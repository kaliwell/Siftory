import type {
  AssetLibraryMutationResult,
  AssetLibraryReferenceImportResult,
  AssetLibraryReferenceItem,
  AssetRecord,
} from '../shared/ipc/asset-library'
import {
  requireAssetLibraryStores,
  sqliteWriteDb,
  withSqliteWrite,
} from './assetLibraryStorageContext'

export type AssetReferenceDirtyHandler = (reason: string) => Promise<void>

function isActiveAsset(asset: AssetRecord | undefined): asset is AssetRecord {
  return !!asset && !asset.missing && !asset.archived
}

export async function listAssetCategoryReferences(
  categoryId?: number,
): Promise<AssetLibraryReferenceItem[]> {
  const stores = requireAssetLibraryStores()
  await stores.assets.ensureLoaded()
  return stores.references
    .getAll()
    .filter((item) => categoryId === undefined || item.categoryId === categoryId)
    .map((reference) => ({
      reference,
      asset: stores.assets.getById(reference.assetId),
    }))
}

export async function addAssetCategoryReferences(
  categoryId: number,
  assetIds: number[],
  weight: number,
  markDirty: AssetReferenceDirtyHandler,
): Promise<AssetLibraryMutationResult> {
  const stores = requireAssetLibraryStores()
  await stores.assets.ensureLoaded()
  if (!stores.categories.getById(categoryId)) return { ok: false, error: 'Category not found' }
  const clampedWeight = Math.max(0.1, Math.min(10, weight))
  const validIds = [...new Set(assetIds)].filter((id) => isActiveAsset(stores.assets.getById(id)))
  if (sqliteWriteDb()) {
    const inserted = withSqliteWrite((db) => {
      const now = Date.now()
      const newRows: Array<{
        id: number
        categoryId: number
        assetId: number
        weight: number
        createdAt: number
      }> = []
      const existingByAsset = new Map(
        stores.references
          .getAll()
          .filter((item) => item.categoryId === categoryId)
          .map((item) => [item.assetId, item] as const),
      )
      for (const assetId of validIds) {
        if (existingByAsset.has(assetId)) {
          db.updateReferenceWeight(categoryId, assetId, clampedWeight)
        } else {
          const row = {
            id: db.allocateId('category_references'),
            categoryId,
            assetId,
            weight: clampedWeight,
            createdAt: now,
          }
          db.insertReferenceIgnore(row)
          newRows.push(row)
        }
      }
      return newRows
    })
    for (const assetId of validIds) {
      const existing = stores.references
        .getAll()
        .find((item) => item.categoryId === categoryId && item.assetId === assetId)
      if (existing?.id) stores.references.update(existing.id, { weight: clampedWeight })
    }
    stores.references.insertMany(inserted)
    await markDirty('Category reference images changed')
    return { ok: true }
  }
  const records = stores.references.getAll()
  const now = Date.now()
  for (const assetId of [...new Set(assetIds)]) {
    if (!isActiveAsset(stores.assets.getById(assetId))) continue
    const existing = records.find(
      (item) => item.categoryId === categoryId && item.assetId === assetId,
    )
    if (existing) existing.weight = clampedWeight
    else {
      records.push({
        id: 0,
        categoryId,
        assetId,
        weight: clampedWeight,
        createdAt: now,
      })
    }
  }
  stores.references.replaceAll(
    records.map((item) => (item.id > 0 ? item : { ...item, id: undefined })),
  )
  await stores.references.flush()
  await markDirty('Category reference images changed')
  return { ok: true }
}

export async function importAssetCategoryReferenceImages(
  categoryId: number,
  filePaths: string[],
  markDirty: AssetReferenceDirtyHandler,
): Promise<AssetLibraryReferenceImportResult> {
  const stores = requireAssetLibraryStores()
  if (!stores.categories.getById(categoryId)) return { ok: false, error: 'Category not found' }
  const assets = await stores.assets.importManualImages(filePaths)
  if (assets.length === 0) {
    return { ok: false, error: 'No supported, readable image files were selected' }
  }
  const existingPairs = new Set(
    stores.references
      .getAll()
      .filter((item) => item.categoryId === categoryId)
      .map((item) => item.assetId),
  )
  const result = await addAssetCategoryReferences(
    categoryId,
    assets.map((asset) => asset.id),
    1,
    markDirty,
  )
  if (!result.ok) return result
  return {
    ok: true,
    imported: assets.length,
    referencesAdded: assets.filter((asset) => !existingPairs.has(asset.id)).length,
    assetIds: assets.map((asset) => asset.id),
  }
}

export async function removeAssetCategoryReference(
  id: number,
  markDirty: AssetReferenceDirtyHandler,
): Promise<AssetLibraryMutationResult> {
  const stores = requireAssetLibraryStores()
  if (!stores.references.getById(id)) return { ok: false, error: 'Reference not found' }
  if (sqliteWriteDb()) {
    withSqliteWrite((db) => db.deleteReference(id))
    stores.references.deleteById(id)
    await markDirty('Category reference image removed')
    return { ok: true }
  }
  if (!stores.references.deleteById(id)) return { ok: false, error: 'Reference not found' }
  await stores.references.flush()
  await markDirty('Category reference image removed')
  return { ok: true }
}
