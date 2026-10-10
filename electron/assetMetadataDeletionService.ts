import fs from 'fs'
import type {
  AssetCategory,
  AssetLibraryMutationResult,
  AssetLibraryPurgeMetadataDeletionsRequest,
  AssetLibraryPurgeMetadataDeletionsResult,
  AssetMetadataDeletionListRequest,
  AssetMetadataDeletionListResponse,
  AssetTag,
} from '../shared/ipc/asset-library'
import {
  assetMetadataDeletionHistoryLimits,
  assetMetadataDeletionRecordBytes,
  selectRetainedAssetMetadataDeletions,
} from './assetMetadataDeletionHistory'
import {
  getAssetLibraryBaseDir,
  requireAssetLibraryStores,
  sqliteWriteDb,
  withShadowRead,
  withSqliteWrite,
  type AssetMetadataDeletionBundle,
} from './assetLibraryStorageContext'
import { runJsonLinesTransaction } from './jsonLinesTransaction'
import { JsonLinesStore } from './vectorDatabaseService'

export type AssetMetadataDeletionDirtyHandler = (reason: string) => Promise<void>

export function pruneAssetMetadataDeletionHistory(
  store: JsonLinesStore<AssetMetadataDeletionBundle>,
): number {
  const records = store.getAll()
  const retained = new Set(selectRetainedAssetMetadataDeletions(records))
  if (retained.size === records.length) return 0
  return store.deleteWhere((record) => !retained.has(record))
}

export async function deleteAssetTaxonomyCategory(
  id: number,
  markDirty: AssetMetadataDeletionDirtyHandler,
): Promise<AssetLibraryMutationResult> {
  const stores = requireAssetLibraryStores()
  if (stores.categories.find((item) => item.parentId === id).length > 0) {
    return { ok: false, error: 'Move or delete child categories first' }
  }
  const category = stores.categories.getById(id)
  if (!category) return { ok: false, error: 'Category not found' }
  const deletionBundle: Omit<AssetMetadataDeletionBundle, 'id'> = {
    kind: 'category',
    name: category.name,
    category,
    categoryAssignments: stores.categoryAssignments.find((item) => item.categoryId === id),
    tagAssignments: [],
    references: stores.references.find((item) => item.categoryId === id),
    suggestions: stores.suggestions.find((item) => item.categoryId === id),
    deletedAt: Date.now(),
  }
  if (sqliteWriteDb()) {
    const bundle = withSqliteWrite((db) => {
      const record: AssetMetadataDeletionBundle = {
        ...deletionBundle,
        id: db.allocateId('metadata_deletion_trash'),
      }
      db.insertTrashBundle(record)
      db.pruneTrash(
        assetMetadataDeletionHistoryLimits.maxRecords,
        assetMetadataDeletionHistoryLimits.maxBytes,
      )
      if (category.sourceClusterGroupId) {
        db.updateClusterGroup(category.sourceClusterGroupId, {
          status: 'suggested',
          updatedAt: Date.now(),
        })
      }
      db.deleteCategoryRelations(id)
      db.deleteCategory(id)
      return record
    })
    stores.metadataDeletions.insert(bundle)
    pruneAssetMetadataDeletionHistory(stores.metadataDeletions)
    if (category.sourceClusterGroupId) {
      stores.clusters.update(category.sourceClusterGroupId, {
        status: 'suggested',
        updatedAt: Date.now(),
      })
    }
    stores.categories.deleteById(id)
    stores.categoryAssignments.deleteWhere((item) => item.categoryId === id)
    stores.references.deleteWhere((item) => item.categoryId === id)
    stores.suggestions.deleteWhere((item) => item.categoryId === id)
    await markDirty('Category deleted')
    return { ok: true }
  }
  await runJsonLinesTransaction(
    getAssetLibraryBaseDir(),
    [
      stores.categories,
      stores.categoryAssignments,
      stores.references,
      stores.suggestions,
      stores.metadataDeletions,
      ...(category.sourceClusterGroupId ? [stores.clusters] : []),
    ],
    () => {
      stores.metadataDeletions.insert(deletionBundle)
      pruneAssetMetadataDeletionHistory(stores.metadataDeletions)
      if (category.sourceClusterGroupId) {
        stores.clusters.update(category.sourceClusterGroupId, {
          status: 'suggested',
          updatedAt: Date.now(),
        })
      }
      stores.categories.deleteById(id)
      stores.categoryAssignments.deleteWhere((item) => item.categoryId === id)
      stores.references.deleteWhere((item) => item.categoryId === id)
      stores.suggestions.deleteWhere((item) => item.categoryId === id)
    },
  )
  await markDirty('Category deleted')
  return { ok: true }
}

export async function deleteAssetTaxonomyTag(
  id: number,
  markDirty: AssetMetadataDeletionDirtyHandler,
): Promise<AssetLibraryMutationResult> {
  const stores = requireAssetLibraryStores()
  const tag = stores.tags.getById(id)
  if (!tag) return { ok: false, error: 'Tag not found' }
  const deletionBundle: Omit<AssetMetadataDeletionBundle, 'id'> = {
    kind: 'tag',
    name: tag.name,
    tag,
    categoryAssignments: [],
    tagAssignments: stores.tagAssignments.find((item) => item.tagId === id),
    references: [],
    suggestions: stores.suggestions.find((item) => item.tagId === id),
    deletedAt: Date.now(),
  }
  if (sqliteWriteDb()) {
    const bundle = withSqliteWrite((db) => {
      const record: AssetMetadataDeletionBundle = {
        ...deletionBundle,
        id: db.allocateId('metadata_deletion_trash'),
      }
      db.insertTrashBundle(record)
      db.pruneTrash(
        assetMetadataDeletionHistoryLimits.maxRecords,
        assetMetadataDeletionHistoryLimits.maxBytes,
      )
      db.deleteTagRelations(id)
      db.deleteTag(id)
      return record
    })
    stores.metadataDeletions.insert(bundle)
    pruneAssetMetadataDeletionHistory(stores.metadataDeletions)
    stores.tags.deleteById(id)
    stores.tagAssignments.deleteWhere((item) => item.tagId === id)
    stores.suggestions.deleteWhere((item) => item.tagId === id)
    await markDirty('Tag deleted')
    return { ok: true }
  }
  await runJsonLinesTransaction(
    getAssetLibraryBaseDir(),
    [stores.tags, stores.tagAssignments, stores.suggestions, stores.metadataDeletions],
    () => {
      stores.metadataDeletions.insert(deletionBundle)
      pruneAssetMetadataDeletionHistory(stores.metadataDeletions)
      stores.tags.deleteById(id)
      stores.tagAssignments.deleteWhere((item) => item.tagId === id)
      stores.suggestions.deleteWhere((item) => item.tagId === id)
    },
  )
  await markDirty('Tag deleted')
  return { ok: true }
}

export async function restoreAssetMetadataDeletionRecord(
  id: number,
  markDirty: AssetMetadataDeletionDirtyHandler,
): Promise<AssetLibraryMutationResult> {
  const stores = requireAssetLibraryStores()
  const deletion = stores.metadataDeletions.getById(id)
  if (!deletion) return { ok: false, error: 'Deletion recovery record not found' }
  if (deletion.restoredAt) return { ok: false, error: 'Deletion was already restored' }
  if (!deletion.id) return { ok: false, error: 'Deletion recovery record is incomplete' }
  const now = Date.now()

  if (deletion.kind === 'category' && deletion.category) {
    if (
      stores.categories.find(
        (category) => category.name.toLowerCase() === deletion.name.toLowerCase(),
      ).length > 0
    ) {
      return { ok: false, error: `Category "${deletion.name}" already exists` }
    }
    if (sqliteWriteDb()) {
      const restored = withSqliteWrite((db) => {
        const restoredCategory: AssetCategory = {
          ...deletion.category!,
          id: db.allocateId('categories'),
          updatedAt: now,
        }
        db.insertCategory(restoredCategory)
        const restoredSuggestions = deletion.suggestions.map((suggestion) => ({
          ...suggestion,
          id: db.allocateId('suggestions'),
          categoryId: restoredCategory.id,
          updatedAt: now,
        }))
        db.insertDomainRecords('suggestions', restoredSuggestions)
        const suggestionIds = new Map(
          deletion.suggestions.map((suggestion, index) => [
            suggestion.id,
            restoredSuggestions[index]?.id,
          ]),
        )
        const restoredAssignments = deletion.categoryAssignments.map((assignment) => ({
          ...assignment,
          id: db.allocateId('asset_categories'),
          categoryId: restoredCategory.id,
          ...(assignment.suggestionId
            ? { suggestionId: suggestionIds.get(assignment.suggestionId) }
            : {}),
          updatedAt: now,
        }))
        db.insertDomainRecords('asset_categories', restoredAssignments)
        const restoredReferences = deletion.references.map((reference) => ({
          ...reference,
          id: db.allocateId('category_references'),
          categoryId: restoredCategory.id,
        }))
        db.insertDomainRecords('category_references', restoredReferences)
        if (deletion.category!.sourceClusterGroupId) {
          db.updateClusterGroup(deletion.category!.sourceClusterGroupId, {
            status: 'confirmed',
            updatedAt: now,
          })
        }
        db.markTrashRestored(deletion.id!, now)
        return { restoredCategory, restoredSuggestions, restoredAssignments, restoredReferences }
      })
      stores.categories.insert(restored.restoredCategory)
      stores.suggestions.insertMany(restored.restoredSuggestions)
      stores.categoryAssignments.insertMany(restored.restoredAssignments)
      stores.references.insertMany(restored.restoredReferences)
      if (deletion.category!.sourceClusterGroupId) {
        stores.clusters.update(deletion.category!.sourceClusterGroupId, {
          status: 'confirmed',
          updatedAt: now,
        })
      }
      stores.metadataDeletions.update(deletion.id!, { restoredAt: now })
      await markDirty(`${deletion.kind} deletion restored`)
      return { ok: true, affected: 1 }
    }
    await runJsonLinesTransaction(
      getAssetLibraryBaseDir(),
      [
        stores.categories,
        stores.categoryAssignments,
        stores.references,
        stores.suggestions,
        stores.metadataDeletions,
        ...(deletion.category.sourceClusterGroupId ? [stores.clusters] : []),
      ],
      () => {
        const restoredCategory = stores.categories.insert({
          ...deletion.category!,
          id: undefined,
          updatedAt: now,
        })
        const restoredSuggestions = stores.suggestions.insertMany(
          deletion.suggestions.map((suggestion) => ({
            ...suggestion,
            id: undefined,
            categoryId: restoredCategory.id,
            updatedAt: now,
          })),
        )
        const suggestionIds = new Map(
          deletion.suggestions.map((suggestion, index) => [
            suggestion.id,
            restoredSuggestions[index]?.id,
          ]),
        )
        stores.categoryAssignments.insertMany(
          deletion.categoryAssignments.map((assignment) => ({
            ...assignment,
            id: undefined,
            categoryId: restoredCategory.id,
            ...(assignment.suggestionId
              ? { suggestionId: suggestionIds.get(assignment.suggestionId) }
              : {}),
            updatedAt: now,
          })),
        )
        stores.references.insertMany(
          deletion.references.map((reference) => ({
            ...reference,
            id: undefined,
            categoryId: restoredCategory.id,
          })),
        )
        if (deletion.category!.sourceClusterGroupId) {
          stores.clusters.update(deletion.category!.sourceClusterGroupId, {
            status: 'confirmed',
            updatedAt: now,
          })
        }
        stores.metadataDeletions.update(deletion.id!, { restoredAt: now })
      },
    )
  } else if (deletion.kind === 'tag' && deletion.tag) {
    if (
      stores.tags.find((tagItem) => tagItem.name.toLowerCase() === deletion.name.toLowerCase())
        .length > 0
    ) {
      return { ok: false, error: `Tag "${deletion.name}" already exists` }
    }
    if (sqliteWriteDb()) {
      const restored = withSqliteWrite((db) => {
        const restoredTag: AssetTag = {
          ...deletion.tag!,
          id: db.allocateId('tags'),
          updatedAt: now,
        }
        db.insertTag(restoredTag)
        const restoredSuggestions = deletion.suggestions.map((suggestion) => ({
          ...suggestion,
          id: db.allocateId('suggestions'),
          tagId: restoredTag.id,
          updatedAt: now,
        }))
        db.insertDomainRecords('suggestions', restoredSuggestions)
        const suggestionIds = new Map(
          deletion.suggestions.map((suggestion, index) => [
            suggestion.id,
            restoredSuggestions[index]?.id,
          ]),
        )
        const restoredAssignments = deletion.tagAssignments.map((assignment) => ({
          ...assignment,
          id: db.allocateId('asset_tags'),
          tagId: restoredTag.id,
          ...(assignment.suggestionId
            ? { suggestionId: suggestionIds.get(assignment.suggestionId) }
            : {}),
          updatedAt: now,
        }))
        db.insertDomainRecords('asset_tags', restoredAssignments)
        db.markTrashRestored(deletion.id!, now)
        return { restoredTag, restoredSuggestions, restoredAssignments }
      })
      stores.tags.insert(restored.restoredTag)
      stores.suggestions.insertMany(restored.restoredSuggestions)
      stores.tagAssignments.insertMany(restored.restoredAssignments)
      stores.metadataDeletions.update(deletion.id!, { restoredAt: now })
      await markDirty(`${deletion.kind} deletion restored`)
      return { ok: true, affected: 1 }
    }
    await runJsonLinesTransaction(
      getAssetLibraryBaseDir(),
      [stores.tags, stores.tagAssignments, stores.suggestions, stores.metadataDeletions],
      () => {
        const restoredTag = stores.tags.insert({ ...deletion.tag!, id: undefined, updatedAt: now })
        const restoredSuggestions = stores.suggestions.insertMany(
          deletion.suggestions.map((suggestion) => ({
            ...suggestion,
            id: undefined,
            tagId: restoredTag.id,
            updatedAt: now,
          })),
        )
        const suggestionIds = new Map(
          deletion.suggestions.map((suggestion, index) => [
            suggestion.id,
            restoredSuggestions[index]?.id,
          ]),
        )
        stores.tagAssignments.insertMany(
          deletion.tagAssignments.map((assignment) => ({
            ...assignment,
            id: undefined,
            tagId: restoredTag.id,
            ...(assignment.suggestionId
              ? { suggestionId: suggestionIds.get(assignment.suggestionId) }
              : {}),
            updatedAt: now,
          })),
        )
        stores.metadataDeletions.update(deletion.id!, { restoredAt: now })
      },
    )
  } else {
    return { ok: false, error: 'Deletion recovery record is incomplete' }
  }
  await markDirty(`${deletion.kind} deletion restored`)
  return { ok: true, affected: 1 }
}

export async function undoLatestAssetMetadataDeletion(
  markDirty: AssetMetadataDeletionDirtyHandler,
): Promise<AssetLibraryMutationResult> {
  const deletion = requireAssetLibraryStores()
    .metadataDeletions.getAll()
    .filter((item) => !item.restoredAt)
    .sort((left, right) => right.deletedAt - left.deletedAt)[0]
  if (!deletion?.id) return { ok: false, error: 'No category or tag deletion to restore' }
  return restoreAssetMetadataDeletionRecord(deletion.id, markDirty)
}

function persistedStoreBytes<T extends { id?: number }>(store: JsonLinesStore<T>): number {
  try {
    const stats = fs.statSync(store.getPersistenceFilePath())
    return stats.isFile() ? stats.size : 0
  } catch {
    return 0
  }
}

export function listAssetMetadataDeletionHistory(
  request: AssetMetadataDeletionListRequest = {},
): AssetMetadataDeletionListResponse {
  const stores = requireAssetLibraryStores()
  const offset = Math.max(0, Math.floor(request.offset || 0))
  const limit = Math.max(1, Math.min(50, Math.floor(request.limit || 10)))
  const status = request.status || 'all'
  const page = withShadowRead(
    (db) => db.trashPage({ status, offset, limit }),
    () => null,
  )
  if (page) {
    return {
      items: page.items.map((item) => ({
        id: item.id,
        kind: item.kind as 'category' | 'tag',
        name: item.name,
        deletedAt: item.deletedAt,
        ...(item.restoredAt ? { restoredAt: item.restoredAt } : {}),
        relationCount: item.relationCount,
        estimatedBytes: item.estimatedBytes,
      })),
      total: page.total,
      offset,
      limit,
      totalBytes: page.totalBytes,
      maxRecords: assetMetadataDeletionHistoryLimits.maxRecords,
      maxBytes: assetMetadataDeletionHistoryLimits.maxBytes,
    }
  }
  const allRecords = stores.metadataDeletions.getAll()
  const records = allRecords
    .filter((item) => {
      if (!item.id || !Number.isInteger(item.id) || item.id <= 0) return false
      if (status === 'pending') return !item.restoredAt
      if (status === 'restored') return Boolean(item.restoredAt)
      return true
    })
    .sort((left, right) => right.deletedAt - left.deletedAt || (right.id || 0) - (left.id || 0))
  return {
    items: records.slice(offset, offset + limit).map((item) => ({
      id: item.id!,
      kind: item.kind,
      name: item.name,
      deletedAt: item.deletedAt,
      ...(item.restoredAt ? { restoredAt: item.restoredAt } : {}),
      relationCount:
        item.categoryAssignments.length +
        item.tagAssignments.length +
        item.references.length +
        item.suggestions.length,
      estimatedBytes: assetMetadataDeletionRecordBytes(item),
    })),
    total: records.length,
    offset,
    limit,
    totalBytes: persistedStoreBytes(stores.metadataDeletions),
    maxRecords: assetMetadataDeletionHistoryLimits.maxRecords,
    maxBytes: assetMetadataDeletionHistoryLimits.maxBytes,
  }
}

export async function purgeAssetMetadataDeletionHistory(
  request: AssetLibraryPurgeMetadataDeletionsRequest = {},
): Promise<AssetLibraryPurgeMetadataDeletionsResult> {
  const stores = requireAssetLibraryStores()
  const restoredOnly = request.restoredOnly === true
  if (!restoredOnly && request.confirm !== true) {
    return { ok: false, error: 'Purging all deletion records requires confirm: true' }
  }
  if (sqliteWriteDb()) {
    const purgedCount = withSqliteWrite((db) => db.deleteTrashRows(restoredOnly))
    if (restoredOnly) stores.metadataDeletions.deleteWhere((item) => !!item.restoredAt)
    else stores.metadataDeletions.clear()
    return { ok: true, purgedCount }
  }
  const purgedCount = restoredOnly
    ? stores.metadataDeletions.deleteWhere((item) => !!item.restoredAt)
    : stores.metadataDeletions.count()
  if (!restoredOnly) stores.metadataDeletions.clear()
  await stores.metadataDeletions.flush()
  return { ok: true, purgedCount }
}
