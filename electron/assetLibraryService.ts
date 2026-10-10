import type {
  AssetCategory,
  AssetClusterGroup,
  AssetClusterLineageEvent,
  AssetLibraryBackupCreateResult,
  AssetLibraryBackupRestoreResult,
  AssetLibraryBackupSummary,
  AssetLibraryBackupVerification,
  AssetLibraryCategoryInput,
  AssetLibraryCategoryClusterRequest,
  AssetLibraryCategorySampleSearchRequest,
  AssetLibraryCategorySampleSearchResponse,
  AssetLibraryClusterRequest,
  AssetLibraryClusterSummary,
  AssetLibraryListRequest,
  AssetLibraryListResponse,
  AssetLibraryMutationResult,
  AssetLibraryPurgeMetadataDeletionsRequest,
  AssetLibraryPurgeMetadataDeletionsResult,
  AssetMetadataDeletionListRequest,
  AssetMetadataDeletionListResponse,
  AssetLibraryReferenceImportResult,
  AssetLibraryReferenceItem,
  AssetLibraryReferenceSuggestionRequest,
  AssetLibrarySimilarSearchRequest,
  AssetLibrarySimilarSearchResponse,
  AssetLibrarySearchResultQuery,
  AssetLibraryStats,
  AssetLibrarySuggestionListRequest,
  AssetLibrarySuggestionListResponse,
  AssetLibraryTagInput,
  AssetLibraryTagSuggestionRequest,
  AssetLibraryTaskProgress,
  AssetLibraryTaskResult,
  AssetLibraryTaskType,
  AssetSmartAlbum,
  AssetSmartAlbumInput,
  AssetCollection,
  AssetCollectionItem,
  AssetCollectionItemInput,
  AssetTag,
} from '../shared/ipc/asset-library'
import type { AssetFeedbackModelStatus } from '../shared/ipc/asset-feedback'
import { prepareClipEmbeddingCache } from './semanticSearchService'
import { isSourceFileSyncRunning } from './sourceFileSyncService'
import { cancelActiveAssetTaskWorker } from './assetTaskWorkerHost'
import { normalizeAssetLibraryListRequest } from './assetLibraryListRequest'
import {
  listAssetLibraryAssetsFromJsonl,
  listAssetLibraryAssetsFromSql,
} from './assetLibraryReadQueries'
import {
  activeAssetById,
  readAssetLibraryStats,
  type AssetLibrarySqlStats,
} from './assetLibraryStatsQuery'
import {
  getAssetFeedbackModelStatus,
  initAssetFeedbackModelService,
  markAssetFeedbackDirty as persistAssetFeedbackDirty,
  rebuildAssetFeedbackModel,
  setAssetFeedbackClipCacheProvider,
  setAssetFeedbackEnabled,
  setAssetFeedbackSourceProvider,
} from './assetFeedbackModelService'
import { buildAssetFeedbackSourceSnapshot as buildFeedbackSnapshot } from './assetFeedbackSnapshot'
import {
  AssetLibraryTaskController,
  type AssetLibraryProgressListener,
  type AssetLibraryRunningTask,
} from './assetLibraryTaskController'
import {
  getAssetLibraryBaseDir,
  initializeAssetLibraryStorage,
  markAssetLibraryStorageUnavailable,
  requireAssetLibraryStores as requireStores,
  withShadowRead,
  withShadowReadAsync,
  type AssetLibraryServiceInitOptions,
} from './assetLibraryStorageContext'
import {
  createAssetTaxonomyCategory,
  createAssetTaxonomyTag,
  listAssetTaxonomyCategories,
  listAssetTaxonomyTags,
  updateAssetTaxonomyCategory,
  updateAssetTaxonomyTag,
} from './assetLibraryTaxonomyCatalog'
import {
  deleteAssetTaxonomyCategory,
  deleteAssetTaxonomyTag,
  listAssetMetadataDeletionHistory,
  purgeAssetMetadataDeletionHistory,
  restoreAssetMetadataDeletionRecord,
  undoLatestAssetMetadataDeletion,
} from './assetMetadataDeletionService'
import {
  assignCategoryToAssets,
  assignTagToAssets,
  removeCategoryFromAssets,
  removeTagFromAssets,
  resolveActiveAssetPath,
  setAssetsArchived,
  setAssetsUserMetadata,
  setCategoryAssetsFeedback,
} from './assetLibraryAssignmentService'
import {
  addAssetCategoryReferences,
  importAssetCategoryReferenceImages,
  listAssetCategoryReferences,
  removeAssetCategoryReference,
} from './assetLibraryReferenceService'
import {
  clearCategorySampleSearchResults,
  getCategorySampleSearchResult,
  startCategorySampleSearchTask,
} from './assetCategorySampleSearchService'
import {
  clearAssetSimilarSearchResults,
  getAssetSimilarSearchResult,
  startAssetSimilarSearchTask,
} from './assetSimilarSearchService'
import { tryAcquireVectorSearchReservation } from './vectorMaintenanceService'
import {
  buildReferenceSuggestionTask,
  buildTagSuggestionTask,
} from './assetSuggestionGenerationService'
import {
  listAssetSuggestionItems,
  reviewAssetSuggestionItems,
  undoAssetSuggestionReviews,
} from './assetSuggestionReviewService'
import { buildAssetClustersTask, buildCategoryAssetClusterTask } from './assetClusterBuildService'
import {
  buildLibraryDuplicateGroupsTask,
  buildLibraryNearDuplicateGroupsTask,
  buildSemanticPeopleClustersTask,
  refreshAssetClusterLabelsTask,
} from './assetDerivedClusterService'
import {
  applyDuplicateClusterGroup,
  listAssetClusterLineage,
  listAssetClusterSummaries,
  mergeAssetClusterGroups,
  moveAssetClusterGroupMembers,
  promoteAssetClusterGroup,
  splitAssetClusterGroup,
  updateAssetClusterGroup,
} from './assetClusterManagementService'
import { startAssetLibrarySyncTask } from './assetLibrarySyncService'
import {
  createAssetSmartAlbum,
  deleteAssetSmartAlbum,
  listAssetSmartAlbums,
  updateAssetSmartAlbum,
} from './assetSmartAlbumService'
import {
  addAssetCollectionItem,
  addAssetCollectionItems,
  createAssetCollection,
  deleteAssetCollection,
  listAssetCollectionItems,
  listAssetCollections,
  reorderAssetCollections,
  removeAssetCollectionItem,
  updateAssetCollection,
} from './assetCollectionService'
import {
  createAssetLibraryMetadataBackup as createMetadataBackup,
  getAssetLibraryMetadataBackupRoot as getMetadataBackupRoot,
  initAssetLibraryBackupCoordinator,
  listAssetLibraryMetadataBackups as listMetadataBackups,
  resetAssetLibraryBackupCoordinator,
  restoreAssetLibraryMetadataBackup as restoreMetadataBackup,
  verifyAssetLibraryMetadataBackup as verifyMetadataBackup,
} from './assetLibraryBackupCoordinator'

export { computeClusterInheritance, type ClusterInheritance } from './assetClusterInheritance'
export { resolveAssetReferenceEmbeddingBackend } from './assetLibraryStorageConfig'
export {
  getAssetLibraryShadowDatabase,
  getAssetLibraryStorageMode,
  type AssetLibraryServiceInitOptions,
} from './assetLibraryStorageContext'

let baseDir = ''
let feedbackRebuildTimer: NodeJS.Timeout | null = null
const taskController = new AssetLibraryTaskController()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function initAssetLibraryService(
  userDataPath: string,
  options?: AssetLibraryServiceInitOptions,
): void {
  if (feedbackRebuildTimer) clearTimeout(feedbackRebuildTimer)
  feedbackRebuildTimer = null
  resetAssetLibraryBackupCoordinator()
  clearCategorySampleSearchResults()
  clearAssetSimilarSearchResults()
  const initialized = initializeAssetLibraryStorage(userDataPath, options)
  baseDir = getAssetLibraryBaseDir()
  if (!initialized) return
  initAssetFeedbackModelService(baseDir)
  setAssetFeedbackSourceProvider(buildAssetFeedbackSourceSnapshot)
  setAssetFeedbackClipCacheProvider(prepareClipEmbeddingCache)
  scheduleAssetFeedbackRebuild()
  initAssetLibraryBackupCoordinator(baseDir, {
    hasActiveWork: () => taskController.hasActiveTask() || taskController.hasPendingMutations(),
    runMutation: (runner) => runAssetLibraryMutation(runner),
    reinitialize: (nextUserDataPath) => initAssetLibraryService(nextUserDataPath),
    validateRestoredLibrary: () => getAssetLibraryStats(),
    failRestore: (error) => {
      if (feedbackRebuildTimer) clearTimeout(feedbackRebuildTimer)
      feedbackRebuildTimer = null
      markAssetLibraryStorageUnavailable(error)
      throw error
    },
  })
}

export function setAssetLibraryProgressListener(
  listener: AssetLibraryProgressListener | null,
): void {
  taskController.setProgressListener(listener)
}

function publishProgress(patch: Partial<AssetLibraryTaskProgress>): void {
  taskController.publishProgress(patch)
}

function startTask(
  type: AssetLibraryTaskType,
  runner: (task: AssetLibraryRunningTask) => Promise<string>,
  options: { allowSourceFileSync?: boolean } = {},
): AssetLibraryTaskResult {
  if (!options.allowSourceFileSync && isSourceFileSyncRunning()) {
    return { ok: false, error: 'Source file synchronization is running' }
  }
  return taskController.startTask(type, runner)
}

export function runAssetLibraryMutation<T>(runner: () => Promise<T> | T): Promise<T> {
  if (isSourceFileSyncRunning()) {
    return Promise.reject(new Error('Source file synchronization is running'))
  }
  return taskController.runMutation(runner)
}

export function isAssetLibraryWorkRunning(): boolean {
  return taskController.hasActiveTask() || taskController.hasPendingMutations()
}

export function stopAssetLibraryTask(taskId?: string): AssetLibraryMutationResult {
  return taskController.stopTask(taskId, cancelActiveAssetTaskWorker)
}

export function getAssetLibraryTaskProgress(taskId?: string): AssetLibraryTaskProgress | null {
  return taskController.getProgress(taskId)
}

function scheduleAssetFeedbackRebuild(): void {
  if (feedbackRebuildTimer) clearTimeout(feedbackRebuildTimer)
  feedbackRebuildTimer = setTimeout(() => {
    feedbackRebuildTimer = null
    void getAssetFeedbackModelStatus()
      .then((status) => {
        if (!status.enabled) return
        if (status.state === 'ready' && status.builtRevision === status.revision) return
        if (taskController.hasActiveTask() || taskController.hasPendingMutations()) {
          scheduleAssetFeedbackRebuild()
          return
        }
        buildAssetFeedbackSearchModel()
      })
      .catch((error: unknown) => {
        console.warn(`[AssetFeedback] Could not schedule rebuild: ${errorMessage(error)}`)
      })
  }, 15_000)
  feedbackRebuildTimer.unref?.()
}

export function listAssetLibraryMetadataBackups(): Promise<AssetLibraryBackupSummary[]> {
  return listMetadataBackups()
}

export function createAssetLibraryMetadataBackup(): Promise<AssetLibraryBackupCreateResult> {
  return createMetadataBackup()
}

export function verifyAssetLibraryMetadataBackup(
  backupId: string,
): Promise<AssetLibraryBackupVerification> {
  return verifyMetadataBackup(backupId)
}

export function getAssetLibraryMetadataBackupRoot(): string {
  return getMetadataBackupRoot()
}

export function restoreAssetLibraryMetadataBackup(
  backupId: string,
): Promise<AssetLibraryBackupRestoreResult> {
  return restoreMetadataBackup(backupId)
}

async function markAssetFeedbackDirty(reason: string): Promise<void> {
  try {
    await persistAssetFeedbackDirty(reason)
  } catch (error: unknown) {
    console.warn(`[AssetFeedback] Could not persist dirty state: ${errorMessage(error)}`)
  }
  scheduleAssetFeedbackRebuild()
}

async function buildAssetFeedbackSourceSnapshot() {
  const stores = requireStores()
  await stores.assets.ensureLoaded()
  const feedbackRelations = withShadowRead(
    (db) => ({
      categoryAssignments: db.listCategoryAssignments({ formalOnly: true }),
      tagAssignments: db.listTagAssignments({ formalOnly: true }),
      references: db.referenceWeightRows(),
      rejectedSuggestions: db.listSuggestions({ status: 'rejected' }).sort((a, b) => a.id - b.id),
    }),
    () => ({
      categoryAssignments: stores.categoryAssignments.getAll(),
      tagAssignments: stores.tagAssignments.getAll(),
      references: stores.references.getAll(),
      rejectedSuggestions: stores.suggestions.getAll(),
    }),
  )
  return buildFeedbackSnapshot({
    categories: stores.categories.getAll(),
    tags: stores.tags.getAll(),
    ...feedbackRelations,
    getAssetById: (assetId) => stores.assets.getById(assetId),
  })
}

export function buildAssetFeedbackSearchModel(): AssetLibraryTaskResult {
  if (feedbackRebuildTimer) {
    clearTimeout(feedbackRebuildTimer)
    feedbackRebuildTimer = null
  }
  return startTask('feedback_model', async (task) => {
    const status = await rebuildAssetFeedbackModel({
      isCancelled: () => task.cancelled,
      onProgress: ({ current, total, percent, message }) => {
        publishProgress({ current, total, percent, message })
      },
    })
    return `Search learning ready: ${status.targetCount} targets, ${status.embeddedSampleCount} embedded samples.`
  })
}

export function getAssetFeedbackSearchStatus(): Promise<AssetFeedbackModelStatus> {
  return getAssetFeedbackModelStatus()
}

export async function setAssetFeedbackSearchEnabled(
  enabled: boolean,
): Promise<AssetFeedbackModelStatus> {
  const status = await setAssetFeedbackEnabled(enabled)
  if (!enabled && feedbackRebuildTimer) {
    clearTimeout(feedbackRebuildTimer)
    feedbackRebuildTimer = null
  } else if (enabled && status.state !== 'ready') {
    scheduleAssetFeedbackRebuild()
  }
  return status
}

export function startCategorySampleSearch(
  request: AssetLibraryCategorySampleSearchRequest,
): AssetLibraryTaskResult {
  const releaseSearch = tryAcquireVectorSearchReservation()
  if (!releaseSearch) return { ok: false, error: 'Vector maintenance is running' }
  let scheduled = false
  let result: AssetLibraryTaskResult
  try {
    result = startCategorySampleSearchTask(request, {
      startTask: (type, runner) => {
        const started = startTask(type, async (task) => {
          try {
            return await runner(task)
          } finally {
            releaseSearch()
          }
        })
        scheduled = started.ok
        return started
      },
      publishProgress,
    })
  } catch (error) {
    releaseSearch()
    throw error
  }
  if (!scheduled) releaseSearch()
  return result
}

export function getCategorySampleSearchResults(
  query: AssetLibrarySearchResultQuery = {},
): AssetLibraryCategorySampleSearchResponse | null {
  return getCategorySampleSearchResult(query)
}

export function startAssetSimilarSearch(
  request: AssetLibrarySimilarSearchRequest,
): AssetLibraryTaskResult {
  const releaseSearch = tryAcquireVectorSearchReservation()
  if (!releaseSearch) return { ok: false, error: 'Vector maintenance is running' }
  let scheduled = false
  let result: AssetLibraryTaskResult
  try {
    result = startAssetSimilarSearchTask(request, {
      startTask: (type, runner) => {
        const started = startTask(type, async (task) => {
          try {
            return await runner(task)
          } finally {
            releaseSearch()
          }
        })
        scheduled = started.ok
        return started
      },
      publishProgress,
    })
  } catch (error) {
    releaseSearch()
    throw error
  }
  if (!scheduled) releaseSearch()
  return result
}

export function getAssetSimilarSearchResults(
  query: AssetLibrarySearchResultQuery = {},
): AssetLibrarySimilarSearchResponse | null {
  return getAssetSimilarSearchResult(query)
}

export async function getAssetLibraryStats(): Promise<AssetLibraryStats> {
  const stores = requireStores()
  const isActiveAssetId = activeAssetById((assetId) => stores.assets.getById(assetId))
  return readAssetLibraryStats({
    assets: stores.assets,
    categoryAssignments: stores.categoryAssignments.getAll(),
    suggestions: stores.suggestions.getAll(),
    clusterMembers: stores.clusterMembers.getAll(),
    clusters: stores.clusters.getAll(),
    referenceAssetIds: stores.references.getAll().map((reference) => reference.assetId),
    categoryCount: stores.categories.count(),
    tagCount: stores.tags.count(),
    referenceCount: stores.references.count(),
    isActiveAssetId,
    readSqlStats: (inactiveAssetIds): AssetLibrarySqlStats | null =>
      withShadowRead(
        (db) => {
          // Aggregate-first stats: SQLite returns scalar counts instead of
          // materializing tens of thousands of relation ids in the main process.
          const activeClusterIds = new Set(
            db.clusterMemberAggregates(inactiveAssetIds).map((item) => item.clusterGroupId),
          )
          const counts = db.categoryAndTagCounts()
          return {
            classifiedAssets: db.formalAssignedAssetCount(inactiveAssetIds),
            suggestedCount: db.suggestionStatusCount('suggested', inactiveAssetIds),
            lowConfidenceCount: db.suggestionStatusCount('low_confidence', inactiveAssetIds),
            categoryCount: counts.categories,
            tagCount: counts.tags,
            clusterCount: db
              .listClusterGroups()
              .filter((cluster) => cluster.status !== 'ignored' && activeClusterIds.has(cluster.id))
              .length,
            referenceCount: db.activeReferenceCount(inactiveAssetIds),
          }
        },
        () => null,
      ),
  })
}

export async function listAssetLibraryAssets(
  request: AssetLibraryListRequest = {},
): Promise<AssetLibraryListResponse> {
  const stores = requireStores()
  await stores.assets.ensureLoaded()
  const normalized = normalizeAssetLibraryListRequest(request)
  return withShadowReadAsync(
    (db) => listAssetLibraryAssetsFromSql(stores.assets, normalized, db),
    () =>
      listAssetLibraryAssetsFromJsonl(
        stores.assets,
        stores.categoryAssignments.getAll(),
        stores.tagAssignments.getAll(),
        normalized,
      ),
  )
}

export function listSmartAlbums(): AssetSmartAlbum[] {
  return listAssetSmartAlbums()
}

export function createSmartAlbum(input: AssetSmartAlbumInput): Promise<AssetSmartAlbum> {
  return createAssetSmartAlbum(input)
}

export function updateSmartAlbum(
  id: number,
  input: Partial<AssetSmartAlbumInput>,
): Promise<AssetSmartAlbum> {
  return updateAssetSmartAlbum(id, input)
}

export function deleteSmartAlbum(id: number): Promise<AssetLibraryMutationResult> {
  return deleteAssetSmartAlbum(id)
}

export function listCollections(): AssetCollection[] {
  return listAssetCollections()
}

export function createCollection(name: string): Promise<AssetCollection> {
  return createAssetCollection(name)
}

export function updateCollection(id: number, name: string): Promise<AssetCollection> {
  return updateAssetCollection(id, name)
}

export function reorderCollections(ids: number[]): Promise<AssetLibraryMutationResult> {
  return reorderAssetCollections(ids)
}

export function deleteCollection(id: number): Promise<AssetLibraryMutationResult> {
  return deleteAssetCollection(id)
}

export function listCollectionItems(id: number): AssetCollectionItem[] {
  return listAssetCollectionItems(id)
}

export function addCollectionItem(
  id: number,
  input: AssetCollectionItemInput,
): Promise<AssetCollectionItem> {
  return addAssetCollectionItem(id, input)
}

export function addCollectionItems(
  id: number,
  inputs: AssetCollectionItemInput[],
): Promise<AssetCollectionItem[]> {
  return addAssetCollectionItems(id, inputs)
}

export function removeCollectionItem(id: number): Promise<AssetLibraryMutationResult> {
  return removeAssetCollectionItem(id)
}

export function listAssetCategories(): AssetCategory[] {
  return listAssetTaxonomyCategories()
}

export async function createAssetCategory(
  input: AssetLibraryCategoryInput,
): Promise<AssetCategory> {
  return createAssetTaxonomyCategory(input, markAssetFeedbackDirty)
}

export async function updateAssetCategory(
  id: number,
  input: Partial<AssetLibraryCategoryInput>,
): Promise<AssetCategory> {
  return updateAssetTaxonomyCategory(id, input, markAssetFeedbackDirty)
}

export async function deleteAssetCategory(id: number): Promise<AssetLibraryMutationResult> {
  return deleteAssetTaxonomyCategory(id, markAssetFeedbackDirty)
}

export function listAssetTags(): AssetTag[] {
  return listAssetTaxonomyTags()
}

export async function createAssetTag(input: AssetLibraryTagInput): Promise<AssetTag> {
  return createAssetTaxonomyTag(input, markAssetFeedbackDirty)
}

export async function updateAssetTag(
  id: number,
  input: Partial<AssetLibraryTagInput>,
): Promise<AssetTag> {
  return updateAssetTaxonomyTag(id, input, markAssetFeedbackDirty)
}

export async function deleteAssetTag(id: number): Promise<AssetLibraryMutationResult> {
  return deleteAssetTaxonomyTag(id, markAssetFeedbackDirty)
}

export function listAssetMetadataDeletions(
  request: AssetMetadataDeletionListRequest = {},
): AssetMetadataDeletionListResponse {
  return listAssetMetadataDeletionHistory(request)
}

export async function restoreAssetMetadataDeletion(
  id: number,
): Promise<AssetLibraryMutationResult> {
  return restoreAssetMetadataDeletionRecord(id, markAssetFeedbackDirty)
}

export async function undoLastAssetMetadataDeletion(): Promise<AssetLibraryMutationResult> {
  return undoLatestAssetMetadataDeletion(markAssetFeedbackDirty)
}

/**
 * Permanently deletes trash records (no restore possible afterwards).
 * `restoredOnly: true` removes only already-restored records; purging
 * everything requires `confirm: true` as a second-factor guard.
 */
export async function purgeAssetMetadataDeletions(
  request: AssetLibraryPurgeMetadataDeletionsRequest = {},
): Promise<AssetLibraryPurgeMetadataDeletionsResult> {
  return purgeAssetMetadataDeletionHistory(request)
}

export async function assignAssetsToCategory(
  assetIds: number[],
  categoryId: number,
): Promise<AssetLibraryMutationResult> {
  return assignCategoryToAssets(assetIds, categoryId, markAssetFeedbackDirty)
}

export async function setCategorySampleFeedback(
  assetIds: number[],
  categoryId: number,
  relevant: boolean,
): Promise<AssetLibraryMutationResult> {
  return setCategoryAssetsFeedback(assetIds, categoryId, relevant, markAssetFeedbackDirty)
}

export async function removeAssetCategoryAssignment(
  assetIds: number[],
  categoryId: number,
): Promise<AssetLibraryMutationResult> {
  return removeCategoryFromAssets(assetIds, categoryId, markAssetFeedbackDirty)
}

export async function assignAssetsToTag(
  assetIds: number[],
  tagId: number,
): Promise<AssetLibraryMutationResult> {
  return assignTagToAssets(assetIds, tagId, markAssetFeedbackDirty)
}

export async function removeAssetTagAssignment(
  assetIds: number[],
  tagId: number,
): Promise<AssetLibraryMutationResult> {
  return removeTagFromAssets(assetIds, tagId, markAssetFeedbackDirty)
}

export async function archiveAssetLibraryAssets(
  assetIds: number[],
): Promise<AssetLibraryMutationResult> {
  return setAssetsArchived(assetIds, true, markAssetFeedbackDirty)
}

export async function restoreAssetLibraryAssets(
  assetIds: number[],
): Promise<AssetLibraryMutationResult> {
  return setAssetsArchived(assetIds, false, markAssetFeedbackDirty)
}

export function setAssetLibraryUserMetadata(
  assetIds: number[],
  patch: { rating?: number; favorite?: boolean },
): Promise<AssetLibraryMutationResult> {
  return setAssetsUserMetadata(assetIds, patch)
}

export async function resolveAssetLibraryAssetPath(assetId: number): Promise<string> {
  return resolveActiveAssetPath(assetId)
}

export async function listCategoryReferences(
  categoryId?: number,
): Promise<AssetLibraryReferenceItem[]> {
  return listAssetCategoryReferences(categoryId)
}

export async function addCategoryReferences(
  categoryId: number,
  assetIds: number[],
  weight = 1,
): Promise<AssetLibraryMutationResult> {
  return addAssetCategoryReferences(categoryId, assetIds, weight, markAssetFeedbackDirty)
}

export async function importCategoryReferenceImages(
  categoryId: number,
  filePaths: string[],
): Promise<AssetLibraryReferenceImportResult> {
  return importAssetCategoryReferenceImages(categoryId, filePaths, markAssetFeedbackDirty)
}

export async function removeCategoryReference(id: number): Promise<AssetLibraryMutationResult> {
  return removeAssetCategoryReference(id, markAssetFeedbackDirty)
}

export function syncAssetLibraryFromImageIndex(
  manifestPath?: string,
  options: { allowSourceFileSync?: boolean } = {},
): AssetLibraryTaskResult {
  return startAssetLibrarySyncTask(manifestPath, {
    startTask: (type, runner) => startTask(type, runner, options),
    publishProgress,
    markFeedbackDirty: markAssetFeedbackDirty,
    invalidateSearchResults: () => {
      clearCategorySampleSearchResults()
      clearAssetSimilarSearchResults()
    },
  })
}

export function buildReferenceSuggestions(
  request: AssetLibraryReferenceSuggestionRequest = {},
): AssetLibraryTaskResult {
  return buildReferenceSuggestionTask(request, {
    startTask,
    publishProgress,
    markFeedbackDirty: markAssetFeedbackDirty,
  })
}

export function buildTagSuggestions(
  request: AssetLibraryTagSuggestionRequest = {},
): AssetLibraryTaskResult {
  return buildTagSuggestionTask(request, {
    startTask,
    publishProgress,
    markFeedbackDirty: markAssetFeedbackDirty,
  })
}

export function listAssetSuggestions(
  request: AssetLibrarySuggestionListRequest = {},
): Promise<AssetLibrarySuggestionListResponse> {
  return listAssetSuggestionItems(request)
}

export function reviewAssetSuggestions(
  ids: number[],
  status: 'confirmed' | 'rejected' | 'ignored',
): Promise<AssetLibraryMutationResult> {
  return reviewAssetSuggestionItems(ids, status, {
    markFeedbackDirty: markAssetFeedbackDirty,
  })
}

export function undoAssetSuggestions(ids: number[]): Promise<AssetLibraryMutationResult> {
  return undoAssetSuggestionReviews(ids, {
    markFeedbackDirty: markAssetFeedbackDirty,
  })
}

export function buildCategoryAssetCluster(
  request: AssetLibraryCategoryClusterRequest,
): AssetLibraryTaskResult {
  return buildCategoryAssetClusterTask(request, { startTask, publishProgress })
}

export function buildAssetClusters(
  request: AssetLibraryClusterRequest = {},
): AssetLibraryTaskResult {
  return buildAssetClustersTask(request, { startTask, publishProgress })
}

export function buildLibraryDuplicateGroups(): AssetLibraryTaskResult {
  return buildLibraryDuplicateGroupsTask({ startTask, publishProgress })
}

export function buildLibraryNearDuplicateGroups(request?: {
  threshold?: number
}): AssetLibraryTaskResult {
  return buildLibraryNearDuplicateGroupsTask(request, { startTask, publishProgress })
}

export function refreshAssetClusterLabels(): AssetLibraryTaskResult {
  return refreshAssetClusterLabelsTask({ startTask, publishProgress })
}

export function buildSemanticPeopleClusters(
  request: AssetLibraryClusterRequest = {},
): AssetLibraryTaskResult {
  return buildSemanticPeopleClustersTask(request, { startTask, publishProgress })
}

export function listAssetClusters(): Promise<AssetLibraryClusterSummary[]> {
  return listAssetClusterSummaries()
}

export function applyDuplicateGroup(
  clusterId: number,
): Promise<{ ok: boolean; archived?: number; error?: string }> {
  return applyDuplicateClusterGroup(clusterId, markAssetFeedbackDirty)
}

export function listClusterLineage(options?: {
  groupId?: number
  limit?: number
}): AssetClusterLineageEvent[] {
  return listAssetClusterLineage(options)
}

export function mergeAssetClusters(
  groupIds: number[],
): Promise<{ ok: boolean; group?: AssetClusterGroup; error?: string }> {
  return mergeAssetClusterGroups(groupIds)
}

export function splitAssetCluster(
  groupId: number,
  assetIds: number[],
): Promise<{ ok: boolean; group?: AssetClusterGroup; error?: string }> {
  return splitAssetClusterGroup(groupId, assetIds)
}

export function moveAssetClusterMembers(
  fromGroupId: number,
  toGroupId: number | null,
  assetIds: number[],
): Promise<{ ok: boolean; error?: string }> {
  return moveAssetClusterGroupMembers(fromGroupId, toGroupId, assetIds)
}

export function updateAssetCluster(
  id: number,
  patch: { name?: string; status?: AssetClusterGroup['status'] },
): Promise<AssetClusterGroup> {
  return updateAssetClusterGroup(id, patch)
}

export function promoteAssetCluster(
  clusterId: number,
  categoryId?: number,
): Promise<{ ok: boolean; category?: AssetCategory; error?: string }> {
  return promoteAssetClusterGroup(clusterId, categoryId, markAssetFeedbackDirty)
}
