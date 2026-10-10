import type {
  ModelStatus,
  EmbeddingProgress,
  LayeredSearchRequest,
  LayeredSearchResponse,
  SemanticSearchRequest,
  SemanticSearchProgress,
  LayeredSearchProgress,
  SemanticSearchResponse,
  VectorBuildRequest,
  FeatureExtractRequest,
  FeatureExtractProgress,
  VectorSettings,
  ComputeBackendCapability,
} from '../vectorTypes'
import type { RuntimeOperationResult } from '../runtimeErrors'
import type {
  UserModelMutationResult,
  UserModelRuntimeStatus,
  UserModelSlotId,
  UserModelSlotStatus,
} from '../userModelPlatform'
import type {
  AssetCategory,
  AssetClusterGroup,
  AssetClusterLineageEvent,
  AssetLibraryCategoryInput,
  AssetLibraryBackupCreateResult,
  AssetLibraryBackupExportResult,
  AssetLibraryBackupImportResult,
  AssetLibraryBackupRestoreResult,
  AssetLibraryBackupSummary,
  AssetLibraryBackupVerification,
  AssetLibraryCategoryClusterRequest,
  AssetLibraryCategorySampleSearchRequest,
  AssetLibraryCategorySampleSearchResponse,
  AssetLibraryClusterRequest,
  AssetLibraryClusterPathSelectionResult,
  AssetLibraryClusterSummary,
  AssetLibraryExportDeletionsResult,
  AssetLibraryExportReportResult,
  AssetLibraryListRequest,
  AssetLibraryListResponse,
  AssetMetadataDeletionListRequest,
  AssetMetadataDeletionListResponse,
  AssetLibraryMutationResult,
  AssetLibraryPurgeMetadataDeletionsRequest,
  AssetLibraryPurgeMetadataDeletionsResult,
  AssetLibraryReferenceImportResult,
  AssetLibraryReferenceItem,
  AssetLibraryReferenceSuggestionRequest,
  AssetLibraryStats,
  AssetLibrarySimilarSearchRequest,
  AssetLibrarySimilarSearchResponse,
  AssetLibrarySearchResultQuery,
  AssetLibrarySuggestionListRequest,
  AssetLibrarySuggestionListResponse,
  AssetLibraryTagInput,
  AssetLibraryTagSuggestionRequest,
  AssetLibraryTaskProgress,
  AssetLibraryTaskResult,
  AssetUserMetadataSetter,
  AssetCollectionApi,
  AssetSmartAlbum,
  AssetSmartAlbumInput,
  AssetTag,
} from './asset-library'
import type { AssetFeedbackModelStatus } from './asset-feedback'
import type {
  DiscoveryAddSourceRequest,
  DiscoveryAddSourceResult,
  DiscoveryCatalogQueryRequest,
  DiscoveryCatalogQueryResponse,
  DiscoveryCatalogStats,
  DiscoveryRemoteDownloadGrant,
  DiscoveryRemoteVideoPrepareResult,
  DiscoveryRemotePreviewResult,
  DiscoveryRepairSourceRootResult,
  DiscoveryProbeResult,
  DiscoveryScanStartResult,
  DiscoveryScanStatus,
  DiscoverySourceListItem,
} from './discovery-catalog'
import type {
  AssetFileActionResult,
  AssetDerivedRebuildPreviewResult,
  AssetDerivedRebuildStartResult,
  AssetDerivedRebuildCancelResult,
  AssetIdentityResolveResult,
  AssetMoveRepairResult,
  AssetRepairRecoveryListResult,
  AssetShadowReport,
} from './asset-identity'
import type {
  UnifiedSchedulerStats,
  UnifiedResourceProfile,
  UnifiedSearchFeedbackMutationResult,
  UnifiedSearchFeedbackRequest,
  UnifiedSearchExportRequest,
  UnifiedSearchExportResult,
  UnifiedSearchRequest,
  UnifiedSearchResponse,
} from './unified-search'
import type {
  DupGroup,
  DupScanProgress,
  LargestFile,
  DupScanOptions,
  FileEntry,
  DirListing,
  DirListingPaged,
  DirListRequest,
  FMResult,
  FMProgress,
  FMFolderSizeProgress,
  FMFolderSizeRequest,
  FMFolderSizeResult,
  FMVolumeSpaceResult,
  ThumbnailResult,
} from './file-manager'
import type {
  ImageSearchStatus,
  ImageSearchStartScanArgs,
  ImageSearchPrepareLibraryArgs,
  ImageSearchPrepareLibraryStartResult,
  ImageSearchPreparationProgress,
  ImageSearchSearchArgs,
  ImageSearchSearchResponse,
  ImageHashResult,
  ImageSearchDataQueryResult,
  ImageSearchDataEditResult,
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
  ThumbnailRebuildProgress,
  ThumbnailRebuildBackend,
  VectorFailureRetryCandidates,
  StorageCleanupPreview,
  StorageCleanupProgress,
  ProcessedImageDataPreview,
  ProcessedImageDataResetResult,
  VectorClearDiagnosticsResult,
  VectorClearFailuresResult,
  VectorCompactJobsResult,
  VectorMaintenanceStats,
} from './image-search'
import type {
  VectorGcPreview,
  VectorGcProgress,
  VectorStoreMigrationPreview,
  VectorStoreMigrationProgress,
} from './vector-maintenance'
import type {
  AppSettingsData,
  AppConfigData,
  DisplayScope,
  WorkspaceTopology,
  WorkspaceWorkArea,
  AiControlAuditEntry,
  AiControlConfirmation,
  AiControlConfirmationResult,
  AiControlScope,
  AiControlSettings,
  AiControlSettingsResult,
  GlobalHotkeyStatus,
  WindowVisibilityEvent,
} from './app-core'
import type {
  RemoteTerminalProfile,
  RemoteTerminalConnectRequest,
  RemoteTerminalTestRequest,
  RemoteTerminalTestResult,
  RemoteServerMetricsRequest,
  RemoteServerMetricsSnapshot,
  RemoteTerminalSessionStatus,
  RemoteTerminalDataEvent,
  RemoteDirectoryResult,
  RemoteDirectoryPage,
  RemoteOperationResult,
  RemoteTransferTask,
  RemoteTransferSelection,
} from './remote-terminal'
import type { AppStorageScanStatus, AppStorageScanResult } from './app-storage'
import type {
  SubjectBBox,
  SubjectDetectionResult,
  SubjectSearchResult,
  SamPoint,
  SamSegmentResult,
  SamPreviewResult,
  BatchRenameProgress,
  BatchRenameStartRequest,
  BatchRenameStartResponse,
  BatchRenameResult,
} from './subject-search'
export interface ElectronAPI {
  openFolder: (path: string) => Promise<void>
  openThirdPartyLicenses: () => Promise<import('./app-core').OpenThirdPartyLicensesResult>
  viewEndUserTerms: () => Promise<import('./end-user-terms').ViewEndUserTermsResult>
  copyToClipboard: (text: string) => Promise<void>
  browseFolder: () => Promise<string | null>
  sourceDerivedData: {
    preview: (
      request: import('./source-derived-data').SourceDerivedDataPreviewRequest,
    ) => Promise<import('./source-derived-data').SourceDerivedDataPreview>
    execute: (
      token: string,
    ) => Promise<import('./source-derived-data').SourceDerivedDataCleanupResult>
    progress: () => Promise<import('./source-derived-data').SourceDerivedDataCleanupProgress>
    syncPreview: (
      request: import('./source-derived-data').SourceFileSyncPreviewRequest,
    ) => Promise<import('./source-derived-data').SourceFileSyncPreview>
    syncExecute: (token: string) => Promise<import('./source-derived-data').SourceFileSyncResult>
    syncProgress: () => Promise<import('./source-derived-data').SourceFileSyncProgress>
  }
  getPathForFile: (file: File) => string
  fileDrag: {
    start: (token: string, mode: 'compatible' | 'original') => void
    onError: (cb: (message: string) => void) => () => void
  }
  setTransparency: (opacity: number) => Promise<void>
  getHotkeyStatus: () => Promise<GlobalHotkeyStatus>
  registerHotkey: () => Promise<GlobalHotkeyStatus>
  unregisterHotkey: () => Promise<void>
  loadSettings: () => Promise<AppSettingsData | null>
  saveSettings: (settings: Partial<AppSettingsData>) => Promise<void>
  loadConfig: () => Promise<AppConfigData | null>
  saveConfig: (config: AppConfigData) => Promise<void>
  openConfigDir: () => Promise<void>
  setIgnoreMouseEvents: (ignore: boolean, generation: number) => Promise<void>
  setOverlayShape: (
    rects: { x: number; y: number; width: number; height: number }[],
    generation: number,
  ) => Promise<{ x: number; y: number; width: number; height: number }>
  getWorkArea: () => Promise<WorkspaceWorkArea>
  getDisplayTopology: () => Promise<WorkspaceTopology>
  setDisplayScope: (scope: DisplayScope) => Promise<WorkspaceTopology>
  onSnapPanels: (cb: (wa: WorkspaceWorkArea) => void) => () => void
  onShowAllPanels: (cb: (wa: WorkspaceWorkArea) => void) => () => void
  onArrangeHorizontal: (cb: () => void) => () => void
  onArrangeGrid: (cb: () => void) => () => void
  onArrangeVertical: (cb: () => void) => () => void
  onToggleGlobalVisibility: (cb: (event: WindowVisibilityEvent) => void) => () => void
  onShowGlobalVisibility: (cb: (event: WindowVisibilityEvent) => void) => () => void
  onGlobalWindowShownForPaint: (cb: (event: WindowVisibilityEvent) => void) => () => void
  onWorkAreaChanged: (cb: (wa: WorkspaceWorkArea) => void) => () => void
  onHotkeyWarnings: (cb: (failures: string[]) => void) => () => void
  hideWindow: () => Promise<void>
  showWindow: (generation: number) => Promise<boolean>
  revealWindow: (generation: number) => Promise<boolean>
  getWindowAlwaysOnTop: () => Promise<boolean>
  setWindowAlwaysOnTop: (value: boolean) => Promise<boolean>
  getAiControlSettings: () => Promise<AiControlSettings>
  setAiControlEnabled: (
    enabled: boolean,
    port?: number,
    scopes?: AiControlScope[],
  ) => Promise<AiControlSettingsResult>
  rotateAiControlToken: (scopes?: AiControlScope[]) => Promise<AiControlSettingsResult>
  getAiControlAudit: () => Promise<AiControlAuditEntry[]>
  getAiControlConfirmations: () => Promise<AiControlConfirmation[]>
  resolveAiControlConfirmation: (
    confirmationId: string,
    approved: boolean,
  ) => Promise<AiControlConfirmationResult>
  fmExpandPath: (p: string) => Promise<string>
  fmPathExists: (p: string) => Promise<boolean>
  fmListDirectory: (dirPath: string) => Promise<DirListing>
  fmListDirectoryPaged: (req: DirListRequest) => Promise<DirListingPaged>
  fmGetVolumeSpace: (rootPath: string) => Promise<FMVolumeSpaceResult>
  fmGetFolderSize: (request: FMFolderSizeRequest) => Promise<FMFolderSizeResult>
  fmCancelFolderSizeRequests: (requestId: string) => Promise<void>
  onFMFolderSizeProgress: (cb: (progress: FMFolderSizeProgress) => void) => () => void
  fmGetFileInfo: (filePath: string) => Promise<FileEntry & { error?: string }>
  fmOpenFile: (filePath: string) => Promise<void | { error?: string }>
  fmOpenInExplorer: (filePath: string) => Promise<void>
  fmCreateDirectory: (parentDir: string, name: string) => Promise<FMResult>
  fmRenameFile: (oldPath: string, newName: string) => Promise<FMResult>
  fmDeleteFiles: (paths: string[]) => Promise<{ path: string; success: boolean; error?: string }[]>
  fmCopyFiles: (
    sources: string[],
    destDir: string,
    options?: { conflict?: 'overwrite' | 'rename' },
  ) => Promise<{ path: string; success: boolean; error?: string }[]>
  fmMoveFiles: (
    sources: string[],
    destDir: string,
    options?: { conflict?: 'overwrite' | 'rename' },
  ) => Promise<{ path: string; success: boolean; error?: string }[]>
  onFMCopyProgress: (cb: (info: FMProgress) => void) => () => void
  fmGetThumbnail: (filePath: string, maxDim?: number) => Promise<ThumbnailResult>
  fmGetFolderThumbnails: (
    folderPath: string,
    maxCount?: number,
    maxDim?: number,
  ) => Promise<ThumbnailResult[]>
  fmGetFileIcons: (
    requests: { path: string; size?: 'small' | 'normal' | 'large' }[],
  ) => Promise<ThumbnailResult[]>
  fmGetThumbnailsBatch: (requests: { path: string; maxDim: number }[]) => Promise<ThumbnailResult[]>
  fmWatchDir: (dirPath: string) => Promise<void>
  fmUnwatchDir: (dirPath: string) => Promise<void>
  onDirChanged: (cb: (dirPath: string) => void) => () => void
  fmAbortOperation: () => Promise<void>
  discoveryCatalog: {
    listSources: () => Promise<DiscoverySourceListItem[]>
    addSource: (request: DiscoveryAddSourceRequest) => Promise<DiscoveryAddSourceResult>
    removeSource: (sourceId: string) => Promise<{ ok: boolean; error?: string }>
    repairSourceRoot: (
      sourceId: string,
      newRoot: string,
    ) => Promise<DiscoveryRepairSourceRootResult>
    probeSource: (sourceId: string) => Promise<DiscoveryProbeResult>
    startScan: (sourceId: string) => Promise<DiscoveryScanStartResult>
    cancelScan: (sourceId: string) => Promise<{ ok: boolean; error?: string }>
    getScanStatus: (sourceId?: string) => Promise<DiscoveryScanStatus[]>
    onScanStatusChanged: (cb: (status: DiscoveryScanStatus) => void) => () => void
    query: (request: DiscoveryCatalogQueryRequest) => Promise<DiscoveryCatalogQueryResponse>
    getStats: () => Promise<DiscoveryCatalogStats>
    createRemoteDownloadGrant: (fileEntryId: string) => Promise<DiscoveryRemoteDownloadGrant>
    prepareRemoteVideo: (
      actionToken: string,
      timestampMs?: number,
    ) => Promise<DiscoveryRemoteVideoPrepareResult>
    getRemotePreview: (
      fileEntryId: string,
      maxDim?: number,
    ) => Promise<DiscoveryRemotePreviewResult>
  }
  assetIdentity: {
    resolve: (filePath: string) => Promise<AssetIdentityResolveResult>
    getShadowReport: () => Promise<AssetShadowReport>
    openOriginal: (ref: string) => Promise<AssetFileActionResult>
    revealOriginal: (ref: string) => Promise<AssetFileActionResult>
    repairMoved: (newPath: string) => Promise<AssetMoveRepairResult>
    previewDerivedRebuild: (token: string) => Promise<AssetDerivedRebuildPreviewResult>
    startDerivedRebuild: (token: string) => Promise<AssetDerivedRebuildStartResult>
    cancelDerivedRebuild: (token: string) => Promise<AssetDerivedRebuildCancelResult>
    listPendingRepairs: () => Promise<AssetRepairRecoveryListResult>
  }
  unifiedSearch: {
    query: (request: UnifiedSearchRequest) => Promise<UnifiedSearchResponse>
    setVisiblePaths: (paths: string[]) => Promise<{ bumped: number }>
    getSchedulerStats: () => Promise<UnifiedSchedulerStats>
    setResourceProfile: (
      profile: UnifiedResourceProfile,
    ) => Promise<{ ok: boolean; stats?: UnifiedSchedulerStats; error?: string }>
    cancelBackgroundTasks: () => Promise<{ cancelled: number }>
    saveFeedback: (
      request: UnifiedSearchFeedbackRequest,
    ) => Promise<UnifiedSearchFeedbackMutationResult>
    undoFeedback: (feedbackId: string) => Promise<UnifiedSearchFeedbackMutationResult>
    exportResults: (request: UnifiedSearchExportRequest) => Promise<UnifiedSearchExportResult>
  }
  productHealth: {
    getReport: () => Promise<import('./product-health').ProductHealthReport>
    runRepair: (
      request: import('./product-health').ProductHealthRepairRequest,
    ) => Promise<import('./product-health').ProductHealthRepairResult>
    saveReport: () => Promise<import('./product-health').ProductHealthExportResult>
  }
  imageSearch: {
    getStatus: () => Promise<ImageSearchStatus>
    startScan: (args: ImageSearchStartScanArgs) => Promise<ImageSearchStatus>
    stopScan: () => Promise<ImageSearchStatus>
    prepareLibrary: (
      args: ImageSearchPrepareLibraryArgs,
    ) => Promise<ImageSearchPrepareLibraryStartResult>
    getPreparationProgress: () => Promise<ImageSearchPreparationProgress>
    stopPreparation: (taskId?: string) => Promise<{ ok: boolean; error?: string }>
    onPreparationProgress: (cb: (progress: ImageSearchPreparationProgress) => void) => () => void
    search: (args: ImageSearchSearchArgs) => Promise<ImageSearchSearchResponse>
    selectPaths: () => Promise<string[] | null>
    onStatusChanged: (cb: (status: ImageSearchStatus) => void) => () => void
    hashImage: (filePath: string) => Promise<ImageHashResult>
    selectImage: () => Promise<string | null>
    pasteClipboardImage: () => Promise<{ ok: boolean; path?: string; error?: string }>
    openFile: (filePath: string) => Promise<void>
    openFolder: (filePath: string) => Promise<void>
    clearIndex: () => Promise<{ ok: boolean }>
    saveIndex: () => Promise<{ ok: boolean; recordCount?: number; error?: string }>
    loadIndex: (filePath: string) => Promise<{ ok: boolean; recordCount?: number }>
    loadManifest: (
      rootDir: string,
    ) => Promise<{ ok: boolean; recordCount?: number; segmentCount?: number; error?: string }>
    repairManifest: (
      rootDir: string,
    ) => Promise<{ ok: boolean; recordCount?: number; segmentCount?: number; error?: string }>
    getIndexMode: () => Promise<{
      mode: string
      recordCount: number
      segmentPath: string
      version: number
    }>
    listDrives: () => Promise<string[]>
    validatePath: (filePath: string) => Promise<{ ok: boolean; error?: string }>
    queryData: (
      query: string,
      offset?: number,
      limit?: number,
    ) => Promise<ImageSearchDataQueryResult>
    getDataStats: (prefix: string) => Promise<ImageSearchDataStatsResult>
    getDataOverview: () => Promise<ImageSearchDataOverview>
    startDataCatalogBuild: () => Promise<ImageSearchDataCatalogStartResult>
    getDataCatalogProgress: () => Promise<ImageSearchDataCatalogProgress>
    cancelDataCatalogBuild: () => Promise<{ ok: boolean }>
    listDataFolders: (request?: ImageSearchDataFolderQuery) => Promise<ImageSearchDataFolderList>
    openDataStoreLocation: (storeId: string) => Promise<{ ok: boolean; error?: string }>
    previewFolderDataEdit: (
      folder: string,
      layers: ImageSearchFolderDataLayer[],
    ) => Promise<ImageSearchFolderDataEditPreview>
    executeFolderDataEdit: (token: string) => Promise<ImageSearchFolderDataEditResult>
    getFolderDataEditProgress: () => Promise<ImageSearchFolderDataEditProgress>
    cancelFolderDataEdit: () => Promise<{ ok: boolean }>
    getDirNameStats: (name: string) => Promise<ImageSearchDataStatsResult>
    updateData: (filePath: string) => Promise<ImageSearchDataEditResult>
    deleteData: (filePath: string) => Promise<ImageSearchDataEditResult>
    deleteDataFolder: (folder: string) => Promise<ImageSearchDataEditResult>
    deleteDirName: (name: string) => Promise<ImageSearchDataEditResult>
    repairDataPath: (oldPath: string, newPath: string) => Promise<ImageSearchDataEditResult>
    startThumbnailRebuild: (
      paths: string[],
      backend?: ThumbnailRebuildBackend,
      gpuJobs?: number,
      batchSize?: number,
    ) => Promise<{ ok: boolean; progress?: ThumbnailRebuildProgress; error?: string }>
    getThumbnailRebuildProgress: () => Promise<ThumbnailRebuildProgress>
    stopThumbnailRebuild: () => Promise<ThumbnailRebuildProgress>
    clearThumbnailCache: (
      confirm: boolean,
    ) => Promise<{ ok: boolean; cleanupStarted?: boolean; error?: string }>
    pauseScan: () => Promise<{ ok: boolean }>
    resumeScan: () => Promise<{ ok: boolean }>
    isScanPaused: () => Promise<{ paused: boolean }>
  }
  appStorage: {
    scan: () => Promise<AppStorageScanResult>
    stop: () => Promise<{ ok: boolean }>
    getStatus: () => Promise<AppStorageScanStatus>
    loadCached: () => Promise<AppStorageScanResult | null>
    clearCached: () => Promise<{ ok: boolean; error?: string }>
    openPath: (folderPath: string) => Promise<{ ok: boolean; error?: string }>
    onStatusChanged: (cb: (status: AppStorageScanStatus) => void) => () => void
  }
  remoteTerminal: {
    listProfiles: () => Promise<RemoteTerminalProfile[]>
    saveProfile: (profile: RemoteTerminalProfile) => Promise<{ ok: boolean; error?: string }>
    deleteProfile: (id: string) => Promise<{ ok: boolean; error?: string }>
    connect: (req: RemoteTerminalConnectRequest) => Promise<RemoteTerminalSessionStatus>
    testConnection: (req: RemoteTerminalTestRequest) => Promise<RemoteTerminalTestResult>
    collectMetrics: (req: RemoteServerMetricsRequest) => Promise<RemoteServerMetricsSnapshot>
    credentialStatus: (
      profileId: string,
    ) => Promise<{ available: boolean; stored: boolean; kind?: 'password' | 'passphrase' }>
    saveCredential: (
      profileId: string,
      kind: 'password' | 'passphrase',
      secret: string,
    ) => Promise<{ ok: boolean; error?: string }>
    deleteCredential: (profileId: string) => Promise<{ ok: boolean; error?: string }>
    listRemoteDirectory: (
      profileId: string,
      remotePath: string,
      credential?: { password?: string; passphrase?: string },
    ) => Promise<RemoteDirectoryResult>
    listRemoteDirectoryPaged: (
      profileId: string,
      remotePath: string,
      cursor?: string,
      credential?: { password?: string; passphrase?: string },
    ) => Promise<RemoteDirectoryPage>
    mkdirRemote: (
      profileId: string,
      parentPath: string,
      name: string,
      credential?: { password?: string; passphrase?: string },
    ) => Promise<RemoteOperationResult>
    renameRemote: (
      profileId: string,
      oldPath: string,
      newName: string,
      credential?: { password?: string; passphrase?: string },
    ) => Promise<RemoteOperationResult>
    removeRemote: (
      profileId: string,
      remotePath: string,
      credential?: { password?: string; passphrase?: string },
    ) => Promise<RemoteOperationResult>
    chooseUploadFile: () => Promise<RemoteTransferSelection>
    chooseDownloadDirectory: () => Promise<RemoteTransferSelection>
    enqueueUpload: (
      profileId: string,
      remoteDirectory: string,
      selectionToken: string,
      credential?: { password?: string; passphrase?: string },
      conflictPolicy?: 'ask' | 'overwrite' | 'skip' | 'rename',
    ) => Promise<{ ok: boolean; task?: RemoteTransferTask; error?: string }>
    enqueueDownload: (
      profileId: string,
      remoteFilePath: string,
      totalBytes: number,
      selectionToken: string,
      credential?: { password?: string; passphrase?: string },
      conflictPolicy?: 'ask' | 'overwrite' | 'skip' | 'rename',
    ) => Promise<{ ok: boolean; task?: RemoteTransferTask; error?: string }>
    enqueueCatalogDownload: (
      actionToken: string,
      selectionToken: string,
      conflictPolicy?: 'ask' | 'overwrite' | 'skip' | 'rename',
    ) => Promise<{ ok: boolean; task?: RemoteTransferTask; error?: string }>
    listTransfers: () => Promise<RemoteTransferTask[]>
    cancelTransfer: (taskId: string) => Promise<{ ok: boolean; error?: string }>
    clearTransferHistory: () => Promise<{ ok: boolean }>
    onTransferChanged: (cb: (task: RemoteTransferTask) => void) => () => void
    disconnect: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
    write: (sessionId: string, data: string) => Promise<{ ok: boolean; error?: string }>
    resize: (
      sessionId: string,
      size: { cols: number; rows: number },
    ) => Promise<{ ok: boolean; error?: string }>
    onData: (cb: (event: RemoteTerminalDataEvent) => void) => () => void
    onStatusChanged: (cb: (status: RemoteTerminalSessionStatus) => void) => () => void
  }
  duplicateFinder: {
    scanDuplicates: (opts: DupScanOptions) => Promise<{ ok: boolean; error?: string }>
    stopScan: () => Promise<{ ok: boolean }>
    getProgress: () => Promise<DupScanProgress>
    getResults: () => Promise<{ groups: DupGroup[] }>
    findLargest: (opts: {
      dirPath: string
      topN: number
    }) => Promise<{ ok: boolean; files: LargestFile[]; error?: string }>
    openPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>
    onProgress: (cb: (progress: DupScanProgress) => void) => () => void
  }
  mediaSearch: import('./media-search').MediaSearchApi & {}
  assetLibrary: {
    getStats: () => Promise<AssetLibraryStats>
    getFeedbackStatus: () => Promise<AssetFeedbackModelStatus>
    setFeedbackEnabled: (enabled: boolean) => Promise<AssetFeedbackModelStatus>
    rebuildFeedbackModel: () => Promise<AssetLibraryTaskResult>
    listAssets: (request?: AssetLibraryListRequest) => Promise<AssetLibraryListResponse>
    listSmartAlbums: () => Promise<AssetSmartAlbum[]>
    createSmartAlbum: (input: AssetSmartAlbumInput) => Promise<AssetSmartAlbum>
    updateSmartAlbum: (id: number, input: Partial<AssetSmartAlbumInput>) => Promise<AssetSmartAlbum>
    deleteSmartAlbum: (id: number) => Promise<AssetLibraryMutationResult>
    listCollections: AssetCollectionApi['listCollections']
    createCollection: AssetCollectionApi['createCollection']
    updateCollection: AssetCollectionApi['updateCollection']
    reorderCollections: AssetCollectionApi['reorderCollections']
    deleteCollection: AssetCollectionApi['deleteCollection']
    listCollectionItems: AssetCollectionApi['listCollectionItems']
    addCollectionItem: AssetCollectionApi['addCollectionItem']
    addCollectionItems: AssetCollectionApi['addCollectionItems']
    removeCollectionItem: AssetCollectionApi['removeCollectionItem']
    syncFromImageIndex: (manifestPath?: string) => Promise<AssetLibraryTaskResult>
    listCategories: () => Promise<AssetCategory[]>
    createCategory: (input: AssetLibraryCategoryInput) => Promise<AssetCategory>
    updateCategory: (
      id: number,
      input: Partial<AssetLibraryCategoryInput>,
    ) => Promise<AssetCategory>
    deleteCategory: (id: number) => Promise<AssetLibraryMutationResult>
    listTags: () => Promise<AssetTag[]>
    createTag: (input: AssetLibraryTagInput) => Promise<AssetTag>
    updateTag: (id: number, input: Partial<AssetLibraryTagInput>) => Promise<AssetTag>
    deleteTag: (id: number) => Promise<AssetLibraryMutationResult>
    listMetadataDeletions: (
      request?: AssetMetadataDeletionListRequest,
    ) => Promise<AssetMetadataDeletionListResponse>
    exportMetadataDeletions: () => Promise<AssetLibraryExportDeletionsResult>
    purgeMetadataDeletions: (
      request?: AssetLibraryPurgeMetadataDeletionsRequest,
    ) => Promise<AssetLibraryPurgeMetadataDeletionsResult>
    exportLibraryReport: () => Promise<AssetLibraryExportReportResult>
    restoreMetadataDeletion: (id: number) => Promise<AssetLibraryMutationResult>
    undoLastMetadataDeletion: () => Promise<AssetLibraryMutationResult>
    assignCategory: (assetIds: number[], categoryId: number) => Promise<AssetLibraryMutationResult>
    assignTag: (assetIds: number[], tagId: number) => Promise<AssetLibraryMutationResult>
    setCategorySampleFeedback: (
      assetIds: number[],
      categoryId: number,
      relevant: boolean,
    ) => Promise<AssetLibraryMutationResult>
    removeCategoryAssignment: (
      assetIds: number[],
      categoryId: number,
    ) => Promise<AssetLibraryMutationResult>
    removeTagAssignment: (assetIds: number[], tagId: number) => Promise<AssetLibraryMutationResult>
    archiveAssets: (assetIds: number[]) => Promise<AssetLibraryMutationResult>
    restoreAssets: (assetIds: number[]) => Promise<AssetLibraryMutationResult>
    setUserMetadata: AssetUserMetadataSetter
    listReferences: (categoryId?: number) => Promise<AssetLibraryReferenceItem[]>
    addReferences: (
      categoryId: number,
      assetIds: number[],
      weight?: number,
    ) => Promise<AssetLibraryMutationResult>
    selectReferenceImages: (categoryId: number) => Promise<AssetLibraryReferenceImportResult>
    pasteReferenceImage: (categoryId: number) => Promise<AssetLibraryReferenceImportResult>
    removeReference: (id: number) => Promise<AssetLibraryMutationResult>
    buildReferenceSuggestions: (
      request?: AssetLibraryReferenceSuggestionRequest,
    ) => Promise<AssetLibraryTaskResult>
    buildTagSuggestions: (
      request?: AssetLibraryTagSuggestionRequest,
    ) => Promise<AssetLibraryTaskResult>
    listSuggestions: (
      request?: AssetLibrarySuggestionListRequest,
    ) => Promise<AssetLibrarySuggestionListResponse>
    reviewSuggestions: (
      ids: number[],
      status: 'confirmed' | 'rejected' | 'ignored',
    ) => Promise<AssetLibraryMutationResult>
    undoSuggestions: (ids: number[]) => Promise<AssetLibraryMutationResult>
    buildClusters: (request?: AssetLibraryClusterRequest) => Promise<AssetLibraryTaskResult>
    buildDuplicateGroups: () => Promise<AssetLibraryTaskResult>
    buildNearDuplicateGroups: (request?: { threshold?: number }) => Promise<AssetLibraryTaskResult>
    buildCategoryCluster: (
      request: AssetLibraryCategoryClusterRequest,
    ) => Promise<AssetLibraryTaskResult>
    buildPeopleClusters: (request?: AssetLibraryClusterRequest) => Promise<AssetLibraryTaskResult>
    refreshClusterLabels: () => Promise<AssetLibraryTaskResult>
    selectClusterPaths: () => Promise<AssetLibraryClusterPathSelectionResult>
    listClusters: () => Promise<AssetLibraryClusterSummary[]>
    updateCluster: (
      id: number,
      patch: { name?: string; status?: AssetClusterGroup['status'] },
    ) => Promise<AssetClusterGroup>
    applyDuplicateGroup: (id: number) => Promise<{ ok: boolean; archived?: number; error?: string }>
    mergeClusters: (
      ids: number[],
    ) => Promise<{ ok: boolean; group?: AssetClusterGroup; error?: string }>
    splitCluster: (
      id: number,
      assetIds: number[],
    ) => Promise<{ ok: boolean; group?: AssetClusterGroup; error?: string }>
    moveClusterMembers: (
      fromId: number,
      toId: number | null,
      assetIds: number[],
    ) => Promise<{ ok: boolean; error?: string }>
    listClusterLineage: (request?: {
      groupId?: number
      limit?: number
    }) => Promise<AssetClusterLineageEvent[]>
    promoteCluster: (
      clusterId: number,
      categoryId?: number,
    ) => Promise<{ ok: boolean; category?: AssetCategory; error?: string }>
    startCategorySampleSearch: (
      request: AssetLibraryCategorySampleSearchRequest,
    ) => Promise<AssetLibraryTaskResult>
    getCategorySampleSearchResults: (
      query?: AssetLibrarySearchResultQuery,
    ) => Promise<AssetLibraryCategorySampleSearchResponse | null>
    startSimilarSearch: (
      request: AssetLibrarySimilarSearchRequest,
    ) => Promise<AssetLibraryTaskResult>
    getSimilarSearchResults: (
      query?: AssetLibrarySearchResultQuery,
    ) => Promise<AssetLibrarySimilarSearchResponse | null>
    stopTask: (taskId?: string) => Promise<AssetLibraryMutationResult>
    getTaskProgress: (taskId?: string) => Promise<AssetLibraryTaskProgress | null>
    listBackups: () => Promise<AssetLibraryBackupSummary[]>
    createBackup: () => Promise<AssetLibraryBackupCreateResult>
    verifyBackup: (backupId: string) => Promise<AssetLibraryBackupVerification>
    restoreBackup: (backupId: string) => Promise<AssetLibraryBackupRestoreResult>
    exportBackup: (backupId: string, passphrase: string) => Promise<AssetLibraryBackupExportResult>
    importBackup: (passphrase: string) => Promise<AssetLibraryBackupImportResult>
    deleteBackup: (backupId: string) => Promise<AssetLibraryMutationResult>
    openBackupFolder: () => Promise<AssetLibraryMutationResult>
    openAsset: (assetId: number) => Promise<AssetLibraryMutationResult>
    revealAsset: (assetId: number) => Promise<AssetLibraryMutationResult>
    onTaskProgress: (cb: (progress: AssetLibraryTaskProgress) => void) => () => void
  }
  vector: {
    getComputeBackendCapability: () => Promise<ComputeBackendCapability>
    getModelStatus: (modelName?: string) => Promise<ModelStatus>
    downloadModel: (modelName: string) => Promise<{ ok: boolean; error?: string }>
    listUserModelSlots: () => Promise<UserModelSlotStatus[]>
    checkUserModelSlots: () => Promise<UserModelRuntimeStatus[]>
    importUserModel: (
      slotId: UserModelSlotId,
      acknowledgement: true,
      profileId?: string,
    ) => Promise<UserModelMutationResult>
    removeUserModel: (slotId: UserModelSlotId) => Promise<UserModelMutationResult>
    openUserModelFolder: () => Promise<{ ok: boolean; error?: string }>
    cancelDownload: () => Promise<{ ok: boolean }>
    deleteModel: (modelName: string) => Promise<{ ok: boolean; error?: string }>
    startEmbeddingBuild: (req: VectorBuildRequest) => Promise<RuntimeOperationResult>
    stopEmbeddingBuild: () => Promise<{ ok: boolean }>
    pauseEmbeddingBuild: () => Promise<{ ok: boolean }>
    resumeEmbeddingBuild: () => Promise<{ ok: boolean }>
    getEmbeddingProgress: () => Promise<EmbeddingProgress>
    buildVectorIndex: (
      modelName: string,
    ) => Promise<{ ok: boolean; error?: string; warning?: string }>
    getVectorIndexStatus: () => Promise<{
      built: boolean
      count: number
      modelName?: string
      dim?: number
      error?: string
    }>
    searchLayered: (req: LayeredSearchRequest) => Promise<LayeredSearchResponse>
    stopLayeredSearch: () => Promise<{ ok: boolean }>
    searchSemantic: (req: SemanticSearchRequest) => Promise<SemanticSearchResponse>
    extractFeatures: (req: FeatureExtractRequest) => Promise<{ ok: boolean; error?: string }>
    getFeatureProgress: () => Promise<FeatureExtractProgress>
    getVectorSettings: () => Promise<VectorSettings>
    saveVectorSettings: (settings: Partial<VectorSettings>) => Promise<{ ok: boolean }>
    getVectorMaintenanceStats: () => Promise<VectorMaintenanceStats>
    getVectorFailureRetryCandidates: (req?: {
      modelName?: string
      reason?: string
      limit?: number
    }) => Promise<VectorFailureRetryCandidates>
    clearVectorDiagnostics: () => Promise<VectorClearDiagnosticsResult>
    clearVectorFailures: () => Promise<VectorClearFailuresResult>
    compactVectorJobs: () => Promise<VectorCompactJobsResult>
    previewStorageCleanup: () => Promise<StorageCleanupPreview>
    startStorageCleanup: (request: {
      token: string
      selectedIds: string[]
    }) => Promise<{ ok: boolean; taskId?: string; error?: string }>
    getStorageCleanupProgress: () => Promise<StorageCleanupProgress>
    cancelStorageCleanup: () => Promise<{ ok: boolean }>
    previewProcessedImageData: () => Promise<ProcessedImageDataPreview>
    clearProcessedImageData: () => Promise<ProcessedImageDataResetResult>
    previewVectorGc: () => Promise<VectorGcPreview>
    startVectorGc: (token: string) => Promise<{ ok: boolean; taskId?: string; error?: string }>
    getVectorGcProgress: () => Promise<VectorGcProgress>
    cancelVectorGc: () => Promise<{ ok: boolean }>
    previewVectorStoreMigration: () => Promise<VectorStoreMigrationPreview>
    startVectorStoreMigration: (
      token: string,
    ) => Promise<{ ok: boolean; taskId?: string; error?: string }>
    getVectorStoreMigrationProgress: () => Promise<VectorStoreMigrationProgress>
    cancelVectorStoreMigration: () => Promise<{ ok: boolean }>
    onModelStatusChanged: (cb: (status: ModelStatus) => void) => () => void
    onEmbeddingProgress: (cb: (progress: EmbeddingProgress) => void) => () => void
    onFeatureProgress: (cb: (progress: FeatureExtractProgress) => void) => () => void
    onSemanticSearchProgress: (cb: (progress: SemanticSearchProgress) => void) => () => void
    onLayeredSearchProgress: (cb: (progress: LayeredSearchProgress) => void) => () => void
  }
  subject: {
    detect: (imagePath: string) => Promise<SubjectDetectionResult>
    search: (
      imagePath: string,
      topK?: number,
      subject?: SubjectBBox,
      segmentationSessionId?: string,
    ) => Promise<{
      ok: boolean
      results: SubjectSearchResult[]
      error?: string
      subjectLabel?: string
    }>
    selectImage: () => Promise<string | null>
  }
  sam: {
    status: () => Promise<{ ready: boolean; error?: string }>
    preview: (imagePath: string, maxWidth: number, maxHeight: number) => Promise<SamPreviewResult>
    segment: (imagePath: string, points: SamPoint[]) => Promise<SamSegmentResult>
  }
  batchRename: {
    start: (req: BatchRenameStartRequest) => Promise<BatchRenameStartResponse>
    stop: () => Promise<{ ok: boolean }>
    getProgress: () => Promise<BatchRenameProgress | null>
    getResult: () => Promise<BatchRenameResult | null>
    selectFolder: () => Promise<string | null>
    onProgress: (cb: (progress: BatchRenameProgress) => void) => () => void
  }
}
