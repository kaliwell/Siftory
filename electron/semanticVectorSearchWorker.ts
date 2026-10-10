// ── CLIP semantic vector search worker (VAL-028) ──
// Runs the exact F16 scan off the main process: the cache vectors are loaded
// once per cache generation (shared across queries, not cloned per query) and
// the F16 decode is fused into the dot-product loop through a 64 Ki-entry
// lookup table, so no per-row Float32Array is materialized. Scoring,
// tie-break, and scan order reuse BoundedSemanticCandidateHeap from
// semanticClipScan.ts, keeping results bit-identical to the in-process
// reference scan (parity fixture: tests/semantic-vector-search-worker.test.cjs).

import fs from 'fs'
import { parentPort } from 'worker_threads'
import {
  noteEmbeddingCacheIntegrityFailure,
  verifyEmbeddingCacheFileProof,
} from './embeddingCacheIntegrity'
import {
  embeddingCachePathKey,
  float16ToFloat32,
  readEmbeddingF16CacheLatestPathRowsSync,
  type EmbeddingF16CacheHandle,
} from './embeddingF16Cache'
import { BoundedSemanticCandidateHeap, type SemanticClipCandidate } from './semanticClipScan'

export interface SemanticVectorWorkerSearchRequest {
  type: 'search'
  requestId: number
  cache: EmbeddingF16CacheHandle
  queryVector: number[]
  candidateK: number
  stopBuffer: SharedArrayBuffer
  /**
   * Scope protocol: 0 clears the scope (accept every row). A positive id
   * references the scope snapshot already held by this worker; the full key
   * list travels only when it changes (scopeKeys), so the per-query
   * structured clone of large scope sets disappears (VAL-035).
   */
  scopeId: number
  scopeKeys?: string[]
}

export interface SemanticVectorWorkerScanResult {
  candidates: SemanticClipCandidate[]
  scanned: number
  total: number
  loadMs: number
  searchMs: number
  cacheReused: boolean
}

interface LoadedSemanticCache {
  key: string
  dim: number
  vectors: Uint16Array
  rows: Array<{ row: number; path: string; key: string }>
}

let loaded: LoadedSemanticCache | null = null
let loadedScope: { id: number; set: Set<string> } | null = null
let f16Lut: Float32Array | null = null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** float16ToFloat32 for every possible half, built once per worker process. */
function float16Lut(): Float32Array {
  if (!f16Lut) {
    f16Lut = new Float32Array(0x10000)
    for (let value = 0; value < 0x10000; value++) f16Lut[value] = float16ToFloat32(value)
  }
  return f16Lut
}

function cacheKey(cache: EmbeddingF16CacheHandle): string {
  return JSON.stringify({
    vectorPath: cache.vectorPath,
    generation: cache.meta.generation || null,
    version: cache.meta.version,
    modelName: cache.meta.modelName,
    embeddingType: cache.meta.embeddingType,
    dim: cache.meta.dim,
    count: cache.meta.count,
    sourceRecordCount: cache.meta.sourceRecordCount,
    sourceFiles: cache.meta.sourceFiles,
    deltaVectorPath: cache.delta?.vectorPath || null,
    deltaBaseCount: cache.delta?.baseCount ?? null,
  })
}

/**
 * Fail-closed integrity gate (VAL-038): handles minted from disk carry the
 * committed content proofs of every segment; re-verify them (memoized per
 * on-disk state) before the bytes are read into the worker. Handles without
 * proofs are synthetic legacy callers and keep the legacy behavior.
 */
function assertSemanticVectorCacheIntegrity(cache: EmbeddingF16CacheHandle): void {
  const integrity = cache.integrity
  if (!integrity) return
  const fail = (segment: string): never => {
    noteEmbeddingCacheIntegrityFailure(
      'semantic-vector-worker',
      `${segment} failed its content proof (${cache.vectorPath})`,
    )
    throw new Error(`Semantic vector cache ${segment} integrity proof mismatch`)
  }
  if (!verifyEmbeddingCacheFileProof(cache.vectorPath, integrity.vectors)) fail('base vectors')
  if (!verifyEmbeddingCacheFileProof(cache.pathIndexPath, integrity.paths)) fail('base paths')
  if (cache.delta) {
    if (
      !integrity.deltaVectors ||
      !verifyEmbeddingCacheFileProof(cache.delta.vectorPath, integrity.deltaVectors)
    ) {
      fail('delta vectors')
    }
    if (
      !integrity.deltaPaths ||
      !verifyEmbeddingCacheFileProof(cache.delta.pathIndexPath, integrity.deltaPaths)
    ) {
      fail('delta paths')
    }
  }
}

/** Uint16 view over the row-major F16 payload; copies only when unaligned. */
function uint16View(buffer: Buffer): Uint16Array {
  if ((buffer.byteOffset & 1) === 0) {
    return new Uint16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength >> 1)
  }
  const aligned = new ArrayBuffer(buffer.byteLength)
  new Uint8Array(aligned).set(buffer)
  return new Uint16Array(aligned)
}

function loadCache(
  cache: EmbeddingF16CacheHandle,
  isCancelled: () => boolean,
): { snapshot: LoadedSemanticCache; loadMs: number; reused: boolean } {
  const key = cacheKey(cache)
  if (loaded?.key === key) return { snapshot: loaded, loadMs: 0, reused: true }
  const startedAt = Date.now()
  if (isCancelled()) throw new Error('Semantic vector scan cancelled')
  assertSemanticVectorCacheIntegrity(cache)
  const rowBytes = cache.meta.dim * 2
  // A composite handle (base generation + committed increment) stores delta
  // rows in a separate segment; concatenate only the committed prefix,
  // mirroring the ANN worker's immutable view.
  const baseVectors = fs.readFileSync(cache.vectorPath)
  const vectors = cache.delta
    ? Buffer.concat([
        baseVectors,
        fs
          .readFileSync(cache.delta.vectorPath)
          .subarray(0, (cache.meta.count - cache.delta.baseCount) * rowBytes),
      ])
    : baseVectors
  if (vectors.length !== cache.meta.count * rowBytes) {
    throw new Error('Semantic vector cache Float16 size mismatch')
  }
  if (isCancelled()) throw new Error('Semantic vector scan cancelled')
  // Same latest-revision resolution as the in-process scan: duplicate paths
  // keep their newest physical row and the scan walks rows in ascending order.
  const rows = readEmbeddingF16CacheLatestPathRowsSync(cache).map((item) => ({
    row: item.row,
    path: item.path,
    key: embeddingCachePathKey(item.path),
  }))
  loaded = { key, dim: cache.meta.dim, vectors: uint16View(vectors), rows }
  return { snapshot: loaded, loadMs: Date.now() - startedAt, reused: false }
}

function resolveScope(request: SemanticVectorWorkerSearchRequest): Set<string> | null {
  if (request.scopeId === 0) {
    loadedScope = null
    return null
  }
  if (request.scopeKeys) {
    loadedScope = { id: request.scopeId, set: new Set(request.scopeKeys) }
    return loadedScope.set
  }
  if (!loadedScope || loadedScope.id !== request.scopeId) {
    throw new Error('Semantic vector worker scope snapshot is missing')
  }
  return loadedScope.set
}

async function search(request: SemanticVectorWorkerSearchRequest): Promise<void> {
  const stopView = new Int32Array(request.stopBuffer)
  const isCancelled = () => Atomics.load(stopView, 0) === 1
  const startedAt = Date.now()
  try {
    const load = loadCache(request.cache, isCancelled)
    const snapshot = load.snapshot
    const scope = resolveScope(request)
    const lut = float16Lut()
    const query = request.queryVector
    const dim = snapshot.dim
    const rows = snapshot.rows
    const heap = new BoundedSemanticCandidateHeap(request.candidateK)
    let scanned = 0
    for (let index = 0; index < rows.length; index++) {
      if ((index & 1023) === 0 && isCancelled()) throw new Error('Semantic vector scan cancelled')
      const item = rows[index]
      scanned += 1
      if (scope && scope.size > 0 && !scope.has(item.key)) continue
      const base = item.row * dim
      let dot = 0
      for (let d = 0; d < dim; d++) dot += query[d] * lut[snapshot.vectors[base + d]]
      const score = Math.max(0, Math.min(1, (dot + 1) / 2))
      heap.offer(item.key, item.path, score, dot, item.row)
      if ((index & 4095) === 0 || index === rows.length - 1) {
        parentPort?.postMessage({
          type: 'progress',
          requestId: request.requestId,
          scanned,
          total: rows.length,
          percent: Math.min(100, Math.round((scanned / Math.max(1, rows.length)) * 100)),
        })
      }
    }
    const candidates = heap.values().sort((a, b) => b.score - a.score)
    parentPort?.postMessage({
      type: 'result',
      requestId: request.requestId,
      result: {
        candidates,
        scanned,
        total: rows.length,
        loadMs: load.loadMs,
        searchMs: Date.now() - startedAt,
        cacheReused: load.reused,
      } satisfies SemanticVectorWorkerScanResult,
    })
  } catch (error) {
    parentPort?.postMessage({
      type: isCancelled() ? 'cancelled' : 'error',
      requestId: request.requestId,
      error: errorMessage(error),
    })
  }
}

parentPort?.on('message', (request: SemanticVectorWorkerSearchRequest) => {
  if (request?.type === 'search') void search(request)
})
