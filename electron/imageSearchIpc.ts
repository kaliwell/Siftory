import { secureIpcMain } from './ipcAuthorization'
import { app, clipboard, dialog, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  captureImageSearchLoadedIndexIdentity,
  clearImageIndex,
  deleteImageSearchData,
  deleteImageSearchDataFolder,
  deleteImageSearchDirName,
  getImageIndexMode,
  getImageSearchDataStats,
  getImageSearchDirNameStats,
  getImageSearchStatus,
  hashImageFileAsync,
  isImageSearchIndexMutationRunning,
  isImageSearchScanPaused,
  loadImageIndex,
  loadManifest,
  pauseImageSearchScan,
  queryImageSearchData,
  reconcileImageSearchSourceVectorInvalidations,
  repairImageSearchDataPath,
  repairManifest,
  resolveImageSearchIndexIdentity,
  resumeImageSearchScan,
  saveImageIndexToDefaultLocation,
  searchImagesAsync,
  startImageSearchScan,
  stopImageSearchScan,
  updateImageSearchData,
} from './imageSearchService'
import { openSafeShellPath, revealSafeShellPath, safeShellPath } from './pathGuards'
import { readJSON } from './settingsStore'
import { isStorageCleanupActiveFor } from './storageCleanupService'
import { isVectorGcRunning } from './vectorGcService'
import { isVectorStoreMigrationRunning } from './vectorStoreMigrationService'
import { getEmbeddingProgress } from './embeddingService'
import { isEmbeddingF16CacheBuildRunning } from './embeddingF16Cache'
import {
  invalidateClipEmbeddingCacheMemory,
  isClipEmbeddingCacheBuildRunning,
} from './semanticSearchService'
import { clearVectorIndex } from './vectorIndexService'
import { disposeVectorAnnWorker } from './vectorAnnWorkerHost'
import { disposeSemanticVectorSearchWorker } from './semanticVectorSearchWorkerHost'
import { stopLayeredSearch } from './rerankService'
import { removeImageDataFolder } from './vectorDatabaseService'
import {
  cancelImageSearchFolderDataEdit,
  executeImageSearchFolderDataEdit,
  getImageSearchFolderDataEditProgress,
  isImageSearchFolderDataEditRunning,
  previewImageSearchFolderDataEdit,
} from './imageSearchFolderDataService'
import {
  cancelImageSearchDataCatalogBuild,
  getImageSearchDataCatalogProgress,
  getImageSearchDataOverview,
  isImageSearchDataCatalogBuildRunning,
  listImageSearchDataFolders,
  resolveImageSearchDataStoreLocation,
  startImageSearchDataCatalogBuild,
} from './imageSearchDataCatalogService'
import { authorizeFileDragResults } from './fileDragIpc'
import type {
  ImageSearchFolderDataLayer,
  ImageSearchDataFolderQuery,
  ImageSearchPrepareLibraryArgs,
  ImageSearchSearchArgs,
  ImageSearchStartScanArgs,
} from '../shared/ipc-contract'
import { IMAGE_SEARCH_IPC } from '../shared/ipc-contract'
import { submitUnifiedTask, type UnifiedTaskSubmitter } from './unifiedTaskSubmission'
import { cancelQueuedImageSearchScan, queueImageSearchScan } from './imageSearchTaskScheduling'
import {
  getImagePreparationProgress,
  isImagePreparationRunning,
  onImagePreparationProgress,
  startImageLibraryPreparation,
  stopImageLibraryPreparation,
} from './imagePreparationPipeline'
import { getSourceFileSyncMutationEpoch, isSourceFileSyncRunning } from './sourceFileSyncService'
import { isSourceDerivedDataCleanupRunning } from './sourceDerivedDataCleanupService'
import { isAssetDerivedRebuildRunning } from './assetDerivedRebuildCoordinator'
import {
  isVectorMaintenanceReservationActive,
  tryAcquireVectorExclusiveMaintenance,
  tryAcquireVectorSearchReservation,
} from './vectorMaintenanceService'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function listWindowsDrives(): string[] {
  if (process.platform !== 'win32') return ['/']
  const drives: string[] = []
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      if (fs.existsSync(root)) drives.push(root)
    } catch {
      /* skip inaccessible drives */
    }
  }
  return drives
}

// Edit operations (single delete/update/repair, folder purge) share the same
// busy guards as startScan: vector GC and storage cleanup both hold the index.
function imageSearchEditBusyError(includeDataCatalog = true): string | null {
  if (isSourceFileSyncRunning()) return 'Source file synchronization is running'
  if (isSourceDerivedDataCleanupRunning()) return 'Source-derived data cleanup is running'
  if (isAssetDerivedRebuildRunning()) return 'A derived index rebuild is running'
  if (isImageSearchIndexMutationRunning()) return 'An Image Search index edit is already running'
  if (isVectorMaintenanceReservationActive()) return 'Vector maintenance is running'
  if (isImagePreparationRunning()) return 'Image library preparation is already running'
  if (isImageSearchFolderDataEditRunning()) return 'A folder index edit is already running'
  if (isVectorGcRunning()) return 'Vector GC is using the active Image Search index'
  if (isVectorStoreMigrationRunning()) return 'Vector store migration is running'
  if (isStorageCleanupActiveFor('image-search')) return 'Image Search storage cleanup is running'
  if (isStorageCleanupActiveFor('vectors')) return 'Vector storage cleanup is running'
  if (includeDataCatalog && isImageSearchDataCatalogBuildRunning()) {
    return 'Image Search data catalog analysis is running'
  }
  if (['queued', 'running', 'paused', 'stopping'].includes(getEmbeddingProgress().state)) {
    return 'Stop the active embedding task before editing folder indexes'
  }
  if (isEmbeddingF16CacheBuildRunning() || isClipEmbeddingCacheBuildRunning()) {
    return 'Wait for the active vector cache build to finish'
  }
  if (
    ['queued', 'scanning', 'indexing', 'searching', 'paused'].includes(getImageSearchStatus().state)
  ) {
    return 'Stop the active Image Search task before editing indexed data'
  }
  return null
}

async function reconcileBeforeImageIndexSwitch(): Promise<string | null> {
  const recovery = await reconcileImageSearchSourceVectorInvalidations()
  if (recovery.activePendingIntents <= 0) return null
  return (
    recovery.error ||
    `${recovery.activePendingIntents} active source-vector recovery operation(s) remain pending`
  )
}

async function captureAndReconcileLoadedManifest(
  rootDir: string,
  expectedIdentity: Awaited<ReturnType<typeof resolveImageSearchIndexIdentity>>,
): Promise<string | null> {
  try {
    await captureImageSearchLoadedIndexIdentity(rootDir, expectedIdentity)
  } catch (error) {
    return `The index loaded, but its recovery identity could not be verified: ${errorMessage(error)}`
  }
  const recovery = await reconcileImageSearchSourceVectorInvalidations()
  if (recovery.activePendingIntents <= 0) {
    if (recovery.deferredIntents > 0) {
      console.info(
        `[ImageSearch] Deferred ${recovery.deferredIntents} source-vector intent(s) bound to another index`,
      )
    }
    return null
  }
  return (
    recovery.error ||
    `${recovery.activePendingIntents} active source-vector recovery operation(s) remain pending`
  )
}

function configuredImageSearchRoots(): string[] {
  const settings = readJSON(path.join(app.getPath('userData'), 'floating_clock_settings.json')) as {
    imageSearchScanPaths?: unknown
  } | null
  return Array.isArray(settings?.imageSearchScanPaths)
    ? settings.imageSearchScanPaths.filter((item): item is string => typeof item === 'string')
    : []
}

function folderDataLayers(rawLayers: unknown): ImageSearchFolderDataLayer[] {
  if (!Array.isArray(rawLayers)) return []
  return [...new Set(rawLayers)].filter(
    (layer): layer is ImageSearchFolderDataLayer =>
      layer === 'native' || layer === 'dino' || layer === 'clip',
  )
}

export function registerImageSearchIpc(
  getMainWindow: () => Electron.BrowserWindow | null,
  taskScheduler?: UnifiedTaskSubmitter,
): void {
  onImagePreparationProgress((progress) => {
    const window = getMainWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(IMAGE_SEARCH_IPC.ON_PREPARATION_PROGRESS, progress)
  })
  secureIpcMain.handle('imageSearch:getStatus', async () => getImageSearchStatus())

  secureIpcMain.handle(
    IMAGE_SEARCH_IPC.PREPARE_LIBRARY,
    async (_event, args: ImageSearchPrepareLibraryArgs) => {
      const busy = imageSearchEditBusyError()
      if (busy) return { ok: false, error: busy }
      return startImageLibraryPreparation(args, taskScheduler)
    },
  )

  secureIpcMain.handle(IMAGE_SEARCH_IPC.GET_PREPARATION_PROGRESS, async () =>
    getImagePreparationProgress(),
  )

  secureIpcMain.handle(IMAGE_SEARCH_IPC.STOP_PREPARATION, async (_event, taskId: unknown) =>
    stopImageLibraryPreparation(typeof taskId === 'string' ? taskId : undefined),
  )

  secureIpcMain.handle('imageSearch:startScan', async (_event, args: ImageSearchStartScanArgs) => {
    const busy = imageSearchEditBusyError()
    if (busy) return { ok: false, error: busy }
    return taskScheduler ? queueImageSearchScan(args, taskScheduler) : startImageSearchScan(args)
  })

  secureIpcMain.handle('imageSearch:stopScan', async () => {
    if (cancelQueuedImageSearchScan()) return getImageSearchStatus()
    return stopImageSearchScan()
  })

  secureIpcMain.handle('imageSearch:pauseScan', async () => pauseImageSearchScan())

  secureIpcMain.handle('imageSearch:resumeScan', async () => resumeImageSearchScan())

  secureIpcMain.handle('imageSearch:isScanPaused', async () => isImageSearchScanPaused())

  secureIpcMain.handle('imageSearch:search', async (event, args: ImageSearchSearchArgs) => {
    if (isSourceFileSyncRunning() || isSourceDerivedDataCleanupRunning()) {
      return {
        results: [],
        status: {
          ...getImageSearchStatus(),
          message: 'Source index maintenance is running',
        },
      }
    }
    if (isImageSearchFolderDataEditRunning()) {
      return {
        results: [],
        status: {
          ...getImageSearchStatus(),
          message: 'A folder index edit is running',
        },
      }
    }
    const releaseSearch = tryAcquireVectorSearchReservation()
    if (!releaseSearch) {
      return {
        results: [],
        status: { ...getImageSearchStatus(), message: 'Vector maintenance is running' },
      }
    }
    const sourceSyncEpoch = getSourceFileSyncMutationEpoch()
    try {
      const response = await searchImagesAsync(args)
      if (isSourceFileSyncRunning() || sourceSyncEpoch !== getSourceFileSyncMutationEpoch()) {
        return {
          results: [],
          status: {
            ...getImageSearchStatus(),
            message:
              'Search results were discarded because source synchronization changed the index',
          },
        }
      }
      return {
        ...response,
        results: authorizeFileDragResults(
          event.sender.id,
          response.results,
          (result) => result.path,
        ),
      }
    } finally {
      releaseSearch()
    }
  })

  secureIpcMain.handle('imageSearch:selectPaths', async () => {
    const window = getMainWindow()
    if (!window || window.isDestroyed()) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'multiSelections'],
      title: 'Select folders to index for ImageSearch',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })

  secureIpcMain.handle('imageSearch:selectImage', async () => {
    const window = getMainWindow()
    if (!window || window.isDestroyed()) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      title: 'Select an image to test hash',
      filters: [
        {
          name: 'Images',
          extensions: [
            'jpg',
            'jpeg',
            'png',
            'webp',
            'gif',
            'bmp',
            'tiff',
            'tif',
            'psd',
            'psb',
            'kra',
            'svg',
            'pdf',
            'ai',
            'eps',
            'tif',
            'tiff',
            'cr2',
            'cr3',
            'nef',
            'arw',
            'dng',
            'raf',
            'orf',
            'rw2',
            'pef',
            'srw',
            'clip',
            'cdr',
            'indd',
          ],
        },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  secureIpcMain.handle('imageSearch:hashImage', async (_event, rawPath: unknown) => {
    const filePath = safeShellPath(rawPath)
    if (!filePath) return { ok: false, error: 'Invalid path' }
    return submitUnifiedTask(taskScheduler, {
      stage: 'hash',
      priority: 0,
      paths: [filePath],
      label: `explicit image hash: ${path.basename(filePath).slice(0, 80)}`,
      run: () => hashImageFileAsync(filePath),
    })
  })

  secureIpcMain.handle('imageSearch:pasteClipboardImage', async () => {
    try {
      const image = clipboard.readImage()
      if (!image || image.isEmpty()) {
        return { ok: false, error: 'Clipboard does not contain an image.' }
      }
      const dir = path.join(app.getPath('userData'), 'image-search-queries')
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, `clipboard-${Date.now()}.png`)
      fs.writeFileSync(filePath, image.toPNG())
      return { ok: true, path: filePath }
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  secureIpcMain.handle('imageSearch:openFile', async (_event, rawPath: unknown) => {
    return openSafeShellPath(shell, rawPath, { requireExists: true })
  })

  secureIpcMain.handle('imageSearch:openFolder', async (_event, rawPath: unknown) => {
    return revealSafeShellPath(shell, rawPath, { requireExists: true })
  })

  secureIpcMain.handle('imageSearch:clearIndex', async () => {
    const busy = imageSearchEditBusyError()
    if (busy) return { ok: false, error: busy }
    const releaseMaintenance = tryAcquireVectorExclusiveMaintenance()
    if (!releaseMaintenance) return { ok: false, error: 'Vector maintenance is running' }
    try {
      return clearImageIndex()
    } finally {
      releaseMaintenance()
    }
  })

  // The write location is resolved from main-process state only; the renderer
  // cannot supply a path (PIO-P1-01).
  secureIpcMain.handle('imageSearch:saveIndex', async () => {
    const busy = imageSearchEditBusyError()
    if (busy) return { ok: false, error: busy }
    const releaseMaintenance = tryAcquireVectorExclusiveMaintenance()
    if (!releaseMaintenance) return { ok: false, error: 'Vector maintenance is running' }
    try {
      return await saveImageIndexToDefaultLocation()
    } finally {
      releaseMaintenance()
    }
  })

  secureIpcMain.handle('imageSearch:loadIndex', async (_event, rawPath: unknown) => {
    const busy = imageSearchEditBusyError()
    if (busy) return { ok: false, error: busy }
    const filePath = safeShellPath(rawPath)
    if (!filePath) return { ok: false, error: 'Invalid path' }
    try {
      if (!fs.statSync(filePath).isFile()) return { ok: false, error: 'Index path is not a file' }
    } catch {
      return { ok: false, error: 'Index path does not exist' }
    }
    const releaseMaintenance = tryAcquireVectorExclusiveMaintenance()
    if (!releaseMaintenance) return { ok: false, error: 'Vector maintenance is running' }
    try {
      const recoveryError = await reconcileBeforeImageIndexSwitch()
      if (recoveryError) {
        return { ok: false, error: `Cannot switch image indexes: ${recoveryError}` }
      }
      return loadImageIndex(filePath)
    } finally {
      releaseMaintenance()
    }
  })

  secureIpcMain.handle('imageSearch:loadManifest', async (_event, rawPath: unknown) => {
    const busy = imageSearchEditBusyError()
    if (busy) return { ok: false, error: busy }
    const rootDir = safeShellPath(rawPath)
    if (!rootDir) return { ok: false, error: 'Invalid path' }
    try {
      if (!fs.statSync(rootDir).isDirectory())
        return { ok: false, error: 'Manifest path is not a directory' }
    } catch {
      return { ok: false, error: 'Manifest path does not exist' }
    }
    const releaseMaintenance = tryAcquireVectorExclusiveMaintenance()
    if (!releaseMaintenance) return { ok: false, error: 'Vector maintenance is running' }
    try {
      const recoveryError = await reconcileBeforeImageIndexSwitch()
      if (recoveryError) {
        return { ok: false, error: `Cannot switch image indexes: ${recoveryError}` }
      }
      const expectedIdentity = await resolveImageSearchIndexIdentity(rootDir)
      const result = loadManifest(rootDir)
      if (!result.ok) return result
      const loadedRecoveryError = await captureAndReconcileLoadedManifest(rootDir, expectedIdentity)
      return loadedRecoveryError ? { ...result, ok: false, error: loadedRecoveryError } : result
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    } finally {
      releaseMaintenance()
    }
  })

  secureIpcMain.handle('imageSearch:repairManifest', async (_event, rawPath: unknown) => {
    const busy = imageSearchEditBusyError()
    if (busy) return { ok: false, error: busy }
    const rootDir = safeShellPath(rawPath)
    if (!rootDir) return { ok: false, error: 'Invalid path' }
    try {
      if (!fs.statSync(rootDir).isDirectory())
        return { ok: false, error: 'Manifest path is not a directory' }
    } catch {
      return { ok: false, error: 'Manifest path does not exist' }
    }
    const releaseMaintenance = tryAcquireVectorExclusiveMaintenance()
    if (!releaseMaintenance) return { ok: false, error: 'Vector maintenance is running' }
    try {
      const recoveryError = await reconcileBeforeImageIndexSwitch()
      if (recoveryError) {
        return { ok: false, error: `Cannot repair and switch image indexes: ${recoveryError}` }
      }
      const expectedIdentity = await resolveImageSearchIndexIdentity(rootDir)
      const repaired = repairManifest(rootDir)
      if (!repaired.ok) return repaired
      const loaded = loadManifest(rootDir)
      if (!loaded.ok) return loaded
      const loadedRecoveryError = await captureAndReconcileLoadedManifest(rootDir, expectedIdentity)
      return loadedRecoveryError ? { ...loaded, ok: false, error: loadedRecoveryError } : loaded
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    } finally {
      releaseMaintenance()
    }
  })

  secureIpcMain.handle('imageSearch:getIndexMode', async () => getImageIndexMode())

  secureIpcMain.handle('imageSearch:listDrives', async () => listWindowsDrives())

  secureIpcMain.handle('imageSearch:validatePath', async (_event, rawPath: unknown) => {
    const filePath = safeShellPath(rawPath)
    if (!filePath) return { ok: false, error: 'Invalid path' }
    try {
      const stat = fs.statSync(filePath)
      if (stat.isDirectory()) return { ok: true }
      return { ok: false, error: 'Path is not a directory' }
    } catch {
      return { ok: false, error: 'Path does not exist or is inaccessible' }
    }
  })

  secureIpcMain.handle(
    'imageSearch:queryData',
    async (_event, rawQuery: unknown, rawOffset: unknown, rawLimit: unknown) => {
      const query = typeof rawQuery === 'string' ? rawQuery.slice(0, 1024) : ''
      const offset = Math.max(0, Math.floor(Number(rawOffset) || 0))
      const limit = Math.max(1, Math.min(200, Math.floor(Number(rawLimit) || 50)))
      return queryImageSearchData(query, offset, limit)
    },
  )

  secureIpcMain.handle('imageSearch:getDataStats', async (_event, rawPrefix: unknown) => {
    const prefix = typeof rawPrefix === 'string' ? rawPrefix.slice(0, 1024) : ''
    return getImageSearchDataStats(prefix)
  })

  secureIpcMain.handle('imageSearch:getDataOverview', async () =>
    getImageSearchDataOverview(app.getPath('userData')),
  )

  secureIpcMain.handle('imageSearch:startDataCatalogBuild', async () => {
    const busy = imageSearchEditBusyError(false)
    if (busy) return { ok: false, error: busy }
    return startImageSearchDataCatalogBuild(app.getPath('userData'), configuredImageSearchRoots())
  })

  secureIpcMain.handle('imageSearch:getDataCatalogProgress', async () =>
    getImageSearchDataCatalogProgress(),
  )

  secureIpcMain.handle('imageSearch:cancelDataCatalogBuild', async () =>
    cancelImageSearchDataCatalogBuild(),
  )

  secureIpcMain.handle('imageSearch:listDataFolders', async (_event, rawRequest: unknown) => {
    const request =
      rawRequest && typeof rawRequest === 'object'
        ? (rawRequest as ImageSearchDataFolderQuery)
        : undefined
    return listImageSearchDataFolders(app.getPath('userData'), request)
  })

  secureIpcMain.handle('imageSearch:openDataStoreLocation', async (_event, rawId: unknown) => {
    const storeId = typeof rawId === 'string' ? rawId.slice(0, 64) : ''
    const location = await resolveImageSearchDataStoreLocation(app.getPath('userData'), storeId)
    if (!location) return { ok: false, error: 'Data store is missing or invalid' }
    return openSafeShellPath(shell, location, { requireExists: true })
  })

  secureIpcMain.handle(
    'imageSearch:previewFolderDataEdit',
    async (_event, rawFolder: unknown, rawLayers: unknown) => {
      const busy = imageSearchEditBusyError()
      if (busy) return { ok: false, error: busy }
      const folder = safeShellPath(rawFolder)
      if (!folder) return { ok: false, error: 'Invalid folder path' }
      const layers = folderDataLayers(rawLayers)
      if (layers.length === 0) return { ok: false, error: 'Select at least one index layer' }
      const nativeStats = layers.includes('native')
        ? getImageSearchDataStats(folder)
        : { ok: true, count: 0, totalBytes: 0 }
      if (!nativeStats.ok) {
        return { ok: false, error: nativeStats.error || 'Could not read Native index statistics' }
      }
      return previewImageSearchFolderDataEdit({
        userDataPath: app.getPath('userData'),
        folder,
        layers,
        allowedRoots: configuredImageSearchRoots(),
        nativeStats: {
          count: nativeStats.count || 0,
          totalBytes: nativeStats.totalBytes || 0,
        },
      })
    },
  )

  secureIpcMain.handle('imageSearch:executeFolderDataEdit', async (_event, rawToken: unknown) => {
    const busy = imageSearchEditBusyError()
    if (busy) return { ok: false, error: busy }
    const token = typeof rawToken === 'string' ? rawToken.slice(0, 256) : ''
    if (!token) return { ok: false, error: 'Invalid folder edit confirmation' }
    const allowedRoots = configuredImageSearchRoots()
    return executeImageSearchFolderDataEdit({
      userDataPath: app.getPath('userData'),
      token,
      allowedRoots,
      hooks: {
        deleteNative: (folder) =>
          // A preview token can also authorize an indexed historical folder
          // that is no longer present in the current scan-path settings.
          deleteImageSearchDataFolder(folder, [...allowedRoots, folder]),
        cleanupAuxiliary: async (folder, layers) => {
          const result = await removeImageDataFolder(folder, layers)
          return { removed: result.removed }
        },
        invalidateRuntimeCaches: () => {
          stopLayeredSearch()
          disposeVectorAnnWorker()
          disposeSemanticVectorSearchWorker()
          clearVectorIndex()
          invalidateClipEmbeddingCacheMemory()
        },
      },
    })
  })

  secureIpcMain.handle('imageSearch:getFolderDataEditProgress', async () =>
    getImageSearchFolderDataEditProgress(),
  )

  secureIpcMain.handle('imageSearch:cancelFolderDataEdit', async () =>
    cancelImageSearchFolderDataEdit(),
  )

  secureIpcMain.handle('imageSearch:getDirNameStats', async (_event, rawName: unknown) => {
    const name = typeof rawName === 'string' ? rawName.slice(0, 256) : ''
    return getImageSearchDirNameStats(name)
  })

  secureIpcMain.handle('imageSearch:updateData', async (_event, rawPath: unknown) => {
    const busy = imageSearchEditBusyError()
    if (busy) return { ok: false, error: busy }
    const filePath = safeShellPath(rawPath)
    if (!filePath) return { ok: false, error: 'Invalid path' }
    try {
      if (!fs.statSync(filePath).isFile()) return { ok: false, error: 'Source is not a file' }
    } catch {
      return { ok: false, error: 'Source file does not exist' }
    }
    return updateImageSearchData(filePath)
  })

  secureIpcMain.handle('imageSearch:deleteData', async (_event, rawPath: unknown) => {
    const busy = imageSearchEditBusyError()
    if (busy) return { ok: false, error: busy }
    const filePath = safeShellPath(rawPath)
    if (!filePath) return { ok: false, error: 'Invalid path' }
    return deleteImageSearchData(filePath)
  })

  secureIpcMain.handle('imageSearch:deleteDataFolder', async (_event, rawFolder: unknown) => {
    const busy = imageSearchEditBusyError()
    if (busy) return { ok: false, error: busy }
    const folder = safeShellPath(rawFolder)
    if (!folder) return { ok: false, error: 'Invalid path' }
    return deleteImageSearchDataFolder(folder, configuredImageSearchRoots())
  })

  secureIpcMain.handle('imageSearch:deleteDirName', async (_event, rawName: unknown) => {
    const busy = imageSearchEditBusyError()
    if (busy) return { ok: false, error: busy }
    // No scan-path root check: the feature is precisely about cleaning a
    // same-named directory wherever it was indexed. The service rejects
    // empty/separator-bearing names before touching the index.
    const name = typeof rawName === 'string' ? rawName.slice(0, 256) : ''
    return deleteImageSearchDirName(name)
  })

  secureIpcMain.handle(
    'imageSearch:repairDataPath',
    async (_event, rawOldPath: unknown, rawNewPath: unknown) => {
      const busy = imageSearchEditBusyError()
      if (busy) return { ok: false, error: busy }
      const oldPath = safeShellPath(rawOldPath)
      const newPath = safeShellPath(rawNewPath)
      if (!oldPath || !newPath) return { ok: false, error: 'Invalid old or new path' }
      try {
        if (!fs.statSync(newPath).isFile()) return { ok: false, error: 'New source is not a file' }
      } catch {
        return { ok: false, error: 'New source file does not exist' }
      }
      return repairImageSearchDataPath(oldPath, newPath)
    },
  )
}
