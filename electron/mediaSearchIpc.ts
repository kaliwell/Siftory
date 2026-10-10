import { secureIpcMain } from './ipcAuthorization'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { app, clipboard, dialog, shell, type BrowserWindow } from 'electron'
import {
  getMediaTaskProgress,
  getMediaSearchStatus,
  setMediaTaskProgressCallback,
  startMediaFrameBuild,
  startMediaIndexScan,
  startMediaLibraryPreparation,
  stopMediaTask,
} from './mediaTaskQueue'
import { isStorageCleanupActiveFor } from './storageCleanupService'
import {
  clearMediaSearchCache,
  clearMediaSearchData,
  getMediaCacheStatsAsync,
  getMediaSearchDir,
} from './mediaCacheService'
import { loadVideoManifest, loadVideoManifestPreview } from './videoScanService'
import {
  findReadyVideoFrameById,
  getFrameEmbeddingStats,
  getReadyVideoFrameCount,
  loadAvailableVideoFrameManifest,
  loadVideoFrameManifest,
  loadVideoFrameManifestPreview,
  searchSimilarVideoFrames,
} from './videoFrameService'
import {
  clearFfmpegDirectory,
  ensureBundledFfmpegBinDir,
  saveFfmpegDirectory,
} from './mediaToolConfigService'
import type { UnifiedTaskSubmitter } from './unifiedTaskSubmission'
import { detectSubtitleStreams, getFfmpegHelpMessage, warmFfmpegStatusCache } from './ffmpegService'
import {
  isRevealableMediaScanPath,
  isMediaSearchQueryImagePath,
  isVideoPath,
  normalizeMediaSearchStartScanArgs,
  normalizeTaskId,
} from './mediaSearchGuards'
import { isMediaSearchPathInScope, normalizeMediaSearchScopePaths } from './mediaSearchScope'
import {
  clearMediaSearchImageDataUrlCache,
  readMediaSearchImageDataUrl,
  readMediaSearchThumbnailDataUrl,
} from './mediaSearchImageCache'
import { resolveRequestedComputeBackend } from './computeBackendService'
import type { MediaSearchTaskProgress } from '../shared/ipc-contract'
import type { VectorBuildRequest } from '../shared/vectorTypes'
import { openSafeShellPath, revealSafeShellPath, safeShellPath } from './pathGuards'
import { searchVideoFramesByImage, searchVideoFramesByText } from './videoFrameSearchService'
import { startEmbeddingBuild } from './embeddingService'
import { queueEmbeddingBuild } from './embeddingTaskScheduling'
import {
  clearMediaFrameEmbeddingBuildActive,
  markMediaFrameEmbeddingBuildActive,
} from './mediaFrameEmbeddingState'
import { runtimeFailure } from '../shared/runtimeErrors'
import { resolveControlledMediaSeek } from './controlledMediaSeek'
import { openControlledMediaPlayer } from './mediaPlayerService'
import {
  extractVideoSubtitles,
  fuseMultimodalResults,
  getAudioSemanticTranscriptStatsSnapshot,
  searchTranscripts,
} from './transcriptService'
import { VideoSemanticDatabase, VIDEO_SEMANTIC_DATABASE_FILENAME } from './videoSemanticDatabase'
import { VideoSemanticJobService } from './videoSemanticJobService'
import { VideoSemanticUiService } from './videoSemanticUiService'
import { VideoSemanticBuildCoordinator } from './videoSemanticBuildCoordinator'
import { createDefaultVideoSemanticRuntime } from './videoSemanticRuntimeFactory'
import { getSourceFileSyncMutationEpoch, isSourceFileSyncRunning } from './sourceFileSyncService'
import {
  tryAcquireVectorMutationReservation,
  tryAcquireVectorSearchReservation,
} from './vectorMaintenanceService'

type MainWindowProvider = () => BrowserWindow | null

/** Roots the user explicitly scanned or picked via dialog; keys are normalized lowercase paths. */
const knownRevealRoots = new Set<string>()
let videoSemanticUiService: VideoSemanticUiService | null = null
let videoSemanticTaskScheduler: UnifiedTaskSubmitter | undefined
let audioSemanticChild: ChildProcessWithoutNullStreams | null = null
let audioSemanticChildReady: Promise<void> | null = null
let audioSemanticChildBusy = false
let audioSemanticChildShutdownRegistered = false
let audioSemanticLastJob: AudioSemanticPublicJob | null = null
let audioSemanticStaticStatusCache: {
  expiresAt: number
  value: ReturnType<typeof buildAudioSemanticStaticStatus>
} | null = null
let activeMediaSearches = 0
let mediaMaintenanceReservations = 0
const AUDIO_SEMANTIC_STATIC_STATUS_CACHE_MS = 30_000
const SOURCE_FILE_SYNC_BUSY_MESSAGE = 'Source file synchronization is running'

function beginMediaMaintenanceReservation(): () => void {
  mediaMaintenanceReservations += 1
  let released = false
  return () => {
    if (released) return
    released = true
    mediaMaintenanceReservations = Math.max(0, mediaMaintenanceReservations - 1)
  }
}

export function isMediaSemanticMaintenanceRunning(): boolean {
  return (
    audioSemanticChildBusy ||
    activeMediaSearches > 0 ||
    mediaMaintenanceReservations > 0 ||
    Boolean(videoSemanticUiService?.hasActiveJob())
  )
}

interface AudioSemanticPublicJob {
  jobId: string
  generationId: string
  state: 'queued' | 'running' | 'stopped' | 'completed' | 'failed'
  totalVideos: number
  completedVideos: number
  totalSegments: number
  completedSegments: number
  failedSegments: number
  currentVideoId?: string
  currentStartMs?: number
  currentEndMs?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

const SENSEVOICE_REVISION = '3847d57b6bdf2dd8875cb1508d2af43d80a16bf7'
const SENSEVOICE_CRITICAL_FILES: Readonly<Record<string, number>> = {
  'model.pt': 936_291_369,
  'config.yaml': 1_855,
  'configuration.json': 396,
  'am.mvn': 11_203,
  'chn_jpn_yue_eng_ko_spectok.bpe.model': 377_341,
}
const AUDIO_DIARIZATION_MODELS = {
  vad: {
    modelId: 'fsmn-vad',
    modelRevision: 'modelscope-v2.0.4',
    relativeRoot: ['models', 'fsmn-vad', 'v2.0.4'],
    files: { 'model.pt': 1_721_366, 'config.yaml': 1_215, 'configuration.json': 365 },
  },
  speaker: {
    modelId: 'campplus-speaker',
    modelRevision: 'modelscope-v2.0.2',
    relativeRoot: ['models', 'campplus', 'v2.0.2'],
    files: {
      'campplus_cn_common.bin': 28_036_335,
      'config.yaml': 537,
      'configuration.json': 581,
    },
  },
} as const

function senseVoiceRuntimeRoot(): string {
  return path.join(app.getPath('userData'), 'runtimes', 'sensevoice')
}

function senseVoiceRunnerPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sensevoice', 'sensevoice_runner.py')
    : path.join(app.getAppPath(), 'resources', 'sensevoice', 'sensevoice_runner.py')
}

function inspectAudioSemanticRuntime() {
  const runtimeRoot = senseVoiceRuntimeRoot()
  const pythonPath = path.join(
    runtimeRoot,
    'venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  )
  const runnerPath = senseVoiceRunnerPath()
  if (!fs.existsSync(pythonPath)) {
    return {
      adapterId: 'funasr-sensevoice-cpu',
      state: 'not-installed' as const,
      reason: 'audio-runtime-missing',
    }
  }
  if (!fs.existsSync(runnerPath)) {
    return {
      adapterId: 'funasr-sensevoice-cpu',
      state: 'unavailable' as const,
      reason: 'audio-runner-missing',
    }
  }
  const modelDir = path.join(runtimeRoot, 'models', 'SenseVoiceSmall', SENSEVOICE_REVISION)
  for (const [fileName, expectedBytes] of Object.entries(SENSEVOICE_CRITICAL_FILES)) {
    try {
      const stat = fs.statSync(path.join(modelDir, fileName))
      if (!stat.isFile() || stat.size !== expectedBytes) {
        return {
          adapterId: 'funasr-sensevoice-cpu',
          state: 'error' as const,
          reason: 'audio-model-corrupt',
        }
      }
    } catch {
      return {
        adapterId: 'funasr-sensevoice-cpu',
        state: 'not-installed' as const,
        reason: 'audio-model-missing',
      }
    }
  }
  return {
    adapterId: 'funasr-sensevoice-cpu',
    state: 'ready' as const,
    model: {
      modelId: 'FunAudioLLM/SenseVoiceSmall',
      modelRevision: SENSEVOICE_REVISION,
      runtime: 'funasr' as const,
      quantization: 'fp32',
    },
  }
}

function inspectAudioDiarizationRuntime() {
  const runtimeRoot = senseVoiceRuntimeRoot()
  for (const model of Object.values(AUDIO_DIARIZATION_MODELS)) {
    const modelRoot = path.join(runtimeRoot, ...model.relativeRoot)
    for (const [fileName, expectedBytes] of Object.entries(model.files)) {
      try {
        const stat = fs.statSync(path.join(modelRoot, fileName))
        if (!stat.isFile() || stat.size !== expectedBytes) {
          return { state: 'error' as const, reason: 'audio-diarization-model-corrupt' }
        }
      } catch {
        return { state: 'not-installed' as const, reason: 'audio-diarization-model-missing' }
      }
    }
  }
  return {
    state: 'ready' as const,
    vadModel: {
      modelId: AUDIO_DIARIZATION_MODELS.vad.modelId,
      modelRevision: AUDIO_DIARIZATION_MODELS.vad.modelRevision,
    },
    speakerModel: {
      modelId: AUDIO_DIARIZATION_MODELS.speaker.modelId,
      modelRevision: AUDIO_DIARIZATION_MODELS.speaker.modelRevision,
    },
  }
}

function getVideoSemanticUiService(): VideoSemanticUiService {
  if (videoSemanticUiService) return videoSemanticUiService
  const database = new VideoSemanticDatabase(
    path.join(app.getPath('userData'), 'media-search', VIDEO_SEMANTIC_DATABASE_FILENAME),
  )
  const runtime = createDefaultVideoSemanticRuntime({
    resourcesRoot: process.resourcesPath,
    allowManagedLlamaCpp: app.isPackaged,
  })
  app.once('before-quit', () => void runtime.dispose?.())
  const jobs = new VideoSemanticJobService(database)
  const coordinator = new VideoSemanticBuildCoordinator({
    database,
    jobs,
    runtime,
    scheduler: videoSemanticTaskScheduler,
    getVideo: (videoId) => loadVideoManifest().find((video) => video.videoId === videoId),
    getFrames: loadVideoFrameManifest,
    framesRoot: path.join(getMediaSearchDir(), 'frames'),
  })
  let service: VideoSemanticUiService
  const buildResult = async (
    result: Awaited<ReturnType<VideoSemanticBuildCoordinator['start']>>,
  ) => ({
    ok: result.started,
    status: await service.getStatus(result.job.videoId),
    ...(result.started ? {} : { error: result.reason || 'video-semantic-build-not-started' }),
  })
  service = new VideoSemanticUiService(
    database,
    jobs,
    () => runtime.inspect(),
    async (videoId) => {
      try {
        return await buildResult(await coordinator.start(videoId))
      } catch (error) {
        return { ok: false, error: errorMessage(error), status: await service.getStatus(videoId) }
      }
    },
    async (jobId) => {
      try {
        return await buildResult(await coordinator.resume(jobId))
      } catch (error) {
        const job = jobs.getJob(jobId)
        return {
          ok: false,
          error: errorMessage(error),
          ...(job ? { status: await service.getStatus(job.videoId) } : {}),
        }
      }
    },
  )
  jobs.recoverInterruptedJobs()
  for (const queued of database.listJobs().filter((job) => job.state === 'queued')) {
    void coordinator.resume(queued.jobId).catch((error) => {
      const current = jobs.getJob(queued.jobId)
      if (current && current.state !== 'done' && current.state !== 'stopped') {
        jobs.pauseJob(queued.jobId, errorMessage(error))
      }
    })
  }
  videoSemanticUiService = service
  return service
}

function knownVideoId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const videoId = value.trim()
  return loadVideoManifest().some((video) => video.videoId === videoId) ? videoId : null
}

function availableMediaVideoIds(): Set<string> {
  return new Set(
    loadVideoManifest()
      .filter((video) => !video.missing)
      .map((video) => video.videoId),
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function getAudioSemanticJobPath(): string {
  return path.join(getMediaSearchDir(), 'audio-semantic', 'build-job.json')
}

function sanitizeAudioSemanticJob(raw: unknown): AudioSemanticPublicJob | null {
  if (!raw || typeof raw !== 'object') return null
  const job = raw as Record<string, unknown>
  const states = new Set(['queued', 'running', 'stopped', 'completed', 'failed'])
  if (
    typeof job.jobId !== 'string' ||
    typeof job.generationId !== 'string' ||
    typeof job.state !== 'string' ||
    !states.has(job.state)
  ) {
    return null
  }
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
  const optionalText = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.slice(0, 2_000) : undefined
  const optionalTime = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  return {
    jobId: job.jobId,
    generationId: job.generationId,
    state: job.state as AudioSemanticPublicJob['state'],
    totalVideos: count(job.totalVideos),
    completedVideos: count(job.completedVideos),
    totalSegments: count(job.totalSegments),
    completedSegments: count(job.completedSegments),
    failedSegments: count(job.failedSegments),
    currentVideoId: optionalText(job.currentVideoId),
    currentStartMs: optionalTime(job.currentStartMs),
    currentEndMs: optionalTime(job.currentEndMs),
    lastError: optionalText(job.lastError),
    createdAt: optionalTime(job.createdAt) ?? 0,
    updatedAt: optionalTime(job.updatedAt) ?? 0,
  }
}

function readAudioSemanticJob(): AudioSemanticPublicJob | null {
  try {
    const job = sanitizeAudioSemanticJob(
      JSON.parse(fs.readFileSync(getAudioSemanticJobPath(), 'utf8')),
    )
    if (job) audioSemanticLastJob = job
    return job
  } catch {
    return audioSemanticLastJob
  }
}

function audioSemanticWorkerPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'audioSemanticBuildChild.js')
    : path.join(app.getAppPath(), 'dist-electron', 'audioSemanticBuildChild.js')
}

function consumeAudioSemanticChildMessage(rawLine: string, ready: () => void): void {
  if (!rawLine || rawLine.length > 64 * 1024) return
  try {
    const message = JSON.parse(rawLine) as { type?: unknown; job?: unknown }
    if (message.type === 'ready') {
      ready()
      return
    }
    if (message.type === 'progress') {
      const job = sanitizeAudioSemanticJob(message.job)
      if (job) {
        audioSemanticLastJob = job
        audioSemanticChildBusy = job.state === 'queued' || job.state === 'running'
        if (job.state === 'completed' || job.state === 'failed' || job.state === 'stopped') {
          audioSemanticStaticStatusCache = null
        }
      }
      return
    }
    if (message.type === 'error') audioSemanticChildBusy = false
  } catch {
    // Ignore non-protocol stdout. The child remains isolated and progress is also persisted.
  }
}

function ensureAudioSemanticChild(): Promise<void> {
  if (audioSemanticChild && audioSemanticChildReady) return audioSemanticChildReady
  const workerPath = audioSemanticWorkerPath()
  if (!fs.existsSync(workerPath)) return Promise.reject(new Error('audio-build-worker-missing'))
  fs.mkdirSync(getMediaSearchDir(), { recursive: true })
  const child = spawn(process.execPath, [workerPath], {
    cwd: getMediaSearchDir(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      FLOATING_CLOCK_MEDIA_SEARCH_DIR: getMediaSearchDir(),
      FLOATING_CLOCK_RESOURCES_PATH: app.isPackaged ? process.resourcesPath : app.getAppPath(),
      FLOATING_CLOCK_SENSEVOICE_RUNTIME_ROOT: senseVoiceRuntimeRoot(),
      FLOATING_CLOCK_SENSEVOICE_RUNNER_PATH: senseVoiceRunnerPath(),
    },
    windowsHide: true,
    shell: false,
  })
  audioSemanticChild = child
  let settled = false
  let lineBuffer = ''
  let resolveReady = () => {}
  let rejectReady = (_error: Error) => {}
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      if (settled) return
      settled = true
      resolve()
    }
    rejectReady = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
  })
  audioSemanticChildReady = readyPromise
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    lineBuffer = `${lineBuffer}${chunk}`.slice(-128 * 1024)
    let newline = lineBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = lineBuffer.slice(0, newline).trim()
      lineBuffer = lineBuffer.slice(newline + 1)
      consumeAudioSemanticChildMessage(line, resolveReady)
      newline = lineBuffer.indexOf('\n')
    }
  })
  child.stderr.on('data', () => {
    // Runtime details may contain private media paths, so stderr is intentionally not relayed.
  })
  child.once('error', (error) => rejectReady(error))
  child.once('exit', () => {
    rejectReady(new Error('audio-build-worker-exited'))
    if (audioSemanticChild === child) {
      audioSemanticChild = null
      audioSemanticChildReady = null
      audioSemanticChildBusy = false
    }
  })
  if (!audioSemanticChildShutdownRegistered) {
    audioSemanticChildShutdownRegistered = true
    app.once('before-quit', () => {
      audioSemanticChild?.kill()
      audioSemanticChild = null
      audioSemanticChildReady = null
      audioSemanticChildBusy = false
    })
  }
  return Promise.race([
    readyPromise,
    new Promise<void>((_resolve, reject) =>
      setTimeout(() => reject(new Error('audio-build-worker-start-timeout')), 15_000),
    ),
  ])
}

async function sendAudioSemanticCommand(command: unknown): Promise<void> {
  await ensureAudioSemanticChild()
  const line = `${JSON.stringify(command)}\n`
  if (line.length > 4 * 1024 * 1024 || !audioSemanticChild?.stdin.writable) {
    throw new Error('audio-build-command-unavailable')
  }
  audioSemanticChild.stdin.write(line)
}

function eligibleAudioSemanticVideos(videoId?: string) {
  return loadVideoManifest()
    .filter(
      (video) =>
        (!videoId || video.videoId === videoId) &&
        !video.missing &&
        typeof video.durationMs === 'number' &&
        Number.isFinite(video.durationMs) &&
        video.durationMs >= 1_000 &&
        typeof video.audioCodec === 'string' &&
        video.audioCodec.length > 0,
    )
    .slice(0, 10_000)
}

function audioSemanticSourceFingerprint(video: {
  videoId: string
  sizeBytes: number
  mtimeMs: number
  durationMs?: number
}): string {
  return crypto
    .createHash('sha256')
    .update(`${video.videoId}:${video.sizeBytes}:${video.mtimeMs}:${video.durationMs}`)
    .digest('hex')
}

function audioSemanticPersistedJobIsAuthoritative(jobId: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(getAudioSemanticJobPath(), 'utf8')) as {
      jobId?: unknown
      videos?: unknown
    }
    if (raw.jobId !== jobId || !Array.isArray(raw.videos) || raw.videos.length > 10_000)
      return false
    const manifest = new Map(eligibleAudioSemanticVideos().map((video) => [video.videoId, video]))
    return raw.videos.every((value) => {
      if (!value || typeof value !== 'object') return false
      const planned = value as {
        videoId?: unknown
        videoPath?: unknown
        durationMs?: unknown
        sourceFingerprint?: unknown
      }
      if (typeof planned.videoId !== 'string') return false
      const current = manifest.get(planned.videoId)
      if (!current) return false
      const plannedPath =
        typeof planned.videoPath === 'string' ? path.resolve(planned.videoPath) : ''
      const currentPath = path.resolve(current.path)
      const samePath =
        process.platform === 'win32'
          ? plannedPath.toLowerCase() === currentPath.toLowerCase()
          : plannedPath === currentPath
      return (
        samePath &&
        planned.durationMs === current.durationMs &&
        planned.sourceFingerprint === audioSemanticSourceFingerprint(current)
      )
    })
  } catch {
    return false
  }
}

function getAudioSemanticUiStatus() {
  return getAudioSemanticUiStatusWithRefresh(false)
}

function buildAudioSemanticStaticStatus(forceRefresh = false) {
  const indexed = getAudioSemanticTranscriptStatsSnapshot({ force: forceRefresh })
  const runtime = inspectAudioSemanticRuntime()
  const diarization = inspectAudioDiarizationRuntime()
  return {
    runtime,
    diarization,
    indexState:
      indexed.segments > 0 || (indexed.pending && indexed.videos > 0)
        ? ('ready' as const)
        : ('index-stale' as const),
    indexedVideos: indexed.videos,
    indexedSegments: indexed.segments,
    statsPending: indexed.pending,
    eligibleVideos: eligibleAudioSemanticVideos().length,
    capabilities: {
      asr: true,
      language: true,
      emotion: true,
      audioEvents: true,
      speakerDiarization: diarization.state === 'ready',
    },
  }
}

function getAudioSemanticUiStatusWithRefresh(forceRefresh: boolean) {
  const now = Date.now()
  if (
    forceRefresh ||
    !audioSemanticStaticStatusCache ||
    audioSemanticStaticStatusCache.expiresAt <= now ||
    audioSemanticStaticStatusCache.value.statsPending
  ) {
    audioSemanticStaticStatusCache = {
      value: buildAudioSemanticStaticStatus(forceRefresh),
      expiresAt: now + AUDIO_SEMANTIC_STATIC_STATUS_CACHE_MS,
    }
  }
  const staticStatus = audioSemanticStaticStatusCache.value
  const persistedJob = readAudioSemanticJob()
  const job =
    persistedJob?.state === 'running' && !audioSemanticChildBusy
      ? { ...persistedJob, state: 'stopped' as const, lastError: 'app-restarted' }
      : persistedJob
  const ready = staticStatus.runtime.state === 'ready'
  const busy = job?.state === 'running' && audioSemanticChildBusy
  return {
    ...staticStatus,
    runtime: busy ? { ...staticStatus.runtime, state: 'busy' as const } : staticStatus.runtime,
    ...(job ? { job } : {}),
    canBuild: ready && !busy,
    canStop: Boolean(job && busy),
    canResume: Boolean(
      job && ready && !busy && (job.state === 'stopped' || job.state === 'failed'),
    ),
    modelDownloadRequired: !ready,
    updatedAt: Date.now(),
  }
}

let mediaSearchSortedVideoListCache: {
  signature: string
  records: ReturnType<typeof loadVideoManifest>
} | null = null

function getSortedMediaSearchVideos(): ReturnType<typeof loadVideoManifest> {
  const records = loadVideoManifest().filter((record) => !record.missing)
  const signature = records
    .map(
      (record) =>
        `${record.videoId}:${record.updatedAt}:${record.metadataStatus}:${record.thumbnailStatus}`,
    )
    .join('|')
  if (mediaSearchSortedVideoListCache?.signature === signature) {
    return mediaSearchSortedVideoListCache.records
  }
  const sorted = records.sort((a, b) => {
    const aBad = a.metadataStatus === 'error' || a.thumbnailStatus === 'error'
    const bBad = b.metadataStatus === 'error' || b.thumbnailStatus === 'error'
    if (aBad !== bBad) return aBad ? 1 : -1
    const aTime = a.updatedAt || a.discoveredAt || 0
    const bTime = b.updatedAt || b.discoveredAt || 0
    return bTime - aTime
  })
  mediaSearchSortedVideoListCache = { signature, records: sorted }
  return sorted
}

function sendMediaTaskProgress(
  getMainWindow: MainWindowProvider,
  progress: MediaSearchTaskProgress,
): void {
  try {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mediaSearch:onTaskProgress', progress)
    }
  } catch {
    /* ignore */
  }
}

function sendMediaSearchProgress(
  getMainWindow: MainWindowProvider,
  payload: Record<string, unknown>,
): void {
  try {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mediaSearch:onSearchProgress', payload)
    }
  } catch {
    /* ignore */
  }
}

function formatMediaSearchVectorProgressMessage(
  phase: 'embedding' | 'indexing' | 'scanning',
  candidatesScanned: number,
  totalCandidates: number,
  embeddingMessage: string,
): string {
  if (phase === 'indexing') return 'Checking frame vector index...'
  if (phase === 'embedding') return embeddingMessage
  return `Scanning frame vectors: ${candidatesScanned}/${Math.max(0, totalCandidates)} candidates`
}

export function registerMediaSearchCoreIpc(
  getMainWindow: MainWindowProvider,
  taskScheduler?: UnifiedTaskSubmitter,
): void {
  videoSemanticTaskScheduler = taskScheduler
  setMediaTaskProgressCallback((progress) => sendMediaTaskProgress(getMainWindow, progress))

  secureIpcMain.handle('mediaSearch:getStatus', async (_event, rawRequest: unknown) => {
    const request =
      typeof rawRequest === 'object' && rawRequest !== null
        ? (rawRequest as { includeCounts?: unknown })
        : {}
    await warmFfmpegStatusCache()
    return getMediaSearchStatus({ includeCounts: request.includeCounts !== false })
  })

  secureIpcMain.handle('mediaSearch:getCacheStats', async () => getMediaCacheStatsAsync())

  secureIpcMain.handle(
    'mediaSearch:getVideoSemanticStatus',
    async (_event, rawVideoId: unknown, rawForceRefresh: unknown) => {
      if (rawVideoId !== undefined && !knownVideoId(rawVideoId)) {
        throw new Error('Video not found in manifest')
      }
      if (rawForceRefresh !== undefined && typeof rawForceRefresh !== 'boolean') {
        throw new Error('Invalid refresh option')
      }
      return getVideoSemanticUiService().getStatus(
        rawVideoId === undefined ? undefined : String(rawVideoId),
        rawForceRefresh === true,
      )
    },
  )

  secureIpcMain.handle(
    'mediaSearch:setVideoSemanticProfile',
    async (_event, rawVideoId: unknown, rawProfileId: unknown) => {
      const videoId = knownVideoId(rawVideoId)
      if (!videoId) return { ok: false, error: 'Video not found in manifest' }
      const profileId = typeof rawProfileId === 'string' ? rawProfileId : ''
      return getVideoSemanticUiService().setProfile(
        videoId,
        profileId as import('../shared/videoSemantic').VideoSemanticProfileId | 'auto',
      )
    },
  )

  secureIpcMain.handle(
    'mediaSearch:startVideoSemanticBuild',
    async (_event, rawVideoId: unknown) => {
      if (isSourceFileSyncRunning()) {
        return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
      }
      const videoId = knownVideoId(rawVideoId)
      if (!videoId) return { ok: false, error: 'Video not found in manifest' }
      mediaMaintenanceReservations += 1
      try {
        if (isSourceFileSyncRunning()) {
          return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
        }
        return await getVideoSemanticUiService().start(videoId)
      } finally {
        mediaMaintenanceReservations = Math.max(0, mediaMaintenanceReservations - 1)
      }
    },
  )

  secureIpcMain.handle('mediaSearch:stopVideoSemanticJob', async (_event, rawJobId: unknown) => {
    if (typeof rawJobId !== 'string') return { ok: false, error: 'Invalid job id' }
    try {
      return await getVideoSemanticUiService().stop(rawJobId)
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  secureIpcMain.handle('mediaSearch:resumeVideoSemanticJob', async (_event, rawJobId: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    if (typeof rawJobId !== 'string') return { ok: false, error: 'Invalid job id' }
    mediaMaintenanceReservations += 1
    try {
      return await getVideoSemanticUiService().resume(rawJobId)
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    } finally {
      mediaMaintenanceReservations = Math.max(0, mediaMaintenanceReservations - 1)
    }
  })

  secureIpcMain.handle('mediaSearch:clearCache', async () => {
    if (isSourceFileSyncRunning()) {
      return {
        ok: false,
        deletedEntries: 0,
        freedBytes: 0,
        error: SOURCE_FILE_SYNC_BUSY_MESSAGE,
      }
    }
    const status = getMediaSearchStatus()
    if (status.state === 'running') {
      return {
        ok: false,
        deletedEntries: 0,
        freedBytes: 0,
        error: 'Stop the active MediaSearch task before clearing cache',
      }
    }
    const result = clearMediaSearchCache()
    clearMediaSearchImageDataUrlCache()
    return result
  })

  secureIpcMain.handle('mediaSearch:clearData', async () => {
    if (isSourceFileSyncRunning()) {
      return {
        ok: false,
        deletedEntries: 0,
        freedBytes: 0,
        removedEmbeddings: 0,
        error: SOURCE_FILE_SYNC_BUSY_MESSAGE,
      }
    }
    const status = getMediaSearchStatus()
    if (status.state === 'running') {
      return {
        ok: false,
        deletedEntries: 0,
        freedBytes: 0,
        removedEmbeddings: 0,
        error: 'Stop the active MediaSearch task before clearing video data',
      }
    }
    const result = clearMediaSearchData()
    clearMediaSearchImageDataUrlCache()
    mediaSearchSortedVideoListCache = null
    audioSemanticStaticStatusCache = null
    return result
  })

  secureIpcMain.handle('mediaSearch:listVideos', async (_event, rawRequest: unknown) => {
    if (isSourceFileSyncRunning()) return { videos: [], total: 0 }
    const request =
      typeof rawRequest === 'object' && rawRequest !== null
        ? (rawRequest as { limit?: unknown; includeImages?: unknown })
        : { limit: rawRequest }
    const limit =
      typeof request.limit === 'number' && Number.isFinite(request.limit)
        ? Math.max(1, Math.min(1000, Math.floor(request.limit)))
        : 200
    const includeImages = request.includeImages === true
    if (!includeImages) {
      const preview = loadVideoManifestPreview(limit)
      return {
        videos: preview.records,
        total: preview.total,
      }
    }
    const all = getSortedMediaSearchVideos()
    return {
      videos: all.slice(0, limit).map((record) => ({
        ...record,
        thumbnailDataUrl: includeImages
          ? readMediaSearchThumbnailDataUrl(record.thumbnailPath)
          : undefined,
      })),
      total: all.length,
    }
  })

  secureIpcMain.handle('mediaSearch:listFrames', async (_event, rawRequest: unknown) => {
    if (isSourceFileSyncRunning()) return { frames: [], total: 0 }
    const request =
      typeof rawRequest === 'object' && rawRequest !== null
        ? (rawRequest as { limit?: unknown; includeImages?: unknown })
        : { limit: rawRequest }
    const limit =
      typeof request.limit === 'number' && Number.isFinite(request.limit)
        ? Math.max(1, Math.min(2000, Math.floor(request.limit)))
        : 500
    const includeImages = request.includeImages === true
    if (!includeImages) {
      const preview = loadVideoFrameManifestPreview(limit)
      return {
        frames: preview.frames,
        total: preview.total,
      }
    }
    const all = loadAvailableVideoFrameManifest()
    return {
      frames: all.slice(0, limit).map((record) => ({
        ...record,
        imageDataUrl: includeImages ? readMediaSearchImageDataUrl(record.imagePath) : undefined,
      })),
      total: all.length,
    }
  })

  secureIpcMain.handle('mediaSearch:getFrameImageDataUrl', async (_event, rawPath: unknown) => {
    if (isSourceFileSyncRunning()) return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    const filePath = safeShellPath(rawPath)
    if (!filePath) return { ok: false, error: 'Invalid path' }
    const dataUrl = readMediaSearchImageDataUrl(filePath)
    return dataUrl ? { ok: true, dataUrl } : { ok: false, error: 'Image unavailable' }
  })

  secureIpcMain.handle('mediaSearch:getFramePreview', async (_event, rawRequest: unknown) => {
    if (isSourceFileSyncRunning()) return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    const frameId =
      typeof (rawRequest as { frameId?: unknown } | null)?.frameId === 'string'
        ? ((rawRequest as { frameId: string }).frameId.trim() as string)
        : ''
    if (!/^[a-fA-F0-9]{40}$/.test(frameId)) return { ok: false, error: 'Invalid frame id' }
    const frame = findReadyVideoFrameById(frameId)
    if (!frame) return { ok: false, error: 'Frame not found in manifest' }
    const dataUrl = readMediaSearchImageDataUrl(frame.imagePath)
    return dataUrl ? { ok: true, dataUrl } : { ok: false, error: 'Image unavailable' }
  })

  secureIpcMain.handle('mediaSearch:getFrameEmbeddingStats', async () => getFrameEmbeddingStats())

  secureIpcMain.handle('mediaSearch:buildFrameEmbeddings', async (_event, rawRequest: unknown) => {
    if (isSourceFileSyncRunning()) {
      return runtimeFailure('VECTOR_CLEANUP_RUNNING', SOURCE_FILE_SYNC_BUSY_MESSAGE)
    }
    const request = rawRequest as {
      modelName?: unknown
      backend?: unknown
      maxConcurrentEmbeddings?: unknown
      scanPaths?: unknown
    }
    const modelName =
      request?.modelName === 'dinov2_vitb14' || request?.modelName === 'clip_vit_base_patch32'
        ? request.modelName
        : null
    if (!modelName) return runtimeFailure('FRAME_MODEL_INVALID')
    const readyFrames = getReadyVideoFrameCount()
    if (readyFrames <= 0) {
      return runtimeFailure('FRAME_IMAGES_MISSING')
    }
    const scopePaths = normalizeMediaSearchScopePaths(request.scanPaths)
    const frameImageIds = loadVideoFrameManifest()
      .filter(
        (record) =>
          record.status === 'done' &&
          record.imagePath &&
          fs.existsSync(record.imagePath) &&
          isMediaSearchPathInScope(record.videoPath, scopePaths),
      )
      .map((record) => record.imagePath as string)
    if (frameImageIds.length === 0) {
      return runtimeFailure(
        scopePaths.length > 0 ? 'FRAME_IMAGES_MISSING_IN_SCOPE' : 'FRAME_IMAGES_MISSING',
      )
    }
    const releaseVectorMutation = tryAcquireVectorMutationReservation()
    if (!releaseVectorMutation) return runtimeFailure('VECTOR_CLEANUP_RUNNING')
    const releaseReservation = beginMediaMaintenanceReservation()
    try {
      const backend = await resolveRequestedComputeBackend(
        request.backend === 'auto' || request.backend === 'cpu' || request.backend === 'gpu'
          ? request.backend
          : 'auto',
      )
      if (isSourceFileSyncRunning()) {
        return runtimeFailure('VECTOR_CLEANUP_RUNNING', SOURCE_FILE_SYNC_BUSY_MESSAGE)
      }
      const maxConcurrentEmbeddings =
        typeof request.maxConcurrentEmbeddings === 'number' &&
        Number.isFinite(request.maxConcurrentEmbeddings)
          ? Math.max(1, Math.min(12, Math.floor(request.maxConcurrentEmbeddings)))
          : modelName === 'clip_vit_base_patch32'
            ? 8
            : 1
      const { invalidateFrameIndex } = await import('./mediaSearchFrameIndex')
      if (isSourceFileSyncRunning()) {
        return runtimeFailure('VECTOR_CLEANUP_RUNNING', SOURCE_FILE_SYNC_BUSY_MESSAGE)
      }
      invalidateFrameIndex()
      markMediaFrameEmbeddingBuildActive()
      const buildRequest: VectorBuildRequest = {
        modelName,
        embeddingType: 'global',
        imageIds: frameImageIds,
        backend,
        maxConcurrentEmbeddings,
      }
      try {
        const result = taskScheduler
          ? queueEmbeddingBuild(buildRequest, taskScheduler)
          : await startEmbeddingBuild(buildRequest)
        if (!result.ok) clearMediaFrameEmbeddingBuildActive()
        return result
      } catch (error) {
        clearMediaFrameEmbeddingBuildActive()
        throw error
      }
    } finally {
      releaseReservation()
      releaseVectorMutation()
    }
  })

  secureIpcMain.handle('mediaSearch:selectVideoPaths', async (_event, rawMode: unknown) => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return null
    const mode =
      rawMode === 'single-video' || rawMode === 'folders' || rawMode === 'videos'
        ? rawMode
        : 'videos'
    const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> =
      mode === 'single-video'
        ? ['openFile']
        : mode === 'folders'
          ? ['openDirectory', 'multiSelections']
          : ['openFile', 'multiSelections']
    const result = await dialog.showOpenDialog(mainWindow, {
      properties,
      ...(mode !== 'folders'
        ? {
            filters: [
              {
                name: 'Video files',
                extensions: [
                  'mp4',
                  'mkv',
                  'mov',
                  'avi',
                  'webm',
                  'wmv',
                  'm4v',
                  'flv',
                  'ts',
                  'mts',
                  'm2ts',
                ],
              },
              { name: 'All files', extensions: ['*'] },
            ],
          }
        : {}),
    })
    if (result.canceled) return null
    const paths = result.filePaths.filter((filePath) => {
      try {
        const stat = fs.statSync(filePath)
        return mode === 'folders' ? stat.isDirectory() : stat.isFile() && isVideoPath(filePath)
      } catch {
        return false
      }
    })
    if (mode === 'single-video' && paths.length > 1) paths.splice(1)
    for (const p of paths) knownRevealRoots.add(path.normalize(p).toLowerCase())
    return { paths }
  })

  secureIpcMain.handle('mediaSearch:listDrives', async () => {
    if (process.platform !== 'win32') return ['/']
    const drives: string[] = []
    for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const root = `${String.fromCharCode(c)}:\\`
      try {
        if (fs.existsSync(root)) drives.push(root)
      } catch {
        /* skip inaccessible drive */
      }
    }
    return drives
  })

  secureIpcMain.handle('mediaSearch:validatePath', async (_event, rawPath: unknown) => {
    const filePath = safeShellPath(rawPath)
    if (!filePath) return { ok: false, error: 'Invalid path' }
    try {
      const stat = fs.statSync(filePath)
      if (stat.isDirectory() || (stat.isFile() && isVideoPath(filePath))) {
        return { ok: true, path: filePath }
      }
      return { ok: false, error: 'Path must be a video file or directory' }
    } catch {
      return { ok: false, error: 'Path does not exist or is inaccessible' }
    }
  })

  secureIpcMain.handle('mediaSearch:selectFfmpegDirectory', async () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select FFmpeg bin directory',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return saveFfmpegDirectory(result.filePaths[0])
  })

  secureIpcMain.handle('mediaSearch:clearFfmpegDirectory', async () => clearFfmpegDirectory())

  secureIpcMain.handle('mediaSearch:openFfmpegToolsDirectory', async () => {
    const result = ensureBundledFfmpegBinDir()
    if (!result.ok || !result.toolsDir) return result
    const openResult = await openSafeShellPath(shell, result.toolsDir, { requireExists: true })
    return openResult.ok
      ? result
      : { ok: false, toolsDir: result.toolsDir, error: openResult.error }
  })

  secureIpcMain.handle('videoIndex:startScan', async (_event, req: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    const args = normalizeMediaSearchStartScanArgs(req)
    if (!args) return { ok: false, error: 'Invalid MediaSearch scan request' }
    for (const p of args.paths) knownRevealRoots.add(path.normalize(p).toLowerCase())
    const helpMsg = getFfmpegHelpMessage()
    if (isStorageCleanupActiveFor('media-search')) {
      return { ok: false, error: 'Media Search storage cleanup is running' }
    }
    const releaseReservation = beginMediaMaintenanceReservation()
    try {
      if (isSourceFileSyncRunning()) {
        return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
      }
      const result = await startMediaIndexScan(args)
      if (helpMsg && result.ok) {
        result.warning = helpMsg
      }
      return result
    } finally {
      releaseReservation()
    }
  })

  secureIpcMain.handle('mediaSearch:buildFrames', async (_event, req: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    const raw = req as { paths?: unknown }
    const paths = normalizeMediaSearchScopePaths(raw?.paths)
    const releaseReservation = beginMediaMaintenanceReservation()
    try {
      if (isSourceFileSyncRunning()) {
        return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
      }
      return await startMediaFrameBuild({ paths }, taskScheduler)
    } finally {
      releaseReservation()
    }
  })

  secureIpcMain.handle('mediaSearch:prepareLibrary', async (_event, req: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    if (!req || typeof req !== 'object') {
      return { ok: false, error: 'Invalid media library preparation request' }
    }
    const raw = req as {
      paths?: unknown
      backend?: unknown
      maxConcurrentEmbeddings?: unknown
      batchSize?: unknown
    }
    if (raw.paths !== undefined && !Array.isArray(raw.paths)) {
      return { ok: false, error: 'Invalid media library scope' }
    }
    const paths = normalizeMediaSearchScopePaths(raw.paths)
    if (Array.isArray(raw.paths) && raw.paths.length > 0 && paths.length === 0) {
      return { ok: false, error: 'No readable media library scope paths' }
    }
    if (
      raw.backend !== undefined &&
      raw.backend !== 'auto' &&
      raw.backend !== 'cpu' &&
      raw.backend !== 'gpu'
    ) {
      return { ok: false, error: 'Invalid media library compute backend' }
    }
    if (
      raw.maxConcurrentEmbeddings !== undefined &&
      (typeof raw.maxConcurrentEmbeddings !== 'number' ||
        !Number.isFinite(raw.maxConcurrentEmbeddings))
    ) {
      return { ok: false, error: 'Invalid media library embedding concurrency' }
    }
    if (
      raw.batchSize !== undefined &&
      (typeof raw.batchSize !== 'number' || !Number.isFinite(raw.batchSize))
    ) {
      return { ok: false, error: 'Invalid media library embedding batch size' }
    }
    if (isStorageCleanupActiveFor('media-search')) {
      return { ok: false, error: 'Media Search storage cleanup is running' }
    }
    const releaseVectorMutation = tryAcquireVectorMutationReservation()
    if (!releaseVectorMutation) return { ok: false, error: 'Vector maintenance is running' }
    const releaseReservation = beginMediaMaintenanceReservation()
    try {
      const backend = await resolveRequestedComputeBackend(
        raw.backend === 'auto' || raw.backend === 'cpu' || raw.backend === 'gpu'
          ? raw.backend
          : 'auto',
      )
      if (isSourceFileSyncRunning()) {
        return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
      }
      const batchSize =
        raw.batchSize === undefined
          ? undefined
          : raw.batchSize === 0
            ? 0
            : Math.max(1, Math.min(16, Math.floor(Number(raw.batchSize))))
      return await startMediaLibraryPreparation(
        {
          paths,
          backend,
          maxConcurrentEmbeddings: Math.max(
            1,
            Math.min(12, Math.floor(Number(raw.maxConcurrentEmbeddings) || 2)),
          ),
          ...(batchSize !== undefined ? { batchSize } : {}),
        },
        taskScheduler,
      )
    } finally {
      releaseReservation()
      releaseVectorMutation()
    }
  })

  secureIpcMain.handle('videoIndex:stopTask', async (_event, taskId: unknown) => {
    return stopMediaTask(normalizeTaskId(taskId))
  })

  secureIpcMain.handle('videoIndex:getTaskProgress', async (_event, taskId: unknown) => {
    return getMediaTaskProgress(normalizeTaskId(taskId))
  })

  secureIpcMain.handle('mediaSearch:selectQueryImage', async () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Image files', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const filePath = safeShellPath(result.filePaths[0])
    if (!filePath || !isMediaSearchQueryImagePath(filePath)) return null
    try {
      const stat = fs.statSync(filePath)
      return stat.isFile() ? { path: filePath } : null
    } catch {
      return null
    }
  })

  secureIpcMain.handle('mediaSearch:pasteClipboardImage', async () => {
    try {
      const image = clipboard.readImage()
      if (!image || image.isEmpty()) {
        return { ok: false, error: 'Clipboard does not contain an image.' }
      }
      const dir = path.join(app.getPath('userData'), 'media-search-queries')
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, `clipboard-${Date.now()}.png`)
      fs.writeFileSync(filePath, image.toPNG())
      return { ok: true, path: filePath }
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) }
    }
  })

  secureIpcMain.handle('mediaSearch:searchSimilarFrame', async (_event, rawRequest: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, results: [], totalCandidates: 0, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    const request = rawRequest as {
      requestId?: unknown
      frameId?: unknown
      modelName?: unknown
      topK?: unknown
    }
    const frameId =
      typeof request?.frameId === 'string' && /^[a-fA-F0-9]{40}$/.test(request.frameId)
        ? request.frameId
        : ''
    if (!frameId) return { ok: false, results: [], totalCandidates: 0, error: 'Invalid frame id' }
    const modelName =
      request.modelName === 'dinov2_vitb14' || request.modelName === 'clip_vit_base_patch32'
        ? request.modelName
        : undefined
    const topK =
      typeof request.topK === 'number' && Number.isFinite(request.topK)
        ? Math.max(1, Math.min(200, Math.floor(request.topK)))
        : 50
    const startedAt = Date.now()
    const releaseVectorSearch = tryAcquireVectorSearchReservation()
    if (!releaseVectorSearch) {
      return { ok: false, results: [], totalCandidates: 0, error: 'Vector maintenance is running' }
    }
    const sourceSyncEpoch = getSourceFileSyncMutationEpoch()
    activeMediaSearches += 1
    try {
      const result = await searchSimilarVideoFrames({
        frameId,
        modelName,
        topK,
        onProgress: (p) => {
          const total = Math.max(1, p.shardTotal)
          const completed = Math.max(0, Math.min(total, p.shardIndex))
          sendMediaSearchProgress(getMainWindow, {
            taskId: normalizeTaskId(request.requestId) || `similar-${frameId.slice(0, 8)}`,
            type: 'build-visual-vector',
            state: 'running',
            total,
            completed,
            failed: 0,
            percentage: Math.round((completed / total) * 100),
            message: formatMediaSearchVectorProgressMessage(
              p.phase,
              p.candidatesScanned,
              total,
              'Preparing query frame vector...',
            ),
            startedAt,
            updatedAt: Date.now(),
            elapsedMs: Date.now() - startedAt,
          })
        },
      })
      if (isSourceFileSyncRunning() || sourceSyncEpoch !== getSourceFileSyncMutationEpoch()) {
        return {
          ok: false,
          results: [],
          totalCandidates: 0,
          error: 'Search results were discarded because source synchronization changed the index',
        }
      }
      return result
    } finally {
      activeMediaSearches = Math.max(0, activeMediaSearches - 1)
      releaseVectorSearch()
    }
  })

  secureIpcMain.handle('mediaSearch:searchFramesByImage', async (_event, rawRequest: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, results: [], totalCandidates: 0, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    const request = rawRequest as {
      requestId?: unknown
      imagePath?: unknown
      modelName?: unknown
      backend?: unknown
      topK?: unknown
      scanPaths?: unknown
    }
    const imagePath = typeof request?.imagePath === 'string' ? safeShellPath(request.imagePath) : ''
    if (!imagePath || !isMediaSearchQueryImagePath(imagePath)) {
      return { ok: false, results: [], totalCandidates: 0, error: 'Invalid query image path' }
    }
    try {
      const stat = fs.statSync(imagePath)
      if (!stat.isFile()) {
        return { ok: false, results: [], totalCandidates: 0, error: 'Query image is not a file' }
      }
    } catch {
      return { ok: false, results: [], totalCandidates: 0, error: 'Query image file is missing' }
    }
    const modelName =
      request.modelName === 'dinov2_vitb14' || request.modelName === 'clip_vit_base_patch32'
        ? request.modelName
        : undefined
    const backend = request.backend === 'cpu' || request.backend === 'gpu' ? request.backend : 'gpu'
    const topK =
      typeof request.topK === 'number' && Number.isFinite(request.topK)
        ? Math.max(1, Math.min(1000, Math.floor(request.topK)))
        : 50
    const releaseVectorSearch = tryAcquireVectorSearchReservation()
    if (!releaseVectorSearch) {
      return { ok: false, results: [], totalCandidates: 0, error: 'Vector maintenance is running' }
    }
    const sourceSyncEpoch = getSourceFileSyncMutationEpoch()
    activeMediaSearches += 1
    try {
      const result = await searchVideoFramesByImage({
        imagePath,
        modelName,
        backend,
        topK,
        scanPaths: normalizeMediaSearchScopePaths(request.scanPaths),
        onProgress: (p) => {
          const total = Math.max(1, p.shardTotal)
          const completed = Math.max(0, Math.min(total, p.shardIndex))
          sendMediaSearchProgress(getMainWindow, {
            taskId:
              normalizeTaskId(request.requestId) ||
              `imgsearch-${path.basename(imagePath).slice(0, 20)}`,
            type: 'build-visual-vector',
            state: 'running',
            total,
            completed,
            failed: 0,
            percentage: Math.round((completed / total) * 100),
            message: formatMediaSearchVectorProgressMessage(
              p.phase,
              p.candidatesScanned,
              total,
              'Computing query image embedding...',
            ),
            startedAt: Date.now(),
            updatedAt: Date.now(),
          })
        },
      })
      if (isSourceFileSyncRunning() || sourceSyncEpoch !== getSourceFileSyncMutationEpoch()) {
        return {
          ok: false,
          results: [],
          totalCandidates: 0,
          error: 'Search results were discarded because source synchronization changed the index',
        }
      }
      return result
    } finally {
      activeMediaSearches = Math.max(0, activeMediaSearches - 1)
      releaseVectorSearch()
    }
  })

  secureIpcMain.handle('mediaSearch:searchFramesByText', async (_event, rawRequest: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, results: [], totalCandidates: 0, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    const request = rawRequest as {
      requestId?: unknown
      textQuery?: unknown
      topK?: unknown
      scanPaths?: unknown
    }
    const textQuery = typeof request?.textQuery === 'string' ? request.textQuery.trim() : ''
    if (!textQuery) return { ok: false, results: [], totalCandidates: 0, error: 'Empty text query' }
    const topK =
      typeof request.topK === 'number' && Number.isFinite(request.topK)
        ? Math.max(1, Math.min(1000, Math.floor(request.topK)))
        : 50
    const startedAt = Date.now()
    const releaseVectorSearch = tryAcquireVectorSearchReservation()
    if (!releaseVectorSearch) {
      return { ok: false, results: [], totalCandidates: 0, error: 'Vector maintenance is running' }
    }
    const sourceSyncEpoch = getSourceFileSyncMutationEpoch()
    activeMediaSearches += 1
    try {
      const result = await searchVideoFramesByText({
        textQuery,
        topK,
        scanPaths: normalizeMediaSearchScopePaths(request.scanPaths),
        onProgress: (p) => {
          const elapsedMs = Date.now() - startedAt
          const total = Math.max(1, p.shardTotal)
          const completed = Math.max(0, Math.min(total, p.shardIndex))
          sendMediaSearchProgress(getMainWindow, {
            taskId:
              normalizeTaskId(request.requestId) ||
              `txtsearch-${crypto.createHash('sha1').update(textQuery).digest('hex').slice(0, 12)}`,
            type: 'build-visual-vector',
            state: 'running',
            total,
            completed,
            failed: 0,
            percentage: Math.round((completed / total) * 100),
            message: formatMediaSearchVectorProgressMessage(
              p.phase,
              p.candidatesScanned,
              total,
              'Computing CLIP text embedding...',
            ),
            startedAt,
            updatedAt: Date.now(),
            elapsedMs,
          })
        },
      })
      if (isSourceFileSyncRunning() || sourceSyncEpoch !== getSourceFileSyncMutationEpoch()) {
        return {
          ok: false,
          results: [],
          totalCandidates: 0,
          error: 'Search results were discarded because source synchronization changed the index',
        }
      }
      return result
    } finally {
      activeMediaSearches = Math.max(0, activeMediaSearches - 1)
      releaseVectorSearch()
    }
  })

  secureIpcMain.handle('mediaSearch:openMediaAtTime', async (_event, input: unknown) => {
    const resolved = resolveControlledMediaSeek(input, loadVideoManifest())
    if (!resolved.ok) return resolved
    const result = await openControlledMediaPlayer(resolved.value, { parent: getMainWindow() })
    return result.ok
      ? { ok: true, timestampMs: resolved.value.timestampMs, mode: 'internal-player' as const }
      : { ok: false, error: result.error || 'Unable to open media' }
  })

  secureIpcMain.handle('mediaSearch:revealInExplorer', async (_event, input: unknown) => {
    const raw = input as { videoId?: unknown; scanPath?: unknown } | null
    const videoId = typeof raw?.videoId === 'string' && raw.videoId.trim() ? raw.videoId.trim() : ''
    if (videoId) {
      const video = loadVideoManifest().find((v) => v.videoId === videoId)
      if (!video) return { ok: false, error: 'Video not found in manifest' }
      if (video.missing) return { ok: false, error: 'Video file is missing' }
      const result = revealSafeShellPath(shell, video.path, { requireExists: true })
      return result.ok ? { ok: true } : { ok: false, error: result.error || 'Invalid path' }
    }
    const scanPath = safeShellPath(raw?.scanPath)
    if (
      scanPath &&
      isRevealableMediaScanPath(
        scanPath,
        knownRevealRoots,
        loadVideoManifest().map((v) => v.path),
        (p) => {
          try {
            return fs.statSync(p).isDirectory()
          } catch {
            return false
          }
        },
      )
    ) {
      const result = revealSafeShellPath(shell, scanPath, { requireExists: true })
      return result.ok ? { ok: true } : { ok: false, error: result.error || 'Invalid path' }
    }
    return { ok: false, error: 'Path is not a known media search location' }
  })

  secureIpcMain.handle('mediaSearch:detectSubtitles', async (_event, rawPath: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    const filePath = safeShellPath(rawPath)
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'Invalid video path' }
    return detectSubtitleStreams(filePath)
  })

  secureIpcMain.handle('mediaSearch:extractSubtitles', async (_event, rawVideoId: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    const videoId = typeof rawVideoId === 'string' && rawVideoId.trim() ? rawVideoId.trim() : ''
    if (!videoId) return { ok: false, error: 'Invalid video id' }
    const videos = loadVideoManifest()
    const video = videos.find((v: { videoId: string }) => v.videoId === videoId)
    if (!video) return { ok: false, error: 'Video not found in manifest' }
    const result = extractVideoSubtitles(videoId, video.path)
    return {
      ok: result.ok,
      videoId,
      streamCount: result.transcript ? 1 : 0,
      segmentCount: result.transcript?.segments.length ?? 0,
      language: result.transcript?.language,
      error: result.error,
    }
  })

  secureIpcMain.handle('mediaSearch:getAudioSemanticStatus', async (_event, rawForceRefresh) => {
    if (rawForceRefresh !== undefined && typeof rawForceRefresh !== 'boolean') {
      throw new Error('Invalid refresh option')
    }
    return getAudioSemanticUiStatusWithRefresh(rawForceRefresh === true)
  })

  secureIpcMain.handle(
    'mediaSearch:startAudioSemanticBuild',
    async (_event, rawVideoId: unknown) => {
      if (isSourceFileSyncRunning()) {
        return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
      }
      try {
        const videoId = rawVideoId === undefined ? undefined : knownVideoId(rawVideoId)
        if (videoId === null) return { ok: false, error: 'Video not found in manifest' }
        if (audioSemanticChildBusy)
          return { ok: false, error: 'audio-semantic-job-already-running' }
        const runtime = inspectAudioSemanticRuntime()
        if (runtime.state !== 'ready') return { ok: false, error: runtime.reason || runtime.state }
        const videos = eligibleAudioSemanticVideos(videoId).map((video) => ({
          videoId: video.videoId,
          assetId: video.videoId,
          videoPath: video.path,
          durationMs: video.durationMs as number,
          sourceFingerprint: audioSemanticSourceFingerprint(video),
        }))
        if (videos.length === 0) return { ok: false, error: 'No indexed videos with audio' }
        audioSemanticChildBusy = true
        await sendAudioSemanticCommand({ type: 'start', videos })
        return { ok: true, status: getAudioSemanticUiStatus() }
      } catch (error) {
        audioSemanticChildBusy = false
        return { ok: false, error: errorMessage(error), status: getAudioSemanticUiStatus() }
      }
    },
  )

  secureIpcMain.handle('mediaSearch:stopAudioSemanticBuild', async (_event, rawJobId: unknown) => {
    if (typeof rawJobId !== 'string' || !rawJobId.trim()) {
      return { ok: false, error: 'Invalid job id' }
    }
    const job = readAudioSemanticJob()
    if (!job || job.jobId !== rawJobId || !audioSemanticChildBusy) {
      return { ok: false, error: 'Audio semantic job is not running' }
    }
    try {
      await sendAudioSemanticCommand({ type: 'stop', jobId: rawJobId })
      return { ok: true, status: getAudioSemanticUiStatus() }
    } catch (error) {
      return { ok: false, error: errorMessage(error), status: getAudioSemanticUiStatus() }
    }
  })

  secureIpcMain.handle(
    'mediaSearch:resumeAudioSemanticBuild',
    async (_event, rawJobId: unknown) => {
      if (isSourceFileSyncRunning()) {
        return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
      }
      if (typeof rawJobId !== 'string' || !rawJobId.trim()) {
        return { ok: false, error: 'Invalid job id' }
      }
      const job = readAudioSemanticJob()
      if (!job || job.jobId !== rawJobId || audioSemanticChildBusy) {
        return { ok: false, error: 'Audio semantic job cannot be resumed' }
      }
      if (!audioSemanticPersistedJobIsAuthoritative(rawJobId)) {
        return { ok: false, error: 'Audio semantic source changed; start a new build' }
      }
      if (job.state !== 'stopped' && job.state !== 'failed' && job.state !== 'running') {
        return { ok: false, error: 'Audio semantic job cannot be resumed' }
      }
      try {
        audioSemanticChildBusy = true
        await sendAudioSemanticCommand({ type: 'resume', jobId: rawJobId })
        return { ok: true, status: getAudioSemanticUiStatus() }
      } catch (error) {
        audioSemanticChildBusy = false
        return { ok: false, error: errorMessage(error), status: getAudioSemanticUiStatus() }
      }
    },
  )

  secureIpcMain.handle('mediaSearch:searchTranscripts', async (_event, rawRequest: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, results: [], totalVideos: 0, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    const request = rawRequest as { query?: unknown; topK?: unknown }
    const query = typeof request?.query === 'string' ? request.query.trim() : ''
    if (!query) return { ok: false, results: [], totalVideos: 0, error: 'Empty query' }
    const topK =
      typeof request.topK === 'number' && Number.isFinite(request.topK)
        ? Math.max(1, Math.min(200, Math.floor(request.topK)))
        : 50
    const availableVideoIds = availableMediaVideoIds()
    const results = searchTranscripts(query, Math.min(1000, topK * 4))
      .filter((result) => availableVideoIds.has(result.videoId))
      .slice(0, topK)
    const uniqueVideos = new Set(results.map((r) => r.videoId)).size
    return { ok: true, results, totalVideos: uniqueVideos }
  })

  secureIpcMain.handle('mediaSearch:searchMultimodal', async (_event, rawRequest: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, results: [], totalCandidates: 0, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    const request = rawRequest as {
      imagePath?: unknown
      frameId?: unknown
      textQuery?: unknown
      modelName?: unknown
      backend?: unknown
      topK?: unknown
      visualWeight?: unknown
      scanPaths?: unknown
    }
    const textQuery = typeof request?.textQuery === 'string' ? request.textQuery.trim() : ''
    if (!textQuery) return { ok: false, results: [], totalCandidates: 0, error: 'Empty text query' }
    const modelName =
      request.modelName === 'dinov2_vitb14' || request.modelName === 'clip_vit_base_patch32'
        ? request.modelName
        : 'clip_vit_base_patch32'
    const backend = request.backend === 'cpu' || request.backend === 'gpu' ? request.backend : 'gpu'
    const topK =
      typeof request.topK === 'number' && Number.isFinite(request.topK)
        ? Math.max(1, Math.min(1000, Math.floor(request.topK)))
        : 50
    const visualWeight =
      typeof request.visualWeight === 'number' && Number.isFinite(request.visualWeight)
        ? Math.max(0, Math.min(1, request.visualWeight))
        : 0.55

    const imagePath =
      typeof request?.imagePath === 'string' ? safeShellPath(request.imagePath) : undefined
    const scanPaths = normalizeMediaSearchScopePaths(request.scanPaths)
    if (
      Array.isArray(request.scanPaths) &&
      request.scanPaths.length > 0 &&
      scanPaths.length === 0
    ) {
      return {
        ok: false,
        results: [],
        totalCandidates: 0,
        error: 'Selected search sources are unavailable',
      }
    }
    const frameId =
      typeof request?.frameId === 'string' && /^[a-fA-F0-9]{40}$/.test(request.frameId)
        ? request.frameId
        : undefined

    const releaseVectorSearch = tryAcquireVectorSearchReservation()
    if (!releaseVectorSearch) {
      return { ok: false, results: [], totalCandidates: 0, error: 'Vector maintenance is running' }
    }
    const sourceSyncEpoch = getSourceFileSyncMutationEpoch()
    activeMediaSearches += 1
    try {
      const availableVideoIds = availableMediaVideoIds()
      const isEligibleVideo = (videoId: string, videoPath: string) =>
        availableVideoIds.has(videoId) && isMediaSearchPathInScope(videoPath, scanPaths)
      const textResults = searchTranscripts(textQuery, topK, { acceptVideo: isEligibleVideo })

      let visualFrames: import('../shared/ipc-contract').MediaSearchVideoFrameRecord[] = []
      if (imagePath && isMediaSearchQueryImagePath(imagePath) && fs.existsSync(imagePath)) {
        const vResult = await searchVideoFramesByImage({
          imagePath,
          modelName,
          backend,
          topK,
          scanPaths,
        })
        if (!vResult.ok) {
          return {
            ok: false,
            results: [],
            totalCandidates: 0,
            error: vResult.error || 'Visual frame search failed',
          }
        }
        visualFrames = vResult.results
      } else if (frameId) {
        const vResult = await searchSimilarVideoFrames({ frameId, modelName, topK, scanPaths })
        if (!vResult.ok) {
          return {
            ok: false,
            results: [],
            totalCandidates: 0,
            error: vResult.error || 'Visual frame search failed',
          }
        }
        visualFrames = vResult.results
      } else {
        return { ok: false, results: [], totalCandidates: 0, error: 'Invalid query image or frame' }
      }

      if (isSourceFileSyncRunning() || sourceSyncEpoch !== getSourceFileSyncMutationEpoch()) {
        return {
          ok: false,
          results: [],
          totalCandidates: 0,
          error: 'Search results were discarded because source synchronization changed the index',
        }
      }
      const fused = fuseMultimodalResults(visualFrames, textResults, visualWeight)
      const scoped = fused.filter((m) => isEligibleVideo(m.frame.videoId, m.frame.videoPath))
      const top = scoped.slice(0, topK).map((m) => m.frame)
      return { ok: true, results: top, totalCandidates: scoped.length }
    } finally {
      activeMediaSearches = Math.max(0, activeMediaSearches - 1)
      releaseVectorSearch()
    }
  })
}
