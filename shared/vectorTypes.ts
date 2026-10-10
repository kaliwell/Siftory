// ── Vector Retrieval & Rerank Shared Types ─────────────────
// Layer 2 (Vector) + Layer 3 (Rerank) on top of fast_scanner Hash layer.
// All types are shared by electron/ services and src/ renderer.
// Keep this file free of node/electron imports.

import type { AssetFeedbackMode } from './ipc/asset-feedback'
import type { RuntimeErrorPayload } from './runtimeErrors'

// ── Model Management ──────────────────────────────────────

export type ModelState =
  | 'not-installed'
  | 'downloading'
  | 'downloaded'
  | 'verified'
  | 'loading'
  | 'loaded'
  | 'unloading'
  | 'error'

export interface ModelRequiredFile {
  filename: string
  url: string
  sha256: string
  sizeBytes: number
}

export interface ModelInfo {
  name: string // e.g. "dinov2_vitb14"
  displayName: string // e.g. "DINOv2 ViT-B/14"
  version: string // e.g. "1.0.0"
  url: string // download URL
  filename: string // e.g. "dinov2_vitb14_pretrain.pth"
  sha256: string
  sizeBytes: number
  license: string // SPDX or license name
  commercialFriendly: boolean
  dim: number // embedding dimension
  inputSize: number // expected input size (224 or 336)
  framework: 'pytorch' | 'onnx' | 'other'
  description: string
  /** Additional hash-pinned files required before the model is runtime-ready. */
  requiredFiles?: ModelRequiredFile[]
}

export interface ModelStatus {
  state: ModelState
  name: string
  version?: string
  progress?: number // 0-100 download percentage
  bytesDownloaded?: number
  totalBytes?: number
  error?: string
  installedVersion?: string
  installedPath?: string
}

// ── Embedding ─────────────────────────────────────────────

export type EmbeddingType = 'global' | 'object_crop'

/** Aggregate, de-identified timings for one embedding build. */
export interface EmbeddingStageMetrics {
  schemaVersion: 1
  batches: number
  items: number
  succeeded: number
  failed: number
  fallbackBatches: number
  queueWaitMsTotal: number
  queueWaitMsMax: number
  batchWallMsTotal: number
  batchWallMsMax: number
  runtimeLoadMsTotal: number
  decodeNormalizeMsTotal: number
  preprocessMsTotal: number
  inferenceMsTotal: number
  postprocessMsTotal: number
  fallbackMsTotal: number
  persistenceOperations: number
  persistenceMsTotal: number
  persistenceMsMax: number
  persistencePeakPending: number
}

export interface EmbeddingEntry {
  id: number // auto-increment PK
  imageId: string // corresponds to fast_scanner image id / path
  modelName: string
  modelVersion: string
  embeddingType: EmbeddingType
  dim: number
  vector: Float32Array | number[]
  norm: number // L2 norm
  createdAt: number // epoch ms
  updatedAt: number
}

export interface EmbeddingJob {
  id?: number
  imageId: string
  path: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  modelName: string
  embeddingType: EmbeddingType
  error?: string
  retries: number
  createdAt: number
  updatedAt?: number
  epoch?: number
  owner?: string
  heartbeatAt?: number
  startedAt?: number
  finishedAt?: number
}

export interface EmbeddingProgress {
  total: number
  completed: number
  failed: number
  skipped: number
  running: number
  pending: number
  startedAt?: number
  elapsedMs?: number
  itemsPerSecond?: number
  etaMs?: number
  currentImageId?: string
  currentPath?: string
  state: 'idle' | 'queued' | 'running' | 'paused' | 'stopping' | 'done' | 'error'
  error?: string
  runtimeError?: RuntimeErrorPayload
  effectiveBatchSize?: number
  batchMode?: 'auto' | 'manual' | 'default'
  batchReason?: string
  availableMemoryMb?: number
  availableVideoMemoryMb?: number
  stageMetrics?: EmbeddingStageMetrics
  providerTelemetry?: EmbeddingProviderTelemetry
}

export interface EmbeddingProviderTelemetry {
  schemaVersion: 1
  model: 'dino' | 'clip'
  requestedBackends: Array<'cpu' | 'gpu' | 'cuda'>
  selectedProviders: Array<'cpu' | 'dml' | 'gpu' | 'cuda'>
  fallbackDetected: boolean
  reports: number
  reasons: string[]
}

// ── Vector Index ──────────────────────────────────────────

export interface VectorIndexManifest {
  version: number
  modelName: string
  modelVersion: string
  embeddingType: EmbeddingType
  dim: number
  count: number
  indexType: 'memory' | 'memory_lsh' | 'streaming' | 'hnswlib' | 'faiss'
  indexPath?: string
  createdAt: number
  updatedAt: number
}

export interface VectorSearchResult {
  imageId: string
  path: string
  vectorScore: number // cosine similarity [0, 1]
  modelName: string
  embeddingType: EmbeddingType
}

export interface VectorSearchRequest {
  queryVector: Float32Array | number[]
  topK: number
  modelName?: string // filter by model
  embeddingType?: EmbeddingType
  /** Main-process only cooperative cancellation hook; never sent over IPC. */
  isCancelled?: () => boolean
  /** Main-process only active-index filter; never sent over IPC. */
  acceptPath?: (filePath: string) => boolean
  /**
   * Main-process only scope snapshot pushed into ANN candidate selection;
   * never sent over IPC. Keys are plain paths; the ANN worker normalizes them
   * with embeddingCachePathKey semantics before matching cache rows.
   */
  acceptPathKeys?: readonly string[]
}

// ── Feature Extractors ────────────────────────────────────

export interface ColorFeature {
  id?: number
  imageId: string
  featureType: 'hsv_hist' | 'lab_hist'
  colorHist: number[] // histogram bins
  dominantColors: { r: number; g: number; b: number; pct: number }[]
  createdAt: number
  updatedAt: number
}

export interface ShapeFeature {
  id?: number
  imageId: string
  aspectRatio: number
  objectAreaRatio: number // bbox area / image area
  edgeDensity: number
  bboxWidth: number
  bboxHeight: number
  createdAt: number
  updatedAt: number
}

export interface ObjectCropEntry {
  id?: number
  imageId: string
  cropType: 'center' | 'bounding_box' | 'manual' | 'yolo' | 'sam'
  x: number
  y: number
  w: number
  h: number
  confidence: number
  source: string
  createdAt: number
}

// ── Search Modes & Results ────────────────────────────────

export type SearchMode = 'fast' | 'standard' | 'precise'
export type MatchLevel = 'exact' | 'near_duplicate' | 'same_product' | 'similar_product' | 'weak'

export interface LayeredSearchResult {
  imageId: string
  path: string
  /** Short-lived main-process capability for dragging this exact search result. */
  dragToken?: string
  /** Normal drag uses a rendered compatibility preview; Shift-drag keeps the source file. */
  dragUsesCompatibilityPreview?: boolean
  thumbPath?: string
  finalScore: number
  hashScore: number
  vectorScore: number
  colorScore: number
  shapeScore: number
  localFeatureScore: number
  ocrScore: number
  feedbackBoost?: number
  diffDistance?: number
  dctDistance?: number
  phashDistance?: number
  dhashDistance?: number
  matchLevel: MatchLevel
  reasons: string[]
  indexSources: ('hash' | 'vector' | 'semantic_text' | 'clip_embedding')[]
  width?: number
  height?: number
  fileSize?: number
  modifiedTime?: number
  sourceKind?: 'project'
  sourceExt?: string
  projectDisplayType?: string
  keywords?: string[]
  previewProvider?: string
}

export interface LayeredSearchRequest {
  imagePath: string
  mode: SearchMode
  requestId?: string
  hashThreshold?: number // Hamming distance threshold
  hashTopK?: number
  vectorTopK?: number
  rerankTopK?: number
  /** Optional explicit vector-search deadline; omitted means user-cancellable with no deadline. */
  timeoutMs?: number
  /** Resolved by the main process from vector settings. */
  backend?: 'cpu' | 'gpu'
}

export interface SemanticSearchRequest {
  text: string
  topK?: number
  requestId?: string
  feedbackMode?: AssetFeedbackMode
  /** Main-process only cooperative cancellation hook; never sent over IPC. */
  isCancelled?: () => boolean
}

export interface SemanticSearchResponse {
  results: LayeredSearchResult[]
  query: string
  totalCandidates: number
  matchedCandidates?: number
  returnedCount?: number
  fallbackCount?: number
  totalMs: number
  degraded: boolean
  degradationReasons: string[]
  searchMode: 'semantic'
  /** Which text encoder produced the query embedding (CLIP-embedding search path only). */
  textEncoderUsed?: 'english' | 'multilingual'
  feedbackApplied?: boolean
  feedbackRevision?: number
  feedbackBuiltRevision?: number
  feedbackStale?: boolean
  feedbackMs?: number
  feedbackTargets?: Array<{
    kind: 'category' | 'tag'
    id: number
    name: string
    gate: number
  }>
}

export interface LayeredSearchResponse {
  results: LayeredSearchResult[]
  mode: SearchMode
  degraded: boolean
  degradationReasons: string[]
  queryHash?: string
  queryDctHash64?: string
  hashCandidateCount?: number
  vectorCandidateCount?: number
  mergedCandidateCount?: number
  rerankedCount?: number
  featureRerankCandidateCount?: number
  featurePreparedCount?: number
  featureDeferredCount?: number
  totalMs?: number
  hashMs?: number
  vectorMs?: number
  rerankMs?: number
  featureMs?: number
  modelStatus: ModelStatus
  searchMode: SearchMode
}

export interface SemanticSearchProgress {
  requestId?: string
  phase: 'preparing' | 'embedding' | 'scanning' | 'fallback' | 'done' | 'error'
  scanned: number
  total?: number
  percent?: number
  startedAt?: number
  elapsedMs?: number
  itemsPerSecond?: number
  etaMs?: number
  message?: string
}

export interface LayeredSearchProgress {
  requestId?: string
  mode: SearchMode
  phase:
    | 'preparing'
    | 'hash'
    | 'vector_embedding'
    | 'vector_search'
    | 'merge'
    | 'rerank'
    | 'done'
    | 'error'
  scanned: number
  total?: number
  percent?: number
  startedAt?: number
  elapsedMs?: number
  itemsPerSecond?: number
  etaMs?: number
  message?: string
}

// ── Vector Build / Index ──────────────────────────────────

export interface VectorBuildRequest {
  modelName: string
  embeddingType: EmbeddingType
  imageIds?: string[] // optional subset; all if omitted
  scanPaths?: string[] // fallback source when no embedding jobs have been seeded yet
  /** `auto` lets the main process choose GPU when a usable adapter is available. */
  backend?: 'auto' | 'cpu' | 'gpu'
  maxConcurrentEmbeddings?: number
  /** 0 selects an adaptive batch; positive values remain explicit user overrides. */
  batchSize?: number
  /** Main-process only: keeps one validated model worker set open for committed input chunks. */
  streamSessionId?: string
}

export interface ComputeBackendCapability {
  gpuAvailable: boolean
  recommendedBackend: 'cpu' | 'gpu'
  reason: string
  deviceName?: string
  checkedAt: number
}

export interface VectorBuildProgress {
  total: number
  completed: number
  failed: number
  skipped: number
  currentPath?: string
  state: 'idle' | 'running' | 'paused' | 'stopping' | 'done' | 'error'
  error?: string
}

// ── Color / Shape Extract Request ─────────────────────────

export interface FeatureExtractRequest {
  imageIds?: string[]
  featureTypes: ('color' | 'shape')[]
}

export interface FeatureExtractProgress {
  total: number
  completed: number
  failed: number
  state: 'idle' | 'running' | 'done' | 'error'
  error?: string
}

// ── Settings ──────────────────────────────────────────────

export interface VectorSettings {
  enabled: boolean
  modelName: string
  modelDir: string
  maxConcurrentEmbeddings: number
  embeddingTimeoutMs: number
  rerankEnabled: boolean
  vectorTopK: number
  rerankTopK: number
  backend: 'cpu' | 'gpu'
  /** Semantic text encoder selection; 'auto' routes CJK queries to the multilingual encoder. */
  textEncoder?: 'auto' | 'english' | 'multilingual'
}

export const DEFAULT_VECTOR_SETTINGS: VectorSettings = {
  enabled: false,
  modelName: 'dinov2_vitb14',
  modelDir: '', // filled at runtime from userData
  maxConcurrentEmbeddings: 1,
  embeddingTimeoutMs: 30000,
  rerankEnabled: false,
  vectorTopK: 200,
  rerankTopK: 50,
  backend: 'cpu',
  textEncoder: 'auto',
}
