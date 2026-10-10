import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  ImageSearchPreparationPhase,
  ImageSearchPreparationProgress,
  ImageSearchPrepareLibraryArgs,
  ImageSearchPrepareLibraryStartResult,
  ImageSearchStartScanArgs,
  ImageSearchStatus,
} from '../shared/ipc/image-search'
import type { EmbeddingProgress, ModelStatus, VectorBuildRequest } from '../shared/vectorTypes'
import {
  appendStreamingEmbeddingInputs,
  closeStreamingEmbeddingBuild,
  getEmbeddingProgress,
  isStreamingEmbeddingBuildReady,
  onEmbeddingProgress,
  scaleStreamingEmbeddingBuild,
  startEmbeddingBuild,
  stopEmbeddingBuild,
} from './embeddingService'
import { cancelQueuedEmbeddingBuild, queueEmbeddingBuild } from './embeddingTaskScheduling'
import {
  getImageSearchCatalogRevision,
  getImageSearchCommitFeed,
  getImageSearchStatus,
  isImageSearchScanLifecycleComplete,
  onImageSearchStatus,
  startImageSearchScan,
  stopImageSearchScan,
  waitForImageSearchPersistence,
} from './imageSearchService'
import { cancelQueuedImageSearchScan, queueImageSearchScan } from './imageSearchTaskScheduling'
import { cancelDownload, downloadModel, getModelStatus } from './modelService'
import { buildVectorIndex } from './vectorIndexService'
import { flushVectorDatabaseWrites, removeImageDataBatch } from './vectorDatabaseService'
import type { UnifiedTaskSubmitter } from './unifiedTaskSubmission'
import { PreparationInputSpool } from './preparationInputSpool'

type PreparationModelName = 'dinov2_vitb14' | 'clip_vit_base_patch32'

interface CommitFeedChunk {
  ok: boolean
  paths: string[]
  generation: number
  pending: number
  dropped: number
  enabled: boolean
  error?: string
}

export interface ImagePreparationPipelineResult {
  activeSetRevision: string
  scanIndexed: number
  committedImages: number
  invalidatedImages: number
  commitFeedDropped: number
  timings: {
    totalMs: number
    scanReadyMs: number
    dinoReadyMs: number
    clipReadyMs: number
    vectorIndexMs: number
  }
}

export interface ImagePreparationPipelineOptions {
  paths: string[]
  backend: 'auto' | 'cpu' | 'gpu'
  maxConcurrentEmbeddings: number
  batchSize?: number
  scheduler?: UnifiedTaskSubmitter
  isCancelled?: () => boolean
  onProgress?: (progress: ImageSearchPreparationProgress) => void
  registerCancellation?: (handler: (() => Promise<void>) | null) => void
}

export interface ImagePreparationPipelineDependencies {
  configureCommitFeed: (enabled: boolean, maxEntries: number) => { ok: boolean; error?: string }
  drainCommitFeed: (limit: number) => CommitFeedChunk
  startScan: (
    request: ImageSearchStartScanArgs,
    scheduler?: UnifiedTaskSubmitter,
  ) => ImageSearchStatus
  getScanStatus: () => ImageSearchStatus
  onScanStatus: (listener: (status: ImageSearchStatus) => void) => () => void
  scanLifecycleComplete: () => boolean
  waitScanPersistence: () => Promise<void>
  stopScan: () => Promise<ImageSearchStatus>
  getCatalogRevision: () => string
  getModelStatus: (modelName: string) => ModelStatus
  downloadModel: (modelName: string) => Promise<{ ok: boolean; error?: string }>
  cancelDownload: () => { ok: boolean }
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
  invalidateCommittedInputs: (paths: readonly string[]) => Promise<void>
  buildVectorIndex: typeof buildVectorIndex
}

function nativeCommitFeed() {
  return getImageSearchCommitFeed()
}

const DEFAULT_DEPENDENCIES: ImagePreparationPipelineDependencies = {
  configureCommitFeed: (enabled, maxEntries) => {
    const feed = nativeCommitFeed()
    if (!feed?.configureScanCommitFeed) {
      return { ok: false, error: 'Native scan commit feed is unavailable' }
    }
    const result = feed.configureScanCommitFeed(enabled, maxEntries)
    return result.ok ? { ok: true } : { ok: false, error: result.error || 'Commit feed failed' }
  },
  drainCommitFeed: (limit) => {
    const feed = nativeCommitFeed()
    const result = feed?.drainScanCommittedPaths?.(limit)
    if (!result?.ok) {
      return {
        ok: false,
        paths: [],
        generation: 0,
        pending: 0,
        dropped: 0,
        enabled: false,
        error: result?.error || 'Native scan commit feed is unavailable',
      }
    }
    return {
      ok: true,
      paths: Array.isArray(result.paths)
        ? result.paths.filter(
            (item): item is string =>
              typeof item === 'string' && item.length > 0 && item.length <= 32_768,
          )
        : [],
      generation: Math.max(0, Math.floor(Number(result.generation) || 0)),
      pending: Math.max(0, Math.floor(Number(result.pending) || 0)),
      dropped: Math.max(0, Math.floor(Number(result.dropped) || 0)),
      enabled: Boolean(result.enabled),
    }
  },
  startScan: (request, scheduler) =>
    scheduler ? queueImageSearchScan(request, scheduler) : startImageSearchScan(request),
  getScanStatus: getImageSearchStatus,
  onScanStatus: onImageSearchStatus,
  scanLifecycleComplete: isImageSearchScanLifecycleComplete,
  waitScanPersistence: waitForImageSearchPersistence,
  stopScan: async () => {
    if (cancelQueuedImageSearchScan()) return getImageSearchStatus()
    return stopImageSearchScan()
  },
  getCatalogRevision: getImageSearchCatalogRevision,
  getModelStatus,
  downloadModel,
  cancelDownload,
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
  invalidateCommittedInputs: async (paths) => {
    removeImageDataBatch(paths)
    await flushVectorDatabaseWrites()
  },
  buildVectorIndex,
}

function cancellationError(): Error {
  const error = new Error('Image library preparation cancelled')
  error.name = 'AbortError'
  return error
}

function boundedConcurrency(value: number): number {
  return Math.max(1, Math.min(2, Math.floor(Number(value) || 1)))
}

function boundedBatchSize(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return value === 0 ? 0 : Math.max(1, Math.min(16, Math.floor(value)))
}

function pathKey(value: string): string {
  const resolved = path.resolve(value).replace(/\//g, '\\').replace(/\\+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isPathWithinRoots(candidate: string, roots: readonly string[]): boolean {
  const candidateKey = pathKey(candidate)
  return roots.some((root) => {
    const rootKey = pathKey(root)
    return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}\\`)
  })
}

function isReadyModel(status: ModelStatus): boolean {
  return status.state === 'downloaded' || status.state === 'verified' || status.state === 'loaded'
}

function embeddingPercent(progress: EmbeddingProgress): number {
  if (progress.state === 'done') return 100
  if (progress.total <= 0) return 0
  return Math.min(
    100,
    Math.round(((progress.completed + progress.failed + progress.skipped) / progress.total) * 100),
  )
}

export function createImagePreparationPipeline(
  dependencyOverrides: Partial<ImagePreparationPipelineDependencies> = {},
): (options: ImagePreparationPipelineOptions) => Promise<ImagePreparationPipelineResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }

  return async (options) => {
    const startedAt = performance.now()
    const roots = [
      ...new Map(options.paths.map((item) => [pathKey(item), path.resolve(item)])).values(),
    ]
    const maxConcurrency = boundedConcurrency(options.maxConcurrentEmbeddings)
    const batchSize = boundedBatchSize(options.batchSize)
    let phase: ImageSearchPreparationPhase = 'scanning'
    let percentage = 0
    let scanIndexed = 0
    let committedImages = 0
    let invalidatedImages = 0
    let commitFeedDropped = 0
    let scanComplete = false
    let dinoEmbeddingComplete = false
    let clipEmbeddingComplete = false
    let vectorIndexComplete = false
    let scanOwned = false
    let embeddingOwned = false
    let downloadOwned = false
    let internalCancelled = false
    let scanFinished = false
    let scanReadyMs = 0
    let scanFailure: unknown
    let dinoModelReady = false
    let modelFailure: unknown
    let streamSessionId: string | null = null
    let expectedFeedGeneration: number | null = null
    const pendingStreamInputs = new PreparationInputSpool()
    const streamBatchTarget = batchSize && batchSize > 0 ? batchSize : 4
    const streamQueueHighWater = Math.max(2, streamBatchTarget * 2)

    const cancelled = (): boolean => internalCancelled || Boolean(options.isCancelled?.())
    const throwIfCancelled = (): void => {
      if (cancelled()) throw cancellationError()
    }
    const report = (nextPhase = phase, message?: string, nextPercentage = percentage): void => {
      phase = nextPhase
      percentage = Math.max(percentage, Math.min(vectorIndexComplete ? 100 : 99, nextPercentage))
      options.onProgress?.({
        state: 'running',
        phase,
        percentage,
        message,
        scanIndexed,
        committedImages,
        invalidatedImages,
        commitFeedDropped,
        scanComplete,
        dinoEmbeddingComplete,
        clipEmbeddingComplete,
        vectorIndexComplete,
      })
    }
    const delay = async (milliseconds: number): Promise<void> => {
      throwIfCancelled()
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
      throwIfCancelled()
    }
    const ensureModel = async (modelName: PreparationModelName): Promise<void> => {
      const label = modelName === 'dinov2_vitb14' ? 'DINO' : 'CLIP'
      for (;;) {
        throwIfCancelled()
        const current = dependencies.getModelStatus(modelName)
        if (isReadyModel(current)) return
        if (current.state === 'error') throw new Error(current.error || `${label} model is invalid`)
        if (current.state === 'downloading') {
          report(phase, `Downloading ${label} model...`, percentage)
          await delay(100)
          continue
        }
        downloadOwned = true
        const downloaded = await dependencies.downloadModel(modelName)
        downloadOwned = false
        throwIfCancelled()
        if (!downloaded.ok) throw new Error(downloaded.error || `Failed to download ${label}`)
      }
    }
    const dinoModelPromise = ensureModel('dinov2_vitb14')
    void dinoModelPromise.then(
      () => {
        dinoModelReady = true
      },
      (error) => {
        modelFailure = error
      },
    )
    const clipModelPromise = dinoModelPromise.then(() => ensureModel('clip_vit_base_patch32'))
    void clipModelPromise.catch((error) => {
      modelFailure = error
    })

    const waitForScan = (): Promise<ImageSearchStatus> => {
      const current = dependencies.getScanStatus()
      if (current.state === 'error') {
        return Promise.reject(new Error(current.lastError || 'Image scan failed'))
      }
      if (dependencies.scanLifecycleComplete()) return Promise.resolve(current)
      return new Promise<ImageSearchStatus>((resolve, reject) => {
        let settled = false
        let cancelTimer: ReturnType<typeof setInterval> | undefined
        const cleanup = () => {
          unsubscribe()
          if (cancelTimer) clearInterval(cancelTimer)
        }
        const check = (status: ImageSearchStatus) => {
          scanIndexed = Math.max(scanIndexed, status.indexedCount)
          report(
            phase,
            status.message || `Scanning images: ${status.indexedCount.toLocaleString()}`,
            Math.min(20, status.state === 'idle' ? 20 : Math.max(1, percentage)),
          )
          if (settled) return
          if (status.state === 'error') {
            settled = true
            cleanup()
            reject(new Error(status.lastError || 'Image scan failed'))
          } else if (dependencies.scanLifecycleComplete()) {
            settled = true
            cleanup()
            resolve(status)
          }
        }
        const unsubscribe = dependencies.onScanStatus(check)
        cancelTimer = setInterval(() => {
          if (!cancelled() || settled) return
          settled = true
          cleanup()
          reject(cancellationError())
        }, 50)
        check(dependencies.getScanStatus())
      })
    }
    const waitForEmbeddingTerminal = (
      modelPhase: ImageSearchPreparationPhase,
      floor: number,
      span: number,
    ): Promise<EmbeddingProgress> => {
      throwIfCancelled()
      const current = dependencies.getEmbeddingProgress()
      if (current.state === 'done' || current.state === 'error') return Promise.resolve(current)
      return new Promise<EmbeddingProgress>((resolve, reject) => {
        let settled = false
        let cancelTimer: ReturnType<typeof setInterval> | undefined
        const cleanup = () => {
          unsubscribe()
          if (cancelTimer) clearInterval(cancelTimer)
        }
        const check = (progress: EmbeddingProgress) => {
          report(
            modelPhase,
            progress.currentPath || 'Building missing embeddings...',
            floor + Math.round((embeddingPercent(progress) / 100) * span),
          )
          if (settled || (progress.state !== 'done' && progress.state !== 'error')) return
          settled = true
          cleanup()
          resolve(progress)
        }
        const unsubscribe = dependencies.onEmbeddingProgress(check)
        cancelTimer = setInterval(() => {
          if (!cancelled() || settled) return
          settled = true
          cleanup()
          reject(cancellationError())
        }, 50)
        check(dependencies.getEmbeddingProgress())
      })
    }
    const submitEmbedding = async (
      request: VectorBuildRequest,
      modelPhase: ImageSearchPreparationPhase,
      floor: number,
      span: number,
    ): Promise<EmbeddingProgress> => {
      throwIfCancelled()
      embeddingOwned = true
      const started = options.scheduler
        ? dependencies.queueEmbedding(request, options.scheduler)
        : await dependencies.startEmbedding(request)
      if (!started.ok) {
        embeddingOwned = false
        throw new Error(
          started.error || started.runtimeError?.detail || `${request.modelName} embedding failed`,
        )
      }
      const terminal = await waitForEmbeddingTerminal(modelPhase, floor, span)
      embeddingOwned = false
      throwIfCancelled()
      if (terminal.state === 'error' || terminal.failed > 0) {
        throw new Error(
          terminal.error || `${request.modelName} embedding failed for ${terminal.failed} image(s)`,
        )
      }
      return terminal
    }
    const baseEmbeddingRequest = (modelName: PreparationModelName): VectorBuildRequest => ({
      modelName,
      embeddingType: 'global',
      scanPaths: roots,
      backend: options.backend,
      maxConcurrentEmbeddings: maxConcurrency,
      ...(batchSize !== undefined ? { batchSize } : {}),
    })
    const startStream = async (initialPaths: string[]): Promise<void> => {
      streamSessionId = crypto.randomUUID()
      const request: VectorBuildRequest = {
        modelName: 'dinov2_vitb14',
        embeddingType: 'global',
        imageIds: initialPaths,
        backend: options.backend,
        maxConcurrentEmbeddings: maxConcurrency,
        streamSessionId,
        ...(batchSize !== undefined ? { batchSize } : {}),
      }
      await submitEmbeddingStartOnly(request)
      while (!dependencies.isStreamingEmbeddingReady(streamSessionId)) {
        throwIfCancelled()
        const current = dependencies.getEmbeddingProgress()
        if (current.state === 'error' || current.state === 'done') {
          throw new Error(current.error || 'DINO embedding stream ended before becoming ready')
        }
        await delay(25)
      }
    }
    const submitEmbeddingStartOnly = async (request: VectorBuildRequest): Promise<void> => {
      embeddingOwned = true
      const started = options.scheduler
        ? dependencies.queueEmbedding(request, options.scheduler)
        : await dependencies.startEmbedding(request)
      if (!started.ok) {
        embeddingOwned = false
        throw new Error(
          started.error || started.runtimeError?.detail || 'Embedding failed to start',
        )
      }
    }
    const flushStreamBuffer = async (force = false): Promise<void> => {
      while (
        pendingStreamInputs.count() > 0 &&
        (force || pendingStreamInputs.count() >= streamBatchTarget)
      ) {
        const embeddingProgress = dependencies.getEmbeddingProgress()
        if (
          streamSessionId &&
          embeddingProgress.pending + embeddingProgress.running >= streamQueueHighWater
        ) {
          if (embeddingProgress.state === 'error' || embeddingProgress.state === 'done') {
            throw new Error(
              embeddingProgress.error ||
                'DINO embedding stream ended while committed inputs were backpressured',
            )
          }
          if (!force) break
          await delay(25)
          continue
        }
        const take = force ? 256 : streamBatchTarget
        const window = pendingStreamInputs.peek(take)
        if (window.paths.length === 0) break
        if (!streamSessionId) await startStream(window.paths)
        else {
          const appended = await dependencies.appendStreamingEmbeddingInputs(
            streamSessionId,
            window.paths,
            { replaceKnown: true },
          )
          if (!appended.ok) {
            throw new Error(
              appended.error ||
                appended.runtimeError?.detail ||
                'Failed to append committed images',
            )
          }
        }
        pendingStreamInputs.acknowledge(window.ids)
      }
    }
    const closeStream = async (): Promise<void> => {
      if (!streamSessionId) return
      const scaled = dependencies.scaleStreamingEmbedding(streamSessionId, maxConcurrency)
      if (!scaled.ok) {
        throw new Error(scaled.error || scaled.runtimeError?.detail || 'DINO stream scale failed')
      }
      const closed = dependencies.closeStreamingEmbedding(streamSessionId)
      if (!closed.ok) {
        throw new Error(closed.error || closed.runtimeError?.detail || 'DINO stream close failed')
      }
      const terminal = await waitForEmbeddingTerminal('embedding-dino', 20, 30)
      embeddingOwned = false
      if (terminal.state === 'error' || terminal.failed > 0) {
        throw new Error(terminal.error || `DINO stream failed for ${terminal.failed} image(s)`)
      }
      streamSessionId = null
    }
    const cancelOwnedWork = async (): Promise<void> => {
      if (downloadOwned) dependencies.cancelDownload()
      if (embeddingOwned) {
        if (!dependencies.cancelQueuedEmbedding()) dependencies.stopEmbedding()
        embeddingOwned = false
      }
      if (scanOwned) {
        await dependencies.stopScan().catch(() => undefined)
        scanOwned = false
      }
    }
    options.registerCancellation?.(cancelOwnedWork)

    const feedConfigured = dependencies.configureCommitFeed(true, 4096).ok
    report('scanning', 'Starting image scan and model preparation...', 0)
    const startedScan = dependencies.startScan(
      {
        paths: roots,
        mode: 'balanced',
        scanMode: 'update',
        buildThumbnails: false,
      },
      options.scheduler,
    )
    if (startedScan.state === 'error') {
      dependencies.configureCommitFeed(false, 4096)
      options.registerCancellation?.(null)
      throw new Error(startedScan.lastError || 'Image scan failed to start')
    }
    scanOwned = true
    const scanPromise = waitForScan()
      .then(async (finalStatus) => {
        await dependencies.waitScanPersistence()
        scanIndexed = Math.max(scanIndexed, finalStatus.indexedCount)
        scanComplete = true
        scanReadyMs = performance.now() - startedAt
        scanFinished = true
        scanOwned = false
        report('finalizing-scan', 'Image scan and manifest commit complete', 20)
        return finalStatus
      })
      .catch((error) => {
        scanFailure = error
        scanFinished = true
        throw error
      })
    void scanPromise.catch(() => undefined)

    try {
      if (feedConfigured) {
        for (;;) {
          throwIfCancelled()
          if (scanFailure) throw scanFailure
          if (modelFailure) throw modelFailure
          const chunk = dependencies.drainCommitFeed(256)
          if (!chunk.ok) throw new Error(chunk.error || 'Native scan commit feed failed')
          commitFeedDropped = Math.max(commitFeedDropped, chunk.dropped)
          if (chunk.paths.length > 0) {
            if (expectedFeedGeneration === null) expectedFeedGeneration = chunk.generation
            else if (chunk.generation !== expectedFeedGeneration) {
              throw new Error('Image scan generation changed during preparation')
            }
          }
          const candidatePaths: string[] = []
          for (const committedPath of chunk.paths) {
            if (!isPathWithinRoots(committedPath, roots)) continue
            candidatePaths.push(committedPath)
          }
          const freshPaths = pendingStreamInputs.add(candidatePaths)
          if (freshPaths.length > 0) {
            await dependencies.invalidateCommittedInputs(freshPaths)
            committedImages += freshPaths.length
            invalidatedImages += freshPaths.length
            if (dinoModelReady && !scanFinished) {
              report(
                'embedding-dino',
                `Building DINO from ${committedImages.toLocaleString()} committed image(s)...`,
                20,
              )
              await flushStreamBuffer()
            }
            report(phase, undefined, percentage)
          }
          if (scanFinished && chunk.pending === 0) break
          if (freshPaths.length === 0) await delay(25)
        }
      }

      await scanPromise
      throwIfCancelled()
      const activeSetRevision = dependencies.getCatalogRevision()
      await dinoModelPromise
      if (streamSessionId) await flushStreamBuffer(true)
      await closeStream()
      report('finalizing-dino', 'Verifying complete DINO coverage...', 50)
      await submitEmbedding(baseEmbeddingRequest('dinov2_vitb14'), 'finalizing-dino', 50, 10)
      dinoEmbeddingComplete = true
      const dinoReadyMs = performance.now() - startedAt
      report('finalizing-dino', 'DINO image coverage complete', 60)

      await clipModelPromise
      report('embedding-clip', 'Building complete CLIP coverage...', 60)
      await submitEmbedding(baseEmbeddingRequest('clip_vit_base_patch32'), 'embedding-clip', 60, 30)
      clipEmbeddingComplete = true
      const clipReadyMs = performance.now() - startedAt
      report('embedding-clip', 'CLIP image coverage complete', 90)

      throwIfCancelled()
      if (dependencies.getCatalogRevision() !== activeSetRevision) {
        throw new Error('Image active set changed during preparation; run preparation again')
      }
      const vectorIndexStartedAt = performance.now()
      report('indexing', 'Committing the searchable vector index...', 90)
      const built = await dependencies.buildVectorIndex('dinov2_vitb14')
      if (!built.ok) throw new Error(built.error || 'Vector index build failed')
      if (dependencies.getCatalogRevision() !== activeSetRevision) {
        throw new Error('Image active set changed before the ready commit')
      }
      vectorIndexComplete = true
      report('done', 'Image library ready', 100)
      return {
        activeSetRevision,
        scanIndexed,
        committedImages,
        invalidatedImages,
        commitFeedDropped,
        timings: {
          totalMs: performance.now() - startedAt,
          scanReadyMs,
          dinoReadyMs,
          clipReadyMs,
          vectorIndexMs: performance.now() - vectorIndexStartedAt,
        },
      }
    } catch (error) {
      internalCancelled = true
      await cancelOwnedWork()
      await Promise.allSettled([scanPromise, dinoModelPromise, clipModelPromise])
      throw error
    } finally {
      dependencies.configureCommitFeed(false, 4096)
      options.registerCancellation?.(null)
      pendingStreamInputs.dispose()
    }
  }
}

export const runImagePreparationPipeline = createImagePreparationPipeline()

const IDLE_PROGRESS: ImageSearchPreparationProgress = {
  state: 'idle',
  percentage: 0,
  scanIndexed: 0,
  committedImages: 0,
  invalidatedImages: 0,
  commitFeedDropped: 0,
  scanComplete: false,
  dinoEmbeddingComplete: false,
  clipEmbeddingComplete: false,
  vectorIndexComplete: false,
}

let activeProgress: ImageSearchPreparationProgress = { ...IDLE_PROGRESS }
let cancelRequested = false
let activeCancellation: { taskId: string; cancel: () => Promise<void> } | null = null
const progressListeners = new Set<(progress: ImageSearchPreparationProgress) => void>()

function emitProgress(progress: ImageSearchPreparationProgress): void {
  activeProgress = { ...progress, updatedAt: Date.now() }
  for (const listener of progressListeners) {
    try {
      listener({ ...activeProgress })
    } catch {
      // A renderer listener must not break preparation.
    }
  }
}

export function onImagePreparationProgress(
  listener: (progress: ImageSearchPreparationProgress) => void,
): () => void {
  progressListeners.add(listener)
  return () => progressListeners.delete(listener)
}

export function getImagePreparationProgress(): ImageSearchPreparationProgress {
  return { ...activeProgress }
}

export function isImagePreparationRunning(): boolean {
  return activeProgress.state === 'running'
}

function normalizePreparationPaths(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const selected = new Map<string, string>()
  for (const value of values.slice(0, 64)) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 32_768) continue
    try {
      const resolved = path.resolve(value)
      if (!fs.statSync(resolved).isDirectory()) continue
      selected.set(pathKey(resolved), resolved)
    } catch {
      // Skip inaccessible roots.
    }
  }
  return [...selected.values()]
}

export function startImageLibraryPreparation(
  args: ImageSearchPrepareLibraryArgs,
  scheduler?: UnifiedTaskSubmitter,
): ImageSearchPrepareLibraryStartResult {
  if (isImagePreparationRunning()) {
    return { ok: false, error: 'Image library preparation is already running' }
  }
  const paths = normalizePreparationPaths(args.paths)
  if (paths.length === 0) return { ok: false, error: 'No accessible image folders selected' }
  const taskId = crypto.randomUUID()
  cancelRequested = false
  activeCancellation = null
  const startedAt = Date.now()
  emitProgress({
    ...IDLE_PROGRESS,
    taskId,
    state: 'running',
    phase: 'scanning',
    message: 'Starting image library preparation...',
    startedAt,
  })
  void runImagePreparationPipeline({
    paths,
    backend:
      args.backend === 'cpu' || args.backend === 'gpu' || args.backend === 'auto'
        ? args.backend
        : 'auto',
    maxConcurrentEmbeddings: boundedConcurrency(args.maxConcurrentEmbeddings ?? 2),
    ...(boundedBatchSize(args.batchSize) !== undefined
      ? { batchSize: boundedBatchSize(args.batchSize) }
      : {}),
    scheduler,
    isCancelled: () => cancelRequested,
    registerCancellation: (handler) => {
      if (activeProgress.taskId !== taskId) return
      activeCancellation = handler ? { taskId, cancel: handler } : null
    },
    onProgress: (progress) => {
      if (activeProgress.taskId !== taskId || activeProgress.state !== 'running') return
      emitProgress({ ...activeProgress, ...progress, taskId, startedAt })
    },
  })
    .then((result) => {
      if (activeProgress.taskId !== taskId) return
      if (cancelRequested || activeProgress.state === 'stopped') return
      emitProgress({
        ...activeProgress,
        state: 'done',
        phase: 'done',
        percentage: 100,
        message: `Image library ready. ${result.scanIndexed.toLocaleString()} images indexed.`,
        scanComplete: true,
        dinoEmbeddingComplete: true,
        clipEmbeddingComplete: true,
        vectorIndexComplete: true,
        finishedAt: Date.now(),
      })
    })
    .catch((error: unknown) => {
      if (activeProgress.taskId !== taskId || activeProgress.state === 'stopped') return
      const stopped = cancelRequested || (error instanceof Error && error.name === 'AbortError')
      emitProgress({
        ...activeProgress,
        state: stopped ? 'stopped' : 'error',
        message: stopped ? 'Image library preparation stopped' : 'Image library preparation failed',
        ...(!stopped ? { error: error instanceof Error ? error.message : String(error) } : {}),
        finishedAt: Date.now(),
      })
    })
    .finally(() => {
      if (activeCancellation?.taskId === taskId) activeCancellation = null
    })
  return { ok: true, taskId }
}

export async function stopImageLibraryPreparation(
  taskId?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (taskId && activeProgress.taskId !== taskId) return { ok: false, error: 'Task not found' }
  if (!isImagePreparationRunning()) return { ok: true }
  cancelRequested = true
  const cancellation = activeCancellation
  if (cancellation !== null && cancellation.taskId === activeProgress.taskId) {
    await cancellation.cancel().catch(() => undefined)
  }
  emitProgress({
    ...activeProgress,
    state: 'stopped',
    message: 'Image library preparation stopped',
    finishedAt: Date.now(),
  })
  return { ok: true }
}
