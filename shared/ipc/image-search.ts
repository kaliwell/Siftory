// Image search, thumbnail, vector maintenance, and storage IPC contracts.

export type ImageSearchState =
  | 'idle'
  | 'queued'
  | 'scanning'
  | 'indexing'
  | 'searching'
  | 'paused'
  | 'error'

export interface ImageSearchStatus {
  state: ImageSearchState
  indexedCount: number
  pendingCount: number
  currentPath?: string
  message?: string
  lastError?: string
  lastWarning?: string
  skippedCount?: number
  signatureRejectedCount?: number
  skippedIndexed?: number
  skippedUnchanged?: number
  newCount?: number
  updatedCount?: number
  warningCount?: number
  durationMs?: number
  detailedMetricsEnabled?: boolean
  nativeVersion?: string
  nativeConnected?: boolean
  nativePath?: string
  indexMode?: string
  segmentVersion?: number
  segmentPath?: string
  autosaveState?: string
  lastSaveTime?: number
  pathIndexMapSize?: number
  overlayCount?: number
  replacedCount?: number
  deletedCount?: number
  autoloadSource?: string // 'settings' | 'default' | 'repair' | 'none'
  segmentCount?: number
  pathMapHealthy?: boolean
  // Perf timing (ms)
  enumMs?: number
  filesystemEnumMs?: number
  queueWaitMs?: number
  queueSubmitCount?: number
  queueBlockedCount?: number
  readMs?: number
  readFileCount?: number
  readBytes?: number
  normalizeMs?: number
  mapLookupMs?: number
  statMs?: number
  decodeMsTotal?: number
  hashMsTotal?: number
  pushMs?: number
  commitMs?: number
  totalScanMs?: number
  backend?: string
  fallbackReason?: string
  fallbackCode?: string
  fallbackAction?: string
  usnWin32Error?: number
  usnRequiresAdmin?: boolean
  enumDirCount?: number
  enumFileCount?: number
  enumImageCount?: number
  enumSkippedDirCount?: number
  scanWorkerCount?: number
  scanQueueCapacity?: number
  scanQueuePending?: number
  scanPeakQueuePending?: number
  scanActiveWorkers?: number
  scanPeakWorkers?: number
  scanWorkerMinCompleted?: number
  scanWorkerMaxCompleted?: number
  scanWorkerMinBusyMs?: number
  scanWorkerMaxBusyMs?: number
  decodeBackend?: string
  thumbnailEnabled?: boolean
  thumbnailQueued?: number
  thumbnailCompleted?: number
  thumbnailFailed?: number
  thumbnailDropped?: number
  thumbnailPending?: number
  thumbnailInputReused?: number
  thumbnailInputReusedBytes?: number
  thumbnailInputFallback?: number
  thumbnailSourceReads?: number
  thumbnailRetainedInputBytes?: number
  thumbnailRetainedInputLimitBytes?: number
  thumbnailWorkerCount?: number
  thumbnailScanWorkerCount?: number
  thumbnailFillWorkerCount?: number
  thumbnailQueueCapacity?: number
  thumbnailDeferred?: number
  thumbnailDeferredPending?: number
  thumbnailDeferredPathBytes?: number
  thumbnailDeferredEntryLimit?: number
  thumbnailDeferredPathLimitBytes?: number
  thumbnailFillCompleted?: number
  thumbnailFillFailed?: number
  thumbnailCancelled?: number
  thumbnailLogicalProcessors?: number
  thumbnailTotalMemoryBytes?: number
  thumbnailAvailableMemoryBytes?: number
  thumbnailWorkerOverride?: boolean
  thumbnailWorkerPolicy?: string
  thumbnailPhase?: string
  projectDiscovered?: number
  projectIndexed?: number
  projectUnavailable?: number
  projectFailed?: number
  projectRemoved?: number
}

export interface ImageSearchResult {
  id: string
  path: string
  /** Short-lived main-process capability for dragging this exact search result. */
  dragToken?: string
  /** Normal drag uses a rendered compatibility preview; Shift-drag keeps the source file. */
  dragUsesCompatibilityPreview?: boolean
  score: number
  distance?: number
  width?: number
  height?: number
  fileSize?: number
  modifiedTime?: number
  diffHash64?: string
  dctHash64?: string
  sourceKind?: 'project'
  sourceExt?: string
  projectDisplayType?: string
  keywords?: string[]
  previewProvider?: string
}

// Image scan and searchable-library preparation task contracts live with the
// rest of the image-search IPC surface. Keeping these small contracts here
// avoids making every main-process consumer traverse type-only leaf modules.
export interface ImageSearchStartScanArgs {
  paths: string[]
  mode?: 'light' | 'balanced' | 'fast'
  exclude?: string[]
  scanMode?: 'addNew' | 'update' | 'updateAll' | 'full'
  /** Generate native JPEG thumbnails for newly decoded JPEG images. */
  buildThumbnails?: boolean
}

export type ImageSearchPreparationPhase =
  | 'scanning'
  | 'embedding-dino'
  | 'finalizing-scan'
  | 'finalizing-dino'
  | 'embedding-clip'
  | 'indexing'
  | 'done'

export interface ImageSearchPrepareLibraryArgs {
  paths: string[]
  backend?: 'auto' | 'cpu' | 'gpu'
  maxConcurrentEmbeddings?: number
  batchSize?: number
  buildThumbnails?: boolean
}

export interface ImageSearchPreparationProgress {
  taskId?: string
  state: 'idle' | 'running' | 'done' | 'stopped' | 'error'
  phase?: ImageSearchPreparationPhase
  percentage: number
  message?: string
  error?: string
  scanIndexed: number
  committedImages: number
  invalidatedImages: number
  commitFeedDropped: number
  scanComplete: boolean
  dinoEmbeddingComplete: boolean
  clipEmbeddingComplete: boolean
  vectorIndexComplete: boolean
  startedAt?: number
  updatedAt?: number
  finishedAt?: number
}

export interface ImageSearchPrepareLibraryStartResult {
  ok: boolean
  taskId?: string
  error?: string
}

export interface ImageSearchSearchArgs {
  query?: string
  imagePath?: string
  threshold?: number
  topK?: number
  searchMode?: 'fast' | 'balanced' | 'recall'
}

export interface ImageSearchSearchResponse {
  results: ImageSearchResult[]
  status: ImageSearchStatus
  queryHash?: string
  queryDctHash64?: string
  scannedCount?: number
  candidateCount?: number
  resultCount?: number
  searchMs?: number
  mode?: string
  indexType?: string
  bucketSize?: number
  fallbackUsed?: boolean
  searchMode?: string
}

export interface ImageHashResult {
  ok: boolean
  diffHash64?: string
  dctHash64?: string
  diffHash256?: string
  width?: number
  height?: number
  channels?: number
  fileSize?: number
  decodeMs?: number
  readMs?: number
  hashMs?: number
  decodeBackend?: string
  error?: string
}

export interface ImageSearchDataRecord {
  path: string
  width: number
  height: number
  fileSize: number
  modifiedTime: number
  exists: boolean
}

export interface ImageSearchDataQueryResult {
  ok: boolean
  records?: ImageSearchDataRecord[]
  offset?: number
  hasMore?: boolean
  scanned?: number
  error?: string
}

export interface ImageSearchDataEditResult {
  ok: boolean
  recordCount?: number
  removedCount?: number
  error?: string
}

export interface ImageSearchDataStatsResult {
  ok: boolean
  count?: number
  totalBytes?: number
  error?: string
}

export type ImageSearchFolderDataLayer = 'native' | 'dino' | 'clip'

export interface ImageSearchFolderDataLayerStats {
  /** Unique indexed image paths under the requested folder. */
  count: number
  /** Physical JSONL rows; can exceed count when an image has older revisions. */
  recordCount: number
  /** Bytes occupied by matching rows (Native reports source-image bytes). */
  matchedBytes: number
  /** Total bytes of the backing files that must be read/re-written. */
  sourceBytes: number
  fileCount: number
}

export interface ImageSearchFolderDataEditPreview {
  ok: boolean
  token?: string
  folder?: string
  createdAt?: number
  expiresAt?: number
  selectedLayers?: ImageSearchFolderDataLayer[]
  native?: ImageSearchFolderDataLayerStats
  dino?: ImageSearchFolderDataLayerStats
  clip?: ImageSearchFolderDataLayerStats
  /** Worst-case free space needed for atomic vector-shard rewrites. */
  temporaryBytes?: number
  /** Rebuildable cache files invalidated when matching vector shards change. */
  invalidatedCacheFiles?: number
  invalidatedCacheBytes?: number
  error?: string
}

export interface ImageSearchFolderDataEditResult {
  ok: boolean
  folder?: string
  removedCount?: number
  removed?: Record<ImageSearchFolderDataLayer, number>
  removedRecords?: Record<ImageSearchFolderDataLayer, number>
  auxiliaryRemoved?: number
  invalidatedCacheFiles?: number
  invalidatedCacheBytes?: number
  backupCount?: number
  pendingReleaseBytes?: number
  warnings?: string[]
  error?: string
}

export interface ImageSearchFolderDataEditProgress {
  state:
    | 'idle'
    | 'previewing'
    | 'ready'
    | 'rewriting'
    | 'finalizing'
    | 'completed'
    | 'cancelled'
    | 'error'
  phase?: 'scan' | 'rewrite' | 'cache' | 'native'
  folder?: string
  currentFile?: string
  processedBytes: number
  totalBytes: number
  removedRecords: number
  error?: string
  startedAt?: number
  updatedAt?: number
  finishedAt?: number
}

export type ImageSearchDataCatalogState =
  | 'no-catalog'
  | 'ready'
  | 'stale'
  | 'building'
  | 'cancelling'
  | 'error'

export type ImageSearchDataCatalogTaskState =
  | 'idle'
  | 'collecting'
  | 'building'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'error'

export type ImageSearchDataCatalogStage =
  | 'inventory'
  | 'native'
  | 'dino'
  | 'clip'
  | 'folders'
  | 'validate'
  | 'switch'

export interface ImageSearchDataCatalogProgress {
  taskId?: string
  state: ImageSearchDataCatalogTaskState
  stage?: ImageSearchDataCatalogStage
  processedBytes: number
  totalBytes: number
  processedRecords: number
  nativeRecords: number
  dinoRecords: number
  clipRecords: number
  message?: string
  error?: string
  startedAt?: number
  updatedAt?: number
  finishedAt?: number
}

export type ImageSearchDataStoreRole =
  | 'authoritative'
  | 'derived'
  | 'maintenance'
  | 'recovery'
  | 'catalog'

export interface ImageSearchDataStoreFile {
  id: string
  name: string
  /** Path relative to Electron userData; never accepted back as an authority. */
  relativePath: string
  sizeBytes: number
  modifiedAt?: number
}

export interface ImageSearchDataStore {
  id: string
  label: string
  layer: 'native' | 'dino' | 'clip' | 'shared'
  role: ImageSearchDataStoreRole
  pathCategory: string
  fileCount: number
  totalBytes: number
  lastModifiedAt?: number
  rebuildable: boolean
  cleanupRisk: 'low' | 'medium' | 'high'
  freshness: 'current' | 'stale' | 'unknown' | 'not-applicable'
  inventoryComplete: boolean
  filesTruncated: boolean
  files: ImageSearchDataStoreFile[]
  recordCount?: number
  uniqueCount?: number
  malformedCount?: number
  duplicateCount?: number
  detail?: string
}

export interface ImageSearchDataOverview {
  ok: boolean
  catalogState: ImageSearchDataCatalogState
  stores: ImageSearchDataStore[]
  totalBytes: number
  authoritativeBytes: number
  generation?: string
  builtAt?: number
  unionPathCount: number
  nativeUniqueCount: number
  dinoUniqueCount: number
  clipUniqueCount: number
  completeCount: number
  missingDinoCount: number
  missingClipCount: number
  vectorOnlyCount: number
  duplicateRows: number
  malformedRows: number
  folderCount: number
  error?: string
}

export interface ImageSearchDataFolderQuery {
  parent?: string | null
  query?: string
  onlyAnomalies?: boolean
  offset?: number
  limit?: number
}

export interface ImageSearchDataFolder {
  folder: string
  parent?: string
  name: string
  depth: number
  childCount: number
  nativeCount: number
  dinoCount: number
  clipCount: number
  nativeOnly: number
  dinoOnly: number
  clipOnly: number
  missingDino: number
  missingClip: number
  vectorOnly: number
  duplicateRows: number
  malformedRows: number
  matchedBytes: number
}

export interface ImageSearchDataFolderList {
  ok: boolean
  catalogState: ImageSearchDataCatalogState
  generation?: string
  parent?: string | null
  records: ImageSearchDataFolder[]
  offset: number
  total: number
  hasMore: boolean
  error?: string
}

export interface ImageSearchDataCatalogStartResult {
  ok: boolean
  taskId?: string
  error?: string
}

export interface ThumbnailRebuildProgress {
  state: 'idle' | 'running' | 'stopping' | 'done' | 'error'
  total: number
  completed: number
  skipped: number
  failed: number
  requestedBackend?: ThumbnailRebuildBackend
  effectiveBackend?: 'gpu' | 'cpu' | 'mixed' | 'native-cpp' | 'cuda'
  gpuCompleted?: number
  cpuCompleted?: number
  fallbackCount?: number
  /** User-requested GPU job setting. */
  gpuJobs?: number
  /** Actual GPU renderer lanes available to the pipeline. */
  gpuLanes?: number
  cpuLanes?: number
  batchSize?: number
  inFlight?: number
  peakInFlight?: number
  gpuQueueDepth?: number
  cpuQueueDepth?: number
  cacheQueueDepth?: number
  cacheWrites?: number
  cacheWriteFailures?: number
  /** GPU-eligible Auto tasks routed to idle CPU lanes under GPU congestion. */
  autoCpuRouted?: number
  gpuDevice?: string
  gpuError?: string
  currentPath?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}

export type ThumbnailRebuildBackend = 'auto' | 'gpu' | 'cpu' | 'native' | 'cuda'

// ── IPC Channel Constants ─────────────────────────────────

export const IMAGE_SEARCH_IPC = {
  GET_STATUS: 'imageSearch:getStatus',
  START_SCAN: 'imageSearch:startScan',
  STOP_SCAN: 'imageSearch:stopScan',
  PREPARE_LIBRARY: 'imageSearch:prepareLibrary',
  GET_PREPARATION_PROGRESS: 'imageSearch:getPreparationProgress',
  STOP_PREPARATION: 'imageSearch:stopPreparation',
  ON_PREPARATION_PROGRESS: 'imageSearch:onPreparationProgress',
  SEARCH: 'imageSearch:search',
  SELECT_PATHS: 'imageSearch:selectPaths',
  ON_STATUS_CHANGED: 'imageSearch:onStatusChanged',
  HASH_IMAGE: 'imageSearch:hashImage',
  SELECT_IMAGE: 'imageSearch:selectImage',
  OPEN_FILE: 'imageSearch:openFile',
  OPEN_FOLDER: 'imageSearch:openFolder',
  CLEAR_INDEX: 'imageSearch:clearIndex',
  SAVE_INDEX: 'imageSearch:saveIndex',
  LOAD_INDEX: 'imageSearch:loadIndex',
  LOAD_MANIFEST: 'imageSearch:loadManifest',
  REPAIR_MANIFEST: 'imageSearch:repairManifest',
  GET_INDEX_MODE: 'imageSearch:getIndexMode',
  LIST_DRIVES: 'imageSearch:listDrives',
  VALIDATE_PATH: 'imageSearch:validatePath',
  QUERY_DATA: 'imageSearch:queryData',
  GET_DATA_STATS: 'imageSearch:getDataStats',
  GET_DATA_OVERVIEW: 'imageSearch:getDataOverview',
  START_DATA_CATALOG_BUILD: 'imageSearch:startDataCatalogBuild',
  GET_DATA_CATALOG_PROGRESS: 'imageSearch:getDataCatalogProgress',
  CANCEL_DATA_CATALOG_BUILD: 'imageSearch:cancelDataCatalogBuild',
  LIST_DATA_FOLDERS: 'imageSearch:listDataFolders',
  OPEN_DATA_STORE_LOCATION: 'imageSearch:openDataStoreLocation',
  PREVIEW_FOLDER_DATA_EDIT: 'imageSearch:previewFolderDataEdit',
  EXECUTE_FOLDER_DATA_EDIT: 'imageSearch:executeFolderDataEdit',
  GET_FOLDER_DATA_EDIT_PROGRESS: 'imageSearch:getFolderDataEditProgress',
  CANCEL_FOLDER_DATA_EDIT: 'imageSearch:cancelFolderDataEdit',
  GET_DIR_NAME_STATS: 'imageSearch:getDirNameStats',
  UPDATE_DATA: 'imageSearch:updateData',
  DELETE_DATA: 'imageSearch:deleteData',
  DELETE_DATA_FOLDER: 'imageSearch:deleteDataFolder',
  DELETE_DIR_NAME: 'imageSearch:deleteDirName',
  REPAIR_DATA_PATH: 'imageSearch:repairDataPath',
  START_THUMBNAIL_REBUILD: 'imageSearch:startThumbnailRebuild',
  GET_THUMBNAIL_REBUILD_PROGRESS: 'imageSearch:getThumbnailRebuildProgress',
  STOP_THUMBNAIL_REBUILD: 'imageSearch:stopThumbnailRebuild',
  CLEAR_THUMBNAIL_CACHE: 'imageSearch:clearThumbnailCache',
} as const

// ── Vector / Rerank IPC Channels ─────────────────────────

export const VECTOR_IPC = {
  GET_MODEL_STATUS: 'vector:getModelStatus',
  DOWNLOAD_MODEL: 'vector:downloadModel',
  LIST_USER_MODEL_SLOTS: 'vector:listUserModelSlots',
  CHECK_USER_MODEL_SLOTS: 'vector:checkUserModelSlots',
  IMPORT_USER_MODEL: 'vector:importUserModel',
  REMOVE_USER_MODEL: 'vector:removeUserModel',
  OPEN_USER_MODEL_FOLDER: 'vector:openUserModelFolder',
  CANCEL_DOWNLOAD: 'vector:cancelDownload',
  DELETE_MODEL: 'vector:deleteModel',
  START_EMBEDDING_BUILD: 'vector:startEmbeddingBuild',
  STOP_EMBEDDING_BUILD: 'vector:stopEmbeddingBuild',
  PAUSE_EMBEDDING_BUILD: 'vector:pauseEmbeddingBuild',
  RESUME_EMBEDDING_BUILD: 'vector:resumeEmbeddingBuild',
  GET_EMBEDDING_PROGRESS: 'vector:getEmbeddingProgress',
  BUILD_VECTOR_INDEX: 'vector:buildVectorIndex',
  GET_VECTOR_INDEX_STATUS: 'vector:getVectorIndexStatus',
  SEARCH_LAYERED: 'vector:searchLayered',
  STOP_LAYERED_SEARCH: 'vector:stopLayeredSearch',
  SEARCH_SEMANTIC: 'vector:searchSemantic',
  EXTRACT_FEATURES: 'vector:extractFeatures',
  GET_FEATURE_PROGRESS: 'vector:getFeatureProgress',
  GET_VECTOR_SETTINGS: 'vector:getVectorSettings',
  SAVE_VECTOR_SETTINGS: 'vector:saveVectorSettings',
  GET_VECTOR_MAINTENANCE_STATS: 'vector:getVectorMaintenanceStats',
  GET_VECTOR_FAILURE_RETRY_CANDIDATES: 'vector:getVectorFailureRetryCandidates',
  CLEAR_VECTOR_DIAGNOSTICS: 'vector:clearVectorDiagnostics',
  CLEAR_VECTOR_FAILURES: 'vector:clearVectorFailures',
  COMPACT_VECTOR_JOBS: 'vector:compactVectorJobs',
  PREVIEW_STORAGE_CLEANUP: 'vector:previewStorageCleanup',
  START_STORAGE_CLEANUP: 'vector:startStorageCleanup',
  GET_STORAGE_CLEANUP_PROGRESS: 'vector:getStorageCleanupProgress',
  CANCEL_STORAGE_CLEANUP: 'vector:cancelStorageCleanup',
  PREVIEW_PROCESSED_IMAGE_DATA: 'vector:previewProcessedImageData',
  CLEAR_PROCESSED_IMAGE_DATA: 'vector:clearProcessedImageData',
  PREVIEW_VECTOR_GC: 'vector:previewVectorGc',
  START_VECTOR_GC: 'vector:startVectorGc',
  GET_VECTOR_GC_PROGRESS: 'vector:getVectorGcProgress',
  CANCEL_VECTOR_GC: 'vector:cancelVectorGc',
  PREVIEW_VECTOR_STORE_MIGRATION: 'vector:previewVectorStoreMigration',
  START_VECTOR_STORE_MIGRATION: 'vector:startVectorStoreMigration',
  GET_VECTOR_STORE_MIGRATION_PROGRESS: 'vector:getVectorStoreMigrationProgress',
  CANCEL_VECTOR_STORE_MIGRATION: 'vector:cancelVectorStoreMigration',
  ON_MODEL_STATUS_CHANGED: 'vector:onModelStatusChanged',
  ON_EMBEDDING_PROGRESS: 'vector:onEmbeddingProgress',
  ON_FEATURE_PROGRESS: 'vector:onFeatureProgress',
} as const

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
