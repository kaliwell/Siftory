import { secureIpcMain } from './ipcAuthorization'
import { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  SOURCE_DERIVED_DATA_IPC,
  type ImageSearchSearchArgs,
  type SourceDerivedDataPreview,
  type SourceDerivedDataPreviewRequest,
  type SourceFileSyncPreviewRequest,
} from '../shared/ipc-contract'
import { runtimeFailure } from '../shared/runtimeErrors'
import {
  DEFAULT_VECTOR_SETTINGS,
  type SearchMode,
  type VectorBuildRequest,
  type VectorSettings,
} from '../shared/vectorTypes'
import { safeShellPath } from './pathGuards'
import {
  cancelDownload,
  deleteModel,
  downloadModel,
  getModelStatus,
  initModelService,
  onModelStatusChanged,
} from './modelService'
import {
  importUserModel,
  listUserModelSlots,
  openUserModelFolder,
  removeUserModel,
} from './userModelPlatformService'
import { checkUserModelRuntimeSlots } from './userModelSessionService'
import {
  flushVectorDatabaseWrites,
  getEmbeddingStorePaths,
  initVectorDatabase,
  removeImageDataFolder,
  removeImageDataFolders,
} from './vectorDatabaseService'
import {
  getEmbeddingProgress,
  onEmbeddingProgress,
  pauseEmbeddingBuild,
  resumeEmbeddingBuild,
  startEmbeddingBuild,
  stopEmbeddingBuild,
} from './embeddingService'
import { cancelQueuedEmbeddingBuild, queueEmbeddingBuild } from './embeddingTaskScheduling'
import {
  buildVectorIndex,
  clearVectorIndex,
  getVectorIndexStatus,
  isVectorIndexBuildRunning,
} from './vectorIndexService'
import {
  clearVectorDiagnostics,
  clearVectorFailures,
  compactVectorJobs,
  getVectorFailureRetryCandidates,
  getVectorMaintenanceStats,
} from './vectorMaintenanceService'
import { setHashDelegate, searchLayered, stopLayeredSearch } from './rerankService'
import { invalidateClipEmbeddingCacheMemory, searchSemanticImages } from './semanticSearchService'
import { extractColorFeature } from './colorFeatureService'
import { extractShapeFeature } from './shapeFeatureService'
import {
  hashImageFileAsync,
  deleteImageSearchDataFolder,
  deleteImageSearchDataPaths,
  getImageSearchDataStats,
  getImageIndexMode,
  getImageSearchScopeState,
  getImageSearchStatus,
  isImageSearchIndexMutationRunning,
  isImageSearchIndexedPath,
  isImageSearchQueryRunning,
  listImageSearchIndexedThumbnailSources,
  listImageSearchIndexedPaths,
  prepareImageSearchSourceVectorInvalidation,
  snapshotImageSearchData,
  searchImagesAsync,
} from './imageSearchService'
import {
  handleMediaFrameEmbeddingProgress,
  isMediaFrameIndexBuildPending,
} from './mediaFrameEmbeddingState'
import { getMediaSearchStatus } from './mediaTaskQueue'
import { isMediaSemanticMaintenanceRunning } from './mediaSearchIpc'
import { authorizeFileDragResults } from './fileDragIpc'
import {
  cancelStorageCleanup,
  getStorageCleanupProgress,
  previewStorageCleanup,
  isStorageCleanupActiveFor,
  startStorageCleanup,
} from './storageCleanupService'
import { clearProcessedImageData, previewProcessedImageData } from './derivedDataResetService'
import {
  cancelVectorGc,
  getVectorGcProgress,
  isVectorGcRunning,
  previewVectorGc,
  startVectorGc,
} from './vectorGcService'
import {
  cancelVectorStoreMigration,
  createVectorStoreMigrationPreview,
  getVectorStoreMigrationProgress,
  isVectorStoreMigrationRunning,
  startVectorStoreMigration,
} from './vectorStoreMigrationService'
import {
  deleteProjectSearchDataInFolder,
  getProjectSearchEntriesInFolder,
  mapProjectLayeredResults,
  prepareProjectSearchInput,
} from './projectSearchIndexService'
import {
  getComputeBackendCapability,
  resolveRequestedComputeBackend,
} from './computeBackendService'
import { isImageSearchFolderDataEditRunning } from './imageSearchFolderDataService'
import { isImageSearchDataCatalogBuildRunning } from './imageSearchDataCatalogService'
import {
  executeSourceDerivedDataCleanup,
  getSourceDerivedDataCleanupProgress,
  isSourceDerivedDataCleanupRunning,
  previewSourceDerivedDataCleanup,
} from './sourceDerivedDataCleanupService'
import {
  completeSourceFileSyncAssetLibraryRecovery,
  executeSourceFileSync,
  getExistingSourceFileSyncExecution,
  getSourceFileSyncMutationEpoch,
  getSourceFileSyncProgress,
  isSourceFileSyncRunning,
  prepareSourceFileSyncAssetLibraryRecovery,
  previewSourceFileSync,
  recordSourceFileSyncAssetLibraryRecoveryFailure,
  retrySourceFileSyncAssetLibraryRecovery,
} from './sourceFileSyncService'
import { invalidateEmbeddingLogRetentionCaches } from './embeddingLogRetention'
import { getMediaSearchDir, invalidateMediaCacheStats } from './mediaCacheService'
import { invalidateVideoManifestCache } from './videoScanService'
import { loadVideoManifest, markVideoManifestRecordsMissing } from './videoScanService'
import { invalidateVideoFrameManifestCache } from './videoFrameService'
import { getSourceCatalogService } from './sourceCatalogService'
import { clearMediaSearchImageDataUrlCache } from './mediaSearchImageCache'
import { invalidateTranscriptCaches } from './transcriptService'
import { disposeVectorAnnWorker } from './vectorAnnWorkerHost'
import { disposeSemanticVectorSearchWorker } from './semanticVectorSearchWorkerHost'
import type { UnifiedTaskSubmitter } from './unifiedTaskSubmission'
import { purgeThumbnailCacheForSources } from './thumbnailDiskCache'
import {
  getAssetLibraryTaskProgress,
  isAssetLibraryWorkRunning,
  syncAssetLibraryFromImageIndex,
} from './assetLibraryService'
import { isAssetDerivedRebuildRunning } from './assetDerivedRebuildCoordinator'
import { isImagePreparationRunning } from './imagePreparationPipeline'
import { isEmbeddingF16CacheBuildRunning } from './embeddingF16Cache'
import { isUnifiedSearchRunning } from './unifiedSearchIpc'
import {
  isVectorExclusiveMaintenanceReserved,
  isVectorMutationReservationActive,
  isVectorSearchReservationActive,
  tryAcquireVectorExclusiveMaintenance,
  tryAcquireVectorMutationReservation,
  tryAcquireVectorSearchReservation,
  type VectorExclusiveMaintenanceLease,
} from './vectorMaintenanceService'

type GetMainWindow = () => BrowserWindow | null

type ManagedVectorModelName =
  | 'dinov2_vitb14'
  | 'clip_vit_base_patch32'
  | 'clip_vit_b32_multilingual_v1_text'

const VECTOR_MODEL_NAMES: ReadonlySet<string> = new Set<ManagedVectorModelName>([
  'dinov2_vitb14',
  'clip_vit_base_patch32',
  'clip_vit_b32_multilingual_v1_text',
])

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function normalizeVectorModelName(input: unknown): ManagedVectorModelName | null {
  return typeof input === 'string' && VECTOR_MODEL_NAMES.has(input)
    ? (input as ManagedVectorModelName)
    : null
}

function normalizeLayeredSearchMode(value: unknown): SearchMode {
  return value === 'standard' || value === 'precise' || value === 'fast' ? value : 'fast'
}

function normalizeHashSearchMode(value: string): ImageSearchSearchArgs['searchMode'] {
  return value === 'balanced' || value === 'recall' || value === 'fast' ? value : 'balanced'
}

function normalizeExistingDirectoryList(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const paths: string[] = []
  const seen = new Set<string>()
  for (const value of input) {
    const normalized = safeShellPath(value)
    if (!normalized || seen.has(normalized)) continue
    try {
      if (!fs.statSync(normalized).isDirectory()) continue
    } catch {
      continue
    }
    seen.add(normalized)
    paths.push(normalized)
    if (paths.length >= 64) break
  }
  return paths
}

let vectorSettings: VectorSettings | null = null
let activeVectorSearches = 0

const SOURCE_FILE_SYNC_BUSY_MESSAGE = 'Source file synchronization is running'
const ASSET_LIBRARY_RECOVERY_RETRY_DELAYS_MS = [5_000, 10_000, 30_000, 60_000, 120_000, 300_000]

function tryAcquireVectorMutation(): (() => void) | null {
  if (
    isVectorGcRunning() ||
    isVectorStoreMigrationRunning() ||
    isStorageCleanupActiveFor('vectors')
  ) {
    return null
  }
  return tryAcquireVectorMutationReservation()
}

function tryAcquireVectorMaintenanceReservation(): VectorExclusiveMaintenanceLease | null {
  if (
    isVectorGcRunning() ||
    isVectorStoreMigrationRunning() ||
    isStorageCleanupActiveFor('vectors')
  ) {
    return null
  }
  return tryAcquireVectorExclusiveMaintenance()
}

function getVectorSettingsPath(userDataPath: string): string {
  return path.join(userDataPath, 'vector-settings.json')
}

function loadVectorSettings(userDataPath: string): VectorSettings {
  if (vectorSettings) return vectorSettings
  try {
    const settingsPath = getVectorSettingsPath(userDataPath)
    if (fs.existsSync(settingsPath)) {
      const loadedSettings = {
        ...DEFAULT_VECTOR_SETTINGS,
        ...JSON.parse(fs.readFileSync(settingsPath, 'utf-8')),
      }
      vectorSettings = loadedSettings
      return loadedSettings
    }
  } catch {
    /* use defaults */
  }
  const defaultSettings = { ...DEFAULT_VECTOR_SETTINGS }
  vectorSettings = defaultSettings
  return defaultSettings
}

function saveVectorSettings(userDataPath: string, settings: Partial<VectorSettings>): void {
  vectorSettings = { ...DEFAULT_VECTOR_SETTINGS, ...loadVectorSettings(userDataPath), ...settings }
  try {
    fs.writeFileSync(
      getVectorSettingsPath(userDataPath),
      JSON.stringify(vectorSettings, null, 2),
      'utf-8',
    )
  } catch {
    /* ignore save errors */
  }
}

function sendToRenderer(getMainWindow: GetMainWindow, channel: string, payload: unknown): void {
  const mainWindow = getMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

async function waitForAssetLibraryTask(
  taskId: string,
  timeoutMs = 30 * 60 * 1000,
): Promise<{ ok: boolean; error?: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const task = getAssetLibraryTaskProgress(taskId)
    if (task?.state === 'done') return { ok: true }
    if (task?.state === 'error' || task?.state === 'stopped') {
      return {
        ok: false,
        error:
          task.error ||
          (task.state === 'stopped'
            ? 'Asset library synchronization was stopped'
            : 'Asset library synchronization failed'),
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250)
      timer.unref?.()
    })
  }
  return { ok: false, error: 'Asset library synchronization timed out' }
}

function sourceDerivedDataBusyError(
  options: { ignoreSourceFileSync?: boolean } = {},
): string | null {
  if (isSourceDerivedDataCleanupRunning()) return 'A source cleanup operation is already running'
  if (!options.ignoreSourceFileSync && isSourceFileSyncRunning()) {
    return 'A source synchronization operation is already running'
  }
  if (isImageSearchDataCatalogBuildRunning()) return 'Image Search data catalog analysis is running'
  if (isImageSearchFolderDataEditRunning()) return 'A folder index edit is running'
  if (isImagePreparationRunning()) return 'Image library preparation is running'
  if (isEmbeddingF16CacheBuildRunning()) return 'An embedding cache build is running'
  if (isImageSearchQueryRunning()) return 'An Image Search query is running'
  if (isImageSearchIndexMutationRunning()) return 'An Image Search index edit is running'
  if (isUnifiedSearchRunning()) return 'A unified search is running'
  if (isAssetLibraryWorkRunning()) return 'Asset Library work is running'
  if (isAssetDerivedRebuildRunning()) return 'A derived index rebuild is running'
  if (isMediaFrameIndexBuildPending()) return 'A Media Search frame index build is running'
  if (isVectorStoreMigrationRunning()) return 'Vector store migration is running'
  if (isVectorGcRunning()) return 'Vector garbage collection is running'
  if (
    isStorageCleanupActiveFor('image-search') ||
    isStorageCleanupActiveFor('vectors') ||
    isStorageCleanupActiveFor('media-search')
  ) {
    return 'Storage cleanup is running'
  }
  if (
    ['queued', 'scanning', 'indexing', 'searching', 'paused'].includes(getImageSearchStatus().state)
  ) {
    return 'An Image Search task is running'
  }
  if (['queued', 'running', 'paused', 'stopping'].includes(getEmbeddingProgress().state)) {
    return 'An embedding task is running'
  }
  if (isVectorIndexBuildRunning()) return 'A vector index build is running'
  if (activeVectorSearches > 0) return 'A vector search is running'
  if (isVectorSearchReservationActive()) return 'A vector-backed search is running'
  if (isVectorMutationReservationActive()) return 'A vector mutation is running'
  if (isVectorExclusiveMaintenanceReserved()) return 'Vector maintenance is starting'
  if (getMediaSearchStatus({ includeCounts: false }).state === 'running') {
    return 'A Media Search task is running'
  }
  if (isMediaSemanticMaintenanceRunning()) return 'A Media Search semantic task is running'
  return null
}

function vectorExclusiveConflict(): string | null {
  if (isSourceFileSyncRunning()) return SOURCE_FILE_SYNC_BUSY_MESSAGE
  if (isSourceDerivedDataCleanupRunning()) return 'Source-derived data cleanup is running'
  if (isAssetDerivedRebuildRunning()) return 'A derived index rebuild is running'
  if (isImagePreparationRunning()) return 'Image library preparation is running'
  if (isImageSearchDataCatalogBuildRunning()) return 'Image Search data catalog analysis is running'
  if (isImageSearchFolderDataEditRunning()) return 'A folder index edit is running'
  if (isImageSearchIndexMutationRunning()) return 'An Image Search index edit is running'
  if (isImageSearchQueryRunning() || activeVectorSearches > 0 || isUnifiedSearchRunning()) {
    return 'A search operation is running'
  }
  if (isEmbeddingF16CacheBuildRunning()) return 'An embedding cache build is running'
  if (['queued', 'running', 'paused', 'stopping'].includes(getEmbeddingProgress().state)) {
    return 'An embedding task is running'
  }
  if (isVectorIndexBuildRunning()) return 'A vector index build is running'
  if (isMediaSemanticMaintenanceRunning() || isMediaFrameIndexBuildPending()) {
    return 'A Media Search task is running'
  }
  if (isVectorGcRunning()) return 'Vector garbage collection is running'
  if (isVectorStoreMigrationRunning()) return 'Vector store migration is running'
  if (isStorageCleanupActiveFor('vectors')) return 'Vector storage cleanup is running'
  return null
}

export function registerVectorIpc(
  getMainWindow: GetMainWindow,
  userDataPath: string,
  taskScheduler?: UnifiedTaskSubmitter,
): void {
  initModelService(userDataPath)
  initVectorDatabase(userDataPath)

  let sourceFileSyncMaintenanceLease: VectorExclusiveMaintenanceLease | null = null
  let assetLibraryRecoveryRetryTimer: NodeJS.Timeout | null = null
  let assetLibraryRecoveryRetryAttempt = 0
  let scheduleAssetLibraryRecoveryRetry: () => void = () => undefined
  const sourceFileSyncDependencies = {
    beginMaintenance: () => {
      stopLayeredSearch()
      disposeVectorAnnWorker()
      disposeSemanticVectorSearchWorker()
      clearVectorIndex()
      invalidateClipEmbeddingCacheMemory()
      invalidateVideoManifestCache()
      invalidateVideoFrameManifestCache()
      clearMediaSearchImageDataUrlCache()
      invalidateTranscriptCaches()
      invalidateMediaCacheStats()
      invalidateEmbeddingLogRetentionCaches()
    },
    prepareMutation: (imagePaths: string[]) =>
      prepareImageSearchSourceVectorInvalidation(imagePaths),
    prepareAssetLibraryRecovery: async (sourcePath: string) => {
      await prepareSourceFileSyncAssetLibraryRecovery(userDataPath, sourcePath)
    },
    completeAssetLibraryRecovery: async () => {
      await completeSourceFileSyncAssetLibraryRecovery(userDataPath)
      if (assetLibraryRecoveryRetryTimer) clearTimeout(assetLibraryRecoveryRetryTimer)
      assetLibraryRecoveryRetryTimer = null
      assetLibraryRecoveryRetryAttempt = 0
    },
    recordAssetLibraryRecoveryFailure: async (error: string) => {
      await recordSourceFileSyncAssetLibraryRecoveryFailure(userDataPath, error)
      if (assetLibraryRecoveryRetryTimer) clearTimeout(assetLibraryRecoveryRetryTimer)
      assetLibraryRecoveryRetryTimer = null
      assetLibraryRecoveryRetryAttempt = 0
      scheduleAssetLibraryRecoveryRetry()
    },
    listImageRecords: async () => {
      const snapshot = await snapshotImageSearchData()
      if (snapshot.ok && Array.isArray(snapshot.records)) return snapshot.records
      throw new Error(snapshot.error || 'Could not read the active image index')
    },
    listVideoRecords: () => loadVideoManifest(),
    markCatalogRecordsMissing: (paths: string[]) => ({
      removed: getSourceCatalogService()?.markLocalFileEntriesMissingByPaths(paths) ?? 0,
    }),
    deleteImageRecords: async (
      paths: string[],
      onProgress?: (processed: number, total: number) => void,
    ) => {
      const result = await deleteImageSearchDataPaths(paths, onProgress, {
        sourceVectorIntentPrepared: true,
        vectorMaintenanceLease: sourceFileSyncMaintenanceLease || undefined,
      })
      // A post-persist auxiliary failure can return ok:false after the Native
      // index was already changed. Always retire runtime search snapshots when
      // records were removed so an old ANN/F16 worker cannot serve stale paths.
      if (result.removedCount > 0) {
        stopLayeredSearch()
        disposeVectorAnnWorker()
        disposeSemanticVectorSearchWorker()
        clearVectorIndex()
        invalidateClipEmbeddingCacheMemory()
      }
      return {
        ok: result.ok,
        removed: result.removedCount,
        vectorRecordsRemoved: result.vectorRecordsRemoved,
        warnings: result.warnings,
        error: result.error,
      }
    },
    markVideoRecordsMissing: (videoIds: string[]) => markVideoManifestRecordsMissing(videoIds),
    purgeImageThumbnails: (
      records: Array<{ path: string; modifiedTime?: number }>,
      onProgress?: (processed: number, total: number) => void,
    ) =>
      purgeThumbnailCacheForSources(
        userDataPath,
        records.map((record) => ({ path: record.path, mtimeMs: record.modifiedTime || 0 })),
        {
          onProgress: ({ processed, total }) => onProgress?.(processed, total),
        },
      ),
    startAssetLibrarySync: () =>
      syncAssetLibraryFromImageIndex(undefined, { allowSourceFileSync: true }),
    waitForAssetLibrarySync: (taskId: string) => waitForAssetLibraryTask(taskId),
  }

  scheduleAssetLibraryRecoveryRetry = (): void => {
    if (
      assetLibraryRecoveryRetryTimer ||
      assetLibraryRecoveryRetryAttempt >= ASSET_LIBRARY_RECOVERY_RETRY_DELAYS_MS.length
    ) {
      return
    }
    const delay = ASSET_LIBRARY_RECOVERY_RETRY_DELAYS_MS[assetLibraryRecoveryRetryAttempt]
    assetLibraryRecoveryRetryTimer = setTimeout(() => {
      assetLibraryRecoveryRetryTimer = null
      assetLibraryRecoveryRetryAttempt += 1
      void retrySourceFileSyncAssetLibraryRecovery({
        userDataPath,
        getBusyReason: () => sourceDerivedDataBusyError(),
        acquireMaintenance: () => tryAcquireVectorMaintenanceReservation(),
        startAssetLibrarySync: () =>
          syncAssetLibraryFromImageIndex(undefined, { allowSourceFileSync: true }),
        waitForAssetLibrarySync: (taskId) => waitForAssetLibraryTask(taskId),
      })
        .then((result) => {
          if (result.state === 'completed') {
            console.info('[SourceFileSync] Recovered pending Asset Library synchronization')
          } else if (result.state === 'deferred' || result.state === 'failed') {
            scheduleAssetLibraryRecoveryRetry()
          }
        })
        .catch((error) => {
          // Invalid/checksum-failed markers are deliberately retained. Do not
          // loop on a permanent integrity failure during the same session.
          console.error('[SourceFileSync] Asset Library recovery marker is invalid:', error)
        })
    }, delay)
    assetLibraryRecoveryRetryTimer.unref?.()
  }
  scheduleAssetLibraryRecoveryRetry()

  setHashDelegate({
    searchByImageAsync: (imagePath: string, threshold: number, topK: number, searchMode: string) =>
      searchImagesAsync({
        imagePath,
        threshold,
        topK,
        searchMode: normalizeHashSearchMode(searchMode),
      }),
    hashImageAsync: (imagePath: string) => hashImageFileAsync(imagePath),
    isIndexedPath: (imagePath: string) => isImageSearchIndexedPath(imagePath),
    getIndexedCount: () => getImageSearchStatus().indexedCount,
    listIndexedPaths: () => listImageSearchIndexedPaths(),
    getScopeState: () => getImageSearchScopeState(),
  })

  onModelStatusChanged((status) => {
    sendToRenderer(getMainWindow, 'vector:onModelStatusChanged', status)
  })

  onEmbeddingProgress((progress) => {
    sendToRenderer(getMainWindow, 'vector:onEmbeddingProgress', progress)
    handleMediaFrameEmbeddingProgress(progress)
  })

  secureIpcMain.handle('vector:getModelStatus', async (_event, modelName: unknown) => {
    return getModelStatus(normalizeVectorModelName(modelName) || 'dinov2_vitb14')
  })

  secureIpcMain.handle('vector:getComputeBackendCapability', async () => {
    return getComputeBackendCapability()
  })

  secureIpcMain.handle('vector:downloadModel', async (_event, modelName: unknown) => {
    const normalized = normalizeVectorModelName(modelName)
    if (!normalized) return { ok: false, error: 'Invalid model name' }
    return downloadModel(normalized)
  })

  secureIpcMain.handle('vector:listUserModelSlots', async () => listUserModelSlots())

  secureIpcMain.handle('vector:checkUserModelSlots', async () => checkUserModelRuntimeSlots())

  secureIpcMain.handle(
    'vector:importUserModel',
    async (_event, slotId: unknown, acknowledgement: unknown, profileId: unknown) =>
      importUserModel(slotId, acknowledgement, profileId),
  )

  secureIpcMain.handle('vector:removeUserModel', async (_event, slotId: unknown) =>
    removeUserModel(slotId),
  )

  secureIpcMain.handle('vector:openUserModelFolder', async () => openUserModelFolder())

  secureIpcMain.handle('vector:cancelDownload', async () => {
    return cancelDownload()
  })

  secureIpcMain.handle('vector:deleteModel', async (_event, modelName: unknown) => {
    const normalized = normalizeVectorModelName(modelName)
    if (!normalized) return { ok: false, error: 'Invalid model name' }
    return deleteModel(normalized)
  })

  secureIpcMain.handle('vector:startEmbeddingBuild', async (_event, req: unknown) => {
    if (isSourceFileSyncRunning()) {
      return runtimeFailure('VECTOR_CLEANUP_RUNNING', SOURCE_FILE_SYNC_BUSY_MESSAGE)
    }
    if (isSourceDerivedDataCleanupRunning()) {
      return runtimeFailure('VECTOR_CLEANUP_RUNNING', 'Source-derived data cleanup is running')
    }
    if (isAssetDerivedRebuildRunning()) {
      return runtimeFailure('VECTOR_CLEANUP_RUNNING', 'A derived index rebuild is running')
    }
    if (isVectorIndexBuildRunning()) {
      return runtimeFailure('VECTOR_CLEANUP_RUNNING', 'A vector index build is running')
    }
    if (isImageSearchIndexMutationRunning()) {
      return runtimeFailure('VECTOR_CLEANUP_RUNNING', 'An Image Search index edit is running')
    }
    if (isImageSearchDataCatalogBuildRunning()) {
      return runtimeFailure(
        'VECTOR_CLEANUP_RUNNING',
        'Image Search data catalog analysis is running',
      )
    }
    if (isImageSearchFolderDataEditRunning()) {
      return runtimeFailure('VECTOR_CLEANUP_RUNNING', 'A folder index edit is running')
    }
    if (isVectorGcRunning()) return runtimeFailure('VECTOR_GC_RUNNING')
    if (isVectorStoreMigrationRunning()) {
      return runtimeFailure('VECTOR_MIGRATION_RUNNING')
    }
    if (isStorageCleanupActiveFor('vectors') || isStorageCleanupActiveFor('maintenance')) {
      return runtimeFailure('VECTOR_CLEANUP_RUNNING')
    }
    const r = req as Record<string, unknown> | null | undefined
    if (!r || typeof r.modelName !== 'string') {
      return runtimeFailure('INVALID_REQUEST', 'modelName is required')
    }
    const modelName = normalizeVectorModelName(r.modelName)
    if (!modelName) return runtimeFailure('INVALID_MODEL')
    const releaseMutation = tryAcquireVectorMutation()
    if (!releaseMutation) return runtimeFailure('VECTOR_CLEANUP_RUNNING')
    try {
      const savedSettings = loadVectorSettings(userDataPath)
      const requestedBackend =
        r.backend === 'auto' || r.backend === 'cpu' || r.backend === 'gpu'
          ? r.backend
          : savedSettings.backend
      const backend = await resolveRequestedComputeBackend(requestedBackend)
      if (isSourceFileSyncRunning()) {
        return runtimeFailure('VECTOR_CLEANUP_RUNNING', SOURCE_FILE_SYNC_BUSY_MESSAGE)
      }
      if (isSourceDerivedDataCleanupRunning() || isAssetDerivedRebuildRunning()) {
        return runtimeFailure(
          'VECTOR_CLEANUP_RUNNING',
          'Index maintenance started during preflight',
        )
      }
      const requestedBatchSize = Number(r.batchSize)
      const buildRequest: VectorBuildRequest = {
        modelName,
        embeddingType: r.embeddingType === 'object_crop' ? 'object_crop' : 'global',
        imageIds: Array.isArray(r.imageIds)
          ? r.imageIds
              .map((imageId) => safeShellPath(imageId))
              .filter((imageId): imageId is string => typeof imageId === 'string')
          : undefined,
        scanPaths: normalizeExistingDirectoryList(r.scanPaths),
        backend,
        maxConcurrentEmbeddings: Number(
          r.maxConcurrentEmbeddings || savedSettings.maxConcurrentEmbeddings || 1,
        ),
        batchSize:
          Number.isFinite(requestedBatchSize) && requestedBatchSize >= 0
            ? requestedBatchSize
            : undefined,
      }
      return taskScheduler
        ? queueEmbeddingBuild(buildRequest, taskScheduler)
        : startEmbeddingBuild(buildRequest)
    } finally {
      releaseMutation()
    }
  })

  secureIpcMain.handle('vector:stopEmbeddingBuild', async () => {
    if (cancelQueuedEmbeddingBuild()) return { ok: true }
    return stopEmbeddingBuild()
  })

  secureIpcMain.handle('vector:pauseEmbeddingBuild', async () => {
    return pauseEmbeddingBuild()
  })

  secureIpcMain.handle('vector:resumeEmbeddingBuild', async () => {
    return resumeEmbeddingBuild()
  })

  secureIpcMain.handle('vector:getEmbeddingProgress', async () => {
    return getEmbeddingProgress()
  })

  secureIpcMain.handle('vector:buildVectorIndex', async (_event, modelName: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    if (isImageSearchDataCatalogBuildRunning()) {
      return { ok: false, error: 'Image Search data catalog analysis is running' }
    }
    if (isImageSearchFolderDataEditRunning()) {
      return { ok: false, error: 'A folder index edit is running' }
    }
    if (isSourceDerivedDataCleanupRunning()) {
      return { ok: false, error: 'Source-derived data cleanup is running' }
    }
    if (isAssetDerivedRebuildRunning() || isImageSearchIndexMutationRunning()) {
      return { ok: false, error: 'Index maintenance is running' }
    }
    if (['queued', 'running', 'paused', 'stopping'].includes(getEmbeddingProgress().state)) {
      return { ok: false, error: 'An embedding task is running' }
    }
    if (isVectorGcRunning()) return { ok: false, error: 'Vector GC is running' }
    if (isStorageCleanupActiveFor('vectors')) {
      return { ok: false, error: 'Vector storage cleanup is running' }
    }
    const normalized = normalizeVectorModelName(modelName)
    if (!normalized) return { ok: false, error: 'Invalid model name' }
    const releaseMutation = tryAcquireVectorMutation()
    if (!releaseMutation) return { ok: false, error: 'Vector maintenance is running' }
    try {
      if (isSourceFileSyncRunning() || isSourceDerivedDataCleanupRunning()) {
        return { ok: false, error: 'Source maintenance is running' }
      }
      return await buildVectorIndex(normalized)
    } finally {
      releaseMutation()
    }
  })

  secureIpcMain.handle('vector:getVectorIndexStatus', async () => {
    return getVectorIndexStatus()
  })

  secureIpcMain.handle('vector:searchLayered', async (event, req: unknown) => {
    if (isSourceFileSyncRunning()) {
      return {
        results: [],
        mode: 'fast',
        degraded: true,
        degradationReasons: [SOURCE_FILE_SYNC_BUSY_MESSAGE],
        modelStatus: getModelStatus('dinov2_vitb14'),
        searchMode: 'fast' as const,
      }
    }
    if (isImageSearchFolderDataEditRunning()) {
      return {
        results: [],
        mode: 'fast',
        degraded: true,
        degradationReasons: ['A folder index edit is running'],
        modelStatus: getModelStatus('dinov2_vitb14'),
        searchMode: 'fast' as const,
      }
    }
    const r = req as Record<string, unknown> | null | undefined
    if (!r || typeof r.imagePath !== 'string' || !r.imagePath) {
      return {
        results: [],
        mode: 'fast',
        degraded: true,
        degradationReasons: ['Invalid request: imagePath required'],
        modelStatus: getModelStatus('dinov2_vitb14'),
        searchMode: 'fast' as const,
      }
    }
    const imagePath = safeShellPath(r.imagePath)
    const mode = normalizeLayeredSearchMode(r.mode)
    if (!imagePath) {
      return {
        results: [],
        mode: 'fast',
        degraded: true,
        degradationReasons: ['Invalid request: invalid image path'],
        modelStatus: getModelStatus('dinov2_vitb14'),
        searchMode: 'fast' as const,
      }
    }
    try {
      if (!fs.statSync(imagePath).isFile()) {
        return {
          results: [],
          mode: 'fast',
          degraded: true,
          degradationReasons: ['Invalid request: image path is not a file'],
          modelStatus: getModelStatus('dinov2_vitb14'),
          searchMode: 'fast' as const,
        }
      }
    } catch {
      return {
        results: [],
        mode: 'fast',
        degraded: true,
        degradationReasons: ['Invalid request: image path does not exist'],
        modelStatus: getModelStatus('dinov2_vitb14'),
        searchMode: 'fast' as const,
      }
    }
    const searchEpoch = getSourceFileSyncMutationEpoch()
    const releaseSearch = tryAcquireVectorSearchReservation()
    if (!releaseSearch) {
      return {
        results: [],
        mode,
        degraded: true,
        degradationReasons: ['Vector maintenance is running'],
        modelStatus: getModelStatus('dinov2_vitb14'),
        searchMode: mode,
      }
    }
    activeVectorSearches += 1
    try {
      const searchInputPath = await prepareProjectSearchInput(imagePath)
      if (!searchInputPath) {
        return {
          results: [],
          mode,
          degraded: true,
          degradationReasons: ['Project file has no searchable content preview'],
          modelStatus: getModelStatus('dinov2_vitb14'),
          searchMode: mode,
        }
      }
      const savedSettings = loadVectorSettings(userDataPath)
      const response = await searchLayered(
        {
          imagePath: searchInputPath,
          mode,
          requestId: typeof r.requestId === 'string' ? r.requestId : undefined,
          hashThreshold: typeof r.hashThreshold === 'number' ? r.hashThreshold : undefined,
          hashTopK: typeof r.hashTopK === 'number' ? r.hashTopK : undefined,
          vectorTopK: typeof r.vectorTopK === 'number' ? r.vectorTopK : undefined,
          rerankTopK: typeof r.rerankTopK === 'number' ? r.rerankTopK : undefined,
          timeoutMs: typeof r.timeoutMs === 'number' ? r.timeoutMs : undefined,
          backend: savedSettings.backend === 'gpu' ? 'gpu' : 'cpu',
        },
        (progress) => {
          sendToRenderer(getMainWindow, 'vector:onLayeredSearchProgress', progress)
        },
      )
      if (isSourceFileSyncRunning() || searchEpoch !== getSourceFileSyncMutationEpoch()) {
        return {
          results: [],
          mode,
          degraded: true,
          degradationReasons: [
            'Search results were discarded because source synchronization changed the index',
          ],
          modelStatus: getModelStatus('dinov2_vitb14'),
          searchMode: mode,
        }
      }
      return {
        ...response,
        results: authorizeFileDragResults(
          event.sender.id,
          mapProjectLayeredResults(response.results),
          (result) => result.path,
        ),
      }
    } catch (err: unknown) {
      return {
        results: [],
        mode,
        degraded: true,
        degradationReasons: [errorMessage(err)],
        modelStatus: getModelStatus('dinov2_vitb14'),
        searchMode: mode,
      }
    } finally {
      activeVectorSearches = Math.max(0, activeVectorSearches - 1)
      releaseSearch()
    }
  })

  secureIpcMain.handle('vector:stopLayeredSearch', async () => {
    stopLayeredSearch()
    return { ok: true }
  })

  secureIpcMain.handle('vector:searchSemantic', async (event, req: unknown) => {
    if (isSourceFileSyncRunning()) {
      return {
        results: [],
        query: '',
        totalCandidates: 0,
        totalMs: 0,
        degraded: true,
        degradationReasons: [SOURCE_FILE_SYNC_BUSY_MESSAGE],
        searchMode: 'semantic' as const,
      }
    }
    if (isImageSearchFolderDataEditRunning()) {
      return {
        results: [],
        query: '',
        totalCandidates: 0,
        totalMs: 0,
        degraded: true,
        degradationReasons: ['A folder index edit is running'],
        searchMode: 'semantic' as const,
      }
    }
    const r = req as Record<string, unknown> | null | undefined
    const text = typeof r?.text === 'string' ? r.text : ''
    if (!text.trim()) {
      return {
        results: [],
        query: '',
        totalCandidates: 0,
        totalMs: 0,
        degraded: true,
        degradationReasons: ['Semantic query text is empty.'],
        searchMode: 'semantic' as const,
      }
    }
    const searchEpoch = getSourceFileSyncMutationEpoch()
    const releaseSearch = tryAcquireVectorSearchReservation()
    if (!releaseSearch) {
      return {
        results: [],
        query: text,
        totalCandidates: 0,
        totalMs: 0,
        degraded: true,
        degradationReasons: ['Vector maintenance is running'],
        searchMode: 'semantic' as const,
      }
    }
    activeVectorSearches += 1
    try {
      const response = await searchSemanticImages(
        {
          text,
          topK: typeof r?.topK === 'number' ? r.topK : undefined,
          requestId: typeof r?.requestId === 'string' ? r.requestId : undefined,
          feedbackMode:
            r?.feedbackMode === 'off' || r?.feedbackMode === 'force' ? r.feedbackMode : 'auto',
        },
        (progress) => {
          sendToRenderer(getMainWindow, 'vector:onSemanticSearchProgress', progress)
        },
      )
      if (isSourceFileSyncRunning() || searchEpoch !== getSourceFileSyncMutationEpoch()) {
        return {
          results: [],
          query: text,
          totalCandidates: 0,
          totalMs: response.totalMs,
          degraded: true,
          degradationReasons: [
            'Search results were discarded because source synchronization changed the index',
          ],
          searchMode: 'semantic' as const,
        }
      }
      return {
        ...response,
        results: authorizeFileDragResults(
          event.sender.id,
          mapProjectLayeredResults(response.results),
          (result) => result.path,
        ),
      }
    } finally {
      activeVectorSearches = Math.max(0, activeVectorSearches - 1)
      releaseSearch()
    }
  })

  secureIpcMain.handle('vector:extractFeatures', async (_event, req: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    if (isImageSearchFolderDataEditRunning()) {
      return { ok: false, error: 'A folder index edit is running' }
    }
    const r = req as Record<string, unknown> | null | undefined
    if (!r || !Array.isArray(r.imageIds)) {
      return { ok: false, error: 'Invalid request: imageIds array required' }
    }
    const releaseMutation = tryAcquireVectorMutation()
    if (!releaseMutation) {
      return { ok: false, error: 'Vector maintenance is running' }
    }
    try {
      const imageIds: string[] = r.imageIds as string[]
      const featureTypes: string[] = (r.featureTypes as string[]) || []
      for (const imageId of imageIds) {
        if (featureTypes.includes('color')) {
          await extractColorFeature(imageId)
        }
        if (featureTypes.includes('shape')) {
          await extractShapeFeature(imageId)
        }
      }
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) }
    } finally {
      releaseMutation()
    }
  })

  secureIpcMain.handle('vector:getFeatureProgress', async () => {
    return { total: 0, completed: 0, failed: 0, state: 'done' as const }
  })

  secureIpcMain.handle('vector:getVectorSettings', async () => {
    return loadVectorSettings(userDataPath)
  })

  secureIpcMain.handle(
    'vector:saveVectorSettings',
    async (_event, settings: Partial<VectorSettings>) => {
      saveVectorSettings(userDataPath, settings)
      return { ok: true }
    },
  )

  secureIpcMain.handle('vector:getVectorMaintenanceStats', async () => {
    const imageState = getImageSearchStatus().state
    const embeddingState = getEmbeddingProgress().state
    const mediaState = getMediaSearchStatus({ includeCounts: false }).state
    return getVectorMaintenanceStats({
      imageSearch: ['queued', 'scanning', 'indexing', 'searching', 'paused'].includes(imageState)
        ? 'active'
        : 'idle',
      vectors: ['queued', 'running', 'paused', 'stopping'].includes(embeddingState)
        ? 'active'
        : 'idle',
      mediaSearch: mediaState === 'running' ? 'active' : 'idle',
      assetLibrary: 'unknown',
    })
  })

  secureIpcMain.handle('vector:previewStorageCleanup', async () => {
    return previewStorageCleanup(userDataPath)
  })

  secureIpcMain.handle('vector:startStorageCleanup', async (_event, request: unknown) => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    if (isImageSearchDataCatalogBuildRunning()) {
      return { ok: false, error: 'Image Search data catalog analysis is running' }
    }
    if (isImageSearchFolderDataEditRunning()) {
      return { ok: false, error: 'A folder index edit is running' }
    }
    if (isVectorStoreMigrationRunning()) {
      return { ok: false, error: 'Vector store migration is running' }
    }
    if (isSourceDerivedDataCleanupRunning() || isAssetDerivedRebuildRunning()) {
      return { ok: false, error: 'Index maintenance is running' }
    }
    const raw = request as { token?: unknown; selectedIds?: unknown } | null
    if (
      !raw ||
      typeof raw.token !== 'string' ||
      !Array.isArray(raw.selectedIds) ||
      !raw.selectedIds.every((id) => typeof id === 'string')
    ) {
      return { ok: false, error: 'Invalid cleanup confirmation' }
    }
    const blockedDomains = new Set<
      'image-search' | 'vectors' | 'media-search' | 'asset-library' | 'maintenance'
    >()
    if (
      ['queued', 'scanning', 'indexing', 'searching', 'paused'].includes(
        getImageSearchStatus().state,
      )
    ) {
      blockedDomains.add('image-search')
    }
    if (['queued', 'running', 'paused', 'stopping'].includes(getEmbeddingProgress().state)) {
      blockedDomains.add('vectors')
      blockedDomains.add('maintenance')
    }
    if (getMediaSearchStatus({ includeCounts: false }).state === 'running') {
      blockedDomains.add('media-search')
    }
    const releaseReservation = tryAcquireVectorMaintenanceReservation()
    if (!releaseReservation) {
      return { ok: false, error: 'Another vector maintenance operation is running' }
    }
    try {
      if (isSourceFileSyncRunning() || isSourceDerivedDataCleanupRunning()) {
        return { ok: false, error: 'Source maintenance is running' }
      }
      return startStorageCleanup(
        userDataPath,
        { token: raw.token, selectedIds: raw.selectedIds as string[] },
        blockedDomains,
      )
    } finally {
      releaseReservation()
    }
  })

  secureIpcMain.handle('vector:getStorageCleanupProgress', async () => {
    return getStorageCleanupProgress()
  })

  secureIpcMain.handle('vector:cancelStorageCleanup', async () => {
    return cancelStorageCleanup()
  })

  secureIpcMain.handle('vector:previewProcessedImageData', async () => {
    return previewProcessedImageData(userDataPath)
  })

  secureIpcMain.handle('vector:clearProcessedImageData', async () => {
    const busy = (error: string) => ({
      ok: false,
      freedBytes: 0,
      deletedFiles: 0,
      error,
      errors: [] as string[],
    })
    if (isSourceFileSyncRunning()) return busy(SOURCE_FILE_SYNC_BUSY_MESSAGE)
    if (isImageSearchDataCatalogBuildRunning()) {
      return busy('Image Search data catalog analysis is running')
    }
    if (isImageSearchFolderDataEditRunning()) {
      return busy('A folder index edit is running')
    }
    if (isVectorStoreMigrationRunning()) {
      return busy('Vector store migration is running')
    }
    if (isStorageCleanupActiveFor('image-search') || isStorageCleanupActiveFor('vectors')) {
      return busy('Storage cleanup is running')
    }
    if (
      ['queued', 'scanning', 'indexing', 'searching', 'paused'].includes(
        getImageSearchStatus().state,
      )
    ) {
      return busy('An Image Search task is running')
    }
    if (['queued', 'running', 'paused', 'stopping'].includes(getEmbeddingProgress().state)) {
      return busy('An embedding task is running')
    }
    if (getMediaSearchStatus({ includeCounts: false }).state === 'running') {
      return busy('A Media Search task is running')
    }
    const releaseMutation = tryAcquireVectorMaintenanceReservation()
    if (!releaseMutation) return busy('Vector maintenance is running')
    try {
      if (isSourceFileSyncRunning()) return busy(SOURCE_FILE_SYNC_BUSY_MESSAGE)
      return await clearProcessedImageData(userDataPath)
    } finally {
      releaseMutation()
    }
  })

  secureIpcMain.handle(SOURCE_DERIVED_DATA_IPC.SYNC_PREVIEW, async (_event, raw: unknown) => {
    const busy = sourceDerivedDataBusyError()
    if (busy) {
      return {
        ok: false,
        checkedImageRecords: 0,
        checkedVideoRecords: 0,
        missingImageRecords: 0,
        missingVideoRecords: 0,
        inaccessibleRecords: 0,
        staleIndexedSourceBytes: 0,
        originalFilesAffected: 0,
        warnings: [],
        error: busy,
      }
    }
    const request = raw as Partial<SourceFileSyncPreviewRequest> | null
    const sourcePath = safeShellPath(request?.sourcePath)
    if (!sourcePath) {
      return {
        ok: false,
        checkedImageRecords: 0,
        checkedVideoRecords: 0,
        missingImageRecords: 0,
        missingVideoRecords: 0,
        inaccessibleRecords: 0,
        staleIndexedSourceBytes: 0,
        originalFilesAffected: 0,
        warnings: [],
        error: 'Invalid source folder path',
      }
    }
    return previewSourceFileSync({
      sourcePath,
      dependencies: sourceFileSyncDependencies,
    })
  })

  secureIpcMain.handle(SOURCE_DERIVED_DATA_IPC.SYNC_EXECUTE, async (_event, raw: unknown) => {
    const token = typeof raw === 'string' ? raw.slice(0, 256) : ''
    const existing = getExistingSourceFileSyncExecution(token)
    if (existing) return existing
    const busy = sourceDerivedDataBusyError({ ignoreSourceFileSync: true })
    if (busy) {
      return {
        ok: false,
        imageRecordsRemoved: 0,
        imageVectorRecordsRemoved: 0,
        videoRecordsMarkedMissing: 0,
        recoveredBeforeApply: 0,
        thumbnailFilesRemoved: 0,
        freedBytes: 0,
        assetLibrarySyncStarted: false,
        originalFilesAffected: 0,
        warnings: [],
        error: busy,
      }
    }
    const releaseMaintenance = tryAcquireVectorMaintenanceReservation()
    if (!releaseMaintenance) {
      return {
        ok: false,
        imageRecordsRemoved: 0,
        imageVectorRecordsRemoved: 0,
        videoRecordsMarkedMissing: 0,
        recoveredBeforeApply: 0,
        thumbnailFilesRemoved: 0,
        freedBytes: 0,
        assetLibrarySyncStarted: false,
        originalFilesAffected: 0,
        warnings: [],
        error: 'Vector search or maintenance started before source synchronization',
      }
    }
    try {
      sourceFileSyncMaintenanceLease = releaseMaintenance
      return await executeSourceFileSync({ token, dependencies: sourceFileSyncDependencies })
    } finally {
      sourceFileSyncMaintenanceLease = null
      releaseMaintenance()
    }
  })

  secureIpcMain.handle(SOURCE_DERIVED_DATA_IPC.SYNC_PROGRESS, async () =>
    getSourceFileSyncProgress(),
  )

  secureIpcMain.handle(SOURCE_DERIVED_DATA_IPC.PREVIEW, async (_event, rawRequest: unknown) => {
    const failure = (error: string): SourceDerivedDataPreview => ({
      ok: false,
      categories: [],
      imageRecords: 0,
      videoRecords: 0,
      totalRecords: 0,
      fileCount: 0,
      estimatedBytes: 0,
      originalFilesAffected: 0,
      warnings: [],
      error,
    })
    const busy = sourceDerivedDataBusyError()
    if (busy) return failure(busy)
    const request = rawRequest as Partial<SourceDerivedDataPreviewRequest> | null
    const sourcePath = safeShellPath(request?.sourcePath)
    if (!sourcePath) return failure('Invalid source folder path')
    try {
      const native = getImageSearchDataStats(sourcePath)
      if (!native.ok) throw new Error(native.error || 'Could not read the active image index')
      // Resolve every Native input before creating a confirmable cleanup plan.
      // A failed export is not a successfully exported empty index.
      const thumbnailSources = await listImageSearchIndexedThumbnailSources(sourcePath)
      const nativeMode = getImageIndexMode()
      const projectEntries = getProjectSearchEntriesInFolder(sourcePath)
      const historyPolicy =
        request?.historyPolicy === 'remove-source-traces'
          ? 'remove-source-traces'
          : 'preserve-audit'
      return await previewSourceDerivedDataCleanup({
        userDataPath,
        mediaRoot: getMediaSearchDir(),
        sourcePath,
        nativeStats: {
          count: native.count || 0,
          totalBytes: native.totalBytes || 0,
          replacedCount: nativeMode.replacedCount || 0,
          deletedCount: nativeMode.deletedCount || 0,
        },
        thumbnailSources,
        historyPolicy,
        additionalImagePaths: projectEntries.flatMap((entry) =>
          entry.previewPath ? [entry.previewPath] : [],
        ),
      })
    } catch (error) {
      return failure(errorMessage(error))
    }
  })

  secureIpcMain.handle(SOURCE_DERIVED_DATA_IPC.EXECUTE, async (_event, rawToken: unknown) => {
    const busy = sourceDerivedDataBusyError()
    if (busy) {
      return {
        ok: false,
        imageRecordsRemoved: 0,
        videoRecordsRemoved: 0,
        totalRecordsRemoved: 0,
        deletedFiles: 0,
        freedBytes: 0,
        originalFilesAffected: 0,
        warnings: [],
        error: busy,
      }
    }
    const token = typeof rawToken === 'string' ? rawToken.slice(0, 256) : ''
    if (!token) {
      return {
        ok: false,
        imageRecordsRemoved: 0,
        videoRecordsRemoved: 0,
        totalRecordsRemoved: 0,
        deletedFiles: 0,
        freedBytes: 0,
        originalFilesAffected: 0,
        warnings: [],
        error: 'Invalid source cleanup confirmation',
      }
    }
    const releaseReservation = tryAcquireVectorMaintenanceReservation()
    if (!releaseReservation) {
      return {
        ok: false,
        imageRecordsRemoved: 0,
        videoRecordsRemoved: 0,
        totalRecordsRemoved: 0,
        deletedFiles: 0,
        freedBytes: 0,
        originalFilesAffected: 0,
        warnings: [],
        error: 'Another index maintenance operation is running',
      }
    }
    try {
      const { invalidateFrameIndex } = await import('./mediaSearchFrameIndex')
      const invalidateRuntimeCaches = () => {
        stopLayeredSearch()
        disposeVectorAnnWorker()
        disposeSemanticVectorSearchWorker()
        clearVectorIndex()
        invalidateClipEmbeddingCacheMemory()
        invalidateFrameIndex()
        invalidateVideoManifestCache()
        invalidateVideoFrameManifestCache()
        clearMediaSearchImageDataUrlCache()
        invalidateTranscriptCaches()
        invalidateMediaCacheStats()
        invalidateEmbeddingLogRetentionCaches()
      }
      return await executeSourceDerivedDataCleanup({
        userDataPath,
        token,
        hooks: {
          invalidateRuntimeCaches,
          image: {
            deleteNative: (folder) =>
              deleteImageSearchDataFolder(folder, [folder], { compactAfterDelete: true }),
            cleanupAuxiliary: async (folder, layers) => {
              const result = await removeImageDataFolder(folder, layers)
              return { removed: result.removed }
            },
            invalidateRuntimeCaches: () => invalidateRuntimeCaches(),
          },
          cleanupImageArtifacts: async (_sources, folder) => {
            const projectPreviewPaths = getProjectSearchEntriesInFolder(folder).flatMap((entry) =>
              entry.previewPath ? [entry.previewPath] : [],
            )
            const projectVectors = await removeImageDataFolders(projectPreviewPaths, [
              'native',
              'dino',
              'clip',
            ])
            const projects = await deleteProjectSearchDataInFolder(folder)
            return {
              deletedFiles: projects.deletedFiles,
              freedBytes: projects.freedBytes,
              removedRecords: projects.removedEntries + projectVectors.removed,
              warnings: projects.warnings,
            }
          },
          cleanupLegacyFrameVectors: async (frameRoots) => {
            const result = await removeImageDataFolders(frameRoots, ['dino', 'clip'])
            return { removed: result.removed }
          },
        },
      })
    } finally {
      releaseReservation()
    }
  })

  secureIpcMain.handle(SOURCE_DERIVED_DATA_IPC.PROGRESS, async () =>
    getSourceDerivedDataCleanupProgress(),
  )

  secureIpcMain.handle('vector:previewVectorGc', async () => {
    const conflict = vectorExclusiveConflict()
    if (conflict) throw new Error(conflict)
    if (isSourceFileSyncRunning()) {
      throw new Error(SOURCE_FILE_SYNC_BUSY_MESSAGE)
    }
    if (isImageSearchDataCatalogBuildRunning()) {
      throw new Error('Finish the Image Search data catalog analysis before previewing vector GC')
    }
    if (isImageSearchFolderDataEditRunning()) {
      throw new Error('Finish the folder index edit before previewing vector GC')
    }
    const imageStatus = getImageSearchStatus()
    const embeddingStatus = getEmbeddingProgress()
    if (['queued', 'running', 'paused', 'stopping'].includes(embeddingStatus.state)) {
      throw new Error('Stop the active embedding task before previewing vector GC')
    }
    if (isVectorStoreMigrationRunning()) {
      throw new Error('Finish vector store migration before previewing vector GC')
    }
    if (!imageStatus.segmentPath) throw new Error('Image Search index is not loaded')
    const releaseReservation = tryAcquireVectorMaintenanceReservation()
    if (!releaseReservation) throw new Error('Another vector maintenance operation is running')
    try {
      return await previewVectorGc(userDataPath, imageStatus.segmentPath)
    } finally {
      releaseReservation()
    }
  })

  secureIpcMain.handle('vector:startVectorGc', async (_event, token: unknown) => {
    const conflict = vectorExclusiveConflict()
    if (conflict) return { ok: false, error: conflict }
    if (isSourceFileSyncRunning()) {
      return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    if (isImageSearchDataCatalogBuildRunning()) {
      return { ok: false, error: 'Image Search data catalog analysis is running' }
    }
    if (isImageSearchFolderDataEditRunning()) {
      return { ok: false, error: 'A folder index edit is running' }
    }
    if (typeof token !== 'string' || !token) {
      return { ok: false, error: 'Invalid Vector GC confirmation' }
    }
    const embeddingStatus = getEmbeddingProgress()
    if (['queued', 'running', 'paused', 'stopping'].includes(embeddingStatus.state)) {
      return { ok: false, error: 'Stop the active embedding task before vector GC' }
    }
    if (isStorageCleanupActiveFor('vectors')) {
      return { ok: false, error: 'Vector storage cleanup is running' }
    }
    if (isVectorStoreMigrationRunning()) {
      return { ok: false, error: 'Vector store migration is running' }
    }
    const releaseReservation = tryAcquireVectorMaintenanceReservation()
    if (!releaseReservation) {
      return { ok: false, error: 'Another vector maintenance operation is running' }
    }
    try {
      // Drain the serial embedding append chain (which also carries the D3
      // increment double-write) so no append can interleave with the GC
      // compaction; the compaction re-stats the sources afterwards.
      await flushVectorDatabaseWrites()
      const postflightConflict = vectorExclusiveConflict()
      if (postflightConflict) return { ok: false, error: postflightConflict }
      return startVectorGc(token)
    } finally {
      releaseReservation()
    }
  })

  secureIpcMain.handle('vector:getVectorGcProgress', async () => getVectorGcProgress())

  secureIpcMain.handle('vector:cancelVectorGc', async () => cancelVectorGc())

  secureIpcMain.handle('vector:previewVectorStoreMigration', async () => {
    const conflict = vectorExclusiveConflict()
    if (conflict) throw new Error(conflict)
    if (isSourceFileSyncRunning()) {
      throw new Error(SOURCE_FILE_SYNC_BUSY_MESSAGE)
    }
    if (isImageSearchDataCatalogBuildRunning()) {
      throw new Error(
        'Finish the Image Search data catalog analysis before migrating vector storage',
      )
    }
    if (isImageSearchFolderDataEditRunning()) {
      throw new Error('Finish the folder index edit before migrating vector storage')
    }
    const embeddingStatus = getEmbeddingProgress()
    if (['queued', 'running', 'paused', 'stopping'].includes(embeddingStatus.state)) {
      throw new Error('Stop the active embedding task before migrating vector storage')
    }
    if (isVectorGcRunning() || isStorageCleanupActiveFor('vectors')) {
      throw new Error('Finish the active vector maintenance task before migration')
    }
    const cacheDir = path.join(userDataPath, 'vector-db', 'embedding-cache')
    const releaseReservation = tryAcquireVectorMaintenanceReservation()
    if (!releaseReservation) throw new Error('Another vector maintenance operation is running')
    try {
      return await createVectorStoreMigrationPreview(userDataPath, [
        {
          cacheDir,
          modelName: 'clip_vit_base_patch32',
          embeddingType: 'global',
          dim: 512,
          sourcePaths: getEmbeddingStorePaths('clip_vit_base_patch32', 'global'),
        },
        {
          cacheDir,
          modelName: 'dinov2_vitb14',
          embeddingType: 'global',
          dim: 768,
          sourcePaths: getEmbeddingStorePaths('dinov2_vitb14', 'global'),
        },
      ])
    } finally {
      releaseReservation()
    }
  })

  secureIpcMain.handle('vector:startVectorStoreMigration', async (_event, token: unknown) => {
    const conflict = vectorExclusiveConflict()
    if (conflict) return { ok: false, error: conflict }
    if (isSourceFileSyncRunning()) {
      return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    if (isImageSearchDataCatalogBuildRunning()) {
      return { ok: false, error: 'Image Search data catalog analysis is running' }
    }
    if (isImageSearchFolderDataEditRunning()) {
      return { ok: false, error: 'A folder index edit is running' }
    }
    if (typeof token !== 'string' || !token) {
      return { ok: false, error: 'Invalid vector store migration confirmation' }
    }
    const embeddingStatus = getEmbeddingProgress()
    if (['queued', 'running', 'paused', 'stopping'].includes(embeddingStatus.state)) {
      return { ok: false, error: 'Stop the active embedding task before migration' }
    }
    if (isVectorGcRunning() || isStorageCleanupActiveFor('vectors')) {
      return { ok: false, error: 'Another vector maintenance task is running' }
    }
    const releaseReservation = tryAcquireVectorMaintenanceReservation()
    if (!releaseReservation) {
      return { ok: false, error: 'Another vector maintenance operation is running' }
    }
    try {
      // Drain the serial embedding append chain (which also carries the D3
      // increment double-write) before the migration re-stats the sources;
      // extendEmbeddingF16Cache's closed-loop stat re-check stays as backstop.
      await flushVectorDatabaseWrites()
      const postflightConflict = vectorExclusiveConflict()
      if (postflightConflict) return { ok: false, error: postflightConflict }
      return startVectorStoreMigration(userDataPath, token)
    } finally {
      releaseReservation()
    }
  })

  secureIpcMain.handle('vector:getVectorStoreMigrationProgress', async () => {
    return getVectorStoreMigrationProgress()
  })

  secureIpcMain.handle('vector:cancelVectorStoreMigration', async () => {
    return cancelVectorStoreMigration()
  })

  secureIpcMain.handle('vector:getVectorFailureRetryCandidates', async (_event, req: unknown) => {
    const r = req as Record<string, unknown> | null | undefined
    const modelName = normalizeVectorModelName(r?.modelName)
    const reason = typeof r?.reason === 'string' ? r.reason.slice(0, 160) : undefined
    const limit = Math.max(1, Math.min(5000, Number(r?.limit) || 500))
    return getVectorFailureRetryCandidates({
      ...(modelName ? { modelName } : {}),
      ...(reason ? { reason } : {}),
      limit,
    })
  })

  secureIpcMain.handle('vector:clearVectorDiagnostics', async () => {
    return clearVectorDiagnostics()
  })

  secureIpcMain.handle('vector:clearVectorFailures', async () => {
    return clearVectorFailures()
  })

  secureIpcMain.handle('vector:compactVectorJobs', async () => {
    if (isSourceFileSyncRunning()) {
      return { ok: false, error: SOURCE_FILE_SYNC_BUSY_MESSAGE }
    }
    if (isImageSearchFolderDataEditRunning()) {
      return { ok: false, error: 'A folder index edit is running' }
    }
    return compactVectorJobs()
  })
}
