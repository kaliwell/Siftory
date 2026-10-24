// Phase 1 unified source & discovery catalog contracts.
// Design: docs/designs/2026-08-11-local-nas-ai-asset-discovery-architecture.md
// sections 6 (unified data source), 7 (data model), 9.3 (result contract),
// 12.1 (IPC domains). Storage authority: the Discovery Catalog SQLite is the
// authority for sources/file entries/scan sessions/index states; it never
// writes back into the native manifest, assets.jsonl, asset-library.sqlite or
// asset-catalog.sqlite (docs/reference/2026-08-11-storage-authority-boundaries.md).

export type SourceType =
  | 'local-ntfs'
  | 'local-generic'
  | 'removable'
  | 'mounted-network'
  | 'sftp'
  | 'nas-agent'

export type SourceAvailability = 'online' | 'offline' | 'degraded' | 'unknown'

export type SourceScanCapability = 'usn' | 'directory' | 'remote-list' | 'agent'

export interface DataSource {
  id: string
  type: SourceType
  displayName: string
  rootLocator: string
  readOnly: boolean
  availability: SourceAvailability
  scanCapability: SourceScanCapability
  lastAttemptAt?: number
  lastSuccessfulScanAt?: number
  lastCompleteReconcileAt?: number
}

export type FileEntryAvailability = 'online' | 'offline' | 'missing' | 'unknown'

export interface FileEntry {
  id: string
  sourceId: string
  relativePath: string
  name: string
  extension: string
  sizeBytes: number
  modifiedAt: number
  createdAt?: number
  filesystemIdentity?: string
  availability: FileEntryAvailability
  quickFingerprint?: string
  contentHash?: string
}

export type ScanSessionState = 'running' | 'cancelled' | 'completed' | 'error'

export type ScanBackend = 'usn' | 'directory' | 'remote-list' | 'unknown'

export interface ScanSession {
  id: string
  sourceId: string
  state: ScanSessionState
  backend: ScanBackend
  fallbackReason?: string
  fallbackCode?: string
  startedAt: number
  finishedAt?: number
  discoveredCount: number
  committedCount: number
  error?: string
}

// Phase 1 only writes the 'discovered' stage (D1). Later stages land with
// their respective phases; the full ladder is defined in design section 7.4.
export type IndexStage =
  | 'discovered'
  | 'metadata-ready'
  | 'preview-ready'
  | 'hash-ready'
  | 'image-embedding-ready'

export type IndexStageState = 'ready' | 'failed' | 'retryable' | 'stale'

export interface IndexState {
  fileEntryId: string
  stage: IndexStage
  state: IndexStageState
  updatedAt: number
}

// ── Source adapter contract (design 6.2) ─────────────────
// Implemented by main-process adapters. Local and mounted-network adapters
// are available; SFTP and nas-agent remain reserved until their secure
// locator/session wiring is implemented.

export interface SourceProbeResult {
  availability: SourceAvailability
  scanCapability: SourceScanCapability
  nativeConnected: boolean
  detail?: string
}

export interface DiscoveredEntry {
  absolutePath: string
  relativePath: string
  name: string
  extension: string
  sizeBytes: number
  modifiedAt: number
  filesystemIdentity?: string
}

export interface DiscoveryBatchProgress {
  discoveredCount: number
  backend: ScanBackend
  fallbackReason?: string
  fallbackCode?: string
  currentPath?: string
}

export interface DiscoveryBatch {
  entries: DiscoveredEntry[]
  progress: DiscoveryBatchProgress
  final: boolean
}

export interface EnumerateRequest {
  source: DataSource
  signal: AbortSignal
  scanMode?: 'addNew' | 'update' | 'updateAll' | 'full'
}

export interface SourceAdapter {
  probe(source: DataSource): Promise<SourceProbeResult>
  enumerate(request: EnumerateRequest): AsyncIterable<DiscoveryBatch>
}

// ── IPC DTOs (design 9.3 / 12.1) ─────────────────────────

export interface DiscoverySourceListItem extends DataSource {
  displayLocator?: string
  fileCount: number
  totalBytes: number
  lastScanState?: ScanSessionState
  lastScanBackend?: ScanBackend
  lastScanFallbackReason?: string
  incrementalWatch?: DiscoveryIncrementalWatchStatus
}

export type DiscoveryIncrementalWatchState = 'watching' | 'paused-offline' | 'unsupported' | 'error'

export interface DiscoveryIncrementalWatchStatus {
  state: DiscoveryIncrementalWatchState
  pendingCount: number
  lastEventAt?: number
  lastAppliedAt?: number
  lastError?: string
}

export interface DiscoveryAddSourceRequest {
  type: SourceType
  displayName: string
  rootLocator: string
  readOnly?: boolean
  sftpProfileId?: string
  sftpRemoteRoot?: string
}

export interface DiscoveryAddSourceResult {
  ok: boolean
  source?: DataSource
  error?: string
}

export interface DiscoveryRepairSourceRootResult {
  ok: boolean
  source?: DataSource
  repairedEntries?: number
  error?: string
}

export interface DiscoveryProbeResult extends SourceProbeResult {
  ok: boolean
  error?: string
}

export interface DiscoveryScanStartResult {
  ok: boolean
  session?: ScanSession
  error?: string
}

export interface DiscoveryScanStatus {
  sourceId: string
  running: boolean
  session: ScanSession | null
}

export type DiscoveryCatalogQuerySort = 'name_asc' | 'size_desc' | 'recent'

export interface DiscoveryCatalogQueryRequest {
  query?: string
  sourceId?: string
  sourceIds?: string[]
  mediaTypes?: Array<'image' | 'video' | 'audio' | 'file'>
  modifiedAfter?: number
  modifiedBefore?: number
  offset?: number
  limit?: number
  sort?: DiscoveryCatalogQuerySort
}

// Result item mirrors the stable UnifiedAssetSearchResult subset. Remote
// actions exchange fileEntryId for a short-lived main-process token; tokens
// are deliberately never embedded in reusable search responses.
export interface DiscoveryCatalogResultItem {
  fileEntryId: string
  displayName: string
  displayPath: string
  /** Main-process-only path alias used to join derived recall with an authoritative item. */
  recallPath?: string
  sizeBytes: number
  modifiedAt: number
  source: {
    id: string
    name: string
    type: SourceType
    availability: SourceAvailability
  }
  indexState: string[]
}

export interface DiscoveryCatalogQueryResponse {
  items: DiscoveryCatalogResultItem[]
  total: number
}

export interface DiscoveryCatalogStats {
  sourceCount: number
  fileCount: number
  totalBytes: number
  sessionCount: number
  lastScanAt?: number
}

export interface DiscoveryRemoteDownloadGrant {
  ok: boolean
  token?: string
  displayName?: string
  totalBytes?: number
  error?: string
}

export interface DiscoveryRemoteVideoPrepareResult {
  ok: boolean
  videoId?: string
  timestampMs?: number
  cached?: boolean
  transferredBytes?: number
  speedBytesPerSecond?: number
  error?: string
}

export interface DiscoveryRemotePreviewResult {
  ok: boolean
  fileEntryId: string
  dataUrl?: string
  status: 'metadata-only' | 'preview-ready'
  cached?: boolean
  error?: string
}

export const DISCOVERY_CATALOG_IPC = {
  LIST_SOURCES: 'sources:list',
  ADD_SOURCE: 'sources:add',
  REMOVE_SOURCE: 'sources:remove',
  REPAIR_SOURCE_ROOT: 'sources:repairRoot',
  PROBE_SOURCE: 'sources:probe',
  SCAN_START: 'sources:scan/start',
  SCAN_CANCEL: 'sources:scan/cancel',
  SCAN_STATUS: 'sources:scan/status',
  SCAN_STATUS_EVENT: 'sources:scan/statusChanged',
  CATALOG_QUERY: 'catalog:query',
  CATALOG_STATS: 'catalog:stats',
  REMOTE_DOWNLOAD_GRANT: 'catalog:remoteDownload/create',
  REMOTE_VIDEO_PREPARE: 'catalog:remoteVideo/prepare',
  REMOTE_PREVIEW_GET: 'catalog:remotePreview/get',
} as const
