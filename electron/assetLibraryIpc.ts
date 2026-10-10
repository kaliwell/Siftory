import { secureIpcMain } from './ipcAuthorization'
import { app, clipboard, dialog, shell, type BrowserWindow } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { ASSET_LIBRARY_IPC } from '../shared/ipc/asset-library'
import { ASSET_FEEDBACK_IPC } from '../shared/ipc/asset-feedback'
import {
  addCategoryReferences,
  addCollectionItem,
  addCollectionItems,
  archiveAssetLibraryAssets,
  assignAssetsToCategory,
  assignAssetsToTag,
  buildAssetClusters,
  applyDuplicateGroup,
  mergeAssetClusters,
  splitAssetCluster,
  moveAssetClusterMembers,
  listClusterLineage,
  buildLibraryDuplicateGroups,
  buildLibraryNearDuplicateGroups,
  buildCategoryAssetCluster,
  buildSemanticPeopleClusters,
  buildAssetFeedbackSearchModel,
  buildReferenceSuggestions,
  buildTagSuggestions,
  createAssetCategory,
  createCollection,
  createSmartAlbum,
  createAssetLibraryMetadataBackup,
  createAssetTag,
  deleteAssetCategory,
  deleteCollection,
  deleteAssetTag,
  deleteSmartAlbum,
  getAssetLibraryStats,
  getAssetLibraryMetadataBackupRoot,
  getAssetFeedbackSearchStatus,
  getCategorySampleSearchResults,
  getAssetSimilarSearchResults,
  getAssetLibraryTaskProgress,
  importCategoryReferenceImages,
  listAssetCategories,
  listCollectionItems,
  listCollections,
  reorderCollections,
  listAssetClusters,
  listAssetLibraryAssets,
  listAssetMetadataDeletions,
  listAssetLibraryMetadataBackups,
  listAssetSuggestions,
  listSmartAlbums,
  listAssetTags,
  listCategoryReferences,
  promoteAssetCluster,
  purgeAssetMetadataDeletions,
  refreshAssetClusterLabels,
  removeAssetCategoryAssignment,
  removeCollectionItem,
  updateCollection,
  removeAssetTagAssignment,
  removeCategoryReference,
  reviewAssetSuggestions,
  restoreAssetLibraryAssets,
  restoreAssetMetadataDeletion,
  restoreAssetLibraryMetadataBackup,
  resolveAssetLibraryAssetPath,
  runAssetLibraryMutation,
  setAssetFeedbackSearchEnabled,
  setAssetLibraryUserMetadata,
  setCategorySampleFeedback,
  setAssetLibraryProgressListener,
  stopAssetLibraryTask,
  startCategorySampleSearch,
  startAssetSimilarSearch,
  syncAssetLibraryFromImageIndex,
  undoAssetSuggestions,
  undoLastAssetMetadataDeletion,
  updateAssetCategory,
  updateAssetCluster,
  updateAssetTag,
  updateSmartAlbum,
  verifyAssetLibraryMetadataBackup,
} from './assetLibraryService'
import {
  inputRecord,
  normalizeAssetListRequest,
  normalizeCategoryInput,
  normalizeCategoryClusterRequest,
  normalizeCategorySampleSearchRequest,
  normalizeMetadataDeletionListRequest,
  normalizeSimilarSearchRequest,
  normalizeSearchResultQuery,
  normalizeClusterRequest,
  normalizeReferenceSuggestionRequest,
  normalizeSuggestionListRequest,
  normalizeSmartAlbumInput,
  normalizeSmartAlbumPatch,
  normalizeAssetUserMetadataPatch,
  normalizeCollectionItemInput,
  normalizeCollectionItemInputs,
  normalizeTagInput,
  normalizeTagSuggestionRequest,
  optionalSafeText,
  positiveId,
  positiveIds,
} from './assetLibraryGuards'
import { openSafeShellPath, revealSafeShellPath } from './pathGuards'
import {
  deleteAssetLibraryBackup,
  exportEncryptedAssetLibraryBackup,
  importEncryptedAssetLibraryBackup,
  importAssetLibraryBackup,
  normalizeAssetLibraryBackupId,
} from './assetLibraryBackup'
import { isSourceFileSyncRunning } from './sourceFileSyncService'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeBackupIdInput(rawBackupId: unknown): string {
  const backupId = optionalSafeText(rawBackupId, 180)
  if (!backupId) throw new Error('Invalid asset library backup id')
  return normalizeAssetLibraryBackupId(backupId)
}

function normalizeBackupPassphrase(rawPassphrase: unknown): string {
  if (typeof rawPassphrase !== 'string') throw new Error('Backup passphrase is required')
  const bytes = Buffer.byteLength(rawPassphrase, 'utf8')
  if (rawPassphrase.length < 12 || rawPassphrase.length > 256 || bytes > 1_024) {
    throw new Error('Backup passphrase must contain 12 to 256 characters')
  }
  return rawPassphrase
}

type MainWindowProvider = () => BrowserWindow | null

const REFERENCE_IMAGE_FILTERS = [
  {
    name: 'Images',
    extensions: [
      'jpg',
      'jpeg',
      'png',
      'webp',
      'gif',
      'bmp',
      'svg',
      'avif',
      'ico',
      'tiff',
      'tif',
      'psd',
    ],
  },
]

export function registerAssetLibraryIpc(getMainWindow: MainWindowProvider): void {
  setAssetLibraryProgressListener((progress) => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(ASSET_LIBRARY_IPC.ON_TASK_PROGRESS, progress)
    }
  })

  secureIpcMain.handle(ASSET_LIBRARY_IPC.GET_STATS, () => getAssetLibraryStats())
  secureIpcMain.handle(ASSET_FEEDBACK_IPC.GET_STATUS, () => getAssetFeedbackSearchStatus())
  secureIpcMain.handle(ASSET_FEEDBACK_IPC.SET_ENABLED, (_event, rawEnabled: unknown) => {
    if (typeof rawEnabled !== 'boolean') throw new Error('Invalid search learning setting')
    return runAssetLibraryMutation(() => setAssetFeedbackSearchEnabled(rawEnabled))
  })
  secureIpcMain.handle(ASSET_FEEDBACK_IPC.REBUILD, () => buildAssetFeedbackSearchModel())
  secureIpcMain.handle(ASSET_LIBRARY_IPC.LIST_ASSETS, (_event, raw: unknown) => {
    const request = normalizeAssetListRequest(raw)
    if (isSourceFileSyncRunning()) {
      return {
        items: [],
        total: 0,
        offset: request.offset ?? 0,
        limit: request.limit ?? 80,
      }
    }
    return listAssetLibraryAssets(request)
  })
  secureIpcMain.handle(ASSET_LIBRARY_IPC.LIST_SMART_ALBUMS, () => listSmartAlbums())
  secureIpcMain.handle(ASSET_LIBRARY_IPC.CREATE_SMART_ALBUM, (_event, raw: unknown) =>
    runAssetLibraryMutation(() => createSmartAlbum(normalizeSmartAlbumInput(raw))),
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.UPDATE_SMART_ALBUM,
    (_event, rawId: unknown, raw: unknown) =>
      runAssetLibraryMutation(() =>
        updateSmartAlbum(positiveId(rawId, 'smart album id'), normalizeSmartAlbumPatch(raw)),
      ),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.DELETE_SMART_ALBUM, (_event, rawId: unknown) =>
    runAssetLibraryMutation(() => deleteSmartAlbum(positiveId(rawId, 'smart album id'))),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.LIST_COLLECTIONS, () => listCollections())
  secureIpcMain.handle(ASSET_LIBRARY_IPC.CREATE_COLLECTION, (_event, rawName: unknown) =>
    runAssetLibraryMutation(() => createCollection(optionalSafeText(rawName, 120) || '')),
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.UPDATE_COLLECTION,
    (_event, rawId: unknown, rawName: unknown) =>
      runAssetLibraryMutation(() =>
        updateCollection(positiveId(rawId, 'collection id'), optionalSafeText(rawName, 120) || ''),
      ),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.REORDER_COLLECTIONS, (_event, rawIds: unknown) =>
    runAssetLibraryMutation(() => reorderCollections(positiveIds(rawIds))),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.DELETE_COLLECTION, (_event, rawId: unknown) =>
    runAssetLibraryMutation(() => deleteCollection(positiveId(rawId, 'collection id'))),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.LIST_COLLECTION_ITEMS, (_event, rawId: unknown) =>
    isSourceFileSyncRunning() ? [] : listCollectionItems(positiveId(rawId, 'collection id')),
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.ADD_COLLECTION_ITEM,
    (_event, rawId: unknown, rawItem: unknown) =>
      runAssetLibraryMutation(() =>
        addCollectionItem(
          positiveId(rawId, 'collection id'),
          normalizeCollectionItemInput(rawItem),
        ),
      ),
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.ADD_COLLECTION_ITEMS,
    (_event, rawId: unknown, rawItems: unknown) =>
      runAssetLibraryMutation(() =>
        addCollectionItems(
          positiveId(rawId, 'collection id'),
          normalizeCollectionItemInputs(rawItems),
        ),
      ),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.REMOVE_COLLECTION_ITEM, (_event, rawId: unknown) =>
    runAssetLibraryMutation(() => removeCollectionItem(positiveId(rawId, 'collection item id'))),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.SYNC_FROM_IMAGE_INDEX, (_event, rawPath: unknown) =>
    syncAssetLibraryFromImageIndex(optionalSafeText(rawPath)),
  )

  secureIpcMain.handle(ASSET_LIBRARY_IPC.LIST_CATEGORIES, () => listAssetCategories())
  secureIpcMain.handle(ASSET_LIBRARY_IPC.CREATE_CATEGORY, (_event, raw: unknown) =>
    runAssetLibraryMutation(() => createAssetCategory(normalizeCategoryInput(raw))),
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.UPDATE_CATEGORY,
    (_event, rawId: unknown, rawInput: unknown) =>
      runAssetLibraryMutation(() =>
        updateAssetCategory(
          positiveId(rawId, 'category id'),
          normalizeCategoryInput(rawInput, true),
        ),
      ),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.DELETE_CATEGORY, (_event, rawId: unknown) =>
    runAssetLibraryMutation(() => deleteAssetCategory(positiveId(rawId, 'category id'))),
  )

  secureIpcMain.handle(ASSET_LIBRARY_IPC.LIST_TAGS, () => listAssetTags())
  secureIpcMain.handle(ASSET_LIBRARY_IPC.CREATE_TAG, (_event, raw: unknown) =>
    runAssetLibraryMutation(() => createAssetTag(normalizeTagInput(raw))),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.UPDATE_TAG, (_event, rawId: unknown, rawInput: unknown) =>
    runAssetLibraryMutation(() =>
      updateAssetTag(positiveId(rawId, 'tag id'), normalizeTagInput(rawInput, true)),
    ),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.DELETE_TAG, (_event, rawId: unknown) =>
    runAssetLibraryMutation(() => deleteAssetTag(positiveId(rawId, 'tag id'))),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.LIST_METADATA_DELETIONS, (_event, raw: unknown) =>
    listAssetMetadataDeletions(normalizeMetadataDeletionListRequest(raw)),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.RESTORE_METADATA_DELETION, (_event, rawId: unknown) =>
    runAssetLibraryMutation(() => restoreAssetMetadataDeletion(positiveId(rawId, 'deletion id'))),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.UNDO_LAST_METADATA_DELETION, () =>
    runAssetLibraryMutation(() => undoLastAssetMetadataDeletion()),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.EXPORT_METADATA_DELETIONS, async () => {
    const history = listAssetMetadataDeletions({ limit: 50, status: 'all' })
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'Window unavailable' }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export deletion history',
      defaultPath: `deletion-history-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      const payload = JSON.stringify(
        { version: 1, exportedAt: new Date().toISOString(), ...history },
        null,
        2,
      )
      fs.writeFileSync(result.filePath, payload, 'utf8')
      return { ok: true, path: result.filePath, recordCount: history.items.length }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  secureIpcMain.handle(ASSET_LIBRARY_IPC.PURGE_METADATA_DELETIONS, (_event, raw: unknown) => {
    const request =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    const restoredOnly = request.restoredOnly === true
    const confirm = request.confirm === true
    if (!restoredOnly && !confirm) {
      return { ok: false, error: 'Purging all deletion records requires confirm: true' }
    }
    return runAssetLibraryMutation(() => purgeAssetMetadataDeletions({ restoredOnly, confirm }))
  })
  secureIpcMain.handle(ASSET_LIBRARY_IPC.EXPORT_LIBRARY_REPORT, async () => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'Window unavailable' }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export library report',
      defaultPath: `asset-library-report-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      const report = {
        version: 1,
        generatedAt: new Date().toISOString(),
        stats: getAssetLibraryStats(),
        categories: listAssetCategories(),
        tags: listAssetTags(),
        deletionHistory: listAssetMetadataDeletions({ limit: 50, status: 'all' }),
      }
      fs.writeFileSync(result.filePath, JSON.stringify(report, null, 2), 'utf8')
      return { ok: true, path: result.filePath }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.ASSIGN_CATEGORY,
    (_event, rawAssetIds: unknown, rawCategoryId: unknown) =>
      runAssetLibraryMutation(() =>
        assignAssetsToCategory(positiveIds(rawAssetIds), positiveId(rawCategoryId, 'category id')),
      ),
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.ASSIGN_TAG,
    (_event, rawAssetIds: unknown, rawTagId: unknown) =>
      runAssetLibraryMutation(() =>
        assignAssetsToTag(positiveIds(rawAssetIds), positiveId(rawTagId, 'tag id')),
      ),
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.SET_CATEGORY_SAMPLE_FEEDBACK,
    (_event, rawAssetIds: unknown, rawCategoryId: unknown, rawRelevant: unknown) => {
      if (typeof rawRelevant !== 'boolean') throw new Error('Invalid sample feedback state')
      return runAssetLibraryMutation(() =>
        setCategorySampleFeedback(
          positiveIds(rawAssetIds),
          positiveId(rawCategoryId, 'category id'),
          rawRelevant,
        ),
      )
    },
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.REMOVE_CATEGORY_ASSIGNMENT,
    (_event, rawAssetIds: unknown, rawCategoryId: unknown) =>
      runAssetLibraryMutation(() =>
        removeAssetCategoryAssignment(
          positiveIds(rawAssetIds),
          positiveId(rawCategoryId, 'category id'),
        ),
      ),
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.REMOVE_TAG_ASSIGNMENT,
    (_event, rawAssetIds: unknown, rawTagId: unknown) =>
      runAssetLibraryMutation(() =>
        removeAssetTagAssignment(positiveIds(rawAssetIds), positiveId(rawTagId, 'tag id')),
      ),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.ARCHIVE_ASSETS, (_event, rawAssetIds: unknown) =>
    runAssetLibraryMutation(() => archiveAssetLibraryAssets(positiveIds(rawAssetIds))),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.RESTORE_ASSETS, (_event, rawAssetIds: unknown) =>
    runAssetLibraryMutation(() => restoreAssetLibraryAssets(positiveIds(rawAssetIds))),
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.SET_USER_METADATA,
    (_event, rawAssetIds: unknown, rawPatch: unknown) =>
      runAssetLibraryMutation(() =>
        setAssetLibraryUserMetadata(
          positiveIds(rawAssetIds),
          normalizeAssetUserMetadataPatch(rawPatch),
        ),
      ),
  )

  secureIpcMain.handle(ASSET_LIBRARY_IPC.LIST_REFERENCES, (_event, rawCategoryId: unknown) =>
    listCategoryReferences(
      rawCategoryId === undefined ? undefined : positiveId(rawCategoryId, 'category id'),
    ),
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.ADD_REFERENCES,
    (_event, rawCategoryId: unknown, rawAssetIds: unknown, rawWeight: unknown) =>
      runAssetLibraryMutation(() =>
        addCategoryReferences(
          positiveId(rawCategoryId, 'category id'),
          positiveIds(rawAssetIds),
          typeof rawWeight === 'number' && Number.isFinite(rawWeight) ? rawWeight : 1,
        ),
      ),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.SELECT_REFERENCE_IMAGES, async (_event, rawCategoryId) => {
    const categoryId = positiveId(rawCategoryId, 'category id')
    const options = {
      title: 'Select category reference images',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: REFERENCE_IMAGE_FILTERS,
    }
    const mainWindow = getMainWindow()
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (selection.canceled || selection.filePaths.length === 0) {
      return { ok: true, imported: 0, referencesAdded: 0, assetIds: [] }
    }
    return runAssetLibraryMutation(() =>
      importCategoryReferenceImages(categoryId, selection.filePaths),
    )
  })
  secureIpcMain.handle(ASSET_LIBRARY_IPC.PASTE_REFERENCE_IMAGE, async (_event, rawCategoryId) => {
    const categoryId = positiveId(rawCategoryId, 'category id')
    const image = clipboard.readImage()
    if (image.isEmpty()) return { ok: false, error: 'Clipboard does not contain an image' }
    const targetDir = path.join(app.getPath('userData'), 'asset-library', 'reference-images')
    await fs.promises.mkdir(targetDir, { recursive: true })
    const targetPath = path.join(
      targetDir,
      `clipboard-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`,
    )
    await fs.promises.writeFile(targetPath, image.toPNG())
    try {
      const result = await runAssetLibraryMutation(() =>
        importCategoryReferenceImages(categoryId, [targetPath]),
      )
      if (!result.ok) await fs.promises.unlink(targetPath).catch(() => {})
      return result
    } catch (error) {
      await fs.promises.unlink(targetPath).catch(() => {})
      throw error
    }
  })
  secureIpcMain.handle(ASSET_LIBRARY_IPC.REMOVE_REFERENCE, (_event, rawId: unknown) =>
    runAssetLibraryMutation(() => removeCategoryReference(positiveId(rawId, 'reference id'))),
  )

  secureIpcMain.handle(ASSET_LIBRARY_IPC.BUILD_REFERENCE_SUGGESTIONS, (_event, raw: unknown) =>
    buildReferenceSuggestions(normalizeReferenceSuggestionRequest(raw)),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.BUILD_TAG_SUGGESTIONS, (_event, raw: unknown) =>
    buildTagSuggestions(normalizeTagSuggestionRequest(raw)),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.LIST_SUGGESTIONS, (_event, raw: unknown) =>
    listAssetSuggestions(normalizeSuggestionListRequest(raw)),
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.REVIEW_SUGGESTIONS,
    (_event, rawIds: unknown, rawStatus: unknown) => {
      const status = String(rawStatus)
      if (status !== 'confirmed' && status !== 'rejected' && status !== 'ignored') {
        throw new Error('Invalid suggestion review status')
      }
      return runAssetLibraryMutation(() => reviewAssetSuggestions(positiveIds(rawIds), status))
    },
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.UNDO_SUGGESTIONS, (_event, rawIds: unknown) =>
    runAssetLibraryMutation(() => undoAssetSuggestions(positiveIds(rawIds))),
  )

  secureIpcMain.handle(ASSET_LIBRARY_IPC.BUILD_CLUSTERS, (_event, raw: unknown) =>
    buildAssetClusters(normalizeClusterRequest(raw)),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.BUILD_DUPLICATE_GROUPS, () =>
    buildLibraryDuplicateGroups(),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.BUILD_NEAR_DUPLICATE_GROUPS, (_event, raw: unknown) => {
    const req = inputRecord(raw)
    const threshold = Number(req.threshold)
    return buildLibraryNearDuplicateGroups(Number.isFinite(threshold) ? { threshold } : undefined)
  })
  secureIpcMain.handle(ASSET_LIBRARY_IPC.BUILD_CATEGORY_CLUSTER, (_event, raw: unknown) =>
    buildCategoryAssetCluster(normalizeCategoryClusterRequest(raw)),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.BUILD_PEOPLE_CLUSTERS, (_event, raw: unknown) =>
    buildSemanticPeopleClusters(normalizeClusterRequest(raw)),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.REFRESH_CLUSTER_LABELS, () => refreshAssetClusterLabels())
  secureIpcMain.handle(ASSET_LIBRARY_IPC.SELECT_CLUSTER_PATHS, async () => {
    const options = {
      title: 'Select folders or drive roots to cluster',
      properties: ['openDirectory', 'multiSelections'] as Array<
        'openDirectory' | 'multiSelections'
      >,
    }
    const mainWindow = getMainWindow()
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return { canceled: selection.canceled, paths: selection.filePaths }
  })
  secureIpcMain.handle(ASSET_LIBRARY_IPC.LIST_CLUSTERS, () => listAssetClusters())
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.UPDATE_CLUSTER,
    (_event, rawId: unknown, rawPatch: unknown) => {
      const patch = inputRecord(rawPatch)
      const status = String(patch.status)
      return runAssetLibraryMutation(() =>
        updateAssetCluster(positiveId(rawId, 'cluster id'), {
          ...(optionalSafeText(patch.name, 120) ? { name: optionalSafeText(patch.name, 120) } : {}),
          ...(status === 'suggested' || status === 'confirmed' || status === 'ignored'
            ? { status }
            : {}),
        }),
      )
    },
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.APPLY_DUPLICATE_GROUP, (_event, rawId: unknown) =>
    runAssetLibraryMutation(() => applyDuplicateGroup(positiveId(rawId, 'cluster id'))),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.MERGE_CLUSTERS, (_event, rawIds: unknown) =>
    runAssetLibraryMutation(() => mergeAssetClusters(positiveIds(rawIds, 64))),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.SPLIT_CLUSTER, (_event, rawId: unknown, rawIds: unknown) =>
    runAssetLibraryMutation(() =>
      splitAssetCluster(positiveId(rawId, 'cluster id'), positiveIds(rawIds, 10000)),
    ),
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.MOVE_CLUSTER_MEMBERS,
    (_event, rawFrom: unknown, rawTo: unknown, rawIds: unknown) =>
      runAssetLibraryMutation(() =>
        moveAssetClusterMembers(
          positiveId(rawFrom, 'cluster id'),
          rawTo === null || rawTo === undefined ? null : positiveId(rawTo, 'cluster id'),
          positiveIds(rawIds, 10000),
        ),
      ),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.LIST_CLUSTER_LINEAGE, (_event, raw: unknown) => {
    const req = inputRecord(raw)
    const groupId = req.groupId === undefined ? undefined : positiveId(req.groupId, 'cluster id')
    const limit = Number(req.limit)
    return listClusterLineage({
      ...(groupId !== undefined ? { groupId } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    })
  })
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.PROMOTE_CLUSTER,
    (_event, rawClusterId: unknown, rawCategoryId: unknown) =>
      runAssetLibraryMutation(() =>
        promoteAssetCluster(
          positiveId(rawClusterId, 'cluster id'),
          rawCategoryId === undefined ? undefined : positiveId(rawCategoryId, 'category id'),
        ),
      ),
  )

  secureIpcMain.handle(ASSET_LIBRARY_IPC.START_CATEGORY_SAMPLE_SEARCH, (_event, raw: unknown) =>
    startCategorySampleSearch(normalizeCategorySampleSearchRequest(raw)),
  )
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.GET_CATEGORY_SAMPLE_SEARCH_RESULTS,
    (_event, rawQuery: unknown) =>
      isSourceFileSyncRunning()
        ? null
        : getCategorySampleSearchResults(normalizeSearchResultQuery(rawQuery, true)),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.START_SIMILAR_SEARCH, (_event, raw: unknown) =>
    startAssetSimilarSearch(normalizeSimilarSearchRequest(raw)),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.GET_SIMILAR_SEARCH_RESULTS, (_event, rawQuery: unknown) =>
    isSourceFileSyncRunning()
      ? null
      : getAssetSimilarSearchResults(normalizeSearchResultQuery(rawQuery)),
  )

  secureIpcMain.handle(ASSET_LIBRARY_IPC.STOP_TASK, (_event, rawTaskId: unknown) =>
    stopAssetLibraryTask(optionalSafeText(rawTaskId, 120)),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.GET_TASK_PROGRESS, (_event, rawTaskId: unknown) =>
    getAssetLibraryTaskProgress(optionalSafeText(rawTaskId, 120)),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.LIST_BACKUPS, () => listAssetLibraryMetadataBackups())
  secureIpcMain.handle(ASSET_LIBRARY_IPC.CREATE_BACKUP, () =>
    runAssetLibraryMutation(() => createAssetLibraryMetadataBackup()),
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.VERIFY_BACKUP, (_event, rawBackupId: unknown) => {
    const backupId = optionalSafeText(rawBackupId, 180)
    if (!backupId) throw new Error('Invalid asset library backup id')
    return verifyAssetLibraryMetadataBackup(backupId)
  })
  secureIpcMain.handle(ASSET_LIBRARY_IPC.RESTORE_BACKUP, (_event, rawBackupId: unknown) => {
    const backupId = optionalSafeText(rawBackupId, 180)
    if (!backupId) throw new Error('Invalid asset library backup id')
    return runAssetLibraryMutation(() => restoreAssetLibraryMetadataBackup(backupId))
  })
  secureIpcMain.handle(ASSET_LIBRARY_IPC.OPEN_BACKUP_FOLDER, async () => {
    const error = await shell.openPath(getAssetLibraryMetadataBackupRoot())
    return error ? { ok: false, error } : { ok: true }
  })
  secureIpcMain.handle(
    ASSET_LIBRARY_IPC.EXPORT_BACKUP,
    async (_event, rawBackupId: unknown, rawPassphrase: unknown) => {
      const backupId = normalizeBackupIdInput(rawBackupId)
      const passphrase = normalizeBackupPassphrase(rawPassphrase)
      const options = {
        title: 'Choose a folder for the exported backup',
        properties: ['openDirectory', 'createDirectory'] as Array<
          'openDirectory' | 'createDirectory'
        >,
      }
      const mainWindow = getMainWindow()
      const selection = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)
      if (selection.canceled || selection.filePaths.length === 0) {
        return { ok: false, canceled: true }
      }
      try {
        const result = await exportEncryptedAssetLibraryBackup(
          getAssetLibraryMetadataBackupRoot(),
          backupId,
          selection.filePaths[0],
          passphrase,
        )
        return { ok: true, path: result.path }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },
  )
  secureIpcMain.handle(ASSET_LIBRARY_IPC.IMPORT_BACKUP, async (_event, rawPassphrase: unknown) => {
    const options = {
      title: 'Select an exported asset library backup folder',
      properties: ['openDirectory'] as Array<'openDirectory'>,
    }
    const mainWindow = getMainWindow()
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (selection.canceled || selection.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    try {
      const selectedDirectory = selection.filePaths[0]
      const encrypted = fs.existsSync(path.join(selectedDirectory, 'siftory-secure-backup.json'))
      const result = encrypted
        ? await importEncryptedAssetLibraryBackup(
            getAssetLibraryMetadataBackupRoot(),
            selectedDirectory,
            normalizeBackupPassphrase(rawPassphrase),
          )
        : await importAssetLibraryBackup(getAssetLibraryMetadataBackupRoot(), selectedDirectory)
      return { ok: true, backupId: result.backupId, path: result.path }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  })
  secureIpcMain.handle(ASSET_LIBRARY_IPC.DELETE_BACKUP, (_event, rawBackupId: unknown) => {
    const backupId = normalizeBackupIdInput(rawBackupId)
    return runAssetLibraryMutation(async () => {
      const backups = await listAssetLibraryMetadataBackups()
      if (!backups.some((backup) => backup.id === backupId)) {
        return { ok: false, error: 'Asset library backup not found' }
      }
      try {
        await deleteAssetLibraryBackup(getAssetLibraryMetadataBackupRoot(), backupId)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    })
  })
  secureIpcMain.handle(ASSET_LIBRARY_IPC.OPEN_ASSET, async (_event, rawAssetId: unknown) => {
    const assetPath = await resolveAssetLibraryAssetPath(positiveId(rawAssetId, 'asset id'))
    return openSafeShellPath(shell, assetPath, { requireExists: true })
  })
  secureIpcMain.handle(ASSET_LIBRARY_IPC.REVEAL_ASSET, async (_event, rawAssetId: unknown) => {
    const assetPath = await resolveAssetLibraryAssetPath(positiveId(rawAssetId, 'asset id'))
    return revealSafeShellPath(shell, assetPath, { requireExists: true })
  })
}
