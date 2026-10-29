// Run only during cold startup, before database/index/model services or a
// default browser session are opened. Never mutates or deletes the old root.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import {
  LIBRARY_MARKER,
  StorageLocationService,
  localStorageDirectory,
  readLibraryId,
  readStoragePathAliases,
  writeStorageJson,
} from './storageLocationService'

// Electron owns these transient files. They are not application databases.
const TRANSIENT = new Set([
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'DevToolsActivePort',
])
const PENDING_RECOVERY = new Set([
  '.jsonl-transaction.json',
  '.asset-metadata-transaction.json',
  '.asset-library-restore.json',
  'source-file-sync-recovery.json',
])
interface Entry {
  relative: string
  directory: boolean
  size: number
  mtime: number
  ctime: number
  ino: number
  dev: number
}

function assertDirectoryIdentity(directory: string, expected: fs.Stats): void {
  const current = fs.lstatSync(directory)
  if (
    localStorageDirectory(directory) !== directory ||
    current.ino !== expected.ino ||
    current.dev !== expected.dev
  )
    throw new Error('Storage directory identity changed')
}

async function* inventory(
  root: string,
  signal?: AbortSignal,
  relative = '',
): AsyncGenerator<Entry> {
  signal?.throwIfAborted()
  const absolute = path.join(root, relative)
  if (PENDING_RECOVERY.has(path.basename(relative)))
    throw new Error('Finish pending data recovery in the original library before migrating')
  const stat = await fs.promises.lstat(absolute)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new Error('Data contains a link or special file; migration was stopped')
  if (relative)
    yield {
      relative,
      directory: stat.isDirectory(),
      size: stat.isDirectory() ? 0 : stat.size,
      mtime: stat.isDirectory() ? 0 : stat.mtimeMs,
      ctime: stat.isDirectory() ? 0 : stat.ctimeMs,
      ino: stat.ino,
      dev: stat.dev,
    }
  if (stat.isDirectory()) {
    for (const child of (await fs.promises.readdir(absolute)).sort()) {
      if (!relative && TRANSIENT.has(child)) continue
      yield* inventory(root, signal, path.join(relative, child))
    }
  }
}

async function snapshot(root: string, signal?: AbortSignal, onEntry?: (entry: Entry) => void) {
  const hash = createHash('sha256')
  let totalBytes = 0,
    totalFiles = 0
  for await (const entry of inventory(root, signal)) {
    onEntry?.(entry)
    hash.update(JSON.stringify(entry) + '\n')
    if (!entry.directory && entry.relative !== LIBRARY_MARKER) {
      totalBytes += entry.size
      totalFiles++
    }
  }
  return { fingerprint: hash.digest('hex'), totalBytes, totalFiles }
}

async function hashFile(
  filename: string,
  signal?: AbortSignal,
  onRead?: (bytes: number) => void,
): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filename)) {
    signal?.throwIfAborted()
    hash.update(chunk)
    onRead?.(chunk.length)
  }
  return hash.digest('hex')
}

export interface MigrationProgress {
  phase: 'scanning' | 'copying' | 'checking-source' | 'verifying' | 'committing' | 'completed'
  currentFile: string
  scannedFiles: number
  copiedBytes: number
  totalBytes: number
  copiedFiles: number
  totalFiles: number
  /** Bytes read across both source and destination during the final comparison. */
  verifiedBytes: number
  verifiedFiles: number
}
export interface MigrationResult {
  migrated: boolean
  failed: boolean
  partialDirectory?: string
  reason?: string
}

export async function migrateStorageDirectory(
  service: StorageLocationService,
  options: {
    signal?: AbortSignal
    onProgress?: (value: MigrationProgress) => void
    protectDirectory?: (directory: string) => Promise<void>
  } = {},
): Promise<MigrationResult> {
  const state = service.read()
  if (!state?.pending) return { migrated: false, failed: false }
  const pending = state.pending
  let partial: string | undefined
  const progress: MigrationProgress = {
    phase: 'scanning',
    currentFile: '',
    scannedFiles: 0,
    copiedBytes: 0,
    totalBytes: 0,
    copiedFiles: 0,
    totalFiles: 0,
    verifiedBytes: 0,
    verifiedFiles: 0,
  }
  const notify = () => {
    try {
      options.onProgress?.({ ...progress })
    } catch {
      // Presentation is not part of the copy transaction. A broken observer
      // must neither escape a stream callback nor roll back a committed root.
    }
  }
  const scan = (root: string, initial = false) => {
    progress.scannedFiles = 0
    return snapshot(root, options.signal, (entry) => {
      progress.currentFile = entry.relative
      if (!entry.directory && entry.relative !== LIBRARY_MARKER) {
        progress.scannedFiles++
        if (initial) {
          progress.totalFiles = progress.scannedFiles
          progress.totalBytes += entry.size
        }
      }
      notify()
    })
  }
  try {
    notify()
    const source = service.resolveRoot()
    const sourceIdentity = fs.lstatSync(source)
    const parent = localStorageDirectory(path.dirname(pending.destination))
    const destination = path.join(parent, path.basename(pending.destination))
    if (destination !== pending.destination) throw new Error('Destination directory changed')
    // Re-run overlap/existence validation against the cold source's real path.
    for (const [a, b] of [
      [source, destination],
      [destination, source],
    ]) {
      const relative = path.relative(a, b)
      if (
        !relative ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      )
        throw new Error('Data directories overlap')
    }
    const before = await scan(source, true)
    const totalBytes = before.totalBytes
    const disk = await fs.promises.statfs(parent)
    if (disk.bavail * disk.bsize < totalBytes + Math.max(64 * 1024 * 1024, totalBytes * 0.05))
      throw new Error('Not enough free disk space')
    // Exclusive ownership: an interrupted attempt is retained, never overwritten.
    partial = destination
    await fs.promises.mkdir(partial, { mode: 0o700 })
    const destinationIdentity = fs.lstatSync(partial)
    await options.protectDirectory?.(partial)
    progress.phase = 'copying'
    progress.currentFile = ''
    notify()
    for await (const entry of inventory(source, options.signal)) {
      options.signal?.throwIfAborted()
      // The marker is published last so interrupted copies cannot be reconnected.
      if (entry.relative === LIBRARY_MARKER) continue
      progress.currentFile = entry.relative
      if (localStorageDirectory(parent) !== parent || localStorageDirectory(source) !== source)
        throw new Error('Storage directory changed')
      const target = path.join(partial, entry.relative)
      if (entry.directory) {
        await fs.promises.mkdir(target, { mode: 0o700 })
        continue
      }
      const from = path.join(source, entry.relative)
      const current = await fs.promises.lstat(from)
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.size !== entry.size ||
        current.mtimeMs !== entry.mtime ||
        current.ino !== entry.ino ||
        current.dev !== entry.dev
      )
        throw new Error('Source changed during migration')
      const hash = createHash('sha256')
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk)
          progress.copiedBytes += chunk.length
          notify()
          callback(null, chunk)
        },
      })
      await pipeline(
        fs.createReadStream(from),
        meter,
        // Flush using the original writable descriptor before it closes. Opening
        // a copied DLL for writing again can fail under transient Windows locks.
        fs.createWriteStream(target, { flags: 'wx', mode: 0o600, flush: true }),
        { signal: options.signal },
      )
      const copiedHash = hash.digest('hex')
      if ((await hashFile(target, options.signal, () => notify())) !== copiedHash)
        throw new Error('Data verification failed')
      await fs.promises.utimes(target, current.atimeMs / 1000, current.mtimeMs / 1000)
      progress.copiedFiles++
      notify()
    }
    progress.phase = 'checking-source'
    notify()
    if (before.fingerprint !== (await scan(source)).fingerprint)
      throw new Error('Source changed during migration')
    progress.phase = 'verifying'
    progress.currentFile = ''
    notify()
    // Pair two ordered streams; memory stays bounded even for large thumbnail trees.
    const copied = inventory(partial, options.signal)
    const verifiedDestination = createHash('sha256')
    for await (const entry of inventory(source, options.signal)) {
      if (entry.relative === LIBRARY_MARKER) continue
      progress.currentFile = entry.relative
      const next = await copied.next()
      if (
        next.done ||
        next.value.relative !== entry.relative ||
        next.value.directory !== entry.directory ||
        next.value.size !== entry.size
      )
        throw new Error('Destination changed during migration')
      // Remember exactly the destination entries whose contents are checked.
      // Include inode, timestamps and size so later equal-size rewrites,
      // replacement directories and missing/extra files invalidate the commit.
      verifiedDestination.update(JSON.stringify(next.value) + '\n')
      if (!entry.directory) {
        const onRead = (bytes: number) => {
          progress.verifiedBytes += bytes
          notify()
        }
        if (
          (await hashFile(path.join(partial, entry.relative), options.signal, onRead)) !==
          (await hashFile(path.join(source, entry.relative), options.signal, onRead))
        )
          throw new Error('Final data verification failed')
        progress.verifiedFiles++
        notify()
      }
    }
    if (!(await copied.next()).done) throw new Error('Unexpected destination files')
    progress.phase = 'committing'
    notify()
    if (before.fingerprint !== (await scan(source)).fingerprint)
      throw new Error('Source changed during final verification')
    assertDirectoryIdentity(source, sourceIdentity)
    assertDirectoryIdentity(destination, destinationIdentity)
    if (verifiedDestination.digest('hex') !== (await scan(destination)).fingerprint)
      throw new Error('Destination changed after final verification')
    if (readLibraryId(source) !== state.libraryId) throw new Error('Library verification failed')
    options.signal?.throwIfAborted()
    if (localStorageDirectory(parent) !== parent) throw new Error('Destination directory changed')
    const previousRoots = [...new Set([source, ...readStoragePathAliases(source)])]
    if (previousRoots.length > 64) throw new Error('Too many historical data locations')
    assertDirectoryIdentity(source, sourceIdentity)
    assertDirectoryIdentity(destination, destinationIdentity)
    // Only the location descriptor changes. All payload bytes and vector IDs stay intact.
    writeStorageJson(path.join(destination, LIBRARY_MARKER), {
      version: 1,
      libraryId: state.libraryId,
      previousRoots,
    })
    if (readLibraryId(destination) !== state.libraryId)
      throw new Error('Library verification failed')
    assertDirectoryIdentity(destination, destinationIdentity)
    // This atomic pointer switch is the commit. Old data is still complete.
    service.save({
      ...state,
      root: destination,
      previousRoot: source,
      pending: undefined,
      lastMigration: { state: 'completed', at: Date.now() },
    })
  } catch (error) {
    service.save({
      ...state,
      pending: undefined,
      lastMigration: { state: 'failed', at: Date.now() },
    })
    return {
      migrated: false,
      failed: true,
      partialDirectory: partial,
      reason: error instanceof Error ? error.message.slice(0, 500) : 'Data migration failed',
    }
  }
  // Once the pointer is committed, completion reporting cannot enter rollback.
  progress.phase = 'completed'
  progress.currentFile = ''
  notify()
  return { migrated: true, failed: false }
}
