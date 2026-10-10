import fs from 'fs'
import path from 'path'
import type {
  AssetCategory,
  AssetCategoryAssignment,
  AssetCategoryReference,
  AssetClassificationSuggestion,
  AssetClusterGroup,
  AssetClusterLineageEvent,
  AssetClusterMember,
  AssetSmartAlbum,
  AssetCollection,
  AssetCollectionItem,
  AssetTag,
  AssetTagAssignment,
} from '../shared/ipc/asset-library'
import { recoverAssetLibraryRestore } from './assetLibraryBackup'
import { AssetLibraryDatabase } from './assetLibraryDatabase'
import { AssetMetadataStore } from './assetMetadataStore'
import { recoverAssetMetadataTransaction } from './assetMetadataTransaction'
import {
  resolveAssetLibraryStorageMode,
  type AssetLibraryStorageMode,
} from './assetLibraryStorageConfig'
import { recoverJsonLinesTransaction } from './jsonLinesTransaction'
import { JsonLinesStore } from './vectorDatabaseService'

export interface ReferenceEmbeddingCacheRecord {
  id?: number
  assetId: number
  modelName: 'dinov2_vitb14'
  modifiedTime: number
  vector: number[]
  updatedAt: number
}

export interface AssetMetadataDeletionBundle {
  id?: number
  kind: 'category' | 'tag'
  name: string
  category?: AssetCategory
  tag?: AssetTag
  categoryAssignments: AssetCategoryAssignment[]
  tagAssignments: AssetTagAssignment[]
  references: AssetCategoryReference[]
  suggestions: AssetClassificationSuggestion[]
  deletedAt: number
  restoredAt?: number
}

export interface AssetLibraryStores {
  assets: AssetMetadataStore
  categories: JsonLinesStore<AssetCategory>
  tags: JsonLinesStore<AssetTag>
  categoryAssignments: JsonLinesStore<AssetCategoryAssignment>
  tagAssignments: JsonLinesStore<AssetTagAssignment>
  references: JsonLinesStore<AssetCategoryReference>
  suggestions: JsonLinesStore<AssetClassificationSuggestion>
  clusters: JsonLinesStore<AssetClusterGroup>
  clusterMembers: JsonLinesStore<AssetClusterMember>
  clusterLineage: JsonLinesStore<AssetClusterLineageEvent>
  referenceEmbeddings: JsonLinesStore<ReferenceEmbeddingCacheRecord>
  metadataDeletions: JsonLinesStore<AssetMetadataDeletionBundle>
  smartAlbums: JsonLinesStore<AssetSmartAlbum>
  collections: JsonLinesStore<AssetCollection>
  collectionItems: JsonLinesStore<AssetCollectionItem>
}

export interface AssetLibraryServiceInitOptions {
  /** Overrides env/settings for tests and diagnostics. */
  storageMode?: string
}

let baseDir = ''
let stores: AssetLibraryStores | null = null
let initializationError: Error | null = null
let storageMode: AssetLibraryStorageMode = 'jsonl'
let shadowDatabase: AssetLibraryDatabase | null = null
let sqliteWriteFailure: Error | null = null

const RELATION_JSONL_FILES = [
  'categories.jsonl',
  'tags.jsonl',
  'category_references.jsonl',
  'asset_categories.jsonl',
  'asset_tags.jsonl',
  'suggestions.jsonl',
  'cluster_groups.jsonl',
  'cluster_group_assets.jsonl',
  'metadata_deletion_trash.jsonl',
] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function getAssetLibraryBaseDir(): string {
  return baseDir
}

export function getAssetLibraryStorageMode(): AssetLibraryStorageMode {
  return storageMode
}

export function getAssetLibraryShadowDatabase(): AssetLibraryDatabase | null {
  return shadowDatabase
}

function closeShadowDatabase(): void {
  if (!shadowDatabase) return
  try {
    shadowDatabase.close()
  } catch (error) {
    console.warn(
      `[AssetLibrary] Could not close the SQLite shadow database: ${errorMessage(error)}`,
    )
  }
  shadowDatabase = null
}

export function closeAssetLibraryStorage(): void {
  closeShadowDatabase()
}

export function hasAssetLibraryInitializationError(): boolean {
  return initializationError !== null
}

function shadowReadDb(): AssetLibraryDatabase | null {
  return storageMode !== 'jsonl' && shadowDatabase && shadowDatabase.isOpen()
    ? shadowDatabase
    : null
}

export function withShadowRead<T>(read: (db: AssetLibraryDatabase) => T, fallback: () => T): T {
  const db = shadowReadDb()
  if (!db) return fallback()
  try {
    return read(db)
  } catch (error) {
    console.warn(
      `[AssetLibrary] SQLite relation read failed; falling back to JSONL stores: ${errorMessage(error)}`,
    )
    closeShadowDatabase()
    return fallback()
  }
}

export async function withShadowReadAsync<T>(
  read: (db: AssetLibraryDatabase) => T | Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  const db = shadowReadDb()
  if (!db) return fallback()
  try {
    return await read(db)
  } catch (error) {
    console.warn(
      `[AssetLibrary] SQLite relation read failed; falling back to JSONL stores: ${errorMessage(error)}`,
    )
    closeShadowDatabase()
    return fallback()
  }
}

export function sqliteWriteDb(): AssetLibraryDatabase | null {
  return storageMode === 'sqlite' && shadowDatabase && shadowDatabase.isOpen()
    ? shadowDatabase
    : null
}

export function withSqliteWrite<T>(fn: (db: AssetLibraryDatabase) => T): T {
  const db = sqliteWriteDb()
  if (!db) {
    throw (
      sqliteWriteFailure || new Error('Asset library SQLite storage is unavailable; write rejected')
    )
  }
  try {
    return db.transaction(() => fn(db))
  } catch (error) {
    sqliteWriteFailure = new Error(
      `SQLite relation write failed; SQLite storage is closed: ${errorMessage(error)}`,
    )
    closeShadowDatabase()
    console.error('[AssetLibrary] SQLite relation write failed:', error)
    throw sqliteWriteFailure
  }
}

function migrateRelationJsonlFiles(): void {
  for (const filename of RELATION_JSONL_FILES) {
    const source = path.join(baseDir, filename)
    const target = `${source}.migrated`
    try {
      if (!fs.existsSync(source)) continue
      if (fs.existsSync(target)) fs.unlinkSync(target)
      fs.renameSync(source, target)
    } catch (error) {
      console.warn(`[AssetLibrary] Could not mark ${filename} as migrated: ${errorMessage(error)}`)
    }
  }
}

function loadRelationMirrorFromSql(db: AssetLibraryDatabase): void {
  const current = requireAssetLibraryStores()
  current.categories.setMemoryOnly(true)
  current.categories.replaceAll(db.listCategories())
  current.tags.setMemoryOnly(true)
  current.tags.replaceAll(db.listTags())
  current.references.setMemoryOnly(true)
  current.references.replaceAll(db.listReferences())
  current.categoryAssignments.setMemoryOnly(true)
  current.categoryAssignments.replaceAll(db.listCategoryAssignments())
  current.tagAssignments.setMemoryOnly(true)
  current.tagAssignments.replaceAll(db.listTagAssignments())
  current.suggestions.setMemoryOnly(true)
  current.suggestions.replaceAll(db.listSuggestions())
  current.clusters.setMemoryOnly(true)
  current.clusters.replaceAll(db.listClusterGroups())
  current.clusterMembers.setMemoryOnly(true)
  current.clusterMembers.replaceAll(db.listClusterMembers())
  current.metadataDeletions.setMemoryOnly(true)
  current.metadataDeletions.replaceAll(
    db.listTrashBundles() as unknown as AssetMetadataDeletionBundle[],
  )
}

function clearStorage(): void {
  stores = null
  closeShadowDatabase()
  sqliteWriteFailure = null
  storageMode = 'jsonl'
}

export function markAssetLibraryStorageUnavailable(error: Error): void {
  clearStorage()
  initializationError = error
}

export function requireAssetLibraryStores(): AssetLibraryStores {
  if (initializationError) throw initializationError
  if (!stores) throw new Error('Asset library service is not initialized')
  return stores
}

export function initializeAssetLibraryStorage(
  userDataPath: string,
  options?: AssetLibraryServiceInitOptions,
): boolean {
  initializationError = null
  clearStorage()
  baseDir = path.join(userDataPath, 'asset-library')
  try {
    recoverAssetLibraryRestore(baseDir)
  } catch (error) {
    initializationError = new Error(
      `Asset library is unavailable because a pending backup restore could not be recovered: ${errorMessage(error)}`,
    )
    console.error('[AssetLibrary] Could not recover pending backup restore:', error)
    return false
  }
  try {
    recoverAssetMetadataTransaction(baseDir)
  } catch (error) {
    initializationError = new Error(
      `Asset library is unavailable because a pending asset metadata transaction could not be recovered: ${errorMessage(error)}`,
    )
    console.error('[AssetLibrary] Could not recover pending asset metadata transaction:', error)
    return false
  }
  try {
    recoverJsonLinesTransaction(baseDir)
  } catch (error) {
    initializationError = new Error(
      `Asset library is unavailable because a pending metadata transaction could not be recovered: ${errorMessage(error)}`,
    )
    console.error('[AssetLibrary] Could not recover pending JSONL transaction:', error)
    return false
  }
  storageMode = resolveAssetLibraryStorageMode(userDataPath, options?.storageMode)
  if (storageMode !== 'jsonl') {
    try {
      shadowDatabase = new AssetLibraryDatabase(baseDir)
      shadowDatabase.open()
      shadowDatabase.importFromJsonl()
      shadowDatabase.reconcileIdSequences()
      if (storageMode === 'sqlite') migrateRelationJsonlFiles()
    } catch (error) {
      console.warn(`[AssetLibrary] SQLite storage is unavailable: ${errorMessage(error)}`)
      closeShadowDatabase()
    }
  }
  const getBaseDir = () => baseDir
  stores = {
    assets: new AssetMetadataStore(baseDir),
    categories: new JsonLinesStore<AssetCategory>('categories.jsonl', getBaseDir),
    tags: new JsonLinesStore<AssetTag>('tags.jsonl', getBaseDir),
    categoryAssignments: new JsonLinesStore<AssetCategoryAssignment>(
      'asset_categories.jsonl',
      getBaseDir,
    ),
    tagAssignments: new JsonLinesStore<AssetTagAssignment>('asset_tags.jsonl', getBaseDir),
    references: new JsonLinesStore<AssetCategoryReference>('category_references.jsonl', getBaseDir),
    suggestions: new JsonLinesStore<AssetClassificationSuggestion>('suggestions.jsonl', getBaseDir),
    clusters: new JsonLinesStore<AssetClusterGroup>('cluster_groups.jsonl', getBaseDir),
    clusterMembers: new JsonLinesStore<AssetClusterMember>(
      'cluster_group_assets.jsonl',
      getBaseDir,
    ),
    clusterLineage: new JsonLinesStore<AssetClusterLineageEvent>(
      'cluster_lineage.jsonl',
      getBaseDir,
    ),
    referenceEmbeddings: new JsonLinesStore<ReferenceEmbeddingCacheRecord>(
      'reference_embeddings.jsonl',
      getBaseDir,
    ),
    metadataDeletions: new JsonLinesStore<AssetMetadataDeletionBundle>(
      'metadata_deletion_trash.jsonl',
      getBaseDir,
    ),
    smartAlbums: new JsonLinesStore<AssetSmartAlbum>('smart-albums.jsonl', getBaseDir, {
      maxRecords: 500,
      maxFileBytes: 2 * 1024 * 1024,
    }),
    collections: new JsonLinesStore<AssetCollection>('asset-collections.jsonl', getBaseDir, {
      maxRecords: 500,
      maxFileBytes: 2 * 1024 * 1024,
    }),
    collectionItems: new JsonLinesStore<AssetCollectionItem>(
      'asset-collection-items.jsonl',
      getBaseDir,
      { maxRecords: 50_000, maxFileBytes: 64 * 1024 * 1024 },
    ),
  }
  if (storageMode === 'sqlite' && shadowDatabase?.isOpen()) {
    try {
      loadRelationMirrorFromSql(shadowDatabase)
    } catch (error) {
      console.warn(`[AssetLibrary] Could not prime the relation mirror: ${errorMessage(error)}`)
      closeShadowDatabase()
    }
  }
  return true
}
