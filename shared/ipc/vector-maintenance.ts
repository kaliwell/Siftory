export interface VectorGcShardPreview {
  name: string
  sourceBytes: number
  totalRecords: number
  activeRecords: number
  staleRecords: number
  duplicateRecords: number
  malformedRecords: number
  predictedBytes: number
  reclaimableBytes: number
  modelName?: string
  embeddingType?: string
  dim?: number
}

export interface VectorGcPreview {
  token: string
  createdAt: number
  expiresAt: number
  activeAssetCount: number
  shards: VectorGcShardPreview[]
  reclaimableBytes: number
}

export interface VectorGcProgress {
  taskId?: string
  state: 'idle' | 'running' | 'completed' | 'cancelled' | 'error'
  completedShards: number
  totalShards: number
  currentShard?: string
  freedBytes: number
  pendingReleaseBytes: number
  backups: number
  errors: string[]
  startedAt?: number
  updatedAt?: number
  finishedAt?: number
}

export interface VectorStoreMigrationModelPreview {
  modelName: string
  embeddingType: string
  dim: number
  sourceBytes: number
  estimatedBinaryBytes: number
  alreadyCurrent: boolean
}

export interface VectorStoreMigrationPreview {
  token: string
  createdAt: number
  expiresAt: number
  currentGeneration?: string
  models: VectorStoreMigrationModelPreview[]
  sourceBytes: number
  estimatedBinaryBytes: number
}

export interface VectorStoreMigrationProgress {
  taskId?: string
  state: 'idle' | 'running' | 'completed' | 'cancelled' | 'error'
  completedModels: number
  totalModels: number
  currentModel?: string
  writtenBytes: number
  generation?: string
  errors: string[]
  startedAt?: number
  updatedAt?: number
  finishedAt?: number
}

export interface VectorMaintenanceFileStat {
  exists?: boolean
  name?: string
  path?: string
  sizeBytes: number
  sizeMb: number
}

export interface VectorFailureSummaryItem {
  key: string
  count: number
}

export interface VectorRecentFailure {
  time?: string
  imageId?: string
  modelName?: string
  error: string
}

export interface VectorFailureRetryCandidates {
  ok: boolean
  imageIds: string[]
  totalMatched: number
  skippedMissing: number
  error?: string
}

export type StorageInventoryTaskState = 'idle' | 'active' | 'unknown'

export interface StorageInventoryItem {
  id: string
  domain: 'image-search' | 'vectors' | 'media-search' | 'asset-library' | 'maintenance'
  label: string
  pathCategory: string
  totalBytes: number
  activeBytes: number
  reclaimableBytes: number
  lastModifiedAt?: number
  rebuildable: boolean
  cleanupRisk: 'low' | 'medium' | 'high'
  taskState: StorageInventoryTaskState
  fileCount: number
  detail?: string
}

export interface StorageCleanupPreviewItem {
  id: string
  label: string
  pathCategory: string
  domain: StorageInventoryItem['domain']
  cleanupRisk: StorageInventoryItem['cleanupRisk']
  estimatedBytes: number
  fileCount: number
}

export interface StorageCleanupPreview {
  token: string
  createdAt: number
  expiresAt: number
  items: StorageCleanupPreviewItem[]
  estimatedBytes: number
}

export interface StorageCleanupProgress {
  taskId?: string
  state: 'idle' | 'running' | 'completed' | 'cancelled' | 'error'
  selectedIds?: string[]
  completedFiles: number
  totalFiles: number
  freedBytes: number
  skipped: number
  errors: string[]
  startedAt?: number
  updatedAt?: number
  finishedAt?: number
}

export interface ProcessedImageDataCategory {
  id: 'image-search-index' | 'thumbnails' | 'scan-logs' | 'vector-db'
  label: string
  estimatedBytes: number
  fileCount: number
}

export interface ProcessedImageDataPreview {
  categories: ProcessedImageDataCategory[]
  estimatedBytes: number
  fileCount: number
}

export interface ProcessedImageDataResetResult {
  ok: boolean
  freedBytes: number
  deletedFiles: number
  error?: string
  errors: string[]
}

export interface VectorClearDiagnosticsResult {
  ok: boolean
  deleted: number
  freedBytes: number
  error?: string
}

export interface VectorClearFailuresResult {
  ok: boolean
  cleared: boolean
  freedBytes: number
  error?: string
}

export interface VectorCompactJobsResult {
  ok: boolean
  beforeBytes: number
  afterBytes: number
  kept: number
  removed: number
  error?: string
}

export interface VectorMaintenanceStats {
  vectorDbPath: string
  totalBytes: number
  totalMb: number
  embeddingsDirBytes: number
  embeddingsDirMb: number
  dinoEmbeddingRecords: number
  dinoUniqueImages: number
  clipEmbeddingRecords: number
  clipUniqueImages: number
  clipCacheRecords: number
  clipCacheUniquePaths: number
  failureCount: number
  failureByModel: VectorFailureSummaryItem[]
  failureByReason: VectorFailureSummaryItem[]
  recentFailures: VectorRecentFailure[]
  storageInventory: {
    items: StorageInventoryItem[]
    totalBytes: number
    reclaimableBytes: number
    scannedAt: number
  }
  embeddingShards: VectorMaintenanceFileStat[]
  jobs: VectorMaintenanceFileStat
  failures: VectorMaintenanceFileStat
  diagnostics: VectorMaintenanceFileStat
  diagnosticBackups: VectorMaintenanceFileStat[]
  logHealth: Array<{
    name: 'failures' | 'diagnostics'
    ok: boolean
    lastSuccessfulWriteAt?: number
    lastError?: string
    lastErrorAt?: number
    compactions: number
    droppedRecords: number
  }>
  persistence: Array<{
    filename: string
    pendingWrites: number
    lastWriteError?: string
    lastWriteErrorAt?: number
    lastSuccessfulWriteAt?: number
    corruptedRows: number
  }>
  clipCache: {
    vectors: VectorMaintenanceFileStat
    paths: VectorMaintenanceFileStat
    meta: VectorMaintenanceFileStat
  }
}

// ── Settings & Config data types ─────────────────────────
