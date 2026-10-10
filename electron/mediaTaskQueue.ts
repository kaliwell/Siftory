import type {
  MediaSearchPrepareLibraryArgs,
  MediaSearchStartScanArgs,
  MediaSearchStatus,
  MediaSearchTaskProgress,
  MediaSearchTaskType,
} from '../shared/ipc-contract'
import path from 'path'
import { ensureMediaSearchDirs, getMediaSearchDir } from './mediaCacheService'
import {
  cancelRunningMediaTools,
  getCachedFfmpegStatus,
  warmFfmpegStatusCache,
} from './ffmpegService'
import { buildVideoFrameIndex, getVideoFrameManifestCount } from './videoFrameService'
import {
  assignVideoManifestSources,
  getVideoManifestCount,
  loadVideoManifest,
  scanVideoFiles,
} from './videoScanService'
import { submitUnifiedTask, type UnifiedTaskSubmitter } from './unifiedTaskSubmission'
import { getAssetIdentityService } from './assetIdentityService'
import { getSourceCatalogService } from './sourceCatalogService'
import { runMediaPreparationPipeline } from './mediaPreparationPipeline'
import { cancelQueuedEmbeddingBuild } from './embeddingTaskScheduling'
import { getEmbeddingProgress, stopEmbeddingBuild } from './embeddingService'
import { isSourceFileSyncRunning } from './sourceFileSyncService'
import { isSourceDerivedDataCleanupRunning } from './sourceDerivedDataCleanupService'

type ProgressCallback = (progress: MediaSearchTaskProgress) => void

let activeProgress: MediaSearchTaskProgress | null = null
let progressCallback: ProgressCallback | null = null
let taskSeq = 1
let cancelRequested = false

function now(): number {
  return Date.now()
}

function applyProgressMetrics(progress: MediaSearchTaskProgress): MediaSearchTaskProgress {
  if (!progress.startedAt || !Number.isFinite(progress.startedAt)) return progress
  const elapsedMs = Math.max(0, now() - progress.startedAt)
  const finished = Math.max(0, progress.completed + progress.failed)
  const processed = progress.state === 'done' ? Math.max(finished, progress.total) : finished
  const seconds = elapsedMs / 1000
  const itemsPerSecond = seconds > 0 ? processed / seconds : 0
  const remaining = Math.max(0, progress.total - processed)
  return {
    ...progress,
    elapsedMs,
    itemsPerSecond: Number.isFinite(itemsPerSecond) ? itemsPerSecond : 0,
    etaMs:
      progress.state === 'running' && itemsPerSecond > 0
        ? Math.round((remaining / itemsPerSecond) * 1000)
        : progress.state === 'done'
          ? 0
          : progress.etaMs,
  }
}

function createTask(type: MediaSearchTaskType, total: number): MediaSearchTaskProgress {
  const ts = now()
  return applyProgressMetrics({
    taskId: `media-${ts}-${taskSeq++}`,
    type,
    state: 'running',
    total,
    completed: 0,
    failed: 0,
    percentage: 0,
    startedAt: ts,
    updatedAt: ts,
    message: 'Task started',
  })
}

function emit(progress: MediaSearchTaskProgress): void {
  const next = applyProgressMetrics(progress)
  activeProgress = next
  progressCallback?.(next)
}

export function setMediaTaskProgressCallback(cb: ProgressCallback | null): void {
  progressCallback = cb
}

export function getMediaSearchStatus(options: { includeCounts?: boolean } = {}): MediaSearchStatus {
  ensureMediaSearchDirs()
  const tools = getCachedFfmpegStatus()
  warmFfmpegStatusCache()
  const includeCounts = options.includeCounts !== false
  return {
    state: activeProgress?.state ?? 'idle',
    videoCount: includeCounts ? getVideoManifestCount() : 0,
    indexedFrameCount: includeCounts ? getVideoFrameManifestCount() : 0,
    activeTaskId: activeProgress?.taskId,
    activeTaskType: activeProgress?.type,
    message: activeProgress?.message ?? 'MediaSearch P0a skeleton ready',
    lastError: activeProgress?.error,
    ffmpegConfigured: tools.ffmpeg.available,
    ffprobeConfigured: tools.ffprobe.available,
    ffmpegVersion: tools.ffmpeg.version,
    ffprobeVersion: tools.ffprobe.version,
    ffmpegCommand: tools.ffmpeg.command,
    ffprobeCommand: tools.ffprobe.command,
    cacheDir: getMediaSearchDir(),
    updatedAt: activeProgress?.updatedAt ?? now(),
  }
}

export function getMediaTaskProgress(taskId?: string): MediaSearchTaskProgress | null {
  if (!activeProgress) return null
  if (taskId && activeProgress.taskId !== taskId) return null
  return activeProgress
}

export function startMediaIndexScan(args: MediaSearchStartScanArgs): {
  ok: boolean
  taskId?: string
  error?: string
  warning?: string
} {
  if (isSourceFileSyncRunning() || isSourceDerivedDataCleanupRunning()) {
    return { ok: false, error: 'Source index maintenance is running' }
  }
  ensureMediaSearchDirs()
  if (activeProgress?.state === 'running') {
    return { ok: false, error: 'A MediaSearch task is already running' }
  }
  cancelRequested = false
  const task = createTask('scan-video-files', args.paths.length)
  emit({ ...task, message: `Queued ${args.paths.length} path(s) for ${args.mode} scan` })

  void scanVideoFiles({
    paths: args.paths,
    isCancelled: () => cancelRequested,
    onProgress: (scanProgress) => {
      const current = activeProgress
      if (!current || current.taskId !== task.taskId || current.state !== 'running') return
      const total = Math.max(
        scanProgress.scannedEntries,
        scanProgress.videoCount,
        args.paths.length,
      )
      const completed =
        scanProgress.phase === 'processing'
          ? scanProgress.processedVideos
          : scanProgress.scannedEntries
      const progressTotal =
        scanProgress.phase === 'processing' ? Math.max(1, scanProgress.videoCount) : total
      emit({
        ...current,
        total: progressTotal,
        completed,
        failed: scanProgress.failed,
        percentage:
          progressTotal > 0 ? Math.min(99, Math.round((completed / progressTotal) * 100)) : 0,
        currentPath: scanProgress.currentPath,
        updatedAt: now(),
        scanFoundVideos: scanProgress.videoCount,
        scanScannedEntries: scanProgress.scannedEntries,
        scanCapped: scanProgress.capped,
        message:
          scanProgress.phase === 'processing'
            ? `Processing video metadata: ${scanProgress.processedVideos}/${scanProgress.videoCount}`
            : `Scanning files: ${scanProgress.scannedEntries} entries, ${scanProgress.videoCount} videos found${scanProgress.capped ? ' (scan cap reached)' : ''}`,
      })
    },
  })
    .then(async (result) => {
      const current = activeProgress
      if (!current || current.taskId !== task.taskId) return
      if (cancelRequested || current.state === 'stopped') {
        emit({
          ...current,
          state: 'stopped',
          updatedAt: now(),
          message: 'Video scan stopped',
        })
        return
      }
      const activeVideos = result.records.filter((record) => !record.missing)
      await getAssetIdentityService()?.resolveManyForPaths(
        activeVideos.map((record) => record.path),
      )
      const projection = getSourceCatalogService()?.projectMediaSearchVideos(activeVideos)
      if (projection) assignVideoManifestSources(projection.assignments)
      emit({
        ...current,
        state: 'done',
        total: result.capped
          ? result.scannedEntries
          : Math.max(result.scannedEntries, result.records.length),
        completed: result.scannedEntries,
        failed: result.failed,
        percentage: 100,
        currentPath: undefined,
        updatedAt: now(),
        scanFoundVideos: result.discovered + result.updated + result.unchanged,
        scanScannedEntries: result.scannedEntries,
        scanCapped: result.capped,
        message: `Scan done${result.capped ? ' (entry cap reached; selected drive may be partial)' : ''}. ${result.discovered} new, ${result.updated} updated, ${result.unchanged} unchanged.${projection ? ` ${projection.projected} projected to unified sources${projection.unmatched ? `, ${projection.unmatched} outside registered sources` : ''}.` : ''}`,
      })
    })
    .catch((err: unknown) => {
      const current = activeProgress
      if (!current || current.taskId !== task.taskId) return
      emit({
        ...current,
        state: 'error',
        updatedAt: now(),
        error: err instanceof Error ? err.message : String(err),
        message: 'Video scan failed',
      })
    })

  return { ok: true, taskId: task.taskId }
}

function normalizeScopeKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isPathInScope(filePath: string, scopePaths: string[]): boolean {
  if (scopePaths.length === 0) return true
  const key = normalizeScopeKey(filePath)
  return scopePaths.some((scopePath) => {
    const prefix = scopePath.endsWith(path.sep) ? scopePath : `${scopePath}${path.sep}`
    return key === scopePath || key.startsWith(prefix)
  })
}

export function startMediaFrameBuild(
  args: { paths?: string[] },
  taskScheduler?: UnifiedTaskSubmitter,
): {
  ok: boolean
  taskId?: string
  error?: string
} {
  if (isSourceFileSyncRunning() || isSourceDerivedDataCleanupRunning()) {
    return { ok: false, error: 'Source index maintenance is running' }
  }
  ensureMediaSearchDirs()
  if (activeProgress?.state === 'running') {
    return { ok: false, error: 'A MediaSearch task is already running' }
  }
  const scopePaths = (args.paths ?? []).map(normalizeScopeKey)
  const videos = loadVideoManifest().filter(
    (record) => !record.missing && isPathInScope(record.path, scopePaths),
  )
  if (videos.length === 0) {
    return {
      ok: false,
      error:
        scopePaths.length > 0
          ? 'No scanned videos in the selected paths. Run Scan first for this scope.'
          : 'No scanned videos. Run Scan first.',
    }
  }

  cancelRequested = false
  const task = createTask('extract-video-frames', videos.length)
  emit({ ...task, message: `Queued frame extraction for ${videos.length} scanned video(s)` })

  void submitUnifiedTask(taskScheduler, {
    stage: 'preview',
    priority: 1,
    paths: videos.map((video) => video.path),
    label: `video frame index: ${videos.length} video(s)`,
    run: async () => {
      const current = activeProgress
      if (
        !current ||
        current.taskId !== task.taskId ||
        current.state === 'stopped' ||
        cancelRequested
      ) {
        return
      }
      emit({
        ...current,
        updatedAt: now(),
        message: `Extracting frames from ${videos.length} scanned video(s)`,
      })
      try {
        const frameResult = await buildVideoFrameIndex({
          videos,
          isCancelled: () => cancelRequested,
          onProgress: (frameProgress) => {
            const latest = activeProgress
            if (!latest || latest.taskId !== task.taskId || latest.state !== 'running') return
            const total = Math.max(1, frameProgress.total)
            emit({
              ...latest,
              total,
              completed: frameProgress.completed,
              failed: frameProgress.failed,
              percentage: Math.min(99, Math.round((frameProgress.completed / total) * 100)),
              currentPath: frameProgress.currentPath,
              updatedAt: now(),
              message: `Extracting frames: ${frameProgress.completed}/${frameProgress.total}`,
            })
          },
        })
        const latest = activeProgress
        if (!latest || latest.taskId !== task.taskId) return
        const { invalidateFrameIndex } = await import('./mediaSearchFrameIndex')
        invalidateFrameIndex()
        if (cancelRequested || latest.state === 'stopped') {
          emit({
            ...latest,
            state: 'stopped',
            updatedAt: now(),
            message: 'Frame extraction stopped',
          })
          return
        }
        emit({
          ...latest,
          state: 'done',
          total: frameResult.total,
          completed: frameResult.completed + frameResult.failed + frameResult.unavailable,
          failed: frameResult.failed + frameResult.unavailable,
          percentage: 100,
          currentPath: undefined,
          updatedAt: now(),
          message: `Frame index done. ${frameResult.completed} ready, ${frameResult.failed} failed, ${frameResult.unavailable} unavailable.`,
        })
      } catch (err: unknown) {
        const latest = activeProgress
        if (!latest || latest.taskId !== task.taskId) return
        emit({
          ...latest,
          state: 'error',
          updatedAt: now(),
          error: err instanceof Error ? err.message : String(err),
          message: 'Frame extraction failed',
        })
      }
    },
  }).catch((err: unknown) => {
    const current = activeProgress
    if (!current || current.taskId !== task.taskId || current.state === 'stopped') return
    emit({
      ...current,
      state: 'error',
      updatedAt: now(),
      error: err instanceof Error ? err.message : String(err),
      message: 'Frame extraction scheduling failed',
    })
  })

  return { ok: true, taskId: task.taskId }
}

export function startMediaLibraryPreparation(
  args: MediaSearchPrepareLibraryArgs,
  taskScheduler?: UnifiedTaskSubmitter,
): {
  ok: boolean
  taskId?: string
  error?: string
} {
  if (isSourceFileSyncRunning() || isSourceDerivedDataCleanupRunning()) {
    return { ok: false, error: 'Source index maintenance is running' }
  }
  ensureMediaSearchDirs()
  if (activeProgress?.state === 'running') {
    return { ok: false, error: 'A MediaSearch task is already running' }
  }
  const scopePaths = (args.paths ?? []).map(normalizeScopeKey)
  const videos = loadVideoManifest().filter(
    (record) => !record.missing && isPathInScope(record.path, scopePaths),
  )
  if (videos.length === 0) {
    return {
      ok: false,
      error:
        scopePaths.length > 0
          ? 'No scanned videos in the selected paths. Run Scan first for this scope.'
          : 'No scanned videos. Run Scan first.',
    }
  }

  const backend =
    args.backend === 'cpu' || args.backend === 'gpu' || args.backend === 'auto'
      ? args.backend
      : 'auto'
  const maxConcurrentEmbeddings = Math.max(
    1,
    Math.min(12, Math.floor(Number(args.maxConcurrentEmbeddings) || 2)),
  )
  const batchSize =
    args.batchSize === 0
      ? 0
      : Number.isFinite(args.batchSize)
        ? Math.max(1, Math.min(16, Math.floor(Number(args.batchSize))))
        : undefined
  cancelRequested = false
  const task = createTask('prepare-media-library', 100)
  emit({
    ...task,
    message: `Preparing a searchable library from ${videos.length} scanned video(s)`,
    preparationPhase: 'extracting',
    committedFrames: 0,
    frameExtractionComplete: false,
    dinoEmbeddingComplete: false,
    clipEmbeddingComplete: false,
    frameIndexComplete: false,
  })

  void runMediaPreparationPipeline({
    videos,
    backend,
    maxConcurrentEmbeddings,
    ...(batchSize !== undefined ? { batchSize } : {}),
    scheduler: taskScheduler,
    isCancelled: () => cancelRequested,
    onProgress: (pipelineProgress) => {
      const current = activeProgress
      if (!current || current.taskId !== task.taskId || current.state !== 'running') return
      emit({
        ...current,
        total: 100,
        completed: pipelineProgress.percentage,
        failed: 0,
        percentage: pipelineProgress.percentage,
        updatedAt: now(),
        message: pipelineProgress.message,
        preparationPhase: pipelineProgress.phase,
        committedFrames: pipelineProgress.committedFrames,
        frameExtractionComplete: pipelineProgress.frameExtractionComplete,
        dinoEmbeddingComplete: pipelineProgress.dinoEmbeddingComplete,
        clipEmbeddingComplete: pipelineProgress.clipEmbeddingComplete,
        frameIndexComplete: pipelineProgress.frameIndexComplete,
      })
    },
  })
    .then((result) => {
      const current = activeProgress
      if (!current || current.taskId !== task.taskId) return
      if (cancelRequested || current.state === 'stopped') {
        if (current.state !== 'stopped') {
          emit({
            ...current,
            state: 'stopped',
            updatedAt: now(),
            message: 'Library preparation stopped',
          })
        }
        return
      }
      emit({
        ...current,
        state: 'done',
        total: 100,
        completed: 100,
        failed: 0,
        percentage: 100,
        currentPath: undefined,
        updatedAt: now(),
        preparationPhase: 'done',
        committedFrames: result.readyFrames,
        frameExtractionComplete: true,
        dinoEmbeddingComplete: true,
        clipEmbeddingComplete: true,
        frameIndexComplete: true,
        message: `Media library ready. ${result.readyFrames} frames indexed with DINO and CLIP; ${result.frameResult.failed + result.frameResult.unavailable} frame(s) unavailable.`,
      })
    })
    .catch((error: unknown) => {
      const current = activeProgress
      if (!current || current.taskId !== task.taskId || current.state === 'stopped') return
      if (cancelRequested || (error instanceof Error && error.name === 'AbortError')) {
        emit({
          ...current,
          state: 'stopped',
          updatedAt: now(),
          message: 'Library preparation stopped',
        })
        return
      }
      emit({
        ...current,
        state: 'error',
        updatedAt: now(),
        error: error instanceof Error ? error.message : String(error),
        message: 'Media library preparation failed',
      })
    })

  return { ok: true, taskId: task.taskId }
}

export function stopMediaTask(taskId?: string): { ok: boolean; error?: string } {
  if (!activeProgress) return { ok: true }
  if (taskId && activeProgress.taskId !== taskId) return { ok: false, error: 'Task not found' }
  cancelRequested = true
  cancelRunningMediaTools()
  if (activeProgress.type === 'prepare-media-library') {
    if (!cancelQueuedEmbeddingBuild()) {
      const embeddingState = getEmbeddingProgress().state
      if (['queued', 'running', 'paused', 'stopping'].includes(embeddingState)) {
        stopEmbeddingBuild()
      }
    }
  }
  emit({
    ...activeProgress,
    state: 'stopped',
    updatedAt: now(),
    message: 'Task stopped',
  })
  return { ok: true }
}
