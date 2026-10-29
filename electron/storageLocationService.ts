// Filesystem-only application boundary: reusable by the desktop adapter and a
// future single-writer LAN host. No Electron, renderer, or network dependencies.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { StorageLocationStatus } from '../shared/ipc/storage-location'

export const LIBRARY_MARKER = '.siftory-library.json'
const BOOTSTRAP_NAME = 'siftory-storage-location.json'
const ID = /^[a-f0-9-]{36}$/

export interface StorageBootstrap {
  version: 1
  libraryId: string
  root: string
  previousRoot?: string
  pending?: { id: string; source: string; destination: string }
  lastMigration?: { state: 'completed' | 'failed'; at: number }
}

function readObject(filename: string): Record<string, unknown> {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
    throw new Error('Invalid storage location file')
  const value: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid storage location file')
  return value as Record<string, unknown>
}

export function writeStorageJson(filename: string, value: unknown): void {
  const temporary = `${filename}.${randomUUID()}.tmp`
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n')
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  try {
    fs.renameSync(temporary, filename)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

export function localStorageDirectory(directory: string): string {
  if (!path.isAbsolute(directory) || directory.includes('\0') || /^[/\\]{2}/.test(directory))
    throw new Error('Select an absolute local directory')
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Select a real directory, not a directory link')
  const resolved = fs.realpathSync.native(directory)
  if (/^[/\\]{2}/.test(resolved)) throw new Error('Select a local data directory')
  return resolved
}

export function readStoragePathAliases(directory: string): string[] {
  const value = readObject(path.join(directory, LIBRARY_MARKER))
  if (value.previousRoots === undefined) return []
  if (
    !Array.isArray(value.previousRoots) ||
    value.previousRoots.length > 64 ||
    !value.previousRoots.every(absoluteString)
  )
    throw new Error('Invalid historical data locations')
  return value.previousRoots as string[]
}

export function readLibraryId(directory: string): string {
  const value = readObject(path.join(directory, LIBRARY_MARKER))
  if (value.version !== 1 || typeof value.libraryId !== 'string' || !ID.test(value.libraryId))
    throw new Error('Invalid library identity')
  return value.libraryId
}

function absoluteString(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')
}

export class StorageLocationService {
  readonly bootstrapPath: string
  constructor(
    readonly appData: string,
    readonly defaultRoot: string,
  ) {
    this.bootstrapPath = path.join(appData, BOOTSTRAP_NAME)
  }

  read(): StorageBootstrap | null {
    try {
      fs.lstatSync(this.bootstrapPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const value = readObject(this.bootstrapPath)
    if (
      value.version !== 1 ||
      typeof value.libraryId !== 'string' ||
      !ID.test(value.libraryId) ||
      !absoluteString(value.root) ||
      (value.previousRoot !== undefined && !absoluteString(value.previousRoot))
    )
      throw new Error('Invalid data location configuration; restore the location file')
    if (value.pending !== undefined) {
      const pending = value.pending as StorageBootstrap['pending']
      if (
        !pending ||
        typeof pending !== 'object' ||
        !ID.test(pending.id) ||
        !absoluteString(pending.source) ||
        !absoluteString(pending.destination) ||
        pending.source !== value.root
      )
        throw new Error('Invalid pending data migration')
    }
    if (value.lastMigration !== undefined) {
      const last = value.lastMigration as StorageBootstrap['lastMigration']
      if (!last || !['completed', 'failed'].includes(last.state) || !Number.isFinite(last.at))
        throw new Error('Invalid data migration result')
    }
    return value as unknown as StorageBootstrap
  }

  /** No fallback when an explicitly selected disk is offline. */
  resolveRoot(): string {
    const state = this.read()
    if (!state) return this.defaultRoot
    const root = localStorageDirectory(state.root)
    readStoragePathAliases(root)
    if (readLibraryId(root) !== state.libraryId)
      throw new Error('The selected directory belongs to another library')
    return root
  }

  initialize(): StorageBootstrap {
    const state = this.read()
    if (state) {
      this.resolveRoot()
      return state
    }
    fs.mkdirSync(this.defaultRoot, { recursive: true })
    const root = localStorageDirectory(this.defaultRoot)
    const marker = path.join(root, LIBRARY_MARKER)
    const libraryId = fs.existsSync(marker) ? readLibraryId(root) : randomUUID()
    if (!fs.existsSync(marker)) writeStorageJson(marker, { version: 1, libraryId })
    const initial: StorageBootstrap = { version: 1, libraryId, root }
    this.save(initial)
    return initial
  }

  save(state: StorageBootstrap): void {
    writeStorageJson(this.bootstrapPath, state)
  }

  status(externalMediaDirectory: boolean): StorageLocationStatus {
    const state = this.initialize()
    return {
      backend: 'local',
      libraryId: state.libraryId,
      root: state.root,
      previousRoot: state.previousRoot,
      pending: Boolean(state.pending),
      lastMigration: state.lastMigration,
      externalMediaDirectory,
    }
  }

  schedule(destination: string): void {
    const state = this.initialize()
    if (state.pending) throw new Error('A data migration is already scheduled')
    const parent = localStorageDirectory(path.dirname(destination))
    if (path.join(parent, path.basename(destination)) !== destination)
      throw new Error('The destination changed; select it again')
    for (const [a, b] of [
      [state.root, destination],
      [destination, state.root],
    ]) {
      const relative = path.relative(a, b)
      if (
        !relative ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      )
        throw new Error('Data directories must not overlap')
    }
    if (fs.existsSync(destination)) throw new Error('The destination already exists')
    this.save({ ...state, pending: { id: randomUUID(), source: state.root, destination } })
  }

  /** Explicit recovery only, after the user selects an existing matching library. */
  reconnect(directory: string): void {
    const state = this.read()
    if (!state) throw new Error('No relocated library is configured')
    const root = localStorageDirectory(directory)
    if (readLibraryId(root) !== state.libraryId)
      throw new Error('This is not the configured library')
    if (root !== state.root) {
      const previousRoots = [...new Set([state.root, ...readStoragePathAliases(root)])]
      if (previousRoots.length > 64) throw new Error('Too many historical data locations')
      writeStorageJson(path.join(root, LIBRARY_MARKER), {
        version: 1,
        libraryId: state.libraryId,
        previousRoots,
      })
    }
    this.save({ ...state, root, pending: undefined })
  }
}
