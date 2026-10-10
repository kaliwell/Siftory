// ── MediaSearch Frame Embedding Index ──────────────────────
// Lightweight index mapping video frame imagePath → vector,
// built from the authoritative vector generation (or the shared
// F16 embedding cache), falling back to the embedding shard
// files when neither is in sync. Avoids full JSONL scan on
// every search by pre-extracting only frame-relevant
// embeddings into a single compact file.

import fs from 'fs'
import path from 'path'
import { createInterface } from 'readline'
import { StringDecoder } from 'string_decoder'
import { once } from 'events'
import { getMediaSearchDir, ensureMediaSearchDirs } from './mediaCacheService'
import { getEmbeddingCacheDir, getEmbeddingStorePaths } from './vectorDatabaseService'
import { loadVideoFrameManifest } from './videoFrameService'
import {
  describeEmbeddingVectorSource,
  embeddingCachePathKey,
  ensureEmbeddingF16Cache,
  readEmbeddingF16VectorsForPaths,
  readEmbeddingF16VectorsForPathsSync,
  readFreshEmbeddingF16Cache,
  type EnsureEmbeddingF16CacheOptions,
} from './embeddingF16Cache'
import {
  expectedFrameVectorDim,
  normalizeFrameKey,
  normalizeFrameVector,
} from './mediaSearchVectorMath'
import {
  countVideoFrameVectors,
  ensureVideoFrameVectorLookup,
  ensureVideoFrameVectorLookupSync,
  findVideoFrameVector,
  loadVideoFrameVectorMap,
  removeVideoFrameVectorLookup,
  scanVideoFrameVectors,
} from './videoFrameVectorLookup'
import { registerRuntimeCacheBudgetProvider } from './runtimeMemoryCacheRegistry'

export type FrameIndexModelName = 'dinov2_vitb14' | 'clip_vit_base_patch32'
const FRAME_INDEX_MODELS: FrameIndexModelName[] = ['dinov2_vitb14', 'clip_vit_base_patch32']
const FRAME_INDEX_VERSION = 2

export interface FrameVectorEntry {
  imagePath: string
  modelName: string
  dim: number
  vector: number[]
}

export type RuntimeFrameVector = Float32Array

interface FrameIndexMeta {
  version: typeof FRAME_INDEX_VERSION
  sourceSignature: string
  manifest: { path: string; signature: string }
  stores: { path: string; signature: string }[]
  entries: number
  errors: number
  builtAt: number
}

function getFrameIndexPath(): string {
  ensureMediaSearchDirs()
  return path.join(getMediaSearchDir(), 'vectors', 'frame_embedding_index.jsonl')
}

function getFrameIndexMetaPath(): string {
  ensureMediaSearchDirs()
  return path.join(getMediaSearchDir(), 'vectors', 'frame_embedding_index.meta.json')
}

function getFrameIndexLookupPath(): string {
  ensureMediaSearchDirs()
  return path.join(getMediaSearchDir(), 'vectors', 'frame_embedding_index.lookup.sqlite')
}

function frameManifestPath(): string {
  return path.join(getMediaSearchDir(), 'manifests', 'video_frames.jsonl')
}

function fileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function fileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

function getFrameIndexSourceFiles(): string[] {
  return [
    frameManifestPath(),
    ...getEmbeddingStorePaths('dinov2_vitb14', 'global'),
    ...getEmbeddingStorePaths('clip_vit_base_patch32', 'global'),
  ]
}

/** Cache options shared by every frame-vector read path (index build, stats signature). */
export function getFrameEmbeddingCacheOptions(
  modelName: FrameIndexModelName,
): EnsureEmbeddingF16CacheOptions {
  return {
    cacheDir: getEmbeddingCacheDir(),
    modelName,
    embeddingType: 'global',
    dim: expectedFrameVectorDim(modelName),
    sourcePaths: getEmbeddingStorePaths(modelName, 'global'),
  }
}

/**
 * Freshness signature hangs on the authoritative generation identity when
 * CURRENT (or its committed increment) is in sync with the source shards,
 * and on the shard stats otherwise (exactly what a rebuild would consume).
 * The full fingerprint includes committed delta count/source count, so an
 * append, repair, or invalid latest tombstone invalidates the frame index
 * even within the same generation. Generation switches and raw-shard drift
 * invalidate it as well.
 */
function getFrameIndexSourceSignature(): string {
  const parts = [`${path.resolve(frameManifestPath())}=${fileSignature(frameManifestPath())}`]
  for (const modelName of FRAME_INDEX_MODELS) {
    const source = describeEmbeddingVectorSource(getFrameEmbeddingCacheOptions(modelName))
    parts.push(`${modelName}=${source.fingerprint}`)
  }
  return parts.sort().join('|')
}

function readFrameIndexMeta(): FrameIndexMeta | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(getFrameIndexMetaPath(), 'utf-8'),
    ) as Partial<FrameIndexMeta>
    if (raw.version !== FRAME_INDEX_VERSION || typeof raw.sourceSignature !== 'string') return null
    if (!raw.manifest || !Array.isArray(raw.stores)) return null
    return raw as FrameIndexMeta
  } catch {
    return null
  }
}

function writeFrameIndexMeta(entries: number, errors: number): void {
  const manifestPath = frameManifestPath()
  const stores = [
    ...getEmbeddingStorePaths('dinov2_vitb14', 'global'),
    ...getEmbeddingStorePaths('clip_vit_base_patch32', 'global'),
  ]
  const meta: FrameIndexMeta = {
    version: FRAME_INDEX_VERSION,
    sourceSignature: getFrameIndexSourceSignature(),
    manifest: { path: manifestPath, signature: fileSignature(manifestPath) },
    stores: stores
      .map((filePath) => ({ path: filePath, signature: fileSignature(filePath) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    entries,
    errors,
    builtAt: Date.now(),
  }
  fs.writeFileSync(getFrameIndexMetaPath(), JSON.stringify(meta, null, 2), 'utf-8')
}

const frameIndexCache = new Map<
  'dinov2_vitb14' | 'clip_vit_base_patch32',
  {
    signature: string
    index: Map<string, RuntimeFrameVector>
    memory: FrameIndexCacheMemoryStats
  }
>()
const frameIndexLoadPromises = new Map<
  'dinov2_vitb14' | 'clip_vit_base_patch32',
  { signature: string; promise: Promise<Map<string, RuntimeFrameVector>> }
>()
let frameIndexBuildPromise: Promise<{ entries: number; errors: number }> | null = null
const MAX_FRAME_INDEX_CACHE_BYTES = 256 * 1024 * 1024
const DEFAULT_FRAME_INDEX_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const MAP_BASE_BYTES_APPROX = 64
const MAP_ENTRY_BYTES_APPROX = 56
const TYPED_ARRAY_AND_BUFFER_HEADER_BYTES_APPROX = 128
let frameIndexIdleTimeoutMs = DEFAULT_FRAME_INDEX_IDLE_TIMEOUT_MS
let frameIndexIdleTimer: ReturnType<typeof setTimeout> | null = null
let activeFrameIndexSearches = 0
let frameIndexPressureReleasePending = false

export interface FrameIndexCacheMemoryStats {
  entries: number
  models: number
  vectorBytes: number
  arrayBufferOwnedBytes: number
  pathUtf8Bytes: number
  pathStorageBytesApprox: number
  signatureBytes: number
  mapBytesApprox: number
  objectBytesApprox: number
  totalOwnedBytesApprox: number
  budgetBytes: number
}

export function estimateFrameIndexCacheMemory(
  index: Map<string, RuntimeFrameVector>,
  signature: string,
): FrameIndexCacheMemoryStats {
  let vectorBytes = 0
  let arrayBufferOwnedBytes = 0
  let pathUtf8Bytes = 0
  let pathStorageBytesApprox = 0
  for (const [imagePath, vector] of index) {
    vectorBytes += vector.byteLength
    arrayBufferOwnedBytes += vector.buffer.byteLength
    const utf8Bytes = Buffer.byteLength(imagePath, 'utf8')
    pathUtf8Bytes += utf8Bytes
    pathStorageBytesApprox += Math.max(utf8Bytes, imagePath.length * 2)
  }
  const signatureBytes = Buffer.byteLength(signature, 'utf8')
  const mapBytesApprox = MAP_BASE_BYTES_APPROX + index.size * MAP_ENTRY_BYTES_APPROX
  const objectBytesApprox = index.size * TYPED_ARRAY_AND_BUFFER_HEADER_BYTES_APPROX
  return {
    entries: index.size,
    models: 1,
    vectorBytes,
    arrayBufferOwnedBytes,
    pathUtf8Bytes,
    pathStorageBytesApprox,
    signatureBytes,
    mapBytesApprox,
    objectBytesApprox,
    totalOwnedBytesApprox:
      arrayBufferOwnedBytes +
      pathStorageBytesApprox +
      signatureBytes +
      mapBytesApprox +
      objectBytesApprox,
    budgetBytes: MAX_FRAME_INDEX_CACHE_BYTES,
  }
}

export function getFrameIndexCacheMemoryStats(): FrameIndexCacheMemoryStats {
  const values = [...frameIndexCache.values()].map((entry) => entry.memory)
  return {
    entries: values.reduce((sum, value) => sum + value.entries, 0),
    models: values.length,
    vectorBytes: values.reduce((sum, value) => sum + value.vectorBytes, 0),
    arrayBufferOwnedBytes: values.reduce((sum, value) => sum + value.arrayBufferOwnedBytes, 0),
    pathUtf8Bytes: values.reduce((sum, value) => sum + value.pathUtf8Bytes, 0),
    pathStorageBytesApprox: values.reduce((sum, value) => sum + value.pathStorageBytesApprox, 0),
    signatureBytes: values.reduce((sum, value) => sum + value.signatureBytes, 0),
    mapBytesApprox: values.reduce((sum, value) => sum + value.mapBytesApprox, 0),
    objectBytesApprox: values.reduce((sum, value) => sum + value.objectBytesApprox, 0),
    totalOwnedBytesApprox: values.reduce((sum, value) => sum + value.totalOwnedBytesApprox, 0),
    budgetBytes: MAX_FRAME_INDEX_CACHE_BYTES,
  }
}

export function canCacheFrameIndexMemory(stats: FrameIndexCacheMemoryStats): boolean {
  return stats.totalOwnedBytesApprox <= MAX_FRAME_INDEX_CACHE_BYTES
}

function cancelFrameIndexIdleRelease(): void {
  if (frameIndexIdleTimer) clearTimeout(frameIndexIdleTimer)
  frameIndexIdleTimer = null
}

function clearFrameIndexMemoryCacheNow(): number {
  cancelFrameIndexIdleRelease()
  const releasedModels = frameIndexCache.size
  frameIndexCache.clear()
  return releasedModels
}

function scheduleFrameIndexIdleRelease(): void {
  cancelFrameIndexIdleRelease()
  if (activeFrameIndexSearches > 0 || frameIndexCache.size === 0) return
  frameIndexIdleTimer = setTimeout(() => {
    frameIndexIdleTimer = null
    if (activeFrameIndexSearches === 0) clearFrameIndexMemoryCacheNow()
  }, frameIndexIdleTimeoutMs)
  frameIndexIdleTimer.unref?.()
}

function touchFrameIndexCache(
  modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32',
): Map<string, RuntimeFrameVector> | null {
  const cached = frameIndexCache.get(modelName)
  if (!cached) return null
  // Delete/set makes recency explicit even though the production policy keeps
  // at most one model resident.
  frameIndexCache.delete(modelName)
  frameIndexCache.set(modelName, cached)
  scheduleFrameIndexIdleRelease()
  return cached.index
}

export type FrameIndexMemoryReleaseResult = {
  status: 'released' | 'deferred' | 'empty'
  activeSearches: number
  releasedModels: number
}

/** Release only cache-owned references. Active searches keep their leased Map
 * until completion and a pressure request is honored immediately afterwards. */
export function requestFrameIndexMemoryPressureRelease(): FrameIndexMemoryReleaseResult {
  if (frameIndexCache.size === 0) {
    return { status: 'empty', activeSearches: activeFrameIndexSearches, releasedModels: 0 }
  }
  if (activeFrameIndexSearches > 0) {
    frameIndexPressureReleasePending = true
    cancelFrameIndexIdleRelease()
    return {
      status: 'deferred',
      activeSearches: activeFrameIndexSearches,
      releasedModels: 0,
    }
  }
  frameIndexPressureReleasePending = false
  const releasedModels = clearFrameIndexMemoryCacheNow()
  return { status: 'released', activeSearches: 0, releasedModels }
}

registerRuntimeCacheBudgetProvider(
  'media-frame-index',
  () => {
    const stats = getFrameIndexCacheMemoryStats()
    return {
      entries: stats.entries,
      ownedBytesApprox: stats.totalOwnedBytesApprox,
      budgetBytes: stats.budgetBytes,
    }
  },
  requestFrameIndexMemoryPressureRelease,
)

export interface FrameIndexSearchLease {
  index: Map<string, RuntimeFrameVector>
  release(): void
}

/** Acquire a search-scoped reference so idle/pressure cleanup cannot dispose
 * the index while its caller is embedding, scanning, ranking, or yielding. */
export async function acquireFrameIndexForSearch(
  modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32',
): Promise<FrameIndexSearchLease> {
  activeFrameIndexSearches += 1
  cancelFrameIndexIdleRelease()
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    activeFrameIndexSearches = Math.max(0, activeFrameIndexSearches - 1)
    if (activeFrameIndexSearches > 0) return
    if (frameIndexPressureReleasePending) {
      frameIndexPressureReleasePending = false
      clearFrameIndexMemoryCacheNow()
      return
    }
    scheduleFrameIndexIdleRelease()
  }
  try {
    return { index: await loadFrameIndexAsync(modelName), release }
  } catch (error) {
    release()
    throw error
  }
}

export function setFrameIndexIdleTimeoutForTests(timeoutMs: number): () => void {
  const previous = frameIndexIdleTimeoutMs
  frameIndexIdleTimeoutMs = Math.max(1, Math.floor(timeoutMs))
  scheduleFrameIndexIdleRelease()
  return () => {
    frameIndexIdleTimeoutMs = previous
    scheduleFrameIndexIdleRelease()
  }
}

/**
 * The index is keyed by the canonical path while preserving the latest
 * original spelling for consumers. This gives case-insensitive Windows paths
 * the same latest-revision semantics as JSONL shard reads.
 */
function applyFrameIndexEntry(
  index: Map<string, RuntimeFrameVector>,
  pathByKey: Map<string, string>,
  entry: unknown,
  modelName: FrameIndexModelName,
): void {
  if (!entry || typeof entry !== 'object') return
  const candidate = entry as Partial<FrameVectorEntry>
  if (candidate.modelName !== modelName || typeof candidate.imagePath !== 'string') return
  const key = normalizeFrameKey(candidate.imagePath)
  const previousPath = pathByKey.get(key)
  const dim = expectedFrameVectorDim(modelName)
  if (candidate.dim !== dim) {
    if (previousPath) index.delete(previousPath)
    pathByKey.delete(key)
    return
  }
  const vector = normalizeFrameVector(candidate.vector, dim)
  if (!vector) {
    if (previousPath) index.delete(previousPath)
    pathByKey.delete(key)
    return
  }
  if (previousPath && previousPath !== candidate.imagePath) index.delete(previousPath)
  pathByKey.set(key, candidate.imagePath)
  index.set(candidate.imagePath, new Float32Array(vector))
}

function cacheFrameIndex(
  modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32',
  signature: string,
  index: Map<string, RuntimeFrameVector>,
): void {
  const memory = estimateFrameIndexCacheMemory(index, signature)
  if (!canCacheFrameIndexMemory(memory)) return
  // A DINO/CLIP switch must not leave both full frame Maps resident. Existing
  // searches retain their own references, so removing cache ownership is safe.
  clearFrameIndexMemoryCacheNow()
  frameIndexCache.set(modelName, { signature, index, memory })
  scheduleFrameIndexIdleRelease()
}

export function isFrameIndexFresh(): boolean {
  const indexPath = getFrameIndexPath()
  if (!fs.existsSync(indexPath)) return false
  const meta = readFrameIndexMeta()
  if (meta) return meta.sourceSignature === getFrameIndexSourceSignature()
  // A metadata file is an explicit format contract. Do not let a v1 index
  // (which has no declared vector dimension) pass the mtime-only fallback.
  if (fs.existsSync(getFrameIndexMetaPath())) return false

  const indexMtime = fileMtimeMs(indexPath)
  if (indexMtime <= 0 || fileMtimeMs(frameManifestPath()) > indexMtime) return false
  return getFrameIndexSourceFiles().every((filePath) => fileMtimeMs(filePath) <= indexMtime)
}

export function ensureFrameIndexFresh(): { entries: number; errors: number; rebuilt: boolean } {
  if (isFrameIndexFresh()) return { entries: 0, errors: 0, rebuilt: false }
  const result = buildFrameIndex()
  return { ...result, rebuilt: true }
}

export async function ensureFrameIndexFreshAsync(): Promise<{
  entries: number
  errors: number
  rebuilt: boolean
}> {
  if (isFrameIndexFresh()) return { entries: 0, errors: 0, rebuilt: false }
  const result = await buildFrameIndexAsync()
  return { ...result, rebuilt: true }
}

function scanJsonLinesSync(filePath: string, onLine: (line: string) => boolean | void): void {
  const fd = fs.openSync(filePath, 'r')
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let carry = ''
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead <= 0) break
      carry += decoder.write(buffer.subarray(0, bytesRead))
      let newlineIndex = carry.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = carry.slice(0, newlineIndex).replace(/\r$/, '')
        carry = carry.slice(newlineIndex + 1)
        if (onLine(line) === false) return
        newlineIndex = carry.indexOf('\n')
      }
    }
    carry += decoder.end()
    if (carry) onLine(carry.replace(/\r$/, ''))
  } finally {
    fs.closeSync(fd)
  }
}

async function scanJsonLinesAsync(
  filePath: string,
  onLine: (line: string) => boolean | void,
): Promise<void> {
  const input = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (onLine(line) === false) break
    }
  } finally {
    lines.close()
  }
}

/** Shared row handling for the shard-scan fallback: latest revision per frame wins. */
function collectFrameRow(
  line: string,
  modelName: FrameIndexModelName,
  frameImagePaths: Map<string, string>,
  outByKey: Map<string, FrameVectorEntry>,
): 'skip' | 'ok' | 'error' {
  const modelNeedle = `"modelName":${JSON.stringify(modelName)}`
  const typeNeedle = '"embeddingType":"global"'
  if (!line || !line.includes(modelNeedle) || !line.includes(typeNeedle)) return 'skip'
  try {
    const row = JSON.parse(line) as {
      imageId?: unknown
      modelName?: unknown
      embeddingType?: unknown
      dim?: unknown
      vector?: unknown
    }
    if (
      row.modelName !== modelName ||
      row.embeddingType !== 'global' ||
      typeof row.imageId !== 'string'
    ) {
      return 'skip'
    }
    const manifestImagePath = frameImagePaths.get(normalizeFrameKey(row.imageId))
    if (!manifestImagePath) return 'skip'
    const key = `${modelName}|${normalizeFrameKey(manifestImagePath)}`
    const dim = expectedFrameVectorDim(modelName)
    // A model/type/path match is a revision even when its vector is unusable.
    // Removing the old value prevents a repaired append or a newer corrupt row
    // from silently resurrecting an older embedding.
    if (row.dim !== dim) {
      outByKey.delete(key)
      return 'error'
    }
    const vector = normalizeFrameVector(row.vector, dim)
    if (!vector) {
      outByKey.delete(key)
      return 'error'
    }
    outByKey.set(key, {
      imagePath: manifestImagePath,
      modelName,
      dim,
      vector,
    })
    return 'ok'
  } catch {
    return 'error'
  }
}

function collectFrameVectorsFromJsonlSync(
  modelName: FrameIndexModelName,
  frameImagePaths: Map<string, string>,
  outByKey: Map<string, FrameVectorEntry>,
): number {
  let errors = 0
  for (const filePath of getEmbeddingStorePaths(modelName, 'global')) {
    try {
      scanJsonLinesSync(filePath, (line) => {
        if (collectFrameRow(line, modelName, frameImagePaths, outByKey) === 'error') errors++
      })
    } catch {
      continue
    }
  }
  return errors
}

async function collectFrameVectorsFromJsonlAsync(
  modelName: FrameIndexModelName,
  frameImagePaths: Map<string, string>,
  outByKey: Map<string, FrameVectorEntry>,
): Promise<number> {
  let errors = 0
  for (const filePath of getEmbeddingStorePaths(modelName, 'global')) {
    try {
      await scanJsonLinesAsync(filePath, (line) => {
        if (collectFrameRow(line, modelName, frameImagePaths, outByKey) === 'error') errors++
      })
    } catch {
      continue
    }
  }
  return errors
}

/**
 * Fold decoded F16 vectors (already latest-revision-deduplicated by the
 * generation/cache build) into the frame index output. Vectors are decoded
 * and renormalized by the F16 reader, so this matches the JSONL path within
 * Float16 rounding.
 */
function collectFrameVectorsFromCache(
  vectors: Map<string, Float32Array>,
  frameImagePaths: Map<string, string>,
  modelName: FrameIndexModelName,
  outByKey: Map<string, FrameVectorEntry>,
): number {
  const dim = expectedFrameVectorDim(modelName)
  const manifestByCacheKey = new Map<string, string>()
  for (const imagePath of frameImagePaths.values()) {
    manifestByCacheKey.set(embeddingCachePathKey(imagePath), imagePath)
  }
  let errors = 0
  for (const [key, decoded] of vectors) {
    const manifestImagePath = manifestByCacheKey.get(key)
    if (!manifestImagePath) continue
    const vector = normalizeFrameVector(Array.from(decoded), dim)
    if (!vector) {
      errors++
      continue
    }
    outByKey.set(`${modelName}|${normalizeFrameKey(manifestImagePath)}`, {
      imagePath: manifestImagePath,
      modelName,
      dim,
      vector,
    })
  }
  return errors
}

function writeFrameIndexEntriesSync(filePath: string, entries: Iterable<FrameVectorEntry>): void {
  const fd = fs.openSync(filePath, 'w')
  try {
    for (const entry of entries) fs.writeSync(fd, `${JSON.stringify(entry)}\n`, null, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

async function writeFrameIndexEntriesAsync(
  filePath: string,
  entries: Iterable<FrameVectorEntry>,
): Promise<void> {
  const output = fs.createWriteStream(filePath, { encoding: 'utf8' })
  try {
    for (const entry of entries) {
      if (!output.write(`${JSON.stringify(entry)}\n`)) await once(output, 'drain')
    }
    output.end()
    await once(output, 'close')
  } catch (error) {
    output.destroy()
    throw error
  }
}

/** Rebuild the frame index from the authoritative generation / F16 cache,
 *  falling back to the embedding shards when no snapshot is in sync.
 *  Only extracts entries whose imagePath exists in the
 *  current video frame manifest. */
export function buildFrameIndex(): { entries: number; errors: number } {
  const frames = loadVideoFrameManifest()
  const frameImagePaths = new Map(
    frames
      .filter(
        (record) => record.status === 'done' && record.imagePath && fs.existsSync(record.imagePath),
      )
      .map((record) => {
        const imagePath = record.imagePath as string
        return [normalizeFrameKey(imagePath), imagePath] as const
      }),
  )

  if (frameImagePaths.size === 0) {
    try {
      fs.writeFileSync(getFrameIndexPath(), '', 'utf-8')
      writeFrameIndexMeta(0, 0)
    } catch {
      /* ignore */
    }
    return { entries: 0, errors: 0 }
  }

  const indexDir = path.dirname(getFrameIndexPath())
  fs.mkdirSync(indexDir, { recursive: true })
  const tmp = `${getFrameIndexPath()}.tmp-${process.pid}-${Date.now()}`

  let entries = 0
  let errors = 0
  const outByKey = new Map<string, FrameVectorEntry>()

  for (const modelName of FRAME_INDEX_MODELS) {
    // Synchronous entry point: only use a generation/cache snapshot that is
    // provably in sync with the shards; otherwise scan the shards directly.
    const cache = readFreshEmbeddingF16Cache(getFrameEmbeddingCacheOptions(modelName))
    if (cache) {
      const vectors = readEmbeddingF16VectorsForPathsSync(cache, frameImagePaths.values())
      errors += collectFrameVectorsFromCache(vectors, frameImagePaths, modelName, outByKey)
      continue
    }
    errors += collectFrameVectorsFromJsonlSync(modelName, frameImagePaths, outByKey)
  }

  try {
    entries = outByKey.size
    writeFrameIndexEntriesSync(tmp, outByKey.values())
    fs.renameSync(tmp, getFrameIndexPath())
    writeFrameIndexMeta(entries, errors)
    clearFrameIndexMemoryCacheNow()
  } catch (error) {
    console.error('[MediaSearch] frame index write failed', error)
    errors++
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* best-effort temporary cleanup */
    }
  }
  return { entries, errors }
}

/** Rebuild through streaming I/O so stale indexes do not freeze the main process. */
export async function buildFrameIndexAsync(): Promise<{ entries: number; errors: number }> {
  if (frameIndexBuildPromise) return frameIndexBuildPromise

  frameIndexBuildPromise = (async () => {
    const frames = loadVideoFrameManifest()
    const frameImagePaths = new Map(
      frames
        .filter(
          (record) =>
            record.status === 'done' && record.imagePath && fs.existsSync(record.imagePath),
        )
        .map((record) => {
          const imagePath = record.imagePath as string
          return [normalizeFrameKey(imagePath), imagePath] as const
        }),
    )

    if (frameImagePaths.size === 0) {
      try {
        await fs.promises.writeFile(getFrameIndexPath(), '', 'utf-8')
        writeFrameIndexMeta(0, 0)
        clearFrameIndexMemoryCacheNow()
      } catch {
        return { entries: 0, errors: 1 }
      }
      return { entries: 0, errors: 0 }
    }

    const indexPath = getFrameIndexPath()
    await fs.promises.mkdir(path.dirname(indexPath), { recursive: true })
    const tmp = `${indexPath}.tmp-${process.pid}-${Date.now()}`
    let errors = 0
    const outByKey = new Map<string, FrameVectorEntry>()

    for (const modelName of FRAME_INDEX_MODELS) {
      // Prefer the authoritative generation / shared F16 cache (ensured fresh
      // here); fall back to scanning the shards when no snapshot is usable.
      const cache = await ensureEmbeddingF16Cache(getFrameEmbeddingCacheOptions(modelName))
      if (cache) {
        const vectors = await readEmbeddingF16VectorsForPaths(cache, frameImagePaths.values())
        errors += collectFrameVectorsFromCache(vectors, frameImagePaths, modelName, outByKey)
        continue
      }
      errors += await collectFrameVectorsFromJsonlAsync(modelName, frameImagePaths, outByKey)
    }

    const entries = outByKey.size
    try {
      await writeFrameIndexEntriesAsync(tmp, outByKey.values())
      await fs.promises.rename(tmp, indexPath)
      writeFrameIndexMeta(entries, errors)
      await ensureVideoFrameVectorLookup(indexPath, getFrameIndexLookupPath())
      clearFrameIndexMemoryCacheNow()
      frameIndexLoadPromises.clear()
    } catch (error) {
      console.error('[MediaSearch] frame index write failed', error)
      errors++
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
    }
    return { entries, errors }
  })()

  try {
    return await frameIndexBuildPromise
  } finally {
    frameIndexBuildPromise = null
  }
}

/** Load frame vectors for a given model from the frame index. */
export function loadFrameIndex(
  modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32',
): Map<string, RuntimeFrameVector> {
  const indexPath = getFrameIndexPath()
  const signature = `${modelName}:${fileSignature(indexPath)}`
  const cached = frameIndexCache.get(modelName)
  if (cached?.signature === signature)
    return touchFrameIndexCache(modelName) as Map<string, RuntimeFrameVector>
  const index = new Map<string, RuntimeFrameVector>()
  try {
    if (!fs.existsSync(indexPath)) {
      cacheFrameIndex(modelName, signature, index)
      return index
    }
    ensureVideoFrameVectorLookupSync(indexPath, getFrameIndexLookupPath())
    const indexed = loadVideoFrameVectorMap(getFrameIndexLookupPath(), modelName)
    cacheFrameIndex(modelName, signature, indexed)
    return indexed
  } catch {
    // A synchronous caller may arrive before the derived SQLite lookup has
    // been rebuilt. Stream the compatibility JSONL instead of reading/splitting it.
  }
  const modelNeedle = `"modelName":"${modelName}"`
  const pathByKey = new Map<string, string>()
  try {
    scanJsonLinesSync(indexPath, (line) => {
      if (!line || !line.includes(modelNeedle)) return
      try {
        const entry = JSON.parse(line) as FrameVectorEntry
        applyFrameIndexEntry(index, pathByKey, entry, modelName)
      } catch {
        /* skip malformed */
      }
    })
  } catch {
    return index
  }
  cacheFrameIndex(modelName, signature, index)
  return index
}

/** Stream frame vectors without blocking Electron's main thread on a large readFileSync. */
export async function loadFrameIndexAsync(
  modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32',
): Promise<Map<string, RuntimeFrameVector>> {
  const indexPath = getFrameIndexPath()
  const signature = `${modelName}:${fileSignature(indexPath)}`
  const cached = frameIndexCache.get(modelName)
  if (cached?.signature === signature)
    return touchFrameIndexCache(modelName) as Map<string, RuntimeFrameVector>

  const pending = frameIndexLoadPromises.get(modelName)
  if (pending?.signature === signature) return pending.promise

  const promise = (async () => {
    const index = new Map<string, RuntimeFrameVector>()
    if (!fs.existsSync(indexPath)) {
      cacheFrameIndex(modelName, signature, index)
      return index
    }

    await ensureVideoFrameVectorLookup(indexPath, getFrameIndexLookupPath())
    const indexed = loadVideoFrameVectorMap(getFrameIndexLookupPath(), modelName)

    if (`${modelName}:${fileSignature(indexPath)}` === signature) {
      cacheFrameIndex(modelName, signature, indexed)
    }
    return indexed
  })()

  frameIndexLoadPromises.set(modelName, { signature, promise })
  try {
    return await promise
  } finally {
    if (frameIndexLoadPromises.get(modelName)?.promise === promise) {
      frameIndexLoadPromises.delete(modelName)
    }
  }
}

export async function scanFrameIndexVectors(
  modelName: FrameIndexModelName,
  onVector: (imagePath: string, vector: RuntimeFrameVector) => void,
  options: { isCancelled?: () => boolean; yieldEvery?: number } = {},
): Promise<{ entries: number; scanned: number }> {
  const indexPath = getFrameIndexPath()
  await ensureVideoFrameVectorLookup(indexPath, getFrameIndexLookupPath())
  const entries = countVideoFrameVectors(getFrameIndexLookupPath(), modelName)
  const scanned = await scanVideoFrameVectors(
    getFrameIndexLookupPath(),
    modelName,
    onVector,
    options,
  )
  return { entries, scanned }
}

export async function getFrameIndexVectorCount(modelName: FrameIndexModelName): Promise<number> {
  await ensureVideoFrameVectorLookup(getFrameIndexPath(), getFrameIndexLookupPath())
  return countVideoFrameVectors(getFrameIndexLookupPath(), modelName)
}

export function collectFrameIndexImagePaths(
  modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32',
): Set<string> {
  const indexPath = getFrameIndexPath()
  const imagePaths = new Set<string>()
  if (!fs.existsSync(indexPath)) return imagePaths
  const modelNeedle = `"modelName":"${modelName}"`
  const valid = new Map<string, string>()
  try {
    scanJsonLinesSync(indexPath, (line) => {
      if (!line || !line.includes(modelNeedle)) return
      try {
        const entry = JSON.parse(line) as FrameVectorEntry
        if (entry.modelName !== modelName || typeof entry.imagePath !== 'string') return
        const key = normalizeFrameKey(entry.imagePath)
        const dim = expectedFrameVectorDim(modelName)
        if (entry.dim !== dim || !normalizeFrameVector(entry.vector, dim)) {
          valid.delete(key)
          return
        }
        valid.set(key, entry.imagePath)
      } catch {
        /* skip malformed index row */
      }
    })
  } catch {
    return imagePaths
  }
  for (const imagePath of valid.values()) imagePaths.add(imagePath)
  return imagePaths
}

/** Find one frame vector from the compact index, the in-sync generation/F16
 *  cache, or — as a last resort — the embedding shards. */
export function findFrameVector(
  imagePath: string,
  modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32',
): RuntimeFrameVector | undefined {
  const targetKey = normalizeFrameKey(imagePath)
  // The compact v2 index is authoritative only when its source signature is
  // current. In that common case it avoids a full JSONL scan on every query;
  // its strict load path has already applied invalid-row tombstones.
  if (isFrameIndexFresh()) {
    try {
      ensureVideoFrameVectorLookupSync(getFrameIndexPath(), getFrameIndexLookupPath())
      return findVideoFrameVector(getFrameIndexLookupPath(), modelName, imagePath)
    } catch {
      let indexed: RuntimeFrameVector | undefined
      const modelNeedle = `"modelName":"${modelName}"`
      scanJsonLinesSync(getFrameIndexPath(), (line) => {
        if (!line || !line.includes(modelNeedle)) return
        try {
          const entry = JSON.parse(line) as FrameVectorEntry
          if (normalizeFrameKey(entry.imagePath) !== targetKey) return
          const dim = expectedFrameVectorDim(modelName)
          const vector = entry.dim === dim ? normalizeFrameVector(entry.vector, dim) : null
          indexed = vector ? new Float32Array(vector) : undefined
        } catch {
          /* skip malformed */
        }
      })
      return indexed
    }
  }

  const modelNeedle = `"modelName":${JSON.stringify(modelName)}`
  const typeNeedle = '"embeddingType":"global"'
  const dim = expectedFrameVectorDim(modelName)
  let latest: RuntimeFrameVector | null | undefined
  for (const filePath of getEmbeddingStorePaths(modelName, 'global')) {
    try {
      scanJsonLinesSync(filePath, (line) => {
        if (!line || !line.includes(modelNeedle) || !line.includes(typeNeedle)) return
        try {
          const row = JSON.parse(line) as {
            imageId?: unknown
            modelName?: unknown
            embeddingType?: unknown
            dim?: unknown
            vector?: unknown
          }
          if (
            row.modelName === modelName &&
            row.embeddingType === 'global' &&
            typeof row.imageId === 'string' &&
            normalizeFrameKey(row.imageId) === targetKey
          ) {
            // Finish every shard: a current-shard invalid revision is a
            // tombstone for a legacy valid row, while a later valid revision
            // can repair an earlier one.
            const vector = row.dim === dim ? normalizeFrameVector(row.vector, dim) : null
            latest = vector ? new Float32Array(vector) : null
          }
        } catch {
          /* skip malformed */
        }
      })
    } catch {
      continue
    }
  }
  if (latest !== undefined) return latest || undefined

  // With no source revision at all, an in-sync F16 snapshot is a safe fast
  // fallback. A stale compact index is deliberately never used here.
  const cache = readFreshEmbeddingF16Cache(getFrameEmbeddingCacheOptions(modelName))
  if (cache) {
    const fromCache = readEmbeddingF16VectorsForPathsSync(cache, [imagePath]).get(
      embeddingCachePathKey(imagePath),
    )
    const normalized = fromCache ? normalizeFrameVector(fromCache, dim) : null
    if (normalized) return new Float32Array(normalized)
  }
  return undefined
}

/** Delete the frame index so it will be rebuilt on next search. */
export function invalidateFrameIndex(): void {
  try {
    frameIndexPressureReleasePending = false
    clearFrameIndexMemoryCacheNow()
    frameIndexLoadPromises.clear()
    const p = getFrameIndexPath()
    if (fs.existsSync(p)) fs.unlinkSync(p)
    const metaPath = getFrameIndexMetaPath()
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath)
    removeVideoFrameVectorLookup(getFrameIndexLookupPath())
  } catch {
    /* ignore */
  }
}

/** Check whether the frame index exists and is non-empty. */
export function hasFrameIndex(): boolean {
  try {
    const p = getFrameIndexPath()
    return fs.existsSync(p) && fs.statSync(p).size > 0
  } catch {
    return false
  }
}
