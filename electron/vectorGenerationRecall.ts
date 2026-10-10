import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { embeddingCachePathKey, float16ToFloat32 } from './embeddingF16Cache'
import {
  MAX_EMBEDDING_VECTOR_DIM,
  validateEmbeddingVector,
  type EmbeddingVectorIssue,
} from './embeddingVectorValidation'

/**
 * Vector source the recall gate can evaluate: a plain authoritative
 * generation, or a composite "generation + committed increment" snapshot
 * (D3 stage 2) whose rows beyond delta.baseCount live in the delta segment.
 * Structurally compatible with both AuthoritativeVectorStoreHandle and
 * EmbeddingF16CacheHandle.
 */
export interface GenerationRecallVectorSource {
  meta: {
    modelName: string
    embeddingType: string
    dim: number
    count: number
  }
  vectorPath: string
  pathIndexPath: string
  delta?: {
    vectorPath: string
    pathIndexPath: string
    baseCount: number
  }
}

/**
 * Per-model recall / numeric-error gate for authoritative F16 generations.
 *
 * The gate answers one question: does searching the F16 generation return
 * neighbours that are score-equivalent to an exact F32 scan of the
 * authoritative JSONL shard? It samples real vectors from the aligned path
 * set, runs an exact top-K against both stores, and reports strict path
 * overlap, score-equivalent recall, self-query rates and absolute score
 * error percentiles. Thresholds are calibrated on real data before being
 * locked as a release gate.
 */

export interface RecallThresholds {
  minRecallAtK: number
  minSelfInTopKRate: number
  maxTop1Gap: number
  maxMedianScoreError: number
  maxP99ScoreError: number
}

export const DEFAULT_RECALL_THRESHOLDS: RecallThresholds = {
  minRecallAtK: 0.99,
  minSelfInTopKRate: 0.995,
  maxTop1Gap: 1e-3,
  maxMedianScoreError: 1e-3,
  maxP99ScoreError: 5e-3,
}

export interface GenerationRecallOptions {
  queryCount?: number
  topK?: number
  seed?: number
  thresholds?: RecallThresholds
  onProgress?: (info: { phase: string; current: number; total: number }) => void
  /** Cooperative cancellation; checked between load batches, chunks and queries. */
  isCancelled?: () => boolean
  /**
   * Materialisation ceiling for the source validation matrix (default
   * 256 MiB). Above it, normalised rows spill to a scratch file and the scan
   * streams row chunks instead of materialising the full matrix. A separate
   * 4 GiB bound limits file-backed source bytes. The generation remains F16
   * on disk and is decoded through the same bounded scan window.
   */
  memoryCeilingBytes?: number
  /**
   * Directory for the derived source-matrix cache. A later run whose source
   * set fingerprint is unchanged loads the cached matrix instead of
   * re-parsing and re-normalising the JSONL shard.
   */
  matrixCacheDir?: string
}

export interface GenerationRecallReport {
  modelName: string
  embeddingType: string
  dim: number
  generationCount: number
  sourceRecordCount: number
  sourceEffectiveCount: number
  sourceValidCount: number
  sourceZeroNormRows: number
  sourceNonFiniteRows: number
  sourceDimensionMismatchRows: number
  historicalInvalidRows: number
  missingInGeneration: number
  alignedCount: number
  missingInJsonl: number
  malformedJsonlRows: number
  queryCount: number
  topK: number
  sourceLoadMode: RecallSourceLoadMode
  sourceMatrixBytes: number
  generationLoadMode: 'f16-stream'
  generationEncodedBytes: number
  generationDecodedWindowBytes: number
  sourceFingerprint: string
  memoryCeilingBytes: number
  recallAtKMean: number
  recallAtKMin: number
  rankEquivalentRecallAtKMean: number
  rankEquivalentRecallAtKMin: number
  selfTop1Rate: number
  selfInTopKRate: number
  selfWithinTop1ToleranceRate: number
  top1GapP99: number
  top1GapMax: number
  scoreErrorMedian: number
  scoreErrorP99: number
  scoreErrorMax: number
  thresholds: RecallThresholds
  gatePassed: boolean
  gateFailures: string[]
  elapsedMs: number
}

interface LoadedGenerationMatrix {
  paths: string[]
  keys: string[]
  physicalRows: Uint32Array
  dim: number
  baseCount: number
  rowBytes: number
  baseFd: number
  deltaFd: number | null
  encodedBytes: number
}

/** How the source validation matrix backs this evaluation. */
export type RecallSourceLoadMode = 'memory' | 'spill' | 'cache'

type SourceBacking =
  | { kind: 'memory'; matrix: Float32Array }
  | { kind: 'file'; fd: number; filePath: string; temporary: boolean }

interface LoadedSourceMatrix {
  paths: string[]
  keys: string[]
  dim: number
  malformed: number
  stateKeys: Set<string>
  sourceRecordCount: number
  sourceEffectiveCount: number
  sourceValidCount: number
  sourceZeroNormRows: number
  sourceNonFiniteRows: number
  sourceDimensionMismatchRows: number
  historicalInvalidRows: number
  loadMode: RecallSourceLoadMode
  matrixBytes: number
  backing: SourceBacking
}

interface LatestSourceState {
  path: string
  key: string
  issue?: EmbeddingVectorIssue
  normalized?: Float32Array
  spillRow?: number
}

export class RecallEvaluationCancelledError extends Error {
  constructor() {
    super('Recall evaluation cancelled')
    this.name = 'RecallEvaluationCancelledError'
  }
}

function throwIfCancelled(isCancelled?: () => boolean): void {
  if (isCancelled?.()) throw new RecallEvaluationCancelledError()
}

function isValidSourceState(state: LatestSourceState | undefined): boolean {
  return state !== undefined && (state.normalized !== undefined || state.spillRow !== undefined)
}

const MAX_FILE_BACKED_MATRIX_BYTES = 4 * 1024 * 1024 * 1024
const MAX_MEMORY_CEILING_BYTES = 512 * 1024 * 1024
export const DEFAULT_RECALL_MEMORY_CEILING_BYTES = 256 * 1024 * 1024
const SCAN_CHUNK_ROWS = 8192
const SOURCE_CACHE_VERSION = 1
const SOURCE_CACHE_MAX_ENTRIES = 8
// Beyond this the JSON cache metadata (paths/keys per row) outweighs the
// re-parse it saves; large sources still spill, they just are not cached.
const SOURCE_CACHE_MAX_ROWS = 250_000

/**
 * Identity of the JSONL source set, derived from path + size + mtime so an
 * unchanged source set skips both re-parsing and re-normalising. Same trust
 * level as embeddingF16CacheSourceFingerprint: deliberate mtime forgery is
 * out of scope for this internal release gate.
 */
export function recallSourceFingerprint(jsonlPaths: readonly string[]): string {
  const hash = crypto.createHash('sha256')
  for (const jsonlPath of [...jsonlPaths].sort()) {
    const stat = fs.statSync(jsonlPath)
    if (!stat.isFile()) throw new Error(`Source embedding JSONL is not a file: ${jsonlPath}`)
    hash.update(`${jsonlPath}\0${stat.size}\0${stat.mtimeMs}\0`)
  }
  return hash.digest('hex')
}

function sourceCachePaths(
  cacheDir: string,
  fingerprint: string,
): { metaPath: string; matrixPath: string } {
  return {
    metaPath: path.join(cacheDir, `source-${fingerprint}.json`),
    matrixPath: path.join(cacheDir, `source-${fingerprint}.f32`),
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

const SOURCE_COUNT_FIELDS = [
  'malformed',
  'sourceRecordCount',
  'sourceEffectiveCount',
  'sourceValidCount',
  'sourceZeroNormRows',
  'sourceNonFiniteRows',
  'sourceDimensionMismatchRows',
  'historicalInvalidRows',
] as const

function readExactBuffer(fd: number, target: Buffer, byteOffset: number, label: string): void {
  let completed = 0
  while (completed < target.byteLength) {
    const bytes = fs.readSync(
      fd,
      target,
      completed,
      target.byteLength - completed,
      byteOffset + completed,
    )
    if (bytes <= 0) throw new Error(`${label} is truncated`)
    completed += bytes
  }
}

function readExact(fd: number, target: Float32Array, byteOffset: number): void {
  readExactBuffer(
    fd,
    Buffer.from(target.buffer, target.byteOffset, target.byteLength),
    byteOffset,
    'Source matrix file',
  )
}

/**
 * Load a previously cached source matrix. Any inconsistency — version,
 * identity, shape, counts or matrix bytes — returns null so the caller
 * recomputes from the authoritative JSONL; a corrupt cache never fails or
 * skews the gate.
 */
function tryLoadCachedSourceMatrix(
  cacheDir: string,
  fingerprint: string,
  expectedDim: number,
  modelName: string,
  embeddingType: string,
  ceilingBytes: number,
): LoadedSourceMatrix | null {
  try {
    const { metaPath, matrixPath } = sourceCachePaths(cacheDir, fingerprint)
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>
    if (
      meta.version !== SOURCE_CACHE_VERSION ||
      meta.fingerprint !== fingerprint ||
      meta.modelName !== modelName ||
      meta.embeddingType !== embeddingType ||
      meta.dim !== expectedDim ||
      !isStringArray(meta.paths) ||
      !isStringArray(meta.keys) ||
      !isStringArray(meta.stateKeys) ||
      meta.paths.length !== meta.keys.length ||
      meta.sourceValidCount !== meta.paths.length ||
      !SOURCE_COUNT_FIELDS.every(
        (name) => Number.isSafeInteger(meta[name]) && (meta[name] as number) >= 0,
      )
    ) {
      return null
    }
    const stat = fs.statSync(matrixPath)
    const matrixBytes = meta.paths.length * expectedDim * 4
    if (!stat.isFile() || stat.size !== matrixBytes) return null
    const shared = {
      paths: meta.paths,
      keys: meta.keys,
      dim: expectedDim,
      malformed: meta.malformed as number,
      stateKeys: new Set(meta.stateKeys),
      sourceRecordCount: meta.sourceRecordCount as number,
      sourceEffectiveCount: meta.sourceEffectiveCount as number,
      sourceValidCount: meta.sourceValidCount as number,
      sourceZeroNormRows: meta.sourceZeroNormRows as number,
      sourceNonFiniteRows: meta.sourceNonFiniteRows as number,
      sourceDimensionMismatchRows: meta.sourceDimensionMismatchRows as number,
      historicalInvalidRows: meta.historicalInvalidRows as number,
      loadMode: 'cache' as const,
      matrixBytes,
    }
    if (matrixBytes <= ceilingBytes) {
      const matrix = new Float32Array(meta.paths.length * expectedDim)
      const fd = fs.openSync(matrixPath, 'r')
      try {
        readExact(fd, matrix, 0)
      } finally {
        fs.closeSync(fd)
      }
      return { ...shared, backing: { kind: 'memory', matrix } }
    }
    return {
      ...shared,
      backing: {
        kind: 'file',
        fd: fs.openSync(matrixPath, 'r'),
        filePath: matrixPath,
        temporary: false,
      },
    }
  } catch {
    return null
  }
}

function evictSourceCache(cacheDir: string): void {
  try {
    const entries = new Map<string, number>()
    for (const name of fs.readdirSync(cacheDir)) {
      const match = /^source-([a-f0-9]{64})\.(?:json|f32)$/.exec(name)
      if (!match) continue
      const mtime = fs.statSync(path.join(cacheDir, name)).mtimeMs
      entries.set(match[1], Math.max(entries.get(match[1]) ?? 0, mtime))
    }
    const ordered = [...entries.entries()].sort((left, right) => right[1] - left[1])
    for (const [fingerprint] of ordered.slice(SOURCE_CACHE_MAX_ENTRIES)) {
      const { metaPath, matrixPath } = sourceCachePaths(cacheDir, fingerprint)
      try {
        fs.unlinkSync(metaPath)
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(matrixPath)
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* the cache is a pure optimisation */
  }
}

/**
 * Persist the derived matrix + metadata for reuse by later cycles. In spill
 * mode the compact matrix file already sits at the cache location, so only
 * the metadata is written. Best effort: a cache write failure never fails
 * the gate.
 */
function persistSourceMatrixCache(
  cacheDir: string,
  fingerprint: string,
  modelName: string,
  embeddingType: string,
  loaded: LoadedSourceMatrix,
): void {
  if (loaded.paths.length > SOURCE_CACHE_MAX_ROWS) return
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    const { metaPath, matrixPath } = sourceCachePaths(cacheDir, fingerprint)
    if (loaded.backing.kind === 'memory') {
      const temporaryMatrix = `${matrixPath}.${process.pid}.partial`
      fs.writeFileSync(
        temporaryMatrix,
        Buffer.from(
          loaded.backing.matrix.buffer,
          loaded.backing.matrix.byteOffset,
          loaded.matrixBytes,
        ),
      )
      fs.renameSync(temporaryMatrix, matrixPath)
    }
    const meta = {
      version: SOURCE_CACHE_VERSION,
      fingerprint,
      modelName,
      embeddingType,
      dim: loaded.dim,
      paths: loaded.paths,
      keys: loaded.keys,
      stateKeys: [...loaded.stateKeys],
      malformed: loaded.malformed,
      sourceRecordCount: loaded.sourceRecordCount,
      sourceEffectiveCount: loaded.sourceEffectiveCount,
      sourceValidCount: loaded.sourceValidCount,
      sourceZeroNormRows: loaded.sourceZeroNormRows,
      sourceNonFiniteRows: loaded.sourceNonFiniteRows,
      sourceDimensionMismatchRows: loaded.sourceDimensionMismatchRows,
      historicalInvalidRows: loaded.historicalInvalidRows,
    }
    const temporaryMeta = `${metaPath}.${process.pid}.partial`
    fs.writeFileSync(temporaryMeta, JSON.stringify(meta))
    fs.renameSync(temporaryMeta, metaPath)
    evictSourceCache(cacheDir)
  } catch {
    /* the cache is a pure optimisation */
  }
}

interface LoadJsonlOptions {
  ceilingBytes: number
  fingerprint: string
  matrixCacheDir?: string
  isCancelled?: () => boolean
}

async function loadJsonlMatrix(
  jsonlPaths: readonly string[],
  expectedDim: number,
  modelName: string,
  embeddingType: string,
  options: LoadJsonlOptions,
): Promise<LoadedSourceMatrix> {
  const maxValidRows = Math.floor(MAX_FILE_BACKED_MATRIX_BYTES / (expectedDim * 4))
  const maxEffectiveRows = 1_000_000
  const rowBytes = expectedDim * 4
  const latest = new Map<string, LatestSourceState>()
  let validLatestCount = 0
  let malformed = 0
  let sourceRecordCount = 0
  let invalidPhysicalRows = 0
  let lineCounter = 0

  // Spill state: once the materialised matrix would cross the memory ceiling,
  // normalised rows are appended to a scratch file and only per-row metadata
  // stays resident. Latest-wins replacement leaves superseded rows behind, so
  // the scratch file is compacted before scanning to keep reads sequential.
  let spilled = false
  let spillFd: number | null = null
  let spillPath: string | null = null
  let spillRowCount = 0
  const closeSpill = (): void => {
    if (spillFd !== null) {
      try {
        fs.closeSync(spillFd)
      } catch {
        /* best effort */
      }
      spillFd = null
    }
  }
  const removeSpill = (): void => {
    closeSpill()
    if (spillPath !== null) {
      try {
        fs.unlinkSync(spillPath)
      } catch {
        /* best effort */
      }
      spillPath = null
    }
  }
  const spillRow = (state: LatestSourceState): void => {
    if (!state.normalized) throw new Error('Cannot spill an invalid source row')
    if (spillFd === null) {
      const spillDir = options.matrixCacheDir ?? os.tmpdir()
      fs.mkdirSync(spillDir, { recursive: true })
      spillPath = path.join(spillDir, `recall-source-spill-${process.pid}-${Date.now()}.f32`)
      spillFd = fs.openSync(spillPath, 'w')
    }
    fs.writeSync(
      spillFd,
      Buffer.from(state.normalized.buffer, state.normalized.byteOffset, rowBytes),
    )
    state.spillRow = spillRowCount
    state.normalized = undefined
    spillRowCount++
  }

  try {
    for (const jsonlPath of jsonlPaths) {
      const reader = readline.createInterface({
        input: fs.createReadStream(jsonlPath, {
          encoding: 'utf8',
          highWaterMark: 4 * 1024 * 1024,
        }),
        crlfDelay: Infinity,
      })
      for await (const line of reader) {
        lineCounter++
        if ((lineCounter & 4095) === 0) throwIfCancelled(options.isCancelled)
        if (!line) continue
        let row: {
          imageId?: unknown
          modelName?: unknown
          embeddingType?: unknown
          dim?: unknown
          vector?: unknown
        }
        try {
          row = JSON.parse(line) as typeof row
        } catch {
          malformed++
          continue
        }
        if (row.modelName !== modelName || row.embeddingType !== embeddingType) continue
        if (typeof row.imageId !== 'string') {
          malformed++
          continue
        }
        sourceRecordCount++
        const key = embeddingCachePathKey(row.imageId)
        const validation =
          row.dim === expectedDim
            ? validateEmbeddingVector(row.vector, expectedDim)
            : ({
                ok: false,
                issue: 'dimension-mismatch',
                expectedDim,
                actualDim: typeof row.dim === 'number' ? row.dim : undefined,
              } as const)
        const previous = latest.get(key)
        const nextValidCount =
          validLatestCount - (isValidSourceState(previous) ? 1 : 0) + (validation.ok ? 1 : 0)
        if (nextValidCount > maxValidRows) {
          reader.close()
          throw new Error('Source recall matrix exceeds the 4 GiB file-backed safety limit')
        }
        if (!previous && latest.size >= maxEffectiveRows) {
          reader.close()
          throw new Error(`Source recall state count exceeds ${maxEffectiveRows}`)
        }
        const state: LatestSourceState = validation.ok
          ? {
              path: row.imageId,
              key,
              normalized: Float32Array.from(
                row.vector as number[] | Float32Array,
                (value) => value / validation.scale / validation.scaledNorm,
              ),
            }
          : { path: row.imageId, key, issue: validation.issue }
        if (!validation.ok) invalidPhysicalRows++
        latest.delete(key)
        latest.set(key, state)
        validLatestCount = nextValidCount
        if (!spilled && validLatestCount * rowBytes > options.ceilingBytes) {
          spilled = true
          for (const resident of latest.values()) {
            if (resident.normalized) spillRow(resident)
          }
        } else if (spilled && state.normalized) {
          spillRow(state)
        }
      }
    }

    const paths: string[] = []
    const keys: string[] = []
    const validStates: LatestSourceState[] = []
    let sourceZeroNormRows = 0
    let sourceNonFiniteRows = 0
    let sourceDimensionMismatchRows = 0
    for (const state of latest.values()) {
      if (isValidSourceState(state)) {
        paths.push(state.path)
        keys.push(state.key)
        validStates.push(state)
      } else if (state.issue === 'zero-norm') sourceZeroNormRows++
      else if (state.issue === 'non-finite') sourceNonFiniteRows++
      else sourceDimensionMismatchRows++
    }
    const matrixBytes = validStates.length * rowBytes
    const currentInvalidRows =
      sourceZeroNormRows + sourceNonFiniteRows + sourceDimensionMismatchRows
    const shared = {
      paths,
      keys,
      dim: expectedDim,
      malformed,
      stateKeys: new Set(latest.keys()),
      sourceRecordCount,
      sourceEffectiveCount: latest.size,
      sourceValidCount: paths.length,
      sourceZeroNormRows,
      sourceNonFiniteRows,
      sourceDimensionMismatchRows,
      historicalInvalidRows: Math.max(0, invalidPhysicalRows - currentInvalidRows),
      matrixBytes,
    }
    if (!spilled) {
      const matrix = new Float32Array(validStates.length * expectedDim)
      for (let index = 0; index < validStates.length; index++) {
        matrix.set(validStates[index].normalized!, index * expectedDim)
      }
      return { ...shared, loadMode: 'memory', backing: { kind: 'memory', matrix } }
    }

    // Compact the spill file (final rows only, in final order). When the
    // cache is enabled and the row count is cacheable, the compact file
    // doubles as the cached matrix so later cycles stream it directly.
    closeSpill()
    const useCache =
      options.matrixCacheDir !== undefined && validStates.length <= SOURCE_CACHE_MAX_ROWS
    const compactPath = useCache
      ? sourceCachePaths(options.matrixCacheDir!, options.fingerprint).matrixPath
      : path.join(
          options.matrixCacheDir ?? os.tmpdir(),
          `recall-source-compact-${process.pid}-${Date.now()}.f32`,
        )
    const temporaryCompact = `${compactPath}.${process.pid}.partial`
    const scratch = new Float32Array(expectedDim)
    const spillReadFd = fs.openSync(spillPath!, 'r')
    const compactFd = fs.openSync(temporaryCompact, 'w')
    try {
      for (const state of validStates) {
        readExact(spillReadFd, scratch, state.spillRow! * rowBytes)
        fs.writeSync(compactFd, Buffer.from(scratch.buffer, 0, rowBytes))
      }
    } finally {
      fs.closeSync(compactFd)
      fs.closeSync(spillReadFd)
    }
    fs.renameSync(temporaryCompact, compactPath)
    removeSpill()
    return {
      ...shared,
      loadMode: 'spill',
      backing: {
        kind: 'file',
        fd: fs.openSync(compactPath, 'r'),
        filePath: compactPath,
        temporary: !useCache,
      },
    }
  } catch (error) {
    removeSpill()
    throw error
  }
}

interface GenerationRow {
  row: number
  path: string
}

function loadGenerationMatrix(handle: GenerationRecallVectorSource): LoadedGenerationMatrix {
  const dim = handle.meta.dim
  const count = handle.meta.count
  if (!Number.isSafeInteger(dim) || dim <= 0 || dim > MAX_EMBEDDING_VECTOR_DIM) {
    throw new Error(`Generation dimension is invalid: ${dim}`)
  }
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) {
    throw new Error(`Generation count is invalid: ${count}`)
  }
  const baseCount = handle.delta ? handle.delta.baseCount : count
  if (!Number.isSafeInteger(baseCount) || baseCount < 0 || baseCount > count) {
    throw new Error(`Generation base count is invalid: ${baseCount}`)
  }
  const rowBytes = dim * 2
  const encodedBytes = count * rowBytes
  if (!Number.isSafeInteger(encodedBytes) || encodedBytes > MAX_FILE_BACKED_MATRIX_BYTES) {
    throw new Error('Generation recall matrix exceeds the 4 GiB encoded safety limit')
  }
  const expectedBaseBytes = baseCount * rowBytes
  const baseStat = fs.statSync(handle.vectorPath)
  if (!baseStat.isFile() || baseStat.size !== expectedBaseBytes) {
    throw new Error(
      `Generation vector file size mismatch: expected ${expectedBaseBytes}, got ${baseStat.size}`,
    )
  }
  if (handle.delta) {
    const deltaCount = count - baseCount
    const requiredDeltaBytes = deltaCount * rowBytes
    const deltaStat = fs.statSync(handle.delta.vectorPath)
    if (!deltaStat.isFile() || deltaStat.size < requiredDeltaBytes) {
      throw new Error(
        `Delta vector file size mismatch: expected at least ${requiredDeltaBytes}, got ${deltaStat.size}`,
      )
    }
  }
  const rowsByPhysicalIndex = new Map<number, GenerationRow>()
  const indexFiles = handle.delta
    ? [handle.pathIndexPath, handle.delta.pathIndexPath]
    : [handle.pathIndexPath]
  for (const indexFile of indexFiles) {
    const indexStat = fs.statSync(indexFile)
    if (!indexStat.isFile() || indexStat.size > 256 * 1024 * 1024) {
      throw new Error(`Generation path index exceeds the 256 MiB safety limit: ${indexFile}`)
    }
    const pathLines = fs.readFileSync(indexFile, 'utf8').split(/\r?\n/)
    for (const line of pathLines) {
      if (!line) continue
      let item: { row?: unknown; path?: unknown }
      try {
        item = JSON.parse(line) as { row?: unknown; path?: unknown }
      } catch {
        throw new Error(`Generation path index contains malformed JSON: ${indexFile}`)
      }
      if (!Number.isSafeInteger(item.row) || typeof item.path !== 'string') {
        throw new Error(`Generation path index contains an invalid row: ${indexFile}`)
      }
      const row = item.row as number
      if (row < 0 || row >= count) {
        throw new Error(`Generation path index row is out of range: ${row}`)
      }
      if (item.path.length === 0)
        throw new Error(`Generation path index row ${row} has an empty path`)
      if (rowsByPhysicalIndex.has(row)) {
        throw new Error(`Generation path index contains duplicate row ${row}`)
      }
      rowsByPhysicalIndex.set(row, { row, path: item.path })
    }
  }
  if (rowsByPhysicalIndex.size !== count) {
    throw new Error(
      `Generation path index row count mismatch: expected ${count}, got ${rowsByPhysicalIndex.size}`,
    )
  }
  const latestByKey = new Map<string, GenerationRow>()
  for (let row = 0; row < count; row++) {
    const item = rowsByPhysicalIndex.get(row)!
    const key = embeddingCachePathKey(item.path)
    latestByKey.delete(key)
    latestByKey.set(key, item)
  }
  const latestRows = [...latestByKey.values()].sort((left, right) => left.row - right.row)
  const paths: string[] = []
  const keys: string[] = []
  const physicalRows = new Uint32Array(latestRows.length)
  for (let index = 0; index < latestRows.length; index++) {
    const item = latestRows[index]
    physicalRows[index] = item.row
    paths.push(item.path)
    keys.push(embeddingCachePathKey(item.path))
  }
  const baseFd = fs.openSync(handle.vectorPath, 'r')
  try {
    const deltaFd = handle.delta ? fs.openSync(handle.delta.vectorPath, 'r') : null
    return {
      paths,
      keys,
      physicalRows,
      dim,
      baseCount,
      rowBytes,
      baseFd,
      deltaFd,
      encodedBytes,
    }
  } catch (error) {
    fs.closeSync(baseFd)
    throw error
  }
}

function closeGenerationMatrix(generation: LoadedGenerationMatrix): void {
  try {
    fs.closeSync(generation.baseFd)
  } catch {
    /* already closed */
  }
  if (generation.deltaFd !== null) {
    try {
      fs.closeSync(generation.deltaFd)
    } catch {
      /* already closed */
    }
  }
}

interface TopKEntry {
  index: number
  score: number
}

/** Fixed-capacity min-heap of the K highest scores. */
class TopKHeap {
  private readonly heap: TopKEntry[] = []

  constructor(private readonly capacity: number) {}

  push(entry: TopKEntry): void {
    if (this.heap.length < this.capacity) {
      this.heap.push(entry)
      let child = this.heap.length - 1
      while (child > 0) {
        const parent = (child - 1) >> 1
        if (this.heap[parent].score <= this.heap[child].score) break
        const temp = this.heap[parent]
        this.heap[parent] = this.heap[child]
        this.heap[child] = temp
        child = parent
      }
      return
    }
    if (entry.score <= this.heap[0].score) return
    this.heap[0] = entry
    let parent = 0
    for (;;) {
      const left = parent * 2 + 1
      if (left >= this.heap.length) break
      const right = left + 1
      const smaller =
        right < this.heap.length && this.heap[right].score < this.heap[left].score ? right : left
      if (this.heap[parent].score <= this.heap[smaller].score) break
      const temp = this.heap[parent]
      this.heap[parent] = this.heap[smaller]
      this.heap[smaller] = temp
      parent = smaller
    }
  }

  entries(): TopKEntry[] {
    return [...this.heap].sort((left, right) => right.score - left.score)
  }
}

interface SourceAccessor {
  rowCount: number
  dim: number
  /** Copy a single row into a fresh array that callers may retain. */
  readRow(row: number): Float32Array
  /** Copy a single row into a caller-owned scratch array. */
  fillRow(row: number, target: Float32Array): void
  /** Sequential chunked pass over every row; chunk storage is reused. */
  forEachChunk(
    visit: (startRow: number, chunk: Float32Array, rowsInChunk: number) => void,
    isCancelled?: () => boolean,
  ): void
}

function createGenerationAccessor(generation: LoadedGenerationMatrix): SourceAccessor {
  const { dim, rowBytes, baseCount, physicalRows } = generation
  const decodeRows = (
    encoded: Buffer,
    target: Float32Array,
    rows: number,
    logicalStart: number,
  ): void => {
    for (let row = 0; row < rows; row++) {
      const targetOffset = row * dim
      const encodedOffset = row * rowBytes
      const decodedRow = target.subarray(targetOffset, targetOffset + dim)
      for (let component = 0; component < dim; component++) {
        decodedRow[component] = float16ToFloat32(
          encoded.readUInt16LE(encodedOffset + component * 2),
        )
      }
      const validation = validateEmbeddingVector(decodedRow, dim)
      if (!validation.ok) {
        throw new Error(
          `Generation vector row ${physicalRows[logicalStart + row]} is invalid: ${validation.issue}`,
        )
      }
      for (let component = 0; component < dim; component++) {
        decodedRow[component] /= validation.scale * validation.scaledNorm
      }
    }
  }
  const readSpan = (
    logicalStart: number,
    rows: number,
    encoded: Buffer,
    decoded: Float32Array,
  ): void => {
    const physicalStart = physicalRows[logicalStart]
    const inDelta = physicalStart >= baseCount
    const fd = inDelta ? generation.deltaFd : generation.baseFd
    if (fd === null) throw new Error(`Generation row ${physicalStart} has no vector segment`)
    const segmentRow = inDelta ? physicalStart - baseCount : physicalStart
    const encodedView = encoded.subarray(0, rows * rowBytes)
    readExactBuffer(
      fd,
      encodedView,
      segmentRow * rowBytes,
      `Generation vector row ${physicalStart}`,
    )
    decodeRows(encodedView, decoded, rows, logicalStart)
  }
  return {
    rowCount: physicalRows.length,
    dim,
    readRow: (row) => {
      const decoded = new Float32Array(dim)
      readSpan(row, 1, Buffer.allocUnsafe(rowBytes), decoded)
      return decoded
    },
    fillRow: (row, target) => {
      readSpan(row, 1, Buffer.allocUnsafe(rowBytes), target)
    },
    forEachChunk: (visit, isCancelled) => {
      const encoded = Buffer.allocUnsafe(SCAN_CHUNK_ROWS * rowBytes)
      const decoded = new Float32Array(SCAN_CHUNK_ROWS * dim)
      let logicalStart = 0
      while (logicalStart < physicalRows.length) {
        throwIfCancelled(isCancelled)
        const firstPhysical = physicalRows[logicalStart]
        const firstInDelta = firstPhysical >= baseCount
        let rows = 1
        while (rows < SCAN_CHUNK_ROWS && logicalStart + rows < physicalRows.length) {
          const physical = physicalRows[logicalStart + rows]
          if (physical !== firstPhysical + rows || physical >= baseCount !== firstInDelta) break
          rows++
        }
        readSpan(logicalStart, rows, encoded, decoded)
        visit(logicalStart, decoded.subarray(0, rows * dim), rows)
        logicalStart += rows
      }
    },
  }
}

function createSourceAccessor(source: LoadedSourceMatrix): SourceAccessor {
  const dim = source.dim
  const rowBytes = dim * 4
  const rowCount = source.paths.length
  if (source.backing.kind === 'memory') {
    const matrix = source.backing.matrix
    return {
      rowCount,
      dim,
      readRow: (row) => matrix.slice(row * dim, (row + 1) * dim),
      fillRow: (row, target) => {
        target.set(matrix.subarray(row * dim, (row + 1) * dim))
      },
      forEachChunk: (visit, isCancelled) => {
        for (let start = 0; start < rowCount; start += SCAN_CHUNK_ROWS) {
          throwIfCancelled(isCancelled)
          const rows = Math.min(SCAN_CHUNK_ROWS, rowCount - start)
          visit(start, matrix.subarray(start * dim, (start + rows) * dim), rows)
        }
      },
    }
  }
  const { fd } = source.backing
  return {
    rowCount,
    dim,
    readRow: (row) => {
      const values = new Float32Array(dim)
      readExact(fd, values, row * rowBytes)
      return values
    },
    fillRow: (row, target) => {
      readExact(fd, target, row * rowBytes)
    },
    forEachChunk: (visit, isCancelled) => {
      const chunk = new Float32Array(SCAN_CHUNK_ROWS * dim)
      for (let start = 0; start < rowCount; start += SCAN_CHUNK_ROWS) {
        throwIfCancelled(isCancelled)
        const rows = Math.min(SCAN_CHUNK_ROWS, rowCount - start)
        readExact(fd, chunk.subarray(0, rows * dim), start * rowBytes)
        visit(start, chunk.subarray(0, rows * dim), rows)
      }
    },
  }
}

function closeSourceMatrix(source: LoadedSourceMatrix): void {
  if (source.backing.kind !== 'file') return
  try {
    fs.closeSync(source.backing.fd)
  } catch {
    /* already closed */
  }
  if (source.backing.temporary) {
    try {
      fs.unlinkSync(source.backing.filePath)
    } catch {
      /* best effort */
    }
  }
}

/**
 * Exact F32 top-K of every sampled query against the source matrix in one
 * chunked pass. Row norms are computed once per row (not once per query) and
 * only one chunk is resident at a time, so a file-backed source scans at the
 * same speed without materialising the matrix.
 */
function scanSourceTopKAll(
  accessor: SourceAccessor,
  queries: readonly Float32Array[],
  queryNorms: readonly number[],
  topK: number,
  isCancelled: (() => boolean) | undefined,
  onChunk?: (rowsScanned: number) => void,
): TopKEntry[][] {
  const dim = accessor.dim
  const heaps = queries.map(() => new TopKHeap(topK))
  accessor.forEachChunk((startRow, chunk, rowsInChunk) => {
    for (let row = 0; row < rowsInChunk; row++) {
      const base = row * dim
      let normSquared = 0
      for (let index = 0; index < dim; index++) {
        const value = chunk[base + index]
        normSquared += value * value
      }
      const norm = Math.sqrt(normSquared)
      if (norm === 0) continue
      const rowIndex = startRow + row
      for (let q = 0; q < queries.length; q++) {
        const queryNorm = queryNorms[q]
        if (queryNorm === 0) continue
        const query = queries[q]
        let dot = 0
        for (let index = 0; index < dim; index++) dot += query[index] * chunk[base + index]
        heaps[q].push({ index: rowIndex, score: dot / (norm * queryNorm) })
      }
    }
    onChunk?.(startRow + rowsInChunk)
  }, isCancelled)
  return heaps.map((heap) => heap.entries())
}

function scoreSourceRow(
  accessor: SourceAccessor,
  scratch: Float32Array,
  row: number,
  query: Float32Array,
  queryNorm: number,
): number | null {
  accessor.fillRow(row, scratch)
  let dot = 0
  let normSquared = 0
  for (let index = 0; index < accessor.dim; index++) {
    const value = scratch[index]
    dot += query[index] * value
    normSquared += value * value
  }
  const norm = Math.sqrt(normSquared)
  if (norm === 0 || queryNorm === 0) return null
  return dot / (norm * queryNorm)
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
  return sorted[index]
}

function boundedPositiveOption(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new RangeError(`${name} must be a positive safe integer <= ${maximum}`)
  }
  return resolved
}

function validateThresholds(thresholds: RecallThresholds): void {
  for (const name of [
    'minRecallAtK',
    'minSelfInTopKRate',
    'maxTop1Gap',
    'maxMedianScoreError',
    'maxP99ScoreError',
  ] as const) {
    const value = thresholds?.[name]
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Recall threshold ${name} must be a finite non-negative number`)
    }
  }
  if (thresholds.minRecallAtK > 1 || thresholds.minSelfInTopKRate > 1) {
    throw new RangeError('Recall rate thresholds must not exceed 1')
  }
}

function stratifiedSampleRows(
  alignedRows: readonly number[],
  requestedCount: number,
  seed: number,
): number[] {
  const alignedCount = alignedRows.length
  const sampleCount = Math.min(alignedCount, requestedCount)
  if (sampleCount === 0) return []

  const uint32Range = 0x1_0000_0000
  let state = ((seed % uint32Range) + uint32Range) % uint32Range
  const nextUint32 = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }

  const sampled: number[] = []
  for (let bucket = 0; bucket < sampleCount; bucket++) {
    const start = Math.floor((bucket * alignedCount) / sampleCount)
    const endExclusive = Math.floor(((bucket + 1) * alignedCount) / sampleCount)
    const offset = nextUint32() % (endExclusive - start)
    sampled.push(alignedRows[start + offset])
  }
  return sampled
}

export async function evaluateGenerationRecall(
  jsonlPath: string | readonly string[],
  handle: GenerationRecallVectorSource,
  options: GenerationRecallOptions = {},
): Promise<GenerationRecallReport> {
  const started = Date.now()
  if (
    typeof handle.meta.modelName !== 'string' ||
    handle.meta.modelName.length === 0 ||
    typeof handle.meta.embeddingType !== 'string' ||
    handle.meta.embeddingType.length === 0
  ) {
    throw new Error('Generation model identity is invalid')
  }
  if (
    !Number.isSafeInteger(handle.meta.dim) ||
    handle.meta.dim <= 0 ||
    handle.meta.dim > MAX_EMBEDDING_VECTOR_DIM
  ) {
    throw new Error(`Generation dimension is invalid: ${handle.meta.dim}`)
  }
  const queryCount = boundedPositiveOption('queryCount', options.queryCount, 200, 10_000)
  const topK = boundedPositiveOption('topK', options.topK, 50, 5_000)
  const seed = options.seed ?? 20260804
  if (!Number.isSafeInteger(seed)) throw new RangeError('seed must be a safe integer')
  const thresholds = options.thresholds ?? DEFAULT_RECALL_THRESHOLDS
  validateThresholds(thresholds)
  const ceilingBytes = options.memoryCeilingBytes ?? DEFAULT_RECALL_MEMORY_CEILING_BYTES
  if (
    !Number.isSafeInteger(ceilingBytes) ||
    ceilingBytes <= 0 ||
    ceilingBytes > MAX_MEMORY_CEILING_BYTES
  ) {
    throw new RangeError(
      `memoryCeilingBytes must be a positive safe integer <= ${MAX_MEMORY_CEILING_BYTES}`,
    )
  }
  const isCancelled = options.isCancelled
  const onProgress = options.onProgress

  onProgress?.({ phase: 'load-jsonl', current: 0, total: 1 })
  const jsonlPaths = typeof jsonlPath === 'string' ? [jsonlPath] : [...jsonlPath]
  if (jsonlPaths.length === 0) throw new Error('At least one JSONL source path is required')
  throwIfCancelled(isCancelled)
  const sourceFingerprint = recallSourceFingerprint(jsonlPaths)
  const cacheDir = options.matrixCacheDir
  let jsonl = cacheDir
    ? tryLoadCachedSourceMatrix(
        cacheDir,
        sourceFingerprint,
        handle.meta.dim,
        handle.meta.modelName,
        handle.meta.embeddingType,
        ceilingBytes,
      )
    : null
  jsonl ??= await loadJsonlMatrix(
    jsonlPaths,
    handle.meta.dim,
    handle.meta.modelName,
    handle.meta.embeddingType,
    {
      ceilingBytes,
      fingerprint: sourceFingerprint,
      matrixCacheDir: cacheDir,
      isCancelled,
    },
  )
  let generation: LoadedGenerationMatrix | null = null
  try {
    onProgress?.({ phase: 'load-generation', current: 0, total: 1 })
    generation = loadGenerationMatrix(handle)
    const currentGeneration = generation
    throwIfCancelled(isCancelled)

    const jsonlIndexByKey = new Map(jsonl.keys.map((key, index) => [key, index]))
    const generationKeySet = new Set(currentGeneration.keys)
    let missingInGeneration = 0
    for (const key of jsonl.keys) {
      if (!generationKeySet.has(key)) missingInGeneration++
    }
    const alignedJsonlRows: number[] = []
    let missingInJsonl = 0
    for (let row = 0; row < currentGeneration.keys.length; row++) {
      const key = currentGeneration.keys[row]
      if (!jsonl.stateKeys.has(key)) missingInJsonl++
      const jsonlIndex = jsonlIndexByKey.get(key)
      alignedJsonlRows.push(jsonlIndex ?? -1)
    }
    const alignedRows: number[] = []
    for (let row = 0; row < alignedJsonlRows.length; row++) {
      if (alignedJsonlRows[row] >= 0) alignedRows.push(row)
    }
    const alignedCount = alignedRows.length
    const queryRows = stratifiedSampleRows(alignedRows, queryCount, seed)

    const dim = currentGeneration.dim
    const recalls: number[] = []
    const rankEquivalentRecalls: number[] = []
    const scoreErrors: number[] = []
    const top1Gaps: number[] = []
    let selfTop1 = 0
    let selfInTopK = 0
    let selfWithinTop1Tolerance = 0
    const accessor = createSourceAccessor(jsonl)
    const generationAccessor = createGenerationAccessor(currentGeneration)
    const queryVectors = queryRows.map((generationRow) =>
      accessor.readRow(alignedJsonlRows[generationRow]),
    )
    const queryNorms = queryVectors.map((query) => {
      let norm = 0
      for (let index = 0; index < dim; index++) norm += query[index] * query[index]
      return Math.sqrt(norm)
    })
    // Exact F32 top-K for every sampled query in one chunked source pass; a
    // file-backed (spilled or cached) source streams chunks instead of
    // materialising the matrix.
    onProgress?.({ phase: 'scan-source', current: 0, total: accessor.rowCount })
    const f32Tops = scanSourceTopKAll(
      accessor,
      queryVectors,
      queryNorms,
      topK,
      isCancelled,
      (rows) => onProgress?.({ phase: 'scan-source', current: rows, total: accessor.rowCount }),
    )
    onProgress?.({ phase: 'scan-generation', current: 0, total: generationAccessor.rowCount })
    const f16Tops = scanSourceTopKAll(
      generationAccessor,
      queryVectors,
      queryNorms,
      topK,
      isCancelled,
      (rows) =>
        onProgress?.({
          phase: 'scan-generation',
          current: rows,
          total: generationAccessor.rowCount,
        }),
    )
    const sourceRowScratch = new Float32Array(dim)
    const generationRowScratch = new Float32Array(dim)
    for (let q = 0; q < queryRows.length; q++) {
      throwIfCancelled(isCancelled)
      const generationRow = queryRows[q]
      const query = queryVectors[q]
      const queryNorm = queryNorms[q]

      const f32Top = f32Tops[q]
      const f16Top = f16Tops[q]
      const f16Set = new Set(f16Top.map((entry) => currentGeneration.keys[entry.index]))
      const f32Keys = f32Top.map((entry) => jsonl.keys[entry.index])
      const overlap = f32Keys.filter((key) => f16Set.has(key)).length
      recalls.push(overlap / Math.max(1, f32Keys.length))

      // Path overlap is retained as a strict diagnostic, but it is unstable at
      // a dense top-K boundary: F16 quantisation can swap visually equivalent
      // neighbours whose exact F32 scores differ by less than the accepted
      // score tolerance. Gate on the exact-F32 relevance of every returned F16
      // candidate so a near-tie swap passes while a path/vector mismatch does
      // not.
      const f32BoundaryScore = f32Top[f32Top.length - 1]?.score
      let rankEquivalent = 0
      for (const entry of f16Top) {
        const candidateJsonlRow = alignedJsonlRows[entry.index]
        if (candidateJsonlRow < 0) continue
        const exactScore = scoreSourceRow(
          accessor,
          sourceRowScratch,
          candidateJsonlRow,
          query,
          queryNorm,
        )
        if (exactScore === null) continue
        scoreErrors.push(Math.abs(entry.score - exactScore))
        if (
          f32BoundaryScore !== undefined &&
          exactScore + thresholds.maxTop1Gap >= f32BoundaryScore
        ) {
          rankEquivalent++
        }
      }
      rankEquivalentRecalls.push(rankEquivalent / Math.max(1, f32Top.length))

      const selfKey = currentGeneration.keys[generationRow]
      if (f16Top.length > 0 && currentGeneration.keys[f16Top[0].index] === selfKey) selfTop1++
      const selfEntry = f16Top.find((entry) => currentGeneration.keys[entry.index] === selfKey)
      if (selfEntry) selfInTopK++
      // How far the self score trails the F16 top-1. Datasets with exact or
      // near duplicates legitimately tie here; a large gap is the real defect.
      generationAccessor.fillRow(generationRow, generationRowScratch)
      let selfDot = 0
      let selfNormSquared = 0
      for (let index = 0; index < dim; index++) {
        const value = generationRowScratch[index]
        selfDot += query[index] * value
        selfNormSquared += value * value
      }
      const selfNorm = Math.sqrt(selfNormSquared)
      const selfScore = selfNorm > 0 && queryNorm > 0 ? selfDot / (selfNorm * queryNorm) : 0
      const top1Score = f16Top.length > 0 ? f16Top[0].score : 0
      const top1Gap = Math.max(0, top1Score - selfScore)
      top1Gaps.push(top1Gap)
      if (top1Gap <= thresholds.maxTop1Gap) selfWithinTop1Tolerance++
      onProgress?.({ phase: 'queries', current: q + 1, total: queryRows.length })
    }

    const sortedRecalls = [...recalls].sort((left, right) => left - right)
    const sortedRankEquivalentRecalls = [...rankEquivalentRecalls].sort(
      (left, right) => left - right,
    )
    const sortedErrors = [...scoreErrors].sort((left, right) => left - right)
    const sortedGaps = [...top1Gaps].sort((left, right) => left - right)
    const recallAtKMean =
      recalls.length > 0 ? recalls.reduce((sum, value) => sum + value, 0) / recalls.length : 0
    const recallAtKMin = sortedRecalls[0] ?? 0
    const rankEquivalentRecallAtKMean =
      rankEquivalentRecalls.length > 0
        ? rankEquivalentRecalls.reduce((sum, value) => sum + value, 0) /
          rankEquivalentRecalls.length
        : 0
    const rankEquivalentRecallAtKMin = sortedRankEquivalentRecalls[0] ?? 0
    const selfTop1Rate = queryRows.length > 0 ? selfTop1 / queryRows.length : 0
    const selfInTopKRate = queryRows.length > 0 ? selfInTopK / queryRows.length : 0
    const selfWithinTop1ToleranceRate =
      queryRows.length > 0 ? selfWithinTop1Tolerance / queryRows.length : 0
    const top1GapP99 = percentile(sortedGaps, 0.99)
    const top1GapMax = sortedGaps.length > 0 ? sortedGaps[sortedGaps.length - 1] : 0
    const scoreErrorMedian = percentile(sortedErrors, 0.5)
    const scoreErrorP99 = percentile(sortedErrors, 0.99)
    const scoreErrorMax = sortedErrors.length > 0 ? sortedErrors[sortedErrors.length - 1] : 0

    const gateFailures: string[] = []
    if (jsonl.sourceZeroNormRows > 0) {
      gateFailures.push(`source has ${jsonl.sourceZeroNormRows} current zero-norm vector(s)`)
    }
    if (jsonl.sourceNonFiniteRows > 0) {
      gateFailures.push(`source has ${jsonl.sourceNonFiniteRows} current non-finite vector(s)`)
    }
    if (jsonl.sourceDimensionMismatchRows > 0) {
      gateFailures.push(
        `source has ${jsonl.sourceDimensionMismatchRows} current dimension/container mismatch(es)`,
      )
    }
    if (missingInGeneration > 0) {
      gateFailures.push(`generation is missing ${missingInGeneration} current source path(s)`)
    }
    if (missingInJsonl > 0) {
      gateFailures.push(`generation has ${missingInJsonl} path(s) missing from the current source`)
    }
    if (jsonl.malformed > 0) {
      gateFailures.push(`source has ${jsonl.malformed} malformed row(s)`)
    }
    if (alignedCount === 0) gateFailures.push('no valid paths align between source and generation')
    if (rankEquivalentRecallAtKMean < thresholds.minRecallAtK) {
      gateFailures.push(
        `recall@${topK} rank-equivalent mean ${rankEquivalentRecallAtKMean.toFixed(4)} < ${thresholds.minRecallAtK}`,
      )
    }
    if (selfWithinTop1ToleranceRate < thresholds.minSelfInTopKRate) {
      gateFailures.push(
        `self-query top-1-equivalent rate ${selfWithinTop1ToleranceRate.toFixed(4)} < ${thresholds.minSelfInTopKRate}`,
      )
    }
    if (top1GapP99 > thresholds.maxTop1Gap) {
      gateFailures.push(
        `top-1 score gap p99 ${top1GapP99.toExponential(2)} > ${thresholds.maxTop1Gap}`,
      )
    }
    if (scoreErrorMedian > thresholds.maxMedianScoreError) {
      gateFailures.push(
        `median score error ${scoreErrorMedian.toExponential(2)} > ${thresholds.maxMedianScoreError}`,
      )
    }
    if (scoreErrorP99 > thresholds.maxP99ScoreError) {
      gateFailures.push(
        `p99 score error ${scoreErrorP99.toExponential(2)} > ${thresholds.maxP99ScoreError}`,
      )
    }

    const report: GenerationRecallReport = {
      modelName: handle.meta.modelName,
      embeddingType: handle.meta.embeddingType,
      dim,
      generationCount: handle.meta.count,
      sourceRecordCount: jsonl.sourceRecordCount,
      sourceEffectiveCount: jsonl.sourceEffectiveCount,
      sourceValidCount: jsonl.sourceValidCount,
      sourceZeroNormRows: jsonl.sourceZeroNormRows,
      sourceNonFiniteRows: jsonl.sourceNonFiniteRows,
      sourceDimensionMismatchRows: jsonl.sourceDimensionMismatchRows,
      historicalInvalidRows: jsonl.historicalInvalidRows,
      missingInGeneration,
      alignedCount,
      missingInJsonl,
      malformedJsonlRows: jsonl.malformed,
      queryCount: queryRows.length,
      topK,
      sourceLoadMode: jsonl.loadMode,
      sourceMatrixBytes: jsonl.matrixBytes,
      generationLoadMode: 'f16-stream',
      generationEncodedBytes: currentGeneration.encodedBytes,
      generationDecodedWindowBytes:
        Math.min(currentGeneration.paths.length, SCAN_CHUNK_ROWS) * dim * 4,
      sourceFingerprint,
      memoryCeilingBytes: ceilingBytes,
      recallAtKMean,
      recallAtKMin,
      rankEquivalentRecallAtKMean,
      rankEquivalentRecallAtKMin,
      selfTop1Rate,
      selfInTopKRate,
      selfWithinTop1ToleranceRate,
      top1GapP99,
      top1GapMax,
      scoreErrorMedian,
      scoreErrorP99,
      scoreErrorMax,
      thresholds,
      gatePassed: gateFailures.length === 0,
      gateFailures,
      elapsedMs: Date.now() - started,
    }
    if (cacheDir && jsonl.loadMode !== 'cache') {
      persistSourceMatrixCache(
        cacheDir,
        sourceFingerprint,
        handle.meta.modelName,
        handle.meta.embeddingType,
        jsonl,
      )
    }
    return report
  } finally {
    if (generation) closeGenerationMatrix(generation)
    closeSourceMatrix(jsonl)
  }
}
