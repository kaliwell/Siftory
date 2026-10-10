import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { verifyEmbeddingCacheFileProof } from './embeddingCacheIntegrity'

// Version 2 guarantees strict finite/non-zero/exact-dimension source validation.
export const AUTHORITATIVE_VECTOR_STORE_VERSION = 2
export const AUTHORITATIVE_VECTOR_DTYPE = 'f16-le'
export const AUTHORITATIVE_IMPORT_TAIL_BYTES = 64 * 1024
export const FILE_CHUNK_INTEGRITY_VERSION = 1
export const FILE_CHUNK_INTEGRITY_WINDOW_BYTES = 64 * 1024

export interface FileChunkIntegrityChunk {
  offset: number
  length: number
  sha256: string
}

export interface FileChunkIntegrityAnchor {
  version: number
  windowBytes: number
  anchoredSize: number
  chunks: FileChunkIntegrityChunk[]
}

export interface AuthoritativeVectorStoreImport {
  path: string
  size: number
  mtimeMs: number
  tailSha256?: string
  chunkIntegrity?: FileChunkIntegrityAnchor
}

export interface AuthoritativeVectorStoreFile {
  name: string
  size: number
  sha256: string
}

export interface AuthoritativeVectorStoreEntry {
  modelName: string
  embeddingType: string
  dim: number
  dtype: typeof AUTHORITATIVE_VECTOR_DTYPE
  count: number
  sourceRecordCount: number
  imports: AuthoritativeVectorStoreImport[]
  vectors: AuthoritativeVectorStoreFile
  paths: AuthoritativeVectorStoreFile
}

export interface AuthoritativeVectorStoreManifest {
  version: number
  generation: string
  createdAt: number
  entries: AuthoritativeVectorStoreEntry[]
}

interface CurrentGeneration {
  version: number
  generation: string
  manifestSha256: string
  switchedAt: number
}

export interface AuthoritativeVectorStoreHandle {
  meta: {
    version: number
    modelName: string
    embeddingType: string
    dim: number
    count: number
    sourceRecordCount: number
    sourceFiles: Array<{ path: string; size: number; mtimeMs: number }>
    updatedAt: number
    generation: string
  }
  vectorPath: string
  pathIndexPath: string
  /**
   * Committed content proofs from the pinned manifest (VAL-038). Readers
   * verify the on-disk files against these before serving the handle, so a
   * generation file corrupted after the CURRENT switch fails closed.
   */
  files: { vectors: AuthoritativeVectorStoreFile; paths: AuthoritativeVectorStoreFile }
}

function isSafeName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 160 &&
    value !== '.' &&
    value !== '..' &&
    path.basename(value) === value &&
    !value.includes('/') &&
    !value.includes('\\')
  )
}

export function authoritativeVectorStoreRootFromCacheDir(cacheDir: string): string {
  return path.join(path.dirname(path.resolve(cacheDir)), 'vector-store')
}

export function sha256FileSync(filePath: string): string {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

export function sha256FileTailSync(filePath: string, anchoredSize: number): string {
  if (!Number.isInteger(anchoredSize) || anchoredSize < 0) {
    throw new Error('Invalid authoritative import size')
  }
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size < anchoredSize) {
      throw new Error('Authoritative import is shorter than its anchor')
    }
    const length = Math.min(AUTHORITATIVE_IMPORT_TAIL_BYTES, anchoredSize)
    const buffer = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const read = fs.readSync(fd, buffer, offset, length - offset, anchoredSize - length + offset)
      if (read === 0) throw new Error('Could not read authoritative import tail')
      offset += read
    }
    hash.update(buffer)
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function chunkIntegrityWindows(anchoredSize: number): Array<{ offset: number; length: number }> {
  if (!Number.isSafeInteger(anchoredSize) || anchoredSize < 0) {
    throw new Error('Invalid file chunk integrity size')
  }
  if (anchoredSize === 0) return []
  const length = Math.min(FILE_CHUNK_INTEGRITY_WINDOW_BYTES, anchoredSize)
  const maxOffset = anchoredSize - length
  const offsets = [
    ...new Set([0, Math.floor(maxOffset / 3), Math.floor((maxOffset * 2) / 3), maxOffset]),
  ]
  return offsets.map((offset) => ({ offset, length }))
}

function hashFileRangeSync(filePath: string, offset: number, length: number): string {
  const hash = crypto.createHash('sha256')
  if (length === 0) return hash.digest('hex')
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size < offset + length) {
      throw new Error('File chunk integrity range is unavailable')
    }
    const buffer = Buffer.allocUnsafe(length)
    let readOffset = 0
    while (readOffset < length) {
      const read = fs.readSync(
        descriptor,
        buffer,
        readOffset,
        length - readOffset,
        offset + readOffset,
      )
      if (read === 0) throw new Error('Could not read file chunk integrity range')
      readOffset += read
    }
    hash.update(buffer)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

export function createFileChunkIntegritySync(
  filePath: string,
  anchoredSize: number,
): FileChunkIntegrityAnchor {
  return {
    version: FILE_CHUNK_INTEGRITY_VERSION,
    windowBytes: FILE_CHUNK_INTEGRITY_WINDOW_BYTES,
    anchoredSize,
    chunks: chunkIntegrityWindows(anchoredSize).map(({ offset, length }) => ({
      offset,
      length,
      sha256: hashFileRangeSync(filePath, offset, length),
    })),
  }
}

export function isValidFileChunkIntegrity(
  value: unknown,
  anchoredSize: number,
): value is FileChunkIntegrityAnchor {
  if (!value || typeof value !== 'object') return false
  const anchor = value as FileChunkIntegrityAnchor
  if (
    anchor.version !== FILE_CHUNK_INTEGRITY_VERSION ||
    anchor.windowBytes !== FILE_CHUNK_INTEGRITY_WINDOW_BYTES ||
    !Number.isSafeInteger(anchor.anchoredSize) ||
    anchor.anchoredSize < 0 ||
    anchor.anchoredSize > anchoredSize ||
    !Array.isArray(anchor.chunks)
  ) {
    return false
  }
  let expected: Array<{ offset: number; length: number }>
  try {
    expected = chunkIntegrityWindows(anchor.anchoredSize)
  } catch {
    return false
  }
  return (
    anchor.chunks.length === expected.length &&
    anchor.chunks.every(
      (chunk, index) =>
        chunk?.offset === expected[index].offset &&
        chunk.length === expected[index].length &&
        /^[a-f0-9]{64}$/.test(chunk.sha256),
    )
  )
}

export function verifyFileChunkIntegritySync(
  filePath: string,
  anchoredSize: number,
  anchor: FileChunkIntegrityAnchor,
): boolean {
  if (!isValidFileChunkIntegrity(anchor, anchoredSize)) return false
  try {
    return anchor.chunks.every(
      (chunk) => hashFileRangeSync(filePath, chunk.offset, chunk.length) === chunk.sha256,
    )
  } catch {
    return false
  }
}

export function sameFileChunkIntegrity(
  left: FileChunkIntegrityAnchor | undefined,
  right: FileChunkIntegrityAnchor | undefined,
): boolean {
  if (!left || !right) return left === right
  return JSON.stringify(left) === JSON.stringify(right)
}

export function readCurrentAuthoritativeManifest(
  storeRoot: string,
  verifyFileChecksums = false,
): AuthoritativeVectorStoreManifest | null {
  try {
    const currentPath = path.join(storeRoot, 'CURRENT')
    const current = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as CurrentGeneration
    if (
      current.version !== AUTHORITATIVE_VECTOR_STORE_VERSION ||
      !isSafeName(current.generation) ||
      !/^[a-f0-9]{64}$/.test(current.manifestSha256)
    ) {
      return null
    }
    const generationDir = path.join(storeRoot, 'generations', current.generation)
    const manifestPath = path.join(generationDir, 'manifest.json')
    if (sha256FileSync(manifestPath) !== current.manifestSha256) return null
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as AuthoritativeVectorStoreManifest
    if (
      manifest.version !== AUTHORITATIVE_VECTOR_STORE_VERSION ||
      manifest.generation !== current.generation ||
      !Number.isFinite(manifest.createdAt) ||
      !Array.isArray(manifest.entries)
    ) {
      return null
    }
    const identities = new Set<string>()
    for (const entry of manifest.entries) {
      const identity = `${entry.modelName}\0${entry.embeddingType}`
      if (
        identities.has(identity) ||
        typeof entry.modelName !== 'string' ||
        typeof entry.embeddingType !== 'string' ||
        !Number.isInteger(entry.dim) ||
        entry.dim <= 0 ||
        entry.dtype !== AUTHORITATIVE_VECTOR_DTYPE ||
        !Number.isInteger(entry.count) ||
        entry.count < 0 ||
        !Number.isInteger(entry.sourceRecordCount) ||
        entry.sourceRecordCount < entry.count ||
        !Array.isArray(entry.imports) ||
        !entry.imports.every(
          (source) =>
            typeof source.path === 'string' &&
            Number.isInteger(source.size) &&
            source.size >= 0 &&
            Number.isFinite(source.mtimeMs) &&
            (source.tailSha256 === undefined || /^[a-f0-9]{64}$/.test(source.tailSha256)) &&
            (source.chunkIntegrity === undefined ||
              (source.chunkIntegrity.anchoredSize === source.size &&
                isValidFileChunkIntegrity(source.chunkIntegrity, source.size))),
        ) ||
        !isSafeName(entry.vectors?.name) ||
        !isSafeName(entry.paths?.name) ||
        !Number.isInteger(entry.vectors.size) ||
        entry.vectors.size !== entry.count * entry.dim * 2 ||
        !Number.isInteger(entry.paths.size) ||
        entry.paths.size < 0 ||
        !/^[a-f0-9]{64}$/.test(entry.vectors.sha256) ||
        !/^[a-f0-9]{64}$/.test(entry.paths.sha256)
      ) {
        return null
      }
      identities.add(identity)
      for (const file of [entry.vectors, entry.paths]) {
        const target = path.join(generationDir, file.name)
        const stat = fs.statSync(target)
        if (!stat.isFile() || stat.size !== file.size) return null
        if (verifyFileChecksums && !verifyEmbeddingCacheFileProof(target, file)) return null
      }
    }
    return manifest
  } catch {
    return null
  }
}

export function openAuthoritativeVectorStore(
  storeRoot: string,
  modelName: string,
  embeddingType: string,
  dim: number,
  verifyFileChecksums = false,
  expectedSourcePaths?: string[],
): AuthoritativeVectorStoreHandle | null {
  const manifest = readCurrentAuthoritativeManifest(storeRoot, verifyFileChecksums)
  const entry = manifest?.entries.find(
    (candidate) =>
      candidate.modelName === modelName &&
      candidate.embeddingType === embeddingType &&
      candidate.dim === dim,
  )
  if (!manifest || !entry) return null
  if (expectedSourcePaths) {
    for (const sourcePath of expectedSourcePaths) {
      try {
        const stat = fs.statSync(sourcePath)
        const imported = entry.imports.find(
          (source) => path.resolve(source.path) === path.resolve(sourcePath),
        )
        if (
          !imported ||
          !stat.isFile() ||
          stat.size !== imported.size ||
          stat.mtimeMs !== imported.mtimeMs ||
          (imported.tailSha256 !== undefined &&
            sha256FileTailSync(sourcePath, imported.size) !== imported.tailSha256) ||
          (imported.chunkIntegrity !== undefined &&
            !verifyFileChunkIntegritySync(sourcePath, imported.size, imported.chunkIntegrity))
        ) {
          return null
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return null
        /* Removed import copies do not invalidate the authoritative generation. */
      }
    }
  }
  const generationDir = path.join(storeRoot, 'generations', manifest.generation)
  const vectorPath = path.join(generationDir, entry.vectors.name)
  const pathIndexPath = path.join(generationDir, entry.paths.name)
  const vectorStat = fs.statSync(vectorPath)
  const pathStat = fs.statSync(pathIndexPath)
  return {
    meta: {
      version: AUTHORITATIVE_VECTOR_STORE_VERSION,
      modelName,
      embeddingType,
      dim,
      count: entry.count,
      sourceRecordCount: entry.sourceRecordCount,
      sourceFiles: [
        { path: vectorPath, size: vectorStat.size, mtimeMs: vectorStat.mtimeMs },
        { path: pathIndexPath, size: pathStat.size, mtimeMs: pathStat.mtimeMs },
      ],
      updatedAt: manifest.createdAt,
      generation: manifest.generation,
    },
    vectorPath,
    pathIndexPath,
    files: { vectors: entry.vectors, paths: entry.paths },
  }
}
