import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { THUMBNAIL_CACHE_VERSION, THUMBNAIL_DIMENSION_BUCKETS } from '../shared/thumbnailPolicy'

const THUMB_CACHE_MAX_MB = 1024
export const THUMB_CACHE_STARTUP_MAINTENANCE_DELAY_MS = 120_000
export const THUMB_CACHE_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000
const THUMB_CACHE_MAINTENANCE_STATE_VERSION = 1
const THUMB_CACHE_MAINTENANCE_STATE_FILE = 'thumbcache-maintenance.json'

interface ThumbCacheMaintenanceState {
  version: number
  completedAt: number
}

export interface ThumbCacheMaintenanceOptions {
  delayMs?: number
  minIntervalMs?: number
  now?: () => number
}

export interface ThumbCacheMaintenanceHandle {
  cancel(): void
}

export function getThumbCacheDir(userDataPath: string): string {
  const dir = path.join(userDataPath, 'thumbcache')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function cacheKeyForVersion(
  version: number,
  filePath: string,
  mtimeMs: number,
  maxDim: number,
): string {
  const versionedMtime = version >= 5 ? Math.floor(Number(mtimeMs) / 1000) * 1000 : Number(mtimeMs)
  return crypto
    .createHash('sha256')
    .update(`v${version}|${filePath}|${versionedMtime}|${maxDim}`)
    .digest('hex')
    .slice(0, 24)
}

export function cacheKey(filePath: string, mtimeMs: number, maxDim: number): string {
  return cacheKeyForVersion(THUMBNAIL_CACHE_VERSION, filePath, mtimeMs, maxDim)
}

export interface ThumbnailCacheSourceRecord {
  path: string
  mtimeMs: number
}

export interface ThumbnailCacheSourcePurgeProgress {
  phase: 'matching' | 'deleting'
  processed: number
  total: number
}

export interface ThumbnailCacheSourcePurgeOptions {
  concurrency?: number
  onProgress?: (progress: ThumbnailCacheSourcePurgeProgress) => void
}

export interface ThumbnailCacheFilePlan {
  filePath: string
  size: number
  mtimeMs: number
}

export interface ThumbnailCacheFolderPlan {
  sourcePath: string
  cacheDir: string
  cacheRealPath: string
  cacheDev: number
  cacheIno: number
  sourceFilesScanned: number
  files: ThumbnailCacheFilePlan[]
  complete: boolean
  warnings: string[]
}

const THUMBNAIL_SOURCE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.svg',
  '.avif',
  '.ico',
  '.tiff',
  '.tif',
  '.psd',
  '.psb',
  '.kra',
  '.pdf',
  '.ai',
  '.eps',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.raf',
  '.orf',
  '.rw2',
  '.pef',
  '.srw',
  '.clip',
  '.cdr',
  '.indd',
])
const THUMBNAIL_CACHE_FILE = /^[a-f0-9]{24}\.(?:jpg|png|webp|thumb)$/i
const MAX_SOURCE_FILES_FOR_SCOPED_THUMBNAIL_CLEANUP = 2_000_000
const MAX_SOURCE_DIRECTORIES_FOR_SCOPED_THUMBNAIL_CLEANUP = 500_000

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

interface ThumbnailCacheRootIdentity {
  cacheDir: string
  realPath: string
  dev: number
  ino: number
}

async function inspectThumbnailCacheRoot(
  userDataPath: string,
): Promise<ThumbnailCacheRootIdentity> {
  const userDataDir = path.resolve(userDataPath)
  const cacheDir = path.join(userDataDir, 'thumbcache')
  await fsp.mkdir(userDataDir, { recursive: true })
  await fsp.mkdir(cacheDir, { recursive: true })
  const userDataRealPath = await fsp.realpath(userDataDir)
  const before = await fsp.lstat(cacheDir)
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('Thumbnail cache directory is linked or is not a regular directory')
  }
  const realPath = await fsp.realpath(cacheDir)
  const after = await fsp.lstat(cacheDir)
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    realPath === userDataRealPath ||
    !isPathInside(userDataRealPath, realPath)
  ) {
    throw new Error('Thumbnail cache directory changed or escapes the managed user-data root')
  }
  return {
    cacheDir,
    realPath,
    dev: Number(after.dev) || 0,
    ino: Number(after.ino) || 0,
  }
}

async function assertThumbnailCacheRootUnchanged(
  identity: ThumbnailCacheRootIdentity,
): Promise<void> {
  const stat = await fsp.lstat(identity.cacheDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Thumbnail cache directory changed before deletion')
  }
  const realPath = await fsp.realpath(identity.cacheDir)
  if (
    realPath !== identity.realPath ||
    (identity.dev > 0 && Number(stat.dev) > 0 && identity.dev !== Number(stat.dev)) ||
    (identity.ino > 0 && Number(stat.ino) > 0 && identity.ino !== Number(stat.ino))
  ) {
    throw new Error('Thumbnail cache directory identity changed before deletion')
  }
}

/**
 * Builds an exact deletion plan for cache files derived from a source folder.
 * Only names and mtimes are inspected; source file contents are never read.
 * Indexed sources are included so missing files can still retire known cache
 * entries, while the bounded directory walk catches thumbnails for images that
 * failed before they reached the Native index.
 */
export async function previewThumbnailCacheForFolder(
  userDataPath: string,
  sourceFolder: string,
  indexedSources: readonly ThumbnailCacheSourceRecord[] = [],
): Promise<ThumbnailCacheFolderPlan> {
  const sourcePath = path.resolve(sourceFolder)
  const warnings: string[] = []
  const cacheRoot = await inspectThumbnailCacheRoot(userDataPath)
  const cacheDir = cacheRoot.cacheDir
  const empty = (): ThumbnailCacheFolderPlan => ({
    sourcePath,
    cacheDir,
    cacheRealPath: cacheRoot.realPath,
    cacheDev: cacheRoot.dev,
    cacheIno: cacheRoot.ino,
    sourceFilesScanned: 0,
    files: [],
    complete: true,
    warnings,
  })
  const sourceStat = await fsp.lstat(sourcePath)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('Thumbnail cleanup source must be a regular directory')
  }

  let cacheEntries: fs.Dirent[]
  try {
    cacheEntries = await fsp.readdir(cacheDir, { withFileTypes: true })
    await assertThumbnailCacheRootUnchanged(cacheRoot)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return empty()
    throw error
  }

  const available = new Map<string, ThumbnailCacheFilePlan>()
  for (const entry of cacheEntries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !THUMBNAIL_CACHE_FILE.test(entry.name)) {
      continue
    }
    const filePath = path.join(cacheDir, entry.name)
    try {
      const stat = await fsp.lstat(filePath)
      if (stat.isFile() && !stat.isSymbolicLink()) {
        available.set(entry.name.toLowerCase(), {
          filePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      }
    } catch {
      /* A concurrently retired cache entry is simply absent from this preview. */
    }
  }
  if (available.size === 0) return empty()

  const matched = new Map<string, ThumbnailCacheFilePlan>()
  const seenSources = new Set<string>()
  const matchSource = (filePath: string, mtimeMs: number): void => {
    if (!filePath || !Number.isFinite(mtimeMs)) return
    const resolved = path.resolve(filePath)
    if (!isPathInside(sourcePath, resolved)) return
    const sourceKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    const identity = `${sourceKey}\u001f${Number(mtimeMs)}`
    if (seenSources.has(identity)) return
    seenSources.add(identity)
    for (let version = 1; version <= THUMBNAIL_CACHE_VERSION; version += 1) {
      for (const dimension of THUMBNAIL_DIMENSION_BUCKETS) {
        const key = cacheKeyForVersion(version, filePath, mtimeMs, dimension)
        for (const extension of ['.jpg', '.png', '.webp', '.thumb']) {
          const plan = available.get(`${key}${extension}`)
          if (plan) matched.set(plan.filePath, plan)
        }
      }
    }
  }

  for (const source of indexedSources) matchSource(source.path, source.mtimeMs)

  const directories = [sourcePath]
  let sourceFilesScanned = 0
  let directoriesScanned = 0
  let complete = true
  while (directories.length > 0) {
    if (directoriesScanned >= MAX_SOURCE_DIRECTORIES_FOR_SCOPED_THUMBNAIL_CLEANUP) {
      complete = false
      warnings.push('Thumbnail source scan reached its directory safety limit')
      break
    }
    const directory = directories.pop()!
    directoriesScanned += 1
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true })
    } catch (error: unknown) {
      complete = false
      warnings.push(
        `Could not inspect thumbnail source folder ${path.basename(directory)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        directories.push(target)
        continue
      }
      if (
        !entry.isFile() ||
        !THUMBNAIL_SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        continue
      }
      if (sourceFilesScanned >= MAX_SOURCE_FILES_FOR_SCOPED_THUMBNAIL_CLEANUP) {
        complete = false
        warnings.push('Thumbnail source scan reached its file safety limit')
        directories.length = 0
        break
      }
      sourceFilesScanned += 1
      try {
        const stat = await fsp.lstat(target)
        if (stat.isFile() && !stat.isSymbolicLink()) matchSource(target, stat.mtimeMs)
      } catch {
        /* A changing source file cannot be attributed safely and is preserved. */
      }
      if (sourceFilesScanned % 1000 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  }

  return {
    sourcePath,
    cacheDir,
    cacheRealPath: cacheRoot.realPath,
    cacheDev: cacheRoot.dev,
    cacheIno: cacheRoot.ino,
    sourceFilesScanned,
    files: [...matched.values()].sort((left, right) => left.filePath.localeCompare(right.filePath)),
    complete,
    warnings,
  }
}

export async function purgeThumbnailCachePlan(
  plan: ThumbnailCacheFolderPlan,
): Promise<{ deletedFiles: number; freedBytes: number; warnings: string[] }> {
  let deletedFiles = 0
  let freedBytes = 0
  const warnings = [...plan.warnings]
  const cacheRoot: ThumbnailCacheRootIdentity = {
    cacheDir: plan.cacheDir,
    realPath: plan.cacheRealPath,
    dev: plan.cacheDev,
    ino: plan.cacheIno,
  }
  for (const candidate of plan.files) {
    if (!isPathInside(plan.cacheDir, candidate.filePath)) {
      warnings.push('Skipped thumbnail cache entry outside the managed cache directory')
      continue
    }
    try {
      await assertThumbnailCacheRootUnchanged(cacheRoot)
    } catch (error) {
      warnings.push(
        `Thumbnail cache cleanup stopped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      break
    }
    try {
      const stat = await fsp.lstat(candidate.filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      if (stat.size !== candidate.size || stat.mtimeMs !== candidate.mtimeMs) {
        warnings.push(
          `Thumbnail cache entry changed after preview: ${path.basename(candidate.filePath)}`,
        )
        continue
      }
      await assertThumbnailCacheRootUnchanged(cacheRoot)
      await fsp.unlink(candidate.filePath)
      deletedFiles += 1
      freedBytes += stat.size
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        warnings.push(
          `Could not remove thumbnail cache entry: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }
  return { deletedFiles, freedBytes, warnings }
}

/**
 * Removes only cache entries whose source path and indexed mtime are known.
 * The cache filename is intentionally one-way hashed, so the authoritative
 * Native index snapshot supplies the source identity instead of walking or
 * touching the selected source directory.
 */
export async function purgeThumbnailCacheForSources(
  userDataPath: string,
  sources: readonly ThumbnailCacheSourceRecord[],
  options: ThumbnailCacheSourcePurgeOptions = {},
): Promise<{ deletedFiles: number; freedBytes: number; warnings: string[] }> {
  const warnings: string[] = []
  let cacheRoot: ThumbnailCacheRootIdentity
  try {
    cacheRoot = await inspectThumbnailCacheRoot(userDataPath)
  } catch (error) {
    return {
      deletedFiles: 0,
      freedBytes: 0,
      warnings: [
        `Thumbnail cache cleanup was blocked: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    }
  }
  const cacheDir = cacheRoot.cacheDir
  let cacheEntries: fs.Dirent[]
  try {
    cacheEntries = await fsp.readdir(cacheDir, { withFileTypes: true })
    await assertThumbnailCacheRootUnchanged(cacheRoot)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { deletedFiles: 0, freedBytes: 0, warnings }
    }
    return {
      deletedFiles: 0,
      freedBytes: 0,
      warnings: [
        `Could not inspect the thumbnail cache: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    }
  }
  const cacheFilesByKey = new Map<string, string[]>()
  for (const entry of cacheEntries) {
    if (!entry.isFile()) continue
    const extension = path.extname(entry.name).toLowerCase()
    if (!['.jpg', '.png', '.webp', '.thumb'].includes(extension)) continue
    const key = entry.name.slice(0, -extension.length).toLowerCase()
    if (!/^[a-f0-9]{24}$/.test(key)) continue
    const files = cacheFilesByKey.get(key) || []
    files.push(path.join(cacheDir, entry.name))
    cacheFilesByKey.set(key, files)
  }
  if (cacheFilesByKey.size === 0) {
    options.onProgress?.({ phase: 'matching', processed: sources.length, total: sources.length })
    return { deletedFiles: 0, freedBytes: 0, warnings }
  }

  const candidates = new Set<string>()
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex]
    if (source.path && Number.isFinite(source.mtimeMs)) {
      for (let version = 1; version <= THUMBNAIL_CACHE_VERSION; version += 1) {
        for (const dimension of THUMBNAIL_DIMENSION_BUCKETS) {
          const key = cacheKeyForVersion(version, source.path, source.mtimeMs, dimension)
          for (const candidate of cacheFilesByKey.get(key) || []) candidates.add(candidate)
        }
      }
    }
    const processed = sourceIndex + 1
    if (processed % 128 === 0 || processed === sources.length) {
      options.onProgress?.({ phase: 'matching', processed, total: sources.length })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  let deletedFiles = 0
  let freedBytes = 0
  const candidateFiles = [...candidates]
  let cursor = 0
  let processedFiles = 0
  let suppressedWarnings = 0
  let rootInvalidated = false
  const concurrency = Math.max(1, Math.min(32, Math.floor(options.concurrency || 16)))
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, candidateFiles.length)) },
    async () => {
      for (;;) {
        const candidateIndex = cursor++
        if (candidateIndex >= candidateFiles.length) return
        const candidate = candidateFiles[candidateIndex]
        try {
          if (rootInvalidated) continue
          try {
            await assertThumbnailCacheRootUnchanged(cacheRoot)
          } catch (error) {
            rootInvalidated = true
            if (warnings.length < 20) {
              warnings.push(
                `Thumbnail cache cleanup stopped: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              )
            } else {
              suppressedWarnings += 1
            }
            continue
          }
          const stat = await fsp.lstat(candidate)
          if (!stat.isFile() || stat.isSymbolicLink()) continue
          await assertThumbnailCacheRootUnchanged(cacheRoot)
          await fsp.unlink(candidate)
          deletedFiles += 1
          freedBytes += stat.size
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            if (warnings.length < 20) {
              warnings.push(
                `Could not remove thumbnail cache entry: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              )
            } else {
              suppressedWarnings += 1
            }
          }
        } finally {
          processedFiles += 1
          if (processedFiles % 32 === 0 || processedFiles === candidateFiles.length) {
            options.onProgress?.({
              phase: 'deleting',
              processed: processedFiles,
              total: candidateFiles.length,
            })
          }
        }
      }
    },
  )
  await Promise.all(workers)
  if (suppressedWarnings > 0) {
    warnings.push(`Suppressed ${suppressedWarnings} additional thumbnail cache removal warnings`)
  }
  return { deletedFiles, freedBytes, warnings }
}

export function thumbCacheGet(
  userDataPath: string,
  filePath: string,
  mtimeMs: number,
  maxDim: number,
): string | null {
  const dimensions =
    maxDim >= 64 ? [maxDim, ...[64, 128, 256].filter((dimension) => dimension > maxDim)] : [maxDim]
  for (const dimension of dimensions) {
    try {
      const dir = getThumbCacheDir(userDataPath)
      const key = cacheKey(filePath, mtimeMs, dimension)
      const binaryCandidates = [
        { extension: '.jpg', mime: 'image/jpeg' },
        { extension: '.png', mime: 'image/png' },
        { extension: '.webp', mime: 'image/webp' },
      ]
      for (const candidate of binaryCandidates) {
        const binaryPath = path.join(dir, key + candidate.extension)
        if (!fs.existsSync(binaryPath)) continue
        fs.utimesSync(binaryPath, new Date(), new Date())
        return `data:${candidate.mime};base64,${fs.readFileSync(binaryPath).toString('base64')}`
      }
      const textPath = path.join(dir, key + '.thumb')
      if (fs.existsSync(textPath)) {
        fs.utimesSync(textPath, new Date(), new Date())
        return fs.readFileSync(textPath, 'utf-8')
      }
      const legacyPath = path.join(
        dir,
        cacheKeyForVersion(4, filePath, mtimeMs, dimension) + '.thumb',
      )
      if (fs.existsSync(legacyPath)) {
        fs.utimesSync(legacyPath, new Date(), new Date())
        return fs.readFileSync(legacyPath, 'utf-8')
      }
    } catch {
      // A cache read failure behaves like a miss.
    }
  }
  return null
}

export function thumbCacheSet(
  userDataPath: string,
  filePath: string,
  mtimeMs: number,
  maxDim: number,
  dataUrl: string,
): void {
  try {
    const destination = path.join(
      getThumbCacheDir(userDataPath),
      cacheKey(filePath, mtimeMs, maxDim) + '.thumb',
    )
    fs.writeFileSync(destination, dataUrl, 'utf-8')
  } catch {
    // Cache writes are best effort.
  }
}

export type ThumbnailCacheSink = (
  filePath: string,
  mtimeMs: number,
  maxDim: number,
  dataUrl: string,
) => Promise<void>

export async function storeThumbnailCache(
  userDataPath: string,
  filePath: string,
  mtimeMs: number,
  maxDim: number,
  dataUrl: string,
  cacheSink?: ThumbnailCacheSink,
): Promise<void> {
  if (cacheSink) {
    await cacheSink(filePath, mtimeMs, maxDim, dataUrl)
    return
  }
  thumbCacheSet(userDataPath, filePath, mtimeMs, maxDim, dataUrl)
}

function maintenanceStatePath(userDataPath: string): string {
  return path.join(userDataPath, THUMB_CACHE_MAINTENANCE_STATE_FILE)
}

async function readMaintenanceState(
  userDataPath: string,
): Promise<ThumbCacheMaintenanceState | null> {
  try {
    const raw = await fsp.readFile(maintenanceStatePath(userDataPath), 'utf8')
    const parsed = JSON.parse(raw) as Partial<ThumbCacheMaintenanceState>
    if (
      parsed.version !== THUMB_CACHE_MAINTENANCE_STATE_VERSION ||
      !Number.isFinite(parsed.completedAt) ||
      Number(parsed.completedAt) <= 0
    ) {
      return null
    }
    return {
      version: THUMB_CACHE_MAINTENANCE_STATE_VERSION,
      completedAt: Number(parsed.completedAt),
    }
  } catch {
    return null
  }
}

async function writeMaintenanceState(userDataPath: string, completedAt: number): Promise<void> {
  const destination = maintenanceStatePath(userDataPath)
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  try {
    await fsp.mkdir(userDataPath, { recursive: true })
    await fsp.writeFile(
      temporary,
      JSON.stringify({ version: THUMB_CACHE_MAINTENANCE_STATE_VERSION, completedAt }),
      'utf8',
    )
    await fsp.rename(temporary, destination)
  } catch {
    await fsp.unlink(temporary).catch(() => {})
  }
}

async function performThumbCacheEviction(
  userDataPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    if (signal?.aborted) return false
    try {
      const userDataEntries = await fsp.readdir(userDataPath, { withFileTypes: true })
      for (const entry of userDataEntries) {
        if (entry.isDirectory() && entry.name.startsWith('.thumbcache-retired-')) {
          const retiredDir = path.join(userDataPath, entry.name)
          void fsp.rm(retiredDir, { recursive: true, force: true }).catch((error) => {
            console.warn('[Thumbnail] Retired cache cleanup retry failed:', retiredDir, error)
          })
        }
      }
    } catch {
      // The user-data directory may not exist on first launch.
    }
    const dir = getThumbCacheDir(userDataPath)
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
    const stats: Array<{ name: string; atimeMs: number; size: number }> = []
    const statConcurrency = 16
    for (let offset = 0; offset < files.length; offset += statConcurrency) {
      if (signal?.aborted) return false
      const batch = files.slice(offset, offset + statConcurrency)
      const results = await Promise.all(
        batch.map(async (name) => {
          try {
            const stat = await fsp.stat(path.join(dir, name))
            return { name, atimeMs: stat.atimeMs, size: stat.size }
          } catch {
            return null
          }
        }),
      )
      for (const result of results) if (result) stats.push(result)
    }
    stats.sort((a, b) => a.atimeMs - b.atimeMs)
    let total = stats.reduce((sum, file) => sum + file.size, 0)
    const limit = THUMB_CACHE_MAX_MB * 1024 * 1024
    for (const file of stats) {
      if (signal?.aborted) return false
      if (total <= limit) break
      await fsp.unlink(path.join(dir, file.name)).catch(() => {})
      total -= file.size
    }
    return true
  } catch {
    // Cache eviction is best effort.
    return false
  }
}

export async function evictThumbCache(userDataPath: string): Promise<void> {
  if (await performThumbCacheEviction(userDataPath)) {
    await writeMaintenanceState(userDataPath, Date.now())
  }
}

export async function runThumbCacheMaintenanceIfDue(
  userDataPath: string,
  options: Omit<ThumbCacheMaintenanceOptions, 'delayMs'> = {},
  signal?: AbortSignal,
): Promise<boolean> {
  const now = options.now?.() ?? Date.now()
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? THUMB_CACHE_MAINTENANCE_INTERVAL_MS)
  const state = await readMaintenanceState(userDataPath)
  if (
    state &&
    state.completedAt <= now + minIntervalMs &&
    now - state.completedAt < minIntervalMs
  ) {
    return false
  }
  if (!(await performThumbCacheEviction(userDataPath, signal))) return false
  await writeMaintenanceState(userDataPath, now)
  return true
}

export function scheduleThumbCacheMaintenance(
  userDataPath: string,
  options: ThumbCacheMaintenanceOptions = {},
): ThumbCacheMaintenanceHandle {
  const controller = new AbortController()
  const delayMs = Math.max(0, options.delayMs ?? THUMB_CACHE_STARTUP_MAINTENANCE_DELAY_MS)
  let timer: NodeJS.Timeout | null = setTimeout(() => {
    timer = null
    void runThumbCacheMaintenanceIfDue(userDataPath, options, controller.signal)
  }, delayMs)
  timer.unref()
  return {
    cancel() {
      controller.abort()
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
