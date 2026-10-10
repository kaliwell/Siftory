import crypto from 'crypto'
import fs from 'fs'
import type { MediaSearchVideoFrameRecord, MediaSearchVideoRecord } from '../shared/ipc-contract'
import type { EmbeddingProgress, ModelStatus, VectorBuildRequest } from '../shared/vectorTypes'
import {
  getEmbeddingProgress,
  appendStreamingEmbeddingInputs,
  closeStreamingEmbeddingBuild,
  isStreamingEmbeddingBuildReady,
  onEmbeddingProgress,
  scaleStreamingEmbeddingBuild,
  startEmbeddingBuild,
  stopEmbeddingBuild,
} from './embeddingService'
import { cancelQueuedEmbeddingBuild, queueEmbeddingBuild } from './embeddingTaskScheduling'
import { getModelStatus } from './modelService'
import { submitUnifiedTask, type UnifiedTaskSubmitter } from './unifiedTaskSubmission'
import {
  collectEmbeddedImageIds,
  buildVideoFrameIndex,
  type VideoFrameBuildResult,
} from './videoFrameService'
import { flushVectorDatabaseWrites, removeImageData } from './vectorDatabaseService'

export type MediaPreparationModelName = 'dinov2_vitb14' | 'clip_vit_base_patch32'

export type MediaPreparationPipelinePhase =
  | 'extracting'
  | 'waiting-dino-model'
  | 'embedding-dino'
  | 'waiting-clip-model'
  | 'embedding-clip'
  | 'finalizing-dino'
  | 'finalizing-clip'
  | 'indexing'
  | 'done'

export interface MediaPreparationPipelineProgress {
  phase: MediaPreparationPipelinePhase
  message: string
  percentage: number
  extractionProcessed: number
  extractionTotal: number
  extractionFailed: number
  committedFrames: number
  frameExtractionComplete: boolean
  dinoEmbeddingComplete: boolean
  clipEmbeddingComplete: boolean
  frameIndexComplete: boolean
}

export interface MediaPreparationPipelineResult {
  frameResult: VideoFrameBuildResult
  readyFrames: number
  frameIndexEntries: number
  timings: {
    totalMs: number
    frameExtractionMs: number
    dinoReadyMs: number
    clipReadyMs: number
    frameIndexMs: number
  }
}

export interface MediaPreparationPipelineOptions {
  videos: MediaSearchVideoRecord[]
  backend: 'auto' | 'cpu' | 'gpu'
  maxConcurrentEmbeddings: number
  batchSize?: number
  frameIntervalMs?: number
  maxFramesPerVideo?: number
  frameWidth?: number
  scheduler?: UnifiedTaskSubmitter
  isCancelled?: () => boolean
  onProgress?: (progress: MediaPreparationPipelineProgress) => void
  modelWaitTimeoutMs?: number
}

export interface MediaPreparationPipelineDependencies {
  buildFrames: typeof buildVideoFrameIndex
  submitTask: typeof submitUnifiedTask
  getModelStatus: (modelName: string) => ModelStatus
  queueEmbedding: typeof queueEmbeddingBuild
  startEmbedding: typeof startEmbeddingBuild
  getEmbeddingProgress: () => EmbeddingProgress
  onEmbeddingProgress: (callback: (progress: EmbeddingProgress) => void) => () => void
  cancelQueuedEmbedding: () => boolean
  stopEmbedding: () => { ok: boolean }
  isStreamingEmbeddingReady: (sessionId: string) => boolean
  appendStreamingEmbeddingInputs: (
    sessionId: string,
    imagePaths: readonly string[],
    options?: { replaceKnown?: boolean },
  ) => Promise<import('../shared/runtimeErrors').RuntimeOperationResult>
  closeStreamingEmbedding: (
    sessionId: string,
  ) => import('../shared/runtimeErrors').RuntimeOperationResult
  scaleStreamingEmbedding: (
    sessionId: string,
    maxConcurrency: number,
  ) => import('../shared/runtimeErrors').RuntimeOperationResult
  collectEmbeddedIds: typeof collectEmbeddedImageIds
  buildFrameIndex: typeof import('./mediaSearchFrameIndex').buildFrameIndexAsync
  invalidateFrameIndex: () => void | Promise<void>
  removeInvalidatedEmbeddings: (imagePaths: readonly string[]) => Promise<void>
}

const DEFAULT_DEPENDENCIES: MediaPreparationPipelineDependencies = {
  buildFrames: buildVideoFrameIndex,
  submitTask: submitUnifiedTask,
  getModelStatus,
  queueEmbedding: queueEmbeddingBuild,
  startEmbedding: startEmbeddingBuild,
  getEmbeddingProgress,
  onEmbeddingProgress,
  cancelQueuedEmbedding: cancelQueuedEmbeddingBuild,
  stopEmbedding: stopEmbeddingBuild,
  isStreamingEmbeddingReady: isStreamingEmbeddingBuildReady,
  appendStreamingEmbeddingInputs,
  closeStreamingEmbedding: closeStreamingEmbeddingBuild,
  scaleStreamingEmbedding: scaleStreamingEmbeddingBuild,
  collectEmbeddedIds: collectEmbeddedImageIds,
  buildFrameIndex: async () => {
    const { buildFrameIndexAsync } = await import('./mediaSearchFrameIndex')
    return buildFrameIndexAsync()
  },
  invalidateFrameIndex: async () => {
    const { invalidateFrameIndex } = await import('./mediaSearchFrameIndex')
    invalidateFrameIndex()
  },
  removeInvalidatedEmbeddings: async (imagePaths) => {
    for (const imagePath of new Set(imagePaths)) removeImageData(imagePath)
    await flushVectorDatabaseWrites()
  },
}

interface MutablePipelineState {
  phase: MediaPreparationPipelinePhase
  message: string
  percentage: number
  extractionProcessed: number
  extractionTotal: number
  extractionFailed: number
  committedFrames: number
  dinoRatio: number
  clipRatio: number
  frameExtractionComplete: boolean
  dinoEmbeddingComplete: boolean
  clipEmbeddingComplete: boolean
  frameIndexComplete: boolean
}

function cancellationError(): Error {
  const error = new Error('Media library preparation cancelled')
  error.name = 'AbortError'
  return error
}

function isTerminalEmbeddingProgress(progress: EmbeddingProgress): boolean {
  return progress.state === 'done' || progress.state === 'error'
}

function normalizedPathKey(filePath: string): string {
  const resolved = filePath.replace(/\//g, '\\')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function boundedConcurrency(value: number): number {
  return Math.max(1, Math.min(12, Math.floor(Number(value) || 1)))
}

function boundedBatchSize(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value)) return undefined
  return value === 0 ? 0 : Math.max(1, Math.min(16, Math.floor(value)))
}

export function createMediaPreparationPipeline(
  dependencyOverrides: Partial<MediaPreparationPipelineDependencies> = {},
): (options: MediaPreparationPipelineOptions) => Promise<MediaPreparationPipelineResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }

  return async (options) => {
    const startedAt = performance.now()
    const targetVideoIds = new Set(options.videos.map((video) => video.videoId))
    const committedByPath = new Map<string, MediaSearchVideoFrameRecord>()
    let internalCancelled = false
    let embeddingOwned = false
    let extractionFinished = false
    let resolveFirstReady!: () => void
    let firstReadyResolved = false
    const firstReady = new Promise<void>((resolve) => {
      resolveFirstReady = resolve
    })
    const state: MutablePipelineState = {
      phase: 'extracting',
      message: 'Extracting video frames...',
      percentage: 0,
      extractionProcessed: 0,
      extractionTotal: 0,
      extractionFailed: 0,
      committedFrames: 0,
      dinoRatio: 0,
      clipRatio: 0,
      frameExtractionComplete: false,
      dinoEmbeddingComplete: false,
      clipEmbeddingComplete: false,
      frameIndexComplete: false,
    }

    const cancelled = (): boolean => internalCancelled || Boolean(options.isCancelled?.())
    const throwIfCancelled = (): void => {
      if (cancelled()) throw cancellationError()
    }
    const releaseFirstReady = (): void => {
      if (firstReadyResolved) return
      firstReadyResolved = true
      resolveFirstReady()
    }
    const computePercentage = (): number => {
      const frameRatio = state.frameExtractionComplete
        ? 1
        : state.extractionTotal > 0
          ? Math.min(1, state.extractionProcessed / state.extractionTotal)
          : 0
      const calculated =
        frameRatio * 40 +
        Math.min(1, state.dinoRatio) * 25 +
        Math.min(1, state.clipRatio) * 25 +
        (state.frameIndexComplete ? 10 : 0)
      const bounded = Math.min(state.frameIndexComplete ? 100 : 99, Math.round(calculated))
      state.percentage = Math.max(state.percentage, bounded)
      return state.percentage
    }
    const report = (
      phase: MediaPreparationPipelinePhase = state.phase,
      message: string = state.message,
    ): void => {
      state.phase = phase
      state.message = message
      options.onProgress?.({
        phase: state.phase,
        message: state.message,
        percentage: computePercentage(),
        extractionProcessed: state.extractionProcessed,
        extractionTotal: state.extractionTotal,
        extractionFailed: state.extractionFailed,
        committedFrames: state.committedFrames,
        frameExtractionComplete: state.frameExtractionComplete,
        dinoEmbeddingComplete: state.dinoEmbeddingComplete,
        clipEmbeddingComplete: state.clipEmbeddingComplete,
        frameIndexComplete: state.frameIndexComplete,
      })
    }
    const snapshotCommittedPaths = (): string[] =>
      [...committedByPath.values()]
        .flatMap((record) =>
          record.status === 'done' && record.imagePath && fs.existsSync(record.imagePath)
            ? [record.imagePath]
            : [],
        )
        .sort((left, right) => normalizedPathKey(left).localeCompare(normalizedPathKey(right)))
    const updateCommitted = (records: readonly MediaSearchVideoFrameRecord[], replace: boolean) => {
      if (replace) committedByPath.clear()
      for (const record of records) {
        if (!targetVideoIds.has(record.videoId) || !record.imagePath) continue
        committedByPath.set(normalizedPathKey(record.imagePath), record)
      }
      state.committedFrames = committedByPath.size
      if (committedByPath.size > 0) releaseFirstReady()
      report()
    }
    const delay = async (milliseconds: number): Promise<void> => {
      throwIfCancelled()
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
      throwIfCancelled()
    }
    const waitForModel = async (modelName: MediaPreparationModelName): Promise<void> => {
      const label = modelName === 'dinov2_vitb14' ? 'DINO' : 'CLIP'
      const phase = modelName === 'dinov2_vitb14' ? 'waiting-dino-model' : 'waiting-clip-model'
      const waitStartedAt = Date.now()
      const timeoutMs = Math.max(1_000, options.modelWaitTimeoutMs ?? 2 * 60 * 60 * 1000)
      for (;;) {
        throwIfCancelled()
        const status = dependencies.getModelStatus(modelName)
        if (['downloaded', 'verified', 'loaded'].includes(status.state)) return
        if (status.state === 'error') {
          throw new Error(status.error || `${label} model is invalid`)
        }
        if (Date.now() - waitStartedAt > timeoutMs) {
          throw new Error(`Timed out waiting for the ${label} model`)
        }
        report(phase, `Waiting for the ${label} model...`)
        await delay(100)
      }
    }
    const waitForEmbeddingTerminal = (): Promise<EmbeddingProgress> => {
      throwIfCancelled()
      const current = dependencies.getEmbeddingProgress()
      if (isTerminalEmbeddingProgress(current)) return Promise.resolve(current)
      return new Promise<EmbeddingProgress>((resolve, reject) => {
        let settled = false
        let unsubscribe: () => void = () => undefined
        let cancelTimer: ReturnType<typeof setInterval> | undefined
        const cleanup = () => {
          unsubscribe()
          if (cancelTimer) clearInterval(cancelTimer)
        }
        const finish = (progress: EmbeddingProgress) => {
          if (settled || !isTerminalEmbeddingProgress(progress)) return
          settled = true
          cleanup()
          resolve(progress)
        }
        unsubscribe = dependencies.onEmbeddingProgress(finish)
        cancelTimer = setInterval(() => {
          if (!cancelled() || settled) return
          settled = true
          cleanup()
          reject(cancellationError())
        }, 100)
        finish(dependencies.getEmbeddingProgress())
      })
    }
    const runEmbedding = async (
      modelName: MediaPreparationModelName,
      imagePaths: string[],
      phase: MediaPreparationPipelinePhase,
    ): Promise<void> => {
      if (imagePaths.length === 0) return
      throwIfCancelled()
      const label = modelName === 'dinov2_vitb14' ? 'DINO' : 'CLIP'
      report(phase, `Building ${label} embeddings for ${imagePaths.length} committed frame(s)...`)
      const request: VectorBuildRequest = {
        modelName,
        embeddingType: 'global',
        imageIds: imagePaths,
        backend: options.backend,
        maxConcurrentEmbeddings: boundedConcurrency(options.maxConcurrentEmbeddings),
        ...(boundedBatchSize(options.batchSize) !== undefined
          ? { batchSize: boundedBatchSize(options.batchSize) }
          : {}),
      }
      embeddingOwned = true
      const started = options.scheduler
        ? dependencies.queueEmbedding(request, options.scheduler)
        : await dependencies.startEmbedding(request)
      if (!started.ok) {
        embeddingOwned = false
        throw new Error(
          started.error || started.runtimeError?.detail || `${label} embedding failed`,
        )
      }
      const terminal = await waitForEmbeddingTerminal()
      embeddingOwned = false
      throwIfCancelled()
      if (terminal.state === 'error' || terminal.failed > 0) {
        throw new Error(
          terminal.error || `${label} embedding failed for ${terminal.failed} frame(s)`,
        )
      }
    }
    const updateCoverage = async (
      modelName: MediaPreparationModelName,
      imagePaths: string[],
    ): Promise<Set<string>> => {
      const requested = new Set(imagePaths)
      const covered = await dependencies.collectEmbeddedIds(modelName, requested)
      const coverageTarget = state.frameExtractionComplete
        ? imagePaths.length
        : Math.max(imagePaths.length, state.extractionTotal)
      const ratio = coverageTarget > 0 ? covered.size / coverageTarget : 0
      if (modelName === 'dinov2_vitb14') state.dinoRatio = Math.max(state.dinoRatio, ratio)
      else state.clipRatio = Math.max(state.clipRatio, ratio)
      report()
      return covered
    }
    const ensureFinalCoverage = async (
      modelName: MediaPreparationModelName,
      imagePaths: string[],
      phase: MediaPreparationPipelinePhase,
    ): Promise<void> => {
      let covered = await updateCoverage(modelName, imagePaths)
      const missing = imagePaths.filter((imagePath) => !covered.has(imagePath))
      if (missing.length > 0) await runEmbedding(modelName, missing, phase)
      covered = await updateCoverage(modelName, imagePaths)
      const remaining = imagePaths.filter((imagePath) => !covered.has(imagePath))
      if (remaining.length > 0) {
        const label = modelName === 'dinov2_vitb14' ? 'DINO' : 'CLIP'
        throw new Error(`${label} coverage is incomplete: ${remaining.length} frame(s) missing`)
      }
    }
    const cancelOwnedEmbedding = (): void => {
      if (!embeddingOwned) return
      if (!dependencies.cancelQueuedEmbedding()) dependencies.stopEmbedding()
      embeddingOwned = false
    }

    report()
    const extractionStartedAt = performance.now()
    const extractionPromise = dependencies.submitTask(options.scheduler, {
      stage: 'preview',
      priority: 1,
      paths: options.videos.map((video) => video.path),
      label: `video frame preparation: ${options.videos.length} video(s)`,
      run: () =>
        dependencies.buildFrames({
          videos: options.videos,
          ...(options.frameIntervalMs !== undefined ? { intervalMs: options.frameIntervalMs } : {}),
          ...(options.maxFramesPerVideo !== undefined
            ? { maxFramesPerVideo: options.maxFramesPerVideo }
            : {}),
          ...(options.frameWidth !== undefined ? { width: options.frameWidth } : {}),
          isCancelled: cancelled,
          onProgress: (progress) => {
            state.extractionProcessed = progress.completed
            state.extractionTotal = progress.total
            state.extractionFailed = progress.failed
            const message =
              state.phase === 'extracting'
                ? `Extracting frames: ${progress.completed}/${progress.total}`
                : state.message
            report(state.phase, message)
          },
          onCheckpoint: (checkpoint) => {
            updateCommitted(checkpoint.readyRecords, checkpoint.kind === 'final')
          },
        }),
    })
    void extractionPromise.then(
      () => {
        extractionFinished = true
        releaseFirstReady()
      },
      () => {
        extractionFinished = true
        releaseFirstReady()
      },
    )

    const dinoStreamingPromise = (async () => {
      await firstReady
      throwIfCancelled()
      if (extractionFinished && committedByPath.size === 0) return
      await waitForModel('dinov2_vitb14')
      const initialPaths = snapshotCommittedPaths()
      if (initialPaths.length === 0) return
      const streamSessionId = crypto.randomUUID()
      const submittedPathKeys = new Set(initialPaths.map(normalizedPathKey))
      const request: VectorBuildRequest = {
        modelName: 'dinov2_vitb14',
        embeddingType: 'global',
        imageIds: initialPaths,
        backend: options.backend,
        maxConcurrentEmbeddings: 1,
        streamSessionId,
        ...(boundedBatchSize(options.batchSize) !== undefined
          ? { batchSize: boundedBatchSize(options.batchSize) }
          : {}),
      }
      report(
        'embedding-dino',
        `Building DINO embeddings from ${initialPaths.length} committed frame(s)...`,
      )
      embeddingOwned = true
      const started = options.scheduler
        ? dependencies.queueEmbedding(request, options.scheduler)
        : await dependencies.startEmbedding(request)
      if (!started.ok) {
        embeddingOwned = false
        throw new Error(started.error || started.runtimeError?.detail || 'DINO embedding failed')
      }

      while (!dependencies.isStreamingEmbeddingReady(streamSessionId)) {
        throwIfCancelled()
        const current = dependencies.getEmbeddingProgress()
        if (current.state === 'error') {
          throw new Error(current.error || 'DINO embedding stream failed to open')
        }
        if (current.state === 'done') {
          throw new Error('DINO embedding stream ended before it was ready')
        }
        await delay(50)
      }

      const appendCommittedPaths = async (): Promise<void> => {
        const pending = snapshotCommittedPaths().filter(
          (imagePath) => !submittedPathKeys.has(normalizedPathKey(imagePath)),
        )
        for (let offset = 0; offset < pending.length; offset += 256) {
          const chunk = pending.slice(offset, offset + 256)
          const appended = await dependencies.appendStreamingEmbeddingInputs(streamSessionId, chunk)
          if (!appended.ok) {
            throw new Error(
              appended.error ||
                appended.runtimeError?.detail ||
                'Failed to append committed DINO frames',
            )
          }
          for (const imagePath of chunk) submittedPathKeys.add(normalizedPathKey(imagePath))
        }
      }

      while (!extractionFinished) {
        throwIfCancelled()
        await appendCommittedPaths()
        await delay(50)
      }
      await appendCommittedPaths()
      const scaled = dependencies.scaleStreamingEmbedding(
        streamSessionId,
        boundedConcurrency(options.maxConcurrentEmbeddings),
      )
      if (!scaled.ok) {
        throw new Error(
          scaled.error ||
            scaled.runtimeError?.detail ||
            'Failed to scale committed DINO frame embedding',
        )
      }
      const closed = dependencies.closeStreamingEmbedding(streamSessionId)
      if (!closed.ok) {
        throw new Error(
          closed.error || closed.runtimeError?.detail || 'Failed to close DINO embedding stream',
        )
      }
      const terminal = await waitForEmbeddingTerminal()
      embeddingOwned = false
      throwIfCancelled()
      if (terminal.state === 'error' || terminal.failed > 0) {
        throw new Error(terminal.error || `DINO embedding failed for ${terminal.failed} frame(s)`)
      }
      await updateCoverage('dinov2_vitb14', snapshotCommittedPaths())
    })()
    void dinoStreamingPromise.catch(() => undefined)

    try {
      const frameResult = await extractionPromise
      const frameExtractionMs = performance.now() - extractionStartedAt
      throwIfCancelled()
      state.frameExtractionComplete = true
      state.extractionProcessed = frameResult.total
      state.extractionTotal = frameResult.total
      state.extractionFailed = frameResult.failed + frameResult.unavailable
      report(state.phase, state.message)

      if (frameResult.sourceChanged > 0) {
        internalCancelled = true
        cancelOwnedEmbedding()
        await Promise.allSettled([dinoStreamingPromise])
        await dependencies.removeInvalidatedEmbeddings(frameResult.invalidatedImagePaths)
        await dependencies.invalidateFrameIndex()
        throw new Error(
          `${frameResult.sourceChanged} source video(s) changed during preparation; rescan required`,
        )
      }

      await dinoStreamingPromise
      throwIfCancelled()
      const readyPathByKey = new Map<string, string>()
      for (const record of frameResult.records) {
        if (
          targetVideoIds.has(record.videoId) &&
          record.status === 'done' &&
          record.imagePath &&
          fs.existsSync(record.imagePath)
        ) {
          readyPathByKey.set(normalizedPathKey(record.imagePath), record.imagePath)
        }
      }
      const readyPaths = [...readyPathByKey.values()].sort((left, right) =>
        normalizedPathKey(left).localeCompare(normalizedPathKey(right)),
      )
      if (readyPaths.length === 0) throw new Error('No searchable video frames were produced')

      await waitForModel('dinov2_vitb14')
      await ensureFinalCoverage('dinov2_vitb14', readyPaths, 'finalizing-dino')
      state.dinoRatio = 1
      state.dinoEmbeddingComplete = true
      const dinoReadyMs = performance.now() - startedAt
      report('finalizing-dino', 'DINO frame coverage complete')

      await waitForModel('clip_vit_base_patch32')
      await ensureFinalCoverage('clip_vit_base_patch32', readyPaths, 'finalizing-clip')
      state.clipRatio = 1
      state.clipEmbeddingComplete = true
      const clipReadyMs = performance.now() - startedAt
      report('finalizing-clip', 'CLIP frame coverage complete')

      throwIfCancelled()
      await dependencies.invalidateFrameIndex()
      const indexStartedAt = performance.now()
      report('indexing', 'Committing the searchable frame index...')
      const frameIndex = await dependencies.buildFrameIndex()
      if (frameIndex.errors > 0) {
        throw new Error(`Frame index commit reported ${frameIndex.errors} error(s)`)
      }
      state.frameIndexComplete = true
      report('done', 'Media library ready')
      return {
        frameResult,
        readyFrames: readyPaths.length,
        frameIndexEntries: frameIndex.entries,
        timings: {
          totalMs: performance.now() - startedAt,
          frameExtractionMs,
          dinoReadyMs,
          clipReadyMs,
          frameIndexMs: performance.now() - indexStartedAt,
        },
      }
    } catch (error) {
      internalCancelled = true
      cancelOwnedEmbedding()
      await Promise.allSettled([dinoStreamingPromise])
      throw error
    }
  }
}

export const runMediaPreparationPipeline = createMediaPreparationPipeline()
