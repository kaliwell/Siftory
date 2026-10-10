import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import type {
  ImageSearchDataCatalogProgress,
  ImageSearchDataCatalogStartResult,
  ImageSearchDataCatalogState,
  ImageSearchDataFolder,
  ImageSearchDataFolderList,
  ImageSearchDataFolderQuery,
  ImageSearchDataOverview,
  ImageSearchDataStore,
  ImageSearchDataStoreFile,
} from '../shared/ipc-contract'
import { getImageSearchCatalogRevision, snapshotImageSearchData } from './imageSearchService'
import { normalizedImageDataPathKey } from './imageSearchDataPathUtils'
import type {
  ImageSearchCatalogNativeSource,
  ImageSearchCatalogNativeRecord,
  ImageSearchCatalogVectorSource,
  ImageSearchDataCatalogSummary,
  ImageSearchDataCatalogWorkerInput,
  ImageSearchDataCatalogWorkerMessage,
  ImageSearchDataCatalogWorkerResult,
} from './imageSearchDataCatalogTypes'

const CATALOG_ROOT_NAME = 'image-search-data-catalog'
const CURRENT_VERSION = 1
const STORE_FILE_LIMIT = 100
const INVENTORY_CACHE_MS = 10_000
const CATALOG_MIN_TEMPORARY_BYTES = 512 * 1024 * 1024
const CATALOG_FREE_SPACE_RESERVE = 256 * 1024 * 1024

interface PhysicalFile {
  fullPath: string
  relativePath: string
  sizeBytes: number
  modifiedAt: number
}

interface PhysicalSummary {
  files: PhysicalFile[]
  fileCount: number
  totalBytes: number
  lastModifiedAt?: number
  complete: boolean
}

interface StoreDefinition {
  id: string
  label: string
  layer: ImageSearchDataStore['layer']
  role: ImageSearchDataStore['role']
  pathCategory: string
  roots: string[]
  location: string
  rebuildable: boolean
  cleanupRisk: ImageSearchDataStore['cleanupRisk']
  detail?: string
}

interface CurrentCatalog {
  generation: string
  databasePath: string
  summary: ImageSearchDataCatalogSummary
  sourceSnapshot: string
  sourceRows: Array<{
    layer: string
    physicalKey: string
    recordCount: number
    uniqueCount: number
    malformedCount: number
    duplicateCount: number
  }>
}

interface InventoryCache {
  userDataPath: string
  expiresAt: number
  stores: ImageSearchDataStore[]
}

let inventoryCache: InventoryCache | null = null
let activeBuild: Promise<void> | null = null
let activeStopView: Int32Array | null = null
let cancelRequested = false
let progress: ImageSearchDataCatalogProgress = {
  state: 'idle',
  processedBytes: 0,
  totalBytes: 0,
  processedRecords: 0,
  nativeRecords: 0,
  dinoRecords: 0,
  clipRecords: 0,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

function catalogRoot(userDataPath: string): string {
  return path.join(path.resolve(userDataPath), CATALOG_ROOT_NAME)
}

function currentGenerationPointer(root: string): string | null {
  try {
    const pointerPath = path.join(root, 'CURRENT')
    const stat = fs.lstatSync(pointerPath)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as {
      version?: unknown
      generation?: unknown
    }
    return pointer.version === CURRENT_VERSION &&
      typeof pointer.generation === 'string' &&
      /^[a-zA-Z0-9._-]{1,96}$/.test(pointer.generation)
      ? pointer.generation
      : null
  } catch {
    return null
  }
}

async function ensureCatalogDiskSpace(
  userDataPath: string,
  nativeRecordCount: number,
  vectorBytes: number,
): Promise<void> {
  let availableBytes: number
  try {
    const stats = await fs.promises.statfs(path.resolve(userDataPath))
    availableBytes = Number(stats.bavail) * Number(stats.bsize)
  } catch {
    // Some supported filesystems do not expose statfs; SQLite still reports a
    // normal write error and the unreferenced staging directory is removed.
    return
  }
  const estimatedTemporaryBytes = Math.max(
    CATALOG_MIN_TEMPORARY_BYTES,
    nativeRecordCount * 512 + vectorBytes * 0.08,
  )
  const requiredBytes = estimatedTemporaryBytes + CATALOG_FREE_SPACE_RESERVE
  if (Number.isFinite(availableBytes) && availableBytes < requiredBytes) {
    const requiredMiB = Math.ceil(requiredBytes / (1024 * 1024))
    const availableMiB = Math.floor(availableBytes / (1024 * 1024))
    throw new Error(
      `Not enough disk space for the data catalog: about ${requiredMiB.toLocaleString()} MiB required, ${availableMiB.toLocaleString()} MiB available`,
    )
  }
}

export async function pruneCatalogGenerations(
  generationsRoot: string,
  keepGenerations: ReadonlySet<string>,
): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(generationsRoot, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        keepGenerations.has(entry.name) ||
        !/^\d{17}-[a-f0-9]{8}$/.test(entry.name)
      ) {
        return
      }
      const target = path.join(generationsRoot, entry.name)
      if (!isPathInside(generationsRoot, target)) return
      try {
        await fs.promises.rm(target, { recursive: true, force: true })
      } catch {
        // Old catalogs are derived data. A locked generation remains visible
        // in the store inventory and can be retried after the next refresh.
      }
    }),
  )
}

function updateProgress(update: Partial<ImageSearchDataCatalogProgress>): void {
  progress = { ...progress, ...update, updatedAt: Date.now() }
}

function relativePhysicalKey(userDataPath: string, filePath: string): string {
  return path.relative(path.resolve(userDataPath), path.resolve(filePath)).replace(/\\/g, '/')
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!path.isAbsolute(relative) && !relative.startsWith('..'))
}

async function matchingFiles(
  directory: string,
  predicate: (name: string) => boolean,
): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && predicate(entry.name))
      .map((entry) => path.join(directory, entry.name))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function collectPhysicalFiles(
  userDataPath: string,
  roots: readonly string[],
): Promise<PhysicalSummary> {
  const files: PhysicalFile[] = []
  const directories: string[] = []
  const candidateDirectories: string[] = []
  const candidateFiles: string[] = []
  let fileCount = 0
  let totalBytes = 0
  let lastModifiedAt: number | undefined
  let complete = true

  const compareFiles = (left: PhysicalFile, right: PhysicalFile) =>
    right.sizeBytes - left.sizeBytes || left.relativePath.localeCompare(right.relativePath)

  const retainLargeFile = (file: PhysicalFile) => {
    files.push(file)
    // The overview exposes only the largest bounded sample. Periodic pruning
    // avoids retaining and sorting every thumbnail or preview in a large cache.
    if (files.length >= STORE_FILE_LIMIT * 2) {
      files.sort(compareFiles)
      files.length = STORE_FILE_LIMIT
    }
  }

  const addFile = async (filePath: string) => {
    const resolved = path.resolve(filePath)
    if (!isPathInside(userDataPath, resolved)) return
    try {
      const stat = await fs.promises.lstat(resolved)
      if (!stat.isFile() || stat.isSymbolicLink()) return
      const file = {
        fullPath: resolved,
        relativePath: relativePhysicalKey(userDataPath, resolved),
        sizeBytes: stat.size,
        modifiedAt: stat.mtimeMs,
      }
      fileCount++
      totalBytes += file.sizeBytes
      if (!lastModifiedAt || file.modifiedAt > lastModifiedAt) lastModifiedAt = file.modifiedAt
      retainLargeFile(file)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false
    }
  }

  let trustedRoot: string
  try {
    trustedRoot = await fs.promises.realpath(path.resolve(userDataPath))
  } catch {
    return { files: [], fileCount: 0, totalBytes: 0, complete: false }
  }

  const seenRoots = new Set<string>()
  for (const root of roots) {
    const resolved = path.resolve(root)
    const rootKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (!isPathInside(userDataPath, resolved) || seenRoots.has(rootKey)) continue
    seenRoots.add(rootKey)
    try {
      const stat = await fs.promises.lstat(resolved)
      if (stat.isSymbolicLink()) {
        complete = false
        continue
      }
      const real = await fs.promises.realpath(resolved)
      if (!isPathInside(trustedRoot, real)) {
        complete = false
        continue
      }
      if (stat.isFile()) candidateFiles.push(real)
      else if (stat.isDirectory()) candidateDirectories.push(real)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false
    }
  }

  // Registry roots are few. Remove nested roots up front so the traversal is
  // exact without retaining an O(N) set of every discovered file path.
  candidateDirectories.sort((left, right) => left.length - right.length)
  for (const directory of candidateDirectories) {
    if (directories.some((parent) => isPathInside(parent, directory))) continue
    directories.push(directory)
  }
  for (const filePath of candidateFiles) {
    if (!directories.some((directory) => isPathInside(directory, filePath))) {
      await addFile(filePath)
    }
  }

  while (directories.length > 0) {
    const directory = directories.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true })
    } catch {
      complete = false
      continue
    }
    const directFiles: string[] = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) directories.push(target)
      else if (entry.isFile()) directFiles.push(target)
    }
    for (let offset = 0; offset < directFiles.length; offset += 64) {
      await Promise.all(directFiles.slice(offset, offset + 64).map(addFile))
    }
  }

  files.sort(compareFiles)
  files.length = Math.min(files.length, STORE_FILE_LIMIT)
  return {
    files,
    fileCount,
    totalBytes,
    lastModifiedAt,
    complete,
  }
}

async function storeDefinitions(userDataPath: string): Promise<StoreDefinition[]> {
  const userData = path.resolve(userDataPath)
  const vectorDb = path.join(userData, 'vector-db')
  const embeddings = path.join(vectorDb, 'embeddings')
  const embeddingFiles = await matchingFiles(embeddings, (name) =>
    name.toLowerCase().endsWith('.jsonl'),
  )
  const legacyEmbedding = path.join(vectorDb, 'image_embeddings.jsonl')
  const dino = embeddingFiles.filter((file) => path.basename(file).toLowerCase().includes('dino'))
  const clip = embeddingFiles.filter((file) => path.basename(file).toLowerCase().includes('clip'))
  const other = [
    ...embeddingFiles.filter((file) => !dino.includes(file) && !clip.includes(file)),
    legacyEmbedding,
  ]
  const recovery = await matchingFiles(embeddings, (name) =>
    /(?:\.gc-backup-|\.folder-edit-|\.bak$|\.tmp$)/i.test(name),
  )
  const logs = await matchingFiles(userData, (name) => name.startsWith('image-search-scan.log'))
  const diagnosticFiles = await matchingFiles(vectorDb, (name) =>
    /^(?:embedding_failures|embedding_diagnostics)\.jsonl(?:\.|$)/i.test(name),
  )
  return [
    {
      id: 'native-index',
      label: 'Native hash index',
      layer: 'native',
      role: 'authoritative',
      pathCategory: 'Image Search / authoritative index',
      roots: [path.join(userData, 'image-search-index')],
      location: path.join(userData, 'image-search-index'),
      rebuildable: true,
      cleanupRisk: 'high',
      detail: 'Active manifest, segments, overlays, and staging files.',
    },
    {
      id: 'dino-authoritative',
      label: 'DINO embeddings',
      layer: 'dino',
      role: 'authoritative',
      pathCategory: 'Vectors / authoritative DINO JSONL',
      roots: dino,
      location: embeddings,
      rebuildable: true,
      cleanupRisk: 'high',
    },
    {
      id: 'clip-authoritative',
      label: 'CLIP embeddings',
      layer: 'clip',
      role: 'authoritative',
      pathCategory: 'Vectors / authoritative CLIP JSONL',
      roots: clip,
      location: embeddings,
      rebuildable: true,
      cleanupRisk: 'high',
    },
    {
      id: 'other-vector-authoritative',
      label: 'Other embedding stores',
      layer: 'shared',
      role: 'authoritative',
      pathCategory: 'Vectors / legacy or unclassified JSONL',
      roots: other,
      location: vectorDb,
      rebuildable: true,
      cleanupRisk: 'high',
      detail: 'Legacy or model stores whose layer cannot be inferred from the file name.',
    },
    {
      id: 'vector-derived-cache',
      label: 'Vector caches and ANN indexes',
      layer: 'shared',
      role: 'derived',
      pathCategory: 'Vectors / derived caches',
      roots: [
        path.join(vectorDb, 'embedding-cache'),
        path.join(vectorDb, 'clip_embedding_cache.f32'),
        path.join(vectorDb, 'clip_embedding_cache.json'),
        path.join(vectorDb, 'clip_embedding_paths.jsonl'),
        path.join(vectorDb, 'vector_index_manifest.json'),
        path.join(vectorDb, 'vector-store'),
      ],
      location: vectorDb,
      rebuildable: true,
      cleanupRisk: 'medium',
    },
    {
      id: 'thumbnail-cache',
      label: 'Optimized thumbnails',
      layer: 'native',
      role: 'derived',
      pathCategory: 'Image Search / derived thumbnails',
      roots: [path.join(userData, 'thumbcache')],
      location: path.join(userData, 'thumbcache'),
      rebuildable: true,
      cleanupRisk: 'low',
    },
    {
      id: 'project-preview-cache',
      label: 'Project previews',
      layer: 'native',
      role: 'derived',
      pathCategory: 'Image Search / project preview cache',
      roots: [path.join(userData, 'project-previews')],
      location: path.join(userData, 'project-previews'),
      rebuildable: true,
      cleanupRisk: 'medium',
    },
    {
      id: 'embedding-jobs',
      label: 'Embedding jobs',
      layer: 'shared',
      role: 'maintenance',
      pathCategory: 'Maintenance / embedding jobs',
      roots: [path.join(vectorDb, 'embedding_jobs.jsonl')],
      location: vectorDb,
      rebuildable: false,
      cleanupRisk: 'high',
    },
    {
      id: 'vector-diagnostics',
      label: 'Vector failures and diagnostics',
      layer: 'shared',
      role: 'maintenance',
      pathCategory: 'Maintenance / vector diagnostics',
      roots: diagnosticFiles,
      location: vectorDb,
      rebuildable: false,
      cleanupRisk: 'medium',
    },
    {
      id: 'image-search-logs',
      label: 'Image Search logs',
      layer: 'native',
      role: 'maintenance',
      pathCategory: 'Image Search / logs',
      roots: logs,
      location: userData,
      rebuildable: false,
      cleanupRisk: 'low',
    },
    {
      id: 'vector-recovery',
      label: 'Vector recovery files',
      layer: 'shared',
      role: 'recovery',
      pathCategory: 'Vectors / recovery and interrupted writes',
      roots: recovery,
      location: embeddings,
      rebuildable: false,
      cleanupRisk: 'medium',
    },
    {
      id: 'data-catalog',
      label: 'Data Editor catalog',
      layer: 'shared',
      role: 'catalog',
      pathCategory: 'Image Search / derived data catalog',
      roots: [catalogRoot(userData)],
      location: catalogRoot(userData),
      rebuildable: true,
      cleanupRisk: 'low',
    },
    {
      id: 'query-temp',
      label: 'Temporary query images',
      layer: 'shared',
      role: 'maintenance',
      pathCategory: 'Image Search / temporary queries',
      roots: [path.join(userData, 'image-search-queries')],
      location: path.join(userData, 'image-search-queries'),
      rebuildable: false,
      cleanupRisk: 'low',
    },
  ]
}

function publicStoreFile(file: PhysicalFile): ImageSearchDataStoreFile {
  return {
    id: crypto.createHash('sha256').update(file.relativePath).digest('hex').slice(0, 20),
    name: path.basename(file.fullPath),
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt,
  }
}

async function buildStoreInventory(userDataPath: string): Promise<ImageSearchDataStore[]> {
  const resolved = path.resolve(userDataPath)
  if (
    inventoryCache &&
    inventoryCache.userDataPath === resolved &&
    inventoryCache.expiresAt > Date.now()
  ) {
    return inventoryCache.stores
  }
  const definitions = await storeDefinitions(resolved)
  const stores = await Promise.all(
    definitions.map(async (definition): Promise<ImageSearchDataStore> => {
      const summary = await collectPhysicalFiles(resolved, definition.roots)
      return {
        id: definition.id,
        label: definition.label,
        layer: definition.layer,
        role: definition.role,
        pathCategory: definition.pathCategory,
        fileCount: summary.fileCount,
        totalBytes: summary.totalBytes,
        lastModifiedAt: summary.lastModifiedAt,
        rebuildable: definition.rebuildable,
        cleanupRisk: definition.cleanupRisk,
        freshness: definition.role === 'authoritative' ? 'current' : 'not-applicable',
        inventoryComplete: summary.complete,
        filesTruncated: summary.fileCount > STORE_FILE_LIMIT,
        files: summary.files.map(publicStoreFile),
        detail: definition.detail,
      }
    }),
  )
  stores.sort(
    (left, right) => right.totalBytes - left.totalBytes || left.label.localeCompare(right.label),
  )
  inventoryCache = {
    userDataPath: resolved,
    expiresAt: Date.now() + INVENTORY_CACHE_MS,
    stores,
  }
  return stores
}

async function sampleFileFingerprint(filePath: string, sizeBytes: number): Promise<string> {
  const sampleBytes = 64 * 1024
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const hash = crypto.createHash('sha256')
    hash.update(String(sizeBytes))
    const firstLength = Math.min(sampleBytes, sizeBytes)
    if (firstLength > 0) {
      const first = Buffer.allocUnsafe(firstLength)
      const read = await handle.read(first, 0, firstLength, 0)
      hash.update(first.subarray(0, read.bytesRead))
    }
    if (sizeBytes > firstLength) {
      const lastLength = Math.min(sampleBytes, sizeBytes - firstLength)
      const last = Buffer.allocUnsafe(lastLength)
      const read = await handle.read(last, 0, lastLength, sizeBytes - lastLength)
      hash.update(last.subarray(0, read.bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

async function authoritativeVectorSources(
  userDataPath: string,
): Promise<ImageSearchCatalogVectorSource[]> {
  const resolvedUserData = path.resolve(userDataPath)
  const trustedRoot = await fs.promises.realpath(resolvedUserData)
  const vectorDb = path.join(resolvedUserData, 'vector-db')
  const embeddings = path.join(vectorDb, 'embeddings')
  let embeddingFiles: string[] = []
  try {
    const stat = await fs.promises.lstat(embeddings)
    const realEmbeddings = await fs.promises.realpath(embeddings)
    if (stat.isDirectory() && !stat.isSymbolicLink() && isPathInside(trustedRoot, realEmbeddings)) {
      embeddingFiles = await matchingFiles(realEmbeddings, (name) =>
        name.toLowerCase().endsWith('.jsonl'),
      )
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const candidates = [...embeddingFiles, path.join(vectorDb, 'image_embeddings.jsonl')]
  const sources: ImageSearchCatalogVectorSource[] = []
  for (const filePath of [...new Set(candidates.map((candidate) => path.resolve(candidate)))]) {
    try {
      const stat = await fs.promises.lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      const realFile = await fs.promises.realpath(filePath)
      if (!isPathInside(trustedRoot, realFile)) continue
      const name = path.basename(realFile).toLowerCase()
      const layer = name.includes('dino') ? 'dino' : name.includes('clip') ? 'clip' : 'mixed'
      const physicalKey = relativePhysicalKey(trustedRoot, realFile)
      const sampleSha256 = await sampleFileFingerprint(realFile, stat.size)
      sources.push({
        sourceId: `vector-${crypto.createHash('sha256').update(physicalKey).digest('hex').slice(0, 16)}`,
        filePath: realFile,
        physicalKey,
        logicalName: physicalKey,
        layer,
        sizeBytes: stat.size,
        modifiedAt: stat.mtimeMs,
        sampleSha256,
      })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return sources.sort((left, right) => left.physicalKey.localeCompare(right.physicalKey))
}

function sourceSnapshot(nativeRevision: string, sources: ImageSearchCatalogVectorSource[]): string {
  return JSON.stringify({
    version: CURRENT_VERSION,
    nativeRevision,
    vectors: sources.map((source) => ({
      physicalKey: source.physicalKey,
      layer: source.layer,
      sizeBytes: source.sizeBytes,
      modifiedAt: source.modifiedAt,
      sampleSha256: source.sampleSha256,
    })),
  })
}

function readCurrentCatalog(userDataPath: string): CurrentCatalog | null {
  const root = catalogRoot(userDataPath)
  try {
    const generation = currentGenerationPointer(root)
    if (!generation) return null
    const generationDir = path.join(root, 'generations', generation)
    const databasePath = path.join(generationDir, 'catalog.sqlite')
    if (!isPathInside(path.join(root, 'generations'), databasePath)) return null
    const generationStat = fs.lstatSync(generationDir)
    const databaseStat = fs.lstatSync(databasePath)
    if (
      !generationStat.isDirectory() ||
      generationStat.isSymbolicLink() ||
      !databaseStat.isFile() ||
      databaseStat.isSymbolicLink()
    ) {
      return null
    }
    const realRoot = fs.realpathSync(root)
    const realDatabasePath = fs.realpathSync(databasePath)
    if (!isPathInside(realRoot, realDatabasePath)) return null
    const database = new DatabaseSync(realDatabasePath, { readOnly: true })
    try {
      const rows = database
        .prepare('SELECT key, value FROM catalog_meta')
        .all() as unknown as Array<{
        key: string
        value: string
      }>
      const meta = new Map(rows.map((row) => [row.key, row.value]))
      const summary = JSON.parse(meta.get('summary') || '{}') as ImageSearchDataCatalogSummary
      if (summary.generation !== generation) return null
      const sourceRows = database
        .prepare(
          `SELECT layer, physical_key, record_count, unique_count, malformed_count, duplicate_count
           FROM source_files`,
        )
        .all() as unknown as Array<Record<string, unknown>>
      return {
        generation,
        databasePath,
        summary,
        sourceSnapshot: meta.get('source_snapshot') || '',
        sourceRows: sourceRows.map((row) => ({
          layer: String(row.layer || ''),
          physicalKey: String(row.physical_key || ''),
          recordCount: Number(row.record_count) || 0,
          uniqueCount: Number(row.unique_count) || 0,
          malformedCount: Number(row.malformed_count) || 0,
          duplicateCount: Number(row.duplicate_count) || 0,
        })),
      }
    } finally {
      database.close()
    }
  } catch {
    return null
  }
}

function activeCatalogState(
  current: CurrentCatalog | null,
  stale: boolean,
): ImageSearchDataCatalogState {
  if (progress.state === 'collecting' || progress.state === 'building') return 'building'
  if (progress.state === 'cancelling') return 'cancelling'
  if (!current) return progress.state === 'error' ? 'error' : 'no-catalog'
  return stale ? 'stale' : 'ready'
}

function enrichStores(
  stores: ImageSearchDataStore[],
  current: CurrentCatalog | null,
  stale: boolean,
): ImageSearchDataStore[] {
  const totalsForLayer = (layer: string) =>
    (current?.sourceRows || [])
      .filter((row) => row.layer === layer)
      .reduce(
        (sum, row) => ({
          recordCount: sum.recordCount + row.recordCount,
          uniqueCount: sum.uniqueCount + row.uniqueCount,
          malformedCount: sum.malformedCount + row.malformedCount,
          duplicateCount: sum.duplicateCount + row.duplicateCount,
        }),
        { recordCount: 0, uniqueCount: 0, malformedCount: 0, duplicateCount: 0 },
      )
  return stores.map((store) => {
    const layer =
      store.id === 'native-index'
        ? 'native'
        : store.id === 'dino-authoritative'
          ? 'dino'
          : store.id === 'clip-authoritative'
            ? 'clip'
            : store.id === 'other-vector-authoritative'
              ? 'shared'
              : ''
    if (!layer) {
      return store.id === 'data-catalog'
        ? { ...store, freshness: current ? (stale ? 'stale' : 'current') : 'unknown' }
        : store
    }
    const totals = totalsForLayer(layer)
    const layerUniqueCount =
      layer === 'native'
        ? current?.summary.nativeUniqueCount
        : layer === 'dino'
          ? current?.summary.dinoUniqueCount
          : layer === 'clip'
            ? current?.summary.clipUniqueCount
            : totals.uniqueCount
    return {
      ...store,
      freshness: current ? (stale ? 'stale' : 'current') : 'unknown',
      ...(current
        ? {
            recordCount: totals.recordCount,
            uniqueCount: layerUniqueCount || 0,
            malformedCount: totals.malformedCount,
            duplicateCount: totals.duplicateCount,
          }
        : {}),
    }
  })
}

export async function getImageSearchDataOverview(
  userDataPath: string,
): Promise<ImageSearchDataOverview> {
  try {
    const [stores, vectorSources] = await Promise.all([
      buildStoreInventory(userDataPath),
      authoritativeVectorSources(userDataPath),
    ])
    const current = readCurrentCatalog(userDataPath)
    const currentSnapshot = sourceSnapshot(getImageSearchCatalogRevision(), vectorSources)
    const stale = Boolean(current && current.sourceSnapshot !== currentSnapshot)
    const summary = current?.summary
    const enriched = enrichStores(stores, current, stale)
    return {
      ok: true,
      catalogState: activeCatalogState(current, stale),
      stores: enriched,
      totalBytes: enriched.reduce((sum, store) => sum + store.totalBytes, 0),
      authoritativeBytes: enriched
        .filter((store) => store.role === 'authoritative')
        .reduce((sum, store) => sum + store.totalBytes, 0),
      generation: current?.generation,
      builtAt: summary?.builtAt,
      unionPathCount: summary?.unionPathCount || 0,
      nativeUniqueCount: summary?.nativeUniqueCount || 0,
      dinoUniqueCount: summary?.dinoUniqueCount || 0,
      clipUniqueCount: summary?.clipUniqueCount || 0,
      completeCount: summary?.completeCount || 0,
      missingDinoCount: summary?.missingDinoCount || 0,
      missingClipCount: summary?.missingClipCount || 0,
      vectorOnlyCount: summary?.vectorOnlyCount || 0,
      duplicateRows: summary?.duplicateRows || 0,
      malformedRows: summary?.malformedRows || 0,
      folderCount: summary?.folderCount || 0,
      error: progress.state === 'error' ? progress.error : undefined,
    }
  } catch (error) {
    return {
      ok: false,
      catalogState: 'error',
      stores: [],
      totalBytes: 0,
      authoritativeBytes: 0,
      unionPathCount: 0,
      nativeUniqueCount: 0,
      dinoUniqueCount: 0,
      clipUniqueCount: 0,
      completeCount: 0,
      missingDinoCount: 0,
      missingClipCount: 0,
      vectorOnlyCount: 0,
      duplicateRows: 0,
      malformedRows: 0,
      folderCount: 0,
      error: errorMessage(error),
    }
  }
}

async function collectNativeRecords(): Promise<ImageSearchCatalogNativeRecord[]> {
  if (cancelRequested) throw new Error('Image Search data catalog build cancelled')
  updateProgress({ stage: 'native', message: 'Taking a linear Native index snapshot' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const snapshot = await snapshotImageSearchData(() => cancelRequested)
  if (!snapshot.ok) {
    throw new Error(snapshot.error || 'Unable to export the Native Image Search index')
  }
  if (cancelRequested) throw new Error('Image Search data catalog build cancelled')
  const records = snapshot.records || []
  updateProgress({
    stage: 'native',
    nativeRecords: records.length,
    processedRecords: records.length,
    message: `Read Native index ${records.length.toLocaleString()}`,
  })
  return records
}

function dataCatalogWorkerPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'imageSearchDataCatalogWorker.js')
  const local = path.join(__dirname, 'imageSearchDataCatalogWorker.js')
  if (fs.existsSync(local)) return local
  return path.join(__dirname, '..', 'dist-electron', 'imageSearchDataCatalogWorker.js')
}

function runCatalogWorker(
  input: ImageSearchDataCatalogWorkerInput,
): Promise<ImageSearchDataCatalogWorkerResult> {
  return new Promise((resolve, reject) => {
    const stopBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const stopView = new Int32Array(stopBuffer)
    activeStopView = stopView
    if (cancelRequested) Atomics.store(stopView, 0, 1)
    let settled = false
    let worker: Worker
    try {
      worker = new Worker(dataCatalogWorkerPath(), {
        workerData: { input, stopBuffer },
      })
      // Worker construction synchronously clones workerData. The main process
      // no longer needs hundreds of thousands of Native record objects while
      // the vector scan runs, so release those references immediately.
      input.nativeRecords.length = 0
    } catch (error) {
      if (activeStopView === stopView) activeStopView = null
      reject(error)
      return
    }
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      if (activeStopView === stopView) activeStopView = null
      finish()
    }
    worker.on('message', (message: ImageSearchDataCatalogWorkerMessage) => {
      if (message.type === 'progress') {
        updateProgress({ state: cancelRequested ? 'cancelling' : 'building', ...message.progress })
        return
      }
      if (message.type === 'result') {
        settle(() => resolve(message.result))
        return
      }
      if (message.type === 'stopped') {
        settle(() => reject(new Error('Image Search data catalog build cancelled')))
        return
      }
      settle(() => reject(new Error(message.error)))
    })
    worker.once('error', (error) => settle(() => reject(error)))
    worker.once('exit', (code) => {
      if (!settled) settle(() => reject(new Error(`Data catalog worker exited (${code})`)))
    })
  })
}

async function nativeSourceSummary(userDataPath: string): Promise<ImageSearchCatalogNativeSource> {
  const root = path.join(path.resolve(userDataPath), 'image-search-index')
  const summary = await collectPhysicalFiles(userDataPath, [root])
  return {
    sourceId: 'native-index',
    physicalKey: 'image-search-index',
    logicalName: 'image-search-index',
    sizeBytes: summary.totalBytes,
    modifiedAt: summary.lastModifiedAt || 0,
  }
}

async function executeCatalogBuild(
  userDataPath: string,
  roots: string[],
  taskId: string,
): Promise<void> {
  const resolvedUserData = path.resolve(userDataPath)
  const root = catalogRoot(resolvedUserData)
  const generationsRoot = path.join(root, 'generations')
  const previousGeneration = currentGenerationPointer(root)
  const previousCatalog = readCurrentCatalog(resolvedUserData)
  const generation = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto
    .randomBytes(4)
    .toString('hex')}`
  const staging = path.join(generationsRoot, `.${generation}.tmp`)
  const finalDirectory = path.join(generationsRoot, generation)
  let stagingCreated = false
  try {
    const revisionBefore = getImageSearchCatalogRevision()
    const [vectorsBefore, nativeSource, nativeRecords] = await Promise.all([
      authoritativeVectorSources(resolvedUserData),
      nativeSourceSummary(resolvedUserData),
      collectNativeRecords(),
    ])
    if (cancelRequested) throw new Error('Image Search data catalog build cancelled')
    const revisionAfterNative = getImageSearchCatalogRevision()
    if (revisionBefore !== revisionAfterNative) {
      throw new Error('Native Image Search index changed during catalog export; retry analysis')
    }
    const vectorsAfterNative = await authoritativeVectorSources(resolvedUserData)
    const snapshot = sourceSnapshot(revisionAfterNative, vectorsAfterNative)
    if (sourceSnapshot(revisionAfterNative, vectorsBefore) !== snapshot) {
      throw new Error('Embedding sources changed before catalog analysis; retry analysis')
    }
    await ensureCatalogDiskSpace(
      resolvedUserData,
      nativeRecords.length,
      vectorsAfterNative.reduce((sum, source) => sum + source.sizeBytes, 0),
    )

    fs.mkdirSync(generationsRoot, { recursive: true })
    fs.mkdirSync(staging, { recursive: false })
    stagingCreated = true
    updateProgress({
      state: 'building',
      stage: 'dino',
      totalBytes: vectorsAfterNative.reduce((sum, source) => sum + source.sizeBytes, 0),
      processedBytes: 0,
      processedRecords: nativeRecords.length,
      nativeRecords: nativeRecords.length,
      message: 'Starting DINO/CLIP catalog worker',
    })
    const result = await runCatalogWorker({
      taskId,
      generation,
      databasePath: path.join(staging, 'catalog.sqlite'),
      buildMetadataPath: path.join(staging, 'build.json'),
      roots,
      nativeRecords,
      nativeSource,
      vectorSources: vectorsAfterNative,
      sourceSnapshot: snapshot,
      previousDatabasePath: previousCatalog?.databasePath,
    })
    if (cancelRequested) throw new Error('Image Search data catalog build cancelled')
    updateProgress({ state: 'building', stage: 'switch', message: 'Switching catalog snapshot' })
    const finalRevision = getImageSearchCatalogRevision()
    const finalVectors = await authoritativeVectorSources(resolvedUserData)
    if (sourceSnapshot(finalRevision, finalVectors) !== snapshot) {
      throw new Error('Index data changed during catalog analysis; the old snapshot remains active')
    }
    fs.renameSync(staging, finalDirectory)
    stagingCreated = false
    const currentTemp = path.join(root, `CURRENT.${taskId}.tmp`)
    fs.writeFileSync(
      currentTemp,
      JSON.stringify(
        {
          version: CURRENT_VERSION,
          generation: result.generation,
          switchedAt: Date.now(),
        },
        null,
        2,
      ),
      { encoding: 'utf8', flag: 'wx' },
    )
    fs.renameSync(currentTemp, path.join(root, 'CURRENT'))
    await pruneCatalogGenerations(
      generationsRoot,
      new Set([generation, previousGeneration].filter((item): item is string => Boolean(item))),
    )
    inventoryCache = null
    updateProgress({
      state: 'completed',
      stage: 'switch',
      processedBytes: progress.totalBytes,
      processedRecords:
        result.summary.nativeUniqueCount +
        result.summary.dinoUniqueCount +
        result.summary.clipUniqueCount,
      nativeRecords: result.summary.nativeUniqueCount,
      dinoRecords: result.summary.dinoUniqueCount,
      clipRecords: result.summary.clipUniqueCount,
      message: 'Data catalog is ready',
      finishedAt: Date.now(),
    })
  } catch (error) {
    const cancelled = cancelRequested || /cancelled/i.test(errorMessage(error))
    updateProgress({
      state: cancelled ? 'cancelled' : 'error',
      error: cancelled ? undefined : errorMessage(error),
      message: cancelled ? 'Data catalog build cancelled' : undefined,
      finishedAt: Date.now(),
    })
  } finally {
    if (stagingCreated && isPathInside(generationsRoot, staging)) {
      try {
        fs.rmSync(staging, { recursive: true, force: true })
      } catch {
        // An unreferenced staging generation is ignored on the next launch.
      }
    }
  }
}

export function startImageSearchDataCatalogBuild(
  userDataPath: string,
  roots: string[],
): ImageSearchDataCatalogStartResult {
  if (activeBuild) return { ok: false, error: 'A data catalog analysis is already running' }
  const taskId = randomId('image-search-data-catalog')
  cancelRequested = false
  progress = {
    taskId,
    state: 'collecting',
    stage: 'inventory',
    processedBytes: 0,
    totalBytes: 0,
    processedRecords: 0,
    nativeRecords: 0,
    dinoRecords: 0,
    clipRecords: 0,
    message: 'Collecting Image Search data sources',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  activeBuild = executeCatalogBuild(userDataPath, roots, taskId).finally(() => {
    activeBuild = null
    activeStopView = null
  })
  return { ok: true, taskId }
}

export function getImageSearchDataCatalogProgress(): ImageSearchDataCatalogProgress {
  return { ...progress }
}

export function cancelImageSearchDataCatalogBuild(): { ok: boolean } {
  if (activeBuild) {
    cancelRequested = true
    updateProgress({ state: 'cancelling', message: 'Cancelling data catalog analysis' })
    if (activeStopView) Atomics.store(activeStopView, 0, 1)
  }
  return { ok: true }
}

export function isImageSearchDataCatalogBuildRunning(): boolean {
  return Boolean(activeBuild)
}

export async function shutdownImageSearchDataCatalogForQuit(): Promise<void> {
  const pending = activeBuild
  if (!pending) return
  cancelImageSearchDataCatalogBuild()
  await Promise.race([
    pending,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000)
      timer.unref?.()
    }),
  ])
}

function safeFolderQuery(raw: ImageSearchDataFolderQuery | undefined): Required<
  Pick<ImageSearchDataFolderQuery, 'query' | 'onlyAnomalies' | 'offset' | 'limit'>
> & {
  parent: string | null
} {
  const query = typeof raw?.query === 'string' ? raw.query.trim().slice(0, 1024) : ''
  const parentValue = typeof raw?.parent === 'string' ? raw.parent.trim().slice(0, 1024) : ''
  const rawOffset = Number(raw?.offset)
  const offset = Number.isFinite(rawOffset)
    ? Math.max(0, Math.min(2_147_483_647, Math.floor(rawOffset)))
    : 0
  return {
    parent: parentValue || null,
    query,
    onlyAnomalies: raw?.onlyAnomalies === true,
    offset,
    limit: Math.max(1, Math.min(200, Math.floor(Number(raw?.limit) || 100))),
  }
}

export function listImageSearchDataFolders(
  userDataPath: string,
  rawRequest?: ImageSearchDataFolderQuery,
): ImageSearchDataFolderList {
  const request = safeFolderQuery(rawRequest)
  const current = readCurrentCatalog(userDataPath)
  if (!current) {
    return {
      ok: false,
      catalogState: isImageSearchDataCatalogBuildRunning() ? 'building' : 'no-catalog',
      records: [],
      offset: request.offset,
      total: 0,
      hasMore: false,
      error: 'Build the Image Search data catalog first',
    }
  }
  try {
    const database = new DatabaseSync(current.databasePath, { readOnly: true })
    try {
      const conditions: string[] = []
      const parameters: Array<string | number> = []
      if (request.query) {
        const escaped = request.query.replace(/[!%_]/g, (value) => `!${value}`)
        conditions.push("f.display_path LIKE ? ESCAPE '!' COLLATE NOCASE")
        parameters.push(`%${escaped}%`)
      } else if (request.parent) {
        conditions.push('f.parent_key = ?')
        parameters.push(normalizedImageDataPathKey(request.parent))
      } else {
        conditions.push('f.parent_key IS NULL')
      }
      if (request.onlyAnomalies) {
        conditions.push(
          '(f.missing_dino + f.missing_clip + f.vector_only + f.duplicate_rows + f.malformed_rows) > 0',
        )
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const countRow = database
        .prepare(`SELECT COUNT(*) AS total FROM folder_rollups f ${where}`)
        .get(...parameters) as Record<string, unknown> | undefined
      const total = Number(countRow?.total) || 0
      const rows = database
        .prepare(
          `SELECT f.*, parent.display_path AS parent_display
           FROM folder_rollups f
           LEFT JOIN folder_rollups parent ON parent.folder_key = f.parent_key
           ${where}
           ORDER BY
             CASE WHEN ? = 1 THEN
               f.missing_dino + f.missing_clip + f.vector_only + f.duplicate_rows + f.malformed_rows
             ELSE 0 END DESC,
             f.name COLLATE NOCASE,
             f.display_path COLLATE NOCASE
           LIMIT ? OFFSET ?`,
        )
        .all(
          ...parameters,
          request.onlyAnomalies ? 1 : 0,
          request.limit,
          request.offset,
        ) as unknown as Array<Record<string, unknown>>
      const records: ImageSearchDataFolder[] = rows.map((row) => ({
        folder: String(row.display_path || ''),
        parent: row.parent_display ? String(row.parent_display) : undefined,
        name: String(row.name || ''),
        depth: Number(row.depth) || 0,
        childCount: Number(row.child_count) || 0,
        nativeCount: Number(row.native_count) || 0,
        dinoCount: Number(row.dino_count) || 0,
        clipCount: Number(row.clip_count) || 0,
        nativeOnly: Number(row.native_only) || 0,
        dinoOnly: Number(row.dino_only) || 0,
        clipOnly: Number(row.clip_only) || 0,
        missingDino: Number(row.missing_dino) || 0,
        missingClip: Number(row.missing_clip) || 0,
        vectorOnly: Number(row.vector_only) || 0,
        duplicateRows: Number(row.duplicate_rows) || 0,
        malformedRows: Number(row.malformed_rows) || 0,
        matchedBytes: Number(row.matched_bytes) || 0,
      }))
      return {
        ok: true,
        catalogState: isImageSearchDataCatalogBuildRunning() ? 'building' : 'ready',
        generation: current.generation,
        parent: request.parent,
        records,
        offset: request.offset,
        total,
        hasMore: request.offset + records.length < total,
      }
    } finally {
      database.close()
    }
  } catch (error) {
    return {
      ok: false,
      catalogState: 'error',
      generation: current.generation,
      parent: request.parent,
      records: [],
      offset: request.offset,
      total: 0,
      hasMore: false,
      error: errorMessage(error),
    }
  }
}

export async function resolveImageSearchDataStoreLocation(
  userDataPath: string,
  storeId: string,
): Promise<string | null> {
  if (!/^[a-z0-9-]{1,64}$/.test(storeId)) return null
  const definition = (await storeDefinitions(userDataPath)).find((item) => item.id === storeId)
  if (!definition) return null
  const trustedRoot = await fs.promises.realpath(path.resolve(userDataPath))
  const validate = async (candidate: string): Promise<string | null> => {
    const resolved = path.resolve(candidate)
    if (!isPathInside(userDataPath, resolved)) return null
    try {
      const stat = await fs.promises.lstat(resolved)
      if (stat.isSymbolicLink()) return null
      const real = await fs.promises.realpath(resolved)
      return isPathInside(trustedRoot, real) ? real : null
    } catch {
      return null
    }
  }
  const location = await validate(definition.location)
  if (location) return location
  for (const candidate of definition.roots) {
    const fallback = await validate(candidate)
    if (fallback) return fallback
  }
  return null
}

export function resetImageSearchDataCatalogForTests(): void {
  inventoryCache = null
  activeBuild = null
  activeStopView = null
  cancelRequested = false
  progress = {
    state: 'idle',
    processedBytes: 0,
    totalBytes: 0,
    processedRecords: 0,
    nativeRecords: 0,
    dinoRecords: 0,
    clipRecords: 0,
  }
}
