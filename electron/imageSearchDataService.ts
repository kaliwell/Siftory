import fs from 'fs'
import path from 'path'
import {
  appendGlobalEmbeddingInvalidationTombstonesAsync,
  flushVectorDatabaseWrites,
  GlobalEmbeddingInvalidationError,
  removeImageData,
  removeImageDataBatch,
} from './vectorDatabaseService'
import {
  collectProjectIndexedPaths,
  collectProjectThumbnailSources,
  getProjectSearchEntriesInFolder,
  getProjectSearchMetadata,
  mapProjectSearchIndexRecords,
  prepareProjectSearchInput,
  resolveProjectSearchInputPath,
} from './projectSearchIndexService'
import type {
  ImageSearchDataRecord,
  NativeAddon,
  NativeBatchDeleteResult,
} from './imageSearchNativeTypes'
import {
  isImageDataQueryPathWithin,
  normalizedImageDataQueryPrefix,
} from './imageSearchDataPathUtils'
import {
  prepareSourceVectorInvalidationIntent,
  reconcileSourceVectorInvalidationOutbox,
  resolveSourceVectorInvalidationIndexIdentity,
  type SourceVectorInvalidationEntryInput,
  type SourceVectorInvalidationIndexIdentity,
} from './sourceVectorInvalidationOutbox'
import {
  tryAcquireVectorMutationReservation,
  type VectorExclusiveMaintenanceLease,
} from './vectorMaintenanceService'

export type ImageSearchIndexIdentitySnapshot = SourceVectorInvalidationIndexIdentity

export interface ImageSearchDataEditResult {
  ok: boolean
  recordCount?: number
  removedCount?: number
  error?: string
}

export interface ImageSearchFolderDeleteOptions {
  /** Source deletion requires physical removal, not only persisted tombstones. */
  compactAfterDelete?: boolean
}

export interface ImageSearchBatchDeleteOptions {
  /** Caller already durably staged the source-vector write-ahead intent. */
  sourceVectorIntentPrepared?: boolean
  /** Active exclusive lease held by the source-sync transaction. */
  vectorMaintenanceLease?: VectorExclusiveMaintenanceLease
}

export interface ImageSearchDataSnapshotRecord extends Omit<ImageSearchDataRecord, 'exists'> {
  /** Undefined means the fast immutable index snapshot did not stat the source file. */
  exists?: boolean
}

export interface ImageSearchDataServiceContext {
  getNativeAddon(): NativeAddon | null
  getDefaultSavePath(): string
  getDefaultVectorDatabasePath(): string
  getSegmentPath(): string | undefined
  invalidateIndexModeCache(): void
  setEditPersistRetryPending(pending: boolean): void
  recordPersistedIndex(rootDir: string, recordCount: number): void
}

export interface ImageSearchDataDeletePathsResult {
  ok: boolean
  removedCount: number
  vectorRecordsRemoved: number
  warnings: string[]
  error?: string
}

export interface ImageSearchSourceVectorReconcileResult {
  ok: boolean
  vectorRecordsRemoved: number
  pendingIntents: number
  activePendingIntents: number
  deferredIntents: number
  error?: string
}

const MAX_LEGACY_BATCH_DELETE_PATHS = 64
const SOURCE_VECTOR_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const

/**
 * Owns Native index inspection and edits. All process state is supplied through
 * this narrow context so this module never imports the main Image Search service
 * and cannot create an initialization cycle.
 */
export function createImageSearchDataService(context: ImageSearchDataServiceContext) {
  const getAddon = (): NativeAddon | null => context.getNativeAddon()
  let loadedIndexIdentity: SourceVectorInvalidationIndexIdentity | null = null
  let identityCaptureGeneration = 0
  let sourceVectorRetryTimer: NodeJS.Timeout | null = null
  let sourceVectorRetryAttempt = 0

  function currentIndexRoot(): string {
    const mode = getAddon()?.getIndexMode()
    return (
      mode?.manifestPath ||
      context.getSegmentPath() ||
      mode?.segmentPath ||
      context.getDefaultSavePath() ||
      path.join(process.env.APPDATA || '', 'floating-clock-electron', 'image-search-index')
    )
  }

  function clearLoadedIndexIdentity(): void {
    identityCaptureGeneration += 1
    loadedIndexIdentity = null
    if (sourceVectorRetryTimer) clearTimeout(sourceVectorRetryTimer)
    sourceVectorRetryTimer = null
    sourceVectorRetryAttempt = 0
  }

  function sameIndexIdentity(
    left: SourceVectorInvalidationIndexIdentity,
    right: SourceVectorInvalidationIndexIdentity,
  ): boolean {
    return (
      left.canonicalRoot === right.canonicalRoot &&
      left.realPath === right.realPath &&
      left.dev === right.dev &&
      left.ino === right.ino
    )
  }

  function resolveIndexIdentity(rootDir: string): Promise<ImageSearchIndexIdentitySnapshot> {
    return resolveSourceVectorInvalidationIndexIdentity(rootDir)
  }

  async function captureLoadedIndexIdentity(
    rootDir: string,
    expectedIdentity?: ImageSearchIndexIdentitySnapshot,
  ): Promise<void> {
    const generation = ++identityCaptureGeneration
    loadedIndexIdentity = null
    const identity = await resolveIndexIdentity(rootDir)
    if (generation !== identityCaptureGeneration) {
      throw new Error('Image index identity capture was superseded by a newer index load')
    }
    if (expectedIdentity && !sameIndexIdentity(expectedIdentity, identity)) {
      throw new Error('Image index directory changed while the Native index was loading or saving')
    }
    loadedIndexIdentity = identity
    sourceVectorRetryAttempt = 0
  }

  function currentLoadedIndexIdentity(): SourceVectorInvalidationIndexIdentity | null {
    const identity = loadedIndexIdentity
    if (!identity) return null
    let canonicalRoot = path.normalize(path.resolve(currentIndexRoot()))
    if (canonicalRoot !== path.parse(canonicalRoot).root) {
      canonicalRoot = canonicalRoot.replace(/[\\/]+$/, '')
    }
    if (process.platform === 'win32') canonicalRoot = canonicalRoot.toLowerCase()
    return canonicalRoot === identity.canonicalRoot ? identity : null
  }

  async function capturePersistedIndexIdentity(
    rootDir: string,
    expectedIdentity: ImageSearchIndexIdentitySnapshot,
  ): Promise<ImageSearchDataEditResult> {
    try {
      await captureLoadedIndexIdentity(rootDir, expectedIdentity)
      return { ok: true }
    } catch (error) {
      context.setEditPersistRetryPending(true)
      return {
        ok: false,
        error: `Image index was saved, but its recovery identity could not be captured: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
  }

  // Uses the same visibility rules as the Native save snapshot.
  function isImageIndexEffectivelyEmpty(): boolean {
    const addon = getAddon()
    if (!addon || typeof addon.getIndexPathStats !== 'function') return false
    const stats = addon.getIndexPathStats('')
    return Boolean(stats?.ok) && (Number(stats.count) || 0) === 0
  }

  // Native refuses a normal full-save for an empty index. Commit an explicit
  // empty v2 manifest so deleted records cannot revive after restart.
  function persistEmptyImageIndex(rootDir: string): ImageSearchDataEditResult {
    try {
      fs.mkdirSync(rootDir, { recursive: true })
      const now = new Date().toISOString()
      const manifest = JSON.stringify({
        schemaVersion: 2,
        createdAt: now,
        updatedAt: now,
        segments: [],
        overlay: { replacedCount: 0, deletedCount: 0 },
      })
      const tmpPath = path.join(rootDir, 'manifest.tmp')
      fs.writeFileSync(tmpPath, manifest)
      fs.renameSync(tmpPath, path.join(rootDir, 'manifest.json'))
      for (const subdir of ['segments', 'staging']) {
        const dir = path.join(rootDir, subdir)
        if (!fs.existsSync(dir)) continue
        for (const entry of fs.readdirSync(dir)) {
          if (!entry.endsWith('.idx') && !entry.endsWith('.tmp')) continue
          try {
            fs.rmSync(path.join(dir, entry), { force: true })
          } catch {
            // A mapped segment can stay locked, but the manifest no longer references it.
          }
        }
      }
      try {
        fs.rmSync(path.join(rootDir, 'overlay.json'), { force: true })
      } catch {
        // Best-effort cleanup after the authoritative manifest commit.
      }
      context.invalidateIndexModeCache()
      context.recordPersistedIndex(rootDir, 0)
      context.setEditPersistRetryPending(false)
      return { ok: true, recordCount: 0 }
    } catch (error) {
      context.setEditPersistRetryPending(true)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async function persistEmptyImageIndexAndCapture(
    rootDir: string,
  ): Promise<ImageSearchDataEditResult> {
    let expectedIdentity: ImageSearchIndexIdentitySnapshot
    try {
      fs.mkdirSync(rootDir, { recursive: true })
      expectedIdentity = await resolveIndexIdentity(rootDir)
    } catch (error) {
      context.setEditPersistRetryPending(true)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const persisted = persistEmptyImageIndex(rootDir)
    if (!persisted.ok) return persisted
    const captured = await capturePersistedIndexIdentity(rootDir, expectedIdentity)
    return captured.ok ? persisted : captured
  }

  async function persistImageIndexEdits(
    knownRemainingCount?: number,
  ): Promise<ImageSearchDataEditResult> {
    const addon = getAddon()
    if (!addon) return { ok: false, error: 'Native addon not connected' }
    const rootDir = currentIndexRoot()
    let expectedIdentity: ImageSearchIndexIdentitySnapshot
    try {
      fs.mkdirSync(rootDir, { recursive: true })
      expectedIdentity = await resolveIndexIdentity(rootDir)
    } catch (error) {
      context.setEditPersistRetryPending(true)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const effectivelyEmpty =
      knownRemainingCount === undefined ? isImageIndexEffectivelyEmpty() : knownRemainingCount === 0
    if (effectivelyEmpty) {
      const cleared = addon.clearIndex()
      if (!cleared?.ok) {
        return { ok: false, error: cleared?.error || 'Could not release the empty Native index' }
      }
      return persistEmptyImageIndexAndCapture(rootDir)
    }

    let saved: { ok: boolean; recordCount?: number; error?: string }
    try {
      saved = await addon.saveIndexToManifestAsync(rootDir)
    } catch (error) {
      saved = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!saved?.ok) {
      const message = saved?.error || 'Failed to save edited index'
      if (
        message === 'No records to save' &&
        (knownRemainingCount === 0 || isImageIndexEffectivelyEmpty())
      ) {
        return persistEmptyImageIndexAndCapture(rootDir)
      }
      context.setEditPersistRetryPending(true)
      return {
        ok: false,
        error: `${message} (edit applied in memory; will retry saving automatically)`,
      }
    }

    const recordCount = knownRemainingCount ?? saved.recordCount ?? 0
    const captured = await capturePersistedIndexIdentity(rootDir, expectedIdentity)
    if (!captured.ok) return captured
    context.invalidateIndexModeCache()
    context.recordPersistedIndex(rootDir, recordCount)
    context.setEditPersistRetryPending(false)
    return { ok: true, recordCount }
  }

  function queryImageSearchData(
    query: string,
    offset = 0,
    limit = 50,
  ): {
    ok: boolean
    records?: ImageSearchDataRecord[]
    offset?: number
    hasMore?: boolean
    scanned?: number
    error?: string
  } {
    const addon = getAddon()
    if (!addon) return { ok: false, error: 'Native addon not connected' }
    const response = addon.queryIndexRecords(String(query || ''), offset, limit)
    if (!response.ok || !response.records) return response
    const prefix = normalizedImageDataQueryPrefix(query)
    const records = prefix
      ? response.records.filter((record) => isImageDataQueryPathWithin(record.path, prefix))
      : response.records
    return { ...response, records: mapProjectSearchIndexRecords(records) }
  }

  async function snapshotImageSearchData(
    isCancelled?: () => boolean,
    mapProjects = true,
  ): Promise<{
    ok: boolean
    records?: ImageSearchDataSnapshotRecord[]
    recordCount?: number
    scanned?: number
    error?: string
  }> {
    const addon = getAddon()
    if (!addon) return { ok: false, error: 'Native addon not connected' }
    if (isCancelled?.()) return { ok: false, error: 'Index snapshot cancelled' }
    if (!addon.snapshotIndexRecordsAsync || !addon.readIndexExportPage || !addon.closeIndexExport) {
      // Older binaries must never silently run a full large snapshot on the main thread.
      if (!addon.snapshotIndexRecords || addon.getIndexMode().recordCount > 256) {
        return { ok: false, error: 'Update the Native scanner to read a large index safely' }
      }
      const response = addon.snapshotIndexRecords()
      if (!response.ok || !response.records) return response
      const records = mapProjects
        ? mapProjectSearchIndexRecords(response.records)
        : response.records
      return { ...response, records, recordCount: records.length }
    }
    let cursor: string | undefined
    try {
      const snapshot = await addon.snapshotIndexRecordsAsync()
      cursor = snapshot.cursor
      if (!snapshot.ok || !cursor) throw new Error(snapshot.error || 'Native index export failed')
      const records: ImageSearchDataSnapshotRecord[] = []
      let offset = 0
      do {
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (isCancelled?.()) throw new Error('Index snapshot cancelled')
        const page = addon.readIndexExportPage(cursor, offset, 256)
        if (!page.ok || !page.records || page.nextOffset !== offset + page.records.length) {
          throw new Error(page.error || 'Invalid Native index export page')
        }
        records.push(...(mapProjects ? mapProjectSearchIndexRecords(page.records) : page.records))
        offset = page.nextOffset
        if (!page.hasMore) break
        if (!page.records.length) throw new Error('Native index export made no progress')
      } while (offset < Number(snapshot.recordCount))
      if (offset !== snapshot.recordCount) throw new Error('Native index export count changed')
      return { ok: true, records, recordCount: records.length, scanned: snapshot.scanned }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (cursor) await addon.closeIndexExport(cursor)
    }
  }

  function getImageSearchCatalogRevision(): string {
    const addon = getAddon()
    if (!addon) return JSON.stringify({ connected: false })
    const mode = addon.getIndexMode()
    const dirty = addon.isIndexDirty()
    const manifestPath =
      mode.manifestPath ||
      path.join(context.getDefaultSavePath() || mode.segmentPath || '', 'manifest.json')
    let manifest: { size: number; mtimeMs: number } | null = null
    try {
      const stat = fs.statSync(manifestPath)
      if (stat.isFile()) manifest = { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      // In-memory-only indexes are represented by the mode and dirty fields.
    }
    return JSON.stringify({
      connected: true,
      mode: mode.mode,
      recordCount: mode.recordCount,
      version: mode.version,
      segmentPath: mode.segmentPath,
      manifestPath: mode.manifestPath,
      pathIndexMapSize: mode.pathIndexMapSize,
      overlayCount: mode.overlayCount,
      replacedCount: mode.replacedCount,
      deletedCount: mode.deletedCount,
      segmentCount: mode.segmentCount,
      dirty,
      manifest,
    })
  }

  function isImageSearchIndexedPath(filePath: string): boolean {
    const addon = getAddon()
    if (!addon || typeof addon.hasIndexPath !== 'function') return true
    return addon.hasIndexPath(resolveProjectSearchInputPath(filePath))
  }

  async function listImageSearchIndexedPaths(): Promise<string[]> {
    const response = await snapshotImageSearchData(undefined, false)
    if (!response.ok || !Array.isArray(response.records)) {
      throw new Error(response.error || 'Could not read the active image index')
    }
    return collectProjectIndexedPaths(response.records)
  }

  async function listImageSearchIndexedThumbnailSources(folder: string): Promise<
    Array<{
      path: string
      mtimeMs: number
    }>
  > {
    const response = await snapshotImageSearchData(undefined, false)
    if (!response.ok || !Array.isArray(response.records)) {
      throw new Error(response.error || 'Could not read the active image index')
    }
    return collectProjectThumbnailSources(folder, response.records)
  }

  function getImageSearchDataStats(prefix: string): {
    ok: boolean
    count?: number
    totalBytes?: number
    error?: string
  } {
    const addon = getAddon()
    if (!addon) return { ok: false, error: 'Native addon not connected' }
    if (typeof addon.getIndexPathStats !== 'function') {
      return { ok: false, error: 'Native addon does not support path stats' }
    }
    const stats = addon.getIndexPathStats(String(prefix || ''))
    if (!stats.ok) return { ok: false, error: stats.error || 'Path stats failed' }
    return { ok: true, count: Number(stats.count) || 0, totalBytes: Number(stats.totalBytes) || 0 }
  }

  // Mirrors native normalize_segment_name.
  function normalizeDirNameArg(name: string): string | null {
    const normalized = String(name || '')
      .trim()
      .replace(/\/+/g, '\\')
      .toLowerCase()
    if (normalized.length < 2 || normalized.includes('\\')) return null
    return normalized
  }

  function getImageSearchDirNameStats(name: string): {
    ok: boolean
    count?: number
    totalBytes?: number
    error?: string
  } {
    const addon = getAddon()
    if (!addon) return { ok: false, error: 'Native addon not connected' }
    if (typeof addon.getIndexPathSegmentStats !== 'function') {
      return { ok: false, error: 'Native addon does not support directory-name stats' }
    }
    const normalized = normalizeDirNameArg(name)
    if (!normalized) return { ok: false, error: 'Invalid directory name' }
    const stats = addon.getIndexPathSegmentStats(normalized)
    if (!stats.ok) return { ok: false, error: stats.error || 'Directory-name stats failed' }
    return { ok: true, count: Number(stats.count) || 0, totalBytes: Number(stats.totalBytes) || 0 }
  }

  function sourceVectorPathKey(filePath: string): string {
    const normalized = String(filePath || '')
      .replace(/\//g, '\\')
      .replace(/\\+$/, '')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }

  function sourceVectorInvalidationEntries(
    sourcePaths: readonly string[],
  ): SourceVectorInvalidationEntryInput[] {
    return sourcePaths.map((sourcePath) => {
      const nativePath = resolveProjectSearchInputPath(sourcePath)
      const vectorPaths = [
        ...new Map(
          [sourcePath, nativePath].map((vectorPath) => [
            sourceVectorPathKey(vectorPath),
            vectorPath,
          ]),
        ).values(),
      ]
      return { nativePath, vectorPaths }
    })
  }

  async function prepareImageSearchSourceVectorInvalidation(
    sourcePaths: readonly string[],
  ): Promise<void> {
    if (sourcePaths.length === 0) return
    const vectorDbDir = context.getDefaultVectorDatabasePath()
    if (!vectorDbDir) {
      throw new Error('Vector database path is unavailable for source synchronization recovery')
    }
    const indexIdentity = currentLoadedIndexIdentity()
    if (!indexIdentity) {
      throw new Error(
        'Loaded image index identity is unavailable for source synchronization recovery',
      )
    }
    await prepareSourceVectorInvalidationIntent({
      vectorDbDir,
      indexIdentity,
      entries: sourceVectorInvalidationEntries(sourcePaths),
      layers: ['dino', 'clip'],
    })
  }

  async function reconcileImageSearchSourceVectorInvalidations(): Promise<ImageSearchSourceVectorReconcileResult> {
    const vectorDbDir = context.getDefaultVectorDatabasePath()
    if (!vectorDbDir) {
      return {
        ok: false,
        vectorRecordsRemoved: 0,
        pendingIntents: 0,
        activePendingIntents: 1,
        deferredIntents: 0,
        error: 'Vector database path is unavailable for source synchronization recovery',
      }
    }
    const indexIdentity = currentLoadedIndexIdentity()
    if (!indexIdentity) {
      return {
        ok: false,
        vectorRecordsRemoved: 0,
        pendingIntents: 0,
        activePendingIntents: 0,
        deferredIntents: 0,
        error: 'Loaded image index identity is unavailable for source synchronization recovery',
      }
    }
    const addon = getAddon()
    if (!addon || typeof addon.hasIndexPath !== 'function') {
      return {
        ok: false,
        vectorRecordsRemoved: 0,
        pendingIntents: 0,
        activePendingIntents: 1,
        deferredIntents: 0,
        error: 'Native index path lookup is unavailable for source synchronization recovery',
      }
    }

    let vectorRecordsRemoved = 0
    try {
      const reconciled = await reconcileSourceVectorInvalidationOutbox({
        vectorDbDir,
        indexIdentity,
        hasIndexPath: (nativePath) => addon.hasIndexPath!(nativePath),
        invalidatePaths: async (vectorPaths, layers) => {
          vectorRecordsRemoved += removeImageDataBatch(vectorPaths)
          let appendError: unknown
          try {
            const invalidated = await appendGlobalEmbeddingInvalidationTombstonesAsync(
              vectorPaths,
              layers,
            )
            vectorRecordsRemoved += invalidated.appendedRows
          } catch (error) {
            if (error instanceof GlobalEmbeddingInvalidationError) {
              vectorRecordsRemoved += error.result.appendedRows
            }
            appendError = error
          }
          let flushError: unknown
          try {
            await flushVectorDatabaseWrites()
          } catch (error) {
            flushError = error
          }
          if (appendError || flushError) {
            throw new Error(
              [appendError, flushError]
                .filter(Boolean)
                .map((error) => (error instanceof Error ? error.message : String(error)))
                .join('; '),
            )
          }
        },
      })
      const ok = reconciled.activePendingIntents === 0 && reconciled.errors.length === 0
      updateSourceVectorRetry(reconciled.activePendingIntents)
      return {
        ok,
        vectorRecordsRemoved,
        pendingIntents: reconciled.pendingIntents,
        activePendingIntents: reconciled.activePendingIntents,
        deferredIntents: reconciled.deferredIntents,
        ...(ok
          ? {}
          : {
              error:
                reconciled.errors[0] ||
                `${reconciled.activePendingIntents} active source-vector invalidation intent(s) remain pending`,
            }),
      }
    } catch (error) {
      updateSourceVectorRetry(1)
      return {
        ok: false,
        vectorRecordsRemoved,
        pendingIntents: 1,
        activePendingIntents: 1,
        deferredIntents: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  function updateSourceVectorRetry(activePendingIntents: number): void {
    if (activePendingIntents <= 0) {
      if (sourceVectorRetryTimer) clearTimeout(sourceVectorRetryTimer)
      sourceVectorRetryTimer = null
      sourceVectorRetryAttempt = 0
      return
    }
    if (
      sourceVectorRetryTimer ||
      sourceVectorRetryAttempt >= SOURCE_VECTOR_RETRY_DELAYS_MS.length ||
      !currentLoadedIndexIdentity()
    ) {
      return
    }
    const generation = identityCaptureGeneration
    const delay = SOURCE_VECTOR_RETRY_DELAYS_MS[sourceVectorRetryAttempt]
    sourceVectorRetryTimer = setTimeout(() => {
      sourceVectorRetryTimer = null
      sourceVectorRetryAttempt += 1
      if (generation !== identityCaptureGeneration || !currentLoadedIndexIdentity()) return
      const releaseMutation = tryAcquireVectorMutationReservation()
      if (!releaseMutation) {
        updateSourceVectorRetry(1)
        return
      }
      void reconcileImageSearchSourceVectorInvalidations()
        .catch((error) => {
          console.warn('[ImageSearch] Scheduled source-vector recovery failed:', error)
          updateSourceVectorRetry(1)
        })
        .finally(releaseMutation)
    }, delay)
    sourceVectorRetryTimer.unref?.()
  }

  async function deleteImageSearchData(filePath: string): Promise<ImageSearchDataEditResult> {
    const addon = getAddon()
    if (!addon) return { ok: false, error: 'Native addon not connected' }
    const edited = addon.deleteIndexPath(resolveProjectSearchInputPath(filePath))
    if (!edited.ok) return edited
    removeImageData(filePath)
    return persistImageIndexEdits()
  }

  async function deleteImageSearchDataPaths(
    filePaths: readonly string[],
    onProgress?: (processed: number, total: number) => void,
    options: ImageSearchBatchDeleteOptions = {},
  ): Promise<ImageSearchDataDeletePathsResult> {
    const addon = getAddon()
    if (!addon) {
      return {
        ok: false,
        removedCount: 0,
        vectorRecordsRemoved: 0,
        warnings: [],
        error: 'Native addon not connected',
      }
    }
    const pathKey = (filePath: string) => {
      const resolved = path.resolve(filePath)
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved
    }
    const unique = [
      ...new Map(
        filePaths
          .filter(
            (filePath): filePath is string => typeof filePath === 'string' && !!filePath.trim(),
          )
          .map((filePath) => [pathKey(filePath), path.resolve(filePath)]),
      ).values(),
    ]
    if (unique.length === 0) {
      return { ok: true, removedCount: 0, vectorRecordsRemoved: 0, warnings: [] }
    }
    if (
      typeof addon.deleteIndexPathsPagedAsync !== 'function' &&
      typeof addon.deleteIndexPathsAsync !== 'function' &&
      typeof addon.deleteIndexPaths !== 'function' &&
      unique.length > MAX_LEGACY_BATCH_DELETE_PATHS
    ) {
      return {
        ok: false,
        removedCount: 0,
        vectorRecordsRemoved: 0,
        warnings: [],
        error: `The installed Native scanner cannot safely delete more than ${MAX_LEGACY_BATCH_DELETE_PATHS} paths per batch; restart after updating the application`,
      }
    }

    if (
      (!addon.deleteIndexPathsPagedAsync ||
        !addon.readIndexExportPage ||
        !addon.closeIndexExport) &&
      unique.length > 256
    ) {
      return {
        ok: false,
        removedCount: 0,
        vectorRecordsRemoved: 0,
        warnings: [],
        error: 'Update the Native scanner to delete a large batch safely',
      }
    }

    try {
      // Write-ahead before the Native memory edit. Startup reconciles this intent
      // with the persisted Native view after any interruption.
      if (!options.sourceVectorIntentPrepared) {
        await prepareImageSearchSourceVectorInvalidation(unique)
      }
    } catch (error) {
      return {
        ok: false,
        removedCount: 0,
        vectorRecordsRemoved: 0,
        warnings: [],
        error: `Could not prepare source-vector recovery before editing the index: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }

    const removedSources: string[] = []
    const warnings: string[] = []
    let remainingCount: number | undefined
    let changedDuringSync = 0

    if (
      typeof addon.deleteIndexPathsPagedAsync === 'function' ||
      typeof addon.deleteIndexPathsAsync === 'function' ||
      typeof addon.deleteIndexPaths === 'function'
    ) {
      const nativeInputs = unique.map((filePath) => resolveProjectSearchInputPath(filePath))
      const nativeInputToSource = new Map(
        nativeInputs.map((nativePath, index) => [pathKey(nativePath), unique[index]]),
      )
      let edited: NativeBatchDeleteResult
      try {
        edited =
          addon.deleteIndexPathsPagedAsync && addon.readIndexExportPage && addon.closeIndexExport
            ? await addon.deleteIndexPathsPagedAsync(nativeInputs)
            : typeof addon.deleteIndexPathsAsync === 'function'
              ? await addon.deleteIndexPathsAsync(nativeInputs)
              : addon.deleteIndexPaths!(nativeInputs)
      } catch (error) {
        return {
          ok: false,
          removedCount: 0,
          vectorRecordsRemoved: 0,
          warnings,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      if (!edited.ok) {
        return {
          ok: false,
          removedCount: 0,
          vectorRecordsRemoved: 0,
          warnings,
          error: edited.error || 'Image index batch deletion failed',
        }
      }
      try {
        if (edited.cursor && addon.readIndexExportPage && addon.closeIndexExport) {
          try {
            let offset = 0
            do {
              await new Promise<void>((resolve) => setImmediate(resolve))
              const page = addon.readIndexExportPage(edited.cursor, offset, 256)
              if (
                !page.ok ||
                !page.removedPaths ||
                page.nextOffset !== offset + page.removedPaths.length
              ) {
                throw new Error(page.error || 'Invalid Native deletion export page')
              }
              for (const nativePath of page.removedPaths) {
                const source = nativeInputToSource.get(pathKey(nativePath))
                if (!source) throw new Error('Unknown Native deletion result path')
                removedSources.push(source)
              }
              offset = page.nextOffset
              if (!page.hasMore) break
              if (!page.removedPaths.length)
                throw new Error('Native deletion export made no progress')
            } while (offset < Number(edited.removedCount))
          } finally {
            await addon.closeIndexExport(edited.cursor)
          }
        } else {
          for (const nativePath of edited.removedPaths || []) {
            const source = nativeInputToSource.get(pathKey(nativePath))
            if (source) removedSources.push(source)
          }
          if (!edited.removedPaths && Number(edited.removedCount || 0) === unique.length) {
            for (const source of unique) removedSources.push(source)
          }
        }
      } catch (error) {
        // Native has already committed. Preserve the durable intent and actual
        // count so callers retire stale search snapshots and can reconcile later.
        return {
          ok: false,
          removedCount: Math.max(0, Number(edited.removedCount || 0)),
          vectorRecordsRemoved: 0,
          warnings,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      if (removedSources.length !== Number(edited.removedCount || 0)) {
        return {
          ok: false,
          removedCount: Math.max(0, Number(edited.removedCount || 0)),
          vectorRecordsRemoved: 0,
          warnings,
          error: 'Native image index returned an invalid batch deletion result',
        }
      }
      changedDuringSync = Math.max(0, Number(edited.missingCount || 0))
      remainingCount = Number.isFinite(edited.remainingCount)
        ? Math.max(0, Number(edited.remainingCount))
        : undefined
      onProgress?.(unique.length, unique.length)
    } else {
      for (let index = 0; index < unique.length; index += 1) {
        const filePath = unique[index]
        const edited = addon.deleteIndexPath(resolveProjectSearchInputPath(filePath))
        if (edited.ok) {
          removedSources.push(filePath)
        } else if (edited.error === 'Indexed path not found') {
          changedDuringSync += 1
        } else {
          const persisted =
            removedSources.length > 0 ? await persistImageIndexEdits() : { ok: true }
          const reconciled = persisted.ok
            ? await reconcileImageSearchSourceVectorInvalidations()
            : {
                ok: false,
                vectorRecordsRemoved: 0,
                pendingIntents: 1,
                error: persisted.error || 'unknown persistence error',
              }
          return {
            ok: false,
            removedCount: removedSources.length,
            vectorRecordsRemoved: reconciled.vectorRecordsRemoved,
            warnings,
            error: !persisted.ok
              ? `${edited.error || 'Image index deletion failed'}; partial update persistence failed: ${persisted.error || 'unknown error'}`
              : !reconciled.ok
                ? `${edited.error || 'Image index deletion failed'}; partial vector invalidation remains queued: ${reconciled.error || 'retry required'}`
                : edited.error || 'Image index deletion failed',
          }
        }
        const processed = index + 1
        if (processed % 64 === 0 || processed === unique.length) {
          onProgress?.(processed, unique.length)
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    }

    if (changedDuringSync > 0) {
      warnings.push(
        `Skipped ${changedDuringSync} index path(s) that changed during synchronization`,
      )
    }
    const persisted =
      removedSources.length > 0 ? await persistImageIndexEdits(remainingCount) : { ok: true }
    if (!persisted.ok) {
      return {
        ok: false,
        removedCount: removedSources.length,
        vectorRecordsRemoved: 0,
        warnings,
        error: persisted.error || 'Image index persistence failed',
      }
    }
    const reconciled = await reconcileImageSearchSourceVectorInvalidations()
    if (!reconciled.ok) {
      return {
        ok: false,
        removedCount: removedSources.length,
        vectorRecordsRemoved: reconciled.vectorRecordsRemoved,
        warnings,
        error: `Image index synchronized, but source-vector invalidation remains queued: ${
          reconciled.error || 'retry required'
        }`,
      }
    }
    return {
      ok: true,
      removedCount: removedSources.length,
      vectorRecordsRemoved: reconciled.vectorRecordsRemoved,
      warnings,
    }
  }

  async function deleteImageSearchDataFolder(
    folder: string,
    allowedRoots: string[],
    options: ImageSearchFolderDeleteOptions = {},
  ): Promise<ImageSearchDataEditResult> {
    const addon = getAddon()
    if (!addon) return { ok: false, error: 'Native addon not connected' }
    if (typeof addon.purgeIndexPathPrefix !== 'function') {
      return { ok: false, error: 'Native addon does not support folder purge' }
    }
    const getPathStats = addon.getIndexPathStats?.bind(addon)
    if (
      options.compactAfterDelete &&
      (!getPathStats || typeof addon.compactManifestAsync !== 'function')
    ) {
      return { ok: false, error: 'Native addon does not support verified physical folder purge' }
    }
    const normalizedFolder = path.resolve(folder).toLowerCase()
    const allowed = allowedRoots.some((root) => {
      if (typeof root !== 'string' || !root.trim()) return false
      const normalizedRoot = path.resolve(root).toLowerCase()
      const rel = path.relative(normalizedRoot, normalizedFolder)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    })
    if (!allowed) return { ok: false, error: 'Folder is outside the configured scan paths' }

    const purged = addon.purgeIndexPathPrefix(path.resolve(folder))
    if (!purged.ok) return { ok: false, error: purged.error || 'Folder purge failed' }
    let previewRemoved = 0
    for (const entry of getProjectSearchEntriesInFolder(folder)) {
      if (!entry.previewPath) continue
      const removed = addon.deleteIndexPath(entry.previewPath)
      if (removed?.ok) previewRemoved += 1
      try {
        removeImageData(entry.sourcePath)
      } catch (error) {
        console.warn(
          '[ImageSearch] Vector cleanup failed for purged project:',
          entry.sourcePath,
          error,
        )
      }
    }
    const persisted = await persistImageIndexEdits()
    if (!persisted.ok) return persisted
    let recordCount = persisted.recordCount

    if (options.compactAfterDelete) {
      const rootDir = currentIndexRoot()
      const before = addon.getIndexMode()
      const needsCompact =
        Number(before.segmentCount || 0) > 1 ||
        Number(before.replacedCount || 0) > 0 ||
        Number(before.deletedCount || 0) > 0
      if (needsCompact) {
        let compacted: {
          ok: boolean
          recordCount?: number
          physicalCleanupComplete?: boolean
          cleanupError?: string
          error?: string
        }
        try {
          compacted = await addon.compactManifestAsync!(rootDir)
        } catch (error) {
          compacted = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        if (!compacted.ok) {
          return {
            ok: false,
            removedCount: (Number(purged.removedCount) || 0) + previewRemoved,
            error: `Logical Native deletion was saved, but physical compaction failed: ${
              compacted.error || 'unknown compaction error'
            }`,
          }
        }
        if (compacted.physicalCleanupComplete === false) {
          return {
            ok: false,
            removedCount: (Number(purged.removedCount) || 0) + previewRemoved,
            error: `Native compaction committed, but old segment cleanup failed: ${
              compacted.cleanupError || 'unknown segment cleanup error'
            }`,
          }
        }
        recordCount = compacted.recordCount
      }
      const remaining = getPathStats!(path.resolve(folder))
      const after = addon.getIndexMode()
      if (
        !remaining.ok ||
        Number(remaining.count || 0) !== 0 ||
        Number(after.replacedCount || 0) !== 0 ||
        Number(after.deletedCount || 0) !== 0
      ) {
        return {
          ok: false,
          removedCount: (Number(purged.removedCount) || 0) + previewRemoved,
          error: 'Native source deletion persisted, but post-compaction verification failed',
        }
      }
    }
    return {
      ok: true,
      recordCount,
      removedCount: (Number(purged.removedCount) || 0) + previewRemoved,
    }
  }

  async function deleteImageSearchDirName(name: string): Promise<ImageSearchDataEditResult> {
    const addon = getAddon()
    if (!addon) return { ok: false, error: 'Native addon not connected' }
    if (typeof addon.purgeIndexPathSegment !== 'function') {
      return { ok: false, error: 'Native addon does not support directory-name purge' }
    }
    const normalized = normalizeDirNameArg(name)
    if (!normalized) return { ok: false, error: 'Invalid directory name' }
    const purged = addon.purgeIndexPathSegment(normalized)
    if (!purged.ok) return { ok: false, error: purged.error || 'Directory-name purge failed' }
    const persisted = await persistImageIndexEdits()
    if (!persisted.ok) return persisted
    return {
      ok: true,
      recordCount: persisted.recordCount,
      removedCount: Number(purged.removedCount) || 0,
    }
  }

  async function updateImageSearchData(filePath: string): Promise<ImageSearchDataEditResult> {
    const addon = getAddon()
    if (!addon) return { ok: false, error: 'Native addon not connected' }
    const previousProject = getProjectSearchMetadata(filePath)
    const inputPath = await prepareProjectSearchInput(filePath)
    if (!inputPath) return { ok: false, error: 'Project file has no searchable content preview' }
    if (previousProject?.previewPath && previousProject.previewPath !== inputPath) {
      addon.deleteIndexPath(previousProject.previewPath)
      removeImageData(filePath)
    }
    const hashed = await addon.hashImageAsync(inputPath)
    if (!hashed.ok || !hashed.diffHash64 || !hashed.dctHash64) {
      return { ok: false, error: hashed.error || 'Image hash failed' }
    }
    let modifiedTime: number
    let sourceFileSize: number
    try {
      const sourceStat = fs.statSync(filePath)
      modifiedTime = sourceStat.mtimeMs
      sourceFileSize = sourceStat.size
    } catch {
      return { ok: false, error: 'Source file does not exist' }
    }
    const edited = addon.upsertIndexRecord(
      inputPath,
      hashed.width || 0,
      hashed.height || 0,
      sourceFileSize,
      modifiedTime,
      hashed.diffHash64,
      hashed.dctHash64,
    )
    if (!edited.ok) return edited
    return persistImageIndexEdits()
  }

  async function repairImageSearchDataPath(
    oldPath: string,
    newPath: string,
  ): Promise<ImageSearchDataEditResult> {
    const addon = getAddon()
    if (!addon) return { ok: false, error: 'Native addon not connected' }
    const oldInputPath = resolveProjectSearchInputPath(oldPath)
    const newInputPath = await prepareProjectSearchInput(newPath)
    if (!newInputPath) return { ok: false, error: 'New project file has no searchable preview' }
    if (oldInputPath !== oldPath || newInputPath !== newPath) {
      addon.deleteIndexPath(oldInputPath)
      removeImageData(oldPath)
      return updateImageSearchData(newPath)
    }
    const edited = addon.repairIndexPath(oldPath, newPath)
    if (!edited.ok) return edited
    return persistImageIndexEdits()
  }

  return {
    currentIndexRoot,
    currentLoadedIndexIdentity,
    clearLoadedIndexIdentity,
    resolveIndexIdentity,
    captureLoadedIndexIdentity,
    persistEmptyImageIndex,
    persistImageIndexEdits,
    queryImageSearchData,
    snapshotImageSearchData,
    getImageSearchCatalogRevision,
    isImageSearchIndexedPath,
    listImageSearchIndexedPaths,
    listImageSearchIndexedThumbnailSources,
    getImageSearchDataStats,
    getImageSearchDirNameStats,
    prepareImageSearchSourceVectorInvalidation,
    reconcileImageSearchSourceVectorInvalidations,
    deleteImageSearchData,
    deleteImageSearchDataPaths,
    deleteImageSearchDataFolder,
    deleteImageSearchDirName,
    repairImageSearchDataPath,
    updateImageSearchData,
  }
}

export type ImageSearchDataService = ReturnType<typeof createImageSearchDataService>
