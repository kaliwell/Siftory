import fs from 'fs'
import path from 'path'
import { parentPort } from 'worker_threads'
import {
  createFileChunkIntegritySync,
  sameFileChunkIntegrity,
  sha256FileTailSync,
  type FileChunkIntegrityAnchor,
  verifyFileChunkIntegritySync,
} from './authoritativeVectorStore'
import {
  noteEmbeddingCacheIntegrityFailure,
  verifyEmbeddingCacheFileProof,
} from './embeddingCacheIntegrity'
import {
  embeddingCachePathKey,
  embeddingF16CacheSourceFingerprint,
  type EmbeddingF16CacheHandle,
} from './embeddingF16Cache'
import {
  VECTOR_ANN_SIGNATURE_BYTES,
  VECTOR_ANN_VERSION,
  buildVectorAnnQuantizedProjection,
  collectVectorAnnProjectionCandidates,
  createVectorAnnProjectionPlan,
  quantizeVectorAnnProjection,
  type VectorAnnBufferSegment,
  vectorAnnSignatureFromF16,
  writeVectorAnnSignature,
} from './vectorAnnIndex'
import { F16SnapshotReader, scoreF16SnapshotCandidates } from './f16SnapshotReader'
import {
  persistVectorAnnProjectionSidecar,
  readVectorAnnProjectionSidecar,
  vectorAnnProjectionSidecarPaths,
} from './vectorAnnProjectionSidecar'
import { CompactPathTable } from './compactPathTable'

interface VectorAnnIndexMeta {
  version: number
  modelName: string
  embeddingType: string
  dim: number
  count: number
  sourceFingerprint: string
  baseFingerprint?: string
  baseCount?: number
  baseTailSha256?: string
  baseChunkIntegrity?: FileChunkIntegrityAnchor
  deltaCount?: number
  deltaTailSha256?: string
  deltaChunkIntegrity?: FileChunkIntegrityAnchor
  createdAt: number
}

interface VectorAnnSourceState {
  baseFingerprint: string
  baseCount: number
  baseTailSha256: string
  baseChunkIntegrity: FileChunkIntegrityAnchor
  deltaCount: number
  deltaTailSha256: string
  deltaChunkIntegrity: FileChunkIntegrityAnchor
}

export type VectorAnnBuildMode = 'none' | 'incremental' | 'full'
export type VectorAnnSnapshotLoadMode =
  | 'none'
  | 'metadata-only'
  | 'sidecar-only'
  | 'delta-only'
  | 'full'

export interface VectorAnnWorkerSearchRequest {
  type: 'search'
  requestId: number
  cache: EmbeddingF16CacheHandle
  queryVector: number[]
  topK: number
  /** Optional caller-specific recall budget; the production default remains 20%. */
  candidateRatio?: number
  stopBuffer: SharedArrayBuffer
  /** Plain scope paths; normalized here before candidate selection. */
  acceptPathKeys?: string[]
}

export interface VectorAnnWorkerBatchSearchRequest {
  type: 'search-batch'
  requestId: number
  cache: EmbeddingF16CacheHandle
  queryVectors: number[][]
  topK: number
  candidateRatio?: number
  stopBuffer: SharedArrayBuffer
  /** One immutable scope shared by every query center in this request. */
  acceptPathKeys?: string[]
}

/**
 * VAL-031 background prewarm: runs the exact ensureLoaded path a real search
 * would (including the VAL-038 integrity gate) but skips candidate scoring,
 * so the loaded index a later search reuses is identical by construction.
 */
export interface VectorAnnWorkerPrewarmRequest {
  type: 'prewarm'
  requestId: number
  cache: EmbeddingF16CacheHandle
  stopBuffer: SharedArrayBuffer
}

export type VectorAnnWorkerRequest =
  | VectorAnnWorkerSearchRequest
  | VectorAnnWorkerBatchSearchRequest
  | VectorAnnWorkerPrewarmRequest

export interface VectorAnnWorkerSearchResult {
  path: string
  row: number
  score: number
}

interface LoadedAnnIndex {
  key: string
  meta: VectorAnnIndexMeta
  signatures: VectorAnnBufferSegment[]
  projections: VectorAnnBufferSegment[]
  projectionDimensions: Uint16Array
  projectionInverseScales: Float32Array
  vectorReader: F16SnapshotReader
  paths: CompactPathTable
  activeRows: Uint32Array
  deltaPathBytes: number
  deltaPathTailSha256: string
  deltaPathChunkIntegrity: FileChunkIntegrityAnchor
  signatureFile: { size: number; mtimeMs: number }
}

interface VectorAnnLoadStats {
  snapshotLoadMode: VectorAnnSnapshotLoadMode
  vectorBytesRead: number
  pathBytesRead: number
  reusedVectorBytes: number
}

interface VectorAnnOwnedMemoryStats {
  vectorBytes: number
  signatureBytes: number
  projectionBytes: number
  projectionMetadataBytes: number
  pathUtf8Bytes: number
  pathSlotBytesApprox: number
  metadataBytesApprox: number
  totalOwnedBytesApprox: number
  rowCount: number
}

const MAX_HOT_SEGMENTS = 64
const PATH_READ_CHUNK_BYTES = 64 * 1024

let loaded: LoadedAnnIndex | null = null

function segmentBytes(segments: readonly VectorAnnBufferSegment[]): number {
  return segments.reduce((total, segment) => total + segment.buffer.byteLength, 0)
}

function loadedOwnedMemory(index: LoadedAnnIndex): VectorAnnOwnedMemoryStats {
  const vectorBytes = index.vectorReader.stats().ownedBytes
  const signatureBytes = segmentBytes(index.signatures)
  const projectionBytes = segmentBytes(index.projections)
  const projectionMetadataBytes =
    index.projectionDimensions.byteLength + index.projectionInverseScales.byteLength
  const pathStats = index.paths.stats()
  const pathUtf8Bytes = pathStats.utf8Bytes
  const pathSlotBytesApprox = pathStats.offsetBytes + pathStats.presenceBytes
  const metadataBytesApprox = Buffer.byteLength(JSON.stringify(index.meta), 'utf8')
  return {
    vectorBytes,
    signatureBytes,
    projectionBytes,
    projectionMetadataBytes,
    pathUtf8Bytes,
    pathSlotBytesApprox,
    metadataBytesApprox,
    totalOwnedBytesApprox:
      vectorBytes +
      signatureBytes +
      projectionBytes +
      projectionMetadataBytes +
      pathUtf8Bytes +
      pathSlotBytesApprox +
      metadataBytesApprox +
      index.activeRows.byteLength,
    rowCount: index.meta.count,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sourceFingerprint(cache: EmbeddingF16CacheHandle): string {
  return embeddingF16CacheSourceFingerprint(cache)
}

function sourceState(cache: EmbeddingF16CacheHandle): VectorAnnSourceState {
  const baseCount = cache.delta?.baseCount ?? cache.meta.count
  const deltaCount = cache.meta.count - baseCount
  if (baseCount < 0 || deltaCount < 0) throw new Error('ANN source row count mismatch')
  const rowBytes = cache.meta.dim * 2
  return {
    baseFingerprint: JSON.stringify({
      generation: cache.meta.generation || null,
      vectorPath: path.resolve(cache.vectorPath),
      pathIndexPath: path.resolve(cache.pathIndexPath),
      baseCount,
      dim: cache.meta.dim,
    }),
    baseCount,
    baseTailSha256: sha256FileTailSync(cache.vectorPath, baseCount * rowBytes),
    baseChunkIntegrity: createFileChunkIntegritySync(cache.vectorPath, baseCount * rowBytes),
    deltaCount,
    deltaTailSha256: cache.delta
      ? sha256FileTailSync(cache.delta.vectorPath, deltaCount * rowBytes)
      : sha256FileTailSync(cache.vectorPath, 0),
    deltaChunkIntegrity: cache.delta
      ? createFileChunkIntegritySync(cache.delta.vectorPath, deltaCount * rowBytes)
      : createFileChunkIntegritySync(cache.vectorPath, 0),
  }
}

function projectionSourceIdentity(
  cache: EmbeddingF16CacheHandle,
  state: VectorAnnSourceState,
): string {
  return JSON.stringify({ sourceFingerprint: sourceFingerprint(cache), ...state })
}

function annPaths(cache: EmbeddingF16CacheHandle): { meta: string; signatures: string } {
  const base = path.basename(cache.vectorPath, path.extname(cache.vectorPath))
  const directory = path.dirname(cache.vectorPath)
  return {
    meta: path.join(directory, `${base}.ann-simhash-v${VECTOR_ANN_VERSION}.json`),
    signatures: path.join(directory, `${base}.ann-simhash-v${VECTOR_ANN_VERSION}.bin`),
  }
}

function readFileRange(filePath: string, offset: number, length: number): Buffer {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new Error('ANN file range is invalid')
  }
  const output = Buffer.allocUnsafe(length)
  if (length === 0) return output
  const descriptor = fs.openSync(filePath, 'r')
  try {
    let written = 0
    while (written < length) {
      const bytesRead = fs.readSync(descriptor, output, written, length - written, offset + written)
      if (bytesRead === 0) throw new Error('ANN source range is truncated')
      written += bytesRead
    }
    return output
  } finally {
    fs.closeSync(descriptor)
  }
}

function readStrictPathSuffix(
  filePath: string,
  startOffset: number,
  firstRow: number,
  rowCount: number,
): { paths: string[]; endOffset: number; bytesRead: number } {
  if (rowCount === 0) return { paths: [], endOffset: startOffset, bytesRead: 0 }
  const descriptor = fs.openSync(filePath, 'r')
  const chunk = Buffer.allocUnsafe(PATH_READ_CHUNK_BYTES)
  let carry = Buffer.alloc(0)
  let position = startOffset
  let bytesRead = 0
  const paths: string[] = []
  try {
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, position)
      if (read === 0) break
      position += read
      bytesRead += read
      const data =
        carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read)
      let lineStart = 0
      for (;;) {
        const lineEnd = data.indexOf(0x0a, lineStart)
        if (lineEnd < 0) break
        const lineBytes = data.subarray(lineStart, lineEnd)
        lineStart = lineEnd + 1
        const line = lineBytes.toString('utf8').replace(/\r$/, '')
        if (!line) continue
        const item = JSON.parse(line) as { row?: number; path?: string }
        const expectedRow = firstRow + paths.length
        if (item.row !== expectedRow || typeof item.path !== 'string') {
          throw new Error('ANN delta path suffix is not contiguous')
        }
        paths.push(item.path)
        if (paths.length === rowCount) {
          const unreadBytes = data.length - lineStart
          return { paths, endOffset: position - unreadBytes, bytesRead }
        }
      }
      carry = Buffer.from(data.subarray(lineStart))
      if (carry.length > 8 * 1024 * 1024) throw new Error('ANN path row exceeds the size limit')
    }
  } finally {
    fs.closeSync(descriptor)
  }
  throw new Error('ANN delta path suffix is truncated')
}

function readPaths(cache: EmbeddingF16CacheHandle): {
  paths: Array<string | undefined>
  deltaPathBytes: number
  bytesRead: number
} {
  const result = new Array<string | undefined>(cache.meta.count)
  const baseBytes = fs.readFileSync(cache.pathIndexPath)
  for (const rawLine of baseBytes.toString('utf8').split(/\r?\n/)) {
    if (!rawLine) continue
    try {
      const item = JSON.parse(rawLine) as { row?: number; path?: string }
      if (
        Number.isInteger(item.row) &&
        item.row! >= 0 &&
        item.row! < result.length &&
        typeof item.path === 'string'
      ) {
        result[item.row!] = item.path
      }
    } catch {
      /* derived base path rows that cannot be parsed remain unavailable */
    }
  }
  if (!cache.delta) return { paths: result, deltaPathBytes: 0, bytesRead: baseBytes.length }
  const deltaCount = cache.meta.count - cache.delta.baseCount
  const delta = readStrictPathSuffix(
    cache.delta.pathIndexPath,
    0,
    cache.delta.baseCount,
    deltaCount,
  )
  for (let index = 0; index < delta.paths.length; index++) {
    result[cache.delta.baseCount + index] = delta.paths[index]
  }
  return {
    paths: result,
    deltaPathBytes: delta.endOffset,
    bytesRead: baseBytes.length + delta.bytesRead,
  }
}

function readStoredSignatures(files: {
  meta: string
  signatures: string
}): { meta: VectorAnnIndexMeta; signatures: Buffer } | null {
  try {
    const meta = JSON.parse(fs.readFileSync(files.meta, 'utf8')) as VectorAnnIndexMeta
    if (!Number.isInteger(meta.count) || meta.count < 0) return null
    const signatures = fs.readFileSync(files.signatures)
    if (signatures.length !== meta.count * VECTOR_ANN_SIGNATURE_BYTES) return null
    return { meta, signatures }
  } catch {
    return null
  }
}

function isFreshIndex(
  cache: EmbeddingF16CacheHandle,
  meta: VectorAnnIndexMeta,
  state: VectorAnnSourceState,
): boolean {
  const hasSourceAnchors =
    meta.baseFingerprint !== undefined ||
    meta.baseCount !== undefined ||
    meta.baseTailSha256 !== undefined ||
    meta.baseChunkIntegrity !== undefined ||
    meta.deltaCount !== undefined ||
    meta.deltaTailSha256 !== undefined ||
    meta.deltaChunkIntegrity !== undefined
  const sourceAnchorsMatch =
    !hasSourceAnchors ||
    (meta.baseFingerprint === state.baseFingerprint &&
      meta.baseCount === state.baseCount &&
      meta.baseTailSha256 === state.baseTailSha256 &&
      sameFileChunkIntegrity(meta.baseChunkIntegrity, state.baseChunkIntegrity) &&
      meta.deltaCount === state.deltaCount &&
      meta.deltaTailSha256 === state.deltaTailSha256 &&
      sameFileChunkIntegrity(meta.deltaChunkIntegrity, state.deltaChunkIntegrity))
  return (
    meta.version === VECTOR_ANN_VERSION &&
    meta.modelName === cache.meta.modelName &&
    meta.embeddingType === cache.meta.embeddingType &&
    meta.dim === cache.meta.dim &&
    meta.count === cache.meta.count &&
    meta.sourceFingerprint === sourceFingerprint(cache) &&
    sourceAnchorsMatch
  )
}

function createIndexMeta(
  cache: EmbeddingF16CacheHandle,
  state: VectorAnnSourceState,
): VectorAnnIndexMeta {
  return {
    version: VECTOR_ANN_VERSION,
    modelName: cache.meta.modelName,
    embeddingType: cache.meta.embeddingType,
    dim: cache.meta.dim,
    count: cache.meta.count,
    sourceFingerprint: sourceFingerprint(cache),
    ...state,
    createdAt: Date.now(),
  }
}

function replaceDerivedFile(temporary: string, target: string): void {
  try {
    fs.renameSync(temporary, target)
  } catch {
    try {
      fs.unlinkSync(target)
    } catch {
      /* target may not exist */
    }
    fs.renameSync(temporary, target)
  }
}

function persistMeta(meta: VectorAnnIndexMeta, metaPath: string): void {
  const temporary = `${metaPath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(meta, null, 2), 'utf8')
    replaceDerivedFile(temporary, metaPath)
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    } catch {
      /* next build can replace the temporary metadata */
    }
  }
}

function signatureFileIdentity(filePath: string): { size: number; mtimeMs: number } {
  const stat = fs.statSync(filePath)
  return { size: stat.size, mtimeMs: stat.mtimeMs }
}

function persistSignatures(
  meta: VectorAnnIndexMeta,
  signatures: Buffer,
  files: { meta: string; signatures: string },
): void {
  const signatureTmp = `${files.signatures}.${process.pid}.tmp`
  try {
    fs.writeFileSync(signatureTmp, signatures)
    replaceDerivedFile(signatureTmp, files.signatures)
    // Metadata is the commit marker and is replaced only after signatures.
    persistMeta(meta, files.meta)
  } finally {
    for (const temporary of [signatureTmp]) {
      try {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
      } catch {
        /* next build can replace the derived ANN files */
      }
    }
  }
}

function appendSignatures(
  previousMeta: VectorAnnIndexMeta,
  nextMeta: VectorAnnIndexMeta,
  appended: Buffer,
  files: { meta: string; signatures: string },
  identity: { size: number; mtimeMs: number },
): { size: number; mtimeMs: number } {
  const expectedBytes = previousMeta.count * VECTOR_ANN_SIGNATURE_BYTES
  const currentIdentity = signatureFileIdentity(files.signatures)
  if (
    currentIdentity.size !== expectedBytes ||
    currentIdentity.size !== identity.size ||
    currentIdentity.mtimeMs !== identity.mtimeMs
  ) {
    throw new Error('ANN signature file changed outside the loaded worker')
  }
  const diskMeta = JSON.parse(fs.readFileSync(files.meta, 'utf8')) as VectorAnnIndexMeta
  if (
    diskMeta.version !== previousMeta.version ||
    diskMeta.count !== previousMeta.count ||
    diskMeta.sourceFingerprint !== previousMeta.sourceFingerprint ||
    diskMeta.baseFingerprint !== previousMeta.baseFingerprint ||
    !sameFileChunkIntegrity(diskMeta.baseChunkIntegrity, previousMeta.baseChunkIntegrity) ||
    diskMeta.deltaCount !== previousMeta.deltaCount ||
    diskMeta.deltaTailSha256 !== previousMeta.deltaTailSha256 ||
    !sameFileChunkIntegrity(diskMeta.deltaChunkIntegrity, previousMeta.deltaChunkIntegrity)
  ) {
    throw new Error('ANN signature metadata changed outside the loaded worker')
  }
  const descriptor = fs.openSync(files.signatures, 'r+')
  try {
    fs.ftruncateSync(descriptor, expectedBytes)
    let written = 0
    while (written < appended.length) {
      const count = fs.writeSync(
        descriptor,
        appended,
        written,
        appended.length - written,
        expectedBytes + written,
      )
      if (count === 0) throw new Error('ANN signature append was truncated')
      written += count
    }
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  persistMeta(nextMeta, files.meta)
  return signatureFileIdentity(files.signatures)
}

function buildSignatures(
  requestId: number,
  cache: EmbeddingF16CacheHandle,
  state: VectorAnnSourceState,
  vectors: Buffer,
  files: { meta: string; signatures: string },
  isCancelled: () => boolean,
): { meta: VectorAnnIndexMeta; signatures: Buffer } {
  const startedAt = Date.now()
  if (isCancelled()) throw new Error('ANN build cancelled')
  const plan = createVectorAnnProjectionPlan(cache.meta.dim)
  const signatures = Buffer.allocUnsafe(cache.meta.count * VECTOR_ANN_SIGNATURE_BYTES)
  for (let row = 0; row < cache.meta.count; row++) {
    if ((row & 1023) === 0) {
      if (isCancelled()) throw new Error('ANN build cancelled')
      parentPort?.postMessage({
        type: 'progress',
        requestId,
        phase: 'building',
        current: row,
        total: cache.meta.count,
        percent: Math.round((row / Math.max(1, cache.meta.count)) * 100),
      })
    }
    writeVectorAnnSignature(signatures, row, vectorAnnSignatureFromF16(vectors, row, plan))
  }
  const meta = createIndexMeta(cache, state)
  persistSignatures(meta, signatures, files)
  parentPort?.postMessage({
    type: 'progress',
    requestId,
    phase: 'building',
    current: cache.meta.count,
    total: cache.meta.count,
    percent: 100,
    elapsedMs: Date.now() - startedAt,
  })
  return { meta, signatures }
}

function extendSignatures(
  requestId: number,
  cache: EmbeddingF16CacheHandle,
  state: VectorAnnSourceState,
  vectors: Buffer,
  files: { meta: string; signatures: string },
  previous: { meta: VectorAnnIndexMeta; signatures: Buffer },
  isCancelled: () => boolean,
): { meta: VectorAnnIndexMeta; signatures: Buffer } | null {
  const old = previous.meta
  if (
    !cache.delta ||
    old.version !== VECTOR_ANN_VERSION ||
    old.modelName !== cache.meta.modelName ||
    old.embeddingType !== cache.meta.embeddingType ||
    old.dim !== cache.meta.dim ||
    old.baseFingerprint !== state.baseFingerprint ||
    old.baseCount !== state.baseCount ||
    old.baseTailSha256 !== state.baseTailSha256 ||
    !sameFileChunkIntegrity(old.baseChunkIntegrity, state.baseChunkIntegrity) ||
    !Number.isInteger(old.deltaCount) ||
    old.deltaCount! < 0 ||
    old.count !== state.baseCount + old.deltaCount! ||
    old.deltaCount! > state.deltaCount
  ) {
    return null
  }
  const oldDeltaBytes = old.deltaCount! * cache.meta.dim * 2
  if (old.deltaTailSha256 !== sha256FileTailSync(cache.delta.vectorPath, oldDeltaBytes)) {
    return null
  }
  if (
    !old.deltaChunkIntegrity ||
    !verifyFileChunkIntegritySync(cache.delta.vectorPath, oldDeltaBytes, old.deltaChunkIntegrity)
  ) {
    return null
  }
  const startedAt = Date.now()
  if (isCancelled()) throw new Error('ANN build cancelled')
  const plan = createVectorAnnProjectionPlan(cache.meta.dim)
  const signatures = Buffer.allocUnsafe(cache.meta.count * VECTOR_ANN_SIGNATURE_BYTES)
  previous.signatures.copy(signatures)
  for (let row = old.count; row < cache.meta.count; row++) {
    if ((row & 1023) === 0) {
      if (isCancelled()) throw new Error('ANN build cancelled')
      parentPort?.postMessage({
        type: 'progress',
        requestId,
        phase: 'building',
        current: row,
        total: cache.meta.count,
        percent: Math.round((row / Math.max(1, cache.meta.count)) * 100),
      })
    }
    writeVectorAnnSignature(signatures, row, vectorAnnSignatureFromF16(vectors, row, plan))
  }
  const meta = createIndexMeta(cache, state)
  persistSignatures(meta, signatures, files)
  parentPort?.postMessage({
    type: 'progress',
    requestId,
    phase: 'building',
    current: cache.meta.count,
    total: cache.meta.count,
    percent: 100,
    elapsedMs: Date.now() - startedAt,
  })
  return { meta, signatures }
}

function tryExtendLoadedSnapshot(
  requestId: number,
  cache: EmbeddingF16CacheHandle,
  state: VectorAnnSourceState,
  files: { meta: string; signatures: string },
  key: string,
  isCancelled: () => boolean,
): {
  index: LoadedAnnIndex
  built: boolean
  buildMode: VectorAnnBuildMode
  loadMs: number
  loadStats: VectorAnnLoadStats
} | null {
  const current = loaded
  if (!current || !cache.delta) return null
  const old = current.meta
  if (
    old.version !== VECTOR_ANN_VERSION ||
    old.modelName !== cache.meta.modelName ||
    old.embeddingType !== cache.meta.embeddingType ||
    old.dim !== cache.meta.dim ||
    old.baseFingerprint !== state.baseFingerprint ||
    old.baseCount !== state.baseCount ||
    old.baseTailSha256 !== state.baseTailSha256 ||
    !sameFileChunkIntegrity(old.baseChunkIntegrity, state.baseChunkIntegrity) ||
    !Number.isInteger(old.deltaCount) ||
    old.deltaCount! < 0 ||
    old.deltaCount! > state.deltaCount ||
    old.count !== state.baseCount + old.deltaCount! ||
    current.paths.count !== old.count ||
    current.signatures.length >= MAX_HOT_SEGMENTS ||
    current.projections.length >= MAX_HOT_SEGMENTS
  ) {
    return null
  }
  const rowBytes = cache.meta.dim * 2
  const oldDeltaBytes = old.deltaCount! * rowBytes
  if (old.deltaTailSha256 !== sha256FileTailSync(cache.delta.vectorPath, oldDeltaBytes)) {
    return null
  }
  if (
    !old.deltaChunkIntegrity ||
    !verifyFileChunkIntegritySync(cache.delta.vectorPath, oldDeltaBytes, old.deltaChunkIntegrity)
  ) {
    return null
  }
  if (
    current.deltaPathTailSha256 !==
    sha256FileTailSync(cache.delta.pathIndexPath, current.deltaPathBytes)
  ) {
    return null
  }
  if (
    !verifyFileChunkIntegritySync(
      cache.delta.pathIndexPath,
      current.deltaPathBytes,
      current.deltaPathChunkIntegrity,
    )
  ) {
    return null
  }
  const appendCount = state.deltaCount - old.deltaCount!
  const appendBytes = appendCount * rowBytes
  const startedAt = Date.now()
  if (isCancelled()) throw new Error('ANN build cancelled')
  const appendedVectors = readFileRange(cache.delta.vectorPath, oldDeltaBytes, appendBytes)
  const appendedPaths = readStrictPathSuffix(
    cache.delta.pathIndexPath,
    current.deltaPathBytes,
    old.count,
    appendCount,
  )
  const appendedSignatures = Buffer.allocUnsafe(appendCount * VECTOR_ANN_SIGNATURE_BYTES)
  if (appendCount > 0) {
    const plan = createVectorAnnProjectionPlan(cache.meta.dim)
    for (let localRow = 0; localRow < appendCount; localRow++) {
      if ((localRow & 1023) === 0) {
        if (isCancelled()) throw new Error('ANN build cancelled')
        const currentRow = old.count + localRow
        parentPort?.postMessage({
          type: 'progress',
          requestId,
          phase: 'building',
          current: currentRow,
          total: cache.meta.count,
          percent: Math.round((currentRow / Math.max(1, cache.meta.count)) * 100),
        })
      }
      writeVectorAnnSignature(
        appendedSignatures,
        localRow,
        vectorAnnSignatureFromF16(appendedVectors, localRow, plan),
      )
    }
  }
  const appendedProjection = quantizeVectorAnnProjection(
    appendedVectors,
    cache.meta.dim,
    current.projectionDimensions,
    current.projectionInverseScales,
    isCancelled,
    true,
  )
  const meta = createIndexMeta(cache, state)
  const nextIdentity = appendSignatures(old, meta, appendedSignatures, files, current.signatureFile)
  if (appendCount > 0) {
    current.signatures.push({
      startRow: old.count,
      rowCount: appendCount,
      buffer: appendedSignatures,
    })
    current.projections.push({
      startRow: old.count,
      rowCount: appendCount,
      buffer: appendedProjection,
    })
    current.paths.append(appendedPaths.paths)
    current.activeRows = buildLatestActiveRows(current.paths, isCancelled)
  }
  current.key = key
  current.meta = meta
  current.deltaPathBytes = appendedPaths.endOffset
  current.deltaPathTailSha256 = sha256FileTailSync(
    cache.delta.pathIndexPath,
    appendedPaths.endOffset,
  )
  current.deltaPathChunkIntegrity = createFileChunkIntegritySync(
    cache.delta.pathIndexPath,
    appendedPaths.endOffset,
  )
  current.signatureFile = nextIdentity
  persistVectorAnnProjectionSidecar(
    vectorAnnProjectionSidecarPaths(cache.vectorPath),
    projectionSourceIdentity(cache, state),
    cache.meta.count,
    cache.meta.dim,
    current.projectionDimensions,
    current.projectionInverseScales,
    current.projections,
  )
  current.vectorReader.close()
  current.vectorReader = new F16SnapshotReader(cache)
  parentPort?.postMessage({
    type: 'progress',
    requestId,
    phase: 'building',
    current: cache.meta.count,
    total: cache.meta.count,
    percent: 100,
    elapsedMs: Date.now() - startedAt,
  })
  return {
    index: current,
    built: appendCount > 0,
    buildMode: appendCount > 0 ? 'incremental' : 'none',
    loadMs: Date.now() - startedAt,
    loadStats: {
      snapshotLoadMode: appendCount > 0 ? 'delta-only' : 'metadata-only',
      vectorBytesRead: appendBytes,
      pathBytesRead: appendedPaths.bytesRead,
      reusedVectorBytes: old.count * rowBytes,
    },
  }
}

/**
 * Fail-closed integrity gate (VAL-038): a handle minted from disk carries the
 * committed content proofs of every segment; the worker re-verifies them
 * (memoized per on-disk state) before building or extending an index, so
 * corruption that landed after the handle was minted rejects the ANN request
 * instead of being indexed. Handles without proofs are pre-VAL-038 synthetic
 * callers and keep the legacy behavior.
 */
function assertAnnCacheIntegrity(cache: EmbeddingF16CacheHandle): void {
  const integrity = cache.integrity
  if (!integrity) return
  const fail = (segment: string): never => {
    noteEmbeddingCacheIntegrityFailure(
      'ann-worker',
      `${segment} failed its content proof (${cache.vectorPath})`,
    )
    throw new Error(`ANN cache ${segment} integrity proof mismatch`)
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

function ensureLoaded(
  requestId: number,
  cache: EmbeddingF16CacheHandle,
  isCancelled: () => boolean,
): {
  index: LoadedAnnIndex
  built: boolean
  buildMode: VectorAnnBuildMode
  loadMs: number
  loadStats: VectorAnnLoadStats
} {
  const key = `${cache.vectorPath}:${sourceFingerprint(cache)}`
  if (loaded?.key === key) {
    return {
      index: loaded,
      built: false,
      buildMode: 'none',
      loadMs: 0,
      loadStats: {
        snapshotLoadMode: 'none',
        vectorBytesRead: 0,
        pathBytesRead: 0,
        reusedVectorBytes: loaded.meta.count * loaded.meta.dim * 2,
      },
    }
  }
  const startedAt = Date.now()
  if (isCancelled()) throw new Error('ANN search cancelled')
  assertAnnCacheIntegrity(cache)
  const state = sourceState(cache)
  const files = annPaths(cache)
  try {
    const hot = tryExtendLoadedSnapshot(requestId, cache, state, files, key, isCancelled)
    if (hot) return hot
  } catch (error) {
    if (isCancelled()) throw error
    // The hot snapshot or its derived signature file changed unexpectedly.
    // Re-read the complete immutable view below and repair the derived index.
  }
  const pathSnapshot = readPaths(cache)
  const stored = readStoredSignatures(files)
  const fresh = stored && isFreshIndex(cache, stored.meta, state) ? stored : null
  const projectionFiles = vectorAnnProjectionSidecarPaths(cache.vectorPath)
  const projectionIdentity = projectionSourceIdentity(cache, state)
  const storedProjection = readVectorAnnProjectionSidecar(projectionFiles, {
    sourceIdentity: projectionIdentity,
    count: cache.meta.count,
    dim: cache.meta.dim,
  })
  let vectors: Buffer | null = null
  if (!fresh || !storedProjection) {
    // A composite handle stores committed delta rows separately. Full bytes are
    // needed only while repairing a missing/stale derived sidecar; a healthy
    // cold worker opens the sidecars and paged F16 reader without this copy.
    const baseVectors = fs.readFileSync(cache.vectorPath)
    vectors = cache.delta
      ? Buffer.concat([
          baseVectors,
          fs
            .readFileSync(cache.delta.vectorPath)
            .subarray(0, (cache.meta.count - cache.delta.baseCount) * cache.meta.dim * 2),
        ])
      : baseVectors
    if (vectors.length !== cache.meta.count * cache.meta.dim * 2) {
      throw new Error('ANN Float16 vector size mismatch')
    }
  }
  const incremental = fresh
    ? null
    : stored && extendSignatures(requestId, cache, state, vectors!, files, stored, isCancelled)
  const derived =
    fresh || incremental || buildSignatures(requestId, cache, state, vectors!, files, isCancelled)
  const buildMode: VectorAnnBuildMode = fresh ? 'none' : incremental ? 'incremental' : 'full'
  const projection =
    storedProjection || buildVectorAnnQuantizedProjection(vectors!, cache.meta.dim, isCancelled)
  if (!storedProjection) {
    persistVectorAnnProjectionSidecar(
      projectionFiles,
      projectionIdentity,
      cache.meta.count,
      cache.meta.dim,
      projection.dimensions,
      projection.inverseScales,
      [{ startRow: 0, rowCount: cache.meta.count, buffer: projection.values }],
    )
  }
  loaded?.vectorReader.close()
  const compactPaths = new CompactPathTable(pathSnapshot.paths)
  loaded = {
    key,
    meta: derived.meta,
    signatures: [{ startRow: 0, rowCount: cache.meta.count, buffer: derived.signatures }],
    projections: [{ startRow: 0, rowCount: cache.meta.count, buffer: projection.values }],
    projectionDimensions: projection.dimensions,
    projectionInverseScales: projection.inverseScales,
    vectorReader: new F16SnapshotReader(cache),
    paths: compactPaths,
    activeRows: buildLatestActiveRows(compactPaths, isCancelled),
    deltaPathBytes: pathSnapshot.deltaPathBytes,
    deltaPathTailSha256: cache.delta
      ? sha256FileTailSync(cache.delta.pathIndexPath, pathSnapshot.deltaPathBytes)
      : sha256FileTailSync(cache.vectorPath, 0),
    deltaPathChunkIntegrity: cache.delta
      ? createFileChunkIntegritySync(cache.delta.pathIndexPath, pathSnapshot.deltaPathBytes)
      : createFileChunkIntegritySync(cache.vectorPath, 0),
    signatureFile: signatureFileIdentity(files.signatures),
  }
  return {
    index: loaded,
    built: !fresh,
    buildMode,
    loadMs: Date.now() - startedAt,
    loadStats: {
      snapshotLoadMode: vectors ? 'full' : 'sidecar-only',
      vectorBytesRead: vectors?.length ?? 0,
      pathBytesRead: pathSnapshot.bytesRead,
      reusedVectorBytes: 0,
    },
  }
}

function buildLatestActiveRows(paths: CompactPathTable, isCancelled: () => boolean): Uint32Array {
  const latestRowByPath = new Map<string, number>()
  for (let row = 0; row < paths.count; row++) {
    if ((row & 4095) === 0 && isCancelled()) throw new Error('ANN search cancelled')
    const filePath = paths.get(row)
    if (filePath) latestRowByPath.set(embeddingCachePathKey(filePath), row)
  }
  const rows = Uint32Array.from(latestRowByPath.values())
  rows.sort()
  return rows
}

function collectActiveRows(
  index: LoadedAnnIndex,
  acceptPathKeys: readonly string[] | undefined,
  isCancelled: () => boolean,
): Uint32Array {
  if (!acceptPathKeys) return index.activeRows
  const scope = new Set(acceptPathKeys.map(embeddingCachePathKey))
  const accepted: number[] = []
  for (let indexRow = 0; indexRow < index.activeRows.length; indexRow++) {
    if ((indexRow & 4095) === 0 && isCancelled()) throw new Error('ANN search cancelled')
    const row = index.activeRows[indexRow]
    const filePath = index.paths.get(row)
    if (filePath && scope.has(embeddingCachePathKey(filePath))) accepted.push(row)
  }
  return Uint32Array.from(accepted)
}

function searchLoadedIndex(
  index: LoadedAnnIndex,
  activeRows: Uint32Array,
  queryVector: number[],
  topK: number,
  candidateRatio: number | undefined,
  isCancelled: () => boolean,
): { results: VectorAnnWorkerSearchResult[]; candidateCount: number } {
  const candidates = collectVectorAnnProjectionCandidates(
    index.projections,
    index.meta.count,
    index.projectionDimensions,
    index.projectionInverseScales,
    queryVector,
    activeRows,
    topK,
    candidateRatio,
    isCancelled,
  )
  const scored = scoreF16SnapshotCandidates(
    index.vectorReader,
    candidates,
    queryVector,
    topK,
    isCancelled,
  )
  return {
    results: scored.flatMap((item): VectorAnnWorkerSearchResult[] => {
      const filePath = index.paths.get(item.row)
      return filePath ? [{ path: filePath, row: item.row, score: item.score }] : []
    }),
    candidateCount: candidates.length,
  }
}

async function search(request: VectorAnnWorkerSearchRequest): Promise<void> {
  const stopView = new Int32Array(request.stopBuffer)
  const isCancelled = () => Atomics.load(stopView, 0) === 1
  const startedAt = Date.now()
  try {
    const ensured = ensureLoaded(request.requestId, request.cache, isCancelled)
    const activeRows = collectActiveRows(ensured.index, request.acceptPathKeys, isCancelled)
    const query = searchLoadedIndex(
      ensured.index,
      activeRows,
      request.queryVector,
      request.topK,
      request.candidateRatio,
      isCancelled,
    )
    parentPort?.postMessage({
      type: 'result',
      requestId: request.requestId,
      result: {
        results: query.results,
        candidateCount: query.candidateCount,
        indexedCount: ensured.index.meta.count,
        built: ensured.built,
        buildMode: ensured.buildMode,
        loadMs: ensured.loadMs,
        ...ensured.loadStats,
        searchMs: Date.now() - startedAt,
        memory: loadedOwnedMemory(ensured.index),
      },
    })
  } catch (error) {
    parentPort?.postMessage({
      type: isCancelled() ? 'cancelled' : 'error',
      requestId: request.requestId,
      error: errorMessage(error),
    })
  }
}

async function searchBatch(request: VectorAnnWorkerBatchSearchRequest): Promise<void> {
  const stopView = new Int32Array(request.stopBuffer)
  const isCancelled = () => Atomics.load(stopView, 0) === 1
  const startedAt = Date.now()
  try {
    if (request.queryVectors.length === 0 || request.queryVectors.length > 8) {
      throw new Error('ANN batch query count must be between 1 and 8')
    }
    const ensured = ensureLoaded(request.requestId, request.cache, isCancelled)
    const activeRows = collectActiveRows(ensured.index, request.acceptPathKeys, isCancelled)
    const queryResults = request.queryVectors.map((queryVector) =>
      searchLoadedIndex(
        ensured.index,
        activeRows,
        queryVector,
        request.topK,
        request.candidateRatio,
        isCancelled,
      ),
    )
    parentPort?.postMessage({
      type: 'result',
      requestId: request.requestId,
      result: {
        results: [],
        candidateCount: queryResults.reduce((sum, item) => sum + item.candidateCount, 0),
        queryResults,
        indexedCount: ensured.index.meta.count,
        built: ensured.built,
        buildMode: ensured.buildMode,
        loadMs: ensured.loadMs,
        ...ensured.loadStats,
        searchMs: Date.now() - startedAt,
        memory: loadedOwnedMemory(ensured.index),
      },
    })
  } catch (error) {
    parentPort?.postMessage({
      type: isCancelled() ? 'cancelled' : 'error',
      requestId: request.requestId,
      error: errorMessage(error),
    })
  }
}

async function prewarm(request: VectorAnnWorkerPrewarmRequest): Promise<void> {
  const stopView = new Int32Array(request.stopBuffer)
  const isCancelled = () => Atomics.load(stopView, 0) === 1
  const startedAt = Date.now()
  try {
    const ensured = ensureLoaded(request.requestId, request.cache, isCancelled)
    parentPort?.postMessage({
      type: 'result',
      requestId: request.requestId,
      result: {
        results: [],
        candidateCount: 0,
        indexedCount: ensured.index.meta.count,
        built: ensured.built,
        buildMode: ensured.buildMode,
        loadMs: ensured.loadMs,
        ...ensured.loadStats,
        searchMs: Date.now() - startedAt,
        memory: loadedOwnedMemory(ensured.index),
      },
    })
  } catch (error) {
    parentPort?.postMessage({
      type: isCancelled() ? 'cancelled' : 'error',
      requestId: request.requestId,
      error: errorMessage(error),
    })
  }
}

parentPort?.on('message', (request: VectorAnnWorkerRequest) => {
  if (request?.type === 'search') void search(request)
  else if (request?.type === 'search-batch') void searchBatch(request)
  else if (request?.type === 'prewarm') void prewarm(request)
})
