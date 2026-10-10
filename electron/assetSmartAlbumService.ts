import type {
  AssetLibraryMutationResult,
  AssetSmartAlbum,
  AssetSmartAlbumInput,
  AssetSmartAlbumRules,
} from '../shared/ipc/asset-library'
import { normalizeAssetLibraryListRequest } from './assetLibraryListRequest'
import { requireAssetLibraryStores } from './assetLibraryStorageContext'

export function normalizeAssetSmartAlbumRules(
  rules: Partial<AssetSmartAlbumRules> = {},
): AssetSmartAlbumRules {
  const normalized = normalizeAssetLibraryListRequest(rules)
  return {
    sort: normalized.sort,
    ...(normalized.query ? { query: normalized.query } : {}),
    ...(normalized.categoryId !== undefined ? { categoryId: normalized.categoryId } : {}),
    ...(normalized.tagId !== undefined ? { tagId: normalized.tagId } : {}),
    ...(normalized.unclassified ? { unclassified: true } : {}),
    ...(normalized.archivedOnly ? { archivedOnly: true } : {}),
    ...(normalized.source ? { source: normalized.source } : {}),
    ...(normalized.kind ? { kind: normalized.kind } : {}),
    ...(normalized.modifiedAfter !== undefined ? { modifiedAfter: normalized.modifiedAfter } : {}),
    ...(normalized.modifiedBefore !== undefined
      ? { modifiedBefore: normalized.modifiedBefore }
      : {}),
    ...(normalized.minRating !== undefined ? { minRating: normalized.minRating } : {}),
    ...(normalized.favoriteOnly ? { favoriteOnly: true } : {}),
  }
}

export function listAssetSmartAlbums(): AssetSmartAlbum[] {
  return requireAssetLibraryStores()
    .smartAlbums.getAll()
    .map((album) => ({ ...album, rules: normalizeAssetSmartAlbumRules(album.rules) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
}

export async function createAssetSmartAlbum(input: AssetSmartAlbumInput): Promise<AssetSmartAlbum> {
  const store = requireAssetLibraryStores().smartAlbums
  const name = input.name.trim()
  if (!name) throw new Error('Smart album name is required')
  if (store.find((album) => album.name.toLowerCase() === name.toLowerCase()).length > 0) {
    throw new Error('A smart album with this name already exists')
  }
  const now = Date.now()
  const album = store.insert({
    name,
    rules: normalizeAssetSmartAlbumRules(input.rules),
    createdAt: now,
    updatedAt: now,
  })
  await store.flush()
  return album
}

export async function updateAssetSmartAlbum(
  id: number,
  input: Partial<AssetSmartAlbumInput>,
): Promise<AssetSmartAlbum> {
  const store = requireAssetLibraryStores().smartAlbums
  const existing = store.getById(id)
  if (!existing) throw new Error('Smart album not found')
  const name = input.name?.trim()
  if (!name && typeof input.name === 'string') throw new Error('Smart album name is required')
  if (
    name &&
    store.find((album) => album.id !== id && album.name.toLowerCase() === name.toLowerCase())
      .length > 0
  ) {
    throw new Error('A smart album with this name already exists')
  }
  store.update(id, {
    ...(name ? { name } : {}),
    ...(input.rules ? { rules: normalizeAssetSmartAlbumRules(input.rules) } : {}),
    updatedAt: Date.now(),
  })
  await store.flush()
  return store.getById(id)!
}

export async function deleteAssetSmartAlbum(id: number): Promise<AssetLibraryMutationResult> {
  const store = requireAssetLibraryStores().smartAlbums
  if (!store.deleteById(id)) return { ok: false, error: 'Smart album not found' }
  await store.flush()
  return { ok: true, affected: 1 }
}
