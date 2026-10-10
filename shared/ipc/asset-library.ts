import type { SourceAvailability, SourceType } from './discovery-catalog'

export type AssetLibrarySource = 'image_search' | 'manual'
export type AssetKind = 'image' | 'video_frame'

export interface AssetRecord {
  id: number
  path: string
  kind: AssetKind
  source: AssetLibrarySource
  width: number
  height: number
  fileSize: number
  modifiedTime: number
  diffHash64?: string
  dctHash64?: string
  missing: boolean
  archived?: boolean
  archivedAt?: number
  rating?: number
  favorite?: boolean
  createdAt: number
  updatedAt: number
}

export interface AssetCategory {
  id: number
  name: string
  description: string
  parentId: number | null
  color: string
  icon: string
  sortOrder: number
  referenceThreshold?: number
  sourceClusterGroupId?: number
  createdAt: number
  updatedAt: number
}

export interface AssetTag {
  id: number
  name: string
  color: string
  createdAt: number
  updatedAt: number
}

export type AssetAssignmentSource =
  | 'manual'
  | 'reference_image'
  | 'text_label'
  | 'cluster'
  | 'duplicate'
  | 'filename'
  | 'ocr'
  | 'video_frame'
  | 'manual_review'

export type AssetAssignmentStatus =
  | 'suggested'
  | 'confirmed'
  | 'rejected'
  | 'low_confidence'
  | 'manual_override'
  | 'ignored'

export interface AssetCategoryAssignment {
  id: number
  assetId: number
  categoryId: number
  suggestionId?: number
  confidence: number
  source: AssetAssignmentSource
  status: AssetAssignmentStatus
  confirmedByUser: boolean
  createdAt: number
  updatedAt: number
}

export interface AssetTagAssignment {
  id: number
  assetId: number
  tagId: number
  suggestionId?: number
  confidence: number
  source: AssetAssignmentSource
  status: AssetAssignmentStatus
  confirmedByUser: boolean
  createdAt: number
  updatedAt: number
}

export interface AssetCategoryReference {
  id: number
  categoryId: number
  assetId: number
  weight: number
  createdAt: number
}

export interface AssetLibraryReferenceItem {
  reference: AssetCategoryReference
  asset?: AssetRecord
}

export interface AssetClassificationSuggestion {
  id: number
  assetId: number
  categoryId?: number
  tagId?: number
  confidence: number
  source: 'reference_image' | 'text_label' | 'cluster' | 'manual_review'
  status: AssetAssignmentStatus
  evidenceAssetIds: number[]
  createdAt: number
  updatedAt: number
}

export type AssetClusterStatus = 'suggested' | 'confirmed' | 'ignored'

/** 人工干预标记（路线图 23）：重算时 origin !== 'auto' 的组不被删除。 */
export type AssetClusterOrigin = 'auto' | 'manual_merge' | 'manual_split' | 'manual_edit'

export interface AssetClusterGroup {
  id: number
  name: string
  /** streaming_centroid is kept only for compatibility with pre-v2 cluster stores; new groups use the other algorithms. duplicate_exact/duplicate_near are reserved for the library duplicate scan (路线图 24). */
  algorithm:
    | 'streaming_centroid'
    | 'compressed_kmeans'
    | 'semantic_zero_shot'
    | 'category_feedback'
    | 'duplicate_exact'
    | 'duplicate_near'
  status: AssetClusterStatus
  assetCount: number
  avgSimilarity: number
  representativeAssetId: number
  sourceCategoryId?: number
  labels?: string[]
  /** 缺省视为 'auto'（旧记录无此字段）。 */
  origin?: AssetClusterOrigin
  /** 稳定身份键，重算时按成员 Jaccard ≥ 0.5 继承。 */
  lineageKey?: string
  createdAt: number
  updatedAt: number
}

export interface AssetClusterLineageEvent {
  id: number
  event: 'merge' | 'split' | 'move' | 'recalc_map'
  /** 操作后存在的组 id。 */
  groupIds: number[]
  /** 操作来源组 id（merge 的全部输入、split/move 的原组、recalc_map 的旧组）。 */
  fromGroupIds: number[]
  toGroupId?: number
  memberAssetIds?: number[]
  createdAt: number
}

export interface AssetClusterMember {
  id: number
  clusterGroupId: number
  assetId: number
  similarity: number
  createdAt: number
}

export interface AssetLibraryStats {
  totalAssets: number
  classifiedAssets: number
  unclassifiedAssets: number
  suggestedCount: number
  lowConfidenceCount: number
  categoryCount: number
  tagCount: number
  clusterCount: number
  referenceCount: number
  archivedAssets: number
  storageState: 'ready' | 'read_only' | 'unavailable'
  storageCorruptRows: number
  storageError?: string
  lastSyncAt?: number
  sourceManifest?: string
}

export interface AssetLibraryListRequest {
  offset?: number
  limit?: number
  query?: string
  categoryId?: number
  tagId?: number
  unclassified?: boolean
  archivedOnly?: boolean
  source?: AssetLibrarySource
  kind?: AssetKind
  modifiedAfter?: number
  modifiedBefore?: number
  minRating?: number
  favoriteOnly?: boolean
  sort?: 'updated_desc' | 'name_asc' | 'size_desc'
}

export interface AssetLibraryAssetItem {
  asset: AssetRecord
  categories: AssetCategoryAssignment[]
  tags: AssetTagAssignment[]
}

export interface AssetLibraryListResponse {
  items: AssetLibraryAssetItem[]
  total: number
  offset: number
  limit: number
}

export interface AssetSmartAlbumRules {
  query?: string
  categoryId?: number
  tagId?: number
  unclassified?: boolean
  archivedOnly?: boolean
  source?: AssetLibrarySource
  kind?: AssetKind
  modifiedAfter?: number
  modifiedBefore?: number
  minRating?: number
  favoriteOnly?: boolean
  sort: 'updated_desc' | 'name_asc' | 'size_desc'
}

export interface AssetSmartAlbum {
  id: number
  name: string
  rules: AssetSmartAlbumRules
  createdAt: number
  updatedAt: number
}

export interface AssetSmartAlbumInput {
  name: string
  rules: AssetSmartAlbumRules
}

export interface AssetCollection {
  id: number
  name: string
  sortOrder?: number
  createdAt: number
  updatedAt: number
}

export interface AssetCollectionItemInput {
  assetId?: string
  fileEntryId?: string
  mediaType: string
  displayName: string
  displayPath: string
  sizeBytes: number
  modifiedAt: number
  videoId?: string
  videoHitMs?: number
  source: {
    id: string
    name: string
    type: SourceType
    availability: SourceAvailability
  }
}

export interface AssetCollectionItem extends AssetCollectionItemInput {
  id: number
  collectionId: number
  referenceKey: string
  addedAt: number
}

export interface AssetCollectionApi {
  listCollections: () => Promise<AssetCollection[]>
  createCollection: (name: string) => Promise<AssetCollection>
  updateCollection: (id: number, name: string) => Promise<AssetCollection>
  reorderCollections: (ids: number[]) => Promise<AssetLibraryMutationResult>
  deleteCollection: (id: number) => Promise<AssetLibraryMutationResult>
  listCollectionItems: (id: number) => Promise<AssetCollectionItem[]>
  addCollectionItem: (id: number, input: AssetCollectionItemInput) => Promise<AssetCollectionItem>
  addCollectionItems: (
    id: number,
    inputs: AssetCollectionItemInput[],
  ) => Promise<AssetCollectionItem[]>
  removeCollectionItem: (id: number) => Promise<AssetLibraryMutationResult>
}

export interface AssetLibrarySuggestionItem {
  suggestion: AssetClassificationSuggestion
  asset: AssetRecord
  category?: AssetCategory
  tag?: AssetTag
}

export interface AssetLibrarySuggestionListRequest {
  status?: AssetAssignmentStatus | 'all'
  source?: AssetClassificationSuggestion['source'] | 'all'
  offset?: number
  limit?: number
}

export interface AssetLibrarySuggestionListResponse {
  items: AssetLibrarySuggestionItem[]
  total: number
  offset: number
  limit: number
}

export interface AssetLibraryClusterSummary {
  group: AssetClusterGroup
  representativeAsset?: AssetRecord
  previewAssets: Array<{ asset: AssetRecord; similarity: number }>
}

export interface AssetLibraryCategoryInput {
  name: string
  description?: string
  parentId?: number | null
  color?: string
  icon?: string
  sortOrder?: number
  referenceThreshold?: number
}

export interface AssetLibraryTagInput {
  name: string
  color?: string
}

export interface AssetLibraryReferenceSuggestionRequest {
  categoryId?: number
  threshold?: number
  lowConfidenceThreshold?: number
  maxPerCategory?: number
}

export interface AssetLibraryTagSuggestionRequest {
  tagIds?: number[]
  threshold?: number
  lowConfidenceThreshold?: number
  maxPerTag?: number
}

export interface AssetLibraryClusterRequest {
  maxClusters?: number
  autoClusters?: boolean
  minSimilarity?: number
  maxAssets?: number
  minClusterSize?: number
  scopePaths?: string[]
  semanticRefine?: boolean
  semanticSimilarity?: number
  semanticMaxSplits?: number
}

export interface AssetLibraryCategoryClusterRequest {
  categoryId: number
  topK?: number
  minScore?: number
  includeReviewed?: boolean
  scopePaths?: string[]
}

export interface AssetLibraryClusterPathSelectionResult {
  canceled: boolean
  paths: string[]
}

export interface AssetLibraryCategorySampleSearchRequest {
  categoryId: number
  topK?: number
  includeReviewed?: boolean
}

export type AssetLibrarySampleReviewState = 'positive' | 'negative' | 'unreviewed'

export interface AssetLibraryCategorySampleSearchHit {
  item: AssetLibraryAssetItem
  score: number
  positiveScore: number
  negativeScore: number
  clipScore?: number
  dinoScore?: number
  reviewState: AssetLibrarySampleReviewState
}

export interface AssetLibraryCategorySampleSearchResponse {
  taskId: string
  resultId: string
  categoryId: number
  categoryName: string
  topK: number
  includeReviewed: boolean
  scanned: number
  returned: number
  positiveSampleCount: number
  negativeSampleCount: number
  feedbackRevision: number
  feedbackStale: boolean
  searchMode?: 'clip' | 'clip_dino'
  clipScanMode?: 'ann' | 'exact'
  clipAnnCandidateCount?: number
  clipCandidateCount?: number
  clipIndexedCount?: number
  dinoCandidateCount?: number
  dinoPositiveSampleCount?: number
  dinoNegativeSampleCount?: number
  dinoCacheVectorCount?: number
  searchWarning?: string
  searchMs: number
  generatedAt: number
  hits: AssetLibraryCategorySampleSearchHit[]
}

export interface AssetLibrarySimilarSearchRequest {
  assetId: number
  topK?: number
  categoryId?: number
  includeReviewed?: boolean
}

export interface AssetLibrarySimilarSearchResponse {
  taskId: string
  resultId: string
  queryAssetId: number
  queryPath: string
  categoryId?: number
  categoryName?: string
  topK: number
  includeReviewed: boolean
  scanned: number
  returned: number
  searchMs: number
  generatedAt: number
  hits: AssetLibraryCategorySampleSearchHit[]
}

export interface AssetLibrarySearchResultQuery {
  taskId?: string
  resultId?: string
  categoryId?: number
}

export type AssetLibraryTaskType =
  | 'sync'
  | 'reference_suggestions'
  | 'tag_suggestions'
  | 'clustering'
  | 'feedback_model'
  | 'category_sample_search'
  | 'asset_similar_search'
  | 'duplicate_scan'

export type AssetLibraryTaskState = 'idle' | 'running' | 'done' | 'stopped' | 'error'

export interface AssetLibraryTaskProgress {
  taskId: string
  type: AssetLibraryTaskType
  state: AssetLibraryTaskState
  current: number
  total: number
  percent: number
  message: string
  startedAt: number
  updatedAt: number
  etaMs?: number
  error?: string
}

export interface AssetLibraryMutationResult {
  ok: boolean
  error?: string
  affected?: number
}

export interface AssetUserMetadataPatch {
  rating?: number
  favorite?: boolean
}

export type AssetUserMetadataSetter = (
  assetIds: number[],
  patch: AssetUserMetadataPatch,
) => Promise<AssetLibraryMutationResult>

export interface AssetLibraryReferenceImportResult extends AssetLibraryMutationResult {
  imported?: number
  referencesAdded?: number
  assetIds?: number[]
}

export interface AssetLibraryTaskResult extends AssetLibraryMutationResult {
  taskId?: string
}

export interface AssetMetadataDeletionSummary {
  id: number
  kind: 'category' | 'tag'
  name: string
  deletedAt: number
  restoredAt?: number
  relationCount: number
  estimatedBytes: number
}

export interface AssetMetadataDeletionListRequest {
  offset?: number
  limit?: number
  status?: 'all' | 'pending' | 'restored'
}

export interface AssetMetadataDeletionListResponse {
  items: AssetMetadataDeletionSummary[]
  total: number
  offset: number
  limit: number
  totalBytes: number
  maxRecords: number
  maxBytes: number
}

export type AssetLibraryBackupReason = 'automatic' | 'manual' | 'pre_restore'

export interface AssetLibraryBackupSummary {
  id: string
  createdAt: number
  fileCount: number
  totalBytes: number
  reason: AssetLibraryBackupReason
  manifestValid: boolean
  error?: string
}

export interface AssetLibraryBackupVerification {
  ok: boolean
  fileCount: number
  totalBytes: number
  error?: string
}

export interface AssetLibraryBackupCreateResult extends AssetLibraryMutationResult {
  backup?: AssetLibraryBackupSummary
}

export interface AssetLibraryBackupRestoreResult extends AssetLibraryMutationResult {
  restoredFiles?: number
  deletedFiles?: number
  protectiveBackupId?: string
}

export interface AssetLibraryBackupExportResult extends AssetLibraryMutationResult {
  path?: string
  canceled?: boolean
}

export interface AssetLibraryExportDeletionsResult extends AssetLibraryMutationResult {
  path?: string
  recordCount?: number
  canceled?: boolean
}

export interface AssetLibraryPurgeMetadataDeletionsRequest {
  restoredOnly?: boolean
  confirm?: boolean
}

export interface AssetLibraryPurgeMetadataDeletionsResult extends AssetLibraryMutationResult {
  purgedCount?: number
}

export interface AssetLibraryExportReportResult extends AssetLibraryMutationResult {
  path?: string
  canceled?: boolean
}

export interface AssetLibraryBackupImportResult extends AssetLibraryMutationResult {
  backupId?: string
  path?: string
  canceled?: boolean
}

export const ASSET_LIBRARY_IPC = {
  GET_STATS: 'assetLibrary:getStats',
  LIST_ASSETS: 'assetLibrary:listAssets',
  LIST_SMART_ALBUMS: 'assetLibrary:listSmartAlbums',
  CREATE_SMART_ALBUM: 'assetLibrary:createSmartAlbum',
  UPDATE_SMART_ALBUM: 'assetLibrary:updateSmartAlbum',
  DELETE_SMART_ALBUM: 'assetLibrary:deleteSmartAlbum',
  LIST_COLLECTIONS: 'assetLibrary:listCollections',
  CREATE_COLLECTION: 'assetLibrary:createCollection',
  UPDATE_COLLECTION: 'assetLibrary:updateCollection',
  REORDER_COLLECTIONS: 'assetLibrary:reorderCollections',
  DELETE_COLLECTION: 'assetLibrary:deleteCollection',
  LIST_COLLECTION_ITEMS: 'assetLibrary:listCollectionItems',
  ADD_COLLECTION_ITEM: 'assetLibrary:addCollectionItem',
  ADD_COLLECTION_ITEMS: 'assetLibrary:addCollectionItems',
  REMOVE_COLLECTION_ITEM: 'assetLibrary:removeCollectionItem',
  SYNC_FROM_IMAGE_INDEX: 'assetLibrary:syncFromImageIndex',
  LIST_CATEGORIES: 'assetLibrary:listCategories',
  CREATE_CATEGORY: 'assetLibrary:createCategory',
  UPDATE_CATEGORY: 'assetLibrary:updateCategory',
  DELETE_CATEGORY: 'assetLibrary:deleteCategory',
  LIST_TAGS: 'assetLibrary:listTags',
  CREATE_TAG: 'assetLibrary:createTag',
  UPDATE_TAG: 'assetLibrary:updateTag',
  DELETE_TAG: 'assetLibrary:deleteTag',
  LIST_METADATA_DELETIONS: 'assetLibrary:listMetadataDeletions',
  RESTORE_METADATA_DELETION: 'assetLibrary:restoreMetadataDeletion',
  UNDO_LAST_METADATA_DELETION: 'assetLibrary:undoLastMetadataDeletion',
  EXPORT_METADATA_DELETIONS: 'assetLibrary:exportMetadataDeletions',
  PURGE_METADATA_DELETIONS: 'assetLibrary:purgeMetadataDeletions',
  EXPORT_LIBRARY_REPORT: 'assetLibrary:exportLibraryReport',
  ASSIGN_CATEGORY: 'assetLibrary:assignCategory',
  ASSIGN_TAG: 'assetLibrary:assignTag',
  SET_CATEGORY_SAMPLE_FEEDBACK: 'assetLibrary:setCategorySampleFeedback',
  REMOVE_CATEGORY_ASSIGNMENT: 'assetLibrary:removeCategoryAssignment',
  REMOVE_TAG_ASSIGNMENT: 'assetLibrary:removeTagAssignment',
  ARCHIVE_ASSETS: 'assetLibrary:archiveAssets',
  RESTORE_ASSETS: 'assetLibrary:restoreAssets',
  SET_USER_METADATA: 'assetLibrary:setUserMetadata',
  LIST_REFERENCES: 'assetLibrary:listReferences',
  ADD_REFERENCES: 'assetLibrary:addReferences',
  SELECT_REFERENCE_IMAGES: 'assetLibrary:selectReferenceImages',
  PASTE_REFERENCE_IMAGE: 'assetLibrary:pasteReferenceImage',
  REMOVE_REFERENCE: 'assetLibrary:removeReference',
  BUILD_REFERENCE_SUGGESTIONS: 'assetLibrary:buildReferenceSuggestions',
  BUILD_TAG_SUGGESTIONS: 'assetLibrary:buildTagSuggestions',
  LIST_SUGGESTIONS: 'assetLibrary:listSuggestions',
  REVIEW_SUGGESTIONS: 'assetLibrary:reviewSuggestions',
  UNDO_SUGGESTIONS: 'assetLibrary:undoSuggestions',
  BUILD_CLUSTERS: 'assetLibrary:buildClusters',
  BUILD_DUPLICATE_GROUPS: 'assetLibrary:buildDuplicateGroups',
  BUILD_NEAR_DUPLICATE_GROUPS: 'assetLibrary:buildNearDuplicateGroups',
  BUILD_CATEGORY_CLUSTER: 'assetLibrary:buildCategoryCluster',
  BUILD_PEOPLE_CLUSTERS: 'assetLibrary:buildPeopleClusters',
  REFRESH_CLUSTER_LABELS: 'assetLibrary:refreshClusterLabels',
  SELECT_CLUSTER_PATHS: 'assetLibrary:selectClusterPaths',
  LIST_CLUSTERS: 'assetLibrary:listClusters',
  UPDATE_CLUSTER: 'assetLibrary:updateCluster',
  APPLY_DUPLICATE_GROUP: 'assetLibrary:applyDuplicateGroup',
  MERGE_CLUSTERS: 'assetLibrary:mergeClusters',
  SPLIT_CLUSTER: 'assetLibrary:splitCluster',
  MOVE_CLUSTER_MEMBERS: 'assetLibrary:moveClusterMembers',
  LIST_CLUSTER_LINEAGE: 'assetLibrary:listClusterLineage',
  PROMOTE_CLUSTER: 'assetLibrary:promoteCluster',
  START_CATEGORY_SAMPLE_SEARCH: 'assetLibrary:startCategorySampleSearch',
  GET_CATEGORY_SAMPLE_SEARCH_RESULTS: 'assetLibrary:getCategorySampleSearchResults',
  START_SIMILAR_SEARCH: 'assetLibrary:startSimilarSearch',
  GET_SIMILAR_SEARCH_RESULTS: 'assetLibrary:getSimilarSearchResults',
  STOP_TASK: 'assetLibrary:stopTask',
  GET_TASK_PROGRESS: 'assetLibrary:getTaskProgress',
  LIST_BACKUPS: 'assetLibrary:listBackups',
  CREATE_BACKUP: 'assetLibrary:createBackup',
  VERIFY_BACKUP: 'assetLibrary:verifyBackup',
  RESTORE_BACKUP: 'assetLibrary:restoreBackup',
  EXPORT_BACKUP: 'assetLibrary:exportBackup',
  IMPORT_BACKUP: 'assetLibrary:importBackup',
  DELETE_BACKUP: 'assetLibrary:deleteBackup',
  OPEN_BACKUP_FOLDER: 'assetLibrary:openBackupFolder',
  OPEN_ASSET: 'assetLibrary:openAsset',
  REVEAL_ASSET: 'assetLibrary:revealAsset',
  ON_TASK_PROGRESS: 'assetLibrary:onTaskProgress',
} as const
