import fs from 'fs'
import path from 'path'
import readline from 'readline'
import {
  authoritativeVectorStoreRootFromCacheDir,
  openAuthoritativeVectorStore,
  readCurrentAuthoritativeManifest,
  sha256FileTailSync,
  verifyFileChunkIntegritySync,
  type AuthoritativeVectorStoreHandle,
} from './authoritativeVectorStore'
import {
  createEmbeddingCacheFileProof,
  noteEmbeddingCacheIntegrityFailure,
  verifyEmbeddingCacheFileProof,
  type EmbeddingCacheFileProof,
} from './embeddingCacheIntegrity'
import { readEmbeddingIncrementSnapshot } from './embeddingIncrementLog'
import {
  requireNormalizedEmbeddingVector,
  validateEmbeddingVector,
} from './embeddingVectorValidation'

// Version 3 requires a committed content proof (SHA-256 of the vectors and
// paths segments) in the derived cache meta. Version 2 caches carry no proof
// and are safely invalidated: readers reject them and the next ensure*
// rebuilds them from the source JSONL. No user data is migrated.
export const EMBEDDING_F16_CACHE_VERSION = 3
const MAX_EMBEDDING_ROWS = 1_000_000
const MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024

export interface EmbeddingF16CacheSource {
  path: string
  size: number
  mtimeMs: number
}

/** Content proofs committed into the derived cache meta (version 3). */
export interface EmbeddingF16CacheIntegrityMeta {
  vectorsSha256: string
  pathsSha256: string
}

/**
 * Unified integrity proof of a (possibly composite) F16 cache handle: the
 * committed size+SHA-256 of every on-disk segment the handle serves. Readers
 * verify the segments against these proofs before handing the handle out, and
 * the ANN worker re-verifies them against the bytes it actually read.
 */
export interface EmbeddingF16CacheIntegrity {
  vectors: EmbeddingCacheFileProof
  paths: EmbeddingCacheFileProof
  deltaVectors?: EmbeddingCacheFileProof
  deltaPaths?: EmbeddingCacheFileProof
}

export interface EmbeddingF16CacheMeta {
  version: number
  modelName: string
  embeddingType: string
  dim: number
  count: number
  sourceRecordCount: number
  sourceFiles: EmbeddingF16CacheSource[]
  updatedAt: number
  generation?: string
  /** Present in every version-3 derived meta; enforced on read. */
  integrity?: EmbeddingF16CacheIntegrityMeta
}

export interface EmbeddingF16CacheDeltaSegment {
  vectorPath: string
  pathIndexPath: string
  /** Rows below baseCount live in the base files; rows >= baseCount live in the delta segment. */
  baseCount: number
}

export interface EmbeddingF16CacheHandle {
  meta: EmbeddingF16CacheMeta
  vectorPath: string
  pathIndexPath: string
  /**
   * Committed increment segment on top of the base snapshot (D3 stage 2
   * composite read). Present only when a valid delta commit extends the base;
   * meta.count/meta.sourceRecordCount already include the delta rows.
   */
  delta?: EmbeddingF16CacheDeltaSegment
  /**
   * Content proofs of the on-disk segments, verified when the handle was
   * minted. Undefined only for handles constructed outside the mint paths
   * (legacy/test callers), which the ANN worker treats as unproven legacy.
   */
  integrity?: EmbeddingF16CacheIntegrity
}

export interface EmbeddingF16CacheProgress {
  phase: 'building' | 'compacting' | 'loading'
  current: number
  total: number
  percent: number
  message: string
}

export interface StreamEmbeddingF16CacheOptions {
  isCancelled?: () => boolean
  shouldStop?: () => boolean
  onProgress?: (progress: EmbeddingF16CacheProgress) => void
  onVector: (filePath: string, vector: Float32Array, row: number) => void
}

export interface SearchEmbeddingF16CacheOptions {
  queryVector: Float32Array | number[]
  topK: number
  isCancelled?: () => boolean
  acceptPath?: (filePath: string) => boolean
  onProgress?: (progress: EmbeddingF16CacheProgress) => void
}

export interface EmbeddingF16SearchResult {
  path: string
  row: number
  score: number
}

export interface EnsureEmbeddingF16CacheOptions {
  cacheDir: string
  modelName: string
  embeddingType?: string
  dim: number
  sourcePaths: string[]
  isCancelled?: () => boolean
  onProgress?: (progress: EmbeddingF16CacheProgress) => void
  preferAuthoritative?: boolean
}

interface EmbeddingJsonlRow {
  modelName?: string
  embeddingType?: string
  imageId?: string
  dim?: number
  vector?: unknown
}

interface CachePathRow {
  row: number
  path: string
}

export interface EmbeddingF16CachePathRow {
  row: number
  path: string
}

const buildPromises = new Map<string, Promise<EmbeddingF16CacheHandle | null>>()
const cacheInvalidationEpochs = new Map<string, number>()
const invalidatedCacheKeys = new Set<string>()
const float32Scratch = new Float32Array(1)
const uint32Scratch = new Uint32Array(float32Scratch.buffer)

export function isEmbeddingF16CacheBuildRunning(): boolean {
  return buildPromises.size > 0
}

function sanitizePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96) || 'unknown'
}

export function embeddingCachePathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function cachePaths(
  cacheDir: string,
  modelName: string,
  embeddingType: string,
): { meta: string; vectors: string; paths: string } {
  const base = `${sanitizePart(modelName)}__${sanitizePart(embeddingType)}`
  return {
    meta: path.join(cacheDir, `${base}.f16.json`),
    vectors: path.join(cacheDir, `${base}.f16`),
    paths: path.join(cacheDir, `${base}.paths.jsonl`),
  }
}

function cacheBuildKey(cacheDir: string, modelName: string, embeddingType: string): string {
  return `${path.resolve(cacheDir)}:${modelName}:${embeddingType}`
}

/**
 * Invalidates only the small derived-cache commit point. Large F16/path files
 * remain disposable on disk and are replaced by the next successful rebuild.
 * Advancing the epoch also makes an already-running build cancel or discard
 * its commit instead of publishing a snapshot from before source cleanup.
 */
export async function invalidateEmbeddingF16CacheMetadata(
  cacheDir: string,
  modelName: string,
  embeddingType = 'global',
): Promise<void> {
  const key = cacheBuildKey(cacheDir, modelName, embeddingType)
  cacheInvalidationEpochs.set(key, (cacheInvalidationEpochs.get(key) || 0) + 1)
  invalidatedCacheKeys.add(key)
  const metaPath = cachePaths(cacheDir, modelName, embeddingType).meta
  const quarantinedMeta = `${metaPath}.${process.pid}.${Date.now()}.invalidated.tmp`
  let quarantineError: unknown
  try {
    fs.renameSync(metaPath, quarantinedMeta)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') quarantineError = error
  }
  try {
    await fs.promises.rm(metaPath, { force: true })
    await fs.promises.rm(quarantinedMeta, { force: true })
  } catch (error) {
    throw new AggregateError(
      quarantineError ? [quarantineError, error] : [error],
      'Could not invalidate embedding cache metadata',
      { cause: error },
    )
  }
}

function cleanupCacheTemporaryFiles(options: EnsureEmbeddingF16CacheOptions): void {
  const embeddingType = options.embeddingType || 'global'
  const base = `${sanitizePart(options.modelName)}__${sanitizePart(embeddingType)}`
  try {
    for (const name of fs.readdirSync(options.cacheDir)) {
      if (!name.startsWith(base) || (!name.includes('.tmp') && !name.includes('.rows.'))) continue
      try {
        fs.unlinkSync(path.join(options.cacheDir, name))
      } catch {
        /* A concurrent process may still own the temporary file. */
      }
    }
  } catch {
    /* The cache directory may not exist yet. */
  }
}

function sourceFiles(sourcePaths: string[]): EmbeddingF16CacheSource[] | null {
  const result: EmbeddingF16CacheSource[] = []
  for (const sourcePath of sourcePaths) {
    try {
      const stat = fs.statSync(sourcePath)
      if (!stat.isFile()) return null
      result.push({ path: sourcePath, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch {
      return null
    }
  }
  return result
}

function sameSources(left: EmbeddingF16CacheSource[], right: EmbeddingF16CacheSource[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.path === right[index]?.path &&
        item.size === right[index]?.size &&
        item.mtimeMs === right[index]?.mtimeMs,
    )
  )
}

function isValidCacheIntegrityMeta(value: unknown): value is EmbeddingF16CacheIntegrityMeta {
  if (!value || typeof value !== 'object') return false
  const integrity = value as EmbeddingF16CacheIntegrityMeta
  return (
    /^[a-f0-9]{64}$/.test(integrity.vectorsSha256) && /^[a-f0-9]{64}$/.test(integrity.pathsSha256)
  )
}

function readCache(
  options: EnsureEmbeddingF16CacheOptions,
  requireFreshSources: boolean,
): EmbeddingF16CacheHandle | null {
  const embeddingType = options.embeddingType || 'global'
  if (invalidatedCacheKeys.has(cacheBuildKey(options.cacheDir, options.modelName, embeddingType))) {
    return null
  }
  const files = cachePaths(options.cacheDir, options.modelName, embeddingType)
  const sources = requireFreshSources ? sourceFiles(options.sourcePaths) : null
  if (requireFreshSources && !sources) return null
  try {
    const meta = JSON.parse(fs.readFileSync(files.meta, 'utf8')) as EmbeddingF16CacheMeta
    if (
      meta.version !== EMBEDDING_F16_CACHE_VERSION ||
      meta.modelName !== options.modelName ||
      meta.embeddingType !== embeddingType ||
      meta.dim !== options.dim ||
      !Number.isInteger(meta.count) ||
      meta.count < 0 ||
      meta.count > MAX_EMBEDDING_ROWS ||
      !isValidCacheIntegrityMeta(meta.integrity) ||
      (requireFreshSources && !sameSources(meta.sourceFiles, sources!))
    ) {
      return null
    }
    const vectorStat = fs.statSync(files.vectors)
    const pathStat = fs.statSync(files.paths)
    if (vectorStat.size !== meta.count * meta.dim * 2) return null
    if (meta.count > 0 && pathStat.size <= 0) return null
    const integrity: EmbeddingF16CacheIntegrity = {
      vectors: { size: vectorStat.size, sha256: meta.integrity.vectorsSha256 },
      paths: { size: pathStat.size, sha256: meta.integrity.pathsSha256 },
    }
    if (
      !verifyEmbeddingCacheFileProof(files.vectors, integrity.vectors) ||
      !verifyEmbeddingCacheFileProof(files.paths, integrity.paths)
    ) {
      noteEmbeddingCacheIntegrityFailure(
        'derived-read',
        `derived F16 cache failed its content proof (${files.vectors})`,
      )
      return null
    }
    return { meta, vectorPath: files.vectors, pathIndexPath: files.paths, integrity }
  } catch {
    return null
  }
}

function readFreshCache(options: EnsureEmbeddingF16CacheOptions): EmbeddingF16CacheHandle | null {
  const authoritative = readAuthoritativeCache(options)
  if (authoritative) return authoritative
  const composite = readCompositeCache(options, true)
  if (composite) return composite
  return readCache(options, true)
}

/**
 * Opens the CURRENT authoritative generation entry and verifies its vector and
 * path files against the content proofs pinned by the manifest (VAL-038).
 * Returns null — fail-closed — when the on-disk bytes drifted from the
 * committed proofs after the generation was switched in.
 */
function openVerifiedAuthoritative(
  storeRoot: string,
  modelName: string,
  embeddingType: string,
  dim: number,
  expectedSourcePaths?: string[],
): (AuthoritativeVectorStoreHandle & { integrity: EmbeddingF16CacheIntegrity }) | null {
  const handle = openAuthoritativeVectorStore(
    storeRoot,
    modelName,
    embeddingType,
    dim,
    false,
    expectedSourcePaths,
  )
  if (!handle) return null
  const integrity: EmbeddingF16CacheIntegrity = {
    vectors: { size: handle.files.vectors.size, sha256: handle.files.vectors.sha256 },
    paths: { size: handle.files.paths.size, sha256: handle.files.paths.sha256 },
  }
  if (
    !verifyEmbeddingCacheFileProof(handle.vectorPath, integrity.vectors) ||
    !verifyEmbeddingCacheFileProof(handle.pathIndexPath, integrity.paths)
  ) {
    noteEmbeddingCacheIntegrityFailure(
      'authoritative-read',
      `authoritative generation ${handle.meta.generation} failed its content proof (${handle.vectorPath})`,
    )
    return null
  }
  return { ...handle, integrity }
}

/**
 * Composite read of "base generation + committed increment" (D3 stage 2).
 * Returns a handle whose meta counts include the delta rows and whose delta
 * segment locates rows >= baseCount. With requireComplete the snapshot must
 * exactly match the current source stats (freshness reads); otherwise a
 * "JSONL ahead of increment" snapshot is still returned for stale-tolerant
 * reads. Returns null when no valid increment exists — callers fall back to
 * the pre-D3 paths, which is exactly the stage-1 behavior.
 */
function readCompositeCache(
  options: EnsureEmbeddingF16CacheOptions,
  requireComplete: boolean,
): EmbeddingF16CacheHandle | null {
  if (options.preferAuthoritative === false) return null
  if (
    invalidatedCacheKeys.has(
      cacheBuildKey(options.cacheDir, options.modelName, options.embeddingType || 'global'),
    )
  ) {
    return null
  }
  const storeRoot = authoritativeVectorStoreRootFromCacheDir(options.cacheDir)
  const snapshot = readEmbeddingIncrementSnapshot(
    storeRoot,
    options.modelName,
    options.embeddingType || 'global',
    options.dim,
    options.sourcePaths,
  )
  if (!snapshot || (requireComplete && !snapshot.complete)) return null
  const base = openVerifiedAuthoritative(
    storeRoot,
    options.modelName,
    options.embeddingType || 'global',
    options.dim,
  )
  if (!base || base.meta.generation !== snapshot.generation) return null
  const deltaSource = (filePath: string): EmbeddingF16CacheSource => {
    const stat = fs.statSync(filePath)
    return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs }
  }
  return {
    meta: {
      ...base.meta,
      count: snapshot.commit.baseCount + snapshot.commit.deltaCount,
      sourceRecordCount: snapshot.commit.baseSourceRecordCount + snapshot.commit.deltaCount,
      sourceFiles: [
        ...base.meta.sourceFiles,
        deltaSource(snapshot.vectorPath),
        deltaSource(snapshot.pathIndexPath),
      ],
    },
    vectorPath: base.vectorPath,
    pathIndexPath: base.pathIndexPath,
    delta: {
      vectorPath: snapshot.vectorPath,
      pathIndexPath: snapshot.pathIndexPath,
      baseCount: snapshot.commit.baseCount,
    },
    integrity: {
      ...base.integrity,
      // The snapshot already verified the committed delta segments against
      // these proofs; carry them so downstream consumers (ANN) can re-verify
      // the bytes they read.
      deltaVectors: {
        size: snapshot.commit.deltaCount * snapshot.commit.dim * 2,
        sha256: snapshot.commit.vectorsSha256,
      },
      deltaPaths: {
        size: snapshot.commit.pathsBytes,
        sha256: snapshot.commit.pathsSha256,
      },
    },
  }
}

function readAuthoritativeCache(
  options: EnsureEmbeddingF16CacheOptions,
): EmbeddingF16CacheHandle | null {
  if (options.preferAuthoritative === false) return null
  if (
    invalidatedCacheKeys.has(
      cacheBuildKey(options.cacheDir, options.modelName, options.embeddingType || 'global'),
    )
  ) {
    return null
  }
  return openVerifiedAuthoritative(
    authoritativeVectorStoreRootFromCacheDir(options.cacheDir),
    options.modelName,
    options.embeddingType || 'global',
    options.dim,
    options.sourcePaths,
  )
}

/**
 * Stable fingerprint of the exact source snapshot a handle indexes. Shared by
 * the ANN worker (loaded-index key) and the main-process prewarm scheduler
 * (per-generation dedupe), so both agree on what "same index" means.
 */
export function embeddingF16CacheSourceFingerprint(cache: EmbeddingF16CacheHandle): string {
  return JSON.stringify({
    version: cache.meta.version,
    modelName: cache.meta.modelName,
    embeddingType: cache.meta.embeddingType,
    dim: cache.meta.dim,
    count: cache.meta.count,
    sourceRecordCount: cache.meta.sourceRecordCount,
    sourceFiles: cache.meta.sourceFiles,
  })
}

/**
 * Opens the CURRENT authoritative generation pinned by the manifest WITHOUT
 * re-hashing the vector/path files on the caller's thread. The handle still
 * carries the manifest-pinned content proofs, so downstream consumers (the
 * ANN worker's VAL-038 gate) re-verify every byte they index — off the main
 * thread and fail-closed. Source freshness is intentionally not required:
 * background warmers only need the committed generation bytes.
 */
export function openAuthoritativeEmbeddingF16Cache(
  options: EnsureEmbeddingF16CacheOptions,
): EmbeddingF16CacheHandle | null {
  if (options.preferAuthoritative === false) return null
  if (
    invalidatedCacheKeys.has(
      cacheBuildKey(options.cacheDir, options.modelName, options.embeddingType || 'global'),
    )
  ) {
    return null
  }
  const handle = openAuthoritativeVectorStore(
    authoritativeVectorStoreRootFromCacheDir(options.cacheDir),
    options.modelName,
    options.embeddingType || 'global',
    options.dim,
    false,
  )
  if (!handle) return null
  const integrity: EmbeddingF16CacheIntegrity = {
    vectors: { size: handle.files.vectors.size, sha256: handle.files.vectors.sha256 },
    paths: { size: handle.files.paths.size, sha256: handle.files.paths.sha256 },
  }
  return { ...handle, integrity }
}

/**
 * Returns a cache handle only when it is provably in sync with the current
 * sources: a CURRENT authoritative generation whose imports match, or a
 * derived cache built from the exact current source stats. Returns null when
 * the sources changed since either snapshot was built, so callers can fall
 * back to scanning the JSONL sources (or to an async ensure*) instead of
 * serving stale rows from a synchronous path.
 */
export function readFreshEmbeddingF16Cache(
  options: EnsureEmbeddingF16CacheOptions,
): EmbeddingF16CacheHandle | null {
  return readFreshCache(options)
}

export interface EmbeddingVectorSourceDescription {
  kind: 'generation' | 'jsonl' | 'missing'
  fingerprint: string
}

/**
 * Freshness fingerprint of the vector source a consumer would read right now:
 * the CURRENT authoritative generation when its imports still match the
 * source JSONL stats, the generation extended by a complete committed
 * increment (fingerprint carries count+δ) when appends have been double
 * written, otherwise the source JSONL stats themselves (which is what a
 * rebuild would consume). Freshness signatures derived indexes hang on
 * this fingerprint instead of raw shard mtimes, so a generation switch keeps
 * derived data valid while any source drift still invalidates it.
 */
export function describeEmbeddingVectorSource(
  options: EnsureEmbeddingF16CacheOptions,
): EmbeddingVectorSourceDescription {
  const authoritative = readAuthoritativeCache(options)
  if (authoritative?.meta.generation) {
    return {
      kind: 'generation',
      fingerprint: `generation:${authoritative.meta.generation}:${authoritative.meta.count}:${authoritative.meta.sourceRecordCount}`,
    }
  }
  const composite = readCompositeCache(options, true)
  if (composite?.meta.generation) {
    return {
      kind: 'generation',
      fingerprint: `generation:${composite.meta.generation}:${composite.meta.count}:${composite.meta.sourceRecordCount}`,
    }
  }
  const sources = sourceFiles(options.sourcePaths)
  if (!sources || sources.length === 0) return { kind: 'missing', fingerprint: 'missing' }
  return {
    kind: 'jsonl',
    fingerprint: `jsonl:${sources
      .map((source) => `${path.resolve(source.path)}=${source.size}:${source.mtimeMs}`)
      .join('|')}`,
  }
}

/**
 * Freshness key for derived indexes that only depend on the generation
 * identity (e.g. the media-search frame index): appends within the same
 * generation keep the key stable, while a generation switch or a fallback to
 * raw JSONL stats still invalidates the derived data.
 */
export function embeddingVectorSourceStabilityKey(
  source: EmbeddingVectorSourceDescription,
): string {
  if (source.kind !== 'generation') return source.fingerprint
  const [kind, generation] = source.fingerprint.split(':')
  return `${kind}:${generation}`
}

/**
 * Returns the last complete cache even when source JSONL files have grown.
 * Interactive search uses this snapshot to avoid rebuilding multi-gigabyte
 * sources inside its timeout; maintenance workflows still refresh it.
 */
export function readExistingEmbeddingF16Cache(
  options: EnsureEmbeddingF16CacheOptions,
): EmbeddingF16CacheHandle | null {
  const authoritative = readAuthoritativeCache(options)
  if (authoritative) return authoritative
  // A "JSONL ahead of increment" composite snapshot is still the newest
  // complete view a stale-tolerant reader may serve.
  const composite = readCompositeCache(options, false)
  if (composite) return composite
  return readCache(options, false)
}

export function float32ToFloat16(value: number): number {
  float32Scratch[0] = value
  const bits = uint32Scratch[0]
  const sign = (bits >>> 16) & 0x8000
  const exponent = (bits >>> 23) & 0xff
  const mantissa = bits & 0x7fffff

  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x0200 : 0)
  const halfExponent = exponent - 127 + 15
  if (halfExponent >= 0x1f) return sign | 0x7c00
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign
    const normalized = (mantissa | 0x800000) >>> (1 - halfExponent)
    return sign | ((normalized + 0x1000) >>> 13)
  }
  return sign | (halfExponent << 10) | ((mantissa + 0x1000) >>> 13)
}

export function float16ToFloat32(value: number): number {
  const sign = (value & 0x8000) << 16
  let exponent = (value >>> 10) & 0x1f
  let mantissa = value & 0x03ff
  let bits: number
  if (exponent === 0) {
    if (mantissa === 0) {
      bits = sign
    } else {
      exponent = 1
      while ((mantissa & 0x0400) === 0) {
        mantissa <<= 1
        exponent -= 1
      }
      mantissa &= 0x03ff
      bits = sign | ((exponent + 112) << 23) | (mantissa << 13)
    }
  } else if (exponent === 0x1f) {
    bits = sign | 0x7f800000 | (mantissa << 13)
  } else {
    bits = sign | ((exponent + 112) << 23) | (mantissa << 13)
  }
  uint32Scratch[0] = bits >>> 0
  return float32Scratch[0]
}

function encodeNormalizedVector(values: unknown, dim: number): Buffer | null {
  const validation = validateEmbeddingVector(values, dim)
  if (!validation.ok) return null
  const vector = values as number[] | Float32Array
  const output = Buffer.allocUnsafe(dim * 2)
  for (let index = 0; index < dim; index++) {
    output.writeUInt16LE(
      float32ToFloat16(vector[index] / validation.scale / validation.scaledNorm),
      index * 2,
    )
  }
  return output
}

function replaceDerivedFile(temporaryPath: string, finalPath: string): void {
  if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath)
  fs.renameSync(temporaryPath, finalPath)
}

async function buildCache(
  options: EnsureEmbeddingF16CacheOptions,
): Promise<EmbeddingF16CacheHandle | null> {
  const embeddingType = options.embeddingType || 'global'
  const sources = sourceFiles(options.sourcePaths)
  if (!sources || sources.length === 0) return null
  fs.mkdirSync(options.cacheDir, { recursive: true })
  const files = cachePaths(options.cacheDir, options.modelName, embeddingType)
  const suffix = `.${process.pid}.${Date.now()}.tmp`
  const rawPath = `${files.vectors}.rows${suffix}`
  const vectorTmp = `${files.vectors}${suffix}`
  const pathTmp = `${files.paths}${suffix}`
  const metaTmp = `${files.meta}${suffix}`
  const latestRows = new Map<string, { path: string; row: number }>()
  const totalBytes = sources.reduce((sum, item) => sum + item.size, 0)
  let bytesRead = 0
  let sourceRecordCount = 0
  const rawFd = fs.openSync(rawPath, 'w')

  try {
    for (const source of sources) {
      const reader = readline.createInterface({
        input: fs.createReadStream(source.path, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      })
      for await (const line of reader) {
        if (options.isCancelled?.()) throw new Error('Embedding cache build cancelled')
        bytesRead += Buffer.byteLength(line, 'utf8') + 1
        if (!line || Buffer.byteLength(line, 'utf8') > MAX_JSONL_LINE_BYTES) continue
        let entry: EmbeddingJsonlRow
        try {
          entry = JSON.parse(line) as EmbeddingJsonlRow
        } catch {
          continue
        }
        if (
          entry.modelName !== options.modelName ||
          entry.embeddingType !== embeddingType ||
          typeof entry.imageId !== 'string'
        ) {
          continue
        }
        const key = embeddingCachePathKey(entry.imageId)
        latestRows.delete(key)
        const encoded =
          entry.dim === options.dim ? encodeNormalizedVector(entry.vector, options.dim) : null
        if (!encoded) continue
        if (sourceRecordCount >= MAX_EMBEDDING_ROWS) {
          throw new Error(`Embedding cache row limit exceeded (${MAX_EMBEDDING_ROWS})`)
        }
        fs.writeSync(rawFd, encoded)
        latestRows.set(key, {
          path: entry.imageId,
          row: sourceRecordCount,
        })
        sourceRecordCount += 1
        if (sourceRecordCount % 1000 === 0) {
          const percent =
            totalBytes > 0 ? Math.min(90, Math.round((bytesRead / totalBytes) * 90)) : 0
          options.onProgress?.({
            phase: 'building',
            current: bytesRead,
            total: totalBytes,
            percent,
            message: `Building ${options.modelName} Float16 cache: ${sourceRecordCount.toLocaleString()} records`,
          })
          if (sourceRecordCount % 4000 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve))
          }
        }
      }
    }
  } finally {
    fs.closeSync(rawFd)
  }

  const latest = [...latestRows.values()].sort((left, right) => left.row - right.row)
  const sourceFd = fs.openSync(rawPath, 'r')
  const vectorFd = fs.openSync(vectorTmp, 'w')
  const pathStream = fs.createWriteStream(pathTmp, { encoding: 'utf8' })
  const rowBuffer = Buffer.allocUnsafe(options.dim * 2)
  try {
    for (let index = 0; index < latest.length; index++) {
      if (options.isCancelled?.()) throw new Error('Embedding cache build cancelled')
      const item = latest[index]
      const read = fs.readSync(
        sourceFd,
        rowBuffer,
        0,
        rowBuffer.length,
        item.row * rowBuffer.length,
      )
      if (read !== rowBuffer.length) throw new Error('Could not compact embedding cache row')
      fs.writeSync(vectorFd, rowBuffer)
      pathStream.write(`${JSON.stringify({ row: index, path: item.path })}\n`)
      if ((index + 1) % 1000 === 0 || index + 1 === latest.length) {
        options.onProgress?.({
          phase: 'compacting',
          current: index + 1,
          total: latest.length,
          percent: 90 + Math.round(((index + 1) / Math.max(1, latest.length)) * 9),
          message: `Compacting Float16 cache: ${(index + 1).toLocaleString()}/${latest.length.toLocaleString()}`,
        })
        if ((index + 1) % 4000 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  } finally {
    fs.closeSync(sourceFd)
    fs.closeSync(vectorFd)
    await new Promise<void>((resolve) => pathStream.end(resolve))
  }

  if (options.isCancelled?.()) throw new Error('Embedding cache build cancelled')
  const integrity: EmbeddingF16CacheIntegrity = {
    vectors: createEmbeddingCacheFileProof(vectorTmp),
    paths: createEmbeddingCacheFileProof(pathTmp),
  }
  const meta: EmbeddingF16CacheMeta = {
    version: EMBEDDING_F16_CACHE_VERSION,
    modelName: options.modelName,
    embeddingType,
    dim: options.dim,
    count: latest.length,
    sourceRecordCount,
    sourceFiles: sources,
    updatedAt: Date.now(),
    integrity: {
      vectorsSha256: integrity.vectors.sha256,
      pathsSha256: integrity.paths.sha256,
    },
  }
  fs.writeFileSync(metaTmp, JSON.stringify(meta, null, 2), 'utf8')
  replaceDerivedFile(vectorTmp, files.vectors)
  replaceDerivedFile(pathTmp, files.paths)
  replaceDerivedFile(metaTmp, files.meta)
  try {
    fs.unlinkSync(rawPath)
  } catch {
    /* The next cache build also removes stale derived temporary files. */
  }
  options.onProgress?.({
    phase: 'compacting',
    current: latest.length,
    total: latest.length,
    percent: 100,
    message: `Float16 cache ready: ${latest.length.toLocaleString()} unique vectors`,
  })
  return { meta, vectorPath: files.vectors, pathIndexPath: files.paths, integrity }
}

/**
 * Incremental F16 cache extension. When the CURRENT authoritative generation
 * is stale only because the source JSONL grew by appends, merge just the new
 * rows on top of that generation instead of rebuilding from scratch. The
 * result is byte-identical to a full buildCache run (same latest-revision
 * ordering, same F16 encoding). Returns null when the sources cannot be
 * proven append-only (shrink, same-size rewrite, missing file, non-line
 * boundary), when there is no usable generation base, or when nothing was
 * appended — callers fall back to the full build.
 */
export async function extendEmbeddingF16Cache(
  options: EnsureEmbeddingF16CacheOptions,
): Promise<EmbeddingF16CacheHandle | null> {
  const embeddingType = options.embeddingType || 'global'
  const storeRoot = authoritativeVectorStoreRootFromCacheDir(options.cacheDir)
  const temporaryPaths: string[] = []
  const cleanup = () => {
    for (const target of temporaryPaths) {
      try {
        fs.unlinkSync(target)
      } catch {
        /* Temporary output may not exist. */
      }
    }
  }
  try {
    const manifest = readCurrentAuthoritativeManifest(storeRoot)
    const entry = manifest?.entries.find(
      (candidate) =>
        candidate.modelName === options.modelName &&
        candidate.embeddingType === embeddingType &&
        candidate.dim === options.dim,
    )
    if (!manifest || !entry) return null
    if (entry.imports.length !== options.sourcePaths.length) return null
    const generationDir = path.join(storeRoot, 'generations', manifest.generation)
    const oldVectorPath = path.join(generationDir, entry.vectors.name)
    const oldPathIndexPath = path.join(generationDir, entry.paths.name)
    // Never merge on top of a corrupted base: the generation files must still
    // match the content proofs pinned by the manifest, otherwise corrupt rows
    // would be copied into the new derived cache (VAL-038).
    if (
      !verifyEmbeddingCacheFileProof(oldVectorPath, entry.vectors) ||
      !verifyEmbeddingCacheFileProof(oldPathIndexPath, entry.paths)
    ) {
      noteEmbeddingCacheIntegrityFailure(
        'authoritative-extend',
        `authoritative generation ${manifest.generation} failed its content proof (${oldVectorPath})`,
      )
      return null
    }
    const increment = readEmbeddingIncrementSnapshot(
      storeRoot,
      options.modelName,
      embeddingType,
      options.dim,
      options.sourcePaths,
    )

    interface DeltaSource {
      source: EmbeddingF16CacheSource
      startOffset: number
    }
    const deltaSources: DeltaSource[] = []
    const sourceSnapshot: EmbeddingF16CacheSource[] = []
    for (let index = 0; index < entry.imports.length; index++) {
      const imported = entry.imports[index]
      const sourcePath = options.sourcePaths[index]
      if (path.resolve(sourcePath) !== path.resolve(imported.path)) return null
      const incrementAnchor = increment?.commit.sources.find(
        (source) => path.resolve(source.path) === path.resolve(sourcePath),
      )
      if (increment && !incrementAnchor) return null
      const anchor = incrementAnchor ?? imported
      if (anchor.size < imported.size) return null
      let stat: fs.Stats
      try {
        stat = fs.statSync(sourcePath)
      } catch {
        return null
      }
      if (!stat.isFile() || stat.size < anchor.size) return null
      if (
        anchor.tailSha256 !== undefined &&
        sha256FileTailSync(sourcePath, anchor.size) !== anchor.tailSha256
      ) {
        return null
      }
      if (
        anchor.chunkIntegrity !== undefined &&
        !verifyFileChunkIntegritySync(sourcePath, anchor.size, anchor.chunkIntegrity)
      ) {
        return null
      }
      if (stat.size === anchor.size) {
        // Same size but a changed mtime means an unverifiable rewrite.
        if (stat.mtimeMs !== anchor.mtimeMs) return null
        sourceSnapshot.push({ path: sourcePath, size: stat.size, mtimeMs: stat.mtimeMs })
        continue
      }
      if (anchor.size > 0) {
        const boundaryFd = fs.openSync(sourcePath, 'r')
        try {
          const boundary = Buffer.allocUnsafe(1)
          fs.readSync(boundaryFd, boundary, 0, 1, anchor.size - 1)
          if (boundary[0] !== 0x0a) return null
        } finally {
          fs.closeSync(boundaryFd)
        }
      }
      sourceSnapshot.push({ path: sourcePath, size: stat.size, mtimeMs: stat.mtimeMs })
      deltaSources.push({
        source: sourceSnapshot[sourceSnapshot.length - 1],
        startOffset: anchor.size,
      })
    }
    if (deltaSources.length === 0 && !increment) return null

    const oldPaths: string[] = new Array(entry.count)
    {
      const lines = fs.readFileSync(oldPathIndexPath, 'utf8').split(/\r?\n/)
      let parsed = 0
      for (const line of lines) {
        if (!line) continue
        const item = JSON.parse(line) as { row?: unknown; path?: unknown }
        if (
          typeof item.row !== 'number' ||
          !Number.isInteger(item.row) ||
          item.row < 0 ||
          item.row >= entry.count ||
          typeof item.path !== 'string'
        ) {
          return null
        }
        oldPaths[item.row] = item.path
        parsed++
      }
      if (parsed !== entry.count) return null
    }
    const oldRowByKey = new Map<string, number>()
    for (let row = 0; row < entry.count; row++) {
      oldRowByKey.set(embeddingCachePathKey(oldPaths[row]), row)
    }

    type NewRow = { key: string; path: string } & ({ encoded: Buffer } | { incrementRow: number })
    const newRows: NewRow[] = []
    let newMatched = 0
    if (increment) {
      if (entry.sourceRecordCount + increment.commit.deltaCount > MAX_EMBEDDING_ROWS) return null
      const reader = readline.createInterface({
        input: fs.createReadStream(increment.pathIndexPath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      })
      let incrementRow = 0
      for await (const line of reader) {
        if (incrementRow >= increment.commit.deltaCount) break
        if (!line) continue
        const parsed = JSON.parse(line) as { row?: unknown; path?: unknown }
        if (
          parsed.row !== increment.commit.baseCount + incrementRow ||
          typeof parsed.path !== 'string'
        ) {
          return null
        }
        newRows.push({
          key: embeddingCachePathKey(parsed.path),
          path: parsed.path,
          incrementRow,
        })
        incrementRow++
      }
      if (incrementRow !== increment.commit.deltaCount) return null
      newMatched = increment.commit.deltaCount
    }
    for (const delta of deltaSources) {
      const reader = readline.createInterface({
        input: fs.createReadStream(delta.source.path, {
          start: delta.startOffset,
          encoding: 'utf8',
        }),
        crlfDelay: Infinity,
      })
      for await (const line of reader) {
        if (options.isCancelled?.()) return null
        if (!line || Buffer.byteLength(line, 'utf8') > MAX_JSONL_LINE_BYTES) continue
        let record: EmbeddingJsonlRow
        try {
          record = JSON.parse(line) as EmbeddingJsonlRow
        } catch {
          continue
        }
        if (
          record.modelName !== options.modelName ||
          record.embeddingType !== embeddingType ||
          typeof record.imageId !== 'string'
        ) {
          continue
        }
        const encoded =
          record.dim === options.dim ? encodeNormalizedVector(record.vector, options.dim) : null
        if (!encoded) return null
        if (entry.sourceRecordCount + newMatched >= MAX_EMBEDDING_ROWS) return null
        newRows.push({
          key: embeddingCachePathKey(record.imageId),
          path: record.imageId,
          encoded,
        })
        newMatched++
        if (newMatched % 1000 === 0) {
          options.onProgress?.({
            phase: 'building',
            current: newMatched,
            total: newMatched,
            percent: 0,
            message: `Reading incremental ${options.modelName} rows: ${newMatched.toLocaleString()}`,
          })
        }
      }
    }

    // Latest revision wins; updated paths move to their latest position.
    const supersededOld = new Set<number>()
    const supersededNew = new Set<number>()
    const latestNewByKey = new Map<string, number>()
    for (let index = 0; index < newRows.length; index++) {
      const key = newRows[index].key
      const previous = latestNewByKey.get(key)
      if (previous !== undefined) supersededNew.add(previous)
      latestNewByKey.set(key, index)
      const oldRow = oldRowByKey.get(key)
      if (oldRow !== undefined) supersededOld.add(oldRow)
    }

    fs.mkdirSync(options.cacheDir, { recursive: true })
    const files = cachePaths(options.cacheDir, options.modelName, embeddingType)
    const suffix = `.${process.pid}.${Date.now()}.tmp`
    const vectorTmp = `${files.vectors}${suffix}`
    const pathTmp = `${files.paths}${suffix}`
    const metaTmp = `${files.meta}${suffix}`
    temporaryPaths.push(vectorTmp, pathTmp, metaTmp)

    const rowBytes = options.dim * 2
    const oldFd = fs.openSync(oldVectorPath, 'r')
    const incrementFd = increment ? fs.openSync(increment.vectorPath, 'r') : null
    const vectorFd = fs.openSync(vectorTmp, 'w')
    const pathStream = fs.createWriteStream(pathTmp, { encoding: 'utf8' })
    const rowBuffer = Buffer.allocUnsafe(rowBytes)
    let outRow = 0
    try {
      for (let row = 0; row < entry.count; row++) {
        if (supersededOld.has(row)) continue
        const read = fs.readSync(oldFd, rowBuffer, 0, rowBytes, row * rowBytes)
        if (read !== rowBytes) return null
        fs.writeSync(vectorFd, rowBuffer)
        pathStream.write(`${JSON.stringify({ row: outRow, path: oldPaths[row] })}\n`)
        outRow++
      }
      for (let index = 0; index < newRows.length; index++) {
        if (supersededNew.has(index)) continue
        const newRow = newRows[index]
        if ('encoded' in newRow) {
          fs.writeSync(vectorFd, newRow.encoded)
        } else {
          if (incrementFd === null) return null
          const read = fs.readSync(
            incrementFd,
            rowBuffer,
            0,
            rowBytes,
            newRow.incrementRow * rowBytes,
          )
          if (read !== rowBytes) return null
          fs.writeSync(vectorFd, rowBuffer)
        }
        pathStream.write(`${JSON.stringify({ row: outRow, path: newRow.path })}\n`)
        outRow++
        if (outRow % 4000 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } finally {
      fs.closeSync(oldFd)
      if (incrementFd !== null) fs.closeSync(incrementFd)
      fs.closeSync(vectorFd)
      await new Promise<void>((resolve) => pathStream.end(resolve))
    }

    // Close the append-only proof: no source may change while we merged.
    for (let index = 0; index < options.sourcePaths.length; index++) {
      let stat: fs.Stats
      try {
        stat = fs.statSync(options.sourcePaths[index])
      } catch {
        return null
      }
      const expected = sourceSnapshot[index]
      if (!stat.isFile() || stat.size !== expected.size || stat.mtimeMs !== expected.mtimeMs) {
        return null
      }
    }

    const integrity: EmbeddingF16CacheIntegrity = {
      vectors: createEmbeddingCacheFileProof(vectorTmp),
      paths: createEmbeddingCacheFileProof(pathTmp),
    }
    const meta: EmbeddingF16CacheMeta = {
      version: EMBEDDING_F16_CACHE_VERSION,
      modelName: options.modelName,
      embeddingType,
      dim: options.dim,
      count: outRow,
      sourceRecordCount: entry.sourceRecordCount + newMatched,
      sourceFiles: sourceSnapshot,
      updatedAt: Date.now(),
      integrity: {
        vectorsSha256: integrity.vectors.sha256,
        pathsSha256: integrity.paths.sha256,
      },
    }
    fs.writeFileSync(metaTmp, JSON.stringify(meta, null, 2), 'utf8')
    replaceDerivedFile(vectorTmp, files.vectors)
    replaceDerivedFile(pathTmp, files.paths)
    replaceDerivedFile(metaTmp, files.meta)
    temporaryPaths.length = 0
    options.onProgress?.({
      phase: 'compacting',
      current: outRow,
      total: outRow,
      percent: 100,
      message: `Float16 cache extended: ${outRow.toLocaleString()} unique vectors (+${newMatched.toLocaleString()} rows)`,
    })
    return { meta, vectorPath: files.vectors, pathIndexPath: files.paths, integrity }
  } catch {
    return null
  } finally {
    cleanup()
  }
}

export async function ensureEmbeddingF16Cache(
  options: EnsureEmbeddingF16CacheOptions,
): Promise<EmbeddingF16CacheHandle | null> {
  const fresh = readFreshCache(options)
  if (fresh) return fresh
  const embeddingType = options.embeddingType || 'global'
  const key = cacheBuildKey(options.cacheDir, options.modelName, embeddingType)
  const active = buildPromises.get(key)
  if (active) return active
  const buildEpoch = cacheInvalidationEpochs.get(key) || 0
  const callerCancelled = options.isCancelled
  cleanupCacheTemporaryFiles(options)
  const promise = buildCache({
    ...options,
    isCancelled: () =>
      callerCancelled?.() === true || (cacheInvalidationEpochs.get(key) || 0) !== buildEpoch,
  })
    .then(async (cache) => {
      if ((cacheInvalidationEpochs.get(key) || 0) === buildEpoch) {
        invalidatedCacheKeys.delete(key)
        return cache
      }
      await fs.promises.rm(cachePaths(options.cacheDir, options.modelName, embeddingType).meta, {
        force: true,
      })
      return null
    })
    .catch((error) => {
      cleanupCacheTemporaryFiles(options)
      throw error
    })
    .finally(() => buildPromises.delete(key))
  buildPromises.set(key, promise)
  return promise
}

interface CachePathIndexSegment {
  pathIndexPath: string
  firstRow: number
  rowLimit: number
}

/** Path index segments of a (possibly composite) cache handle, oldest first. */
function cachePathIndexSegments(cache: EmbeddingF16CacheHandle): CachePathIndexSegment[] {
  if (!cache.delta) {
    return [{ pathIndexPath: cache.pathIndexPath, firstRow: 0, rowLimit: cache.meta.count }]
  }
  return [
    { pathIndexPath: cache.pathIndexPath, firstRow: 0, rowLimit: cache.delta.baseCount },
    {
      pathIndexPath: cache.delta.pathIndexPath,
      firstRow: cache.delta.baseCount,
      rowLimit: cache.meta.count,
    },
  ]
}

function applyLatestCachePathRow(
  latest: Map<string, EmbeddingF16CachePathRow>,
  line: string,
  segment: CachePathIndexSegment,
): void {
  if (!line) return
  let item: CachePathRow
  try {
    item = JSON.parse(line) as CachePathRow
  } catch {
    return
  }
  if (
    typeof item.path !== 'string' ||
    !Number.isInteger(item.row) ||
    item.row < segment.firstRow ||
    item.row >= segment.rowLimit
  ) {
    return
  }
  const key = embeddingCachePathKey(item.path)
  latest.delete(key)
  latest.set(key, { row: item.row, path: item.path })
}

/**
 * Resolve the logical current state of a base+delta path index. Revisions are
 * replayed oldest-to-newest and duplicate paths move to their latest physical
 * row, matching a full JSONL cache rebuild.
 */
export function readEmbeddingF16CacheLatestPathRowsSync(
  cache: EmbeddingF16CacheHandle,
): EmbeddingF16CachePathRow[] {
  const latest = new Map<string, EmbeddingF16CachePathRow>()
  for (const segment of cachePathIndexSegments(cache)) {
    for (const line of fs.readFileSync(segment.pathIndexPath, 'utf8').split(/\r?\n/)) {
      applyLatestCachePathRow(latest, line, segment)
    }
  }
  return [...latest.values()].sort((left, right) => left.row - right.row)
}

async function readEmbeddingF16CacheLatestPathRows(
  cache: EmbeddingF16CacheHandle,
  options: Pick<StreamEmbeddingF16CacheOptions, 'isCancelled' | 'onProgress'> = {},
): Promise<EmbeddingF16CachePathRow[]> {
  const latest = new Map<string, EmbeddingF16CachePathRow>()
  let scanned = 0
  for (const segment of cachePathIndexSegments(cache)) {
    const reader = readline.createInterface({
      input: fs.createReadStream(segment.pathIndexPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    try {
      for await (const line of reader) {
        if (options.isCancelled?.()) throw new Error('Embedding cache read cancelled')
        applyLatestCachePathRow(latest, line, segment)
        scanned += 1
        if (scanned % 20_000 === 0) {
          options.onProgress?.({
            phase: 'loading',
            current: Math.min(scanned, cache.meta.count),
            total: cache.meta.count,
            percent: Math.min(49, Math.round((scanned / Math.max(1, cache.meta.count)) * 49)),
            message: `Resolving Float16 cache revisions: ${scanned.toLocaleString()}/${cache.meta.count.toLocaleString()}`,
          })
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    } finally {
      reader.close()
    }
  }
  return [...latest.values()].sort((left, right) => left.row - right.row)
}

/**
 * Row locator for a (possibly composite) cache handle: rows below
 * delta.baseCount resolve into the base vector file, rows at or beyond it
 * resolve into the delta segment at row - baseCount.
 */
function createCacheRowReader(cache: EmbeddingF16CacheHandle): {
  readRow: (row: number, buffer: Buffer) => number
  close: () => void
} {
  const rowBytes = cache.meta.dim * 2
  const baseFd = fs.openSync(cache.vectorPath, 'r')
  let deltaFd: number | null = null
  try {
    deltaFd = cache.delta ? fs.openSync(cache.delta.vectorPath, 'r') : null
  } catch (error) {
    fs.closeSync(baseFd)
    throw error
  }
  return {
    readRow(row, buffer) {
      if (deltaFd !== null && cache.delta && row >= cache.delta.baseCount) {
        return fs.readSync(deltaFd, buffer, 0, rowBytes, (row - cache.delta.baseCount) * rowBytes)
      }
      return fs.readSync(baseFd, buffer, 0, rowBytes, row * rowBytes)
    },
    close() {
      fs.closeSync(baseFd)
      if (deltaFd !== null) fs.closeSync(deltaFd)
    },
  }
}

export async function streamEmbeddingF16Cache(
  cache: EmbeddingF16CacheHandle,
  options: StreamEmbeddingF16CacheOptions,
): Promise<number> {
  const rowBytes = cache.meta.dim * 2
  const buffer = Buffer.allocUnsafe(rowBytes)
  const vector = new Float32Array(cache.meta.dim)
  const rowReader = createCacheRowReader(cache)
  const currentRows = await readEmbeddingF16CacheLatestPathRows(cache, options)
  let scanned = 0
  try {
    for (const item of currentRows) {
      if (options.isCancelled?.()) throw new Error('Embedding cache read cancelled')
      if (options.shouldStop?.()) return scanned
      const bytes = rowReader.readRow(item.row, buffer)
      if (bytes !== rowBytes) continue
      for (let index = 0; index < cache.meta.dim; index++) {
        vector[index] = float16ToFloat32(buffer.readUInt16LE(index * 2))
      }
      options.onVector(item.path, vector, item.row)
      scanned += 1
      if (scanned % 1000 === 0 || scanned === currentRows.length) {
        options.onProgress?.({
          phase: 'loading',
          current: scanned,
          total: currentRows.length,
          percent: Math.min(100, Math.round((scanned / Math.max(1, currentRows.length)) * 100)),
          message: `Reading Float16 vectors: ${scanned.toLocaleString()}/${currentRows.length.toLocaleString()}`,
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  } finally {
    rowReader.close()
  }
  return scanned
}

function pushF16SearchResult(
  heap: EmbeddingF16SearchResult[],
  result: EmbeddingF16SearchResult,
  topK: number,
): void {
  if (heap.length < topK) {
    heap.push(result)
    let child = heap.length - 1
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2)
      if (heap[parent].score <= heap[child].score) break
      ;[heap[parent], heap[child]] = [heap[child], heap[parent]]
      child = parent
    }
    return
  }
  if (result.score <= heap[0].score) return
  heap[0] = result
  let parent = 0
  for (;;) {
    const left = parent * 2 + 1
    const right = left + 1
    if (left >= heap.length) break
    let smaller = left
    if (right < heap.length && heap[right].score < heap[left].score) smaller = right
    if (heap[parent].score <= heap[smaller].score) break
    ;[heap[parent], heap[smaller]] = [heap[smaller], heap[parent]]
    parent = smaller
  }
}

export async function searchEmbeddingF16Cache(
  cache: EmbeddingF16CacheHandle,
  options: SearchEmbeddingF16CacheOptions,
): Promise<EmbeddingF16SearchResult[]> {
  const query = Float32Array.from(
    requireNormalizedEmbeddingVector(options.queryVector, cache.meta.dim),
  )

  const topK = Math.max(1, Math.min(5000, Math.floor(options.topK || 1)))
  const heap: EmbeddingF16SearchResult[] = []
  await streamEmbeddingF16Cache(cache, {
    isCancelled: options.isCancelled,
    onProgress: options.onProgress,
    onVector: (filePath, vector, row) => {
      if (options.acceptPath && !options.acceptPath(filePath)) return
      let dot = 0
      for (let index = 0; index < cache.meta.dim; index++) dot += query[index] * vector[index]
      pushF16SearchResult(heap, { path: filePath, row, score: (dot + 1) / 2 }, topK)
    },
  })
  return heap.sort((left, right) => right.score - left.score || left.row - right.row)
}

/** Paths recorded in the cache path index, in row order. */
export function readEmbeddingF16CachePaths(cache: EmbeddingF16CacheHandle): string[] {
  return readEmbeddingF16CacheLatestPathRowsSync(cache).map((item) => item.path)
}

/**
 * Synchronous variant of readEmbeddingF16VectorsForPaths for callers that
 * already run on a blocking path (e.g. the legacy sync frame index build).
 * Keys match embeddingCachePathKey, values are L2-renormalized after decoding.
 */
export function readEmbeddingF16VectorsForPathsSync(
  cache: EmbeddingF16CacheHandle,
  requestedPaths: Iterable<string>,
): Map<string, Float32Array> {
  const requested = new Set([...requestedPaths].map(embeddingCachePathKey))
  const rows = new Map<string, number>()
  const result = new Map<string, Float32Array>()
  if (requested.size === 0) return result

  for (const item of readEmbeddingF16CacheLatestPathRowsSync(cache)) {
    const key = embeddingCachePathKey(item.path)
    if (requested.has(key)) rows.set(key, item.row)
  }

  const rowBytes = cache.meta.dim * 2
  const buffer = Buffer.allocUnsafe(rowBytes)
  const rowReader = createCacheRowReader(cache)
  try {
    for (const [key, row] of rows) {
      const bytes = rowReader.readRow(row, buffer)
      if (bytes !== rowBytes) continue
      const vector = new Float32Array(cache.meta.dim)
      let normSquared = 0
      for (let index = 0; index < cache.meta.dim; index++) {
        const value = float16ToFloat32(buffer.readUInt16LE(index * 2))
        vector[index] = value
        normSquared += value * value
      }
      const norm = Math.sqrt(normSquared)
      if (norm > 0) {
        for (let index = 0; index < vector.length; index++) vector[index] /= norm
      }
      result.set(key, vector)
    }
  } finally {
    rowReader.close()
  }
  return result
}

export async function readEmbeddingF16VectorsForPaths(
  cache: EmbeddingF16CacheHandle,
  requestedPaths: Iterable<string>,
  options: {
    isCancelled?: () => boolean
    onProgress?: (progress: EmbeddingF16CacheProgress) => void
  } = {},
): Promise<Map<string, Float32Array>> {
  const requested = new Set([...requestedPaths].map(embeddingCachePathKey))
  const rows = new Map<string, number>()
  if (requested.size === 0) return new Map()

  const currentRows = await readEmbeddingF16CacheLatestPathRows(cache, options)
  for (const item of currentRows) {
    const key = embeddingCachePathKey(item.path)
    if (requested.has(key)) rows.set(key, item.row)
  }

  const result = new Map<string, Float32Array>()
  const rowBytes = cache.meta.dim * 2
  const buffer = Buffer.allocUnsafe(rowBytes)
  const rowReader = createCacheRowReader(cache)
  try {
    let loaded = 0
    for (const [key, row] of rows) {
      if (options.isCancelled?.()) throw new Error('Embedding cache read cancelled')
      const bytes = rowReader.readRow(row, buffer)
      if (bytes !== rowBytes) continue
      const vector = new Float32Array(cache.meta.dim)
      let normSquared = 0
      for (let index = 0; index < cache.meta.dim; index++) {
        const value = float16ToFloat32(buffer.readUInt16LE(index * 2))
        vector[index] = value
        normSquared += value * value
      }
      const norm = Math.sqrt(normSquared)
      if (norm > 0) {
        for (let index = 0; index < vector.length; index++) vector[index] /= norm
      }
      result.set(key, vector)
      loaded += 1
      if (loaded % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
  } finally {
    rowReader.close()
  }
  options.onProgress?.({
    phase: 'loading',
    current: result.size,
    total: requested.size,
    percent: 100,
    message: `Loaded ${result.size.toLocaleString()}/${requested.size.toLocaleString()} DINO vectors`,
  })
  return result
}
