// ── ImageSearch Renderer Bridge ────────────────────────────
//
// Type-safe wrapper around window.electronAPI.imageSearch.
// All IPC channels use constants from shared/ipc-contract.ts.
// Falls back gracefully when electronAPI is unavailable (e.g. browser dev).

import type {
  ImageSearchStatus,
  ImageSearchStartScanArgs,
  ImageSearchPrepareLibraryArgs,
  ImageSearchPrepareLibraryStartResult,
  ImageSearchPreparationProgress,
  ImageSearchSearchArgs,
  ImageSearchSearchResponse,
  ImageHashResult,
  ImageSearchDataEditResult,
  ImageSearchDataQueryResult,
  ImageSearchDataStatsResult,
  ImageSearchDataOverview,
  ImageSearchDataCatalogProgress,
  ImageSearchDataCatalogStartResult,
  ImageSearchDataFolderQuery,
  ImageSearchDataFolderList,
  ImageSearchFolderDataLayer,
  ImageSearchFolderDataEditPreview,
  ImageSearchFolderDataEditResult,
  ImageSearchFolderDataEditProgress,
  ThumbnailRebuildBackend,
  ThumbnailRebuildProgress,
} from '../../shared/ipc-contract'

function api() {
  return window.electronAPI?.imageSearch
}

function logError(method: string, err: unknown): void {
  console.error(`[imageSearchBridge.${method}]`, err)
}

export const imageSearchBridge = {
  async getStatus(): Promise<ImageSearchStatus | null> {
    try {
      const a = api()
      if (!a) throw new Error('electronAPI not available')
      return await a.getStatus()
    } catch (e) {
      logError('getStatus', e)
      return null
    }
  },

  async startScan(args: ImageSearchStartScanArgs): Promise<ImageSearchStatus | null> {
    try {
      const a = api()
      if (!a) throw new Error('electronAPI not available')
      return await a.startScan(args)
    } catch (e) {
      logError('startScan', e)
      return null
    }
  },

  async stopScan(): Promise<ImageSearchStatus | null> {
    try {
      const a = api()
      if (!a) throw new Error('electronAPI not available')
      return await a.stopScan()
    } catch (e) {
      logError('stopScan', e)
      return null
    }
  },

  async prepareLibrary(
    args: ImageSearchPrepareLibraryArgs,
  ): Promise<ImageSearchPrepareLibraryStartResult> {
    try {
      const a = api()
      if (!a?.prepareLibrary) throw new Error('electronAPI not available')
      return await a.prepareLibrary(args)
    } catch (e) {
      logError('prepareLibrary', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async getPreparationProgress(): Promise<ImageSearchPreparationProgress> {
    try {
      const a = api()
      if (!a?.getPreparationProgress) throw new Error('electronAPI not available')
      return await a.getPreparationProgress()
    } catch (e) {
      logError('getPreparationProgress', e)
      return {
        state: 'error',
        percentage: 0,
        scanIndexed: 0,
        committedImages: 0,
        invalidatedImages: 0,
        commitFeedDropped: 0,
        scanComplete: false,
        dinoEmbeddingComplete: false,
        clipEmbeddingComplete: false,
        vectorIndexComplete: false,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  },

  async stopPreparation(taskId?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const a = api()
      if (!a?.stopPreparation) throw new Error('electronAPI not available')
      return await a.stopPreparation(taskId)
    } catch (e) {
      logError('stopPreparation', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  onPreparationProgress(
    cb: (progress: ImageSearchPreparationProgress) => void,
  ): (() => void) | undefined {
    try {
      const a = api()
      if (!a?.onPreparationProgress) return undefined
      return a.onPreparationProgress(cb)
    } catch (e) {
      logError('onPreparationProgress', e)
      return undefined
    }
  },

  async search(args: ImageSearchSearchArgs): Promise<ImageSearchSearchResponse | null> {
    try {
      const a = api()
      if (!a) throw new Error('electronAPI not available')
      return await a.search(args)
    } catch (e) {
      logError('search', e)
      return null
    }
  },

  async selectPaths(): Promise<string[] | null> {
    try {
      const a = api()
      if (!a) throw new Error('electronAPI not available')
      return await a.selectPaths()
    } catch (e) {
      logError('selectPaths', e)
      return null
    }
  },

  onStatusChanged(cb: (status: ImageSearchStatus) => void): (() => void) | undefined {
    try {
      const a = api()
      if (!a) return undefined
      return a.onStatusChanged(cb)
    } catch (e) {
      logError('onStatusChanged', e)
      return undefined
    }
  },

  async selectImage(): Promise<string | null> {
    try {
      const a = api()
      if (!a) throw new Error('electronAPI not available')
      return await a.selectImage()
    } catch (e) {
      logError('selectImage', e)
      return null
    }
  },

  async pasteClipboardImage(): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      const a = api()
      if (!a?.pasteClipboardImage) throw new Error('electronAPI not available')
      return await a.pasteClipboardImage()
    } catch (e) {
      logError('pasteClipboardImage', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async openFile(filePath: string): Promise<void> {
    const a = api()
    if (!a) return
    await a.openFile(filePath)
  },

  async openFolder(filePath: string): Promise<void> {
    const a = api()
    if (!a) return
    await a.openFolder(filePath)
  },

  async saveIndex(): Promise<{ ok: boolean; recordCount?: number } | null> {
    try {
      const a = api()
      if (!a) throw new Error('no api')
      return await a.saveIndex()
    } catch (e) {
      logError('saveIndex', e)
      return null
    }
  },

  async getIndexMode(): Promise<{ mode: string; recordCount: number } | null> {
    try {
      const a = api()
      if (!a) throw new Error('no api')
      return await a.getIndexMode()
    } catch (e) {
      logError('getIndexMode', e)
      return null
    }
  },

  async loadIndex(filePath: string): Promise<{ ok: boolean; recordCount?: number } | null> {
    try {
      const a = api()
      if (!a) throw new Error('no api')
      return await a.loadIndex(filePath)
    } catch (e) {
      logError('loadIndex', e)
      return null
    }
  },

  async loadManifest(
    rootDir: string,
  ): Promise<{ ok: boolean; recordCount?: number; segmentCount?: number; error?: string } | null> {
    try {
      const a = api()
      if (!a) throw new Error('no api')
      return await a.loadManifest(rootDir)
    } catch (e) {
      logError('loadManifest', e)
      return null
    }
  },

  async repairManifest(
    rootDir: string,
  ): Promise<{ ok: boolean; recordCount?: number; segmentCount?: number; error?: string } | null> {
    try {
      const a = api()
      if (!a) throw new Error('no api')
      return await a.repairManifest(rootDir)
    } catch (e) {
      logError('repairManifest', e)
      return null
    }
  },

  async listDrives(): Promise<string[]> {
    try {
      const a = api()
      if (!a) throw new Error('electronAPI not available')
      return await a.listDrives()
    } catch (e) {
      logError('listDrives', e)
      return []
    }
  },

  async validatePath(filePath: string): Promise<{ ok: boolean; error?: string } | null> {
    try {
      const a = api()
      if (!a) throw new Error('electronAPI not available')
      return await a.validatePath(filePath)
    } catch (e) {
      logError('validatePath', e)
      return null
    }
  },

  async pauseScan(): Promise<boolean> {
    try {
      const a = api()
      if (!a) return false
      const r = await a.pauseScan()
      return r.ok
    } catch (e) {
      logError('pauseScan', e)
      return false
    }
  },

  async resumeScan(): Promise<boolean> {
    try {
      const a = api()
      if (!a) return false
      const r = await a.resumeScan()
      return r.ok
    } catch (e) {
      logError('resumeScan', e)
      return false
    }
  },

  async isScanPaused(): Promise<boolean> {
    try {
      const a = api()
      if (!a) return false
      const r = await a.isScanPaused()
      return r.paused
    } catch (e) {
      logError('isScanPaused', e)
      return false
    }
  },

  async clearIndex(): Promise<{ ok: boolean } | null> {
    try {
      const a = api()
      if (!a) throw new Error('electronAPI not available')
      return await a.clearIndex()
    } catch (e) {
      logError('clearIndex', e)
      return null
    }
  },

  async hashImage(filePath: string): Promise<ImageHashResult | null> {
    try {
      const a = api()
      if (!a) throw new Error('electronAPI not available')
      return await a.hashImage(filePath)
    } catch (e) {
      logError('hashImage', e)
      return null
    }
  },

  async queryData(query: string, offset = 0, limit = 50): Promise<ImageSearchDataQueryResult> {
    try {
      const a = api()
      if (!a?.queryData) throw new Error('electronAPI not available')
      return await a.queryData(query, offset, limit)
    } catch (e) {
      logError('queryData', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async updateData(filePath: string): Promise<ImageSearchDataEditResult> {
    try {
      const a = api()
      if (!a?.updateData) throw new Error('electronAPI not available')
      return await a.updateData(filePath)
    } catch (e) {
      logError('updateData', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async deleteData(filePath: string): Promise<ImageSearchDataEditResult> {
    try {
      const a = api()
      if (!a?.deleteData) throw new Error('electronAPI not available')
      return await a.deleteData(filePath)
    } catch (e) {
      logError('deleteData', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async getDataStats(prefix: string): Promise<ImageSearchDataStatsResult> {
    try {
      const a = api()
      if (!a?.getDataStats) throw new Error('electronAPI not available')
      return await a.getDataStats(prefix)
    } catch (e) {
      logError('getDataStats', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async getDataOverview(): Promise<ImageSearchDataOverview> {
    try {
      const a = api()
      if (!a?.getDataOverview) throw new Error('electronAPI not available')
      return await a.getDataOverview()
    } catch (e) {
      logError('getDataOverview', e)
      return {
        ok: false,
        catalogState: 'error',
        stores: [],
        totalBytes: 0,
        authoritativeBytes: 0,
        unionPathCount: 0,
        nativeUniqueCount: 0,
        dinoUniqueCount: 0,
        clipUniqueCount: 0,
        completeCount: 0,
        missingDinoCount: 0,
        missingClipCount: 0,
        vectorOnlyCount: 0,
        duplicateRows: 0,
        malformedRows: 0,
        folderCount: 0,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  },

  async startDataCatalogBuild(): Promise<ImageSearchDataCatalogStartResult> {
    try {
      const a = api()
      if (!a?.startDataCatalogBuild) throw new Error('electronAPI not available')
      return await a.startDataCatalogBuild()
    } catch (e) {
      logError('startDataCatalogBuild', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async getDataCatalogProgress(): Promise<ImageSearchDataCatalogProgress> {
    try {
      const a = api()
      if (!a?.getDataCatalogProgress) throw new Error('electronAPI not available')
      return await a.getDataCatalogProgress()
    } catch (e) {
      logError('getDataCatalogProgress', e)
      return {
        state: 'error',
        processedBytes: 0,
        totalBytes: 0,
        processedRecords: 0,
        nativeRecords: 0,
        dinoRecords: 0,
        clipRecords: 0,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  },

  async cancelDataCatalogBuild(): Promise<{ ok: boolean }> {
    try {
      const a = api()
      if (!a?.cancelDataCatalogBuild) throw new Error('electronAPI not available')
      return await a.cancelDataCatalogBuild()
    } catch (e) {
      logError('cancelDataCatalogBuild', e)
      return { ok: false }
    }
  },

  async listDataFolders(
    request: ImageSearchDataFolderQuery = {},
  ): Promise<ImageSearchDataFolderList> {
    try {
      const a = api()
      if (!a?.listDataFolders) throw new Error('electronAPI not available')
      return await a.listDataFolders(request)
    } catch (e) {
      logError('listDataFolders', e)
      return {
        ok: false,
        catalogState: 'error',
        records: [],
        offset: 0,
        total: 0,
        hasMore: false,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  },

  async openDataStoreLocation(storeId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const a = api()
      if (!a?.openDataStoreLocation) throw new Error('electronAPI not available')
      return await a.openDataStoreLocation(storeId)
    } catch (e) {
      logError('openDataStoreLocation', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async previewFolderDataEdit(
    folder: string,
    layers: ImageSearchFolderDataLayer[],
  ): Promise<ImageSearchFolderDataEditPreview> {
    try {
      const a = api()
      if (!a?.previewFolderDataEdit) throw new Error('electronAPI not available')
      return await a.previewFolderDataEdit(folder, layers)
    } catch (e) {
      logError('previewFolderDataEdit', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async executeFolderDataEdit(token: string): Promise<ImageSearchFolderDataEditResult> {
    try {
      const a = api()
      if (!a?.executeFolderDataEdit) throw new Error('electronAPI not available')
      return await a.executeFolderDataEdit(token)
    } catch (e) {
      logError('executeFolderDataEdit', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async getFolderDataEditProgress(): Promise<ImageSearchFolderDataEditProgress> {
    try {
      const a = api()
      if (!a?.getFolderDataEditProgress) throw new Error('electronAPI not available')
      return await a.getFolderDataEditProgress()
    } catch (e) {
      logError('getFolderDataEditProgress', e)
      return {
        state: 'error',
        processedBytes: 0,
        totalBytes: 0,
        removedRecords: 0,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  },

  async cancelFolderDataEdit(): Promise<{ ok: boolean }> {
    try {
      const a = api()
      if (!a?.cancelFolderDataEdit) throw new Error('electronAPI not available')
      return await a.cancelFolderDataEdit()
    } catch (e) {
      logError('cancelFolderDataEdit', e)
      return { ok: false }
    }
  },

  async deleteDataFolder(folder: string): Promise<ImageSearchDataEditResult> {
    try {
      const a = api()
      if (!a?.deleteDataFolder) throw new Error('electronAPI not available')
      return await a.deleteDataFolder(folder)
    } catch (e) {
      logError('deleteDataFolder', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async getDirNameStats(name: string): Promise<ImageSearchDataStatsResult> {
    try {
      const a = api()
      if (!a?.getDirNameStats) throw new Error('electronAPI not available')
      return await a.getDirNameStats(name)
    } catch (e) {
      logError('getDirNameStats', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async deleteDirName(name: string): Promise<ImageSearchDataEditResult> {
    try {
      const a = api()
      if (!a?.deleteDirName) throw new Error('electronAPI not available')
      return await a.deleteDirName(name)
    } catch (e) {
      logError('deleteDirName', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async repairDataPath(oldPath: string, newPath: string): Promise<ImageSearchDataEditResult> {
    try {
      const a = api()
      if (!a?.repairDataPath) throw new Error('electronAPI not available')
      return await a.repairDataPath(oldPath, newPath)
    } catch (e) {
      logError('repairDataPath', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async startThumbnailRebuild(
    paths: string[],
    backend: ThumbnailRebuildBackend = 'auto',
    gpuJobs = 4,
    batchSize = 2,
  ): Promise<{ ok: boolean; progress?: ThumbnailRebuildProgress; error?: string }> {
    try {
      const a = api()
      if (!a?.startThumbnailRebuild) throw new Error('electronAPI not available')
      return await a.startThumbnailRebuild(paths, backend, gpuJobs, batchSize)
    } catch (e) {
      logError('startThumbnailRebuild', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async getThumbnailRebuildProgress(): Promise<ThumbnailRebuildProgress> {
    try {
      const a = api()
      if (!a?.getThumbnailRebuildProgress) throw new Error('electronAPI not available')
      return await a.getThumbnailRebuildProgress()
    } catch (e) {
      logError('getThumbnailRebuildProgress', e)
      return { state: 'error', total: 0, completed: 0, skipped: 0, failed: 0 }
    }
  },

  async stopThumbnailRebuild(): Promise<ThumbnailRebuildProgress> {
    try {
      const a = api()
      if (!a?.stopThumbnailRebuild) throw new Error('electronAPI not available')
      return await a.stopThumbnailRebuild()
    } catch (e) {
      logError('stopThumbnailRebuild', e)
      return { state: 'error', total: 0, completed: 0, skipped: 0, failed: 0 }
    }
  },

  async clearThumbnailCache(
    confirm: boolean,
  ): Promise<{ ok: boolean; cleanupStarted?: boolean; error?: string }> {
    try {
      const a = api()
      if (!a?.clearThumbnailCache) throw new Error('electronAPI not available')
      return await a.clearThumbnailCache(confirm)
    } catch (e) {
      logError('clearThumbnailCache', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
}
