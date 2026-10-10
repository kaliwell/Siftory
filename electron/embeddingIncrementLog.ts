// ── Embedding increment log (D3 stage 1, write path only) ──
// Double-writes embedding appends into a per-model increment directory that
// hangs off the CURRENT authoritative generation:
//   vector-store/incremental/<model>__<type>/delta.f16         (F16-LE rows)
//   vector-store/incremental/<model>__<type>/delta.paths.jsonl ({row, path})
//   vector-store/incremental/<model>__<type>/delta.json        (commit point)
// Write order inside the serial append chain is always: JSONL row first, then
// the delta segments, then the delta.json commit (tmp + rename, the same
// atomic primitive as CURRENT switches). delta.json is a subordinate commit
// point anchored on the generation referenced by CURRENT; the JSONL shard
// stays authoritative. Any validation failure discards the increment
// directory and the append path degrades to the pre-D3 behavior (JSONL only).

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import {
  createFileChunkIntegritySync,
  isValidFileChunkIntegrity,
  readCurrentAuthoritativeManifest,
  type AuthoritativeVectorStoreEntry,
  type FileChunkIntegrityAnchor,
  verifyFileChunkIntegritySync,
} from './authoritativeVectorStore'
import { noteEmbeddingCacheIntegrityFailure, sha256FilePrefixSync } from './embeddingCacheIntegrity'
import { requireNormalizedEmbeddingVector } from './embeddingVectorValidation'

// Version 3 adds committed content proofs (vectorsSha256/pathsSha256) so
// post-commit corruption of the delta segments fails closed instead of
// reaching search/ANN. Version 2 commits are rejected and safely discarded.
export const EMBEDDING_DELTA_VERSION = 3

/** Source tail anchors hash the last 64 KiB window at the anchored size. */
const TAIL_WINDOW_BYTES = 64 * 1024

const float32Scratch = new Float32Array(1)
const uint32Scratch = new Uint32Array(float32Scratch.buffer)

/**
 * Local copy of float32ToFloat16 from embeddingF16Cache.ts. Duplicated on
 * purpose: embeddingF16Cache imports the read side of this module (D3 stage
 * 2 composite snapshot), and importing it back would create a module cycle.
 */
function float32ToFloat16(value: number): number {
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

export interface EmbeddingDeltaSourceAnchor {
  path: string
  size: number
  mtimeMs: number
  tailSha256: string
  chunkIntegrity?: FileChunkIntegrityAnchor
}

export interface EmbeddingDeltaCommit {
  version: number
  generation: string
  modelName: string
  embeddingType: string
  dim: number
  deltaCount: number
  baseCount: number
  baseSourceRecordCount: number
  sources: EmbeddingDeltaSourceAnchor[]
  /** SHA-256 of the committed delta.f16 prefix (deltaCount * dim * 2 bytes). */
  vectorsSha256: string
  /** Committed byte length of delta.paths.jsonl the paths hash covers. */
  pathsBytes: number
  /** SHA-256 of the committed delta.paths.jsonl prefix (pathsBytes bytes). */
  pathsSha256: string
}

/**
 * Running hash state of the committed delta prefixes, keyed by increment dir.
 * Kept incremental so each append commits in O(row) instead of re-hashing the
 * whole segment; rebuilt from disk (and re-verified) when a context is
 * revalidated. Any validation failure or discard drops the state.
 */
interface DeltaHashState {
  deltaCount: number
  pathsBytes: number
  vectorsHash: crypto.Hash
  pathsHash: crypto.Hash
}

const deltaHashStates = new Map<string, DeltaHashState>()
const invalidatedIncrementDirs = new Set<string>()

function dropDeltaHashState(dir: string): void {
  deltaHashStates.delete(dir)
}

function incrementDirKey(dir: string): string {
  return path.resolve(dir)
}

/** Hashes the first `size` bytes of a file into a retained (still-updatable) hash. */
function createPrefixHash(filePath: string, size: number): crypto.Hash {
  const hash = crypto.createHash('sha256')
  if (size > 0) {
    const descriptor = fs.openSync(filePath, 'r')
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, size))
    try {
      let offset = 0
      while (offset < size) {
        const read = fs.readSync(
          descriptor,
          buffer,
          0,
          Math.min(buffer.length, size - offset),
          offset,
        )
        if (read === 0) throw new Error('Could not read delta segment prefix')
        hash.update(buffer.subarray(0, read))
        offset += read
      }
    } finally {
      fs.closeSync(descriptor)
    }
  }
  return hash
}

/**
 * Verifies the committed delta segments against their content proofs. Used by
 * the cached writer fast path (memoized, so an unchanged segment costs one
 * Map lookup) before reusing the in-memory hash state.
 */
function committedDeltaProofsMatch(
  storeRoot: string,
  modelName: string,
  embeddingType: string,
  commit: EmbeddingDeltaCommit,
): boolean {
  const dir = embeddingIncrementDir(storeRoot, modelName, embeddingType)
  const files = deltaPaths(dir)
  try {
    const match =
      sha256FilePrefixSync(files.f16, commit.deltaCount * commit.dim * 2) ===
        commit.vectorsSha256 &&
      sha256FilePrefixSync(files.paths, commit.pathsBytes) === commit.pathsSha256
    if (!match) {
      noteEmbeddingCacheIntegrityFailure(
        'delta-commit',
        `committed delta segments failed their content proof (${dir})`,
      )
    }
    return match
  } catch {
    return false
  }
}

/**
 * Rebuilds the running hash state from the committed segments, proving the
 * on-disk bytes against the commit's content proofs first. Returns null (and
 * the caller discards the increment) when the committed bytes were corrupted
 * after the commit — re-hashing them would launder the corruption into the
 * next commit's proofs.
 */
function rebuildDeltaHashState(
  dir: string,
  files: { f16: string; paths: string },
  commit: EmbeddingDeltaCommit,
): DeltaHashState | null {
  try {
    const vectorBytes = commit.deltaCount * commit.dim * 2
    const vectorsHash = createPrefixHash(files.f16, vectorBytes)
    const pathsHash = createPrefixHash(files.paths, commit.pathsBytes)
    if (
      vectorsHash.copy().digest('hex') !== commit.vectorsSha256 ||
      pathsHash.copy().digest('hex') !== commit.pathsSha256
    ) {
      noteEmbeddingCacheIntegrityFailure(
        'delta-commit',
        `committed delta segments failed their content proof (${dir})`,
      )
      return null
    }
    const state: DeltaHashState = {
      deltaCount: commit.deltaCount,
      pathsBytes: commit.pathsBytes,
      vectorsHash,
      pathsHash,
    }
    deltaHashStates.set(dir, state)
    return state
  } catch {
    return null
  }
}

export interface EmbeddingIncrementContext {
  dir: string
  generation: string
  entry: AuthoritativeVectorStoreEntry
  sourcePaths: string[]
  /** Last committed state; null when no delta.json has been committed yet. */
  commit: EmbeddingDeltaCommit | null
}

interface PreparedEntry {
  generation: string
  context: EmbeddingIncrementContext | null
}

/** Prepared state is validated once per generation, then reused (single writer). */
const preparedEntries = new Map<string, PreparedEntry>()

function invalidatePreparedContext(context: EmbeddingIncrementContext): void {
  for (const [key, prepared] of preparedEntries) {
    if (prepared.context === context) preparedEntries.delete(key)
  }
}

function sanitizePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96) || 'unknown'
}

export function embeddingIncrementDir(
  storeRoot: string,
  modelName: string,
  embeddingType: string,
): string {
  return path.join(
    storeRoot,
    'incremental',
    `${sanitizePart(modelName)}__${sanitizePart(embeddingType)}`,
  )
}

function deltaPaths(dir: string): { f16: string; paths: string; commit: string } {
  return {
    f16: path.join(dir, 'delta.f16'),
    paths: path.join(dir, 'delta.paths.jsonl'),
    commit: path.join(dir, 'delta.json'),
  }
}

/** Byte-identical to encodeNormalizedVector in embeddingF16Cache.ts. */
function encodeDeltaVector(values: unknown, dim: number): Buffer {
  const normalized = requireNormalizedEmbeddingVector(values, dim)
  const output = Buffer.allocUnsafe(dim * 2)
  for (let index = 0; index < dim; index++) {
    output.writeUInt16LE(float32ToFloat16(normalized[index]), index * 2)
  }
  return output
}

function hashSourceTail(filePath: string, size: number): string {
  const window = Math.min(TAIL_WINDOW_BYTES, size)
  const hash = crypto.createHash('sha256')
  if (window > 0) {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(window)
      const read = fs.readSync(fd, buffer, 0, window, size - window)
      if (read !== window) throw new Error(`Short tail read on ${filePath}`)
      hash.update(buffer)
    } finally {
      fs.closeSync(fd)
    }
  }
  return hash.digest('hex')
}

function anchorSource(
  filePath: string,
  previous?: EmbeddingDeltaSourceAnchor,
): EmbeddingDeltaSourceAnchor {
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(`Increment source is not a file: ${filePath}`)
  const reusableChunkIntegrity =
    previous?.chunkIntegrity &&
    stat.size >= previous.chunkIntegrity.anchoredSize &&
    isValidFileChunkIntegrity(previous.chunkIntegrity, stat.size)
      ? previous.chunkIntegrity
      : undefined
  return {
    path: filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    tailSha256: hashSourceTail(filePath, stat.size),
    chunkIntegrity: reusableChunkIntegrity ?? createFileChunkIntegritySync(filePath, stat.size),
  }
}

function isValidCommitShape(commit: EmbeddingDeltaCommit): boolean {
  return (
    commit.version === EMBEDDING_DELTA_VERSION &&
    typeof commit.generation === 'string' &&
    typeof commit.modelName === 'string' &&
    typeof commit.embeddingType === 'string' &&
    Number.isInteger(commit.dim) &&
    commit.dim > 0 &&
    Number.isInteger(commit.deltaCount) &&
    commit.deltaCount >= 0 &&
    Number.isInteger(commit.baseCount) &&
    commit.baseCount >= 0 &&
    Number.isInteger(commit.baseSourceRecordCount) &&
    commit.baseSourceRecordCount >= commit.baseCount &&
    Number.isSafeInteger(commit.pathsBytes) &&
    commit.pathsBytes >= 0 &&
    /^[a-f0-9]{64}$/.test(commit.vectorsSha256) &&
    /^[a-f0-9]{64}$/.test(commit.pathsSha256) &&
    Array.isArray(commit.sources) &&
    commit.sources.every(
      (source) =>
        typeof source?.path === 'string' &&
        Number.isInteger(source.size) &&
        source.size >= 0 &&
        Number.isFinite(source.mtimeMs) &&
        /^[a-f0-9]{64}$/.test(source.tailSha256) &&
        (source.chunkIntegrity === undefined ||
          isValidFileChunkIntegrity(source.chunkIntegrity, source.size)),
    )
  )
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b)
}

function sourceMatchesAnchorExactly(source: EmbeddingDeltaSourceAnchor): boolean {
  try {
    const stat = fs.statSync(source.path)
    return (
      stat.isFile() &&
      stat.size === source.size &&
      stat.mtimeMs === source.mtimeMs &&
      hashSourceTail(source.path, source.size) === source.tailSha256 &&
      (source.chunkIntegrity === undefined ||
        verifyFileChunkIntegritySync(source.path, source.size, source.chunkIntegrity))
    )
  } catch {
    return false
  }
}

function committedSourcesMatchExactly(commit: EmbeddingDeltaCommit): boolean {
  return commit.sources.every(sourceMatchesAnchorExactly)
}

function cleanupStaleCommitTemps(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('delta.json.') && name.endsWith('.tmp')) {
      fs.rmSync(path.join(dir, name), { force: true })
    }
  }
}

/**
 * Structural check + crash recovery for the delta segments: anything beyond
 * the committed deltaCount is an uncommitted tail from a crashed append and
 * is truncated; anything short of it is corruption and rejects the increment.
 * Returns the committed byte length of the paths segment, or null on failure.
 */
function recoverDeltaSegments(
  files: { f16: string; paths: string },
  commit: EmbeddingDeltaCommit,
): number | null {
  const rowBytes = commit.dim * 2
  const expectedF16 = commit.deltaCount * rowBytes
  if (fs.existsSync(files.f16)) {
    const size = fs.statSync(files.f16).size
    if (size < expectedF16) return null
    if (size > expectedF16) fs.truncateSync(files.f16, expectedF16)
  } else if (commit.deltaCount > 0) {
    return null
  }

  let raw = ''
  if (fs.existsSync(files.paths)) raw = fs.readFileSync(files.paths, 'utf8')
  // Committed rows always end with '\n'; content past the deltaCount-th
  // newline is an uncommitted (possibly half-written) tail.
  let offset = 0
  for (let row = 0; row < commit.deltaCount; row++) {
    const newline = raw.indexOf('\n', offset)
    if (newline < 0) return null
    offset = newline + 1
  }
  const committedLines = raw.slice(0, offset).split('\n').filter(Boolean)
  if (committedLines.length !== commit.deltaCount) return null
  for (let index = 0; index < committedLines.length; index++) {
    try {
      const parsed = JSON.parse(committedLines[index]) as { row?: unknown; path?: unknown }
      if (parsed.row !== commit.baseCount + index || typeof parsed.path !== 'string') return null
    } catch {
      return null
    }
  }
  if (offset < raw.length) fs.writeFileSync(files.paths, raw.slice(0, offset), 'utf8')
  // The commit anchors bytes, not UTF-16 code units: non-ASCII paths make the
  // two diverge, and the writer's proof check compares against commit.pathsBytes.
  return Buffer.byteLength(raw.slice(0, offset), 'utf8')
}

function validateExistingIncrement(
  dir: string,
  entry: AuthoritativeVectorStoreEntry,
  generation: string,
  targetPath: string,
): EmbeddingIncrementContext | null {
  const files = deltaPaths(dir)
  const discard = (): null => {
    dropDeltaHashState(dir)
    fs.rmSync(dir, { recursive: true, force: true })
    return null
  }
  let commit: EmbeddingDeltaCommit
  try {
    commit = JSON.parse(fs.readFileSync(files.commit, 'utf8')) as EmbeddingDeltaCommit
  } catch {
    // No readable commit point: nothing committed is lost by resetting the dir.
    return discard()
  }
  if (
    !isValidCommitShape(commit) ||
    commit.generation !== generation ||
    commit.modelName !== entry.modelName ||
    commit.embeddingType !== entry.embeddingType ||
    commit.dim !== entry.dim ||
    commit.baseCount !== entry.count ||
    commit.baseSourceRecordCount !== entry.sourceRecordCount
  ) {
    return discard()
  }
  // The delta must anchor every base import plus the append target.
  const anchored = new Set(commit.sources.map((source) => path.resolve(source.path)))
  for (const imported of entry.imports) {
    if (!anchored.has(path.resolve(imported.path))) return discard()
  }
  if (!anchored.has(path.resolve(targetPath))) return discard()
  // The writer is strict: sources must match their anchors exactly. A source
  // that grew past its anchor (crash between JSONL and delta append, or an
  // external rewrite) invalidates the increment — behavior degrades to the
  // pre-D3 mismatch/rebuild loop.
  if (!committedSourcesMatchExactly(commit)) return discard()
  const committedPathsBytes = recoverDeltaSegments(files, commit)
  if (committedPathsBytes === null || committedPathsBytes !== commit.pathsBytes) return discard()
  if (!rebuildDeltaHashState(dir, files, commit)) return discard()
  cleanupStaleCommitTemps(dir)
  return {
    dir,
    generation,
    entry,
    sourcePaths: commit.sources.map((source) => source.path),
    commit,
  }
}

function prepareFreshIncrement(
  dir: string,
  entry: AuthoritativeVectorStoreEntry,
  generation: string,
  targetPath: string,
): EmbeddingIncrementContext | null {
  dropDeltaHashState(dir)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  const targetIsImported = entry.imports.some((imported) => samePath(imported.path, targetPath))
  // A fresh increment may only start when every import still matches the
  // manifest exactly; otherwise the JSONL tail already drifted past the base
  // generation and delta rows could not line up with it.
  for (const imported of entry.imports) {
    try {
      const stat = fs.statSync(imported.path)
      if (
        !stat.isFile() ||
        stat.size !== imported.size ||
        stat.mtimeMs !== imported.mtimeMs ||
        (imported.tailSha256 !== undefined &&
          hashSourceTail(imported.path, imported.size) !== imported.tailSha256) ||
        (imported.chunkIntegrity !== undefined &&
          !verifyFileChunkIntegritySync(imported.path, imported.size, imported.chunkIntegrity))
      ) {
        return null
      }
    } catch {
      return null
    }
  }
  if (!targetIsImported) {
    try {
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) return null
    } catch {
      return null
    }
  }
  const sourcePaths = entry.imports.map((imported) => imported.path)
  if (!targetIsImported) sourcePaths.push(targetPath)
  return { dir, generation, entry, sourcePaths, commit: null }
}

function validateEmbeddingIncrement(
  storeRoot: string,
  modelName: string,
  embeddingType: string,
  targetPath: string,
): PreparedEntry | null {
  const manifest = readCurrentAuthoritativeManifest(storeRoot)
  const entry = manifest?.entries.find(
    (candidate) => candidate.modelName === modelName && candidate.embeddingType === embeddingType,
  )
  if (!manifest || !entry) return null
  const dir = embeddingIncrementDir(storeRoot, modelName, embeddingType)
  const context = fs.existsSync(deltaPaths(dir).commit)
    ? validateExistingIncrement(dir, entry, manifest.generation, targetPath)
    : prepareFreshIncrement(dir, entry, manifest.generation, targetPath)
  return { generation: manifest.generation, context }
}

/**
 * Validates (and crash-recovers) the increment directory for the CURRENT
 * generation. Must be called inside the serial append chain, before the JSONL
 * row is written. Returns null when no increment may be written — the caller
 * then performs the JSONL append alone, which is exactly the pre-D3 behavior.
 */
export function prepareEmbeddingIncrement(
  storeRoot: string,
  modelName: string,
  embeddingType: string,
  targetPath: string,
): EmbeddingIncrementContext | null {
  try {
    const key = `${storeRoot}\0${modelName}\0${embeddingType}`
    const cached = preparedEntries.get(key)
    if (cached) {
      const manifest = readCurrentAuthoritativeManifest(storeRoot)
      if (manifest && manifest.generation === cached.generation) {
        const committed = cached.context?.commit
        // A cached writer context is only safe while every committed source
        // still matches its anchor. External appends/rewrites must force the
        // strict recovery/discard path before this process appends another row;
        // otherwise the new commit could skip the external row yet look fresh.
        // The committed delta segments must also still match their content
        // proofs: reusing the in-memory hash state after an on-disk bitflip
        // would commit proofs the corrupted bytes can never satisfy.
        if (
          !committed ||
          (committedSourcesMatchExactly(committed) &&
            committedDeltaProofsMatch(storeRoot, modelName, embeddingType, committed))
        ) {
          return cached.context
        }
      }
      dropDeltaHashState(embeddingIncrementDir(storeRoot, modelName, embeddingType))
      preparedEntries.delete(key)
    }
    const prepared = validateEmbeddingIncrement(storeRoot, modelName, embeddingType, targetPath)
    if (prepared) preparedEntries.set(key, prepared)
    return prepared?.context ?? null
  } catch {
    return null
  }
}

/**
 * Appends one row to the delta segments and commits the new deltaCount with
 * fresh source tail anchors (tmp + rename). Must be called after the JSONL
 * row has been written, inside the same serial chain step. Rows that a full
 * rebuild would reject are rejected here before any delta file is touched.
 */
export function appendEmbeddingIncrementRow(
  context: EmbeddingIncrementContext,
  imageId: string,
  vector: Float32Array | number[],
): void {
  try {
    const files = deltaPaths(context.dir)
    const deltaCount = context.commit?.deltaCount ?? 0
    const encoded = encodeDeltaVector(vector, context.entry.dim)
    let state = deltaHashStates.get(context.dir)
    if (!state) {
      if (context.commit) {
        // The running state was lost (defensive path): rebuild it from the
        // committed segments, which also re-proves their content.
        state = rebuildDeltaHashState(context.dir, files, context.commit) ?? undefined
        if (!state) throw new Error('Increment delta segments failed their content proof')
      } else {
        state = {
          deltaCount: 0,
          pathsBytes: 0,
          vectorsHash: crypto.createHash('sha256'),
          pathsHash: crypto.createHash('sha256'),
        }
        deltaHashStates.set(context.dir, state)
      }
    }
    if (state.deltaCount !== deltaCount || state.pathsBytes !== (context.commit?.pathsBytes ?? 0)) {
      throw new Error('Increment hash state does not match the last commit')
    }
    const pathLine = `${JSON.stringify({ row: context.entry.count + deltaCount, path: imageId })}\n`
    const pathsBytes = state.pathsBytes + Buffer.byteLength(pathLine, 'utf8')
    const vectorsHash = state.vectorsHash.copy().update(encoded).digest('hex')
    const pathsHash = state.pathsHash.copy().update(pathLine, 'utf8').digest('hex')
    fs.mkdirSync(context.dir, { recursive: true })
    fs.appendFileSync(files.f16, encoded)
    fs.appendFileSync(files.paths, pathLine, 'utf8')
    const commit: EmbeddingDeltaCommit = {
      version: EMBEDDING_DELTA_VERSION,
      generation: context.generation,
      modelName: context.entry.modelName,
      embeddingType: context.entry.embeddingType,
      dim: context.entry.dim,
      deltaCount: deltaCount + 1,
      baseCount: context.entry.count,
      baseSourceRecordCount: context.entry.sourceRecordCount,
      sources: context.sourcePaths.map((sourcePath) =>
        anchorSource(
          sourcePath,
          context.commit?.sources.find((source) => samePath(source.path, sourcePath)),
        ),
      ),
      vectorsSha256: vectorsHash,
      pathsBytes,
      pathsSha256: pathsHash,
    }
    const temporary = `${files.commit}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(commit, null, 2), 'utf8')
    fs.renameSync(temporary, files.commit)
    invalidatedIncrementDirs.delete(incrementDirKey(context.dir))
    state.vectorsHash.update(encoded)
    state.pathsHash.update(pathLine, 'utf8')
    state.deltaCount += 1
    state.pathsBytes = pathsBytes
    context.commit = commit
  } catch (error) {
    // The JSONL row has already landed. Never reuse a context whose segment
    // or commit write failed: the next append must revalidate/recover (or
    // discard) the subordinate increment before it can write another row.
    dropDeltaHashState(context.dir)
    invalidatePreparedContext(context)
    throw error
  }
}

export function resetEmbeddingIncrementStateForTests(): void {
  preparedEntries.clear()
  deltaHashStates.clear()
  invalidatedIncrementDirs.clear()
}

// ── Read-side composite snapshot (D3 stage 2) ──

export interface EmbeddingIncrementReadSnapshot {
  generation: string
  entry: AuthoritativeVectorStoreEntry
  commit: EmbeddingDeltaCommit
  /** delta.f16 segment holding rows >= commit.baseCount. */
  vectorPath: string
  /** delta.paths.jsonl segment holding {row, path} for the delta rows. */
  pathIndexPath: string
  /**
   * True when every expected source stat exactly matches its anchor. False
   * means the JSONL sources grew past the committed delta (reader-lenient
   * "JSONL ahead of increment"): the composite snapshot is still valid for
   * stale-tolerant reads, but freshness checks must fall back to rebuild.
   */
  complete: boolean
}

/**
 * Read-only structural check of the delta segments: unlike the writer's
 * recoverDeltaSegments this never truncates — an uncommitted tail is simply
 * not part of the committed snapshot.
 */
function checkDeltaSegmentsReadable(
  files: { f16: string; paths: string },
  commit: EmbeddingDeltaCommit,
): boolean {
  try {
    if (commit.deltaCount === 0) return true
    const stat = fs.statSync(files.f16)
    if (!stat.isFile() || stat.size < commit.deltaCount * commit.dim * 2) return false
    const raw = fs.readFileSync(files.paths, 'utf8')
    let offset = 0
    for (let row = 0; row < commit.deltaCount; row++) {
      const newline = raw.indexOf('\n', offset)
      if (newline < 0) return false
      const parsed = JSON.parse(raw.slice(offset, newline)) as { row?: unknown; path?: unknown }
      if (parsed.row !== commit.baseCount + row || typeof parsed.path !== 'string') return false
      offset = newline + 1
    }
    return true
  } catch {
    return false
  }
}

/**
 * Reader-lenient validation of the increment directory against the CURRENT
 * generation (D3 stage 2). Never mutates or deletes anything: any validation
 * failure returns null and the caller falls back to the pre-D3 paths. Unlike
 * the writer, a source that grew past its anchor does not invalidate the
 * snapshot — it marks it incomplete (JSONL ahead of the committed delta).
 */
export function readEmbeddingIncrementSnapshot(
  storeRoot: string,
  modelName: string,
  embeddingType: string,
  dim: number,
  sourcePaths: string[],
): EmbeddingIncrementReadSnapshot | null {
  try {
    const manifest = readCurrentAuthoritativeManifest(storeRoot)
    const entry = manifest?.entries.find(
      (candidate) =>
        candidate.modelName === modelName &&
        candidate.embeddingType === embeddingType &&
        candidate.dim === dim,
    )
    if (!manifest || !entry) return null
    const dir = embeddingIncrementDir(storeRoot, modelName, embeddingType)
    if (invalidatedIncrementDirs.has(incrementDirKey(dir))) return null
    const files = deltaPaths(dir)
    let commit: EmbeddingDeltaCommit
    try {
      commit = JSON.parse(fs.readFileSync(files.commit, 'utf8')) as EmbeddingDeltaCommit
    } catch {
      return null
    }
    if (
      !isValidCommitShape(commit) ||
      commit.deltaCount === 0 ||
      commit.generation !== manifest.generation ||
      commit.modelName !== entry.modelName ||
      commit.embeddingType !== entry.embeddingType ||
      commit.dim !== entry.dim ||
      commit.baseCount !== entry.count ||
      commit.baseSourceRecordCount !== entry.sourceRecordCount
    ) {
      return null
    }
    let complete = true
    for (const sourcePath of sourcePaths) {
      const anchor = commit.sources.find((source) => samePath(source.path, sourcePath))
      if (!anchor) return null
      let stat: fs.Stats
      try {
        stat = fs.statSync(sourcePath)
      } catch {
        return null
      }
      if (!stat.isFile() || stat.size < anchor.size) return null
      // Even when the source grew, the previously committed prefix must remain
      // byte-identical. Only verified append-only growth is reader-lenient.
      if (hashSourceTail(sourcePath, anchor.size) !== anchor.tailSha256) return null
      if (
        anchor.chunkIntegrity !== undefined &&
        !verifyFileChunkIntegritySync(sourcePath, anchor.size, anchor.chunkIntegrity)
      ) {
        return null
      }
      if (stat.size > anchor.size) {
        // JSONL ahead of the committed delta: valid but incomplete.
        complete = false
        continue
      }
      if (stat.mtimeMs !== anchor.mtimeMs) return null
    }
    if (!checkDeltaSegmentsReadable(files, commit)) return null
    // Content proof of the committed delta segments (VAL-038): a post-commit
    // bitflip or rewrite fails closed here, so corrupted rows never reach the
    // composite snapshot that search and ANN consume.
    try {
      if (
        sha256FilePrefixSync(files.f16, commit.deltaCount * commit.dim * 2) !==
          commit.vectorsSha256 ||
        sha256FilePrefixSync(files.paths, commit.pathsBytes) !== commit.pathsSha256
      ) {
        noteEmbeddingCacheIntegrityFailure(
          'delta-read',
          `committed delta segments failed their content proof (${dir})`,
        )
        return null
      }
    } catch {
      return null
    }
    return {
      generation: manifest.generation,
      entry,
      commit,
      vectorPath: files.f16,
      pathIndexPath: files.paths,
      complete,
    }
  } catch {
    return null
  }
}

/**
 * Removes the increment directory for a model entry. Called by the migration
 * executor after a CURRENT switch (and by GC after shard compaction): the old
 * delta anchors can never match the new base again, so keeping the directory
 * would only leave an orphan. Source reconciliation uses the async equivalent
 * below to avoid recursive filesystem work on Electron's main thread.
 */
export function discardEmbeddingIncrement(
  storeRoot: string,
  modelName: string,
  embeddingType: string,
): void {
  try {
    const dir = embeddingIncrementDir(storeRoot, modelName, embeddingType)
    invalidatedIncrementDirs.add(incrementDirKey(dir))
    dropDeltaHashState(dir)
    preparedEntries.delete(`${storeRoot}\0${modelName}\0${embeddingType}`)
    fs.rmSync(dir, {
      recursive: true,
      force: true,
    })
  } catch {
    /* A missing or busy increment directory is not an error. */
  }
}

/**
 * Async discard used by source reconciliation. It runs inside the serialized
 * embedding append chain, clears every cached writer handle before yielding,
 * and avoids a recursive synchronous filesystem operation on Electron's main
 * thread.
 */
export async function discardEmbeddingIncrementAsync(
  storeRoot: string,
  modelName: string,
  embeddingType: string,
): Promise<void> {
  const dir = embeddingIncrementDir(storeRoot, modelName, embeddingType)
  invalidatedIncrementDirs.add(incrementDirKey(dir))
  dropDeltaHashState(dir)
  preparedEntries.delete(`${storeRoot}\0${modelName}\0${embeddingType}`)
  const files = deltaPaths(dir)
  const quarantinedCommit = `${files.commit}.${process.pid}.${Date.now()}.invalidated.tmp`
  let quarantineError: unknown
  try {
    fs.renameSync(files.commit, quarantinedCommit)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') quarantineError = error
  }
  try {
    await fs.promises.rm(dir, { recursive: true, force: true })
  } catch (error) {
    throw new AggregateError(
      quarantineError ? [quarantineError, error] : [error],
      'Could not discard embedding increment',
      { cause: error },
    )
  }
}
