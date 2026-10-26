import path from 'path'
import type { ModelRequiredFile } from '../shared/vectorTypes'
import crypto from 'crypto'
import fs from 'fs'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'

export interface ModelDownloadProgress {
  bytesDownloaded: number
  totalBytes: number
}

export interface ModelDownloadStreamOptions {
  signal: AbortSignal
  totalBytes: number
  progressIntervalMs?: number
  progressByteInterval?: number
  onProgress?: (progress: ModelDownloadProgress) => void
}

export async function streamModelBodyToFile(
  body: AsyncIterable<Uint8Array>,
  destPath: string,
  options: ModelDownloadStreamOptions,
): Promise<{ bytesDownloaded: number; sha256: string }> {
  const hash = crypto.createHash('sha256')
  const progressIntervalMs = Math.max(50, options.progressIntervalMs ?? 200)
  const progressByteInterval = Math.max(64 * 1024, options.progressByteInterval ?? 4 * 1024 * 1024)
  let bytesDownloaded = 0
  let lastProgressAt = Date.now()
  let lastProgressBytes = 0

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      bytesDownloaded += chunk.length
      const now = Date.now()
      if (
        now - lastProgressAt >= progressIntervalMs ||
        bytesDownloaded - lastProgressBytes >= progressByteInterval
      ) {
        lastProgressAt = now
        lastProgressBytes = bytesDownloaded
        options.onProgress?.({ bytesDownloaded, totalBytes: options.totalBytes })
      }
      callback(null, chunk)
    },
  })

  await pipeline(Readable.from(body), meter, fs.createWriteStream(destPath), {
    signal: options.signal,
  })
  if (bytesDownloaded !== lastProgressBytes) {
    options.onProgress?.({ bytesDownloaded, totalBytes: options.totalBytes })
  }
  return { bytesDownloaded, sha256: hash.digest('hex') }
}

const HASH_BUFFER_BYTES = 4 * 1024 * 1024
interface VerificationCacheEntry {
  size: number
  mtimeMs: number
  ctimeMs: number
  expectedSize: number
  expectedSha256: string
  verified: boolean
}

const verificationCache = new Map<string, VerificationCacheEntry>()

function verificationSidecarPath(modelPath: string): string {
  return `${modelPath}.verified.json`
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return (
    Boolean(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function hashFileBoundedSync(filePath: string): string {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES)
  const fd = fs.openSync(filePath, 'r')
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function cacheEntryMatches(
  cached: VerificationCacheEntry | undefined,
  stat: fs.Stats,
  file: ModelRequiredFile,
): boolean {
  return Boolean(
    cached &&
    cached.verified &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.ctimeMs === stat.ctimeMs &&
    cached.expectedSize === file.sizeBytes &&
    cached.expectedSha256 === file.sha256,
  )
}

/** Cache only after this process has checked the pinned bytes and file identity. */
export function rememberVerifiedFile(
  modelPath: string,
  file: ModelRequiredFile,
  writableStorageRoot: string,
): void {
  try {
    const stat = fs.statSync(modelPath)
    const entry: VerificationCacheEntry = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      expectedSize: file.sizeBytes,
      expectedSha256: file.sha256,
      verified: true,
    }
    verificationCache.set(modelPath, entry)
    if (!isPathInside(writableStorageRoot, modelPath)) return
    const sidecarPath = verificationSidecarPath(modelPath)
    const temporaryPath = `${sidecarPath}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify({ schemaVersion: 2, ...entry }), {
        encoding: 'utf8',
        flag: 'wx',
      })
      fs.renameSync(temporaryPath, sidecarPath)
    } finally {
      fs.rmSync(temporaryPath, { force: true })
    }
  } catch {
    // Verification remains valid for this process even if its advisory sidecar cannot be written.
  }
}

/**
 * Verifies a pinned file once per unchanged process-local file identity. A
 * persisted sidecar is never accepted as proof, so every process re-hashes
 * existing files before reporting the model as downloaded.
 */
export function verifyPinnedModelFileSync(
  modelPath: string,
  file: ModelRequiredFile,
  writableStorageRoot: string,
): boolean {
  try {
    const before = fs.lstatSync(modelPath)
    if (!before.isFile() || before.isSymbolicLink() || before.size !== file.sizeBytes) return false
    const cached = verificationCache.get(modelPath)
    if (cacheEntryMatches(cached, before, file)) return true
    const verified = hashFileBoundedSync(modelPath) === file.sha256
    const after = fs.lstatSync(modelPath)
    const unchanged =
      after.isFile() &&
      !after.isSymbolicLink() &&
      after.size === before.size &&
      after.mtimeMs === before.mtimeMs &&
      after.ctimeMs === before.ctimeMs
    if (!verified || !unchanged) {
      verificationCache.delete(modelPath)
      return false
    }
    rememberVerifiedFile(modelPath, file, writableStorageRoot)
    return true
  } catch {
    verificationCache.delete(modelPath)
    return false
  }
}

export function verifyPinnedModelFileAsync(
  modelPath: string,
  file: ModelRequiredFile,
  writableStorageRoot: string,
): Promise<boolean> {
  return verifyModelFileAsync(
    modelPath,
    file,
    (stat) => cacheEntryMatches(verificationCache.get(modelPath), stat, file),
    () => rememberVerifiedFile(modelPath, file, writableStorageRoot),
  )
}

/** Full verification with bounded asynchronous reads, keeping renderer IPC responsive. */
export async function verifyModelFileAsync(
  modelPath: string,
  file: ModelRequiredFile,
  matchesCache: (stat: fs.Stats) => boolean,
  rememberVerified: () => void,
): Promise<boolean> {
  let handle: fs.promises.FileHandle | undefined
  try {
    const before = await fs.promises.lstat(modelPath)
    if (!before.isFile() || before.isSymbolicLink() || before.size !== file.sizeBytes) return false
    if (matchesCache(before)) return true
    handle = await fs.promises.open(modelPath, 'r')
    const opened = await handle.stat()
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.ctimeMs !== before.ctimeMs)
      return false
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let total = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += bytesRead
      if (total > file.sizeBytes) return false
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await fs.promises.lstat(modelPath)
    if (
      total !== file.sizeBytes ||
      hash.digest('hex') !== file.sha256 ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      return false
    rememberVerified()
    return true
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}
export function resetModelFileVerificationCache(): void {
  verificationCache.clear()
}

export function clearModelFileVerificationCacheUnder(directory: string): void {
  const resolved = path.resolve(directory)
  for (const modelPath of verificationCache.keys()) {
    if (modelPath === resolved || modelPath.startsWith(`${resolved}${path.sep}`)) {
      verificationCache.delete(modelPath)
    }
  }
}
