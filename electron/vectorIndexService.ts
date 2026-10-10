// ── Vector Index Service ───────────────────────────────────
// Lightweight in-memory vector index with cosine similarity.
// Interface abstracted as VectorIndexProvider for future
// swap to hnswlib/FAISS.
// Stores index manifest in vector-db/vector_index_manifest.json.

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { app } from 'electron'
import type {
  VectorIndexManifest,
  VectorSearchResult,
  VectorSearchRequest,
  EmbeddingEntry,
  EmbeddingType,
} from '../shared/vectorTypes'
import { getEmbeddingsByModel, getEmbeddingStorePaths } from './vectorDatabaseService'
import {
  ensureEmbeddingF16Cache,
  embeddingCachePathKey,
  readExistingEmbeddingF16Cache,
  searchEmbeddingF16Cache,
  type EmbeddingF16CacheProgress,
} from './embeddingF16Cache'
import { searchVectorAnn } from './vectorAnnWorkerHost'
import { isVisionModelName, getVisionModelCapability } from './modelRegistry'
import {
  requireNormalizedEmbeddingVector,
  validateEmbeddingVector,
} from './embeddingVectorValidation'

// ── Types ──────────────────────────────────────────────────

export interface VectorIndexProvider {
  build(entries: EmbeddingEntry[]): Promise<void>
  search(req: VectorSearchRequest): Promise<VectorSearchResult[]>
  add(entry: EmbeddingEntry): void
  remove(imageId: string): void
  count(): number
  clear(): void
}

const EXACT_SCAN_LIMIT = 10_000
const LSH_PLANES = 24
const LSH_BAND_BITS = 8
const LSH_MIN_CANDIDATE_FACTOR = 24
const MAX_IN_MEMORY_EMBEDDING_FILE_BYTES = 512 * 1024 * 1024
const MAX_VECTOR_SEARCH_TOP_K = 5_000

function requireVectorSearchTopK(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_VECTOR_SEARCH_TOP_K
  ) {
    throw new RangeError(
      `Vector search topK must be a safe integer between 1 and ${MAX_VECTOR_SEARCH_TOP_K}`,
    )
  }
  return value as number
}

function expectedModelDim(modelName: string, fallback?: number): number {
  if (isVisionModelName(modelName)) return getVisionModelCapability(modelName).dim
  if (Number.isSafeInteger(fallback) && fallback! > 0) return fallback!
  throw new Error(`Expected embedding dimension is unavailable for model ${modelName}`)
}

function latestValidEntries(
  entries: EmbeddingEntry[],
  modelName: string,
  embeddingType: EmbeddingType,
  expectedDim: number,
): EmbeddingEntry[] {
  const latest = new Map<string, EmbeddingEntry>()
  for (const entry of entries) {
    if (
      entry?.modelName !== modelName ||
      entry?.embeddingType !== embeddingType ||
      typeof entry.imageId !== 'string'
    ) {
      continue
    }
    const key = embeddingCachePathKey(entry.imageId)
    latest.delete(key)
    const validation =
      entry.dim === expectedDim ? validateEmbeddingVector(entry.vector, expectedDim) : null
    if (!validation?.ok) continue
    latest.set(key, {
      ...entry,
      dim: expectedDim,
      vector: requireNormalizedEmbeddingVector(entry.vector, expectedDim),
      norm: 1,
    })
  }
  return [...latest.values()]
}

// ── In-memory Cosine Similarity + LSH Index ────────────────

class MemoryVectorIndex implements VectorIndexProvider {
  private entries: EmbeddingEntry[] = []
  private vectors: Float32Array[] = []
  private imageIds: string[] = []
  private paths: Map<string, string> = new Map()
  private modelName = ''
  private embeddingType: EmbeddingType = 'global'
  private dim = 0
  private projectionPlanes: Float32Array[] = []
  private buckets: Map<string, number[]> = new Map()

  async build(entries: EmbeddingEntry[]): Promise<void> {
    this.entries = []
    this.vectors = []
    this.imageIds = []
    this.paths.clear()
    this.buckets.clear()
    this.dim = 0
    this.modelName = ''
    this.embeddingType = 'global'

    for (const e of entries) {
      const expectedDim = this.dim || e.dim
      const vec = Float32Array.from(requireNormalizedEmbeddingVector(e.vector, expectedDim))
      if (this.dim && e.dim !== this.dim) throw new Error('Memory vector index dimension mismatch')
      this.entries.push(e)
      this.vectors.push(vec)
      this.imageIds.push(e.imageId)
      if (e.imageId) {
        this.paths.set(e.imageId, '') // path resolved from hash index at query time
      }
      this.modelName = e.modelName
      this.embeddingType = e.embeddingType
      this.dim = expectedDim
    }
    this.rebuildLsh()
  }

  async search(req: VectorSearchRequest): Promise<VectorSearchResult[]> {
    requireVectorSearchTopK(req.topK)
    if (this.vectors.length === 0) return []

    const qNormed = Float32Array.from(requireNormalizedEmbeddingVector(req.queryVector, this.dim))

    const candidateIndexes = this.getCandidateIndexes(qNormed, req.topK)
    return this.scoreCandidates(candidateIndexes, qNormed, req)
  }

  private scoreCandidates(
    candidateIndexes: number[],
    qNormed: Float32Array,
    req: VectorSearchRequest,
  ): VectorSearchResult[] {
    const scores: { idx: number; score: number }[] = []
    for (const i of candidateIndexes) {
      if (req.modelName && this.entries[i]?.modelName !== req.modelName) continue
      if (req.embeddingType && this.entries[i]?.embeddingType !== req.embeddingType) continue
      if (req.acceptPath && !req.acceptPath(this.imageIds[i])) continue

      const v = this.vectors[i]
      // Dot product (vectors are already normalized in upsertEmbedding)
      let dot = 0
      for (let j = 0; j < this.dim; j++) {
        dot += qNormed[j] * v[j]
      }
      // Cosine similarity in [0, 2] range (shifted to [0, 1])
      const score = (dot + 1) / 2
      scores.push({ idx: i, score })
    }

    scores.sort((a, b) => b.score - a.score)
    const topK = Math.min(req.topK, scores.length)
    return scores.slice(0, topK).map((s) => ({
      imageId: this.imageIds[s.idx],
      path: this.paths.get(this.imageIds[s.idx]) || '',
      vectorScore: s.score,
      modelName: this.modelName,
      embeddingType: this.embeddingType,
    }))
  }

  private getCandidateIndexes(queryVec: Float32Array, topK: number): number[] {
    if (this.vectors.length <= EXACT_SCAN_LIMIT || this.buckets.size === 0) {
      return this.vectors.map((_v, i) => i)
    }

    const candidateSet = new Set<number>()
    for (const key of this.getBandKeys(queryVec)) {
      const bucket = this.buckets.get(key)
      if (!bucket) continue
      for (const idx of bucket) candidateSet.add(idx)
    }

    const minCandidates = Math.min(
      this.vectors.length,
      Math.max(topK * LSH_MIN_CANDIDATE_FACTOR, topK),
    )
    if (candidateSet.size < minCandidates) {
      return this.vectors.map((_v, i) => i)
    }
    return [...candidateSet]
  }

  private rebuildLsh(): void {
    this.buckets.clear()
    if (this.vectors.length <= EXACT_SCAN_LIMIT || this.dim <= 0) return
    this.projectionPlanes = createProjectionPlanes(this.dim)
    for (let i = 0; i < this.vectors.length; i++) {
      for (const key of this.getBandKeys(this.vectors[i])) {
        const bucket = this.buckets.get(key)
        if (bucket) bucket.push(i)
        else this.buckets.set(key, [i])
      }
    }
  }

  private getSignature(vec: Float32Array): number {
    let signature = 0
    for (let planeIdx = 0; planeIdx < this.projectionPlanes.length; planeIdx++) {
      const plane = this.projectionPlanes[planeIdx]
      let dot = 0
      for (let i = 0; i < this.dim; i++) dot += vec[i] * plane[i]
      if (dot >= 0) signature |= 1 << planeIdx
    }
    return signature
  }

  private getBandKeys(vec: Float32Array): string[] {
    const signature = this.getSignature(vec)
    const keys: string[] = []
    const bandCount = Math.ceil(LSH_PLANES / LSH_BAND_BITS)
    const mask = (1 << LSH_BAND_BITS) - 1
    for (let band = 0; band < bandCount; band++) {
      const bandValue = (signature >> (band * LSH_BAND_BITS)) & mask
      keys.push(`${band}:${bandValue}`)
    }
    return keys
  }

  add(entry: EmbeddingEntry): void {
    const expectedDim = this.dim || entry.dim
    if (entry.dim !== expectedDim) throw new Error('Memory vector index dimension mismatch')
    const vec = Float32Array.from(requireNormalizedEmbeddingVector(entry.vector, expectedDim))
    this.entries.push(entry)
    this.vectors.push(vec)
    this.imageIds.push(entry.imageId)
    if (!this.dim) this.dim = entry.dim || vec.length
    this.rebuildLsh()
  }

  remove(imageId: string): void {
    const idx = this.imageIds.indexOf(imageId)
    if (idx !== -1) {
      this.entries.splice(idx, 1)
      this.vectors.splice(idx, 1)
      this.imageIds.splice(idx, 1)
      this.rebuildLsh()
    }
  }

  count(): number {
    return this.vectors.length
  }

  clear(): void {
    this.entries = []
    this.vectors = []
    this.imageIds = []
    this.paths.clear()
    this.buckets.clear()
  }
}

function createProjectionPlanes(dim: number): Float32Array[] {
  const planes: Float32Array[] = []
  let seed = 0x5f3759df
  for (let planeIdx = 0; planeIdx < LSH_PLANES; planeIdx++) {
    const plane = new Float32Array(dim)
    for (let i = 0; i < dim; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      plane[i] = (seed / 0xffffffff) * 2 - 1
    }
    planes.push(plane)
  }
  return planes
}

// ── Singleton ──────────────────────────────────────────────

let index: MemoryVectorIndex | null = null
let currentManifest: VectorIndexManifest | null = null
let vectorIndexBuildsInFlight = 0
let vectorIndexLifecycleEpoch = 0

function getManifestPath(): string {
  const dbDir = path.join(app.getPath('userData'), 'vector-db')
  return path.join(dbDir, 'vector_index_manifest.json')
}

function getEmbeddingFilePaths(
  modelName?: string,
  embeddingType: EmbeddingType = 'global',
): string[] {
  return getEmbeddingStorePaths(modelName, embeddingType)
}

function getTotalEmbeddingBytes(paths: string[]): number {
  return paths.reduce((sum, filePath) => {
    try {
      return sum + fs.statSync(filePath).size
    } catch {
      return sum
    }
  }, 0)
}

function isLargeEmbeddingFile(
  modelName?: string,
  embeddingType: EmbeddingType = 'global',
): boolean {
  return (
    getTotalEmbeddingBytes(getEmbeddingFilePaths(modelName, embeddingType)) >
    MAX_IN_MEMORY_EMBEDDING_FILE_BYTES
  )
}

function loadManifest(): VectorIndexManifest | null {
  try {
    const p = getManifestPath()
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'))
    }
  } catch {
    /* ok */
  }
  return null
}

function saveManifest(m: VectorIndexManifest): void {
  const p = getManifestPath()
  const dir = path.dirname(p)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(p, JSON.stringify(m, null, 2), 'utf-8')
}

async function countEmbeddingsStreaming(
  modelName: string,
  embeddingType: EmbeddingType,
): Promise<{ count: number; dim: number; modelVersion: string }> {
  const filePaths = getEmbeddingFilePaths(modelName, embeddingType)
  if (filePaths.length === 0) return { count: 0, dim: 0, modelVersion: 'unknown' }
  const expectedDim = expectedModelDim(modelName)
  const latest = new Map<string, string>()

  for (const filePath of filePaths) {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })

    for await (const line of rl) {
      try {
        const row = JSON.parse(line) as Partial<EmbeddingEntry>
        if (
          row.modelName !== modelName ||
          row.embeddingType !== embeddingType ||
          typeof row.imageId !== 'string'
        ) {
          continue
        }
        const key = embeddingCachePathKey(row.imageId)
        latest.delete(key)
        if (row.dim !== expectedDim || !validateEmbeddingVector(row.vector, expectedDim).ok)
          continue
        latest.set(key, typeof row.modelVersion === 'string' ? row.modelVersion : 'unknown')
      } catch {
        /* Skip malformed rows without changing an unrelated path state. */
      }
    }
  }

  return {
    count: latest.size,
    dim: expectedDim,
    modelVersion: [...latest.values()].at(-1) || 'unknown',
  }
}

// ── Public API ─────────────────────────────────────────────

export function getVectorIndex(): VectorIndexProvider | null {
  return index
}

export async function buildVectorIndex(
  modelName: string,
  embeddingType: EmbeddingType = 'global',
): Promise<{ ok: boolean; error?: string; warning?: string }> {
  const buildEpoch = vectorIndexLifecycleEpoch
  vectorIndexBuildsInFlight += 1
  try {
    if (isLargeEmbeddingFile(modelName, embeddingType)) {
      const previous = loadManifest()
      const counted = await countEmbeddingsStreaming(modelName, embeddingType)
      if (buildEpoch !== vectorIndexLifecycleEpoch) {
        return { ok: false, error: 'Vector index build was invalidated by index maintenance' }
      }
      if (counted.count === 0) {
        return { ok: false, error: 'No embeddings found for this model. Build embeddings first.' }
      }
      currentManifest = {
        version: 1,
        modelName,
        modelVersion: counted.modelVersion,
        embeddingType,
        dim: counted.dim || previous?.dim || 0,
        count: counted.count,
        indexType: 'streaming',
        createdAt: previous?.createdAt || Date.now(),
        updatedAt: Date.now(),
      }
      saveManifest(currentManifest)
      return {
        ok: true,
        warning:
          'Embedding database is too large for the in-memory index. Streaming vector search is enabled.',
      }
    }

    const expectedDim = expectedModelDim(modelName)
    const entries = latestValidEntries(
      getEmbeddingsByModel(modelName, embeddingType),
      modelName,
      embeddingType,
      expectedDim,
    )
    if (entries.length === 0) {
      return { ok: false, error: 'No embeddings found for this model. Build embeddings first.' }
    }

    const idx = new MemoryVectorIndex()
    await idx.build(entries)
    if (buildEpoch !== vectorIndexLifecycleEpoch) {
      return { ok: false, error: 'Vector index build was invalidated by index maintenance' }
    }
    index = idx

    currentManifest = {
      version: 1,
      modelName,
      modelVersion: entries[0]?.modelVersion || 'unknown',
      embeddingType,
      dim: expectedDim,
      count: entries.length,
      indexType: entries.length > EXACT_SCAN_LIMIT ? 'memory_lsh' : 'memory',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    saveManifest(currentManifest)

    return { ok: true }
  } finally {
    vectorIndexBuildsInFlight = Math.max(0, vectorIndexBuildsInFlight - 1)
  }
}

export function isVectorIndexBuildRunning(): boolean {
  return vectorIndexBuildsInFlight > 0
}

function normalizeQueryVector(
  queryVector: number[] | Float32Array,
  expectedDim: number,
): Float32Array {
  return Float32Array.from(requireNormalizedEmbeddingVector(queryVector, expectedDim))
}

function pushTopK(top: VectorSearchResult[], result: VectorSearchResult, topK: number): void {
  if (top.length < topK) {
    top.push(result)
    let child = top.length - 1
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2)
      if (top[parent].vectorScore <= top[child].vectorScore) break
      ;[top[parent], top[child]] = [top[child], top[parent]]
      child = parent
    }
    return
  }
  if (result.vectorScore <= (top[0]?.vectorScore ?? -Infinity)) return
  top[0] = result
  let parent = 0
  for (;;) {
    const left = parent * 2 + 1
    const right = left + 1
    if (left >= top.length) break
    let smaller = left
    if (right < top.length && top[right].vectorScore < top[left].vectorScore) smaller = right
    if (top[parent].vectorScore <= top[smaller].vectorScore) break
    ;[top[parent], top[smaller]] = [top[smaller], top[parent]]
    parent = smaller
  }
}

async function searchF16Embeddings(
  req: VectorSearchRequest,
  modelName: string,
  embeddingType: EmbeddingType,
  sourcePaths: string[],
  manifest: VectorIndexManifest | null,
  onProgress?: (progress: { scanned: number; totalBytes?: number; percent?: number }) => void,
): Promise<VectorSearchResult[] | null> {
  const dim = expectedModelDim(
    modelName,
    manifest?.modelName === modelName && manifest.embeddingType === embeddingType
      ? manifest.dim
      : undefined,
  )
  const queryVector = normalizeQueryVector(req.queryVector, dim)
  const cacheOptions = {
    cacheDir: path.join(app.getPath('userData'), 'vector-db', 'embedding-cache'),
    modelName,
    embeddingType,
    dim,
    sourcePaths,
    isCancelled: req.isCancelled,
    onProgress: (progress: EmbeddingF16CacheProgress) =>
      onProgress?.({
        scanned: progress.current,
        totalBytes: progress.total,
        percent: progress.percent,
      }),
  }
  const cache =
    readExistingEmbeddingF16Cache(cacheOptions) ?? (await ensureEmbeddingF16Cache(cacheOptions))
  if (!cache || cache.meta.count <= 0) return null

  const topK = requireVectorSearchTopK(req.topK)
  if (process.env.FLOATING_CLOCK_DISABLE_VECTOR_ANN !== '1') {
    try {
      const annTopK = Math.min(5000, Math.max(topK * 4, topK + 100))
      const ann = await searchVectorAnn(cache, queryVector, annTopK, {
        isCancelled: req.isCancelled,
        acceptPathKeys: req.acceptPathKeys,
        onProgress: (progress) =>
          onProgress?.({
            scanned: progress.current,
            totalBytes: progress.total,
            percent: progress.percent,
          }),
      })
      const activeMatches = req.acceptPath
        ? ann.results.filter((match) => req.acceptPath!(match.path))
        : ann.results
      if (activeMatches.length >= topK) {
        onProgress?.({
          scanned: ann.candidateCount,
          totalBytes: ann.indexedCount,
          percent: 100,
        })
        return activeMatches.slice(0, topK).map((match) => ({
          imageId: match.path,
          path: match.path,
          vectorScore: match.score,
          modelName,
          embeddingType,
        }))
      }
    } catch (error) {
      if (req.isCancelled?.()) throw error
      // ANN is a disposable acceleration layer. Corruption, version mismatch,
      // worker failure, or insufficient results falls back to exact Float16.
    }
  }
  const matches = await searchEmbeddingF16Cache(cache, {
    queryVector,
    topK,
    isCancelled: req.isCancelled,
    acceptPath: req.acceptPath,
    onProgress: (progress) =>
      onProgress?.({
        scanned: progress.current,
        totalBytes: cache.meta.count,
        percent: progress.percent,
      }),
  })
  return matches.map((match) => ({
    imageId: match.path,
    path: match.path,
    vectorScore: match.score,
    modelName,
    embeddingType,
  }))
}

async function streamSearchEmbeddings(
  req: VectorSearchRequest,
  manifest: VectorIndexManifest | null,
  onProgress?: (progress: { scanned: number; totalBytes?: number; percent?: number }) => void,
): Promise<VectorSearchResult[]> {
  const modelName = req.modelName || manifest?.modelName
  const embeddingType = req.embeddingType || manifest?.embeddingType || 'global'
  const filePaths = getEmbeddingFilePaths(modelName, embeddingType)
  if (filePaths.length === 0) return []
  if (!modelName) throw new Error('Vector search model name is required')
  const expectedDim = expectedModelDim(modelName, manifest?.dim)
  const qNormed = normalizeQueryVector(req.queryVector, expectedDim)
  const topK = requireVectorSearchTopK(req.topK)
  const top: VectorSearchResult[] = []
  const totalBytes = getTotalEmbeddingBytes(filePaths)
  const latestSequenceByKey = new Map<string, number>()
  let relevantSequence = 0

  // First pass records only the latest revision number and validity. A
  // negative value is a latest invalid tombstone; the second pass scores only
  // positive latest revisions without retaining every vector in memory.
  for (const filePath of filePaths) {
    const reader = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of reader) {
      if (req.isCancelled?.()) throw new Error('Vector search cancelled')
      if (!line) continue
      try {
        const entry = JSON.parse(line) as Partial<EmbeddingEntry>
        if (
          entry.modelName !== modelName ||
          entry.embeddingType !== embeddingType ||
          typeof entry.imageId !== 'string'
        ) {
          continue
        }
        relevantSequence++
        const key = embeddingCachePathKey(entry.imageId)
        const valid =
          entry.dim === expectedDim && validateEmbeddingVector(entry.vector, expectedDim).ok
        latestSequenceByKey.set(key, valid ? relevantSequence : -relevantSequence)
      } catch {
        /* A row without a trustworthy identity cannot supersede a path. */
      }
    }
  }

  let approxBytes = 0
  let scanned = 0
  let lastProgressAt = 0
  relevantSequence = 0

  for (const filePath of filePaths) {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })

    for await (const line of rl) {
      if (req.isCancelled?.()) {
        rl.close()
        throw new Error('Vector search cancelled')
      }
      if (!line) continue
      scanned++
      approxBytes += Buffer.byteLength(line, 'utf8') + 1
      const now = Date.now()
      if (onProgress && (now - lastProgressAt > 350 || scanned === 1)) {
        lastProgressAt = now
        onProgress({
          scanned,
          totalBytes,
          percent: totalBytes > 0 ? Math.min(100, Math.round((approxBytes / totalBytes) * 100)) : 0,
        })
      }
      try {
        const entry = JSON.parse(line) as EmbeddingEntry
        if (modelName && entry.modelName !== modelName) continue
        if (embeddingType && entry.embeddingType !== embeddingType) continue
        if (typeof entry.imageId !== 'string') continue
        relevantSequence++
        const key = embeddingCachePathKey(entry.imageId)
        if (latestSequenceByKey.get(key) !== relevantSequence) continue
        if (req.acceptPath && !req.acceptPath(entry.imageId)) continue
        if (entry.dim !== expectedDim) continue
        const validation = validateEmbeddingVector(entry.vector, expectedDim)
        if (!validation.ok) continue
        const vector = entry.vector as number[] | Float32Array
        let dot = 0
        for (let i = 0; i < expectedDim; i++) {
          dot += qNormed[i] * (vector[i] / validation.scale / validation.scaledNorm)
        }
        const score = (dot + 1) / 2
        pushTopK(
          top,
          {
            imageId: entry.imageId,
            path: entry.imageId,
            vectorScore: score,
            modelName: entry.modelName,
            embeddingType: entry.embeddingType,
          },
          topK,
        )
      } catch {
        /* skip corrupt embedding line */
      }
    }
  }

  top.sort((a, b) => b.vectorScore - a.vectorScore)
  onProgress?.({ scanned, totalBytes, percent: 100 })
  return top
}

export async function searchVectorIndex(
  req: VectorSearchRequest,
  onProgress?: (progress: { scanned: number; totalBytes?: number; percent?: number }) => void,
): Promise<VectorSearchResult[]> {
  requireVectorSearchTopK(req.topK)
  const searchEpoch = vectorIndexLifecycleEpoch
  if (!index) {
    // Try to load from manifest
    const manifest = loadManifest()
    const modelName = req.modelName || manifest?.modelName
    const embeddingType = req.embeddingType || manifest?.embeddingType || 'global'
    if (isLargeEmbeddingFile(modelName, embeddingType)) {
      const sourcePaths = getEmbeddingFilePaths(modelName, embeddingType)
      if (modelName && sourcePaths.length > 0) {
        const cached = await searchF16Embeddings(
          req,
          modelName,
          embeddingType,
          sourcePaths,
          manifest,
          onProgress,
        )
        if (cached) return searchEpoch === vectorIndexLifecycleEpoch ? cached : []
      }
      const streamed = await streamSearchEmbeddings(req, manifest, onProgress)
      return searchEpoch === vectorIndexLifecycleEpoch ? streamed : []
    }
    if (manifest) {
      const expectedDim = expectedModelDim(manifest.modelName, manifest.dim)
      const entries = latestValidEntries(
        getEmbeddingsByModel(manifest.modelName, manifest.embeddingType),
        manifest.modelName,
        manifest.embeddingType,
        expectedDim,
      )
      if (entries.length > 0) {
        const idx = new MemoryVectorIndex()
        await idx.build(entries)
        if (searchEpoch !== vectorIndexLifecycleEpoch) return []
        index = idx
        currentManifest = manifest
      }
    }
  }
  if (!index) return []
  return index.search(req)
}

export function getVectorIndexStatus(): {
  built: boolean
  count: number
  modelName?: string
  dim?: number
  error?: string
} {
  if (index) {
    return {
      built: true,
      count: index.count(),
      modelName: currentManifest?.modelName,
      dim: currentManifest?.dim,
    }
  }
  const manifest = loadManifest()
  if (manifest) {
    return {
      built: true,
      count: manifest.count,
      modelName: manifest.modelName,
      dim: manifest.dim,
    }
  }
  return { built: false, count: 0 }
}

export function clearVectorIndex(): void {
  vectorIndexLifecycleEpoch += 1
  if (index) {
    index.clear()
    index = null
  }
  currentManifest = null
  try {
    const p = getManifestPath()
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch {
    /* ok */
  }
}
