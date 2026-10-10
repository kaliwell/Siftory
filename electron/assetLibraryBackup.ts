import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync } from 'node:sqlite'
import type {
  AssetLibraryBackupReason,
  AssetLibraryBackupSummary,
  AssetLibraryBackupVerification,
} from '../shared/ipc/asset-library'

const BACKUP_VERSION = 2
const BACKUP_PREFIX = 'backup-'
const EXPORT_DIRECTORY_PREFIX = 'floating-clock-backup-'
const REDACTED_SOURCE_DIRECTORY = 'asset-library'
const SECURE_EXPORT_PREFIX = 'siftory-secure-backup-'
const SECURE_EXPORT_MANIFEST = 'siftory-secure-backup.json'
const SECURE_EXPORT_VERSION = 2
const LEGACY_SECURE_EXPORT_VERSION = 1
const SECURE_EXPORT_MAX_BYTES = 16 * 1024 * 1024 * 1024
const SECURE_IMPORT_TEMP_PREFIX = '.siftory-secure-import-'
const SECURE_IMPORT_STALE_AGE_MS = 24 * 60 * 60 * 1000
const SECURE_KDF_V1 = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const
const SECURE_KDF_V2 = { N: 131_072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 } as const
const DEFAULT_MINIMUM_INTERVAL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_BACKUPS = 7
const MAX_BACKUP_FILES = 128
const RESTORE_VERSION = 1
const RESTORE_JOURNAL = '.asset-library-restore.json'
const RESTORE_STAGE_PREFIX = '.asset-library-restore-stage-'
const MAX_RESTORE_ENTRIES = MAX_BACKUP_FILES * 2 + 32
const SQLITE_FILENAME = 'asset-library.sqlite'
const DERIVED_CATALOG_FILES = [
  'asset-catalog.sqlite',
  'asset-catalog.sqlite-wal',
  'asset-catalog.sqlite-shm',
  'asset-library.sqlite-wal',
  'asset-library.sqlite-shm',
] as const
// SQLite is snapshotted via VACUUM INTO. JSONL mode remains supported, so
// preserve both live relation files and their post-migration copies.
const ROOT_METADATA_FILES = [
  'assets.jsonl',
  'state.json',
  'archived-assets.json',
  // Phase 2 stable AssetId ↔ identity mapping (rebuildable, but backed up
  // so restore preserves the mapping verbatim — Phase 2 acceptance).
  'asset-identities.jsonl',
  'smart-albums.jsonl',
  'asset-collections.jsonl',
  'asset-collection-items.jsonl',
  'reference_embeddings.jsonl',
  'cluster_lineage.jsonl',
  'categories.jsonl.migrated',
  'tags.jsonl.migrated',
  'asset_categories.jsonl.migrated',
  'asset_tags.jsonl.migrated',
  'category_references.jsonl.migrated',
  'suggestions.jsonl.migrated',
  'cluster_groups.jsonl.migrated',
  'cluster_group_assets.jsonl.migrated',
  'metadata_deletion_trash.jsonl.migrated',
  'asset-library.sqlite',
] as const
const DERIVED_CATALOG_SET = new Set<string>(DERIVED_CATALOG_FILES)
// v1 backups stored the relation JSONL under their original names; those
// paths stay valid in manifests and restore journals for backward compat.
const LEGACY_RELATION_JSONL_FILES = [
  'categories.jsonl',
  'tags.jsonl',
  'asset_categories.jsonl',
  'asset_tags.jsonl',
  'category_references.jsonl',
  'suggestions.jsonl',
  'cluster_groups.jsonl',
  'cluster_group_assets.jsonl',
  'metadata_deletion_trash.jsonl',
] as const
const MANAGED_METADATA_SET = new Set<string>([
  ...ROOT_METADATA_FILES,
  ...LEGACY_RELATION_JSONL_FILES,
])

interface AssetLibraryBackupFile {
  path: string
  bytes: number
  sha256: string
}

interface AssetLibraryBackupManifest {
  version: 1 | typeof BACKUP_VERSION
  createdAt: number
  sourceDirectory: string
  reason?: AssetLibraryBackupReason
  files: AssetLibraryBackupFile[]
  totalBytes: number
}

interface AssetLibraryRestoreEntry {
  operation: 'replace' | 'delete'
  target: string
  staged?: string
  bytes?: number
  sha256?: string
}

interface AssetLibraryRestoreJournal {
  version: typeof RESTORE_VERSION
  id: string
  backupId: string
  createdAt: number
  entries: AssetLibraryRestoreEntry[]
}

export interface AssetLibraryBackupOptions {
  now?: number
  minimumIntervalMs?: number
  maxBackups?: number
  reason?: AssetLibraryBackupReason
}

export interface AssetLibraryBackupResult {
  created: boolean
  backupPath?: string
  backup?: AssetLibraryBackupSummary
  fileCount: number
  totalBytes: number
  skippedReason?: 'not-due' | 'no-metadata'
}

export interface AssetLibraryRestoreResult {
  restoredFiles: number
  deletedFiles: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function slashPath(value: string): string {
  return value.replace(/\\/g, '/')
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes(':') || path.isAbsolute(value)) return false
  if (
    slashPath(value)
      .split('/')
      .some((part) => /[. ]$/.test(part) && part !== '..' && part !== '.')
  ) {
    return false
  }
  const normalized = path.normalize(value)
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`)
}

// Check every existing component, including the selected root and its parents.
// Leaf-only lstat checks do not protect reads/renames through directory junctions.
// Missing suffixes are allowed so callers can create a new managed directory.
function assertUnlinkedPath(filePath: string, kind: 'file' | 'directory'): void {
  const absolute = path.resolve(filePath)
  const parsed = path.parse(absolute)
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let current = parsed.root
  for (const [index, component] of components.entries()) {
    current = path.join(current, component)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('Backup path contains a symbolic link or junction')
    const expectedDirectory = index < components.length - 1 || kind === 'directory'
    if (expectedDirectory ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error('Backup path has an unexpected file type')
    }
  }
}

function isManagedMetadataPath(value: string): boolean {
  if (!isSafeRelativePath(value)) return false
  const normalized = slashPath(path.normalize(value))
  return MANAGED_METADATA_SET.has(normalized) || normalized.startsWith('search-feedback/')
}

function isRestoreTarget(value: string): boolean {
  const normalized = slashPath(path.normalize(value))
  return isManagedMetadataPath(normalized) || DERIVED_CATALOG_SET.has(normalized)
}

function backupRoot(assetLibraryDir: string): string {
  return path.join(path.dirname(path.resolve(assetLibraryDir)), 'asset-library-backups')
}

function backupName(now: number): string {
  const timestamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('.', '-')
  return `${BACKUP_PREFIX}${timestamp}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
}

export function normalizeAssetLibraryBackupId(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 180 ||
    !value.startsWith(BACKUP_PREFIX) ||
    path.basename(value) !== value ||
    !/^[a-zA-Z0-9._-]+$/.test(value)
  ) {
    throw new Error('Invalid asset library backup id')
  }
  return value
}

function backupDirectory(assetLibraryDir: string, backupId: string): string {
  const root = backupRoot(assetLibraryDir)
  const directory = path.join(root, normalizeAssetLibraryBackupId(backupId))
  if (path.dirname(path.resolve(directory)) !== path.resolve(root)) {
    throw new Error('Invalid asset library backup path')
  }
  return directory
}

function summaryFromManifest(
  directory: string,
  manifest: AssetLibraryBackupManifest,
): AssetLibraryBackupSummary {
  return {
    id: path.basename(directory),
    createdAt: manifest.createdAt,
    fileCount: manifest.files.length,
    totalBytes: manifest.totalBytes,
    reason: manifest.reason || 'automatic',
    manifestValid: true,
  }
}

async function collectFilesRecursively(
  root: string,
  relativeDir: string,
  output: string[],
  depth = 0,
): Promise<void> {
  if (depth > 4 || output.length >= MAX_BACKUP_FILES) return
  const absoluteDir = path.join(root, relativeDir)
  assertUnlinkedPath(absoluteDir, 'directory')
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (output.length >= MAX_BACKUP_FILES) break
    if (entry.isSymbolicLink())
      throw new Error('Backup metadata contains a symbolic link or junction')
    const relativePath = path.join(relativeDir, entry.name)
    if (!isSafeRelativePath(relativePath)) continue
    if (entry.isDirectory()) {
      await collectFilesRecursively(root, relativePath, output, depth + 1)
    } else if (entry.isFile()) {
      output.push(relativePath)
    }
  }
}

async function listMetadataFiles(assetLibraryDir: string): Promise<string[]> {
  assertUnlinkedPath(assetLibraryDir, 'directory')
  const files: string[] = []
  for (const filename of MANAGED_METADATA_SET) {
    assertUnlinkedPath(path.join(assetLibraryDir, filename), 'file')
    try {
      const stat = await fs.promises.lstat(path.join(assetLibraryDir, filename))
      if (stat.isFile() && !stat.isSymbolicLink()) files.push(filename)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }
  await collectFilesRecursively(assetLibraryDir, 'search-feedback', files)
  return files
}

async function copyFileWithHash(source: string, target: string): Promise<AssetLibraryBackupFile> {
  assertUnlinkedPath(source, 'file')
  assertUnlinkedPath(target, 'file')
  const sourceStat = await fs.promises.lstat(source)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`Backup source is not a regular file: ${source}`)
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  assertUnlinkedPath(source, 'file')
  assertUnlinkedPath(target, 'file')
  const hash = crypto.createHash('sha256')
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(source)
    const output = fs.createWriteStream(target, { flags: 'wx' })
    input.on('data', (chunk: string | Buffer) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      bytes += buffer.length
      hash.update(buffer)
    })
    input.once('error', reject)
    output.once('error', reject)
    output.once('finish', resolve)
    input.pipe(output)
  })
  return { path: '', bytes, sha256: hash.digest('hex') }
}

/** Consistent SQLite snapshot via VACUUM INTO, hashed for the manifest. */
function snapshotSqliteWithHash(source: string, target: string): AssetLibraryBackupFile {
  assertUnlinkedPath(source, 'file')
  assertUnlinkedPath(target, 'file')
  const database = new DatabaseSync(source)
  try {
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  } finally {
    database.close()
  }
  return { path: '', ...hashFileSync(target) }
}

async function hashFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  assertUnlinkedPath(filePath, 'file')
  const stat = await fs.promises.lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular file')
  const hash = crypto.createHash('sha256')
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(filePath)
    input.on('data', (chunk: string | Buffer) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      bytes += buffer.length
      hash.update(buffer)
    })
    input.once('error', reject)
    input.once('end', resolve)
  })
  return { bytes, sha256: hash.digest('hex') }
}

function hashFileSync(filePath: string): { bytes: number; sha256: string } {
  assertUnlinkedPath(filePath, 'file')
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular file')
  const contents = fs.readFileSync(filePath)
  return {
    bytes: contents.length,
    sha256: crypto.createHash('sha256').update(contents).digest('hex'),
  }
}

function validBackupFile(value: unknown): value is AssetLibraryBackupFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<AssetLibraryBackupFile>
  return (
    typeof file.path === 'string' &&
    isManagedMetadataPath(file.path) &&
    Number.isSafeInteger(file.bytes) &&
    Number(file.bytes) >= 0 &&
    typeof file.sha256 === 'string' &&
    /^[a-f\d]{64}$/i.test(file.sha256)
  )
}

async function readManifest(directory: string): Promise<AssetLibraryBackupManifest | null> {
  try {
    assertUnlinkedPath(path.join(directory, 'manifest.json'), 'file')
    const parsed = JSON.parse(
      await fs.promises.readFile(path.join(directory, 'manifest.json'), 'utf8'),
    ) as Partial<AssetLibraryBackupManifest>
    if (
      (parsed.version !== 1 && parsed.version !== BACKUP_VERSION) ||
      !Number.isSafeInteger(parsed.createdAt) ||
      Number(parsed.createdAt) < 0 ||
      typeof parsed.sourceDirectory !== 'string' ||
      !Array.isArray(parsed.files) ||
      parsed.files.length === 0 ||
      parsed.files.length > MAX_BACKUP_FILES ||
      !parsed.files.every(validBackupFile) ||
      !Number.isSafeInteger(parsed.totalBytes) ||
      Number(parsed.totalBytes) < 0 ||
      (parsed.reason !== undefined &&
        parsed.reason !== 'automatic' &&
        parsed.reason !== 'manual' &&
        parsed.reason !== 'pre_restore')
    ) {
      return null
    }
    const uniquePaths = new Set(
      parsed.files.map((file) => slashPath(path.normalize(file.path)).toLowerCase()),
    )
    if (uniquePaths.size !== parsed.files.length) return null
    return parsed as AssetLibraryBackupManifest
  } catch {
    return null
  }
}

async function listCompletedBackups(root: string): Promise<string[]> {
  assertUnlinkedPath(root, 'directory')
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(BACKUP_PREFIX),
    )
    .map((entry) => path.join(root, entry.name))
    .sort((left, right) => path.basename(right).localeCompare(path.basename(left)))
}

async function latestBackupCreatedAt(root: string): Promise<number | null> {
  for (const directory of await listCompletedBackups(root)) {
    const manifest = await readManifest(directory)
    if (manifest) return manifest.createdAt
  }
  return null
}

async function pruneBackups(root: string, maxBackups: number): Promise<void> {
  const completed = await listCompletedBackups(root)
  for (const directory of completed.slice(maxBackups)) {
    if (
      path.dirname(path.resolve(directory)) !== path.resolve(root) ||
      !path.basename(directory).startsWith(BACKUP_PREFIX)
    ) {
      continue
    }
    assertUnlinkedPath(directory, 'directory')
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
}

export function getAssetLibraryBackupRoot(assetLibraryDir: string): string {
  return backupRoot(assetLibraryDir)
}

export async function listAssetLibraryBackups(
  assetLibraryDir: string,
): Promise<AssetLibraryBackupSummary[]> {
  const directories = await listCompletedBackups(backupRoot(assetLibraryDir))
  const summaries = await Promise.all(
    directories.map(async (directory): Promise<AssetLibraryBackupSummary> => {
      const manifest = await readManifest(directory)
      if (manifest) return summaryFromManifest(directory, manifest)
      let createdAt = 0
      try {
        createdAt = Math.max(0, Math.round((await fs.promises.stat(directory)).mtimeMs))
      } catch {
        /* retain the invalid entry so the user can see it */
      }
      return {
        id: path.basename(directory),
        createdAt,
        fileCount: 0,
        totalBytes: 0,
        reason: 'automatic',
        manifestValid: false,
        error: 'Invalid manifest',
      }
    }),
  )
  return summaries.sort((left, right) => right.createdAt - left.createdAt)
}

export async function createAssetLibraryBackupIfDue(
  assetLibraryDir: string,
  options: AssetLibraryBackupOptions = {},
): Promise<AssetLibraryBackupResult> {
  const sourceDirectory = path.resolve(assetLibraryDir)
  const root = backupRoot(sourceDirectory)
  const now = options.now ?? Date.now()
  const minimumIntervalMs = Math.max(0, options.minimumIntervalMs ?? DEFAULT_MINIMUM_INTERVAL_MS)
  const maxBackups = Math.max(1, Math.min(30, options.maxBackups ?? DEFAULT_MAX_BACKUPS))
  const reason = options.reason || 'automatic'
  assertUnlinkedPath(sourceDirectory, 'directory')
  assertUnlinkedPath(root, 'directory')
  await fs.promises.mkdir(root, { recursive: true })
  const latestCreatedAt = await latestBackupCreatedAt(root)
  if (latestCreatedAt !== null && now - latestCreatedAt < minimumIntervalMs) {
    return { created: false, fileCount: 0, totalBytes: 0, skippedReason: 'not-due' }
  }

  const relativeFiles = await listMetadataFiles(sourceDirectory)
  if (relativeFiles.length === 0) {
    return { created: false, fileCount: 0, totalBytes: 0, skippedReason: 'no-metadata' }
  }

  const name = backupName(now)
  const temporaryDirectory = path.join(root, `.${name}.tmp`)
  const finalDirectory = path.join(root, name)
  await fs.promises.mkdir(temporaryDirectory, { recursive: false })
  try {
    const files: AssetLibraryBackupFile[] = []
    for (const relativePath of relativeFiles) {
      if (slashPath(relativePath) === SQLITE_FILENAME) {
        const snapshot = snapshotSqliteWithHash(
          path.join(sourceDirectory, relativePath),
          path.join(temporaryDirectory, relativePath),
        )
        files.push({ ...snapshot, path: slashPath(relativePath) })
        continue
      }
      const copied = await copyFileWithHash(
        path.join(sourceDirectory, relativePath),
        path.join(temporaryDirectory, relativePath),
      )
      files.push({ ...copied, path: slashPath(relativePath) })
    }
    // An empty library may never have flushed the core asset files; seed them
    // so the backup stays restorable (restore requires the asset index).
    const backedUpPaths = new Set(files.map((file) => file.path))
    for (const seed of [
      { filename: 'assets.jsonl', contents: '' },
      { filename: 'state.json', contents: '{"nextId":1}\n' },
    ]) {
      if (backedUpPaths.has(seed.filename)) continue
      const contents = Buffer.from(seed.contents, 'utf8')
      await fs.promises.writeFile(path.join(temporaryDirectory, seed.filename), contents, {
        flag: 'wx',
      })
      files.push({
        path: seed.filename,
        bytes: contents.length,
        sha256: crypto.createHash('sha256').update(contents).digest('hex'),
      })
    }
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
    const manifest: AssetLibraryBackupManifest = {
      version: BACKUP_VERSION,
      createdAt: now,
      sourceDirectory: REDACTED_SOURCE_DIRECTORY,
      reason,
      files,
      totalBytes,
    }
    await fs.promises.writeFile(
      path.join(temporaryDirectory, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      { encoding: 'utf8', flag: 'wx' },
    )
    await fs.promises.rename(temporaryDirectory, finalDirectory)
    await pruneBackups(root, maxBackups)
    const backup = summaryFromManifest(finalDirectory, manifest)
    return {
      created: true,
      backupPath: finalDirectory,
      backup,
      fileCount: files.length,
      totalBytes,
    }
  } catch (error) {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export async function verifyAssetLibraryBackup(
  directory: string,
): Promise<AssetLibraryBackupVerification> {
  const resolvedDirectory = path.resolve(directory)
  const manifest = await readManifest(resolvedDirectory)
  if (!manifest) return { ok: false, fileCount: 0, totalBytes: 0, error: 'Invalid manifest' }
  let totalBytes = 0
  try {
    for (const file of manifest.files) {
      const actual = await hashFile(path.join(resolvedDirectory, file.path))
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) {
        throw new Error(`Backup file failed verification: ${file.path}`)
      }
      totalBytes += actual.bytes
    }
    if (totalBytes !== manifest.totalBytes) throw new Error('Backup size summary is invalid')
    return { ok: true, fileCount: manifest.files.length, totalBytes }
  } catch (error: unknown) {
    return {
      ok: false,
      fileCount: manifest.files.length,
      totalBytes,
      error: errorMessage(error),
    }
  }
}

export async function verifyAssetLibraryBackupById(
  assetLibraryDir: string,
  backupId: string,
): Promise<AssetLibraryBackupVerification> {
  return verifyAssetLibraryBackup(backupDirectory(assetLibraryDir, backupId))
}

function readRestoreJournal(assetLibraryDir: string): AssetLibraryRestoreJournal | null {
  const journalPath = path.join(assetLibraryDir, RESTORE_JOURNAL)
  assertUnlinkedPath(journalPath, 'file')
  let parsed: Partial<AssetLibraryRestoreJournal>
  try {
    parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Partial<AssetLibraryRestoreJournal>
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw new Error(`Could not read asset library restore journal: ${errorMessage(error)}`, {
      cause: error,
    })
  }
  if (
    parsed.version !== RESTORE_VERSION ||
    typeof parsed.id !== 'string' ||
    !/^[a-f\d]{16,64}$/i.test(parsed.id) ||
    typeof parsed.backupId !== 'string' ||
    !Number.isSafeInteger(parsed.createdAt) ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length === 0 ||
    parsed.entries.length > MAX_RESTORE_ENTRIES
  ) {
    throw new Error('Invalid asset library restore journal')
  }
  const targets = new Set<string>()
  for (const entry of parsed.entries) {
    if (!entry || typeof entry !== 'object' || !isRestoreTarget(entry.target)) {
      throw new Error('Invalid asset library restore target')
    }
    const target = slashPath(path.normalize(entry.target)).toLowerCase()
    if (targets.has(target)) throw new Error('Duplicate asset library restore target')
    targets.add(target)
    if (entry.operation === 'delete') {
      if (entry.staged !== undefined || entry.bytes !== undefined || entry.sha256 !== undefined) {
        throw new Error('Invalid asset library restore deletion')
      }
      continue
    }
    if (
      entry.operation !== 'replace' ||
      typeof entry.staged !== 'string' ||
      !isSafeRelativePath(entry.staged) ||
      path.basename(entry.staged) !== entry.staged ||
      !entry.staged.startsWith(RESTORE_STAGE_PREFIX) ||
      !Number.isSafeInteger(entry.bytes) ||
      Number(entry.bytes) < 0 ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f\d]{64}$/i.test(entry.sha256)
    ) {
      throw new Error('Invalid asset library restore replacement')
    }
  }
  return parsed as AssetLibraryRestoreJournal
}

function verifyRestoreFile(filePath: string, entry: AssetLibraryRestoreEntry): boolean {
  if (entry.bytes === undefined || !entry.sha256) return false
  try {
    const actual = hashFileSync(filePath)
    return actual.bytes === entry.bytes && actual.sha256 === entry.sha256
  } catch {
    return false
  }
}

export function recoverAssetLibraryRestore(assetLibraryDir: string): boolean {
  const sourceDirectory = path.resolve(assetLibraryDir)
  const journal = readRestoreJournal(sourceDirectory)
  if (!journal) return false
  // Validate the entire replay before its first mutation, including already
  // applied replacements whose staged file disappeared after a prior rename.
  preflightRestoreEntries(sourceDirectory, journal.entries)
  for (const entry of journal.entries) {
    const targetPath = path.join(sourceDirectory, entry.target)
    assertUnlinkedPath(targetPath, 'file')
    if (entry.operation === 'delete') {
      fs.rmSync(targetPath, { force: true })
      continue
    }
    const stagedPath = path.join(sourceDirectory, entry.staged as string)
    assertUnlinkedPath(stagedPath, 'file')
    if (fs.existsSync(stagedPath)) {
      if (!verifyRestoreFile(stagedPath, entry)) {
        throw new Error(`Asset library restore stage failed verification: ${entry.target}`)
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      assertUnlinkedPath(targetPath, 'file')
      fs.renameSync(stagedPath, targetPath)
    }
    if (!verifyRestoreFile(targetPath, entry)) {
      throw new Error(`Asset library restore target failed verification: ${entry.target}`)
    }
  }
  assertUnlinkedPath(path.join(sourceDirectory, RESTORE_JOURNAL), 'file')
  fs.rmSync(path.join(sourceDirectory, RESTORE_JOURNAL), { force: true })
  return true
}

function preflightRestoreEntries(directory: string, entries: AssetLibraryRestoreEntry[]): void {
  for (const entry of entries) {
    const targetPath = path.join(directory, entry.target)
    assertUnlinkedPath(targetPath, 'file')
    if (entry.operation === 'delete') continue
    const stagedPath = path.join(directory, entry.staged as string)
    assertUnlinkedPath(stagedPath, 'file')
    const candidate = fs.existsSync(stagedPath) ? stagedPath : targetPath
    if (!verifyRestoreFile(candidate, entry)) {
      throw new Error(`Asset library restore file failed verification: ${entry.target}`)
    }
  }
}

async function writeRestoreJournal(
  assetLibraryDir: string,
  journal: AssetLibraryRestoreJournal,
): Promise<void> {
  const finalPath = path.join(assetLibraryDir, RESTORE_JOURNAL)
  const temporaryPath = `${finalPath}.tmp`
  assertUnlinkedPath(finalPath, 'file')
  assertUnlinkedPath(temporaryPath, 'file')
  preflightRestoreEntries(assetLibraryDir, journal.entries)
  await fs.promises.rm(temporaryPath, { force: true })
  try {
    const handle = await fs.promises.open(temporaryPath, 'wx')
    try {
      await handle.writeFile(JSON.stringify(journal), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    assertUnlinkedPath(finalPath, 'file')
    await fs.promises.rename(temporaryPath, finalPath)
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

export async function restoreAssetLibraryBackup(
  assetLibraryDir: string,
  backupId: string,
): Promise<AssetLibraryRestoreResult> {
  const sourceDirectory = path.resolve(assetLibraryDir)
  const directory = backupDirectory(sourceDirectory, backupId)
  recoverAssetLibraryRestore(sourceDirectory)
  const verification = await verifyAssetLibraryBackup(directory)
  if (!verification.ok) throw new Error(verification.error || 'Backup verification failed')
  const manifest = await readManifest(directory)
  if (!manifest) throw new Error('Invalid asset library backup manifest')
  if (!manifest.files.some((file) => slashPath(file.path) === 'assets.jsonl')) {
    throw new Error('Backup does not contain the asset metadata index')
  }

  assertUnlinkedPath(sourceDirectory, 'directory')
  await fs.promises.mkdir(sourceDirectory, { recursive: true })
  const currentFiles = await listMetadataFiles(sourceDirectory)
  const backupTargets = new Set(manifest.files.map((file) => slashPath(path.normalize(file.path))))
  const restoreId = crypto.randomBytes(16).toString('hex')
  const entries: AssetLibraryRestoreEntry[] = []
  const stagedPaths: string[] = []
  try {
    for (const [index, file] of manifest.files.entries()) {
      assertUnlinkedPath(path.join(sourceDirectory, file.path), 'file')
      const staged = `${RESTORE_STAGE_PREFIX}${restoreId}-${index}`
      const stagedPath = path.join(sourceDirectory, staged)
      let copied: AssetLibraryBackupFile
      try {
        copied = await copyFileWithHash(path.join(directory, file.path), stagedPath)
      } catch (error) {
        await fs.promises.rm(stagedPath, { force: true }).catch(() => {})
        throw error
      }
      if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) {
        throw new Error(`Backup changed while preparing restore: ${file.path}`)
      }
      stagedPaths.push(stagedPath)
      entries.push({
        operation: 'replace',
        target: slashPath(path.normalize(file.path)),
        staged,
        bytes: file.bytes,
        sha256: file.sha256,
      })
    }
    for (const relativePath of currentFiles) {
      const target = slashPath(path.normalize(relativePath))
      if (!backupTargets.has(target)) entries.push({ operation: 'delete', target })
    }
    for (const target of DERIVED_CATALOG_FILES) {
      entries.push({ operation: 'delete', target })
    }
    await writeRestoreJournal(sourceDirectory, {
      version: RESTORE_VERSION,
      id: restoreId,
      backupId: normalizeAssetLibraryBackupId(backupId),
      createdAt: Date.now(),
      entries,
    })
  } catch (error) {
    await Promise.all(stagedPaths.map((filePath) => fs.promises.rm(filePath, { force: true })))
    throw error
  }

  recoverAssetLibraryRestore(sourceDirectory)
  return {
    restoredFiles: manifest.files.length,
    deletedFiles: entries.filter((entry) => entry.operation === 'delete').length,
  }
}

export interface AssetLibraryBackupExportResult {
  path: string
}

export interface AssetLibraryBackupImportResult {
  backupId: string
  path: string
}

interface SecureBackupFile {
  path: string
  encryptedFile: string
  bytes: number
  sha256: string
  iv: string
  tag: string
}

interface SecureBackupManifest {
  version: typeof LEGACY_SECURE_EXPORT_VERSION | typeof SECURE_EXPORT_VERSION
  backupId: string
  kdf: { algorithm: 'scrypt'; salt: string; N: number; r: number; p: number }
  cipher: 'aes-256-gcm'
  files: SecureBackupFile[]
  totalBytes: number
}

function validateBackupPassphrase(passphrase: string): void {
  const bytes = Buffer.byteLength(passphrase, 'utf8')
  if (passphrase.length < 12 || passphrase.length > 256 || bytes > 1_024) {
    throw new Error('Backup passphrase must contain 12 to 256 characters')
  }
}

function deriveBackupKey(
  passphrase: string,
  salt: Buffer,
  kdf: Pick<SecureBackupManifest['kdf'], 'N' | 'r' | 'p'>,
): Promise<Buffer> {
  const maxmem = kdf.N === SECURE_KDF_V2.N ? SECURE_KDF_V2.maxmem : SECURE_KDF_V1.maxmem
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

function secureBackupFilePath(relativePath: string): string {
  return `${crypto.createHash('sha256').update(relativePath, 'utf8').digest('hex')}.enc`
}

async function encryptBackupFile(
  source: string,
  target: string,
  key: Buffer,
  context: {
    version: SecureBackupManifest['version']
    backupId: string
    path: string
    encryptedFile: string
  },
): Promise<{ bytes: number; sha256: string; iv: string; tag: string }> {
  assertUnlinkedPath(target, 'file')
  const actual = await hashFile(source)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  if (context.version >= 2) {
    cipher.setAAD(
      secureBackupFileAad({
        ...context,
        bytes: actual.bytes,
        sha256: actual.sha256,
      }),
    )
  }
  await pipeline(
    fs.createReadStream(source),
    cipher,
    fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }),
  )
  return {
    ...actual,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

function secureBackupFileAad(
  file: Pick<SecureBackupFile, 'path' | 'encryptedFile' | 'bytes' | 'sha256'> & {
    version: SecureBackupManifest['version']
    backupId: string
  },
): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: file.version,
      backupId: file.backupId,
      path: file.path,
      encryptedFile: file.encryptedFile,
      bytes: file.bytes,
      sha256: file.sha256,
    }),
    'utf8',
  )
}

function validSecureBackupFile(value: unknown): value is SecureBackupFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<SecureBackupFile>
  return (
    typeof file.path === 'string' &&
    (file.path === 'manifest.json' || isManagedMetadataPath(file.path)) &&
    typeof file.encryptedFile === 'string' &&
    /^[a-f\d]{64}\.enc$/i.test(file.encryptedFile) &&
    Number.isSafeInteger(file.bytes) &&
    Number(file.bytes) >= 0 &&
    typeof file.sha256 === 'string' &&
    /^[a-f\d]{64}$/i.test(file.sha256) &&
    typeof file.iv === 'string' &&
    Buffer.from(file.iv, 'base64').length === 12 &&
    typeof file.tag === 'string' &&
    Buffer.from(file.tag, 'base64').length === 16
  )
}

async function readSecureBackupManifest(directory: string): Promise<SecureBackupManifest> {
  const manifestPath = path.join(directory, SECURE_EXPORT_MANIFEST)
  assertUnlinkedPath(manifestPath, 'file')
  const stat = await fs.promises.lstat(manifestPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error('Invalid encrypted backup manifest')
  }
  const parsed = JSON.parse(
    await fs.promises.readFile(manifestPath, 'utf8'),
  ) as Partial<SecureBackupManifest>
  const supportedVersion =
    parsed.version === LEGACY_SECURE_EXPORT_VERSION || parsed.version === SECURE_EXPORT_VERSION
  const expectedKdf =
    parsed.version === LEGACY_SECURE_EXPORT_VERSION ? SECURE_KDF_V1 : SECURE_KDF_V2
  if (
    !supportedVersion ||
    typeof parsed.backupId !== 'string' ||
    parsed.cipher !== 'aes-256-gcm' ||
    parsed.kdf?.algorithm !== 'scrypt' ||
    parsed.kdf.N !== expectedKdf.N ||
    parsed.kdf.r !== expectedKdf.r ||
    parsed.kdf.p !== expectedKdf.p ||
    Buffer.from(parsed.kdf.salt || '', 'base64').length !== 16 ||
    !Array.isArray(parsed.files) ||
    parsed.files.length < 2 ||
    parsed.files.length > MAX_BACKUP_FILES + 1 ||
    !parsed.files.every(validSecureBackupFile) ||
    !Number.isSafeInteger(parsed.totalBytes) ||
    Number(parsed.totalBytes) < 0 ||
    Number(parsed.totalBytes) > SECURE_EXPORT_MAX_BYTES
  ) {
    throw new Error('Invalid encrypted backup manifest')
  }
  normalizeAssetLibraryBackupId(parsed.backupId)
  const paths = new Set(parsed.files.map((file) => file.path.toLowerCase()))
  const encryptedFiles = new Set(parsed.files.map((file) => file.encryptedFile.toLowerCase()))
  const totalBytes = parsed.files.reduce((sum, file) => sum + file.bytes, 0)
  if (
    paths.size !== parsed.files.length ||
    encryptedFiles.size !== parsed.files.length ||
    totalBytes !== parsed.totalBytes ||
    !paths.has('manifest.json')
  ) {
    throw new Error('Invalid encrypted backup file inventory')
  }
  return parsed as SecureBackupManifest
}

function managedBackupDirectory(backupRootDir: string, backupId: string): string {
  const root = path.resolve(backupRootDir)
  const directory = path.join(root, normalizeAssetLibraryBackupId(backupId))
  if (path.dirname(path.resolve(directory)) !== root) {
    throw new Error('Invalid asset library backup path')
  }
  return directory
}

async function copyDirectoryRecursively(source: string, target: string): Promise<void> {
  assertUnlinkedPath(source, 'directory')
  assertUnlinkedPath(target, 'directory')
  await fs.promises.mkdir(target, { recursive: false })
  const entries = await fs.promises.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to copy symbolic link: ${sourcePath}`)
    }
    if (entry.isDirectory()) {
      await copyDirectoryRecursively(sourcePath, targetPath)
    } else if (entry.isFile()) {
      assertUnlinkedPath(sourcePath, 'file')
      assertUnlinkedPath(targetPath, 'file')
      await fs.promises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
    }
  }
}

async function pathExists(directory: string): Promise<boolean> {
  try {
    await fs.promises.lstat(directory)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
}

async function redactBackupManifestSource(directory: string): Promise<boolean> {
  const manifest = await readManifest(directory)
  if (!manifest || manifest.sourceDirectory === REDACTED_SOURCE_DIRECTORY) return false
  const verification = await verifyAssetLibraryBackup(directory)
  if (!verification.ok) return false
  const target = path.join(directory, 'manifest.json')
  const temporary = path.join(
    directory,
    `.manifest-redaction-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  )
  try {
    await fs.promises.writeFile(
      temporary,
      JSON.stringify({ ...manifest, sourceDirectory: REDACTED_SOURCE_DIRECTORY }, null, 2),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )
    await fs.promises.rename(temporary, target)
    return true
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {})
  }
}

/** Remove historical absolute source paths without touching backed-up metadata. */
export async function redactAssetLibraryBackupSources(assetLibraryDir: string): Promise<number> {
  const root = backupRoot(path.resolve(assetLibraryDir))
  let redacted = 0
  for (const directory of await listCompletedBackups(root)) {
    if (await redactBackupManifestSource(directory)) redacted += 1
  }
  return redacted
}

export async function exportAssetLibraryBackup(
  backupRootDir: string,
  backupId: string,
  targetParentDirectory: string,
): Promise<AssetLibraryBackupExportResult> {
  const sourceDirectory = managedBackupDirectory(backupRootDir, backupId)
  const verification = await verifyAssetLibraryBackup(sourceDirectory)
  if (!verification.ok) {
    throw new Error(
      `Refusing to export an invalid backup: ${verification.error || 'verification failed'}`,
    )
  }
  const parentDirectory = path.resolve(targetParentDirectory)
  assertUnlinkedPath(parentDirectory, 'directory')
  const parentStat = await fs.promises.lstat(parentDirectory).catch(() => null)
  if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('Export destination is not a directory')
  }
  const targetDirectory = path.join(parentDirectory, `${EXPORT_DIRECTORY_PREFIX}${backupId}`)
  if (await pathExists(targetDirectory)) {
    throw new Error('Export destination already exists')
  }
  try {
    await copyDirectoryRecursively(sourceDirectory, targetDirectory)
    await redactBackupManifestSource(targetDirectory)
    const exportedVerification = await verifyAssetLibraryBackup(targetDirectory)
    if (!exportedVerification.ok) {
      throw new Error(exportedVerification.error || 'Exported backup failed verification')
    }
  } catch (error) {
    await fs.promises.rm(targetDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return { path: targetDirectory }
}

export async function importAssetLibraryBackup(
  backupRootDir: string,
  sourceDirectory: string,
  now = Date.now(),
): Promise<AssetLibraryBackupImportResult> {
  const resolvedSource = path.resolve(sourceDirectory)
  const sourceStat = await fs.promises.lstat(resolvedSource).catch(() => null)
  if (!sourceStat || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('Import source is not a directory')
  }
  const sourceName = path.basename(resolvedSource)
  const baseId = sourceName.startsWith(EXPORT_DIRECTORY_PREFIX)
    ? sourceName.slice(EXPORT_DIRECTORY_PREFIX.length)
    : sourceName
  const backupId = normalizeAssetLibraryBackupId(baseId)
  const root = path.resolve(backupRootDir)
  if (path.dirname(resolvedSource) === root) {
    throw new Error('Backup is already in the asset library backup folder')
  }
  assertUnlinkedPath(root, 'directory')
  const verification = await verifyAssetLibraryBackup(resolvedSource)
  if (!verification.ok) {
    throw new Error(
      `Import source is not a valid backup: ${verification.error || 'verification failed'}`,
    )
  }
  await fs.promises.mkdir(root, { recursive: true })
  let finalId = backupId
  if (await pathExists(path.join(root, finalId))) {
    const suffix = `-imported-${now}`
    finalId = normalizeAssetLibraryBackupId(`${backupId.slice(0, 180 - suffix.length)}${suffix}`)
    if (await pathExists(path.join(root, finalId))) {
      throw new Error('An imported backup with the same id already exists')
    }
  }
  const targetDirectory = path.join(root, finalId)
  try {
    await copyDirectoryRecursively(resolvedSource, targetDirectory)
    const importedVerification = await verifyAssetLibraryBackup(targetDirectory)
    if (!importedVerification.ok) {
      throw new Error(importedVerification.error || 'Imported backup failed verification')
    }
  } catch (error) {
    await fs.promises.rm(targetDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return { backupId: finalId, path: targetDirectory }
}

export async function exportEncryptedAssetLibraryBackup(
  backupRootDir: string,
  backupId: string,
  targetParentDirectory: string,
  passphrase: string,
): Promise<AssetLibraryBackupExportResult> {
  validateBackupPassphrase(passphrase)
  const sourceDirectory = managedBackupDirectory(backupRootDir, backupId)
  const verification = await verifyAssetLibraryBackup(sourceDirectory)
  if (!verification.ok) throw new Error('Refusing to export an invalid backup')
  await redactBackupManifestSource(sourceDirectory)
  const manifest = await readManifest(sourceDirectory)
  if (!manifest) throw new Error('Backup manifest is unavailable')
  const parentDirectory = path.resolve(targetParentDirectory)
  assertUnlinkedPath(parentDirectory, 'directory')
  const parentStat = await fs.promises.lstat(parentDirectory).catch(() => null)
  if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('Export destination is not a directory')
  }
  const targetDirectory = path.join(parentDirectory, `${SECURE_EXPORT_PREFIX}${backupId}`)
  if (await pathExists(targetDirectory)) throw new Error('Export destination already exists')
  const salt = crypto.randomBytes(16)
  const key = await deriveBackupKey(passphrase, salt, SECURE_KDF_V2)
  try {
    await fs.promises.mkdir(targetDirectory, { recursive: false, mode: 0o700 })
    const relativeFiles = ['manifest.json', ...manifest.files.map((file) => file.path)]
    const files: SecureBackupFile[] = []
    for (const relativePath of relativeFiles) {
      const encryptedFile = secureBackupFilePath(relativePath)
      const encrypted = await encryptBackupFile(
        path.join(sourceDirectory, relativePath),
        path.join(targetDirectory, encryptedFile),
        key,
        {
          version: SECURE_EXPORT_VERSION,
          backupId,
          path: relativePath,
          encryptedFile,
        },
      )
      files.push({ path: relativePath, encryptedFile, ...encrypted })
    }
    const secureManifest: SecureBackupManifest = {
      version: SECURE_EXPORT_VERSION,
      backupId,
      kdf: {
        algorithm: 'scrypt',
        salt: salt.toString('base64'),
        N: SECURE_KDF_V2.N,
        r: SECURE_KDF_V2.r,
        p: SECURE_KDF_V2.p,
      },
      cipher: 'aes-256-gcm',
      files,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    }
    await fs.promises.writeFile(
      path.join(targetDirectory, SECURE_EXPORT_MANIFEST),
      JSON.stringify(secureManifest, null, 2),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )
    await readSecureBackupManifest(targetDirectory)
    return { path: targetDirectory }
  } catch (error) {
    await fs.promises.rm(targetDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  } finally {
    key.fill(0)
  }
}

export async function importEncryptedAssetLibraryBackup(
  backupRootDir: string,
  sourceDirectory: string,
  passphrase: string,
  now = Date.now(),
): Promise<AssetLibraryBackupImportResult> {
  validateBackupPassphrase(passphrase)
  const resolvedSource = path.resolve(sourceDirectory)
  const sourceStat = await fs.promises.lstat(resolvedSource).catch(() => null)
  if (!sourceStat || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('Import source is not a directory')
  }
  const secureManifest = await readSecureBackupManifest(resolvedSource)
  const root = path.resolve(backupRootDir)
  assertUnlinkedPath(root, 'directory')
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 })
  await cleanupStaleSecureImportDirectories(root)
  const temporaryRoot = await fs.promises.mkdtemp(
    path.join(path.dirname(root), SECURE_IMPORT_TEMP_PREFIX),
  )
  await fs.promises.chmod(temporaryRoot, 0o700)
  const decryptedDirectory = path.join(
    temporaryRoot,
    `${EXPORT_DIRECTORY_PREFIX}${secureManifest.backupId}`,
  )
  const key = await deriveBackupKey(
    passphrase,
    Buffer.from(secureManifest.kdf.salt, 'base64'),
    secureManifest.kdf,
  )
  try {
    await fs.promises.mkdir(decryptedDirectory, { recursive: false, mode: 0o700 })
    for (const file of secureManifest.files) {
      const encryptedPath = path.join(resolvedSource, file.encryptedFile)
      assertUnlinkedPath(encryptedPath, 'file')
      const encryptedStat = await fs.promises.lstat(encryptedPath)
      if (
        !encryptedStat.isFile() ||
        encryptedStat.isSymbolicLink() ||
        encryptedStat.size !== file.bytes
      ) {
        throw new Error('Encrypted backup file inventory changed')
      }
      const outputPath = path.join(decryptedDirectory, file.path)
      assertUnlinkedPath(outputPath, 'file')
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 })
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'))
      if (secureManifest.version >= 2) {
        decipher.setAAD(
          secureBackupFileAad({
            version: secureManifest.version,
            backupId: secureManifest.backupId,
            path: file.path,
            encryptedFile: file.encryptedFile,
            bytes: file.bytes,
            sha256: file.sha256,
          }),
        )
      }
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'))
      try {
        await pipeline(
          fs.createReadStream(encryptedPath),
          decipher,
          fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }),
        )
      } catch {
        throw new Error('Encrypted backup authentication failed')
      }
      const actual = await hashFile(outputPath)
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) {
        throw new Error('Decrypted backup file failed verification')
      }
    }
    const verification = await verifyAssetLibraryBackup(decryptedDirectory)
    if (!verification.ok) throw new Error('Decrypted backup failed verification')
    return await importAssetLibraryBackup(root, decryptedDirectory, now)
  } finally {
    key.fill(0)
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export async function cleanupStaleSecureImportDirectories(
  backupRootDir: string,
  now = Date.now(),
): Promise<number> {
  const root = path.resolve(backupRootDir)
  const parent = path.dirname(root)
  assertUnlinkedPath(parent, 'directory')
  const cutoff = now - SECURE_IMPORT_STALE_AGE_MS
  let removed = 0
  const entries = await fs.promises.readdir(parent, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.name.startsWith(SECURE_IMPORT_TEMP_PREFIX) || !entry.isDirectory()) continue
    const candidate = path.join(parent, entry.name)
    if (path.dirname(path.resolve(candidate)) !== parent) continue
    const stat = await fs.promises.lstat(candidate).catch(() => null)
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.mtimeMs > cutoff) continue
    await fs.promises.rm(candidate, { recursive: true, force: true })
    removed += 1
  }
  return removed
}

export async function deleteAssetLibraryBackup(
  backupRootDir: string,
  backupId: string,
): Promise<void> {
  const directory = managedBackupDirectory(backupRootDir, backupId)
  assertUnlinkedPath(directory, 'directory')
  const stat = await fs.promises.lstat(directory).catch(() => null)
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Asset library backup not found')
  }
  await fs.promises.rm(directory, { recursive: true, force: true })
}

export const assetLibraryBackupDefaults = {
  minimumIntervalMs: DEFAULT_MINIMUM_INTERVAL_MS,
  maxBackups: DEFAULT_MAX_BACKUPS,
} as const

export const assetLibraryRestoreFiles = {
  journal: RESTORE_JOURNAL,
  stagePrefix: RESTORE_STAGE_PREFIX,
} as const
