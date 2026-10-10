import type {
  AssetCategoryAssignment,
  AssetClassificationSuggestion,
  AssetLibraryMutationResult,
  AssetRecord,
  AssetTagAssignment,
} from '../shared/ipc/asset-library'
import {
  getAssetLibraryBaseDir,
  requireAssetLibraryStores,
  sqliteWriteDb,
  withSqliteWrite,
} from './assetLibraryStorageContext'
import { runJsonLinesTransaction } from './jsonLinesTransaction'

export type AssetAssignmentDirtyHandler = (reason: string) => Promise<void>

function isActiveAsset(asset: AssetRecord | undefined): asset is AssetRecord {
  return !!asset && !asset.missing && !asset.archived
}

export function upsertCategoryAssignments(
  assignments: AssetCategoryAssignment[],
  assetIds: number[],
  categoryId: number,
  source: AssetCategoryAssignment['source'],
  confidenceByAsset?: Map<number, number>,
  suggestionId?: number,
): AssetCategoryAssignment[] {
  const now = Date.now()
  const indexByPair = new Map(
    assignments.map((item, index) => [`${item.assetId}:${item.categoryId}`, index]),
  )
  for (const assetId of assetIds) {
    const pairKey = `${assetId}:${categoryId}`
    const existingIndex = indexByPair.get(pairKey) ?? -1
    const confidence = confidenceByAsset?.get(assetId) ?? 1
    if (existingIndex >= 0) {
      const existing = assignments[existingIndex]
      if (existing.source === 'manual' && source !== 'manual') continue
      const manualStatus =
        existing.source !== 'manual' || existing.status === 'manual_override'
          ? 'manual_override'
          : 'confirmed'
      assignments[existingIndex] = {
        ...existing,
        confidence,
        source,
        suggestionId:
          source === 'manual'
            ? undefined
            : suggestionId !== undefined
              ? suggestionId
              : existing.suggestionId,
        status: source === 'manual' ? manualStatus : 'confirmed',
        confirmedByUser: true,
        updatedAt: now,
      }
    } else {
      indexByPair.set(pairKey, assignments.length)
      assignments.push({
        id: 0,
        assetId,
        categoryId,
        ...(suggestionId !== undefined ? { suggestionId } : {}),
        confidence,
        source,
        status: 'confirmed',
        confirmedByUser: true,
        createdAt: now,
        updatedAt: now,
      })
    }
  }
  return assignments
}

export async function assignCategoryToAssets(
  assetIds: number[],
  categoryId: number,
  markDirty: AssetAssignmentDirtyHandler,
): Promise<AssetLibraryMutationResult> {
  const stores = requireAssetLibraryStores()
  await stores.assets.ensureLoaded()
  if (!stores.categories.getById(categoryId)) return { ok: false, error: 'Category not found' }
  const validIds = [...new Set(assetIds)].filter((id) => isActiveAsset(stores.assets.getById(id)))
  if (validIds.length === 0) return { ok: false, error: 'No valid assets selected' }
  if (sqliteWriteDb()) {
    const rows = withSqliteWrite((db) => {
      const subset = upsertCategoryAssignments(
        db.listCategoryAssignments({ categoryId, assetIds: validIds }),
        validIds,
        categoryId,
        'manual',
      )
      const finalRows = subset.map((item) =>
        item.id > 0 ? item : { ...item, id: db.allocateId('asset_categories') },
      )
      db.upsertCategoryAssignments(finalRows)
      return finalRows
    })
    const idSet = new Set(validIds)
    stores.categoryAssignments.deleteWhere(
      (item) => item.categoryId === categoryId && idSet.has(item.assetId),
    )
    stores.categoryAssignments.insertMany(rows)
    await markDirty('Manual category assignments changed')
    return { ok: true }
  }
  const records = upsertCategoryAssignments(
    stores.categoryAssignments.getAll(),
    validIds,
    categoryId,
    'manual',
  ).map((item) => (item.id > 0 ? item : { ...item, id: undefined }))
  stores.categoryAssignments.replaceAll(records)
  await stores.categoryAssignments.flush()
  await markDirty('Manual category assignments changed')
  return { ok: true }
}

export async function setCategoryAssetsFeedback(
  assetIds: number[],
  categoryId: number,
  relevant: boolean,
  markDirty: AssetAssignmentDirtyHandler,
): Promise<AssetLibraryMutationResult> {
  const stores = requireAssetLibraryStores()
  await stores.assets.ensureLoaded()
  if (!stores.categories.getById(categoryId)) return { ok: false, error: 'Category not found' }
  const validIds = [...new Set(assetIds)].filter((id) => isActiveAsset(stores.assets.getById(id)))
  if (validIds.length === 0) return { ok: false, error: 'No valid assets selected' }
  const idSet = new Set(validIds)
  const now = Date.now()

  if (sqliteWriteDb()) {
    if (relevant) {
      const rows = withSqliteWrite((db) => {
        const subset = upsertCategoryAssignments(
          db.listCategoryAssignments({ categoryId, assetIds: validIds }),
          validIds,
          categoryId,
          'manual',
        )
        const finalRows = subset.map((item) =>
          item.id > 0 ? item : { ...item, id: db.allocateId('asset_categories') },
        )
        db.upsertCategoryAssignments(finalRows)
        db.deleteSuggestionsForCategoryAssets(categoryId, validIds)
        return finalRows
      })
      stores.categoryAssignments.deleteWhere(
        (item) => item.categoryId === categoryId && idSet.has(item.assetId),
      )
      stores.categoryAssignments.insertMany(rows)
      stores.suggestions.deleteWhere(
        (item) => item.categoryId === categoryId && idSet.has(item.assetId),
      )
    } else {
      const outcome = withSqliteWrite((db) => {
        db.deleteAssignmentsForAssets('asset_categories', categoryId, validIds)
        const updatedIds: number[] = []
        const inserted: AssetClassificationSuggestion[] = []
        for (const assetId of validIds) {
          const existing = stores.suggestions.find(
            (item) => item.assetId === assetId && item.categoryId === categoryId,
          )[0]
          if (existing?.id) {
            db.rejectSuggestionAsManualReview(existing.id, now)
            updatedIds.push(existing.id)
          } else {
            const suggestion: AssetClassificationSuggestion = {
              id: db.allocateId('suggestions'),
              assetId,
              categoryId,
              confidence: 1,
              source: 'manual_review',
              status: 'rejected',
              evidenceAssetIds: [],
              createdAt: now,
              updatedAt: now,
            }
            db.insertDomainRecords('suggestions', [suggestion])
            inserted.push(suggestion)
          }
        }
        return { updatedIds, inserted }
      })
      stores.categoryAssignments.deleteWhere(
        (item) => item.categoryId === categoryId && idSet.has(item.assetId),
      )
      for (const updatedId of outcome.updatedIds) {
        stores.suggestions.update(updatedId, {
          confidence: 1,
          source: 'manual_review',
          status: 'rejected',
          updatedAt: now,
        })
      }
      stores.suggestions.insertMany(outcome.inserted)
    }
    await markDirty(
      relevant ? 'Category samples marked relevant' : 'Category samples marked unrelated',
    )
    return { ok: true, affected: validIds.length }
  }

  await runJsonLinesTransaction(
    getAssetLibraryBaseDir(),
    [stores.categoryAssignments, stores.suggestions],
    () => {
      if (relevant) {
        const assignments = upsertCategoryAssignments(
          stores.categoryAssignments.getAll(),
          validIds,
          categoryId,
          'manual',
        ).map((item) => (item.id > 0 ? item : { ...item, id: undefined }))
        stores.categoryAssignments.replaceAll(assignments)
        stores.suggestions.deleteWhere(
          (item) => item.categoryId === categoryId && idSet.has(item.assetId),
        )
      } else {
        stores.categoryAssignments.deleteWhere(
          (item) => item.categoryId === categoryId && idSet.has(item.assetId),
        )
        for (const assetId of validIds) {
          const existing = stores.suggestions.find(
            (item) => item.assetId === assetId && item.categoryId === categoryId,
          )[0]
          if (existing?.id) {
            stores.suggestions.update(existing.id, {
              confidence: 1,
              source: 'manual_review',
              status: 'rejected',
              updatedAt: now,
            })
          } else {
            stores.suggestions.insert({
              assetId,
              categoryId,
              confidence: 1,
              source: 'manual_review',
              status: 'rejected',
              evidenceAssetIds: [],
              createdAt: now,
              updatedAt: now,
            })
          }
        }
      }
    },
  )
  await markDirty(
    relevant ? 'Category samples marked relevant' : 'Category samples marked unrelated',
  )
  return { ok: true, affected: validIds.length }
}

export async function removeCategoryFromAssets(
  assetIds: number[],
  categoryId: number,
  markDirty: AssetAssignmentDirtyHandler,
): Promise<AssetLibraryMutationResult> {
  const stores = requireAssetLibraryStores()
  const ids = new Set(assetIds)
  if (sqliteWriteDb()) {
    withSqliteWrite((db) => db.deleteAssignmentsForAssets('asset_categories', categoryId, [...ids]))
    stores.categoryAssignments.deleteWhere(
      (item) => item.categoryId === categoryId && ids.has(item.assetId),
    )
    await markDirty('Category assignments removed')
    return { ok: true }
  }
  stores.categoryAssignments.deleteWhere(
    (item) => item.categoryId === categoryId && ids.has(item.assetId),
  )
  await stores.categoryAssignments.flush()
  await markDirty('Category assignments removed')
  return { ok: true }
}

export async function assignTagToAssets(
  assetIds: number[],
  tagId: number,
  markDirty: AssetAssignmentDirtyHandler,
): Promise<AssetLibraryMutationResult> {
  const stores = requireAssetLibraryStores()
  await stores.assets.ensureLoaded()
  if (!stores.tags.getById(tagId)) return { ok: false, error: 'Tag not found' }
  const validIds = [...new Set(assetIds)].filter((id) => isActiveAsset(stores.assets.getById(id)))
  if (validIds.length === 0) return { ok: false, error: 'No valid assets selected' }
  const now = Date.now()
  if (sqliteWriteDb()) {
    const rows = withSqliteWrite((db) => {
      const existing = db.listTagAssignments({ tagId, assetIds: validIds })
      const existingByPair = new Map(
        existing.map((item) => [`${item.assetId}:${item.tagId}`, item]),
      )
      const result: AssetTagAssignment[] = []
      for (const assetId of validIds) {
        const current = existingByPair.get(`${assetId}:${tagId}`)
        if (current) {
          result.push({
            ...current,
            confidence: 1,
            source: 'manual',
            status:
              current.source !== 'manual' || current.status === 'manual_override'
                ? 'manual_override'
                : 'confirmed',
            confirmedByUser: true,
            updatedAt: now,
          })
        } else {
          result.push({
            id: db.allocateId('asset_tags'),
            assetId,
            tagId,
            confidence: 1,
            source: 'manual',
            status: 'confirmed',
            confirmedByUser: true,
            createdAt: now,
            updatedAt: now,
          })
        }
      }
      db.upsertTagAssignments(result)
      return result
    })
    const idSet = new Set(validIds)
    stores.tagAssignments.deleteWhere((item) => item.tagId === tagId && idSet.has(item.assetId))
    stores.tagAssignments.insertMany(rows)
    await markDirty('Manual tag assignments changed')
    return { ok: true }
  }
  const records = stores.tagAssignments.getAll()
  const indexByPair = new Map(
    records.map((item, index) => [`${item.assetId}:${item.tagId}`, index]),
  )
  for (const assetId of validIds) {
    const pairKey = `${assetId}:${tagId}`
    const index = indexByPair.get(pairKey) ?? -1
    if (index >= 0) {
      const existing = records[index]
      records[index] = {
        ...existing,
        confidence: 1,
        source: 'manual',
        status:
          existing.source !== 'manual' || existing.status === 'manual_override'
            ? 'manual_override'
            : 'confirmed',
        confirmedByUser: true,
        updatedAt: now,
      }
    } else {
      indexByPair.set(pairKey, records.length)
      records.push({
        id: 0,
        assetId,
        tagId,
        confidence: 1,
        source: 'manual',
        status: 'confirmed',
        confirmedByUser: true,
        createdAt: now,
        updatedAt: now,
      })
    }
  }
  stores.tagAssignments.replaceAll(
    records.map((item) => (item.id > 0 ? item : { ...item, id: undefined })),
  )
  await stores.tagAssignments.flush()
  await markDirty('Manual tag assignments changed')
  return { ok: true }
}

export async function removeTagFromAssets(
  assetIds: number[],
  tagId: number,
  markDirty: AssetAssignmentDirtyHandler,
): Promise<AssetLibraryMutationResult> {
  const stores = requireAssetLibraryStores()
  const ids = new Set(assetIds)
  if (sqliteWriteDb()) {
    withSqliteWrite((db) => db.deleteAssignmentsForAssets('asset_tags', tagId, [...ids]))
    stores.tagAssignments.deleteWhere((item) => item.tagId === tagId && ids.has(item.assetId))
    await markDirty('Tag assignments removed')
    return { ok: true }
  }
  stores.tagAssignments.deleteWhere((item) => item.tagId === tagId && ids.has(item.assetId))
  await stores.tagAssignments.flush()
  await markDirty('Tag assignments removed')
  return { ok: true }
}

export async function setAssetsArchived(
  assetIds: number[],
  archived: boolean,
  markDirty: AssetAssignmentDirtyHandler,
): Promise<AssetLibraryMutationResult> {
  const affected = await requireAssetLibraryStores().assets.setArchived(assetIds, archived)
  if (affected > 0) {
    await markDirty(
      archived ? 'Assets removed from the active library' : 'Assets restored to the active library',
    )
  }
  return affected > 0
    ? { ok: true, affected }
    : {
        ok: false,
        affected: 0,
        error: archived ? 'No active assets selected' : 'No removed assets selected',
      }
}

export async function setAssetsUserMetadata(
  assetIds: number[],
  patch: { rating?: number; favorite?: boolean },
): Promise<AssetLibraryMutationResult> {
  const affected = await requireAssetLibraryStores().assets.setUserMetadata(assetIds, patch)
  return affected > 0
    ? { ok: true, affected }
    : { ok: false, affected: 0, error: 'No active assets changed' }
}

export async function resolveActiveAssetPath(assetId: number): Promise<string> {
  const stores = requireAssetLibraryStores()
  await stores.assets.ensureLoaded()
  const asset = stores.assets.getById(assetId)
  if (!asset) throw new Error('Asset not found')
  if (asset.missing) throw new Error('Asset file is marked missing')
  return asset.path
}
