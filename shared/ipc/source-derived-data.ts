export const SOURCE_DERIVED_DATA_IPC = {
  PREVIEW: 'sourceDerivedData:preview',
  EXECUTE: 'sourceDerivedData:execute',
  PROGRESS: 'sourceDerivedData:progress',
  SYNC_PREVIEW: 'sourceDerivedData:syncPreview',
  SYNC_EXECUTE: 'sourceDerivedData:syncExecute',
  SYNC_PROGRESS: 'sourceDerivedData:syncProgress',
} as const

export interface SourceFileSyncPreviewRequest {
  sourcePath: string
}

export interface SourceFileSyncPreview {
  ok: boolean
  token?: string
  sourcePath?: string
  createdAt?: number
  expiresAt?: number
  checkedImageRecords: number
  checkedVideoRecords: number
  missingImageRecords: number
  missingVideoRecords: number
  inaccessibleRecords: number
  staleIndexedSourceBytes: number
  originalFilesAffected: 0
  warnings: string[]
  error?: string
}

export interface SourceFileSyncResult {
  ok: boolean
  sourcePath?: string
  imageRecordsRemoved: number
  imageVectorRecordsRemoved: number
  videoRecordsMarkedMissing: number
  /** Unified discovery catalog rows hidden for the same proven-missing paths. */
  catalogRecordsMarkedMissing?: number
  recoveredBeforeApply: number
  thumbnailFilesRemoved: number
  freedBytes: number
  assetLibrarySyncStarted: boolean
  /** Present when the main process waited for the background asset sync terminal state. */
  assetLibrarySyncCompleted?: boolean
  assetLibraryTaskId?: string
  /** True when an error happened after at least one derived-data mutation committed. */
  partialCommit?: boolean
  originalFilesAffected: 0
  warnings: string[]
  error?: string
}

export interface SourceFileSyncProgress {
  state: 'idle' | 'checking' | 'ready' | 'applying' | 'completed' | 'error'
  phase?:
    | 'validating-source'
    | 'checking-records'
    | 'rechecking-records'
    | 'removing-index'
    | 'removing-thumbnails'
    | 'syncing-library'
  sourcePath?: string
  checkedRecords: number
  totalRecords: number
  changedRecords: number
  startedAt?: number
  updatedAt?: number
  finishedAt?: number
  error?: string
}

export type SourceDerivedDataCategoryId =
  | 'image-native-index'
  | 'image-model-vectors'
  | 'image-subject-vectors'
  | 'image-thumbnails-previews'
  | 'image-diagnostics'
  | 'video-catalog'
  | 'video-frames-thumbnails'
  | 'video-model-vectors'
  | 'video-transcripts-ocr'
  | 'video-semantics'
  | 'managed-automation-history'
  | 'shared-rebuildable-caches'

export type SourceDerivedDataHistoryPolicy = 'preserve-audit' | 'remove-source-traces'

export interface SourceDerivedDataCategory {
  id: SourceDerivedDataCategoryId
  recordCount: number
  fileCount: number
  estimatedBytes: number
  /** False when shared or structured bytes cannot be attributed exactly. */
  exactBytes: boolean
}

export interface SourceDerivedDataPreviewRequest {
  sourcePath: string
  /** Audit history is retained unless the user explicitly opts into scoped trace removal. */
  historyPolicy?: SourceDerivedDataHistoryPolicy
}

export interface SourceDerivedDataPreview {
  ok: boolean
  token?: string
  sourcePath?: string
  createdAt?: number
  expiresAt?: number
  categories: SourceDerivedDataCategory[]
  imageRecords: number
  videoRecords: number
  totalRecords: number
  fileCount: number
  estimatedBytes: number
  originalFilesAffected: 0
  historyPolicy?: SourceDerivedDataHistoryPolicy
  preservedAuditTraceRecords?: number
  preservedAuditTraceFiles?: number
  warnings: string[]
  error?: string
}

export interface SourceDerivedDataCleanupResult {
  ok: boolean
  partialCommit?: boolean
  sourcePath?: string
  imageRecordsRemoved: number
  videoRecordsRemoved: number
  automationHistoryRecordsRemoved?: number
  totalRecordsRemoved: number
  deletedFiles: number
  freedBytes: number
  originalFilesAffected: 0
  warnings: string[]
  error?: string
}

export interface SourceDerivedDataCleanupProgress {
  state: 'idle' | 'previewing' | 'ready' | 'deleting' | 'completed' | 'error'
  phase?:
    | 'images'
    | 'subject-vectors'
    | 'video-manifests'
    | 'video-vectors'
    | 'video-artifacts'
    | 'managed-history'
    | 'finalizing'
  sourcePath?: string
  processedBytes: number
  totalBytes: number
  removedRecords: number
  startedAt?: number
  updatedAt?: number
  finishedAt?: number
  error?: string
}

export interface SourceDerivedDataApi {
  preview(request: SourceDerivedDataPreviewRequest): Promise<SourceDerivedDataPreview>
  execute(token: string): Promise<SourceDerivedDataCleanupResult>
  progress(): Promise<SourceDerivedDataCleanupProgress>
  syncPreview(request: SourceFileSyncPreviewRequest): Promise<SourceFileSyncPreview>
  syncExecute(token: string): Promise<SourceFileSyncResult>
  syncProgress(): Promise<SourceFileSyncProgress>
}
