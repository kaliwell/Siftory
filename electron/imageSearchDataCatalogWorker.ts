import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import type { ImageSearchDataCatalogProgress } from '../shared/ipc-contract'
import {
  createFileChunkIntegritySync,
  type FileChunkIntegrityAnchor,
  isValidFileChunkIntegrity,
  verifyFileChunkIntegritySync,
} from './authoritativeVectorStore'
import {
  CATALOG_SOURCE_CHUNK_BYTES,
  CatalogSourceChunkBuilder,
  type CatalogSourceChunk,
  catalogSourceFingerprintSha256,
  sampleCatalogSourceFileSync,
} from './imageSearchDataCatalogFingerprint'
import { cleanCatalogDisplayPath as cleanDisplayPath } from './imageSearchDataCatalogPaths'
import {
  buildImageSearchFolderRollups,
  updateAffectedImageSearchFolderRollups,
} from './imageSearchDataCatalogRollup'
import {
  extractJsonStringFieldBuffer,
  normalizedImageDataPathKey,
} from './imageSearchDataPathUtils'
import type {
  CatalogVectorLayer,
  ImageSearchCatalogVectorSource,
  ImageSearchDataCatalogSummary,
  ImageSearchDataCatalogWorkerErrorMessage,
  ImageSearchDataCatalogWorkerInput,
  ImageSearchDataCatalogWorkerProgressMessage,
  ImageSearchDataCatalogWorkerResult,
  ImageSearchDataCatalogWorkerResultMessage,
  ImageSearchDataCatalogWorkerStoppedMessage,
} from './imageSearchDataCatalogTypes'

export type {
  CatalogVectorLayer,
  ImageSearchCatalogNativeRecord,
  ImageSearchCatalogNativeSource,
  ImageSearchCatalogVectorSource,
  ImageSearchDataCatalogSummary,
  ImageSearchDataCatalogWorkerInput,
  ImageSearchDataCatalogWorkerMessage,
  ImageSearchDataCatalogWorkerResult,
} from './imageSearchDataCatalogTypes'

const CATALOG_SCHEMA_VERSION = 2
const INSERT_BATCH_SIZE = 20_000
const PROGRESS_RECORD_INTERVAL = 1_000
const MAX_CATALOG_LINE_BYTES = 8 * 1024 * 1024

interface PreviousVectorSourceRow {
  source_id: string
  source_order: number
  layer: string
  physical_key: string
  size_bytes: number
  mtime_ms: number
  fingerprint: string
  sample_sha256: string
  prefix_proof: string
  namespace_count: number
  single_namespace: string | null
  record_count: number
  unique_count: number
  malformed_count: number
  duplicate_count: number
}

interface IncrementalSourcePlan {
  source: ImageSearchCatalogVectorSource
  previous: PreviousVectorSourceRow
  mode: 'reuse' | 'append'
}

interface CatalogBuildDiagnostics {
  buildMode: 'full' | 'incremental'
  reusedSourceCount: number
  fullBytesRead: number
  tailBytesRead: number
  changedPathCount: number
  catalogSha256: string
}

class CatalogBuildCancelledError extends Error {
  constructor() {
    super('Image Search data catalog build cancelled')
    this.name = 'CatalogBuildCancelledError'
  }
}

class IncrementalCatalogInvalidatedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IncrementalCatalogInvalidatedError'
  }
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function checkCancelled(stopView: Int32Array): void {
  if (Atomics.load(stopView, 0) === 1) throw new CatalogBuildCancelledError()
}

function vectorLayer(source: CatalogVectorLayer, modelName: string): 'dino' | 'clip' | null {
  const model = modelName.toLowerCase()
  if (model.includes('dino')) return 'dino'
  if (model.includes('clip')) return 'clip'
  return source === 'mixed' ? null : source
}

function canonicalSourceFingerprint(source: ImageSearchCatalogVectorSource, sha256: string) {
  return {
    algorithm: 'sha256-chunk-tree-v1',
    sourceId: source.sourceId,
    physicalKey: source.physicalKey,
    layer: source.layer,
    sizeBytes: source.sizeBytes,
    modifiedAt: source.modifiedAt,
    sampleSha256: source.sampleSha256,
    sha256,
  }
}

function sourceSampleSha256(source: ImageSearchCatalogVectorSource): string {
  return /^[a-f0-9]{64}$/.test(source.sampleSha256 || '')
    ? source.sampleSha256
    : sampleCatalogSourceFileSync(source.filePath, source.sizeBytes)
}

function insertSourceChunks(
  database: DatabaseSync,
  sourceId: string,
  chunks: readonly CatalogSourceChunk[],
): void {
  const insert = database.prepare(`
    INSERT INTO source_chunks (source_id, chunk_index, offset_bytes, length_bytes, sha256)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const chunk of chunks) {
    insert.run(sourceId, chunk.chunkIndex, chunk.offsetBytes, chunk.lengthBytes, chunk.sha256)
  }
}

function readSourceChunks(database: DatabaseSync, sourceId: string): CatalogSourceChunk[] {
  const rows = database
    .prepare(
      `SELECT chunk_index, offset_bytes, length_bytes, sha256
       FROM source_chunks WHERE source_id = ? ORDER BY chunk_index`,
    )
    .all(sourceId) as unknown as Array<Record<string, unknown>>
  return rows.map((row) => ({
    chunkIndex: numberValue(row.chunk_index),
    offsetBytes: numberValue(row.offset_bytes),
    lengthBytes: numberValue(row.length_bytes),
    sha256: String(row.sha256 || ''),
  }))
}

function catalogLogicalSha256(
  database: DatabaseSync,
  input: ImageSearchDataCatalogWorkerInput,
  summary: ImageSearchDataCatalogSummary,
): string {
  const hash = crypto.createHash('sha256')
  hash.update('siftory-image-data-catalog-v2\0')
  hash.update(input.sourceSnapshot)
  hash.update('\0')
  hash.update(JSON.stringify([...new Set(input.roots.map(cleanDisplayPath))].sort()))
  hash.update('\0')
  const sources = database
    .prepare(
      `SELECT source_id, source_order, layer, physical_key, size_bytes, fingerprint,
              namespace_count, single_namespace, record_count, unique_count,
              malformed_count, duplicate_count
         FROM source_files ORDER BY source_order, source_id`,
    )
    .all()
  hash.update(JSON.stringify(sources))
  hash.update('\0')
  const stableSummary = {
    unionPathCount: summary.unionPathCount,
    nativeUniqueCount: summary.nativeUniqueCount,
    dinoUniqueCount: summary.dinoUniqueCount,
    clipUniqueCount: summary.clipUniqueCount,
    completeCount: summary.completeCount,
    missingDinoCount: summary.missingDinoCount,
    missingClipCount: summary.missingClipCount,
    vectorOnlyCount: summary.vectorOnlyCount,
    duplicateRows: summary.duplicateRows,
    malformedRows: summary.malformedRows,
    folderCount: summary.folderCount,
  }
  hash.update(JSON.stringify(stableSummary))
  return hash.digest('hex')
}

function parsePrefixProof(value: string, anchoredSize: number): FileChunkIntegrityAnchor | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return isValidFileChunkIntegrity(parsed, anchoredSize) ? parsed : null
  } catch {
    return null
  }
}

function sourceEndsAtLineBoundary(filePath: string, sizeBytes: number): boolean {
  if (sizeBytes === 0) return true
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const byte = Buffer.allocUnsafe(1)
    return fs.readSync(descriptor, byte, 0, 1, sizeBytes - 1) === 1 && byte[0] === 0x0a
  } finally {
    fs.closeSync(descriptor)
  }
}

function planIncrementalSources(
  database: DatabaseSync,
  sources: readonly ImageSearchCatalogVectorSource[],
): IncrementalSourcePlan[] | null {
  const version = scalarCount(database, 'PRAGMA user_version')
  if (version !== CATALOG_SCHEMA_VERSION) return null
  const quickCheck = database.prepare('PRAGMA quick_check').get() as
    | Record<string, unknown>
    | undefined
  if (!quickCheck || String(Object.values(quickCheck)[0]) !== 'ok') return null
  const previousRows = database
    .prepare(
      `SELECT source_id, source_order, layer, physical_key, size_bytes, mtime_ms,
              fingerprint, sample_sha256, prefix_proof, namespace_count,
              single_namespace, record_count, unique_count, malformed_count,
              duplicate_count
         FROM source_files WHERE role = 'authoritative' AND layer <> 'native'
         ORDER BY source_order`,
    )
    .all() as unknown as PreviousVectorSourceRow[]
  if (previousRows.length !== sources.length) return null
  const plans: IncrementalSourcePlan[] = []
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]
    const previous = previousRows[index]
    const expectedLayer = source.layer === 'mixed' ? 'shared' : source.layer
    if (
      previous.source_id !== source.sourceId ||
      previous.source_order !== index ||
      previous.layer !== expectedLayer ||
      previous.physical_key !== source.physicalKey
    ) {
      return null
    }
    const stat = fs.lstatSync(source.filePath)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== source.sizeBytes ||
      stat.mtimeMs !== source.modifiedAt
    ) {
      return null
    }
    const sampleSha256 = sourceSampleSha256(source)
    if (source.sizeBytes === previous.size_bytes) {
      if (source.modifiedAt !== previous.mtime_ms || sampleSha256 !== previous.sample_sha256) {
        return null
      }
      plans.push({ source, previous, mode: 'reuse' })
      continue
    }
    const proof = parsePrefixProof(previous.prefix_proof, previous.size_bytes)
    if (
      source.sizeBytes < previous.size_bytes ||
      !proof ||
      !verifyFileChunkIntegritySync(source.filePath, previous.size_bytes, proof) ||
      !sourceEndsAtLineBoundary(source.filePath, previous.size_bytes)
    ) {
      return null
    }
    plans.push({ source, previous, mode: 'append' })
  }
  const appended = plans.filter((plan) => plan.mode === 'append')
  if (appended.length === 0) return plans
  const layerCounts = new Map<string, number>()
  for (const plan of plans) {
    layerCounts.set(plan.previous.layer, (layerCounts.get(plan.previous.layer) || 0) + 1)
  }
  if (
    appended.some(
      (plan) =>
        (plan.previous.layer !== 'dino' && plan.previous.layer !== 'clip') ||
        plan.previous.namespace_count !== 1 ||
        !plan.previous.single_namespace ||
        layerCounts.get(plan.previous.layer) !== 1,
    )
  ) {
    return null
  }
  return plans
}

function beginBatch(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
}

function commitBatch(database: DatabaseSync): void {
  database.exec('COMMIT')
}

function rollbackBatch(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // A prior SQLite failure may already have closed the transaction.
  }
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    -- The database is an unreferenced staging artifact until quick_check and
    -- atomic CURRENT switching succeed, so NORMAL + file-backed temp storage
    -- bounds memory without weakening the committed snapshot contract.
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = FILE;
    PRAGMA user_version = ${CATALOG_SCHEMA_VERSION};

    CREATE TABLE catalog_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE source_files (
      source_id TEXT PRIMARY KEY,
      source_order INTEGER NOT NULL,
      layer TEXT NOT NULL,
      role TEXT NOT NULL,
      logical_name TEXT NOT NULL,
      physical_key TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      fingerprint TEXT,
      sample_sha256 TEXT,
      prefix_proof TEXT,
      namespace_count INTEGER NOT NULL DEFAULT 0,
      single_namespace TEXT,
      record_count INTEGER NOT NULL,
      unique_count INTEGER NOT NULL,
      malformed_count INTEGER NOT NULL,
      duplicate_count INTEGER NOT NULL,
      stale_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE source_chunks (
      source_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      offset_bytes INTEGER NOT NULL,
      length_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      PRIMARY KEY(source_id, chunk_index)
    ) WITHOUT ROWID;

    CREATE TABLE indexed_paths (
      path_id INTEGER PRIMARY KEY,
      normalized_path TEXT NOT NULL UNIQUE,
      display_path TEXT NOT NULL,
      native_count INTEGER NOT NULL DEFAULT 0,
      native_bytes INTEGER NOT NULL DEFAULT 0,
      native_exists INTEGER NOT NULL DEFAULT 0,
      dino_rows INTEGER NOT NULL DEFAULT 0,
      dino_bytes INTEGER NOT NULL DEFAULT 0,
      clip_rows INTEGER NOT NULL DEFAULT 0,
      clip_bytes INTEGER NOT NULL DEFAULT 0,
      duplicate_rows INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE folder_rollups (
      folder_key TEXT PRIMARY KEY,
      parent_key TEXT,
      display_path TEXT NOT NULL,
      name TEXT NOT NULL,
      depth INTEGER NOT NULL,
      child_count INTEGER NOT NULL,
      native_count INTEGER NOT NULL,
      dino_count INTEGER NOT NULL,
      clip_count INTEGER NOT NULL,
      native_only INTEGER NOT NULL,
      dino_only INTEGER NOT NULL,
      clip_only INTEGER NOT NULL,
      missing_dino INTEGER NOT NULL,
      missing_clip INTEGER NOT NULL,
      vector_only INTEGER NOT NULL,
      duplicate_rows INTEGER NOT NULL,
      malformed_rows INTEGER NOT NULL,
      matched_bytes INTEGER NOT NULL
    );

    CREATE INDEX indexed_paths_layers_idx
      ON indexed_paths(native_count, dino_rows, clip_rows);
    CREATE INDEX indexed_paths_duplicates_idx ON indexed_paths(duplicate_rows);
    CREATE INDEX source_files_order_idx ON source_files(source_order);
    CREATE INDEX folder_rollups_parent_idx ON folder_rollups(parent_key, name);
    CREATE INDEX folder_rollups_anomaly_idx
      ON folder_rollups(missing_dino, missing_clip, vector_only, duplicate_rows);
    CREATE INDEX folder_rollups_display_idx ON folder_rollups(display_path);
  `)
}

function scalarCount(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as Record<string, unknown> | undefined
  return numberValue(row ? Object.values(row)[0] : 0)
}

function catalogSummary(
  database: DatabaseSync,
  generation: string,
  builtAt: number,
  folderCount: number,
): ImageSearchDataCatalogSummary {
  return {
    generation,
    builtAt,
    unionPathCount: scalarCount(database, 'SELECT COUNT(*) FROM indexed_paths'),
    nativeUniqueCount: scalarCount(
      database,
      'SELECT COUNT(*) FROM indexed_paths WHERE native_count > 0',
    ),
    dinoUniqueCount: scalarCount(
      database,
      'SELECT COUNT(*) FROM indexed_paths WHERE dino_rows > 0',
    ),
    clipUniqueCount: scalarCount(
      database,
      'SELECT COUNT(*) FROM indexed_paths WHERE clip_rows > 0',
    ),
    completeCount: scalarCount(
      database,
      'SELECT COUNT(*) FROM indexed_paths WHERE native_count > 0 AND dino_rows > 0 AND clip_rows > 0',
    ),
    missingDinoCount: scalarCount(
      database,
      'SELECT COUNT(*) FROM indexed_paths WHERE native_count > 0 AND dino_rows = 0',
    ),
    missingClipCount: scalarCount(
      database,
      'SELECT COUNT(*) FROM indexed_paths WHERE native_count > 0 AND clip_rows = 0',
    ),
    vectorOnlyCount: scalarCount(
      database,
      'SELECT COUNT(*) FROM indexed_paths WHERE native_count = 0 AND (dino_rows > 0 OR clip_rows > 0)',
    ),
    duplicateRows: scalarCount(
      database,
      'SELECT COALESCE(SUM(duplicate_rows), 0) FROM indexed_paths',
    ),
    malformedRows: scalarCount(
      database,
      'SELECT COALESCE(SUM(malformed_count), 0) FROM source_files',
    ),
    folderCount,
  }
}

function writeCatalogMeta(
  database: DatabaseSync,
  input: ImageSearchDataCatalogWorkerInput,
  summary: ImageSearchDataCatalogSummary,
  diagnostics: CatalogBuildDiagnostics,
): void {
  const insert = database.prepare(`
    INSERT INTO catalog_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `)
  const values: Record<string, string> = {
    schema_version: String(CATALOG_SCHEMA_VERSION),
    generation: input.generation,
    built_at: String(summary.builtAt),
    source_snapshot: input.sourceSnapshot,
    summary: JSON.stringify(summary),
    build_mode: diagnostics.buildMode,
    catalog_sha256: diagnostics.catalogSha256,
    build_diagnostics: JSON.stringify(diagnostics),
  }
  beginBatch(database)
  try {
    for (const [key, value] of Object.entries(values)) insert.run(key, value)
    commitBatch(database)
  } catch (error) {
    rollbackBatch(database)
    throw error
  }
}

async function scanVectorSource(options: {
  database: DatabaseSync
  source: ImageSearchCatalogVectorSource
  stopView: Int32Array
  processedBefore: number
  totalBytes: number
  seenRevisionPaths: Map<string, Set<string>>
  insertDino: ReturnType<DatabaseSync['prepare']>
  insertClip: ReturnType<DatabaseSync['prepare']>
  onProgress: (progress: Partial<ImageSearchDataCatalogProgress>) => void
  counts: { dino: number; clip: number }
}): Promise<{
  recordCount: number
  uniqueCount: number
  malformedCount: number
  duplicateCount: number
  fingerprint: string
  sampleSha256: string
  prefixProof: FileChunkIntegrityAnchor
  namespaces: string[]
  chunks: CatalogSourceChunk[]
}> {
  const {
    database,
    source,
    stopView,
    processedBefore,
    totalBytes,
    seenRevisionPaths,
    insertDino,
    insertClip,
    onProgress,
    counts,
  } = options
  const before = await fs.promises.lstat(source.filePath)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size !== source.sizeBytes ||
    before.mtimeMs !== source.modifiedAt
  ) {
    throw new Error(`Embedding source changed before analysis: ${source.logicalName}`)
  }

  const chunkBuilder = new CatalogSourceChunkBuilder()
  const uniquePaths = new Set<string>()
  const namespaces = new Set<string>()
  let aliasedNamespace: string | null = null
  let processedBytes = 0
  let recordCount = 0
  let malformedCount = 0
  let duplicateCount = 0
  let pending = Buffer.alloc(0)
  let discardingOversizedLine = false
  let batchCount = 0
  let transactionOpen = false

  const begin = () => {
    beginBatch(database)
    transactionOpen = true
  }
  const commit = () => {
    commitBatch(database)
    transactionOpen = false
    batchCount = 0
  }
  const finishRecord = () => {
    batchCount++
    if (batchCount >= INSERT_BATCH_SIZE) {
      commit()
      begin()
    }
    if (recordCount % PROGRESS_RECORD_INTERVAL === 0) {
      onProgress({
        stage: source.layer === 'clip' ? 'clip' : 'dino',
        processedBytes: Math.min(totalBytes, processedBefore + processedBytes),
        totalBytes,
        processedRecords: counts.dino + counts.clip,
        dinoRecords: counts.dino,
        clipRecords: counts.clip,
        message: `Reading ${source.logicalName}`,
      })
    }
  }

  const processMalformedRecord = () => {
    checkCancelled(stopView)
    recordCount++
    malformedCount++
    finishRecord()
  }

  const processLine = (lineBuffer: Buffer, physicalBytes: number) => {
    if (lineBuffer.length === 0) return
    checkCancelled(stopView)
    recordCount++
    let first = 0
    let last = lineBuffer.length - 1
    while (first <= last && lineBuffer[first] <= 0x20) first++
    while (last >= first && lineBuffer[last] <= 0x20) last--
    const structurallyValid = lineBuffer[first] === 0x7b && lineBuffer[last] === 0x7d
    const imageId = structurallyValid
      ? extractJsonStringFieldBuffer(lineBuffer, 'imageId')
      : undefined
    const modelName = structurallyValid
      ? extractJsonStringFieldBuffer(lineBuffer, 'modelName') || ''
      : ''
    const embeddingType = structurallyValid
      ? extractJsonStringFieldBuffer(lineBuffer, 'embeddingType') || 'global'
      : 'global'
    const layer = vectorLayer(source.layer, modelName)
    const pathKey = imageId ? normalizedImageDataPathKey(imageId) : ''
    if (!imageId || !pathKey || !layer) {
      malformedCount++
    } else {
      const revisionNamespace = `${layer}\u0000${modelName || source.sourceId}\u0000${embeddingType}`
      namespaces.add(revisionNamespace)
      if (aliasedNamespace && revisionNamespace !== aliasedNamespace) {
        // The common case is one model/type per physical file, where the
        // source-unique set can also be the global revision set. Detach only
        // if a mixed file introduces another namespace.
        seenRevisionPaths.set(aliasedNamespace, new Set(uniquePaths))
        aliasedNamespace = null
      }
      let revisionPaths = seenRevisionPaths.get(revisionNamespace)
      if (!revisionPaths) {
        if (uniquePaths.size === 0 && aliasedNamespace === null) {
          revisionPaths = uniquePaths
          aliasedNamespace = revisionNamespace
        } else {
          revisionPaths = new Set<string>()
        }
        seenRevisionPaths.set(revisionNamespace, revisionPaths)
      }
      const duplicate = revisionPaths.has(pathKey)
      revisionPaths.add(pathKey)
      uniquePaths.add(pathKey)
      if (duplicate) duplicateCount++
      const statement = layer === 'dino' ? insertDino : insertClip
      statement.run(pathKey, cleanDisplayPath(imageId), physicalBytes, duplicate ? 1 : 0)
      counts[layer]++
    }
    finishRecord()
  }

  begin()
  try {
    const stream = fs.createReadStream(source.filePath, { highWaterMark: 1024 * 1024 })
    for await (const chunkValue of stream) {
      checkCancelled(stopView)
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue)
      chunkBuilder.update(chunk)
      processedBytes += chunk.length
      const buffer = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
      let lineStart = 0
      let cursor = buffer.indexOf(0x0a, lineStart)
      while (cursor >= 0) {
        if (discardingOversizedLine) {
          processMalformedRecord()
          discardingOversizedLine = false
        } else if (cursor - lineStart > MAX_CATALOG_LINE_BYTES) {
          processMalformedRecord()
        } else {
          const rawLine = buffer.subarray(lineStart, cursor)
          const line = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, rawLine.length - 1) : rawLine
          processLine(line, cursor - lineStart + 1)
        }
        lineStart = cursor + 1
        cursor = buffer.indexOf(0x0a, lineStart)
      }
      const remaining = buffer.length - lineStart
      if (!discardingOversizedLine && remaining > MAX_CATALOG_LINE_BYTES) {
        discardingOversizedLine = true
        pending = Buffer.alloc(0)
      } else {
        pending =
          !discardingOversizedLine && remaining > 0
            ? Buffer.from(buffer.subarray(lineStart))
            : Buffer.alloc(0)
      }
    }
    if (discardingOversizedLine) processMalformedRecord()
    else if (pending.length > 0) processLine(pending, pending.length)
    if (transactionOpen) commit()
  } catch (error) {
    if (transactionOpen) rollbackBatch(database)
    throw error
  }

  const after = await fs.promises.lstat(source.filePath)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.size !== source.sizeBytes ||
    after.mtimeMs !== source.modifiedAt
  ) {
    throw new Error(`Embedding source changed during analysis: ${source.logicalName}`)
  }
  onProgress({
    stage: source.layer === 'clip' ? 'clip' : 'dino',
    processedBytes: Math.min(totalBytes, processedBefore + source.sizeBytes),
    totalBytes,
    processedRecords: counts.dino + counts.clip,
    dinoRecords: counts.dino,
    clipRecords: counts.clip,
  })
  const chunks = chunkBuilder.finish()
  return {
    recordCount,
    uniqueCount: uniquePaths.size,
    malformedCount,
    duplicateCount,
    fingerprint: catalogSourceFingerprintSha256(chunks),
    sampleSha256: sourceSampleSha256(source),
    prefixProof: createFileChunkIntegritySync(source.filePath, source.sizeBytes),
    namespaces: [...namespaces].sort(),
    chunks,
  }
}

function createVectorInsertStatements(database: DatabaseSync) {
  return {
    dino: database.prepare(`
      INSERT INTO indexed_paths (
        normalized_path, display_path, dino_rows, dino_bytes, duplicate_rows
      ) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(normalized_path) DO UPDATE SET
        display_path = CASE
          WHEN indexed_paths.native_count > 0 THEN indexed_paths.display_path
          ELSE excluded.display_path
        END,
        dino_rows = indexed_paths.dino_rows + 1,
        dino_bytes = indexed_paths.dino_bytes + excluded.dino_bytes,
        duplicate_rows = indexed_paths.duplicate_rows + excluded.duplicate_rows
    `),
    clip: database.prepare(`
      INSERT INTO indexed_paths (
        normalized_path, display_path, clip_rows, clip_bytes, duplicate_rows
      ) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(normalized_path) DO UPDATE SET
        display_path = CASE
          WHEN indexed_paths.native_count > 0 THEN indexed_paths.display_path
          ELSE excluded.display_path
        END,
        clip_rows = indexed_paths.clip_rows + 1,
        clip_bytes = indexed_paths.clip_bytes + excluded.clip_bytes,
        duplicate_rows = indexed_paths.duplicate_rows + excluded.duplicate_rows
    `),
  }
}

function syncIncrementalNativeProjection(
  database: DatabaseSync,
  input: ImageSearchDataCatalogWorkerInput,
  stopView: Int32Array,
  onProgress: (progress: Partial<ImageSearchDataCatalogProgress>) => void,
): void {
  database.exec(`
    CREATE TEMP TABLE next_native (
      normalized_path TEXT PRIMARY KEY,
      display_path TEXT NOT NULL,
      native_bytes INTEGER NOT NULL,
      native_exists INTEGER NOT NULL
    ) WITHOUT ROWID;
  `)
  const insert = database.prepare(`
    INSERT INTO next_native (normalized_path, display_path, native_bytes, native_exists)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(normalized_path) DO UPDATE SET
      display_path = excluded.display_path,
      native_bytes = MAX(next_native.native_bytes, excluded.native_bytes),
      native_exists = MAX(next_native.native_exists, excluded.native_exists)
  `)
  beginBatch(database)
  try {
    for (let index = 0; index < input.nativeRecords.length; index++) {
      if (index % PROGRESS_RECORD_INTERVAL === 0) {
        checkCancelled(stopView)
        onProgress({
          stage: 'native',
          processedRecords: index,
          nativeRecords: index,
          message: `Comparing Native records ${index.toLocaleString()}/${input.nativeRecords.length.toLocaleString()}`,
        })
      }
      const record = input.nativeRecords[index]
      const pathKey = normalizedImageDataPathKey(record.path)
      if (!pathKey) continue
      insert.run(
        pathKey,
        cleanDisplayPath(record.path),
        Math.max(0, numberValue(record.fileSize)),
        record.exists == null ? -1 : record.exists ? 1 : 0,
      )
    }
    commitBatch(database)
  } catch (error) {
    rollbackBatch(database)
    throw error
  }

  const removed = scalarCount(
    database,
    `SELECT COUNT(*) FROM indexed_paths p
      WHERE p.native_count > 0
        AND NOT EXISTS (SELECT 1 FROM next_native n WHERE n.normalized_path = p.normalized_path)`,
  )
  if (removed > 0) {
    throw new IncrementalCatalogInvalidatedError(
      'Native paths were removed; a full catalog rebuild is required',
    )
  }

  database.exec(`
    INSERT OR IGNORE INTO changed_paths (
      normalized_path, old_present, old_display_path, old_native_count,
      old_native_bytes, old_dino_rows, old_clip_rows, old_duplicate_rows
    )
      SELECT p.normalized_path, 1, p.display_path, p.native_count,
             p.native_bytes, p.dino_rows, p.clip_rows, p.duplicate_rows
        FROM next_native n
        JOIN indexed_paths p ON p.normalized_path = n.normalized_path
       WHERE p.native_count <> 1
          OR p.display_path <> n.display_path
          OR p.native_bytes <> n.native_bytes
          OR p.native_exists <> n.native_exists;

    INSERT OR IGNORE INTO changed_paths (
      normalized_path, old_present, old_display_path, old_native_count,
      old_native_bytes, old_dino_rows, old_clip_rows, old_duplicate_rows
    )
      SELECT n.normalized_path, 0, n.display_path, 0, 0, 0, 0, 0
        FROM next_native n
        LEFT JOIN indexed_paths p ON p.normalized_path = n.normalized_path
       WHERE p.path_id IS NULL;

    UPDATE indexed_paths
       SET display_path = (SELECT n.display_path FROM next_native n
                            WHERE n.normalized_path = indexed_paths.normalized_path),
           native_count = 1,
           native_bytes = (SELECT n.native_bytes FROM next_native n
                            WHERE n.normalized_path = indexed_paths.normalized_path),
           native_exists = (SELECT n.native_exists FROM next_native n
                             WHERE n.normalized_path = indexed_paths.normalized_path)
     WHERE normalized_path IN (SELECT normalized_path FROM next_native);

    INSERT INTO indexed_paths (
      normalized_path, display_path, native_count, native_bytes, native_exists
    )
    SELECT n.normalized_path, n.display_path, 1, n.native_bytes, n.native_exists
      FROM next_native n
      LEFT JOIN indexed_paths p ON p.normalized_path = n.normalized_path
     WHERE p.path_id IS NULL;
  `)

  const nativeUnique = scalarCount(database, 'SELECT COUNT(*) FROM next_native')
  database.prepare("DELETE FROM source_files WHERE layer = 'native'").run()
  database
    .prepare(
      `INSERT INTO source_files (
         source_id, source_order, layer, role, logical_name, physical_key,
         size_bytes, mtime_ms, fingerprint, sample_sha256, prefix_proof,
         namespace_count, single_namespace, record_count, unique_count,
         malformed_count, duplicate_count, stale_count
       ) VALUES (?, -1, 'native', 'authoritative', ?, ?, ?, ?, NULL, NULL, NULL,
                 0, NULL, ?, ?, 0, ?, 0)`,
    )
    .run(
      input.nativeSource.sourceId,
      input.nativeSource.logicalName,
      input.nativeSource.physicalKey,
      input.nativeSource.sizeBytes,
      input.nativeSource.modifiedAt,
      input.nativeRecords.length,
      nativeUnique,
      Math.max(0, input.nativeRecords.length - nativeUnique),
    )
  database.exec('DROP TABLE next_native')
}

async function scanVectorAppend(options: {
  database: DatabaseSync
  plan: IncrementalSourcePlan
  stopView: Int32Array
  processedBefore: number
  totalBytes: number
  onProgress: (progress: Partial<ImageSearchDataCatalogProgress>) => void
}): Promise<{ bytesRead: number; fingerprint: string }> {
  const { database, plan, stopView, processedBefore, totalBytes, onProgress } = options
  const { source, previous } = plan
  const layer = previous.layer as 'dino' | 'clip'
  const oldChunks = readSourceChunks(database, source.sourceId)
  if (
    oldChunks.length === 0 ||
    catalogSourceFingerprintSha256(oldChunks) !== previous.fingerprint
  ) {
    throw new IncrementalCatalogInvalidatedError('Previous source chunk fingerprint is invalid')
  }
  const readStart =
    Math.floor(previous.size_bytes / CATALOG_SOURCE_CHUNK_BYTES) * CATALOG_SOURCE_CHUNK_BYTES
  const prefixChunks = oldChunks.filter((chunk) => chunk.offsetBytes < readStart)
  const chunkBuilder = new CatalogSourceChunkBuilder(readStart)
  const statements = createVectorInsertStatements(database)
  const selectLayerRows = database.prepare(
    `SELECT ${layer === 'dino' ? 'dino_rows' : 'clip_rows'} AS layer_rows
       FROM indexed_paths WHERE normalized_path = ?`,
  )
  const markChanged = database.prepare(
    `INSERT OR IGNORE INTO changed_paths (
       normalized_path, old_present, old_display_path, old_native_count,
       old_native_bytes, old_dino_rows, old_clip_rows, old_duplicate_rows
     )
     SELECT ?, CASE WHEN p.path_id IS NULL THEN 0 ELSE 1 END,
            COALESCE(p.display_path, ?), COALESCE(p.native_count, 0),
            COALESCE(p.native_bytes, 0), COALESCE(p.dino_rows, 0),
            COALESCE(p.clip_rows, 0), COALESCE(p.duplicate_rows, 0)
       FROM (SELECT 1) seed
       LEFT JOIN indexed_paths p ON p.normalized_path = ?`,
  )
  let streamBytes = 0
  let parsedBytes = 0
  let recordCount = 0
  let malformedCount = 0
  let duplicateCount = 0
  let uniqueAdded = 0
  let pending = Buffer.alloc(0)
  let discardingOversizedLine = false
  let batchCount = 0
  let transactionOpen = false

  const begin = () => {
    beginBatch(database)
    transactionOpen = true
  }
  const commit = () => {
    commitBatch(database)
    transactionOpen = false
    batchCount = 0
  }
  const finishRecord = () => {
    batchCount++
    if (batchCount >= INSERT_BATCH_SIZE) {
      commit()
      begin()
    }
    if (recordCount % PROGRESS_RECORD_INTERVAL === 0) {
      onProgress({
        stage: layer,
        processedBytes: Math.min(totalBytes, processedBefore + parsedBytes),
        totalBytes,
        processedRecords: recordCount,
        message: `Reading appended tail of ${source.logicalName}`,
      })
    }
  }
  const processMalformedRecord = () => {
    checkCancelled(stopView)
    recordCount++
    malformedCount++
    finishRecord()
  }
  const processLine = (lineBuffer: Buffer, physicalBytes: number) => {
    if (lineBuffer.length === 0) return
    checkCancelled(stopView)
    recordCount++
    let first = 0
    let last = lineBuffer.length - 1
    while (first <= last && lineBuffer[first] <= 0x20) first++
    while (last >= first && lineBuffer[last] <= 0x20) last--
    const structurallyValid = lineBuffer[first] === 0x7b && lineBuffer[last] === 0x7d
    const imageId = structurallyValid
      ? extractJsonStringFieldBuffer(lineBuffer, 'imageId')
      : undefined
    const modelName = structurallyValid
      ? extractJsonStringFieldBuffer(lineBuffer, 'modelName') || ''
      : ''
    const embeddingType = structurallyValid
      ? extractJsonStringFieldBuffer(lineBuffer, 'embeddingType') || 'global'
      : 'global'
    const detectedLayer = vectorLayer(source.layer, modelName)
    const pathKey = imageId ? normalizedImageDataPathKey(imageId) : ''
    const revisionNamespace = detectedLayer
      ? `${detectedLayer}\u0000${modelName || source.sourceId}\u0000${embeddingType}`
      : ''
    if (!imageId || !pathKey || detectedLayer !== layer) {
      malformedCount++
    } else if (revisionNamespace !== previous.single_namespace) {
      throw new IncrementalCatalogInvalidatedError(
        'An appended row changed the source model/type namespace',
      )
    } else {
      const existing = selectLayerRows.get(pathKey) as Record<string, unknown> | undefined
      const duplicate = numberValue(existing?.layer_rows) > 0
      const displayPath = cleanDisplayPath(imageId)
      markChanged.run(pathKey, displayPath, pathKey)
      statements[layer].run(pathKey, displayPath, physicalBytes, duplicate ? 1 : 0)
      if (duplicate) duplicateCount++
      else uniqueAdded++
    }
    finishRecord()
  }
  const feedParser = (chunk: Buffer) => {
    parsedBytes += chunk.length
    const buffer = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
    let lineStart = 0
    let cursor = buffer.indexOf(0x0a, lineStart)
    while (cursor >= 0) {
      if (discardingOversizedLine) {
        processMalformedRecord()
        discardingOversizedLine = false
      } else if (cursor - lineStart > MAX_CATALOG_LINE_BYTES) {
        processMalformedRecord()
      } else {
        const rawLine = buffer.subarray(lineStart, cursor)
        const line = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, rawLine.length - 1) : rawLine
        processLine(line, cursor - lineStart + 1)
      }
      lineStart = cursor + 1
      cursor = buffer.indexOf(0x0a, lineStart)
    }
    const remaining = buffer.length - lineStart
    if (!discardingOversizedLine && remaining > MAX_CATALOG_LINE_BYTES) {
      discardingOversizedLine = true
      pending = Buffer.alloc(0)
    } else {
      pending =
        !discardingOversizedLine && remaining > 0
          ? Buffer.from(buffer.subarray(lineStart))
          : Buffer.alloc(0)
    }
  }

  begin()
  try {
    const stream = fs.createReadStream(source.filePath, {
      start: readStart,
      highWaterMark: 1024 * 1024,
    })
    for await (const chunkValue of stream) {
      checkCancelled(stopView)
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue)
      const absoluteStart = readStart + streamBytes
      chunkBuilder.update(chunk)
      streamBytes += chunk.length
      const parserOffset = Math.max(0, previous.size_bytes - absoluteStart)
      if (parserOffset < chunk.length) feedParser(chunk.subarray(parserOffset))
    }
    if (discardingOversizedLine) processMalformedRecord()
    else if (pending.length > 0) processLine(pending, pending.length)
    if (transactionOpen) commit()
  } catch (error) {
    if (transactionOpen) rollbackBatch(database)
    throw error
  }

  const after = await fs.promises.lstat(source.filePath)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.size !== source.sizeBytes ||
    after.mtimeMs !== source.modifiedAt
  ) {
    throw new Error(`Embedding source changed during incremental analysis: ${source.logicalName}`)
  }
  const replacementChunks = chunkBuilder.finish()
  const chunks = [...prefixChunks, ...replacementChunks]
  const fingerprint = catalogSourceFingerprintSha256(chunks)
  beginBatch(database)
  try {
    database
      .prepare('DELETE FROM source_chunks WHERE source_id = ? AND offset_bytes >= ?')
      .run(source.sourceId, readStart)
    insertSourceChunks(database, source.sourceId, replacementChunks)
    database
      .prepare(
        `UPDATE source_files
            SET size_bytes = ?, mtime_ms = ?, fingerprint = ?, sample_sha256 = ?,
                prefix_proof = ?, record_count = record_count + ?,
                unique_count = unique_count + ?, malformed_count = malformed_count + ?,
                duplicate_count = duplicate_count + ?
          WHERE source_id = ?`,
      )
      .run(
        source.sizeBytes,
        source.modifiedAt,
        fingerprint,
        sourceSampleSha256(source),
        JSON.stringify(createFileChunkIntegritySync(source.filePath, source.sizeBytes)),
        recordCount,
        uniqueAdded,
        malformedCount,
        duplicateCount,
        source.sourceId,
      )
    commitBatch(database)
  } catch (error) {
    rollbackBatch(database)
    throw error
  }
  onProgress({
    stage: layer,
    processedBytes: Math.min(totalBytes, processedBefore + parsedBytes),
    totalBytes,
    processedRecords: recordCount,
  })
  return { bytesRead: streamBytes, fingerprint }
}

async function runFullImageSearchDataCatalogBuild(
  input: ImageSearchDataCatalogWorkerInput,
  stopView: Int32Array,
  onProgress: (progress: Partial<ImageSearchDataCatalogProgress>) => void = () => {},
): Promise<ImageSearchDataCatalogWorkerResult> {
  const startedAt = Date.now()
  fs.mkdirSync(path.dirname(input.databasePath), { recursive: true })
  if (fs.existsSync(input.databasePath)) {
    throw new Error('Catalog staging database already exists')
  }
  const database = new DatabaseSync(input.databasePath)
  const sourceFingerprints: Array<Record<string, unknown>> = []
  try {
    createSchema(database)
    const insertNative = database.prepare(`
      INSERT INTO indexed_paths (
        normalized_path, display_path, native_count, native_bytes, native_exists
      ) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(normalized_path) DO UPDATE SET
        display_path = excluded.display_path,
        native_count = 1,
        native_bytes = MAX(indexed_paths.native_bytes, excluded.native_bytes),
        native_exists = MAX(indexed_paths.native_exists, excluded.native_exists)
    `)
    let nativeBatch = 0
    beginBatch(database)
    try {
      for (let index = 0; index < input.nativeRecords.length; index++) {
        if (index % PROGRESS_RECORD_INTERVAL === 0) {
          checkCancelled(stopView)
          onProgress({
            stage: 'native',
            processedRecords: index,
            nativeRecords: index,
            message: `Projecting Native records ${index.toLocaleString()}/${input.nativeRecords.length.toLocaleString()}`,
          })
        }
        const record = input.nativeRecords[index]
        const pathKey = normalizedImageDataPathKey(record.path)
        if (!pathKey) continue
        insertNative.run(
          pathKey,
          cleanDisplayPath(record.path),
          Math.max(0, numberValue(record.fileSize)),
          // -1 means the fast Native snapshot did not perform per-file stats.
          record.exists == null ? -1 : record.exists ? 1 : 0,
        )
        nativeBatch++
        if (nativeBatch >= INSERT_BATCH_SIZE) {
          commitBatch(database)
          beginBatch(database)
          nativeBatch = 0
        }
      }
      commitBatch(database)
    } catch (error) {
      rollbackBatch(database)
      throw error
    }

    const nativeUnique = scalarCount(
      database,
      'SELECT COUNT(*) FROM indexed_paths WHERE native_count > 0',
    )
    database
      .prepare(
        `
        INSERT INTO source_files (
          source_id, source_order, layer, role, logical_name, physical_key, size_bytes,
          mtime_ms, fingerprint, sample_sha256, prefix_proof, namespace_count,
          single_namespace, record_count, unique_count, malformed_count,
          duplicate_count, stale_count
        ) VALUES (?, -1, 'native', 'authoritative', ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?, 0, ?, 0)
      `,
      )
      .run(
        input.nativeSource.sourceId,
        input.nativeSource.logicalName,
        input.nativeSource.physicalKey,
        input.nativeSource.sizeBytes,
        input.nativeSource.modifiedAt,
        input.nativeRecords.length,
        nativeUnique,
        Math.max(0, input.nativeRecords.length - nativeUnique),
      )

    const insertDino = database.prepare(`
      INSERT INTO indexed_paths (
        normalized_path, display_path, dino_rows, dino_bytes, duplicate_rows
      ) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(normalized_path) DO UPDATE SET
        display_path = CASE
          WHEN indexed_paths.native_count > 0 THEN indexed_paths.display_path
          ELSE excluded.display_path
        END,
        dino_rows = indexed_paths.dino_rows + 1,
        dino_bytes = indexed_paths.dino_bytes + excluded.dino_bytes,
        duplicate_rows = indexed_paths.duplicate_rows + excluded.duplicate_rows
    `)
    const insertClip = database.prepare(`
      INSERT INTO indexed_paths (
        normalized_path, display_path, clip_rows, clip_bytes, duplicate_rows
      ) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(normalized_path) DO UPDATE SET
        display_path = CASE
          WHEN indexed_paths.native_count > 0 THEN indexed_paths.display_path
          ELSE excluded.display_path
        END,
        clip_rows = indexed_paths.clip_rows + 1,
        clip_bytes = indexed_paths.clip_bytes + excluded.clip_bytes,
        duplicate_rows = indexed_paths.duplicate_rows + excluded.duplicate_rows
    `)
    const seenRevisionPaths = new Map<string, Set<string>>()
    const counts = { dino: 0, clip: 0 }
    const totalBytes = input.vectorSources.reduce((sum, source) => sum + source.sizeBytes, 0)
    let processedBefore = 0
    for (let sourceIndex = 0; sourceIndex < input.vectorSources.length; sourceIndex++) {
      const source = input.vectorSources[sourceIndex]
      checkCancelled(stopView)
      const stats = await scanVectorSource({
        database,
        source,
        stopView,
        processedBefore,
        totalBytes,
        seenRevisionPaths,
        insertDino,
        insertClip,
        onProgress,
        counts,
      })
      const sourceLayer = source.layer === 'mixed' ? 'shared' : source.layer
      database
        .prepare(
          `
          INSERT INTO source_files (
            source_id, source_order, layer, role, logical_name, physical_key,
            size_bytes, mtime_ms, fingerprint, sample_sha256, prefix_proof,
            namespace_count, single_namespace, record_count, unique_count,
            malformed_count, duplicate_count, stale_count
          ) VALUES (?, ?, ?, 'authoritative', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `,
        )
        .run(
          source.sourceId,
          sourceIndex,
          sourceLayer,
          source.logicalName,
          source.physicalKey,
          source.sizeBytes,
          source.modifiedAt,
          stats.fingerprint,
          stats.sampleSha256,
          JSON.stringify(stats.prefixProof),
          stats.namespaces.length,
          stats.namespaces.length === 1 ? stats.namespaces[0] : null,
          stats.recordCount,
          stats.uniqueCount,
          stats.malformedCount,
          stats.duplicateCount,
        )
      insertSourceChunks(database, source.sourceId, stats.chunks)
      sourceFingerprints.push(canonicalSourceFingerprint(source, stats.fingerprint))
      processedBefore += source.sizeBytes
    }
    // Duplicate detection is complete; folder aggregation only needs SQLite.
    seenRevisionPaths.clear()

    checkCancelled(stopView)
    onProgress({ stage: 'folders', message: 'Building folder coverage' })
    const folderCount = buildImageSearchFolderRollups(
      database,
      input.roots,
      () => checkCancelled(stopView),
      onProgress,
    )
    const builtAt = Date.now()
    const summary = catalogSummary(database, input.generation, builtAt, folderCount)
    const diagnostics: CatalogBuildDiagnostics = {
      buildMode: 'full',
      reusedSourceCount: 0,
      fullBytesRead: totalBytes,
      tailBytesRead: 0,
      changedPathCount: summary.unionPathCount,
      catalogSha256: catalogLogicalSha256(database, input, summary),
    }
    writeCatalogMeta(database, input, summary, diagnostics)

    onProgress({ stage: 'validate', message: 'Validating catalog snapshot' })
    const quickCheck = database.prepare('PRAGMA quick_check').get() as
      | Record<string, unknown>
      | undefined
    if (!quickCheck || String(Object.values(quickCheck)[0]) !== 'ok') {
      throw new Error('Catalog SQLite quick_check failed')
    }
    if (summary.unionPathCount !== scalarCount(database, 'SELECT COUNT(*) FROM indexed_paths')) {
      throw new Error('Catalog path-count invariant failed')
    }
    database.exec('PRAGMA optimize')
    database.close()

    const durationMs = Date.now() - startedAt
    fs.writeFileSync(
      input.buildMetadataPath,
      JSON.stringify(
        {
          schemaVersion: CATALOG_SCHEMA_VERSION,
          generation: input.generation,
          builtAt,
          durationMs,
          summary,
          sourceSnapshot: JSON.parse(input.sourceSnapshot) as unknown,
          sourceFingerprints,
          ...diagnostics,
        },
        null,
        2,
      ),
      { encoding: 'utf8', flag: 'wx' },
    )
    return {
      generation: input.generation,
      databasePath: input.databasePath,
      builtAt,
      durationMs,
      summary,
      ...diagnostics,
    }
  } catch (error) {
    try {
      database.close()
    } catch {
      // Surface the original build error.
    }
    throw error
  }
}

async function runIncrementalImageSearchDataCatalogBuild(
  input: ImageSearchDataCatalogWorkerInput,
  plans: IncrementalSourcePlan[],
  stopView: Int32Array,
  onProgress: (progress: Partial<ImageSearchDataCatalogProgress>) => void,
): Promise<ImageSearchDataCatalogWorkerResult> {
  const startedAt = Date.now()
  const database = new DatabaseSync(input.databasePath)
  const sourceFingerprints: Array<Record<string, unknown>> = []
  try {
    database.exec(`
      CREATE TEMP TABLE changed_paths (
        normalized_path TEXT PRIMARY KEY,
        old_present INTEGER NOT NULL,
        old_display_path TEXT NOT NULL,
        old_native_count INTEGER NOT NULL,
        old_native_bytes INTEGER NOT NULL,
        old_dino_rows INTEGER NOT NULL,
        old_clip_rows INTEGER NOT NULL,
        old_duplicate_rows INTEGER NOT NULL
      ) WITHOUT ROWID
    `)
    syncIncrementalNativeProjection(database, input, stopView, onProgress)
    checkCancelled(stopView)

    const appendedBytes = plans.reduce(
      (sum, plan) =>
        sum + (plan.mode === 'append' ? plan.source.sizeBytes - plan.previous.size_bytes : 0),
      0,
    )
    let processedBefore = 0
    let tailBytesRead = 0
    for (const plan of plans) {
      checkCancelled(stopView)
      if (plan.mode === 'reuse') {
        sourceFingerprints.push(canonicalSourceFingerprint(plan.source, plan.previous.fingerprint))
        continue
      }
      const result = await scanVectorAppend({
        database,
        plan,
        stopView,
        processedBefore,
        totalBytes: appendedBytes,
        onProgress,
      })
      processedBefore += plan.source.sizeBytes - plan.previous.size_bytes
      tailBytesRead += result.bytesRead
      sourceFingerprints.push(canonicalSourceFingerprint(plan.source, result.fingerprint))
    }

    checkCancelled(stopView)
    const changedPathCount = scalarCount(database, 'SELECT COUNT(*) FROM changed_paths')
    let folderCount = scalarCount(database, 'SELECT COUNT(*) FROM folder_rollups')
    if (changedPathCount > 0) {
      onProgress({ stage: 'folders', message: 'Updating affected folder ancestors' })
      folderCount = updateAffectedImageSearchFolderRollups(
        database,
        input.roots,
        () => checkCancelled(stopView),
        onProgress,
      )
    }
    const builtAt = Date.now()
    const summary = catalogSummary(database, input.generation, builtAt, folderCount)
    const diagnostics: CatalogBuildDiagnostics = {
      buildMode: 'incremental',
      reusedSourceCount: plans.filter((plan) => plan.mode === 'reuse').length,
      fullBytesRead: 0,
      tailBytesRead,
      changedPathCount,
      catalogSha256: catalogLogicalSha256(database, input, summary),
    }
    writeCatalogMeta(database, input, summary, diagnostics)

    onProgress({ stage: 'validate', message: 'Validating incremental catalog snapshot' })
    const quickCheck = database.prepare('PRAGMA quick_check').get() as
      | Record<string, unknown>
      | undefined
    if (!quickCheck || String(Object.values(quickCheck)[0]) !== 'ok') {
      throw new Error('Incremental catalog SQLite quick_check failed')
    }
    if (summary.unionPathCount !== scalarCount(database, 'SELECT COUNT(*) FROM indexed_paths')) {
      throw new Error('Incremental catalog path-count invariant failed')
    }
    database.exec('PRAGMA optimize')
    database.close()

    const durationMs = Date.now() - startedAt
    fs.writeFileSync(
      input.buildMetadataPath,
      JSON.stringify(
        {
          schemaVersion: CATALOG_SCHEMA_VERSION,
          generation: input.generation,
          builtAt,
          durationMs,
          summary,
          sourceSnapshot: JSON.parse(input.sourceSnapshot) as unknown,
          sourceFingerprints,
          ...diagnostics,
        },
        null,
        2,
      ),
      { encoding: 'utf8', flag: 'wx' },
    )
    return {
      generation: input.generation,
      databasePath: input.databasePath,
      builtAt,
      durationMs,
      summary,
      ...diagnostics,
    }
  } catch (error) {
    try {
      database.close()
    } catch {
      // Surface the original incremental build error.
    }
    throw error
  }
}

function removeCatalogStagingFiles(input: ImageSearchDataCatalogWorkerInput): void {
  for (const filePath of [
    input.databasePath,
    `${input.databasePath}-journal`,
    `${input.databasePath}-wal`,
    `${input.databasePath}-shm`,
    input.buildMetadataPath,
  ]) {
    try {
      fs.rmSync(filePath, { force: true })
    } catch {
      // A later exclusive create still fails closed if cleanup was incomplete.
    }
  }
}

export async function runImageSearchDataCatalogBuild(
  input: ImageSearchDataCatalogWorkerInput,
  stopView: Int32Array,
  onProgress: (progress: Partial<ImageSearchDataCatalogProgress>) => void = () => {},
): Promise<ImageSearchDataCatalogWorkerResult> {
  fs.mkdirSync(path.dirname(input.databasePath), { recursive: true })
  if (fs.existsSync(input.databasePath)) throw new Error('Catalog staging database already exists')
  if (input.previousDatabasePath) {
    let plans: IncrementalSourcePlan[] | null = null
    try {
      const previous = fs.lstatSync(input.previousDatabasePath)
      if (!previous.isFile() || previous.isSymbolicLink()) {
        throw new Error('Previous catalog is not an immutable regular file')
      }
      if (path.resolve(input.previousDatabasePath) === path.resolve(input.databasePath)) {
        throw new Error('Previous and staging catalog paths must differ')
      }
      fs.copyFileSync(input.previousDatabasePath, input.databasePath, fs.constants.COPYFILE_EXCL)
      const copied = new DatabaseSync(input.databasePath)
      try {
        plans = planIncrementalSources(copied, input.vectorSources)
      } finally {
        copied.close()
      }
    } catch {
      // Any previous-generation read/validation problem degrades to a fresh
      // derived build. The committed previous generation is never mutated.
    }
    if (plans) {
      try {
        return await runIncrementalImageSearchDataCatalogBuild(input, plans, stopView, onProgress)
      } catch (error) {
        if (!(error instanceof IncrementalCatalogInvalidatedError)) throw error
        onProgress({
          stage: 'dino',
          message: `${error.message}; rebuilding the complete catalog`,
        })
      }
    }
    removeCatalogStagingFiles(input)
  }
  return runFullImageSearchDataCatalogBuild(input, stopView, onProgress)
}

interface WorkerBootstrap {
  input: ImageSearchDataCatalogWorkerInput
  stopBuffer: SharedArrayBuffer
}

if (parentPort && workerData) {
  const port = parentPort
  const bootstrap = workerData as WorkerBootstrap
  const stopView = new Int32Array(bootstrap.stopBuffer)
  runImageSearchDataCatalogBuild(bootstrap.input, stopView, (progress) =>
    port.postMessage({
      type: 'progress',
      progress,
    } satisfies ImageSearchDataCatalogWorkerProgressMessage),
  )
    .then((result) => {
      port.postMessage({
        type: 'result',
        result,
      } satisfies ImageSearchDataCatalogWorkerResultMessage)
    })
    .catch((error: unknown) => {
      if (error instanceof CatalogBuildCancelledError) {
        port.postMessage({ type: 'stopped' } satisfies ImageSearchDataCatalogWorkerStoppedMessage)
        return
      }
      port.postMessage({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      } satisfies ImageSearchDataCatalogWorkerErrorMessage)
    })
}
