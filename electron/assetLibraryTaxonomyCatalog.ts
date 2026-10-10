import type {
  AssetCategory,
  AssetLibraryCategoryInput,
  AssetLibraryTagInput,
  AssetTag,
} from '../shared/ipc/asset-library'
import { resolveReferenceThresholds } from './assetLibraryScoring'
import {
  requireAssetLibraryStores,
  sqliteWriteDb,
  withShadowRead,
  withSqliteWrite,
} from './assetLibraryStorageContext'
import { JsonLinesStore } from './vectorDatabaseService'

export type AssetTaxonomyDirtyHandler = (reason: string) => Promise<void>

export function assetCategoryRecordFields(
  input: AssetLibraryCategoryInput,
  now = Date.now(),
): Omit<AssetCategory, 'id'> {
  return {
    name: input.name.trim(),
    description: input.description?.trim() || '',
    parentId: input.parentId || null,
    color: input.color || '#53c7a2',
    icon: input.icon || 'folder',
    sortOrder: Number.isFinite(input.sortOrder) ? Math.floor(input.sortOrder || 0) : 0,
    referenceThreshold: resolveReferenceThresholds(input.referenceThreshold).suggested,
    createdAt: now,
    updatedAt: now,
  }
}

export function insertAssetCategoryRecord(
  store: JsonLinesStore<AssetCategory>,
  input: AssetLibraryCategoryInput,
  now = Date.now(),
): AssetCategory {
  return store.insert(assetCategoryRecordFields(input, now))
}

export function listAssetTaxonomyCategories(): AssetCategory[] {
  const categories = withShadowRead(
    (db) => db.listCategories(),
    () => requireAssetLibraryStores().categories.getAll(),
  )
  return categories
    .map((category) => ({
      ...category,
      referenceThreshold: resolveReferenceThresholds(category.referenceThreshold).suggested,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

export async function createAssetTaxonomyCategory(
  input: AssetLibraryCategoryInput,
  markDirty: AssetTaxonomyDirtyHandler,
): Promise<AssetCategory> {
  const stores = requireAssetLibraryStores()
  const name = input.name.trim()
  if (!name) throw new Error('Category name is required')
  if (stores.categories.find((item) => item.name.toLowerCase() === name.toLowerCase()).length > 0) {
    throw new Error('A category with this name already exists')
  }
  if (input.parentId && !stores.categories.getById(input.parentId)) {
    throw new Error('Parent category does not exist')
  }
  if (sqliteWriteDb()) {
    const category = withSqliteWrite((db) => {
      const record: AssetCategory = {
        id: db.allocateId('categories'),
        ...assetCategoryRecordFields({ ...input, name }),
      }
      db.insertCategory(record)
      return record
    })
    stores.categories.insert(category)
    await markDirty('Category created')
    return category
  }
  const category = insertAssetCategoryRecord(stores.categories, { ...input, name })
  await stores.categories.flush()
  await markDirty('Category created')
  return category
}

export async function updateAssetTaxonomyCategory(
  id: number,
  input: Partial<AssetLibraryCategoryInput>,
  markDirty: AssetTaxonomyDirtyHandler,
): Promise<AssetCategory> {
  const stores = requireAssetLibraryStores()
  const existing = stores.categories.getById(id)
  if (!existing) throw new Error('Category not found')
  if (input.parentId === id) throw new Error('A category cannot be its own parent')
  if (input.parentId && !stores.categories.getById(input.parentId)) {
    throw new Error('Parent category does not exist')
  }
  if (input.parentId) {
    let ancestor = stores.categories.getById(input.parentId)
    const visited = new Set<number>()
    while (ancestor && !visited.has(ancestor.id)) {
      if (ancestor.id === id) throw new Error('Category hierarchy cannot contain a cycle')
      visited.add(ancestor.id)
      ancestor = ancestor.parentId ? stores.categories.getById(ancestor.parentId) : undefined
    }
  }
  const name = input.name?.trim()
  if (
    name &&
    stores.categories.find(
      (item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase(),
    ).length > 0
  ) {
    throw new Error('A category with this name already exists')
  }
  const patch = {
    ...(name ? { name } : {}),
    ...(typeof input.description === 'string' ? { description: input.description.trim() } : {}),
    ...(input.parentId === null || Number.isInteger(input.parentId)
      ? { parentId: input.parentId || null }
      : {}),
    ...(typeof input.color === 'string' ? { color: input.color } : {}),
    ...(typeof input.icon === 'string' ? { icon: input.icon } : {}),
    ...(Number.isFinite(input.sortOrder) ? { sortOrder: Math.floor(input.sortOrder || 0) } : {}),
    ...(Number.isFinite(input.referenceThreshold)
      ? {
          referenceThreshold: resolveReferenceThresholds(input.referenceThreshold).suggested,
        }
      : {}),
    updatedAt: Date.now(),
  }
  if (sqliteWriteDb()) {
    withSqliteWrite((db) => db.updateCategory(id, patch))
    stores.categories.update(id, patch)
    await markDirty('Category updated')
    return stores.categories.getById(id)!
  }
  stores.categories.update(id, patch)
  await stores.categories.flush()
  await markDirty('Category updated')
  return stores.categories.getById(id)!
}

export function listAssetTaxonomyTags(): AssetTag[] {
  const tags = withShadowRead(
    (db) => db.listTags(),
    () => requireAssetLibraryStores().tags.getAll(),
  )
  return tags.sort((a, b) => a.name.localeCompare(b.name))
}

export async function createAssetTaxonomyTag(
  input: AssetLibraryTagInput,
  markDirty: AssetTaxonomyDirtyHandler,
): Promise<AssetTag> {
  const stores = requireAssetLibraryStores()
  const name = input.name.trim()
  if (!name) throw new Error('Tag name is required')
  if (stores.tags.find((item) => item.name.toLowerCase() === name.toLowerCase()).length > 0) {
    throw new Error('A tag with this name already exists')
  }
  const now = Date.now()
  if (sqliteWriteDb()) {
    const tag = withSqliteWrite((db) => {
      const record: AssetTag = {
        id: db.allocateId('tags'),
        name,
        color: input.color || '#f0b35d',
        createdAt: now,
        updatedAt: now,
      }
      db.insertTag(record)
      return record
    })
    stores.tags.insert(tag)
    await markDirty('Tag created')
    return tag
  }
  const tag = stores.tags.insert({
    name,
    color: input.color || '#f0b35d',
    createdAt: now,
    updatedAt: now,
  })
  await stores.tags.flush()
  await markDirty('Tag created')
  return tag
}

export async function updateAssetTaxonomyTag(
  id: number,
  input: Partial<AssetLibraryTagInput>,
  markDirty: AssetTaxonomyDirtyHandler,
): Promise<AssetTag> {
  const stores = requireAssetLibraryStores()
  const existing = stores.tags.getById(id)
  if (!existing) throw new Error('Tag not found')
  const name = input.name?.trim()
  if (
    name &&
    stores.tags.find((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())
      .length > 0
  ) {
    throw new Error('A tag with this name already exists')
  }
  const patch = {
    ...(name ? { name } : {}),
    ...(typeof input.color === 'string' ? { color: input.color } : {}),
    updatedAt: Date.now(),
  }
  if (sqliteWriteDb()) {
    withSqliteWrite((db) => db.updateTag(id, patch))
    stores.tags.update(id, patch)
    await markDirty('Tag updated')
    return stores.tags.getById(id)!
  }
  stores.tags.update(id, patch)
  await stores.tags.flush()
  await markDirty('Tag updated')
  return stores.tags.getById(id)!
}
