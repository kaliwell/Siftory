import type {
  AudioSemanticUiStatus,
  DiscoveryScanStatus,
  DiscoverySourceListItem,
  ElectronAPI,
  ImageSearchDataOverview,
  ImageSearchStatus,
  MediaSearchCacheStats,
  MediaSearchTaskProgress,
  MediaSearchStatus,
  ThumbnailRebuildProgress,
  VideoSemanticUiStatus,
} from '../../shared/ipc-contract'
import type { EmbeddingProgress, ModelStatus } from '../../shared/vectorTypes'

export type ProductReadinessState =
  | 'not-started'
  | 'preparing'
  | 'searchable'
  | 'degraded'
  | 'ready'

export type ProductReadinessStageState =
  | 'ready'
  | 'working'
  | 'action-required'
  | 'degraded'
  | 'unavailable'

export type ProductReadinessStageId =
  | 'sources'
  | 'catalog'
  | 'image-semantic'
  | 'video-visual'
  | 'video-semantic'
  | 'audio-semantic'

export type ProductReadinessAction =
  | 'add-source'
  | 'scan-sources'
  | 'reconnect-source'
  | 'prepare-image-search'
  | 'retry-image-index'
  | 'configure-video-tools'
  | 'scan-videos'
  | 'build-video-frames'
  | 'install-video-model'
  | 'resume-video-semantic'
  | 'retry-video-semantic'
  | 'install-audio-model'
  | 'resume-audio-semantic'
  | 'retry-audio-semantic'
  | 'review-derived-reset'

export type ProductReadinessReason =
  | 'status-loading'
  | 'status-unavailable'
  | 'no-source'
  | 'source-ready'
  | 'source-offline'
  | 'source-degraded'
  | 'scan-running'
  | 'catalog-empty'
  | 'catalog-ready'
  | 'model-missing'
  | 'model-preparing'
  | 'model-error'
  | 'image-index-empty'
  | 'image-index-running'
  | 'image-index-ready'
  | 'image-index-error'
  | 'video-tools-missing'
  | 'video-scan-running'
  | 'video-scan-error'
  | 'video-frames-missing'
  | 'video-frames-ready'
  | 'no-video'
  | 'runtime-missing'
  | 'runtime-busy'
  | 'runtime-error'
  | 'index-stale'
  | 'index-incomplete'
  | 'index-ready'

export interface ProductReadinessStage {
  id: ProductReadinessStageId
  state: ProductReadinessStageState
  progress: number
  reason: ProductReadinessReason
  action?: ProductReadinessAction
  warnings?: ProductReadinessReason[]
  counts: Record<string, number>
}

export interface ProductSearchCapabilities {
  metadata: boolean
  imageSimilarity: boolean
  naturalLanguageImage: boolean
  videoFrame: boolean
  videoSemantic: boolean
  dialogue: boolean
}

export interface ProductModelLifecycleItem {
  id: 'dinov2_vitb14' | 'clip_vit_base_patch32' | 'qwen3-vl' | 'sensevoice'
  management: 'managed-download' | 'external-runtime'
  state:
    | ModelStatus['state']
    | 'ready'
    | 'busy'
    | 'unavailable'
    | 'not-installed'
    | 'error'
    | 'loading'
  progress?: number
}

export type ProductTaskState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'stopped'

export type ProductTaskKind =
  | 'source-scan'
  | 'image-index'
  | 'thumbnail-index'
  | 'image-embedding'
  | 'video-index'
  | 'video-semantic'
  | 'audio-semantic'

export type ProductTaskControlAction = 'pause' | 'resume' | 'stop' | 'retry'

export interface ProductTaskStorage {
  imageBytes?: number
  mediaBytes?: number
  totalBytes?: number
}

export interface ProductTaskInventoryItem {
  id: string
  authorityId?: string
  kind: ProductTaskKind
  state: ProductTaskState
  progress: number
  completed: number
  total: number
  failed: number
  phase?: string
  itemsPerSecond?: number
  etaMs?: number
  currentItem?: string
  error?: string
  startedAt?: number
  updatedAt?: number
  persisted: boolean
  canStop: boolean
  canPause: boolean
  canResume: boolean
  canRetry: boolean
}

export interface ProductReadinessInput {
  sources?: readonly DiscoverySourceListItem[] | null
  scans?: readonly DiscoveryScanStatus[] | null
  imageSearch?: ImageSearchStatus | null
  modelStatuses?: Partial<Record<'dinov2_vitb14' | 'clip_vit_base_patch32', ModelStatus | null>>
  embeddingProgress?: Partial<
    Record<'dinov2_vitb14' | 'clip_vit_base_patch32', EmbeddingProgress | null>
  >
  thumbnailProgress?: ThumbnailRebuildProgress | null
  imageDataOverview?: ImageSearchDataOverview | null
  mediaTaskProgress?: MediaSearchTaskProgress | null
  mediaCacheStats?: MediaSearchCacheStats | null
  mediaSearch?: MediaSearchStatus | null
  videoSemantic?: VideoSemanticUiStatus | null
  audioSemantic?: AudioSemanticUiStatus | null
  unavailableStages?: readonly ProductReadinessStageId[]
}

export interface ProductReadinessSnapshot {
  state: ProductReadinessState
  progress: number
  searchable: boolean
  stages: ProductReadinessStage[]
  capabilities: ProductSearchCapabilities
  models: ProductModelLifecycleItem[]
  tasks: ProductTaskInventoryItem[]
  taskStorage: ProductTaskStorage
  nextAction?: ProductReadinessAction
}

const STAGE_WEIGHTS: Record<ProductReadinessStageId, number> = {
  sources: 10,
  catalog: 15,
  'image-semantic': 25,
  'video-visual': 15,
  'video-semantic': 20,
  'audio-semantic': 15,
}

const ACTION_PRIORITY: ProductReadinessStageId[] = [
  'sources',
  'catalog',
  'image-semantic',
  'video-visual',
  'video-semantic',
  'audio-semantic',
]

const MODEL_READY_STATES = new Set<ModelStatus['state']>(['downloaded', 'verified', 'loaded'])
const MODEL_WORKING_STATES = new Set<ModelStatus['state']>(['downloading', 'loading', 'unloading'])

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function ratioProgress(completed: number, total: number, emptyValue = 0): number {
  if (total <= 0) return clampProgress(emptyValue)
  return clampProgress((completed / total) * 100)
}

function createStage(
  id: ProductReadinessStageId,
  state: ProductReadinessStageState,
  progress: number,
  reason: ProductReadinessReason,
  counts: Record<string, number> = {},
  action?: ProductReadinessAction,
  warnings?: ProductReadinessReason[],
): ProductReadinessStage {
  return {
    id,
    state,
    progress: clampProgress(progress),
    reason,
    ...(action ? { action } : {}),
    ...(warnings?.length ? { warnings: [...new Set(warnings)] } : {}),
    counts,
  }
}

function buildSourceStages(
  sources: readonly DiscoverySourceListItem[] | null | undefined,
  scans: readonly DiscoveryScanStatus[] | null | undefined,
  unavailableStages: ReadonlySet<ProductReadinessStageId>,
): [ProductReadinessStage, ProductReadinessStage] {
  if (unavailableStages.has('sources')) {
    return [
      createStage('sources', 'unavailable', 0, 'status-unavailable'),
      createStage('catalog', 'unavailable', 0, 'status-unavailable'),
    ]
  }
  if (!sources) {
    const loading = createStage('sources', 'working', 0, 'status-loading')
    return [loading, createStage('catalog', 'working', 0, 'status-loading')]
  }

  const totalFiles = sources.reduce((sum, source) => sum + Math.max(0, source.fileCount), 0)
  const onlineSources = sources.filter((source) => source.availability === 'online').length
  const degradedSources = sources.filter((source) => source.availability === 'degraded').length
  const offlineSources = sources.filter((source) => source.availability === 'offline').length
  const runningScans = scans?.filter((scan) => scan.running) ?? []
  const counts = {
    sources: sources.length,
    onlineSources,
    degradedSources,
    offlineSources,
    files: totalFiles,
  }

  let sourceStage: ProductReadinessStage
  if (sources.length === 0) {
    sourceStage = createStage('sources', 'action-required', 0, 'no-source', counts, 'add-source')
  } else if (onlineSources > 0) {
    sourceStage = createStage(
      'sources',
      degradedSources + offlineSources > 0 ? 'degraded' : 'ready',
      ratioProgress(onlineSources, sources.length),
      degradedSources + offlineSources > 0 ? 'source-degraded' : 'source-ready',
      counts,
      degradedSources + offlineSources > 0 ? 'reconnect-source' : undefined,
    )
  } else {
    sourceStage = createStage(
      'sources',
      'degraded',
      0,
      'source-offline',
      counts,
      'reconnect-source',
    )
  }

  if (totalFiles > 0) {
    return [sourceStage, createStage('catalog', 'ready', 100, 'catalog-ready', counts)]
  }

  if (unavailableStages.has('catalog')) {
    return [sourceStage, createStage('catalog', 'unavailable', 0, 'status-unavailable', counts)]
  }

  if (runningScans.length > 0) {
    const discovered = runningScans.reduce(
      (sum, scan) => sum + Math.max(0, scan.session?.discoveredCount ?? 0),
      0,
    )
    const committed = runningScans.reduce(
      (sum, scan) => sum + Math.max(0, scan.session?.committedCount ?? 0),
      0,
    )
    return [
      sourceStage,
      createStage('catalog', 'working', ratioProgress(committed, discovered, 5), 'scan-running', {
        ...counts,
        runningScans: runningScans.length,
        discovered,
        committed,
      }),
    ]
  }

  return [
    sourceStage,
    createStage(
      'catalog',
      'action-required',
      0,
      'catalog-empty',
      counts,
      sources.length > 0 ? 'scan-sources' : 'add-source',
    ),
  ]
}

function modelProgress(status: ModelStatus | null | undefined): number {
  if (!status) return 0
  if (MODEL_READY_STATES.has(status.state)) return 100
  if (status.state === 'downloading') return clampProgress(status.progress ?? 1)
  if (status.state === 'loading') return 95
  if (status.state === 'unloading') return 25
  return 0
}

function buildImageStage(
  input: ProductReadinessInput,
  catalogFiles: number,
  unavailableStages: ReadonlySet<ProductReadinessStageId>,
): ProductReadinessStage {
  const dino = input.modelStatuses?.dinov2_vitb14
  const clip = input.modelStatuses?.clip_vit_base_patch32
  const statuses = [dino, clip]
  const image = input.imageSearch
  const embedding = [
    input.embeddingProgress?.dinov2_vitb14,
    input.embeddingProgress?.clip_vit_base_patch32,
  ]
  const indexed = Math.max(0, image?.indexedCount ?? 0)
  const pending = Math.max(
    0,
    image?.pendingCount ??
      embedding.reduce((sum, progress) => sum + Math.max(0, progress?.pending ?? 0), 0),
  )
  const counts = { indexed, pending, requiredModels: 2 }

  if (unavailableStages.has('image-semantic')) {
    return createStage('image-semantic', 'unavailable', 0, 'status-unavailable', counts)
  }
  if (!input.modelStatuses || !image) {
    return createStage('image-semantic', 'working', 0, 'status-loading', counts)
  }
  if (statuses.some((status) => status?.state === 'error') || image.state === 'error') {
    return createStage(
      'image-semantic',
      'degraded',
      ratioProgress(indexed, indexed + pending),
      statuses.some((status) => status?.state === 'error') ? 'model-error' : 'image-index-error',
      counts,
      statuses.some((status) => status?.state === 'error')
        ? 'prepare-image-search'
        : 'retry-image-index',
    )
  }
  if (statuses.some((status) => MODEL_WORKING_STATES.has(status?.state ?? 'not-installed'))) {
    return createStage(
      'image-semantic',
      'working',
      statuses.reduce((sum, status) => sum + modelProgress(status), 0) / statuses.length,
      'model-preparing',
      counts,
    )
  }
  if (!statuses.every((status) => status && MODEL_READY_STATES.has(status.state))) {
    return createStage(
      'image-semantic',
      'action-required',
      statuses.reduce((sum, status) => sum + modelProgress(status), 0) / statuses.length,
      'model-missing',
      counts,
      'prepare-image-search',
    )
  }
  if (
    image.state === 'scanning' ||
    image.state === 'indexing' ||
    embedding.some(isEmbeddingActive)
  ) {
    return createStage(
      'image-semantic',
      'working',
      ratioProgress(indexed, indexed + pending, indexed > 0 ? 95 : 5),
      'image-index-running',
      counts,
    )
  }
  if (indexed > 0 || catalogFiles === 0) {
    return createStage('image-semantic', 'ready', 100, 'image-index-ready', counts)
  }
  return createStage(
    'image-semantic',
    'action-required',
    50,
    'image-index-empty',
    counts,
    'prepare-image-search',
  )
}

function isEmbeddingActive(progress: EmbeddingProgress | null | undefined): boolean {
  return Boolean(progress && ['queued', 'running', 'paused', 'stopping'].includes(progress.state))
}

function buildVideoVisualStage(
  status: MediaSearchStatus | null | undefined,
  unavailableStages: ReadonlySet<ProductReadinessStageId>,
): ProductReadinessStage {
  if (unavailableStages.has('video-visual')) {
    return createStage('video-visual', 'unavailable', 0, 'status-unavailable')
  }
  if (!status) return createStage('video-visual', 'working', 0, 'status-loading')
  const counts = {
    videos: Math.max(0, status.videoCount),
    frames: Math.max(0, status.indexedFrameCount),
  }
  if (!status.ffmpegConfigured || !status.ffprobeConfigured) {
    return createStage(
      'video-visual',
      'action-required',
      0,
      'video-tools-missing',
      counts,
      'configure-video-tools',
    )
  }
  if (status.state === 'error') {
    return createStage(
      'video-visual',
      'degraded',
      status.indexedFrameCount > 0 ? 60 : 25,
      'video-scan-error',
      counts,
      'scan-videos',
    )
  }
  if (['queued', 'running', 'paused', 'stopped'].includes(status.state)) {
    return createStage(
      'video-visual',
      'working',
      status.indexedFrameCount > 0 ? 80 : 20,
      'video-scan-running',
      counts,
    )
  }
  if (status.videoCount === 0) {
    return createStage('video-visual', 'ready', 100, 'no-video', counts)
  }
  if (status.indexedFrameCount === 0) {
    return createStage(
      'video-visual',
      'action-required',
      35,
      'video-frames-missing',
      counts,
      'build-video-frames',
    )
  }
  return createStage('video-visual', 'ready', 100, 'video-frames-ready', counts)
}

function buildVideoSemanticStage(
  status: VideoSemanticUiStatus | null | undefined,
  videoCount: number,
  unavailableStages: ReadonlySet<ProductReadinessStageId>,
): ProductReadinessStage {
  if (unavailableStages.has('video-semantic')) {
    return createStage('video-semantic', 'unavailable', 0, 'status-unavailable')
  }
  if (!status) return createStage('video-semantic', 'working', 0, 'status-loading')
  const runningJobs = status.jobs.filter((job) =>
    ['queued', 'running', 'paused'].includes(job.state),
  )
  const completedSegments = runningJobs.reduce((sum, job) => sum + job.completedSegments, 0)
  const totalSegments = runningJobs.reduce((sum, job) => sum + job.totalSegments, 0)
  const counts = {
    indexedVideos: Math.max(0, status.activeVideos),
    indexedSegments: Math.max(0, status.activeSegments),
    videos: Math.max(0, videoCount),
    runningJobs: runningJobs.length,
  }
  if (status.runtime.state === 'error' || status.runtime.state === 'unavailable') {
    return createStage(
      'video-semantic',
      'degraded',
      status.activeVideos > 0 ? 60 : 0,
      'runtime-error',
      counts,
      'retry-video-semantic',
    )
  }
  if (status.runtime.state === 'not-installed') {
    return createStage(
      'video-semantic',
      'action-required',
      0,
      'runtime-missing',
      counts,
      'install-video-model',
    )
  }
  if (status.runtime.state === 'busy' || runningJobs.length > 0) {
    return createStage(
      'video-semantic',
      'working',
      ratioProgress(completedSegments, totalSegments, status.activeSegments > 0 ? 50 : 5),
      'runtime-busy',
      counts,
    )
  }
  if (status.indexState === 'index-stale') {
    return createStage(
      'video-semantic',
      'action-required',
      status.activeVideos > 0 ? 75 : 20,
      'index-stale',
      counts,
      status.canResume ? 'resume-video-semantic' : 'retry-video-semantic',
    )
  }
  if (videoCount > status.activeVideos) {
    return createStage(
      'video-semantic',
      'action-required',
      ratioProgress(status.activeVideos, videoCount),
      'index-incomplete',
      counts,
      status.canResume ? 'resume-video-semantic' : 'retry-video-semantic',
    )
  }
  return createStage('video-semantic', 'ready', 100, 'index-ready', counts)
}

function buildAudioSemanticStage(
  status: AudioSemanticUiStatus | null | undefined,
  unavailableStages: ReadonlySet<ProductReadinessStageId>,
): ProductReadinessStage {
  if (unavailableStages.has('audio-semantic')) {
    return createStage('audio-semantic', 'unavailable', 0, 'status-unavailable')
  }
  if (!status) return createStage('audio-semantic', 'working', 0, 'status-loading')
  const counts = {
    indexedVideos: Math.max(0, status.indexedVideos),
    indexedSegments: Math.max(0, status.indexedSegments),
    eligibleVideos: Math.max(0, status.eligibleVideos),
  }
  const warnings: ProductReadinessReason[] =
    status.diarization.state === 'ready' ? [] : ['runtime-missing']

  if (status.runtime.state === 'error' || status.runtime.state === 'unavailable') {
    return createStage(
      'audio-semantic',
      'degraded',
      status.indexedVideos > 0 ? 60 : 0,
      'runtime-error',
      counts,
      'retry-audio-semantic',
      warnings,
    )
  }
  if (status.runtime.state === 'not-installed' || status.modelDownloadRequired) {
    return createStage(
      'audio-semantic',
      'action-required',
      0,
      'runtime-missing',
      counts,
      'install-audio-model',
      warnings,
    )
  }
  if (
    status.runtime.state === 'busy' ||
    ['queued', 'running', 'stopped'].includes(status.job?.state ?? '')
  ) {
    return createStage(
      'audio-semantic',
      'working',
      ratioProgress(
        status.job?.completedSegments ?? 0,
        status.job?.totalSegments ?? 0,
        status.indexedSegments > 0 ? 50 : 5,
      ),
      'runtime-busy',
      counts,
      status.job?.state === 'stopped' && status.canResume ? 'resume-audio-semantic' : undefined,
      warnings,
    )
  }
  if (status.indexState === 'index-stale') {
    return createStage(
      'audio-semantic',
      'action-required',
      status.indexedVideos > 0 ? 75 : 20,
      'index-stale',
      counts,
      status.canResume ? 'resume-audio-semantic' : 'retry-audio-semantic',
      warnings,
    )
  }
  if (status.eligibleVideos > status.indexedVideos) {
    return createStage(
      'audio-semantic',
      'action-required',
      ratioProgress(status.indexedVideos, status.eligibleVideos),
      'index-incomplete',
      counts,
      status.canResume ? 'resume-audio-semantic' : 'retry-audio-semantic',
      warnings,
    )
  }
  return createStage('audio-semantic', 'ready', 100, 'index-ready', counts, undefined, warnings)
}

function normalizeTaskState(state: string): ProductTaskState {
  if (state === 'done' || state === 'completed' || state === 'idle') return 'completed'
  if (state === 'error' || state === 'failed') return 'failed'
  if (state === 'cancelled' || state === 'stopped') return 'stopped'
  if (state === 'paused') return 'paused'
  if (state === 'stopping') return 'stopping'
  if (state === 'queued') return 'queued'
  return 'running'
}

function taskProgress(completed: number, failed: number, total: number): number {
  return ratioProgress(Math.max(0, completed) + Math.max(0, failed), Math.max(0, total))
}

export function buildProductTaskInventory(
  input: ProductReadinessInput,
): ProductTaskInventoryItem[] {
  const tasks: ProductTaskInventoryItem[] = []

  for (const scan of input.scans ?? []) {
    const session = scan.session
    if (!session) continue
    const total = Math.max(session.discoveredCount, session.committedCount)
    tasks.push({
      id: `source-scan:${session.id}`,
      authorityId: session.sourceId,
      kind: 'source-scan',
      state: normalizeTaskState(session.state),
      progress: taskProgress(session.committedCount, 0, total),
      completed: Math.max(0, session.committedCount),
      total: Math.max(0, total),
      failed: session.state === 'error' ? 1 : 0,
      phase: session.backend,
      ...(session.error ? { error: session.error } : {}),
      startedAt: session.startedAt,
      updatedAt: session.finishedAt ?? session.startedAt,
      persisted: true,
      canStop: scan.running,
      canPause: false,
      canResume: false,
      canRetry: ['error', 'cancelled'].includes(session.state),
    })
  }

  const image = input.imageSearch
  if (image && (image.state !== 'idle' || image.indexedCount > 0 || image.pendingCount > 0)) {
    const total = Math.max(0, image.indexedCount + image.pendingCount)
    tasks.push({
      id: 'image-index:current',
      kind: 'image-index',
      state: normalizeTaskState(image.state),
      progress: taskProgress(image.indexedCount, 0, total),
      completed: Math.max(0, image.indexedCount),
      total,
      failed: Math.max(0, image.warningCount ?? 0),
      phase: image.thumbnailPhase || image.state,
      ...(image.currentPath ? { currentItem: image.currentPath } : {}),
      ...(image.lastError ? { error: image.lastError } : {}),
      ...(image.lastSaveTime ? { updatedAt: image.lastSaveTime } : {}),
      persisted: true,
      canStop: ['queued', 'scanning', 'indexing', 'paused'].includes(image.state),
      canPause: ['queued', 'scanning', 'indexing'].includes(image.state),
      canResume: image.state === 'paused',
      canRetry: image.state === 'error',
    })
  }

  const thumbnail = input.thumbnailProgress
  if (thumbnail && (thumbnail.state !== 'idle' || thumbnail.total > 0)) {
    tasks.push({
      id: 'thumbnail-index:current',
      kind: 'thumbnail-index',
      state: normalizeTaskState(thumbnail.state),
      progress: taskProgress(
        thumbnail.completed + thumbnail.skipped,
        thumbnail.failed,
        thumbnail.total,
      ),
      completed: Math.max(0, thumbnail.completed + thumbnail.skipped),
      total: Math.max(0, thumbnail.total),
      failed: Math.max(0, thumbnail.failed),
      phase: thumbnail.effectiveBackend || thumbnail.requestedBackend,
      ...(thumbnail.currentPath ? { currentItem: thumbnail.currentPath } : {}),
      ...(thumbnail.error || thumbnail.gpuError
        ? { error: thumbnail.error || thumbnail.gpuError }
        : {}),
      ...(thumbnail.startedAt ? { startedAt: thumbnail.startedAt } : {}),
      ...(thumbnail.finishedAt ? { updatedAt: thumbnail.finishedAt } : {}),
      persisted: false,
      canStop: ['running', 'stopping'].includes(thumbnail.state),
      canPause: false,
      canResume: false,
      canRetry: thumbnail.state === 'error',
    })
  }

  const embedding =
    input.embeddingProgress?.clip_vit_base_patch32 ?? input.embeddingProgress?.dinov2_vitb14
  if (embedding && (embedding.state !== 'idle' || embedding.total > 0)) {
    tasks.push({
      id: 'image-embedding:current',
      authorityId:
        input.embeddingProgress?.clip_vit_base_patch32 === embedding
          ? 'clip_vit_base_patch32'
          : 'dinov2_vitb14',
      kind: 'image-embedding',
      state: normalizeTaskState(embedding.state),
      progress: taskProgress(
        embedding.completed + embedding.skipped,
        embedding.failed,
        embedding.total,
      ),
      completed: Math.max(0, embedding.completed + embedding.skipped),
      total: Math.max(0, embedding.total),
      failed: Math.max(0, embedding.failed),
      phase: embedding.batchMode,
      ...(embedding.itemsPerSecond === undefined
        ? {}
        : { itemsPerSecond: embedding.itemsPerSecond }),
      ...(embedding.etaMs === undefined ? {} : { etaMs: embedding.etaMs }),
      ...(embedding.currentPath ? { currentItem: embedding.currentPath } : {}),
      ...(embedding.error ? { error: embedding.error } : {}),
      ...(embedding.startedAt ? { startedAt: embedding.startedAt } : {}),
      persisted: true,
      canStop: ['queued', 'running', 'paused', 'stopping'].includes(embedding.state),
      canPause: ['queued', 'running'].includes(embedding.state),
      canResume: embedding.state === 'paused',
      canRetry: embedding.state === 'error',
    })
  }

  const media = input.mediaTaskProgress
  if (media) {
    tasks.push({
      id: `video-index:${media.taskId}`,
      authorityId: media.taskId,
      kind: 'video-index',
      state: normalizeTaskState(media.state),
      progress: clampProgress(media.percentage),
      completed: Math.max(0, media.completed),
      total: Math.max(0, media.total),
      failed: Math.max(0, media.failed),
      phase: media.type,
      ...(media.itemsPerSecond === undefined ? {} : { itemsPerSecond: media.itemsPerSecond }),
      ...(media.etaMs === undefined ? {} : { etaMs: media.etaMs }),
      ...(media.currentPath ? { currentItem: media.currentPath } : {}),
      ...(media.error ? { error: media.error } : {}),
      startedAt: media.startedAt,
      updatedAt: media.updatedAt,
      persisted: true,
      canStop: ['queued', 'running', 'paused'].includes(media.state),
      canPause: false,
      canResume: false,
      canRetry: media.state === 'error' || media.state === 'stopped',
    })
  }

  for (const job of input.videoSemantic?.jobs ?? []) {
    tasks.push({
      id: `video-semantic:${job.jobId}`,
      authorityId: job.jobId,
      kind: 'video-semantic',
      state: normalizeTaskState(job.state),
      progress: taskProgress(job.completedSegments, job.failedSegments, job.totalSegments),
      completed: Math.max(0, job.completedSegments),
      total: Math.max(0, job.totalSegments),
      failed: Math.max(0, job.failedSegments),
      phase: job.profileId,
      ...(job.currentSegmentId ? { currentItem: job.currentSegmentId } : {}),
      ...(job.lastError ? { error: job.lastError } : {}),
      updatedAt: job.updatedAt,
      persisted: true,
      canStop: ['queued', 'running', 'paused'].includes(job.state),
      canPause: false,
      canResume: ['paused', 'stopped', 'error'].includes(job.state),
      canRetry: job.state === 'error',
    })
  }

  const audio = input.audioSemantic?.job
  if (audio) {
    tasks.push({
      id: `audio-semantic:${audio.jobId}`,
      authorityId: audio.jobId,
      kind: 'audio-semantic',
      state: normalizeTaskState(audio.state),
      progress: taskProgress(audio.completedSegments, audio.failedSegments, audio.totalSegments),
      completed: Math.max(0, audio.completedSegments),
      total: Math.max(0, audio.totalSegments),
      failed: Math.max(0, audio.failedSegments),
      phase: 'sensevoice',
      ...(audio.currentVideoId ? { currentItem: audio.currentVideoId } : {}),
      ...(audio.lastError ? { error: audio.lastError } : {}),
      startedAt: audio.createdAt,
      updatedAt: audio.updatedAt,
      persisted: true,
      canStop: ['queued', 'running'].includes(audio.state),
      canPause: false,
      canResume: ['stopped', 'failed'].includes(audio.state),
      canRetry: audio.state === 'failed',
    })
  }

  const stateOrder: Record<ProductTaskState, number> = {
    running: 0,
    queued: 1,
    paused: 2,
    stopping: 3,
    failed: 4,
    stopped: 5,
    completed: 6,
  }
  return tasks.sort(
    (left, right) =>
      stateOrder[left.state] - stateOrder[right.state] ||
      (right.updatedAt ?? 0) - (left.updatedAt ?? 0) ||
      left.id.localeCompare(right.id, 'en'),
  )
}

export function buildProductReadiness(input: ProductReadinessInput): ProductReadinessSnapshot {
  const unavailableStages = new Set(input.unavailableStages ?? [])
  const [sourceStage, catalogStage] = buildSourceStages(
    input.sources,
    input.scans,
    unavailableStages,
  )
  const catalogFiles = catalogStage.counts.files ?? 0
  const imageStage = buildImageStage(input, catalogFiles, unavailableStages)
  const videoVisualStage = buildVideoVisualStage(input.mediaSearch, unavailableStages)
  const videoSemanticStage = buildVideoSemanticStage(
    input.videoSemantic,
    Math.max(0, input.mediaSearch?.videoCount ?? 0),
    unavailableStages,
  )
  const audioSemanticStage = buildAudioSemanticStage(input.audioSemantic, unavailableStages)
  const stages = [
    sourceStage,
    catalogStage,
    imageStage,
    videoVisualStage,
    videoSemanticStage,
    audioSemanticStage,
  ]
  const capabilities: ProductSearchCapabilities = {
    metadata: catalogFiles > 0,
    imageSimilarity:
      imageStage.state !== 'degraded' &&
      MODEL_READY_STATES.has(input.modelStatuses?.dinov2_vitb14?.state ?? 'not-installed') &&
      (input.imageSearch?.indexedCount ?? 0) > 0,
    naturalLanguageImage:
      imageStage.state !== 'degraded' &&
      MODEL_READY_STATES.has(
        input.modelStatuses?.clip_vit_base_patch32?.state ?? 'not-installed',
      ) &&
      (input.imageSearch?.indexedCount ?? 0) > 0,
    videoFrame: (input.mediaSearch?.indexedFrameCount ?? 0) > 0,
    videoSemantic: (input.videoSemantic?.activeSegments ?? 0) > 0,
    dialogue: (input.audioSemantic?.indexedSegments ?? 0) > 0,
  }
  const models: ProductModelLifecycleItem[] = [
    {
      id: 'dinov2_vitb14',
      management: 'managed-download',
      state: unavailableStages.has('image-semantic')
        ? 'unavailable'
        : (input.modelStatuses?.dinov2_vitb14?.state ?? 'loading'),
      ...(input.modelStatuses?.dinov2_vitb14?.progress === undefined
        ? {}
        : { progress: clampProgress(input.modelStatuses.dinov2_vitb14.progress) }),
    },
    {
      id: 'clip_vit_base_patch32',
      management: 'managed-download',
      state: unavailableStages.has('image-semantic')
        ? 'unavailable'
        : (input.modelStatuses?.clip_vit_base_patch32?.state ?? 'loading'),
      ...(input.modelStatuses?.clip_vit_base_patch32?.progress === undefined
        ? {}
        : { progress: clampProgress(input.modelStatuses.clip_vit_base_patch32.progress) }),
    },
    {
      id: 'qwen3-vl',
      management: 'external-runtime',
      state: unavailableStages.has('video-semantic')
        ? 'unavailable'
        : (input.videoSemantic?.runtime.state ?? 'loading'),
    },
    {
      id: 'sensevoice',
      management: 'external-runtime',
      state: unavailableStages.has('audio-semantic')
        ? 'unavailable'
        : (input.audioSemantic?.runtime.state ?? 'loading'),
    },
  ]
  const tasks = buildProductTaskInventory(input)
  const imageBytes = Math.max(0, input.imageDataOverview?.totalBytes ?? 0)
  const mediaBytes = Math.max(0, input.mediaCacheStats?.totalBytes ?? 0)
  const taskStorage: ProductTaskStorage = {
    ...(input.imageDataOverview?.ok ? { imageBytes } : {}),
    ...(input.mediaCacheStats ? { mediaBytes } : {}),
    ...(input.imageDataOverview?.ok || input.mediaCacheStats
      ? { totalBytes: imageBytes + mediaBytes }
      : {}),
  }
  const searchable = Object.values(capabilities).some(Boolean)
  const hasWorking = stages.some((stage) => stage.state === 'working')
  const hasFailure = stages.some(
    (stage) => stage.state === 'degraded' || stage.state === 'unavailable',
  )
  const allReady = stages.every((stage) => stage.state === 'ready')

  let state: ProductReadinessState
  if (allReady) state = 'ready'
  else if (searchable && hasFailure) state = 'degraded'
  else if (searchable) state = 'searchable'
  else if (hasWorking) state = 'preparing'
  else state = 'not-started'

  const weightedProgress = stages.reduce(
    (sum, stage) => sum + stage.progress * STAGE_WEIGHTS[stage.id],
    0,
  )
  const nextAction = ACTION_PRIORITY.map(
    (id) => stages.find((stage) => stage.id === id)?.action,
  ).find((action): action is ProductReadinessAction => Boolean(action))

  return {
    state,
    progress: clampProgress(weightedProgress / 100),
    searchable,
    stages,
    capabilities,
    models,
    tasks,
    taskStorage,
    ...(nextAction ? { nextAction } : {}),
  }
}

export type ProductReadinessApi = Pick<
  ElectronAPI,
  'discoveryCatalog' | 'imageSearch' | 'vector' | 'mediaSearch'
>

export interface LoadProductReadinessOptions {
  /**
   * Storage inventory walks potentially hundreds of thousands of derived files.
   * It must only run after an explicit user request, never during startup or polling.
   */
  includeStorage?: boolean
}

export interface ProductTaskControlResult {
  ok: boolean
  error?: string
  route?: ProductReadinessAction
}

function controlResult(result: unknown): ProductTaskControlResult {
  if (!result || typeof result !== 'object') return { ok: true }
  const value = result as { ok?: boolean; error?: string }
  return value.ok === false
    ? { ok: false, error: value.error || 'task-control-failed' }
    : { ok: true }
}

export async function runProductTaskControl(
  api: ProductReadinessApi,
  task: ProductTaskInventoryItem,
  action: ProductTaskControlAction,
): Promise<ProductTaskControlResult> {
  const authorityId = task.authorityId

  if (action === 'pause') {
    if (task.kind === 'image-index') return controlResult(await api.imageSearch.pauseScan())
    if (task.kind === 'image-embedding')
      return controlResult(await api.vector.pauseEmbeddingBuild())
  }

  if (action === 'resume') {
    if (task.kind === 'image-index') return controlResult(await api.imageSearch.resumeScan())
    if (task.kind === 'image-embedding')
      return controlResult(await api.vector.resumeEmbeddingBuild())
    if (task.kind === 'video-semantic' && authorityId)
      return controlResult(await api.mediaSearch.resumeVideoSemanticJob(authorityId))
    if (task.kind === 'audio-semantic' && authorityId)
      return controlResult(await api.mediaSearch.resumeAudioSemanticBuild(authorityId))
  }

  if (action === 'stop') {
    if (task.kind === 'source-scan' && authorityId)
      return controlResult(await api.discoveryCatalog.cancelScan(authorityId))
    if (task.kind === 'image-index') return controlResult(await api.imageSearch.stopScan())
    if (task.kind === 'thumbnail-index')
      return controlResult(await api.imageSearch.stopThumbnailRebuild())
    if (task.kind === 'image-embedding') return controlResult(await api.vector.stopEmbeddingBuild())
    if (task.kind === 'video-index')
      return controlResult(await api.mediaSearch.stopTask(authorityId))
    if (task.kind === 'video-semantic' && authorityId)
      return controlResult(await api.mediaSearch.stopVideoSemanticJob(authorityId))
    if (task.kind === 'audio-semantic' && authorityId)
      return controlResult(await api.mediaSearch.stopAudioSemanticBuild(authorityId))
  }

  if (action === 'retry') {
    if (task.kind === 'source-scan' && authorityId)
      return controlResult(await api.discoveryCatalog.startScan(authorityId))
    if (task.kind === 'image-index') return { ok: true, route: 'retry-image-index' }
    if (task.kind === 'thumbnail-index') return { ok: true, route: 'prepare-image-search' }
    if (task.kind === 'image-embedding' && authorityId) {
      return controlResult(
        await api.vector.startEmbeddingBuild({
          modelName: authorityId,
          embeddingType: 'global',
          backend: 'auto',
        }),
      )
    }
    if (task.kind === 'video-index') return { ok: true, route: 'build-video-frames' }
    if (task.kind === 'video-semantic' && authorityId)
      return controlResult(await api.mediaSearch.resumeVideoSemanticJob(authorityId))
    if (task.kind === 'audio-semantic' && authorityId)
      return controlResult(await api.mediaSearch.resumeAudioSemanticBuild(authorityId))
  }

  return { ok: false, error: 'unsupported-task-control' }
}

async function readStatus<T>(
  operation: () => Promise<T>,
  unavailableStages: Set<ProductReadinessStageId>,
  affectedStages: readonly ProductReadinessStageId[],
): Promise<T | null> {
  try {
    return await operation()
  } catch {
    for (const stage of affectedStages) unavailableStages.add(stage)
    return null
  }
}

export async function loadProductReadiness(
  api: ProductReadinessApi,
  options: LoadProductReadinessOptions = {},
): Promise<ProductReadinessSnapshot> {
  const unavailableStages = new Set<ProductReadinessStageId>()
  const [
    sources,
    scans,
    imageSearch,
    dino,
    clip,
    embedding,
    thumbnailProgress,
    imageDataOverview,
    mediaSearch,
    mediaTaskProgress,
    mediaCacheStats,
    videoSemantic,
    audioSemantic,
  ] = await Promise.all([
    readStatus(() => api.discoveryCatalog.listSources(), unavailableStages, ['sources', 'catalog']),
    readStatus(() => api.discoveryCatalog.getScanStatus(), unavailableStages, ['catalog']),
    readStatus(() => api.imageSearch.getStatus(), unavailableStages, ['image-semantic']),
    readStatus(() => api.vector.getModelStatus('dinov2_vitb14'), unavailableStages, [
      'image-semantic',
    ]),
    readStatus(() => api.vector.getModelStatus('clip_vit_base_patch32'), unavailableStages, [
      'image-semantic',
    ]),
    readStatus(() => api.vector.getEmbeddingProgress(), unavailableStages, ['image-semantic']),
    readStatus(() => api.imageSearch.getThumbnailRebuildProgress(), unavailableStages, []),
    options.includeStorage
      ? readStatus(() => api.imageSearch.getDataOverview(), unavailableStages, [])
      : Promise.resolve(null),
    readStatus(() => api.mediaSearch.getStatus({ includeCounts: true }), unavailableStages, [
      'video-visual',
    ]),
    readStatus(() => api.mediaSearch.getTaskProgress(), unavailableStages, []),
    options.includeStorage
      ? readStatus(() => api.mediaSearch.getCacheStats(), unavailableStages, [])
      : Promise.resolve(null),
    readStatus(() => api.mediaSearch.getVideoSemanticStatus(), unavailableStages, [
      'video-semantic',
    ]),
    readStatus(() => api.mediaSearch.getAudioSemanticStatus(), unavailableStages, [
      'audio-semantic',
    ]),
  ])

  return buildProductReadiness({
    sources,
    scans,
    imageSearch,
    modelStatuses: { dinov2_vitb14: dino, clip_vit_base_patch32: clip },
    embeddingProgress: {
      dinov2_vitb14: embedding,
      clip_vit_base_patch32: embedding,
    },
    thumbnailProgress,
    imageDataOverview,
    mediaSearch,
    mediaTaskProgress,
    mediaCacheStats,
    videoSemantic,
    audioSemantic,
    unavailableStages: [...unavailableStages],
  })
}
