import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  ASSET_FEEDBACK_IPC,
  ASSET_LIBRARY_IPC,
  DISCOVERY_CATALOG_IPC,
  ASSET_IDENTITY_IPC,
  IMAGE_SEARCH_IPC,
  PRODUCT_HEALTH_IPC,
  UNIFIED_SEARCH_IPC,
  type AssetLibraryTaskProgress,
  type BatchRenameProgress,
  type DiscoveryScanStatus,
  type DupScanProgress,
  type ElectronAPI,
  type FMFolderSizeProgress,
  type FMProgress,
  type ImageSearchStatus,
  type ImageSearchPreparationProgress,
  type MediaSearchTaskProgress,
  type RemoteTransferTask,
  type WindowVisibilityEvent,
  type WorkspaceWorkArea,
} from '../shared/ipc-contract'
import type {
  ModelStatus,
  EmbeddingProgress,
  FeatureExtractProgress,
  SemanticSearchProgress,
  LayeredSearchProgress,
} from '../shared/vectorTypes'

const api: ElectronAPI = {
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  openThirdPartyLicenses: () => ipcRenderer.invoke('app:openThirdPartyLicenses'),
  viewEndUserTerms: () => ipcRenderer.invoke('app:viewEndUserTerms'),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  sourceDerivedData: {
    preview: (request) => ipcRenderer.invoke('sourceDerivedData:preview', request),
    execute: (token) => ipcRenderer.invoke('sourceDerivedData:execute', token),
    progress: () => ipcRenderer.invoke('sourceDerivedData:progress'),
    syncPreview: (request) => ipcRenderer.invoke('sourceDerivedData:syncPreview', request),
    syncExecute: (token) => ipcRenderer.invoke('sourceDerivedData:syncExecute', token),
    syncProgress: () => ipcRenderer.invoke('sourceDerivedData:syncProgress'),
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  fileDrag: {
    start: (token, mode) => ipcRenderer.send('fileDrag:start', token, mode),
    onError: (cb) => {
      const handler = (_event: IpcRendererEvent, message: string) => cb(message)
      ipcRenderer.on('fileDrag:error', handler)
      return () => ipcRenderer.removeListener('fileDrag:error', handler)
    },
  },
  setTransparency: (opacity) => ipcRenderer.invoke('set-transparency', opacity),
  getHotkeyStatus: () => ipcRenderer.invoke('get-hotkey-status'),
  registerHotkey: () => ipcRenderer.invoke('register-hotkey'),
  unregisterHotkey: () => ipcRenderer.invoke('unregister-hotkey'),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  openConfigDir: () => ipcRenderer.invoke('open-config-dir'),
  setIgnoreMouseEvents: (ignore, generation) =>
    ipcRenderer.invoke('set-ignore-mouse', ignore, generation),
  setOverlayShape: (rects, generation) =>
    ipcRenderer.invoke('set-overlay-shape', rects, generation),
  getWorkArea: () => ipcRenderer.invoke('get-work-area'),
  getDisplayTopology: () => ipcRenderer.invoke('get-display-topology'),
  setDisplayScope: (scope) => ipcRenderer.invoke('set-display-scope', scope),
  onSnapPanels: (cb) => {
    const handler = (_event: IpcRendererEvent, wa: WorkspaceWorkArea) => cb(wa)
    ipcRenderer.on('snap-panels', handler)
    return () => ipcRenderer.removeListener('snap-panels', handler)
  },
  onShowAllPanels: (cb) => {
    const handler = (_event: IpcRendererEvent, wa: WorkspaceWorkArea) => cb(wa)
    ipcRenderer.on('show-all-panels', handler)
    return () => ipcRenderer.removeListener('show-all-panels', handler)
  },
  onArrangeHorizontal: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('arrange-horizontal', handler)
    return () => ipcRenderer.removeListener('arrange-horizontal', handler)
  },
  onArrangeGrid: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('arrange-grid', handler)
    return () => ipcRenderer.removeListener('arrange-grid', handler)
  },
  onArrangeVertical: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('arrange-vertical', handler)
    return () => ipcRenderer.removeListener('arrange-vertical', handler)
  },
  onToggleGlobalVisibility: (cb) => {
    const handler = (_event: IpcRendererEvent, visibilityEvent: WindowVisibilityEvent) =>
      cb(visibilityEvent)
    ipcRenderer.on('toggle-global-visibility', handler)
    return () => ipcRenderer.removeListener('toggle-global-visibility', handler)
  },
  onShowGlobalVisibility: (cb) => {
    const handler = (_event: IpcRendererEvent, visibilityEvent: WindowVisibilityEvent) =>
      cb(visibilityEvent)
    ipcRenderer.on('show-global-visibility', handler)
    return () => ipcRenderer.removeListener('show-global-visibility', handler)
  },
  onGlobalWindowShownForPaint: (cb) => {
    const handler = (_event: IpcRendererEvent, visibilityEvent: WindowVisibilityEvent) =>
      cb(visibilityEvent)
    ipcRenderer.on('global-window-shown-for-paint', handler)
    return () => ipcRenderer.removeListener('global-window-shown-for-paint', handler)
  },
  onWorkAreaChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, wa: WorkspaceWorkArea) => cb(wa)
    ipcRenderer.on('work-area-changed', handler)
    return () => ipcRenderer.removeListener('work-area-changed', handler)
  },
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  showWindow: (generation) => ipcRenderer.invoke('show-window', generation),
  revealWindow: (generation) => ipcRenderer.invoke('reveal-window', generation),
  getWindowAlwaysOnTop: () => ipcRenderer.invoke('get-window-always-on-top'),
  setWindowAlwaysOnTop: (value) => ipcRenderer.invoke('set-window-always-on-top', value),
  getAiControlSettings: () => ipcRenderer.invoke('aiControl:getSettings'),
  setAiControlEnabled: (enabled, port, scopes) =>
    ipcRenderer.invoke('aiControl:setEnabled', enabled, port, scopes),
  rotateAiControlToken: (scopes) => ipcRenderer.invoke('aiControl:rotateToken', scopes),
  getAiControlAudit: () => ipcRenderer.invoke('aiControl:getAudit'),
  getAiControlConfirmations: () => ipcRenderer.invoke('aiControl:getConfirmations'),
  resolveAiControlConfirmation: (confirmationId, approved) =>
    ipcRenderer.invoke('aiControl:resolveConfirmation', confirmationId, approved),
  onHotkeyWarnings: (cb) => {
    const handler = (_event: IpcRendererEvent, failures: string[]) => cb(failures)
    ipcRenderer.on('hotkey-warnings', handler)
    return () => ipcRenderer.removeListener('hotkey-warnings', handler)
  },
  // File Manager APIs
  fmExpandPath: (p) => ipcRenderer.invoke('fm-expand-path', p),
  fmPathExists: (p) => ipcRenderer.invoke('fm-path-exists', p),
  fmListDirectory: (dirPath) => ipcRenderer.invoke('fm-list-directory', dirPath),
  fmListDirectoryPaged: (req) => ipcRenderer.invoke('fm-list-directory-paged', req),
  fmGetVolumeSpace: (rootPath) => ipcRenderer.invoke('fm-get-volume-space', rootPath),
  fmGetFolderSize: (request) => ipcRenderer.invoke('fm-get-folder-size', request),
  fmCancelFolderSizeRequests: (requestId) =>
    ipcRenderer.invoke('fm-cancel-folder-size-requests', requestId),
  onFMFolderSizeProgress: (cb) => {
    const handler = (_event: IpcRendererEvent, progress: FMFolderSizeProgress) => cb(progress)
    ipcRenderer.on('fm:folder-size-progress', handler)
    return () => ipcRenderer.removeListener('fm:folder-size-progress', handler)
  },
  fmGetFileInfo: (filePath) => ipcRenderer.invoke('fm-get-file-info', filePath),
  fmOpenFile: (filePath) => ipcRenderer.invoke('fm-open-file', filePath),
  fmOpenInExplorer: (filePath) => ipcRenderer.invoke('fm-open-in-explorer', filePath),
  fmCreateDirectory: (parentDir, name) =>
    ipcRenderer.invoke('fm-create-directory', parentDir, name),
  fmRenameFile: (oldPath, newName) => ipcRenderer.invoke('fm-rename-file', oldPath, newName),
  fmDeleteFiles: (paths) => ipcRenderer.invoke('fm-delete-files', paths),
  fmCopyFiles: (sources, destDir, options) =>
    ipcRenderer.invoke('fm-copy-files', sources, destDir, options),
  fmMoveFiles: (sources, destDir, options) =>
    ipcRenderer.invoke('fm-move-files', sources, destDir, options),
  onFMCopyProgress: (cb) => {
    const handler = (_event: IpcRendererEvent, info: FMProgress) => cb(info)
    ipcRenderer.on('fm-copy-progress', handler)
    return () => ipcRenderer.removeListener('fm-copy-progress', handler)
  },
  // Thumbnail APIs
  fmGetThumbnail: (filePath, maxDim) => ipcRenderer.invoke('fm-get-thumbnail', filePath, maxDim),
  fmGetFolderThumbnails: (folderPath, maxCount, maxDim) =>
    ipcRenderer.invoke('fm-get-folder-thumbnails', folderPath, maxCount, maxDim),
  fmGetFileIcons: (requests) => ipcRenderer.invoke('fm-get-file-icons', requests),
  fmGetThumbnailsBatch: (requests) => ipcRenderer.invoke('fm-get-thumbnails-batch', requests),
  // Directory watcher
  fmWatchDir: (dirPath) => ipcRenderer.invoke('fm-watch-dir', dirPath),
  fmUnwatchDir: (dirPath) => ipcRenderer.invoke('fm-unwatch-dir', dirPath),
  onDirChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, dirPath: string) => cb(dirPath)
    ipcRenderer.on('fm:dir-changed', handler)
    return () => ipcRenderer.removeListener('fm:dir-changed', handler)
  },
  fmAbortOperation: () => ipcRenderer.invoke('fm-abort-operation'),
  // Phase 1 unified sources & discovery catalog
  discoveryCatalog: {
    listSources: () => ipcRenderer.invoke(DISCOVERY_CATALOG_IPC.LIST_SOURCES),
    addSource: (request) => ipcRenderer.invoke(DISCOVERY_CATALOG_IPC.ADD_SOURCE, request),
    removeSource: (sourceId) => ipcRenderer.invoke(DISCOVERY_CATALOG_IPC.REMOVE_SOURCE, sourceId),
    repairSourceRoot: (sourceId, newRoot) =>
      ipcRenderer.invoke(DISCOVERY_CATALOG_IPC.REPAIR_SOURCE_ROOT, sourceId, newRoot),
    probeSource: (sourceId) => ipcRenderer.invoke(DISCOVERY_CATALOG_IPC.PROBE_SOURCE, sourceId),
    startScan: (sourceId) => ipcRenderer.invoke(DISCOVERY_CATALOG_IPC.SCAN_START, sourceId),
    cancelScan: (sourceId) => ipcRenderer.invoke(DISCOVERY_CATALOG_IPC.SCAN_CANCEL, sourceId),
    getScanStatus: (sourceId) => ipcRenderer.invoke(DISCOVERY_CATALOG_IPC.SCAN_STATUS, sourceId),
    onScanStatusChanged: (cb) => {
      const handler = (_event: IpcRendererEvent, status: DiscoveryScanStatus) => cb(status)
      ipcRenderer.on(DISCOVERY_CATALOG_IPC.SCAN_STATUS_EVENT, handler)
      return () => ipcRenderer.removeListener(DISCOVERY_CATALOG_IPC.SCAN_STATUS_EVENT, handler)
    },
    query: (request) => ipcRenderer.invoke(DISCOVERY_CATALOG_IPC.CATALOG_QUERY, request),
    getStats: () => ipcRenderer.invoke(DISCOVERY_CATALOG_IPC.CATALOG_STATS),
    createRemoteDownloadGrant: (fileEntryId) =>
      ipcRenderer.invoke(DISCOVERY_CATALOG_IPC.REMOTE_DOWNLOAD_GRANT, fileEntryId),
    prepareRemoteVideo: (actionToken, timestampMs) =>
      ipcRenderer.invoke(DISCOVERY_CATALOG_IPC.REMOTE_VIDEO_PREPARE, actionToken, timestampMs),
    getRemotePreview: (fileEntryId, maxDim) =>
      ipcRenderer.invoke(DISCOVERY_CATALOG_IPC.REMOTE_PREVIEW_GET, fileEntryId, maxDim),
  },
  // Phase 2 stable asset identity & unified file actions
  assetIdentity: {
    resolve: (filePath) => ipcRenderer.invoke(ASSET_IDENTITY_IPC.RESOLVE, filePath),
    getShadowReport: () => ipcRenderer.invoke(ASSET_IDENTITY_IPC.SHADOW_REPORT),
    openOriginal: (ref) => ipcRenderer.invoke(ASSET_IDENTITY_IPC.FILE_OPEN, ref),
    revealOriginal: (ref) => ipcRenderer.invoke(ASSET_IDENTITY_IPC.FILE_REVEAL, ref),
    repairMoved: (newPath) => ipcRenderer.invoke(ASSET_IDENTITY_IPC.REPAIR_MOVED, newPath),
    previewDerivedRebuild: (token) =>
      ipcRenderer.invoke(ASSET_IDENTITY_IPC.DERIVED_REBUILD_PREVIEW, token),
    startDerivedRebuild: (token) =>
      ipcRenderer.invoke(ASSET_IDENTITY_IPC.DERIVED_REBUILD_START, token),
    cancelDerivedRebuild: (token) =>
      ipcRenderer.invoke(ASSET_IDENTITY_IPC.DERIVED_REBUILD_CANCEL, token),
    listPendingRepairs: () => ipcRenderer.invoke(ASSET_IDENTITY_IPC.REPAIR_RECOVERY_LIST),
  },
  // Phase 3 unified staged tasks & unified search
  unifiedSearch: {
    query: (request) => ipcRenderer.invoke(UNIFIED_SEARCH_IPC.QUERY, request),
    setVisiblePaths: (paths) => ipcRenderer.invoke(UNIFIED_SEARCH_IPC.SET_VISIBLE_PATHS, paths),
    getSchedulerStats: () => ipcRenderer.invoke(UNIFIED_SEARCH_IPC.SCHEDULER_STATS),
    setResourceProfile: (profile) =>
      ipcRenderer.invoke(UNIFIED_SEARCH_IPC.RESOURCE_PROFILE_SET, profile),
    cancelBackgroundTasks: () => ipcRenderer.invoke(UNIFIED_SEARCH_IPC.RESOURCE_BACKGROUND_CANCEL),
    saveFeedback: (request) => ipcRenderer.invoke(UNIFIED_SEARCH_IPC.FEEDBACK_SAVE, request),
    undoFeedback: (feedbackId) => ipcRenderer.invoke(UNIFIED_SEARCH_IPC.FEEDBACK_UNDO, feedbackId),
    exportResults: (request) => ipcRenderer.invoke(UNIFIED_SEARCH_IPC.EXPORT_SAVE, request),
  },
  productHealth: {
    getReport: () => ipcRenderer.invoke(PRODUCT_HEALTH_IPC.REPORT_GET),
    runRepair: (request) => ipcRenderer.invoke(PRODUCT_HEALTH_IPC.REPAIR_RUN, request),
    saveReport: () => ipcRenderer.invoke(PRODUCT_HEALTH_IPC.REPORT_SAVE_DIALOG),
  },
  // ImageSearch APIs
  imageSearch: {
    getStatus: () => ipcRenderer.invoke('imageSearch:getStatus'),
    startScan: (args) => ipcRenderer.invoke('imageSearch:startScan', args),
    stopScan: () => ipcRenderer.invoke('imageSearch:stopScan'),
    prepareLibrary: (args) => ipcRenderer.invoke(IMAGE_SEARCH_IPC.PREPARE_LIBRARY, args),
    getPreparationProgress: () => ipcRenderer.invoke(IMAGE_SEARCH_IPC.GET_PREPARATION_PROGRESS),
    stopPreparation: (taskId) => ipcRenderer.invoke(IMAGE_SEARCH_IPC.STOP_PREPARATION, taskId),
    onPreparationProgress: (cb) => {
      const handler = (_event: IpcRendererEvent, progress: ImageSearchPreparationProgress) =>
        cb(progress)
      ipcRenderer.on(IMAGE_SEARCH_IPC.ON_PREPARATION_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IMAGE_SEARCH_IPC.ON_PREPARATION_PROGRESS, handler)
    },
    search: (args) => ipcRenderer.invoke('imageSearch:search', args),
    selectPaths: () => ipcRenderer.invoke('imageSearch:selectPaths'),
    onStatusChanged: (cb) => {
      const handler = (_event: IpcRendererEvent, status: ImageSearchStatus) => cb(status)
      ipcRenderer.on('imageSearch:onStatusChanged', handler)
      return () => ipcRenderer.removeListener('imageSearch:onStatusChanged', handler)
    },
    hashImage: (filePath) => ipcRenderer.invoke('imageSearch:hashImage', filePath),
    selectImage: () => ipcRenderer.invoke('imageSearch:selectImage'),
    pasteClipboardImage: () => ipcRenderer.invoke('imageSearch:pasteClipboardImage'),
    openFile: (filePath) => ipcRenderer.invoke('imageSearch:openFile', filePath),
    openFolder: (filePath) => ipcRenderer.invoke('imageSearch:openFolder', filePath),
    clearIndex: () => ipcRenderer.invoke('imageSearch:clearIndex'),
    saveIndex: () => ipcRenderer.invoke('imageSearch:saveIndex'),
    loadIndex: (filePath) => ipcRenderer.invoke('imageSearch:loadIndex', filePath),
    loadManifest: (rootDir) => ipcRenderer.invoke('imageSearch:loadManifest', rootDir),
    repairManifest: (rootDir) => ipcRenderer.invoke('imageSearch:repairManifest', rootDir),
    getIndexMode: () => ipcRenderer.invoke('imageSearch:getIndexMode'),
    listDrives: () => ipcRenderer.invoke('imageSearch:listDrives'),
    validatePath: (filePath) => ipcRenderer.invoke('imageSearch:validatePath', filePath),
    queryData: (query, offset, limit) =>
      ipcRenderer.invoke('imageSearch:queryData', query, offset, limit),
    getDataStats: (prefix) => ipcRenderer.invoke('imageSearch:getDataStats', prefix),
    getDataOverview: () => ipcRenderer.invoke('imageSearch:getDataOverview'),
    startDataCatalogBuild: () => ipcRenderer.invoke('imageSearch:startDataCatalogBuild'),
    getDataCatalogProgress: () => ipcRenderer.invoke('imageSearch:getDataCatalogProgress'),
    cancelDataCatalogBuild: () => ipcRenderer.invoke('imageSearch:cancelDataCatalogBuild'),
    listDataFolders: (request) => ipcRenderer.invoke('imageSearch:listDataFolders', request),
    openDataStoreLocation: (storeId) =>
      ipcRenderer.invoke('imageSearch:openDataStoreLocation', storeId),
    previewFolderDataEdit: (folder, layers) =>
      ipcRenderer.invoke('imageSearch:previewFolderDataEdit', folder, layers),
    executeFolderDataEdit: (token) =>
      ipcRenderer.invoke('imageSearch:executeFolderDataEdit', token),
    getFolderDataEditProgress: () => ipcRenderer.invoke('imageSearch:getFolderDataEditProgress'),
    cancelFolderDataEdit: () => ipcRenderer.invoke('imageSearch:cancelFolderDataEdit'),
    getDirNameStats: (name) => ipcRenderer.invoke('imageSearch:getDirNameStats', name),
    updateData: (filePath) => ipcRenderer.invoke('imageSearch:updateData', filePath),
    deleteData: (filePath) => ipcRenderer.invoke('imageSearch:deleteData', filePath),
    deleteDataFolder: (folder) => ipcRenderer.invoke('imageSearch:deleteDataFolder', folder),
    deleteDirName: (name) => ipcRenderer.invoke('imageSearch:deleteDirName', name),
    repairDataPath: (oldPath, newPath) =>
      ipcRenderer.invoke('imageSearch:repairDataPath', oldPath, newPath),
    startThumbnailRebuild: (paths, backend, gpuJobs, batchSize) =>
      ipcRenderer.invoke('imageSearch:startThumbnailRebuild', paths, backend, gpuJobs, batchSize),
    getThumbnailRebuildProgress: () =>
      ipcRenderer.invoke('imageSearch:getThumbnailRebuildProgress'),
    stopThumbnailRebuild: () => ipcRenderer.invoke('imageSearch:stopThumbnailRebuild'),
    clearThumbnailCache: (confirm) =>
      ipcRenderer.invoke('imageSearch:clearThumbnailCache', confirm),
    pauseScan: () => ipcRenderer.invoke('imageSearch:pauseScan'),
    resumeScan: () => ipcRenderer.invoke('imageSearch:resumeScan'),
    isScanPaused: () => ipcRenderer.invoke('imageSearch:isScanPaused'),
  },
  // AppStorage APIs
  // RemoteTerminal APIs
  remoteTerminal: {
    listProfiles: () => ipcRenderer.invoke('remoteTerminal:listProfiles'),
    saveProfile: (profile) => ipcRenderer.invoke('remoteTerminal:saveProfile', profile),
    deleteProfile: (id) => ipcRenderer.invoke('remoteTerminal:deleteProfile', id),
    credentialStatus: (profileId) =>
      ipcRenderer.invoke('remoteTerminal:credentialStatus', profileId),
    saveCredential: (profileId, kind, secret) =>
      ipcRenderer.invoke('remoteTerminal:saveCredential', profileId, kind, secret),
    deleteCredential: (profileId) =>
      ipcRenderer.invoke('remoteTerminal:deleteCredential', profileId),
    listRemoteDirectory: (profileId, remotePath, credential) =>
      ipcRenderer.invoke('remoteTerminal:listRemoteDirectory', profileId, remotePath, credential),
    listRemoteDirectoryPaged: (profileId, remotePath, cursor, credential) =>
      ipcRenderer.invoke(
        'remoteTerminal:listRemoteDirectoryPaged',
        profileId,
        remotePath,
        cursor,
        credential,
      ),
    mkdirRemote: (profileId, parentPath, name, credential) =>
      ipcRenderer.invoke('remoteTerminal:mkdirRemote', profileId, parentPath, name, credential),
    renameRemote: (profileId, oldPath, newName, credential) =>
      ipcRenderer.invoke('remoteTerminal:renameRemote', profileId, oldPath, newName, credential),
    removeRemote: (profileId, remotePath, credential) =>
      ipcRenderer.invoke('remoteTerminal:removeRemote', profileId, remotePath, credential),
    chooseUploadFile: () => ipcRenderer.invoke('remoteTerminal:chooseUploadFile'),
    chooseDownloadDirectory: () => ipcRenderer.invoke('remoteTerminal:chooseDownloadDirectory'),
    enqueueUpload: (profileId, remoteDirectory, selectionToken, credential, conflictPolicy) =>
      ipcRenderer.invoke(
        'remoteTerminal:enqueueUpload',
        profileId,
        remoteDirectory,
        selectionToken,
        credential,
        conflictPolicy,
      ),
    enqueueDownload: (
      profileId,
      remoteFilePath,
      totalBytes,
      selectionToken,
      credential,
      conflictPolicy,
    ) =>
      ipcRenderer.invoke(
        'remoteTerminal:enqueueDownload',
        profileId,
        remoteFilePath,
        totalBytes,
        selectionToken,
        credential,
        conflictPolicy,
      ),
    enqueueCatalogDownload: (actionToken, selectionToken, conflictPolicy) =>
      ipcRenderer.invoke(
        'remoteTerminal:enqueueCatalogDownload',
        actionToken,
        selectionToken,
        conflictPolicy,
      ),
    listTransfers: () => ipcRenderer.invoke('remoteTerminal:listTransfers'),
    cancelTransfer: (taskId) => ipcRenderer.invoke('remoteTerminal:cancelTransfer', taskId),
    clearTransferHistory: () => ipcRenderer.invoke('remoteTerminal:clearTransferHistory'),
    onTransferChanged: (cb) => {
      const handler = (_event: IpcRendererEvent, task: RemoteTransferTask) => cb(task)
      ipcRenderer.on('remoteTerminal:onTransferChanged', handler)
      return () => ipcRenderer.removeListener('remoteTerminal:onTransferChanged', handler)
    },
  },
  duplicateFinder: {
    scanDuplicates: (opts) => ipcRenderer.invoke('duplicates:scan', opts),
    stopScan: () => ipcRenderer.invoke('duplicates:stop'),
    getProgress: () => ipcRenderer.invoke('duplicates:getProgress'),
    getResults: () => ipcRenderer.invoke('duplicates:getResults'),
    findLargest: (opts) => ipcRenderer.invoke('duplicates:findLargest', opts),
    openPath: (filePath) => ipcRenderer.invoke('duplicates:openPath', filePath),
    onProgress: (cb) => {
      const handler = (_event: IpcRendererEvent, progress: DupScanProgress) => cb(progress)
      ipcRenderer.on('duplicates:onProgress', handler)
      return () => ipcRenderer.removeListener('duplicates:onProgress', handler)
    },
  },
  mediaSearch: {
    getStatus: (request) => ipcRenderer.invoke('mediaSearch:getStatus', request),
    getCacheStats: () => ipcRenderer.invoke('mediaSearch:getCacheStats'),
    clearCache: () => ipcRenderer.invoke('mediaSearch:clearCache'),
    clearData: () => ipcRenderer.invoke('mediaSearch:clearData'),
    listVideos: (request) => ipcRenderer.invoke('mediaSearch:listVideos', request),
    listFrames: (request) => ipcRenderer.invoke('mediaSearch:listFrames', request),
    getFrameImageDataUrl: (imagePath) =>
      ipcRenderer.invoke('mediaSearch:getFrameImageDataUrl', imagePath),
    getFramePreview: (request) => ipcRenderer.invoke('mediaSearch:getFramePreview', request),
    getFrameEmbeddingStats: () => ipcRenderer.invoke('mediaSearch:getFrameEmbeddingStats'),
    buildFrameEmbeddings: (request) =>
      ipcRenderer.invoke('mediaSearch:buildFrameEmbeddings', request),
    searchSimilarFrame: (request) => ipcRenderer.invoke('mediaSearch:searchSimilarFrame', request),
    selectQueryImage: () => ipcRenderer.invoke('mediaSearch:selectQueryImage'),
    pasteClipboardImage: () => ipcRenderer.invoke('mediaSearch:pasteClipboardImage'),
    searchFramesByImage: (request) =>
      ipcRenderer.invoke('mediaSearch:searchFramesByImage', request),
    searchFramesByText: (request) => ipcRenderer.invoke('mediaSearch:searchFramesByText', request),
    selectVideoPaths: (mode) => ipcRenderer.invoke('mediaSearch:selectVideoPaths', mode),
    listDrives: () => ipcRenderer.invoke('mediaSearch:listDrives'),
    validatePath: (filePath) => ipcRenderer.invoke('mediaSearch:validatePath', filePath),
    selectFfmpegDirectory: () => ipcRenderer.invoke('mediaSearch:selectFfmpegDirectory'),
    clearFfmpegDirectory: () => ipcRenderer.invoke('mediaSearch:clearFfmpegDirectory'),
    openFfmpegToolsDirectory: () => ipcRenderer.invoke('mediaSearch:openFfmpegToolsDirectory'),
    startScan: (args) =>
      ipcRenderer.invoke('videoIndex:startScan', args) as Promise<{
        ok: boolean
        taskId?: string
        error?: string
        warning?: string
      }>,
    buildFrames: (args) => ipcRenderer.invoke('mediaSearch:buildFrames', args),
    prepareLibrary: (args) => ipcRenderer.invoke('mediaSearch:prepareLibrary', args),
    stopTask: (taskId) => ipcRenderer.invoke('videoIndex:stopTask', taskId),
    getTaskProgress: (taskId) => ipcRenderer.invoke('videoIndex:getTaskProgress', taskId),
    openMediaAtTime: (input) => ipcRenderer.invoke('mediaSearch:openMediaAtTime', input),
    revealInExplorer: (input) => ipcRenderer.invoke('mediaSearch:revealInExplorer', input),
    onTaskProgress: (cb) => {
      const handler = (_event: IpcRendererEvent, progress: MediaSearchTaskProgress) => cb(progress)
      ipcRenderer.on('mediaSearch:onTaskProgress', handler)
      return () => ipcRenderer.removeListener('mediaSearch:onTaskProgress', handler)
    },
    onSearchProgress: (cb) => {
      const handler = (_event: IpcRendererEvent, progress: MediaSearchTaskProgress) => cb(progress)
      ipcRenderer.on('mediaSearch:onSearchProgress', handler)
      return () => ipcRenderer.removeListener('mediaSearch:onSearchProgress', handler)
    },
    detectSubtitles: (videoPath) => ipcRenderer.invoke('mediaSearch:detectSubtitles', videoPath),
    extractSubtitles: (videoId) => ipcRenderer.invoke('mediaSearch:extractSubtitles', videoId),
    searchTranscripts: (request) => ipcRenderer.invoke('mediaSearch:searchTranscripts', request),
    searchMultimodal: (request) => ipcRenderer.invoke('mediaSearch:searchMultimodal', request),
    getVideoSemanticStatus: (videoId, forceRefresh) =>
      ipcRenderer.invoke('mediaSearch:getVideoSemanticStatus', videoId, forceRefresh),
    getAudioSemanticStatus: (forceRefresh) =>
      ipcRenderer.invoke('mediaSearch:getAudioSemanticStatus', forceRefresh),
    startAudioSemanticBuild: (videoId) =>
      ipcRenderer.invoke('mediaSearch:startAudioSemanticBuild', videoId),
    stopAudioSemanticBuild: (jobId) =>
      ipcRenderer.invoke('mediaSearch:stopAudioSemanticBuild', jobId),
    resumeAudioSemanticBuild: (jobId) =>
      ipcRenderer.invoke('mediaSearch:resumeAudioSemanticBuild', jobId),
    setVideoSemanticProfile: (videoId, profileId) =>
      ipcRenderer.invoke('mediaSearch:setVideoSemanticProfile', videoId, profileId),
    startVideoSemanticBuild: (videoId) =>
      ipcRenderer.invoke('mediaSearch:startVideoSemanticBuild', videoId),
    stopVideoSemanticJob: (jobId) => ipcRenderer.invoke('mediaSearch:stopVideoSemanticJob', jobId),
    resumeVideoSemanticJob: (jobId) =>
      ipcRenderer.invoke('mediaSearch:resumeVideoSemanticJob', jobId),
  },
  assetLibrary: {
    getStats: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.GET_STATS),
    getFeedbackStatus: () => ipcRenderer.invoke(ASSET_FEEDBACK_IPC.GET_STATUS),
    setFeedbackEnabled: (enabled) => ipcRenderer.invoke(ASSET_FEEDBACK_IPC.SET_ENABLED, enabled),
    rebuildFeedbackModel: () => ipcRenderer.invoke(ASSET_FEEDBACK_IPC.REBUILD),
    listAssets: (request) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.LIST_ASSETS, request),
    listSmartAlbums: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.LIST_SMART_ALBUMS),
    createSmartAlbum: (input) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.CREATE_SMART_ALBUM, input),
    updateSmartAlbum: (id, input) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.UPDATE_SMART_ALBUM, id, input),
    deleteSmartAlbum: (id) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.DELETE_SMART_ALBUM, id),
    listCollections: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.LIST_COLLECTIONS),
    createCollection: (name) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.CREATE_COLLECTION, name),
    updateCollection: (id, name) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.UPDATE_COLLECTION, id, name),
    reorderCollections: (ids) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.REORDER_COLLECTIONS, ids),
    deleteCollection: (id) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.DELETE_COLLECTION, id),
    listCollectionItems: (id) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.LIST_COLLECTION_ITEMS, id),
    addCollectionItem: (id, input) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.ADD_COLLECTION_ITEM, id, input),
    addCollectionItems: (id, inputs) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.ADD_COLLECTION_ITEMS, id, inputs),
    removeCollectionItem: (id) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.REMOVE_COLLECTION_ITEM, id),
    syncFromImageIndex: (manifestPath) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.SYNC_FROM_IMAGE_INDEX, manifestPath),
    listCategories: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.LIST_CATEGORIES),
    createCategory: (input) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.CREATE_CATEGORY, input),
    updateCategory: (id, input) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.UPDATE_CATEGORY, id, input),
    deleteCategory: (id) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.DELETE_CATEGORY, id),
    listTags: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.LIST_TAGS),
    createTag: (input) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.CREATE_TAG, input),
    updateTag: (id, input) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.UPDATE_TAG, id, input),
    deleteTag: (id) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.DELETE_TAG, id),
    listMetadataDeletions: (request) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.LIST_METADATA_DELETIONS, request),
    exportMetadataDeletions: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.EXPORT_METADATA_DELETIONS),
    purgeMetadataDeletions: (request) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.PURGE_METADATA_DELETIONS, request),
    exportLibraryReport: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.EXPORT_LIBRARY_REPORT),
    restoreMetadataDeletion: (id) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.RESTORE_METADATA_DELETION, id),
    undoLastMetadataDeletion: () =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.UNDO_LAST_METADATA_DELETION),
    assignCategory: (assetIds, categoryId) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.ASSIGN_CATEGORY, assetIds, categoryId),
    assignTag: (assetIds, tagId) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.ASSIGN_TAG, assetIds, tagId),
    setCategorySampleFeedback: (assetIds, categoryId, relevant) =>
      ipcRenderer.invoke(
        ASSET_LIBRARY_IPC.SET_CATEGORY_SAMPLE_FEEDBACK,
        assetIds,
        categoryId,
        relevant,
      ),
    removeCategoryAssignment: (assetIds, categoryId) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.REMOVE_CATEGORY_ASSIGNMENT, assetIds, categoryId),
    removeTagAssignment: (assetIds, tagId) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.REMOVE_TAG_ASSIGNMENT, assetIds, tagId),
    archiveAssets: (assetIds) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.ARCHIVE_ASSETS, assetIds),
    restoreAssets: (assetIds) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.RESTORE_ASSETS, assetIds),
    setUserMetadata: (assetIds, patch) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.SET_USER_METADATA, assetIds, patch),
    listReferences: (categoryId) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.LIST_REFERENCES, categoryId),
    addReferences: (categoryId, assetIds, weight) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.ADD_REFERENCES, categoryId, assetIds, weight),
    selectReferenceImages: (categoryId) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.SELECT_REFERENCE_IMAGES, categoryId),
    pasteReferenceImage: (categoryId) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.PASTE_REFERENCE_IMAGE, categoryId),
    removeReference: (id) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.REMOVE_REFERENCE, id),
    buildReferenceSuggestions: (request) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.BUILD_REFERENCE_SUGGESTIONS, request),
    buildTagSuggestions: (request) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.BUILD_TAG_SUGGESTIONS, request),
    listSuggestions: (request) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.LIST_SUGGESTIONS, request),
    reviewSuggestions: (ids, status) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.REVIEW_SUGGESTIONS, ids, status),
    undoSuggestions: (ids) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.UNDO_SUGGESTIONS, ids),
    buildClusters: (request) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.BUILD_CLUSTERS, request),
    buildDuplicateGroups: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.BUILD_DUPLICATE_GROUPS),
    buildNearDuplicateGroups: (request) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.BUILD_NEAR_DUPLICATE_GROUPS, request),
    buildCategoryCluster: (request) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.BUILD_CATEGORY_CLUSTER, request),
    buildPeopleClusters: (request) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.BUILD_PEOPLE_CLUSTERS, request),
    refreshClusterLabels: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.REFRESH_CLUSTER_LABELS),
    selectClusterPaths: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.SELECT_CLUSTER_PATHS),
    listClusters: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.LIST_CLUSTERS),
    updateCluster: (id, patch) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.UPDATE_CLUSTER, id, patch),
    applyDuplicateGroup: (id) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.APPLY_DUPLICATE_GROUP, id),
    mergeClusters: (ids) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.MERGE_CLUSTERS, ids),
    splitCluster: (id, assetIds) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.SPLIT_CLUSTER, id, assetIds),
    moveClusterMembers: (fromId, toId, assetIds) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.MOVE_CLUSTER_MEMBERS, fromId, toId, assetIds),
    listClusterLineage: (request) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.LIST_CLUSTER_LINEAGE, request),
    promoteCluster: (clusterId, categoryId) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.PROMOTE_CLUSTER, clusterId, categoryId),
    startCategorySampleSearch: (request) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.START_CATEGORY_SAMPLE_SEARCH, request),
    getCategorySampleSearchResults: (query) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.GET_CATEGORY_SAMPLE_SEARCH_RESULTS, query),
    startSimilarSearch: (request) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.START_SIMILAR_SEARCH, request),
    getSimilarSearchResults: (query) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.GET_SIMILAR_SEARCH_RESULTS, query),
    stopTask: (taskId) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.STOP_TASK, taskId),
    getTaskProgress: (taskId) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.GET_TASK_PROGRESS, taskId),
    listBackups: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.LIST_BACKUPS),
    createBackup: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.CREATE_BACKUP),
    verifyBackup: (backupId) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.VERIFY_BACKUP, backupId),
    restoreBackup: (backupId) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.RESTORE_BACKUP, backupId),
    exportBackup: (backupId, passphrase) =>
      ipcRenderer.invoke(ASSET_LIBRARY_IPC.EXPORT_BACKUP, backupId, passphrase),
    importBackup: (passphrase) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.IMPORT_BACKUP, passphrase),
    deleteBackup: (backupId) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.DELETE_BACKUP, backupId),
    openBackupFolder: () => ipcRenderer.invoke(ASSET_LIBRARY_IPC.OPEN_BACKUP_FOLDER),
    openAsset: (assetId) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.OPEN_ASSET, assetId),
    revealAsset: (assetId) => ipcRenderer.invoke(ASSET_LIBRARY_IPC.REVEAL_ASSET, assetId),
    onTaskProgress: (cb) => {
      const handler = (_event: IpcRendererEvent, progress: AssetLibraryTaskProgress) => cb(progress)
      ipcRenderer.on(ASSET_LIBRARY_IPC.ON_TASK_PROGRESS, handler)
      return () => ipcRenderer.removeListener(ASSET_LIBRARY_IPC.ON_TASK_PROGRESS, handler)
    },
  },
  vector: {
    getComputeBackendCapability: () => ipcRenderer.invoke('vector:getComputeBackendCapability'),
    getModelStatus: (modelName) => ipcRenderer.invoke('vector:getModelStatus', modelName),
    downloadModel: (modelName) => ipcRenderer.invoke('vector:downloadModel', modelName),
    listUserModelSlots: () => ipcRenderer.invoke('vector:listUserModelSlots'),
    checkUserModelSlots: () => ipcRenderer.invoke('vector:checkUserModelSlots'),
    importUserModel: (slotId, acknowledgement, profileId) =>
      ipcRenderer.invoke('vector:importUserModel', slotId, acknowledgement, profileId),
    removeUserModel: (slotId) => ipcRenderer.invoke('vector:removeUserModel', slotId),
    openUserModelFolder: () => ipcRenderer.invoke('vector:openUserModelFolder'),
    cancelDownload: () => ipcRenderer.invoke('vector:cancelDownload'),
    deleteModel: (modelName) => ipcRenderer.invoke('vector:deleteModel', modelName),
    startEmbeddingBuild: (req) => ipcRenderer.invoke('vector:startEmbeddingBuild', req),
    stopEmbeddingBuild: () => ipcRenderer.invoke('vector:stopEmbeddingBuild'),
    pauseEmbeddingBuild: () => ipcRenderer.invoke('vector:pauseEmbeddingBuild'),
    resumeEmbeddingBuild: () => ipcRenderer.invoke('vector:resumeEmbeddingBuild'),
    getEmbeddingProgress: () => ipcRenderer.invoke('vector:getEmbeddingProgress'),
    buildVectorIndex: (modelName) => ipcRenderer.invoke('vector:buildVectorIndex', modelName),
    getVectorIndexStatus: () => ipcRenderer.invoke('vector:getVectorIndexStatus'),
    searchLayered: (req) => ipcRenderer.invoke('vector:searchLayered', req),
    stopLayeredSearch: () => ipcRenderer.invoke('vector:stopLayeredSearch'),
    searchSemantic: (req) => ipcRenderer.invoke('vector:searchSemantic', req),
    extractFeatures: (req) => ipcRenderer.invoke('vector:extractFeatures', req),
    getFeatureProgress: () => ipcRenderer.invoke('vector:getFeatureProgress'),
    getVectorSettings: () => ipcRenderer.invoke('vector:getVectorSettings'),
    saveVectorSettings: (settings) => ipcRenderer.invoke('vector:saveVectorSettings', settings),
    getVectorMaintenanceStats: () => ipcRenderer.invoke('vector:getVectorMaintenanceStats'),
    getVectorFailureRetryCandidates: (req) =>
      ipcRenderer.invoke('vector:getVectorFailureRetryCandidates', req),
    clearVectorDiagnostics: () => ipcRenderer.invoke('vector:clearVectorDiagnostics'),
    clearVectorFailures: () => ipcRenderer.invoke('vector:clearVectorFailures'),
    compactVectorJobs: () => ipcRenderer.invoke('vector:compactVectorJobs'),
    previewStorageCleanup: () => ipcRenderer.invoke('vector:previewStorageCleanup'),
    startStorageCleanup: (request) => ipcRenderer.invoke('vector:startStorageCleanup', request),
    getStorageCleanupProgress: () => ipcRenderer.invoke('vector:getStorageCleanupProgress'),
    cancelStorageCleanup: () => ipcRenderer.invoke('vector:cancelStorageCleanup'),
    previewProcessedImageData: () => ipcRenderer.invoke('vector:previewProcessedImageData'),
    clearProcessedImageData: () => ipcRenderer.invoke('vector:clearProcessedImageData'),
    previewVectorGc: () => ipcRenderer.invoke('vector:previewVectorGc'),
    startVectorGc: (token) => ipcRenderer.invoke('vector:startVectorGc', token),
    getVectorGcProgress: () => ipcRenderer.invoke('vector:getVectorGcProgress'),
    cancelVectorGc: () => ipcRenderer.invoke('vector:cancelVectorGc'),
    previewVectorStoreMigration: () => ipcRenderer.invoke('vector:previewVectorStoreMigration'),
    startVectorStoreMigration: (token) =>
      ipcRenderer.invoke('vector:startVectorStoreMigration', token),
    getVectorStoreMigrationProgress: () =>
      ipcRenderer.invoke('vector:getVectorStoreMigrationProgress'),
    cancelVectorStoreMigration: () => ipcRenderer.invoke('vector:cancelVectorStoreMigration'),
    onModelStatusChanged: (cb) => {
      const handler = (_event: IpcRendererEvent, status: ModelStatus) => cb(status)
      ipcRenderer.on('vector:onModelStatusChanged', handler)
      return () => ipcRenderer.removeListener('vector:onModelStatusChanged', handler)
    },
    onEmbeddingProgress: (cb) => {
      const handler = (_event: IpcRendererEvent, progress: EmbeddingProgress) => cb(progress)
      ipcRenderer.on('vector:onEmbeddingProgress', handler)
      return () => ipcRenderer.removeListener('vector:onEmbeddingProgress', handler)
    },
    onFeatureProgress: (cb) => {
      const handler = (_event: IpcRendererEvent, progress: FeatureExtractProgress) => cb(progress)
      ipcRenderer.on('vector:onFeatureProgress', handler)
      return () => ipcRenderer.removeListener('vector:onFeatureProgress', handler)
    },
    onSemanticSearchProgress: (cb) => {
      const handler = (_event: IpcRendererEvent, progress: SemanticSearchProgress) => cb(progress)
      ipcRenderer.on('vector:onSemanticSearchProgress', handler)
      return () => ipcRenderer.removeListener('vector:onSemanticSearchProgress', handler)
    },
    onLayeredSearchProgress: (cb) => {
      const handler = (_event: IpcRendererEvent, progress: LayeredSearchProgress) => cb(progress)
      ipcRenderer.on('vector:onLayeredSearchProgress', handler)
      return () => ipcRenderer.removeListener('vector:onLayeredSearchProgress', handler)
    },
  },
  // Batch Rename Recovery
  batchRename: {
    start: (req) => ipcRenderer.invoke('batchRename:start', req),
    stop: () => ipcRenderer.invoke('batchRename:stop'),
    getProgress: () => ipcRenderer.invoke('batchRename:getProgress'),
    getResult: () => ipcRenderer.invoke('batchRename:getResult'),
    selectFolder: () => ipcRenderer.invoke('batchRename:selectFolder'),
    onProgress: (cb) => {
      const handler = (_event: IpcRendererEvent, progress: BatchRenameProgress) => cb(progress)
      ipcRenderer.on('batchRename:onProgress', handler)
      return () => ipcRenderer.removeListener('batchRename:onProgress', handler)
    },
  },
  // Subject Search
  subject: {
    detect: (imagePath) => ipcRenderer.invoke('subject:detect', imagePath),
    search: (imagePath, topK?, subject?, segmentationSessionId?) =>
      ipcRenderer.invoke('subject:search', imagePath, topK, subject, segmentationSessionId),
    selectImage: () => ipcRenderer.invoke('subject:selectImage'),
  },
  // SAM Click Segmentation
  sam: {
    status: () => ipcRenderer.invoke('sam:status'),
    preview: (imagePath, maxWidth, maxHeight) =>
      ipcRenderer.invoke('sam:preview', imagePath, maxWidth, maxHeight),
    segment: (imagePath, points) => ipcRenderer.invoke('sam:segment', imagePath, points),
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)
