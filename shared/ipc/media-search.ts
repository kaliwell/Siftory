export type MediaSearchTaskState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'paused'
  | 'done'
  | 'stopped'
  | 'error'

export type MediaSearchTaskType =
  | 'scan-video-files'
  | 'read-video-metadata'
  | 'extract-video-frames'
  | 'prepare-media-library'
  | 'build-visual-vector'
  | 'extract-subtitles'
  | 'cleanup-cache'

export interface MediaSearchStatus {
  state: MediaSearchTaskState
  videoCount: number
  indexedFrameCount: number
  activeTaskId?: string
  activeTaskType?: MediaSearchTaskType
  message?: string
  lastError?: string
  ffmpegConfigured: boolean
  ffprobeConfigured: boolean
  ffmpegVersion?: string
  ffprobeVersion?: string
  ffmpegCommand?: string
  ffprobeCommand?: string
  cacheDir?: string
  updatedAt: number
}

export interface MediaSearchStatusRequest {
  includeCounts?: boolean
}

export interface MediaSearchCacheStats {
  cacheDir: string
  totalBytes: number
  manifestBytes: number
  thumbnailBytes: number
  frameBytes: number
  vectorBytes: number
  tempBytes: number
}

export interface MediaSearchClearCacheResult {
  ok: boolean
  deletedEntries: number
  freedBytes: number
  stats?: MediaSearchCacheStats
  removedEmbeddings?: number
  error?: string
}

export interface MediaSearchFrameEmbeddingRequest {
  modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32'
  backend?: 'auto' | 'cpu' | 'gpu'
  maxConcurrentEmbeddings?: number
  scanPaths?: string[]
}

export interface MediaSearchFrameEmbeddingStats {
  readyFrames: number
  dinoEmbeddedFrames: number
  clipEmbeddedFrames: number
  missingDinoFrames: number
  missingClipFrames: number
  coverageByDrive?: {
    drive: string
    videos: number
    readyFrames: number
    dinoEmbeddedFrames: number
    clipEmbeddedFrames: number
  }[]
}

export interface MediaSearchFrameSearchRequest {
  requestId?: string
  frameId: string
  modelName?: 'dinov2_vitb14' | 'clip_vit_base_patch32'
  topK?: number
}

export interface MediaSearchSearchTimings {
  manifestMs: number
  indexMs: number
  embeddingMs: number
  scoringMs: number
  totalMs: number
}

export interface MediaSearchFrameSearchResponse {
  ok: boolean
  queryFrameId?: string
  modelName?: 'dinov2_vitb14' | 'clip_vit_base_patch32'
  results: MediaSearchVideoFrameRecord[]
  totalCandidates: number
  timings?: MediaSearchSearchTimings
  error?: string
}

export interface MediaSearchFrameImageSearchRequest {
  requestId?: string
  imagePath: string
  modelName?: 'dinov2_vitb14' | 'clip_vit_base_patch32'
  backend?: 'cpu' | 'gpu'
  topK?: number
  scanPaths?: string[]
}

export interface MediaSearchFrameImageSearchResponse {
  ok: boolean
  queryImagePath?: string
  modelName?: 'dinov2_vitb14' | 'clip_vit_base_patch32'
  results: MediaSearchVideoFrameRecord[]
  totalCandidates: number
  timings?: MediaSearchSearchTimings
  error?: string
}

export interface MediaSearchFrameTextSearchRequest {
  requestId?: string
  textQuery: string
  topK?: number
  scanPaths?: string[]
}

export interface MediaSearchFrameTextSearchResponse {
  ok: boolean
  query?: string
  modelName?: 'clip_vit_base_patch32'
  results: MediaSearchVideoFrameRecord[]
  totalCandidates: number
  timings?: MediaSearchSearchTimings
  error?: string
}

export interface MediaSearchToolConfigResult {
  ok: boolean
  ffmpegDir?: string
  toolsDir?: string
  error?: string
}

export interface MediaSearchTaskProgress {
  taskId: string
  type: MediaSearchTaskType
  state: MediaSearchTaskState
  total: number
  completed: number
  failed: number
  percentage: number
  currentPath?: string
  message?: string
  error?: string
  startedAt: number
  updatedAt: number
  elapsedMs?: number
  itemsPerSecond?: number
  etaMs?: number
  scanFoundVideos?: number
  scanScannedEntries?: number
  scanCapped?: boolean
  preparationPhase?: MediaSearchPreparationPhase
  committedFrames?: number
  frameExtractionComplete?: boolean
  dinoEmbeddingComplete?: boolean
  clipEmbeddingComplete?: boolean
  frameIndexComplete?: boolean
}

export type MediaSearchPreparationPhase =
  | 'extracting'
  | 'waiting-dino-model'
  | 'embedding-dino'
  | 'waiting-clip-model'
  | 'embedding-clip'
  | 'finalizing-dino'
  | 'finalizing-clip'
  | 'indexing'
  | 'done'

export interface MediaSearchStartScanArgs {
  paths: string[]
  mode?: 'metadata' | 'thumbnails'
}

export interface MediaSearchBuildFramesArgs {
  paths?: string[]
}

export interface MediaSearchPrepareLibraryArgs {
  paths?: string[]
  backend?: 'auto' | 'cpu' | 'gpu'
  maxConcurrentEmbeddings?: number
  /** 0 keeps the existing adaptive embedding-batch policy. */
  batchSize?: number
}

export interface MediaSearchVideoPathSelection {
  paths: string[]
}

export type MediaSearchVideoPathSelectionMode = 'single-video' | 'videos' | 'folders'

export interface MediaSearchVideoListResponse {
  videos: MediaSearchVideoRecord[]
  total: number
}

export interface MediaSearchFrameListResponse {
  frames: MediaSearchVideoFrameRecord[]
  total: number
}

export interface MediaSearchImageDataResponse {
  ok: boolean
  dataUrl?: string
  error?: string
}

export interface MediaSearchFramePreviewRequest {
  frameId: string
}

export interface MediaSearchVideoFrameRecord {
  frameId: string
  videoId: string
  videoPath: string
  timestampMs: number
  imagePath?: string
  imageDataUrl?: string
  vectorScore?: number
  width?: number
  /** Fingerprint of the authoritative video revision used to derive this frame. */
  sourceFingerprint?: string
  status: 'pending' | 'done' | 'unavailable' | 'error'
  error?: string
  createdAt: number
  updatedAt: number
}

export interface MediaSearchVideoRecord {
  videoId: string
  path: string
  name: string
  ext: string
  sizeBytes: number
  mtimeMs: number
  durationMs?: number
  width?: number
  height?: number
  videoCodec?: string
  audioCodec?: string
  containerFormat?: string
  metadataStatus?: 'pending' | 'done' | 'unavailable' | 'error'
  metadataError?: string
  thumbnailPath?: string
  thumbnailStatus?: 'pending' | 'done' | 'unavailable' | 'error'
  thumbnailError?: string
  thumbnailDataUrl?: string
  discoveredAt: number
  updatedAt: number
  missing?: boolean
  /** Unified source policy captured at scan projection time. */
  sourceId?: string
  sourceType?: 'local' | 'mounted-network' | 'sftp'
}

export interface MediaSearchSubtitleStream {
  index: number
  codec: string
  language?: string
  title?: string
}

export interface MediaSearchSubtitleExtractResult {
  ok: boolean
  videoId?: string
  streamCount?: number
  segmentCount?: number
  language?: string
  error?: string
}

export interface MediaSearchTranscriptSearchRequest {
  query: string
  topK?: number
}

export interface MediaSearchTranscriptSearchResult {
  videoId: string
  videoPath: string
  timestampMs: number
  text: string
  score: number
  matchStartMs: number
  matchEndMs: number
  source: 'embedded-subtitle' | 'sensevoice-asr'
  language?: string
  emotion?: string
  audioEvents?: string[]
  speakerId?: string
  modelId?: string
  modelRevision?: string
}

export interface MediaSearchTranscriptSearchResponse {
  ok: boolean
  results: MediaSearchTranscriptSearchResult[]
  totalVideos: number
  error?: string
}

export interface MediaSearchMultimodalSearchRequest {
  imagePath?: string
  frameId?: string
  textQuery: string
  modelName?: 'dinov2_vitb14' | 'clip_vit_base_patch32'
  backend?: 'cpu' | 'gpu'
  topK?: number
  visualWeight?: number
  scanPaths?: string[]
}

export interface MediaSearchMultimodalSearchResponse {
  ok: boolean
  results: MediaSearchVideoFrameRecord[]
  totalCandidates: number
  error?: string
}

export type MediaPlayerHitKind = 'visual' | 'subtitle' | 'semantic' | 'fused'

export type MediaPlayerEvidenceSource =
  | 'cached-frame'
  | 'embedded-subtitle'
  | 'ai-visual-semantic'
  | 'ocr'
  | 'transcript-reference'
  | 'audio-event'

export interface MediaPlayerHit {
  startMs: number
  endMs?: number
  kind: MediaPlayerHitKind
  text?: string
  evidenceSources: MediaPlayerEvidenceSource[]
}

export interface MediaPlayerHitContext {
  query?: string
  selectedIndex: number
  hits: MediaPlayerHit[]
}

export interface OpenMediaAtTimeInput {
  videoId: string
  /** Exact in-app player position. The main process bounds it against the manifest duration. */
  timestampMs?: number
  /** Bounded search evidence used only by the sandboxed internal player. */
  hitContext?: MediaPlayerHitContext
}

export interface OpenMediaAtTimeResult {
  ok: boolean
  timestampMs?: number
  mode?: 'internal-player'
  error?: string
}

export interface RevealMediaPathInput {
  videoId?: string
  scanPath?: string
}

export interface VideoSemanticUiJob {
  jobId: string
  videoId: string
  generationId: string
  profileId: VideoSemanticProfileId
  state: 'queued' | 'running' | 'paused' | 'stopped' | 'done' | 'error'
  completedSegments: number
  failedSegments: number
  totalSegments: number
  currentSegmentId?: string
  lastError?: string
  updatedAt: number
}

export interface VideoSemanticUiStatus {
  runtime: VideoSemanticRuntimeStatus
  indexState: 'ready' | 'index-stale'
  activeVideos: number
  activeSegments: number
  selectedVideoId?: string
  activeGenerationId?: string
  profileOverride: VideoSemanticProfileId | 'auto'
  profiles: Array<{ id: VideoSemanticProfileId; displayName: string }>
  jobs: VideoSemanticUiJob[]
  canBuild: boolean
  canStop: boolean
  canResume: boolean
  updatedAt: number
}

export interface VideoSemanticControlResult {
  ok: boolean
  status?: VideoSemanticUiStatus
  error?: string
}

export interface AudioSemanticUiStatus {
  runtime: {
    adapterId: string
    state: 'not-installed' | 'ready' | 'busy' | 'unavailable' | 'error'
    reason?: string
    model?: {
      modelId: string
      modelRevision: string
      runtime: 'fake' | 'funasr' | 'sensevoice-gguf'
      quantization: string
    }
  }
  diarization: {
    state: 'not-installed' | 'ready' | 'unavailable' | 'error'
    reason?: string
    vadModel?: { modelId: string; modelRevision: string }
    speakerModel?: { modelId: string; modelRevision: string }
  }
  indexState: 'ready' | 'index-stale'
  indexedVideos: number
  indexedSegments: number
  /** True while a stale/missing compact transcript summary is rebuilt off the UI path. */
  statsPending?: boolean
  eligibleVideos: number
  job?: {
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
  capabilities: {
    asr: boolean
    language: boolean
    emotion: boolean
    audioEvents: boolean
    speakerDiarization: boolean
  }
  canBuild: boolean
  canStop: boolean
  canResume: boolean
  modelDownloadRequired: boolean
  updatedAt: number
}

export interface AudioSemanticControlResult {
  ok: boolean
  status?: AudioSemanticUiStatus
  error?: string
}

export interface MediaSearchApi {
  getStatus(request?: MediaSearchStatusRequest): Promise<MediaSearchStatus>
  getCacheStats(): Promise<MediaSearchCacheStats>
  clearCache(): Promise<MediaSearchClearCacheResult>
  clearData(): Promise<MediaSearchClearCacheResult>
  listVideos(
    request?: number | { limit?: number; includeImages?: boolean },
  ): Promise<MediaSearchVideoListResponse>
  listFrames(
    request?: number | { limit?: number; includeImages?: boolean },
  ): Promise<MediaSearchFrameListResponse>
  getFrameImageDataUrl(imagePath: string): Promise<MediaSearchImageDataResponse>
  getFramePreview(request: MediaSearchFramePreviewRequest): Promise<MediaSearchImageDataResponse>
  getFrameEmbeddingStats(): Promise<MediaSearchFrameEmbeddingStats>
  buildFrameEmbeddings(request: MediaSearchFrameEmbeddingRequest): Promise<RuntimeOperationResult>
  searchSimilarFrame(
    request: MediaSearchFrameSearchRequest,
  ): Promise<MediaSearchFrameSearchResponse>
  selectQueryImage(): Promise<{ path: string } | null>
  pasteClipboardImage(): Promise<{ ok: boolean; path?: string; error?: string }>
  searchFramesByImage(
    request: MediaSearchFrameImageSearchRequest,
  ): Promise<MediaSearchFrameImageSearchResponse>
  searchFramesByText(
    request: MediaSearchFrameTextSearchRequest,
  ): Promise<MediaSearchFrameTextSearchResponse>
  selectVideoPaths(
    mode?: MediaSearchVideoPathSelectionMode,
  ): Promise<MediaSearchVideoPathSelection | null>
  listDrives(): Promise<string[]>
  validatePath(path: string): Promise<{ ok: boolean; path?: string; error?: string }>
  selectFfmpegDirectory(): Promise<MediaSearchToolConfigResult | null>
  clearFfmpegDirectory(): Promise<MediaSearchToolConfigResult>
  openFfmpegToolsDirectory(): Promise<MediaSearchToolConfigResult>
  startScan(
    args: MediaSearchStartScanArgs,
  ): Promise<{ ok: boolean; taskId?: string; error?: string; warning?: string }>
  buildFrames(
    args: MediaSearchBuildFramesArgs,
  ): Promise<{ ok: boolean; taskId?: string; error?: string }>
  prepareLibrary(
    args: MediaSearchPrepareLibraryArgs,
  ): Promise<{ ok: boolean; taskId?: string; error?: string }>
  stopTask(taskId?: string): Promise<{ ok: boolean; error?: string }>
  getTaskProgress(taskId?: string): Promise<MediaSearchTaskProgress | null>
  openMediaAtTime(input: OpenMediaAtTimeInput): Promise<OpenMediaAtTimeResult>
  revealInExplorer(input: RevealMediaPathInput): Promise<{ ok: boolean; error?: string }>
  onTaskProgress(cb: (progress: MediaSearchTaskProgress) => void): () => void
  onSearchProgress(cb: (progress: MediaSearchTaskProgress) => void): () => void
  detectSubtitles(
    videoPath: string,
  ): Promise<{ ok: boolean; streams?: MediaSearchSubtitleStream[]; error?: string }>
  extractSubtitles(videoId: string): Promise<MediaSearchSubtitleExtractResult>
  searchTranscripts(
    request: MediaSearchTranscriptSearchRequest,
  ): Promise<MediaSearchTranscriptSearchResponse>
  searchMultimodal(
    request: MediaSearchMultimodalSearchRequest,
  ): Promise<MediaSearchMultimodalSearchResponse>
  getVideoSemanticStatus(videoId?: string, forceRefresh?: boolean): Promise<VideoSemanticUiStatus>
  getAudioSemanticStatus(forceRefresh?: boolean): Promise<AudioSemanticUiStatus>
  startAudioSemanticBuild(videoId?: string): Promise<AudioSemanticControlResult>
  stopAudioSemanticBuild(jobId: string): Promise<AudioSemanticControlResult>
  resumeAudioSemanticBuild(jobId: string): Promise<AudioSemanticControlResult>
  setVideoSemanticProfile(
    videoId: string,
    profileId: VideoSemanticProfileId | 'auto',
  ): Promise<VideoSemanticControlResult>
  startVideoSemanticBuild(videoId: string): Promise<VideoSemanticControlResult>
  stopVideoSemanticJob(jobId: string): Promise<VideoSemanticControlResult>
  resumeVideoSemanticJob(jobId: string): Promise<VideoSemanticControlResult>
}

export const MEDIA_SEARCH_IPC = {
  GET_STATUS: 'mediaSearch:getStatus',
  GET_CACHE_STATS: 'mediaSearch:getCacheStats',
  CLEAR_CACHE: 'mediaSearch:clearCache',
  LIST_FRAMES: 'mediaSearch:listFrames',
  GET_FRAME_IMAGE_DATA_URL: 'mediaSearch:getFrameImageDataUrl',
  GET_FRAME_PREVIEW: 'mediaSearch:getFramePreview',
  GET_FRAME_EMBEDDING_STATS: 'mediaSearch:getFrameEmbeddingStats',
  BUILD_FRAME_EMBEDDINGS: 'mediaSearch:buildFrameEmbeddings',
  SEARCH_SIMILAR_FRAME: 'mediaSearch:searchSimilarFrame',
  SELECT_QUERY_IMAGE: 'mediaSearch:selectQueryImage',
  SEARCH_FRAMES_BY_IMAGE: 'mediaSearch:searchFramesByImage',
  SEARCH_FRAMES_BY_TEXT: 'mediaSearch:searchFramesByText',
  SELECT_VIDEO_PATHS: 'mediaSearch:selectVideoPaths',
  START_SCAN: 'videoIndex:startScan',
  PREPARE_LIBRARY: 'mediaSearch:prepareLibrary',
  STOP_TASK: 'videoIndex:stopTask',
  GET_TASK_PROGRESS: 'videoIndex:getTaskProgress',
  OPEN_MEDIA_AT_TIME: 'mediaSearch:openMediaAtTime',
  REVEAL_IN_EXPLORER: 'mediaSearch:revealInExplorer',
  ON_TASK_PROGRESS: 'mediaSearch:onTaskProgress',
  GET_VIDEO_SEMANTIC_STATUS: 'mediaSearch:getVideoSemanticStatus',
  GET_AUDIO_SEMANTIC_STATUS: 'mediaSearch:getAudioSemanticStatus',
  START_AUDIO_SEMANTIC_BUILD: 'mediaSearch:startAudioSemanticBuild',
  STOP_AUDIO_SEMANTIC_BUILD: 'mediaSearch:stopAudioSemanticBuild',
  RESUME_AUDIO_SEMANTIC_BUILD: 'mediaSearch:resumeAudioSemanticBuild',
  SET_VIDEO_SEMANTIC_PROFILE: 'mediaSearch:setVideoSemanticProfile',
  START_VIDEO_SEMANTIC_BUILD: 'mediaSearch:startVideoSemanticBuild',
  STOP_VIDEO_SEMANTIC_JOB: 'mediaSearch:stopVideoSemanticJob',
  RESUME_VIDEO_SEMANTIC_JOB: 'mediaSearch:resumeVideoSemanticJob',
} as const
import type { RuntimeOperationResult } from '../runtimeErrors'
import type { VideoSemanticProfileId, VideoSemanticRuntimeStatus } from '../videoSemantic'
