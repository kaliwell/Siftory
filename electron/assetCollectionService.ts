import type {
  AssetCollection,
  AssetCollectionItem,
  AssetCollectionItemInput,
  AssetLibraryMutationResult,
} from '../shared/ipc/asset-library'
import { getAssetLibraryBaseDir, requireAssetLibraryStores } from './assetLibraryStorageContext'
import { runJsonLinesTransaction } from './jsonLinesTransaction'

function referenceKey(input: AssetCollectionItemInput): string {
  return input.assetId ? `asset:${input.assetId}` : `entry:${input.fileEntryId}`
}

export function listAssetCollections(): AssetCollection[] {
  return requireAssetLibraryStores()
    .collections.getAll()
    .sort(
      (a, b) =>
        (a.sortOrder ?? a.id - 1) - (b.sortOrder ?? b.id - 1) ||
        a.name.localeCompare(b.name) ||
        a.id - b.id,
    )
}

export async function createAssetCollection(nameInput: string): Promise<AssetCollection> {
  const store = requireAssetLibraryStores().collections
  const name = nameInput.trim()
  if (!name) throw new Error('Collection name is required')
  if (store.find((item) => item.name.toLowerCase() === name.toLowerCase()).length > 0) {
    throw new Error('A collection with this name already exists')
  }
  const now = Date.now()
  const collection = store.insert({
    name,
    sortOrder:
      store
        .getAll()
        .reduce((maximum, item) => Math.max(maximum, item.sortOrder ?? item.id - 1), -1) + 1,
    createdAt: now,
    updatedAt: now,
  })
  await store.flush()
  return collection
}

export async function updateAssetCollection(
  id: number,
  nameInput: string,
): Promise<AssetCollection> {
  const store = requireAssetLibraryStores().collections
  const collection = store.getById(id)
  if (!collection) throw new Error('Collection not found')
  const name = nameInput.trim()
  if (!name) throw new Error('Collection name is required')
  if (
    store.find((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase()).length >
    0
  ) {
    throw new Error('A collection with this name already exists')
  }
  store.update(id, { name, updatedAt: Date.now() })
  await store.flush()
  return store.getById(id)!
}

export async function reorderAssetCollections(ids: number[]): Promise<AssetLibraryMutationResult> {
  const store = requireAssetLibraryStores().collections
  const current = listAssetCollections()
  if (
    ids.length !== current.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !current.some((collection) => collection.id === id))
  ) {
    throw new Error('Collection order must contain every collection exactly once')
  }
  const now = Date.now()
  await runJsonLinesTransaction(getAssetLibraryBaseDir(), [store], () => {
    ids.forEach((id, sortOrder) => store.update(id, { sortOrder, updatedAt: now }))
  })
  return { ok: true, affected: ids.length }
}

export async function deleteAssetCollection(id: number): Promise<AssetLibraryMutationResult> {
  const stores = requireAssetLibraryStores()
  return runJsonLinesTransaction(
    getAssetLibraryBaseDir(),
    [stores.collections, stores.collectionItems],
    () => {
      if (!stores.collections.deleteById(id)) return { ok: false, error: 'Collection not found' }
      const affectedItems = stores.collectionItems.deleteWhere((item) => item.collectionId === id)
      return { ok: true, affected: affectedItems + 1 }
    },
  )
}

export function listAssetCollectionItems(collectionId: number): AssetCollectionItem[] {
  const stores = requireAssetLibraryStores()
  if (!stores.collections.getById(collectionId)) throw new Error('Collection not found')
  return stores.collectionItems
    .find((item) => item.collectionId === collectionId)
    .sort((a, b) => b.addedAt - a.addedAt || b.id - a.id)
}

export async function addAssetCollectionItem(
  collectionId: number,
  input: AssetCollectionItemInput,
): Promise<AssetCollectionItem> {
  return (await addAssetCollectionItems(collectionId, [input]))[0]
}

export async function addAssetCollectionItems(
  collectionId: number,
  inputs: AssetCollectionItemInput[],
): Promise<AssetCollectionItem[]> {
  const stores = requireAssetLibraryStores()
  if (!stores.collections.getById(collectionId)) throw new Error('Collection not found')
  const now = Date.now()
  const results: AssetCollectionItem[] = []
  await runJsonLinesTransaction(
    getAssetLibraryBaseDir(),
    [stores.collections, stores.collectionItems],
    () => {
      for (const input of inputs) {
        const key = referenceKey(input)
        const existing = stores.collectionItems.find(
          (item) =>
            item.collectionId === collectionId &&
            (item.referenceKey === key ||
              (!!input.fileEntryId && item.fileEntryId === input.fileEntryId)),
        )[0]
        if (existing) {
          stores.collectionItems.update(existing.id, { ...input, referenceKey: key })
          results.push(stores.collectionItems.getById(existing.id)!)
        } else {
          results.push(
            stores.collectionItems.insert({
              ...input,
              collectionId,
              referenceKey: key,
              addedAt: now,
            }),
          )
        }
      }
      stores.collections.update(collectionId, { updatedAt: now })
    },
  )
  return results
}

export async function removeAssetCollectionItem(id: number): Promise<AssetLibraryMutationResult> {
  const store = requireAssetLibraryStores().collectionItems
  if (!store.deleteById(id)) return { ok: false, error: 'Collection item not found' }
  await store.flush()
  return { ok: true, affected: 1 }
}
