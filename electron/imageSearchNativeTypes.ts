// ── ImageSearch native addon surface ─────────────────────
// Type declarations for the C++ fast_scanner addon boundary, split out of
// imageSearchService.ts (VAL-033) so the hottest main-process module keeps
// only behavior. Pure type motion — no runtime change.

import type { ImageHashResult } from '../shared/ipc-contract'

export interface ImageSearchDataRecord {
  path: string
  width: number
  height: number
  fileSize: number
  modifiedTime: number
  exists: boolean
}

export interface NativeIndexExport {
  ok: boolean
  cursor?: string
  recordCount?: number
  scanned?: number
  error?: string
}

export interface NativeBatchDeleteResult {
  ok: boolean
  removedCount?: number
  removedPaths?: string[]
  cursor?: string
  missingCount?: number
  remainingCount?: number
  error?: string
}

export interface NativeScanProgress {
  state: string
  generation?: number
  cancelled?: boolean
  indexedCount: number
  failedCount: number
  totalBytes: number
  currentPath: string
  error?: string
  /** Native getScanProgress reports terminal scan failures under this field. */
  lastError?: string
  lastWarning?: string
  newCount?: number
  skippedCount?: number
  signatureRejectedCount?: number
  skippedIndexed?: number
  skippedUnchanged?: number
  updatedCount?: number
  warningCount?: number
  durationMs?: number
  detailedMetricsEnabled?: boolean
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
}

export interface NativeSearchHit {
  id: number
  path: string
  score: number
  distance: number
  width: number
  height: number
  fileSize: number
  diffHash64: string
  dctHash64?: string
  dctDistance?: number
}

export interface NativeSearchResult {
  ok: boolean
  results: NativeSearchHit[]
  resultCount: number
  queryHash?: string
  queryDctHash64?: string
  scannedCount?: number
  candidateCount?: number
  searchMs?: number
  mode?: string
  indexType?: string
  bucketSize?: number
  fallbackUsed?: boolean
  error?: string
}

export interface NativeAddon {
  getNativeVersion(): string
  getNativeStatus(): {
    connected: boolean
    version: string
    features: string[]
    asyncWorkActiveCount?: number
    asyncWorkRunningCount?: number
    asyncWorkCancellableCount?: number
    asyncWorkPreCommitCount?: number
    asyncWorkClosing?: boolean
    asyncWorkCancelAccepted?: number
    asyncWorkMode?: string
    asyncWorkCancellationMode?: string
  }
  cancelAsyncWork?(): {
    ok: boolean
    cooperativeRequested: number
    nativeCancelAccepted: number
  }
  hashImage(filePath: string): ImageHashResult
  scanDirectory(
    dirPath: string,
    scanMode?: string,
  ): { ok: boolean; generation?: number; error?: string }
  configureScanThumbnails?(
    cacheDir: string,
    enabled: boolean,
    cacheVersion: number,
  ): { ok: boolean; enabled?: boolean; error?: string }
  configureScanCommitFeed?(
    enabled: boolean,
    maxEntries: number,
  ): { ok: boolean; enabled?: boolean; maxEntries?: number; error?: string }
  drainScanCommittedPaths?(limit: number): {
    ok: boolean
    paths?: string[]
    generation?: number
    pending?: number
    dropped?: number
    enabled?: boolean
    error?: string
  }
  startNativeThumbnailRebuild?(
    roots: string,
    cacheDir: string,
    cacheVersion: number,
    workers: number,
    requestCuda: boolean,
  ): { ok: boolean; error?: string }
  getNativeThumbnailRebuildProgress?(): {
    state: 'idle' | 'running' | 'stopping' | 'done' | 'error'
    total: number
    completed: number
    failed: number
    skipped: number
    pending: number
    workers: number
    startedAt: number
    finishedAt: number
    cudaRequested: boolean
    cudaAvailable: boolean
    effectiveBackend: 'native-cpp' | 'cuda'
    cudaError?: string
    currentPath?: string
    error?: string
  }
  stopNativeThumbnailRebuild?(): { ok: boolean }
  getScanProgress(): NativeScanProgress
  stopScan(): { ok: boolean; error?: string }
  stopScanAsync?(): Promise<{ ok: boolean; error?: string }>
  stopScanGenerationAsync?(
    generation: number,
  ): Promise<{ ok: boolean; matched?: boolean; error?: string }>
  pauseScan?(): { ok: boolean; error?: string }
  resumeScan?(): { ok: boolean; error?: string }
  isScanPaused?(): { paused: boolean }
  getIndexStats(): {
    indexedCount: number
    failedCount: number
    totalBytes: number
    lastIndexedPath: string
  }
  clearIndex(): { ok: boolean; error?: string }
  queryIndexRecords(
    query: string,
    offset: number,
    limit: number,
  ): {
    ok: boolean
    records?: ImageSearchDataRecord[]
    offset?: number
    hasMore?: boolean
    scanned?: number
    error?: string
  }
  snapshotIndexRecords?(): {
    ok: boolean
    records?: Array<Omit<ImageSearchDataRecord, 'exists'> & { exists?: boolean }>
    recordCount?: number
    scanned?: number
    error?: string
  }
  snapshotIndexRecordsAsync?(): Promise<NativeIndexExport>
  snapshotScanRecordsAsync?(
    generation: number,
  ): Promise<NativeIndexExport & { generation?: number }>
  readScanExportPage?(
    cursor: string,
    generation: number,
    offset: number,
    limit?: number,
  ): {
    ok: boolean
    generation?: number
    records?: Array<Pick<ImageSearchDataRecord, 'path' | 'fileSize' | 'modifiedTime'>>
    nextOffset?: number
    hasMore?: boolean
    error?: string
  }
  readIndexExportPage?(
    cursor: string,
    offset: number,
    limit?: number,
  ): {
    ok: boolean
    records?: Array<Omit<ImageSearchDataRecord, 'exists'> & { exists?: boolean }>
    removedPaths?: string[]
    nextOffset?: number
    hasMore?: boolean
    error?: string
  }
  closeIndexExport?(cursor: string): Promise<{ ok: boolean }>
  deleteIndexPathsPagedAsync?(filePaths: string[]): Promise<NativeBatchDeleteResult>
  hasIndexPath(filePath: string): boolean
  deleteIndexPath(filePath: string): { ok: boolean; path?: string; error?: string }
  deleteIndexPaths?(filePaths: string[]): NativeBatchDeleteResult
  deleteIndexPathsAsync?(filePaths: string[]): Promise<NativeBatchDeleteResult>
  purgeIndexPathPrefix?(prefix: string): {
    ok: boolean
    removedCount?: number
    error?: string
  }
  getIndexPathStats?(prefix: string): {
    ok: boolean
    count?: number
    totalBytes?: number
    error?: string
  }
  getIndexPathSegmentStats?(name: string): {
    ok: boolean
    count?: number
    totalBytes?: number
    error?: string
  }
  purgeIndexPathSegment?(name: string): {
    ok: boolean
    removedCount?: number
    error?: string
  }
  repairIndexPath(
    oldPath: string,
    newPath: string,
  ): { ok: boolean; oldPath?: string; newPath?: string; error?: string }
  upsertIndexRecord(
    filePath: string,
    width: number,
    height: number,
    fileSize: number,
    modifiedTime: number,
    diffHash64: string,
    dctHash64: string,
  ): { ok: boolean; path?: string; error?: string }
  searchByHash(
    hashHex: string,
    threshold: number,
    topK: number,
    searchMode?: string,
  ): NativeSearchResult
  searchByImage(
    filePath: string,
    threshold: number,
    topK: number,
    searchMode?: string,
  ): NativeSearchResult
  saveIndexToSegment(filePath: string): { ok: boolean; recordCount: number; error?: string }
  loadIndexFromSegment(filePath: string): { ok: boolean; recordCount: number; error?: string }
  getIndexMode(): {
    mode: string
    recordCount: number
    segmentPath: string
    manifestPath?: string
    version: number
    pathIndexMapSize?: number
    overlayCount?: number
    replacedCount?: number
    deletedCount?: number
    pathMapHealthy?: boolean
    segmentCount?: number
  }
  isIndexDirty(): {
    dirty: boolean
    memoryRecords: number
    overlayRecords: number
    replacedCount: number
    deletedCount: number
  }
  saveIndexToManifest(rootDir: string): { ok: boolean; recordCount: number; error?: string }
  loadManifest(rootDir: string): {
    ok: boolean
    recordCount: number
    segmentCount: number
    error?: string
  }
  repairManifestFromSegments(rootDir: string): {
    ok: boolean
    recordCount: number
    segmentCount: number
    error?: string
  }
  // Async (Promise-based) variants
  loadManifestAsync(
    rootDir: string,
    excludedPathPrefix?: string,
  ): Promise<{
    ok: boolean
    recordCount: number
    segmentCount: number
    removedCount?: number
    error?: string
  }>
  saveIndexToManifestAsync(rootDir: string): Promise<{
    ok: boolean
    recordCount: number
    overlayRecords: number
    error?: string
  }>
  hashImageAsync(filePath: string): Promise<ImageHashResult>
  compactManifestAsync(rootDir: string): Promise<{
    ok: boolean
    recordCount: number
    beforeSegments: number
    removedSegments?: number
    physicalCleanupComplete?: boolean
    cleanupError?: string
    error?: string
  }>
  searchByImageAsync(
    filePath: string,
    threshold: number,
    topK: number,
    searchMode?: string,
  ): Promise<NativeSearchResult>
  getCompactStatus(): { ok: boolean; segmentCount: number; compactRecommended: boolean }
}
