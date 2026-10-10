import path from 'path'
import fs from 'fs'
import type {
  ImageSearchStatus,
  ImageSearchStartScanArgs,
  ImageSearchSearchArgs,
  ImageSearchSearchResponse,
  ImageHashResult,
} from '../shared/ipc-contract'
import {
  MAX_SEARCH_TOP_K,
  clampNumber,
  normalizeFsPath,
  normalizeScanMode,
  normalizeScanPaths,
  normalizeSearchMode,
} from './imageSearchGuards'
import { THUMBNAIL_CACHE_VERSION } from '../shared/thumbnailPolicy'
import { removeImageData } from './vectorDatabaseService'
import type { NativeScopeState } from './semanticSearchScope'
import {
  indexProjectPreviews,
  initProjectSearchIndex,
  mapNativeProjectSearchHits,
  mergeProjectSearchHashFallback,
  prepareProjectSearchInput,
  resolveProjectSearchInputPath,
} from './projectSearchIndexService'
import type {
  ImageSearchDataRecord,
  NativeAddon,
  NativeSearchResult,
} from './imageSearchNativeTypes'
import {
  createImageSearchDataService,
  type ImageSearchBatchDeleteOptions,
  type ImageSearchDataEditResult,
  type ImageSearchDataSnapshotRecord,
  type ImageSearchFolderDeleteOptions,
  type ImageSearchIndexIdentitySnapshot,
} from './imageSearchDataService'
import {
  tryAcquireVectorMutationReservation,
  type VectorExclusiveMaintenanceLease,
} from './vectorMaintenanceService'

export type StatusCallback = (status: ImageSearchStatus) => void

export type { ImageSearchDataRecord } from './imageSearchNativeTypes'
export type {
  ImageSearchBatchDeleteOptions,
  ImageSearchDataEditResult,
  ImageSearchDataSnapshotRecord,
  ImageSearchFolderDeleteOptions,
  ImageSearchIndexIdentitySnapshot,
} from './imageSearchDataService'

type ImageSearchAutosaveState = 'idle' | 'saving' | 'saved' | 'failed'

interface NativeConnectionState {
  connected: boolean
  version?: string
}

function validImageSearchScanPaths(args: ImageSearchStartScanArgs): string[] {
  return normalizeScanPaths(args?.paths).filter((scanPath) => {
    try {
      return fs.statSync(scanPath).isDirectory()
    } catch {
      return false
    }
  })
}

function queuedImageSearchStatus(
  current: ImageSearchStatus,
  hasScanPaths: boolean,
  native: NativeConnectionState,
): ImageSearchStatus {
  if (['queued', 'scanning', 'indexing', 'searching', 'paused'].includes(current.state)) {
    return current
  }
  if (!hasScanPaths) {
    return {
      ...current,
      state: 'error',
      pendingCount: 0,
      lastError: 'No scan paths configured',
      message: 'Add at least one scan path before scanning.',
      nativeConnected: native.connected,
      nativeVersion: native.version,
    }
  }
  if (!native.connected) {
    return {
      ...current,
      state: 'error',
      pendingCount: 0,
      lastError: 'Native addon not connected',
      message: 'Native addon not connected - scan unavailable.',
      nativeConnected: native.connected,
      nativeVersion: native.version,
    }
  }
  return {
    ...current,
    state: 'queued',
    pendingCount: 0,
    currentPath: undefined,
    lastError: undefined,
    message: 'Waiting for the unified local indexing lane...',
    nativeConnected: native.connected,
    nativeVersion: native.version,
  }
}

function finishedQueuedImageSearchStatus(
  current: ImageSearchStatus,
  error?: unknown,
): ImageSearchStatus | null {
  if (current.state !== 'queued') return null
  const message =
    error instanceof Error ? error.message : error === undefined ? undefined : String(error)
  return {
    ...current,
    state: error === undefined ? 'idle' : 'error',
    pendingCount: 0,
    currentPath: undefined,
    ...(message
      ? { lastError: message, message }
      : { lastError: undefined, message: 'Scan cancelled.' }),
  }
}

function failedImageSearchStatus(current: ImageSearchStatus, error: unknown): ImageSearchStatus {
  const message = error instanceof Error ? error.message : String(error)
  return {
    ...current,
    state: 'error',
    pendingCount: 0,
    currentPath: undefined,
    lastError: message,
    message,
  }
}

function isImageSearchLifecycleSettled(
  current: ImageSearchStatus,
  hasPendingProjectScan: boolean,
  currentAutosaveState: ImageSearchAutosaveState,
): boolean {
  return (
    (current.state === 'idle' || current.state === 'error') &&
    !hasPendingProjectScan &&
    currentAutosaveState !== 'saving'
  )
}

let nativeAddon: NativeAddon | null = null
let nativeVersion: string | undefined
let nativeConnected = false
let nativePath: string | undefined

function tryLoadAddon(): void {
  const candidates = [
    path.resolve(__dirname, '..', 'native', 'build', 'Release', 'fast_scanner.node'),
    path.resolve(__dirname, '..', '..', 'native', 'build', 'Release', 'fast_scanner.node'),
    path.join(process.resourcesPath || '', 'fast_scanner.node'),
  ]
  for (const p of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(p) as NativeAddon
      if (mod && typeof mod.getNativeVersion === 'function') {
        nativeAddon = mod
        nativeVersion = mod.getNativeVersion()
        nativeConnected = true
        nativePath = p
        console.log('[ImageSearch] Native addon loaded:', nativeVersion)
        return
      }
    } catch {
      /* next */
    }
  }
  console.log('[ImageSearch] Native addon not found — using mock service')
}

let onStatusChange: StatusCallback | null = null
const statusListeners = new Set<StatusCallback>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let defaultSavePath = ''
let defaultThumbnailCachePath = ''
let defaultVectorDatabasePath = ''
let autosaveState: ImageSearchAutosaveState = 'idle'
let autosavePromise: Promise<void> | null = null
let lastSaveTime = 0
let editPersistRetryPending = false
let scanGeneration = 0
let pendingProjectScan: { generation: number; paths: string[] } | null = null
let activeImageSearchQueries = 0
let activeImageIndexMutations = 0

export function isImageSearchQueryRunning(): boolean {
  return activeImageSearchQueries > 0
}

export function isImageSearchIndexMutationRunning(): boolean {
  return activeImageIndexMutations > 0
}

class ImageSearchIndexMutationBusyError extends Error {
  constructor() {
    super('Vector search or exclusive maintenance is using the active Image Search index')
    this.name = 'ImageSearchIndexMutationBusyError'
  }
}

async function runImageIndexMutation<T>(
  operation: () => Promise<T>,
  vectorMaintenanceLease?: VectorExclusiveMaintenanceLease,
): Promise<T> {
  const releaseVectorMutation = tryAcquireVectorMutationReservation(vectorMaintenanceLease)
  if (!releaseVectorMutation) throw new ImageSearchIndexMutationBusyError()
  activeImageIndexMutations += 1
  try {
    return await operation()
  } finally {
    activeImageIndexMutations = Math.max(0, activeImageIndexMutations - 1)
    releaseVectorMutation()
  }
}

async function runImageIndexEditMutation(
  operation: () => Promise<ImageSearchDataEditResult>,
): Promise<ImageSearchDataEditResult> {
  try {
    return await runImageIndexMutation(operation)
  } catch (error) {
    if (error instanceof ImageSearchIndexMutationBusyError) {
      return { ok: false, error: error.message }
    }
    throw error
  }
}

function purgeGeneratedThumbnailIndexRecords(addon: NativeAddon): number {
  if (!defaultThumbnailCachePath || !addon.purgeIndexPathPrefix) return 0
  const result = addon.purgeIndexPathPrefix(defaultThumbnailCachePath)
  const removed = result.ok ? Number(result.removedCount) || 0 : 0
  if (removed > 0) {
    console.warn('[ImageSearch] Removed generated thumbnail cache records from index:', removed)
  }
  return removed
}

let status: ImageSearchStatus = {
  state: 'idle',
  indexedCount: 0,
  pendingCount: 0,
  message: '',
}

// Cache getIndexMode() to avoid C++ FFI on every emit (called every 500ms during scan)
let _cachedIndexMode: ReturnType<NativeAddon['getIndexMode']> | null = null
let _cachedIndexModeTs = 0
const INDEX_MODE_CACHE_MS = 2000 // refresh at most every 2s

const imageSearchDataService = createImageSearchDataService({
  getNativeAddon: () => nativeAddon,
  getDefaultSavePath: () => defaultSavePath,
  getDefaultVectorDatabasePath: () => defaultVectorDatabasePath,
  getSegmentPath: () => status.segmentPath,
  invalidateIndexModeCache: () => {
    _cachedIndexMode = null
    _cachedIndexModeTs = 0
  },
  setEditPersistRetryPending: (pending) => {
    editPersistRetryPending = pending
  },
  recordPersistedIndex: (rootDir, recordCount) => {
    status.segmentPath = rootDir
    status.indexedCount = recordCount
  },
})

function getIndexModeCached(): ReturnType<NativeAddon['getIndexMode']> {
  const now = Date.now()
  if (_cachedIndexMode && now - _cachedIndexModeTs < INDEX_MODE_CACHE_MS) {
    return _cachedIndexMode
  }
  if (nativeAddon) {
    _cachedIndexMode = nativeAddon.getIndexMode()
    _cachedIndexModeTs = now
    return _cachedIndexMode
  }
  return {
    mode: 'memory',
    recordCount: 0,
    segmentPath: '',
    version: 0,
    pathIndexMapSize: 0,
    overlayCount: 0,
    replacedCount: 0,
    deletedCount: 0,
    pathMapHealthy: false,
    segmentCount: 0,
  }
}

function emit(): void {
  if (onStatusChange || statusListeners.size > 0) {
    const m = nativeAddon
      ? getIndexModeCached()
      : {
          mode: 'memory',
          recordCount: 0,
          segmentPath: '',
          version: 0,
          pathIndexMapSize: 0,
          overlayCount: 0,
          replacedCount: 0,
          deletedCount: 0,
          pathMapHealthy: false,
          segmentCount: 0,
        }
    const segPath = status.segmentPath || m.segmentPath
    const effectiveIdx =
      m.mode === 'segment_mmap' && m.recordCount > 0 ? m.recordCount : status.indexedCount
    const snapshot = {
      ...status,
      indexMode: m.mode,
      segmentVersion: m.version,
      segmentPath: segPath || undefined,
      autosaveState,
      lastSaveTime,
      pathIndexMapSize: m.pathIndexMapSize,
      overlayCount: m.overlayCount,
      replacedCount: m.replacedCount,
      deletedCount: m.deletedCount,
      indexedCount: effectiveIdx,
      pathMapHealthy: m.pathMapHealthy,
      segmentCount: m.segmentCount,
    }
    onStatusChange?.(snapshot)
    for (const listener of statusListeners) {
      try {
        listener(snapshot)
      } catch {
        /* one observer must not break scan progress delivery */
      }
    }
  }
}

export function onImageSearchStatus(listener: StatusCallback): () => void {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

export const getImageSearchCommitFeed = (): NativeAddon | null => nativeAddon

function clearPollTimer(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function autosaveDirtyIndex(): void {
  if (!nativeAddon || autosaveState === 'saving' || autosaveState === 'saved') return
  // M4: a failed edit persist retries here, on the next autosave opportunity.
  // persistImageIndexEdits re-sets the flag when the retry fails again.
  if (editPersistRetryPending) {
    editPersistRetryPending = false
    void persistImageIndexEdits().then(async (result) => {
      if (result.ok) {
        lastSaveTime = Date.now()
        console.log('[ImageSearch] Retried persist of pending edits succeeded')
        const recovery = await reconcileImageSearchSourceVectorInvalidations()
        if (!recovery.ok) {
          console.warn('[ImageSearch] Source-vector recovery remains pending:', recovery.error)
        }
      }
      emit()
    })
    return
  }
  const dirty = nativeAddon.isIndexDirty?.()
  if (!dirty?.dirty) {
    autosaveState = 'idle'
    emit()
    return
  }
  autosaveState = 'saving'
  const savePath =
    status.segmentPath ||
    defaultSavePath ||
    path.join(process.env.APPDATA || '', 'floating-clock-electron', 'image-search-index')
  const addon = nativeAddon
  autosavePromise = Promise.resolve()
    .then(async () => {
      fs.mkdirSync(savePath, { recursive: true })
      const identityBefore = await imageSearchDataService.resolveIndexIdentity(savePath)
      return { identityBefore, result: await addon.saveIndexToManifestAsync(savePath) }
    })
    .then(async ({ identityBefore, result }) => {
      if (result?.ok) {
        autosaveState = 'saved'
        lastSaveTime = Date.now()
        status.segmentPath = savePath
        status.indexMode = 'segment_mmap'
        status.indexedCount = result.recordCount
        await imageSearchDataService.captureLoadedIndexIdentity(savePath, identityBefore)
        const recovery = await reconcileImageSearchSourceVectorInvalidations()
        if (!recovery.ok) {
          console.warn('[ImageSearch] Source-vector recovery remains pending:', recovery.error)
        }
        const compactStatus = addon.getCompactStatus?.()
        if (compactStatus?.compactRecommended) {
          console.log(
            '[ImageSearch] Auto-compact triggered:',
            compactStatus.segmentCount,
            'segments',
          )
          addon.compactManifestAsync(savePath).then((compacted) => {
            if (compacted?.ok) {
              console.log(
                '[ImageSearch] Auto-compact done:',
                compacted.recordCount,
                'records, was',
                compacted.beforeSegments,
                'segments',
              )
            } else {
              console.log('[ImageSearch] Auto-compact failed:', compacted?.error)
            }
          })
        }
      } else {
        autosaveState = 'failed'
      }
      emit()
    })
    .catch(() => {
      autosaveState = 'failed'
      emit()
    })
  emit()
}

async function finishProjectScan(generation: number, roots: string[]): Promise<void> {
  if (!nativeAddon || generation !== scanGeneration) return
  status = {
    ...status,
    state: 'indexing',
    currentPath: undefined,
    message: 'Preparing project file previews...',
  }
  emit()
  const addon = nativeAddon
  const result = await indexProjectPreviews(
    roots,
    {
      hashImageAsync: (filePath) => addon.hashImageAsync(filePath),
      upsertIndexRecord: (...args) => addon.upsertIndexRecord(...args),
      deleteIndexPath: (filePath) => addon.deleteIndexPath(filePath),
      removeSourceVectorData: (sourcePath) => removeImageData(sourcePath),
    },
    {
      isCancelled: () => generation !== scanGeneration,
      onProgress: (projectProgress) => {
        if (generation !== scanGeneration) return
        status = {
          ...status,
          state: projectProgress.phase === 'complete' ? 'idle' : 'indexing',
          currentPath: projectProgress.currentPath,
          message:
            projectProgress.phase === 'enumerating'
              ? `Finding project files... ${projectProgress.discovered}`
              : projectProgress.phase === 'rendering'
                ? `Indexing project previews... ${projectProgress.completed}/${projectProgress.discovered}`
                : `Project previews indexed: ${projectProgress.indexed}`,
          projectDiscovered: projectProgress.discovered,
          projectIndexed: projectProgress.indexed,
          projectUnavailable: projectProgress.unavailable,
          projectFailed: projectProgress.failed,
          projectRemoved: projectProgress.removed,
        }
        emit()
      },
    },
  )
  if (generation !== scanGeneration || result.cancelled) return
  status = {
    ...status,
    state: 'idle',
    currentPath: undefined,
    message: `Scan complete. ${status.indexedCount} images + ${result.indexed} project previews`,
    projectDiscovered: result.discovered,
    projectIndexed: result.indexed,
    projectUnavailable: result.unavailable,
    projectFailed: result.failed,
    projectRemoved: result.removed,
    lastWarning: result.truncated
      ? 'Project file enumeration reached its safety limit.'
      : status.lastWarning,
  }
  _cachedIndexMode = null
  emit()
  autosaveDirtyIndex()
}

function startPollingScan(): void {
  clearPollTimer()
  pollTimer = setInterval(() => {
    if (!nativeAddon) return
    const prog = nativeAddon.getScanProgress()
    status = {
      ...status,
      state:
        prog.state === 'scanning'
          ? 'scanning'
          : prog.state === 'paused'
            ? 'paused'
            : prog.state === 'error'
              ? 'error'
              : 'idle',
      indexedCount: Number(prog.indexedCount) || 0,
      pendingCount: 0,
      currentPath: prog.currentPath || undefined,
      message:
        prog.state === 'scanning'
          ? `Scanning... ${prog.indexedCount} indexed`
          : prog.state === 'paused'
            ? `Scan paused. ${prog.indexedCount} indexed`
            : prog.state === 'error'
              ? `Scan error: ${prog.error || 'unknown'}`
              : `Scan complete. ${prog.indexedCount} indexed`,
      lastError: prog.state === 'error' ? prog.error || undefined : undefined,
      lastWarning: prog.state !== 'error' ? prog.lastWarning || undefined : undefined,
      skippedCount: Number(prog.skippedCount) || 0,
      signatureRejectedCount: Number(prog.signatureRejectedCount) || 0,
      skippedIndexed: Number(prog.skippedIndexed) || 0,
      skippedUnchanged: Number(prog.skippedUnchanged) || 0,
      newCount: Number(prog.newCount) || 0,
      updatedCount: Number(prog.updatedCount) || 0,
      warningCount: Number(prog.warningCount) || 0,
      durationMs: Number(prog.durationMs) || 0,
      detailedMetricsEnabled: prog.detailedMetricsEnabled === true,
      enumMs: Number(prog.enumMs) || 0,
      filesystemEnumMs: Number(prog.filesystemEnumMs) || 0,
      queueWaitMs: Number(prog.queueWaitMs) || 0,
      queueSubmitCount: Number(prog.queueSubmitCount) || 0,
      queueBlockedCount: Number(prog.queueBlockedCount) || 0,
      readMs: Number(prog.readMs) || 0,
      readFileCount: Number(prog.readFileCount) || 0,
      readBytes: Number(prog.readBytes) || 0,
      normalizeMs: Number(prog.normalizeMs) || 0,
      mapLookupMs: Number(prog.mapLookupMs) || 0,
      statMs: Number(prog.statMs) || 0,
      decodeMsTotal: Number(prog.decodeMsTotal) || 0,
      hashMsTotal: Number(prog.hashMsTotal) || 0,
      pushMs: Number(prog.pushMs) || 0,
      commitMs: Number(prog.commitMs) || 0,
      totalScanMs: Number(prog.totalScanMs) || 0,
      backend: prog.backend,
      fallbackReason: prog.fallbackReason,
      fallbackCode: prog.fallbackCode,
      fallbackAction: prog.fallbackAction,
      usnWin32Error: prog.usnWin32Error,
      usnRequiresAdmin: prog.usnRequiresAdmin,
      enumDirCount: prog.enumDirCount,
      enumFileCount: prog.enumFileCount,
      enumImageCount: prog.enumImageCount,
      enumSkippedDirCount: prog.enumSkippedDirCount,
      scanWorkerCount: prog.scanWorkerCount,
      scanQueueCapacity: prog.scanQueueCapacity,
      scanQueuePending: prog.scanQueuePending,
      scanPeakQueuePending: prog.scanPeakQueuePending,
      scanActiveWorkers: prog.scanActiveWorkers,
      scanPeakWorkers: prog.scanPeakWorkers,
      scanWorkerMinCompleted: prog.scanWorkerMinCompleted,
      scanWorkerMaxCompleted: prog.scanWorkerMaxCompleted,
      scanWorkerMinBusyMs: prog.scanWorkerMinBusyMs,
      scanWorkerMaxBusyMs: prog.scanWorkerMaxBusyMs,
      thumbnailEnabled: prog.thumbnailEnabled,
      thumbnailQueued: Number(prog.thumbnailQueued) || 0,
      thumbnailCompleted: Number(prog.thumbnailCompleted) || 0,
      thumbnailFailed: Number(prog.thumbnailFailed) || 0,
      thumbnailDropped: Number(prog.thumbnailDropped) || 0,
      thumbnailPending: Number(prog.thumbnailPending) || 0,
      thumbnailInputReused: Number(prog.thumbnailInputReused) || 0,
      thumbnailInputReusedBytes: Number(prog.thumbnailInputReusedBytes) || 0,
      thumbnailInputFallback: Number(prog.thumbnailInputFallback) || 0,
      thumbnailSourceReads: Number(prog.thumbnailSourceReads) || 0,
      thumbnailRetainedInputBytes: Number(prog.thumbnailRetainedInputBytes) || 0,
      thumbnailRetainedInputLimitBytes: Number(prog.thumbnailRetainedInputLimitBytes) || 0,
      thumbnailWorkerCount: Number(prog.thumbnailWorkerCount) || 0,
      thumbnailScanWorkerCount: Number(prog.thumbnailScanWorkerCount) || 0,
      thumbnailFillWorkerCount: Number(prog.thumbnailFillWorkerCount) || 0,
      thumbnailQueueCapacity: Number(prog.thumbnailQueueCapacity) || 0,
      thumbnailDeferred: Number(prog.thumbnailDeferred) || 0,
      thumbnailDeferredPending: Number(prog.thumbnailDeferredPending) || 0,
      thumbnailDeferredPathBytes: Number(prog.thumbnailDeferredPathBytes) || 0,
      thumbnailDeferredEntryLimit: Number(prog.thumbnailDeferredEntryLimit) || 0,
      thumbnailDeferredPathLimitBytes: Number(prog.thumbnailDeferredPathLimitBytes) || 0,
      thumbnailFillCompleted: Number(prog.thumbnailFillCompleted) || 0,
      thumbnailFillFailed: Number(prog.thumbnailFillFailed) || 0,
      thumbnailCancelled: Number(prog.thumbnailCancelled) || 0,
      thumbnailLogicalProcessors: Number(prog.thumbnailLogicalProcessors) || 0,
      thumbnailTotalMemoryBytes: Number(prog.thumbnailTotalMemoryBytes) || 0,
      thumbnailAvailableMemoryBytes: Number(prog.thumbnailAvailableMemoryBytes) || 0,
      thumbnailWorkerOverride: Boolean(prog.thumbnailWorkerOverride),
      thumbnailWorkerPolicy: prog.thumbnailWorkerPolicy,
      thumbnailPhase: prog.thumbnailPhase,
      nativeConnected,
      nativeVersion,
      nativePath,
    }
    emit()
    // Stop polling when scan finishes
    if (prog.state !== 'scanning' && prog.state !== 'paused') {
      clearPollTimer()
      if (prog.state === 'idle') {
        const projectScan = pendingProjectScan
        pendingProjectScan = null
        if (projectScan) {
          void finishProjectScan(projectScan.generation, projectScan.paths).catch((error) => {
            if (projectScan.generation !== scanGeneration) return
            status = {
              ...status,
              state: 'error',
              currentPath: undefined,
              lastError: error instanceof Error ? error.message : 'Project preview indexing failed',
              message: 'Project preview indexing failed.',
            }
            emit()
            autosaveDirtyIndex()
          })
        } else {
          autosaveDirtyIndex()
        }
      } else {
        pendingProjectScan = null
        emit()
      }
    }
  }, 500)
}

export function initImageSearchService(cb: StatusCallback, userDataPath?: string): void {
  onStatusChange = cb
  imageSearchDataService.clearLoadedIndexIdentity()
  if (userDataPath) {
    defaultSavePath = path.join(userDataPath, 'image-search-index')
    defaultThumbnailCachePath = path.join(userDataPath, 'thumbcache')
    defaultVectorDatabasePath = path.join(userDataPath, 'vector-db')
    fs.mkdirSync(defaultThumbnailCachePath, { recursive: true })
    void initProjectSearchIndex(userDataPath).catch((error) => {
      console.warn('[ImageSearch] Project preview lookup initialization failed:', error)
    })
  }
  tryLoadAddon()
  status = {
    ...status,
    nativeConnected,
    nativeVersion,
    message: nativeConnected
      ? `Native addon connected (${nativeVersion})`
      : 'Native addon not connected — mock service active',
  }
  emit()
  console.log(
    '[ImageSearch] Service initialized',
    nativeConnected ? `(native: ${nativeVersion})` : '(mock mode)',
  )

  if (nativeAddon && defaultSavePath) {
    void tryAutoLoadDefault()
  }
}

async function tryAutoLoadDefault(): Promise<void> {
  if (!nativeAddon || !defaultSavePath) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs')
    const mfPath = path.join(defaultSavePath, 'manifest.json')
    const segDir = path.join(defaultSavePath, 'segments')

    // Priority 1: default manifest.json exists → load it (async, non-blocking)
    if (fs.existsSync(mfPath)) {
      const addon = nativeAddon // capture for type narrowing
      status = {
        ...status,
        segmentPath: defaultSavePath,
        autoloadSource: 'default',
        message: 'Loading default image index...',
      }
      emit()
      imageSearchDataService.clearLoadedIndexIdentity()
      imageSearchDataService
        .resolveIndexIdentity(defaultSavePath)
        .then(async (identityBefore) => ({
          identityBefore,
          result: await addon.loadManifestAsync(defaultSavePath, defaultThumbnailCachePath),
        }))
        .then(async ({ identityBefore, result: r }) => {
          if (r?.ok) {
            await imageSearchDataService.captureLoadedIndexIdentity(defaultSavePath, identityBefore)
            const recovery = await reconcileImageSearchSourceVectorInvalidations()
            const m = addon.getIndexMode()
            const rawIndexCount =
              m.mode === 'segment_mmap' && m.recordCount > 0 ? m.recordCount : r.recordCount || 0
            const removedGeneratedRecords = Math.max(0, Number(r.removedCount) || 0)
            if (removedGeneratedRecords > 0) {
              console.warn(
                '[ImageSearch] Removed generated thumbnail cache records from index:',
                removedGeneratedRecords,
              )
            }
            const idxCnt = Math.max(0, rawIndexCount - removedGeneratedRecords)
            status = {
              ...status,
              segmentPath: defaultSavePath,
              autoloadSource: 'default',
              indexedCount: idxCnt,
              indexMode: m.mode || 'segment_mmap',
              message: recovery.ok
                ? `Auto-loaded ${idxCnt} records from default index`
                : `Auto-loaded ${idxCnt} records; source-vector recovery remains pending`,
            }
            emit()
            console.log(
              '[ImageSearch] Auto-loaded default manifest:',
              idxCnt,
              'records,',
              r.segmentCount,
              'segments',
            )
            if (!recovery.ok) {
              console.warn('[ImageSearch] Source-vector recovery remains pending:', recovery.error)
            }
          } else {
            status = { ...status, segmentPath: undefined, autoloadSource: 'none' }
            emit()
            console.log('[ImageSearch] Default manifest load failed:', r?.error)
          }
        })
        .catch((e) => {
          status = { ...status, segmentPath: undefined, autoloadSource: 'none' }
          emit()
          console.log('[ImageSearch] Default manifest load error:', e)
        })
      return // return immediately, load happens in background
    }

    // Priority 2: segments exist without manifest → repair
    if (fs.existsSync(segDir)) {
      const segs = fs.readdirSync(segDir).filter((f: string) => f.endsWith('.idx'))
      if (segs.length > 0) {
        imageSearchDataService.clearLoadedIndexIdentity()
        const rr = nativeAddon.repairManifestFromSegments(defaultSavePath)
        if (rr?.ok) {
          const identityBefore = await imageSearchDataService.resolveIndexIdentity(defaultSavePath)
          const r2 = nativeAddon.loadManifest(defaultSavePath)
          if (r2?.ok) {
            await imageSearchDataService.captureLoadedIndexIdentity(defaultSavePath, identityBefore)
            const recovery = await reconcileImageSearchSourceVectorInvalidations()
            const m = nativeAddon.getIndexMode()
            const rawIndexCount =
              m.mode === 'segment_mmap' && m.recordCount > 0 ? m.recordCount : r2.recordCount || 0
            const idxCnt = Math.max(
              0,
              rawIndexCount - purgeGeneratedThumbnailIndexRecords(nativeAddon),
            )
            status = {
              ...status,
              segmentPath: defaultSavePath,
              autoloadSource: 'repair',
              indexedCount: idxCnt,
              indexMode: 'segment_mmap',
              message: recovery.ok
                ? `Repaired & loaded ${idxCnt} records from orphan segments`
                : `Repaired & loaded ${idxCnt} records; source-vector recovery remains pending`,
            }
            emit()
            console.log('[ImageSearch] Repaired orphan segments:', r2.recordCount, 'records')
            if (!recovery.ok) {
              console.warn('[ImageSearch] Source-vector recovery remains pending:', recovery.error)
            }
            return
          }
        }
        console.log('[ImageSearch] Orphan segment repair failed:', rr?.error)
      }
    }

    status = { ...status, autoloadSource: 'none' }
  } catch (e) {
    console.error('[ImageSearch] tryAutoLoadDefault error:', e)
    status = { ...status, autoloadSource: 'none' }
  }
}

export function getImageSearchStatus(): ImageSearchStatus {
  if (nativeAddon) {
    const m = nativeAddon.getIndexMode()
    const stats = nativeAddon.getIndexStats()
    // Effective indexedCount: segment mode uses recordCount, memory mode uses stats
    const effectiveIdx =
      m.mode === 'segment_mmap' && m.recordCount > 0
        ? m.recordCount
        : Number(stats.indexedCount) || 0
    status = {
      ...status,
      indexedCount: effectiveIdx,
      indexMode: m.mode,
      segmentPath: status.segmentPath || m.segmentPath || undefined,
      autosaveState,
      lastSaveTime,
      nativeConnected,
      nativeVersion,
      nativePath,
    }
  }
  return { ...status }
}

/**
 * Explicit Native scope state for vector-search consumers (VAL-036). Probed
 * lazily from the manifest on disk so the answer always matches the current
 * on-disk state instead of a stale load outcome:
 * - records loaded → 'ready'
 * - manifest missing → 'absent' (legacy no-scope behavior)
 * - manifest parses → 'valid-empty' (nothing loaded from a readable index)
 * - manifest exists but is unparseable/invalid → 'corrupt' (fail closed:
 *   vector search must not silently widen to the full library)
 * Mock mode (no native addon) keeps the legacy count-only semantics.
 */
export function getImageSearchScopeState(): NativeScopeState {
  if (getImageSearchStatus().indexedCount > 0) return 'ready'
  if (!nativeAddon) return 'absent'
  let rawManifest: string
  try {
    rawManifest = fs.readFileSync(path.join(currentIndexRoot(), 'manifest.json'), 'utf8')
  } catch {
    return 'absent'
  }
  try {
    const manifest = JSON.parse(rawManifest) as { segments?: unknown }
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      (manifest.segments !== undefined && !Array.isArray(manifest.segments))
    ) {
      return 'corrupt'
    }
    return 'valid-empty'
  } catch {
    return 'corrupt'
  }
}

/** Validate and publish the queued state before the native composite scan owns the local lane. */
export function reserveImageSearchScan(args: ImageSearchStartScanArgs): ImageSearchStatus {
  status = queuedImageSearchStatus(status, validImageSearchScanPaths(args).length > 0, {
    connected: nativeConnected && nativeAddon !== null,
    version: nativeVersion,
  })
  emit()
  return { ...status }
}

export function finishQueuedImageSearchScan(error?: unknown): boolean {
  const nextStatus = finishedQueuedImageSearchStatus(status, error)
  if (!nextStatus) return false
  status = nextStatus
  emit()
  return true
}

export async function waitForImageSearchPersistence(): Promise<void> {
  if (autosavePromise) await autosavePromise
  if (autosaveState === 'failed') throw new Error('Image Search manifest autosave failed')
}

export function isImageSearchScanLifecycleComplete(): boolean {
  return isImageSearchLifecycleSettled(status, pendingProjectScan !== null, autosaveState)
}

export function startImageSearchScan(
  args: ImageSearchStartScanArgs,
  options: { acceptQueuedReservation?: boolean } = {},
): ImageSearchStatus {
  if (status.state === 'queued' && !options.acceptQueuedReservation) return { ...status }
  const requestedPaths = validImageSearchScanPaths(args)
  if (requestedPaths.length === 0) {
    status = {
      ...status,
      state: 'error',
      pendingCount: 0,
      lastError: 'No scan paths configured',
      message: 'Add at least one scan path before scanning.',
      nativeConnected,
      nativeVersion,
    }
    emit()
    return { ...status }
  }

  if (!nativeAddon) {
    // Preserve the direct-call mock fallback for isolated callers. The
    // production scheduler reservation rejects before reaching this branch.
    status = {
      ...status,
      state: 'scanning',
      message: 'Mock scan (no native).',
      nativeConnected,
      nativeVersion,
    }
    emit()
    return { ...status }
  }

  const paths = requestedPaths
  const scanMode = normalizeScanMode(args.scanMode)
  const buildThumbnails = args.buildThumbnails !== false
  if (nativeAddon.configureScanThumbnails && defaultThumbnailCachePath) {
    const configured = nativeAddon.configureScanThumbnails(
      defaultThumbnailCachePath,
      buildThumbnails,
      THUMBNAIL_CACHE_VERSION,
    )
    if (!configured.ok) {
      console.warn('[ImageSearch] Native scan thumbnail sidecar unavailable:', configured.error)
    }
  }
  const r = nativeAddon.scanDirectory(paths.join('\x1f'), scanMode)
  if (!r.ok) {
    status = { ...status, state: 'error', lastError: r.error, nativeConnected, nativeVersion }
    emit()
    return { ...status }
  }

  scanGeneration += 1
  pendingProjectScan = { generation: scanGeneration, paths }
  autosaveState = 'idle'
  status = {
    ...status,
    state: 'scanning',
    indexedCount: 0,
    pendingCount: 0,
    message: 'Scan started...',
    nativeConnected,
    nativeVersion,
  }
  emit()
  startPollingScan()
  return { ...status }
}

export function failActiveImageSearchScan(error: unknown): boolean {
  if (!['idle', 'queued', 'scanning', 'indexing', 'paused'].includes(status.state)) return false
  if (nativeAddon && ['scanning', 'paused'].includes(status.state)) {
    try {
      if (nativeAddon.stopScanAsync) void nativeAddon.stopScanAsync().catch(() => undefined)
      else nativeAddon.stopScan()
    } catch {
      /* cooperative stop is best-effort after a scheduler failure */
    }
  }
  scanGeneration += 1
  pendingProjectScan = null
  clearPollTimer()
  status = failedImageSearchStatus(status, error)
  emit()
  return true
}

export async function stopImageSearchScan(): Promise<ImageSearchStatus> {
  scanGeneration += 1
  pendingProjectScan = null
  clearPollTimer()
  status = {
    ...status,
    pendingCount: 0,
    message: 'Stopping scan...',
    nativeConnected,
    nativeVersion,
  }
  emit()

  const result = nativeAddon
    ? nativeAddon.stopScanAsync
      ? await nativeAddon.stopScanAsync()
      : nativeAddon.stopScan()
    : { ok: true }
  if (!result.ok) {
    status = {
      ...status,
      state: 'error',
      lastError: result.error || 'Failed to stop scan',
      message: result.error || 'Failed to stop scan.',
      nativeConnected,
      nativeVersion,
    }
    emit()
    return { ...status }
  }
  status = {
    ...status,
    state: 'idle',
    pendingCount: 0,
    currentPath: undefined,
    lastError: undefined,
    message: 'Scan stopped.',
    nativeConnected,
    nativeVersion,
  }
  emit()
  return { ...status }
}

let imageSearchShutdownPromise: Promise<void> | null = null

// Quit handshake: explicitly request cooperative native cancellation, stop any
// scan, await in-flight autosave persistence, then drain the async work
// registry (with a hard timeout so quit can never hang). Idempotent.
export function shutdownImageSearchForQuit(): Promise<void> {
  if (imageSearchShutdownPromise) return imageSearchShutdownPromise
  imageSearchShutdownPromise = (async () => {
    // Stop any in-flight native thumbnail rebuild first; it is a major producer
    // of native async work drained below. Safe when the addon is not loaded
    // (stopNativeThumbnailRebuild degrades to { ok: false }).
    try {
      stopNativeThumbnailRebuild()
    } catch (error) {
      console.warn('[ImageSearch] stopNativeThumbnailRebuild during shutdown failed:', error)
    }
    if (nativeAddon) {
      try {
        const cancelResult = nativeAddon.cancelAsyncWork?.()
        if (cancelResult) {
          console.log(
            '[ImageSearch] cancelAsyncWork: cooperative=',
            cancelResult.cooperativeRequested,
            'nativeCancelled=',
            cancelResult.nativeCancelAccepted,
          )
        }
      } catch (error) {
        console.warn('[ImageSearch] cancelAsyncWork failed:', error)
      }
    }
    try {
      await stopImageSearchScan()
    } catch (error) {
      console.warn('[ImageSearch] stopImageSearchScan during shutdown failed:', error)
    }
    if (autosavePromise) {
      await autosavePromise.catch(() => undefined)
    }
    const drainDeadline = Date.now() + 5000
    while (nativeAddon && Date.now() < drainDeadline) {
      const nativeStatus = nativeAddon.getNativeStatus()
      if ((Number(nativeStatus.asyncWorkActiveCount) || 0) === 0) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  })()
  return imageSearchShutdownPromise
}

export function startNativeThumbnailRebuild(
  roots: string[],
  workers: number,
  requestCuda: boolean,
): { ok: boolean; error?: string } {
  if (!nativeAddon?.startNativeThumbnailRebuild || !defaultThumbnailCachePath) {
    return { ok: false, error: 'Native C++ thumbnail rebuild is unavailable' }
  }
  return nativeAddon.startNativeThumbnailRebuild(
    roots.join('\x1f'),
    defaultThumbnailCachePath,
    THUMBNAIL_CACHE_VERSION,
    workers,
    requestCuda,
  )
}

export function getNativeThumbnailRebuildProgress() {
  return nativeAddon?.getNativeThumbnailRebuildProgress?.()
}

export function stopNativeThumbnailRebuild(): { ok: boolean } {
  return nativeAddon?.stopNativeThumbnailRebuild?.() || { ok: false }
}

export function pauseImageSearchScan(): { ok: boolean } {
  if (nativeAddon?.pauseScan) {
    const result = nativeAddon.pauseScan()
    if (result.ok) {
      status = { ...status, state: 'paused', message: 'Scan paused.' }
      emit()
    }
    return result
  }
  return { ok: false }
}

export function resumeImageSearchScan(): { ok: boolean } {
  if (nativeAddon?.resumeScan) {
    const result = nativeAddon.resumeScan()
    if (result.ok) {
      status = { ...status, state: 'scanning', message: 'Scanning...' }
      emit()
      startPollingScan()
    }
    return result
  }
  return { ok: false }
}

export function isImageSearchScanPaused(): { paused: boolean } {
  if (nativeAddon?.isScanPaused) {
    return nativeAddon.isScanPaused()
  }
  return { paused: false }
}

export function searchImages(args: ImageSearchSearchArgs): ImageSearchSearchResponse {
  if (!nativeAddon) {
    return {
      results: [],
      status: { ...status, message: 'Native not connected', nativeConnected, nativeVersion },
    }
  }

  status = {
    ...status,
    state: 'searching',
    message: 'Searching...',
    nativeConnected,
    nativeVersion,
  }
  emit()

  let raw: NativeSearchResult
  const sm = normalizeSearchMode(args?.searchMode)
  const requestedImagePath = normalizeFsPath(args?.imagePath)
  const imagePath = requestedImagePath ? resolveProjectSearchInputPath(requestedImagePath) : null
  const threshold = clampNumber(args?.threshold, 10, 0, 64)
  const topK = Math.floor(clampNumber(args?.topK, 50, 1, MAX_SEARCH_TOP_K))
  if (imagePath) {
    raw = nativeAddon.searchByImage(imagePath, threshold, topK, sm)
  } else {
    // searchByHash not currently wired through UI query — use empty
    return {
      results: [],
      status: {
        ...status,
        state: 'idle',
        message: 'Use image query.',
        nativeConnected,
        nativeVersion,
      },
    }
  }

  if (!raw.ok) {
    status = { ...status, state: 'error', lastError: raw.error, nativeConnected, nativeVersion }
    emit()
    return { results: [], status: { ...status } }
  }

  const mergedHits = mergeProjectSearchHashFallback(
    raw.results || [],
    raw.queryHash,
    raw.queryDctHash64,
    threshold,
  )
  const results = mapNativeProjectSearchHits(mergedHits)

  status = {
    ...status,
    state: 'idle',
    message: `Found ${results.length} results.`,
    nativeConnected,
    nativeVersion,
  }
  emit()
  return {
    results,
    status: { ...status },
    queryHash: raw.queryHash,
    queryDctHash64: raw.queryDctHash64,
    scannedCount: raw.scannedCount,
    candidateCount: raw.candidateCount,
    resultCount: raw.resultCount ?? results.length,
    searchMs: raw.searchMs,
    mode: raw.mode,
    indexType: raw.indexType,
    bucketSize: raw.bucketSize,
    fallbackUsed: raw.fallbackUsed,
    searchMode: sm,
  }
}

/**
 * Save the index to the authoritative location resolved from main-process
 * state (current segment path, else the userData index root). The renderer
 * cannot influence the write location (PIO-P1-01).
 */
export async function saveImageIndexToDefaultLocation(): Promise<{
  ok: boolean
  recordCount?: number
  error?: string
}> {
  if (!nativeAddon) return { ok: false, error: 'native addon not connected' }
  const target =
    status.segmentPath ||
    defaultSavePath ||
    path.join(process.env.APPDATA || '', 'floating-clock-electron', 'image-search-index')
  const identityBefore = imageSearchDataService.currentLoadedIndexIdentity()
  const result = nativeAddon.saveIndexToManifest(target)
  if (result.ok && identityBefore) {
    await captureIndexIdentityAndReconcile(target, identityBefore)
  }
  return result
}

export function getImageIndexMode(): {
  mode: string
  recordCount: number
  segmentPath: string
  version: number
  pathIndexMapSize?: number
  overlayCount?: number
  replacedCount?: number
  deletedCount?: number
  pathMapHealthy?: boolean
  segmentCount?: number
} {
  if (nativeAddon) return nativeAddon.getIndexMode()
  return {
    mode: 'memory',
    recordCount: 0,
    segmentPath: '',
    version: 0,
    pathIndexMapSize: 0,
    overlayCount: 0,
    replacedCount: 0,
    deletedCount: 0,
  }
}

export function loadImageIndex(filePath: string): { ok: boolean; recordCount?: number } {
  _cachedIndexMode = null // invalidate cache
  imageSearchDataService.clearLoadedIndexIdentity()
  if (nativeAddon) return nativeAddon.loadIndexFromSegment(filePath)
  return { ok: false }
}

export function clearImageIndex(): { ok: boolean } {
  _cachedIndexMode = null // invalidate cache
  const identityBefore = imageSearchDataService.currentLoadedIndexIdentity()
  imageSearchDataService.clearLoadedIndexIdentity()
  if (!nativeAddon) return { ok: false }
  const cleared = nativeAddon.clearIndex()
  if (!cleared?.ok) return cleared
  // Native clearIndex only clears memory; without this the old manifest would
  // revive the index on restart. Persist the empty state when one exists on
  // disk (same semantics as purging the last records, batch 104).
  const rootDir = currentIndexRoot()
  if (fs.existsSync(path.join(rootDir, 'manifest.json'))) {
    const persisted = persistEmptyImageIndex(rootDir)
    if (!persisted.ok) {
      console.warn('[ImageSearch] Cleared index in memory but failed to persist:', persisted.error)
    } else if (identityBefore) {
      void captureIndexIdentityAndReconcile(rootDir, identityBefore)
    }
  }
  return cleared
}

function currentIndexRoot(): string {
  return imageSearchDataService.currentIndexRoot()
}

async function captureIndexIdentityAndReconcile(
  rootDir: string,
  expectedIdentity: ImageSearchIndexIdentitySnapshot,
): Promise<void> {
  try {
    await imageSearchDataService.captureLoadedIndexIdentity(rootDir, expectedIdentity)
    const recovery = await reconcileImageSearchSourceVectorInvalidations()
    if (!recovery.ok) {
      console.warn('[ImageSearch] Source-vector recovery remains pending:', recovery.error)
    }
  } catch (error) {
    console.warn('[ImageSearch] Could not capture loaded index identity:', error)
  }
}

function persistEmptyImageIndex(rootDir: string): ImageSearchDataEditResult {
  return imageSearchDataService.persistEmptyImageIndex(rootDir)
}

async function persistImageIndexEdits(
  knownRemainingCount?: number,
): Promise<ImageSearchDataEditResult> {
  return imageSearchDataService.persistImageIndexEdits(knownRemainingCount)
}

export function queryImageSearchData(
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
  return imageSearchDataService.queryImageSearchData(query, offset, limit)
}

export function snapshotImageSearchData(isCancelled?: () => boolean): Promise<{
  ok: boolean
  records?: ImageSearchDataSnapshotRecord[]
  recordCount?: number
  scanned?: number
  error?: string
}> {
  return imageSearchDataService.snapshotImageSearchData(isCancelled)
}

export function getImageSearchCatalogRevision(): string {
  return imageSearchDataService.getImageSearchCatalogRevision()
}

export function isImageSearchIndexedPath(filePath: string): boolean {
  return imageSearchDataService.isImageSearchIndexedPath(filePath)
}

export function listImageSearchIndexedPaths(): Promise<string[]> {
  return imageSearchDataService.listImageSearchIndexedPaths()
}

export function listImageSearchIndexedThumbnailSources(folder: string): Promise<
  Array<{
    path: string
    mtimeMs: number
  }>
> {
  return imageSearchDataService.listImageSearchIndexedThumbnailSources(folder)
}

export function getImageSearchDataStats(prefix: string): {
  ok: boolean
  count?: number
  totalBytes?: number
  error?: string
} {
  return imageSearchDataService.getImageSearchDataStats(prefix)
}

export function getImageSearchDirNameStats(name: string): {
  ok: boolean
  count?: number
  totalBytes?: number
  error?: string
} {
  return imageSearchDataService.getImageSearchDirNameStats(name)
}

export const clearImageSearchLoadedIndexIdentity = imageSearchDataService.clearLoadedIndexIdentity
export const resolveImageSearchIndexIdentity = imageSearchDataService.resolveIndexIdentity
export const captureImageSearchLoadedIndexIdentity =
  imageSearchDataService.captureLoadedIndexIdentity

export async function prepareImageSearchSourceVectorInvalidation(
  sourcePaths: readonly string[],
): Promise<void> {
  return imageSearchDataService.prepareImageSearchSourceVectorInvalidation(sourcePaths)
}

export async function reconcileImageSearchSourceVectorInvalidations(): Promise<{
  ok: boolean
  vectorRecordsRemoved: number
  pendingIntents: number
  activePendingIntents: number
  deferredIntents: number
  error?: string
}> {
  return imageSearchDataService.reconcileImageSearchSourceVectorInvalidations()
}

async function deleteImageSearchDataImpl(filePath: string): Promise<ImageSearchDataEditResult> {
  return imageSearchDataService.deleteImageSearchData(filePath)
}

async function deleteImageSearchDataPathsImpl(
  filePaths: readonly string[],
  onProgress?: (processed: number, total: number) => void,
  options: ImageSearchBatchDeleteOptions = {},
): Promise<{
  ok: boolean
  removedCount: number
  vectorRecordsRemoved: number
  warnings: string[]
  error?: string
}> {
  return imageSearchDataService.deleteImageSearchDataPaths(filePaths, onProgress, options)
}

async function deleteImageSearchDataFolderImpl(
  folder: string,
  allowedRoots: string[],
  options: ImageSearchFolderDeleteOptions = {},
): Promise<ImageSearchDataEditResult> {
  return imageSearchDataService.deleteImageSearchDataFolder(folder, allowedRoots, options)
}

async function deleteImageSearchDirNameImpl(name: string): Promise<ImageSearchDataEditResult> {
  return imageSearchDataService.deleteImageSearchDirName(name)
}

async function repairImageSearchDataPathImpl(
  oldPath: string,
  newPath: string,
): Promise<ImageSearchDataEditResult> {
  return imageSearchDataService.repairImageSearchDataPath(oldPath, newPath)
}

async function updateImageSearchDataImpl(filePath: string): Promise<ImageSearchDataEditResult> {
  return imageSearchDataService.updateImageSearchData(filePath)
}

export async function deleteImageSearchData(filePath: string): Promise<ImageSearchDataEditResult> {
  return runImageIndexEditMutation(() => deleteImageSearchDataImpl(filePath))
}

export async function deleteImageSearchDataPaths(
  filePaths: readonly string[],
  onProgress?: (processed: number, total: number) => void,
  options: ImageSearchBatchDeleteOptions = {},
): ReturnType<typeof deleteImageSearchDataPathsImpl> {
  try {
    return await runImageIndexMutation(
      () => deleteImageSearchDataPathsImpl(filePaths, onProgress, options),
      options.vectorMaintenanceLease,
    )
  } catch (error) {
    if (error instanceof ImageSearchIndexMutationBusyError) {
      return {
        ok: false,
        removedCount: 0,
        vectorRecordsRemoved: 0,
        warnings: [],
        error: error.message,
      }
    }
    throw error
  }
}

export async function deleteImageSearchDataFolder(
  folder: string,
  allowedRoots: string[],
  options: ImageSearchFolderDeleteOptions = {},
): Promise<ImageSearchDataEditResult> {
  return runImageIndexEditMutation(() =>
    deleteImageSearchDataFolderImpl(folder, allowedRoots, options),
  )
}

export async function deleteImageSearchDirName(name: string): Promise<ImageSearchDataEditResult> {
  return runImageIndexEditMutation(() => deleteImageSearchDirNameImpl(name))
}

export async function repairImageSearchDataPath(
  oldPath: string,
  newPath: string,
): Promise<ImageSearchDataEditResult> {
  return runImageIndexEditMutation(() => repairImageSearchDataPathImpl(oldPath, newPath))
}

export async function updateImageSearchData(filePath: string): Promise<ImageSearchDataEditResult> {
  return runImageIndexEditMutation(() => updateImageSearchDataImpl(filePath))
}

export function loadManifest(rootDir: string): {
  ok: boolean
  recordCount?: number
  segmentCount?: number
  error?: string
} {
  _cachedIndexMode = null // invalidate cache
  imageSearchDataService.clearLoadedIndexIdentity()
  if (nativeAddon && typeof nativeAddon.loadManifest === 'function') {
    const result = nativeAddon.loadManifest(rootDir)
    if (!result.ok) return result
    const removed = purgeGeneratedThumbnailIndexRecords(nativeAddon)
    const recordCount = Math.max(0, Number(result.recordCount || 0) - removed)
    if (removed > 0) {
      const persisted =
        recordCount === 0
          ? persistEmptyImageIndex(rootDir)
          : nativeAddon.saveIndexToManifest(rootDir)
      if (!persisted.ok) {
        return {
          ok: false,
          recordCount,
          segmentCount: result.segmentCount,
          error: `Loaded the image index, but could not persist generated-thumbnail cleanup: ${
            persisted.error || 'unknown persistence error'
          }`,
        }
      }
    }
    return {
      ...result,
      recordCount,
    }
  }
  return { ok: false, error: 'Native addon not connected' }
}

export function repairManifest(rootDir: string): {
  ok: boolean
  recordCount?: number
  segmentCount?: number
  error?: string
} {
  _cachedIndexMode = null // invalidate cache
  if (nativeAddon && typeof nativeAddon.repairManifestFromSegments === 'function') {
    return nativeAddon.repairManifestFromSegments(rootDir)
  }
  return { ok: false, error: 'Native addon not connected' }
}

export function hashImageFile(filePath: string): ImageHashResult {
  if (nativeAddon && typeof nativeAddon.hashImage === 'function') {
    return nativeAddon.hashImage(filePath)
  }
  return { ok: false, error: 'Native addon not connected' }
}

export function compactManifest(rootDir: string): Promise<{
  ok: boolean
  recordCount?: number
  beforeSegments?: number
  removedSegments?: number
  physicalCleanupComplete?: boolean
  cleanupError?: string
  error?: string
}> {
  if (nativeAddon && typeof nativeAddon.compactManifestAsync === 'function') {
    return nativeAddon.compactManifestAsync(rootDir)
  }
  return Promise.resolve({ ok: false, error: 'Native addon not connected' })
}

export function getCompactStatus(): {
  ok: boolean
  segmentCount: number
  compactRecommended: boolean
} {
  if (nativeAddon && typeof nativeAddon.getCompactStatus === 'function') {
    return nativeAddon.getCompactStatus()
  }
  return { ok: false, segmentCount: 0, compactRecommended: false }
}

export function hashImageFileAsync(filePath: string): Promise<ImageHashResult> {
  if (nativeAddon && typeof nativeAddon.hashImageAsync === 'function') {
    return prepareProjectSearchInput(filePath).then((inputPath) =>
      inputPath
        ? nativeAddon!.hashImageAsync(inputPath)
        : { ok: false, error: 'Project file has no searchable content preview' },
    )
  }
  return Promise.resolve({ ok: false, error: 'Native addon not connected' })
}

export async function searchImagesAsync(
  args: ImageSearchSearchArgs,
): Promise<ImageSearchSearchResponse> {
  if (!nativeAddon || typeof nativeAddon.searchByImageAsync !== 'function') {
    return {
      results: [],
      status: { ...status, message: 'Native not connected', nativeConnected, nativeVersion },
    }
  }
  activeImageSearchQueries += 1
  status = {
    ...status,
    state: 'searching',
    message: 'Searching...',
    nativeConnected,
    nativeVersion,
  }
  emit()
  let terminalStatus: ImageSearchStatus | null = null
  try {
    const sm = normalizeSearchMode(args?.searchMode)
    const requestedImagePath = normalizeFsPath(args?.imagePath)
    const imagePath = requestedImagePath
      ? await prepareProjectSearchInput(requestedImagePath)
      : null
    const threshold = clampNumber(args?.threshold, 10, 0, 64)
    const topK = Math.floor(clampNumber(args?.topK, 50, 1, MAX_SEARCH_TOP_K))

    if (!imagePath) {
      terminalStatus = {
        ...status,
        state: 'idle',
        message: requestedImagePath
          ? 'This project file has no searchable content preview.'
          : 'Use image query.',
        nativeConnected,
        nativeVersion,
      }
      return {
        results: [],
        status: { ...terminalStatus },
      }
    }

    const startedAt = Date.now()
    const raw = await nativeAddon.searchByImageAsync(imagePath, threshold, topK, sm)
    if (!raw.ok) {
      terminalStatus = {
        ...status,
        state: 'error',
        lastError: raw.error,
        nativeConnected,
        nativeVersion,
      }
      return { results: [], status: { ...terminalStatus } }
    }
    const mergedHits = mergeProjectSearchHashFallback(
      raw.results || [],
      raw.queryHash,
      raw.queryDctHash64,
      threshold,
    )
    const results = mapNativeProjectSearchHits(mergedHits)
    terminalStatus = {
      ...status,
      state: 'idle',
      message: `Found ${results.length} results.`,
      nativeConnected,
      nativeVersion,
    }
    return {
      results,
      status: { ...terminalStatus },
      queryHash: raw.queryHash,
      queryDctHash64: raw.queryDctHash64,
      scannedCount: raw.scannedCount,
      candidateCount: raw.candidateCount,
      resultCount: results.length,
      // Native searchMs excludes query-image decode/hash time. Report the
      // user-observed end-to-end latency in the UI instead.
      searchMs: Date.now() - startedAt,
      mode: raw.mode,
      indexType: raw.indexType,
      bucketSize: raw.bucketSize,
      fallbackUsed: raw.fallbackUsed,
      searchMode: sm,
    }
  } catch (error) {
    terminalStatus = {
      ...status,
      state: 'error',
      lastError: error instanceof Error ? error.message : String(error),
      nativeConnected,
      nativeVersion,
    }
    return { results: [], status: { ...terminalStatus } }
  } finally {
    activeImageSearchQueries = Math.max(0, activeImageSearchQueries - 1)
    status =
      activeImageSearchQueries === 0
        ? terminalStatus || { ...status, state: 'idle' }
        : {
            ...status,
            state: 'searching',
            message: `Searching (${activeImageSearchQueries} active)...`,
          }
    emit()
  }
}
