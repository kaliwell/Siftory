import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { MediaSearchCacheStats, MediaSearchClearCacheResult } from '../shared/ipc-contract'
import { getEmbeddingStorePaths } from './vectorDatabaseService'

let mediaSearchDir = ''
let loggedMediaSearchDir = false
let mediaCacheStatsCache: { value: MediaSearchCacheStats; updatedAt: number } | null = null
let mediaCacheStatsGeneration = 0
let mediaCacheStatsPromise: {
  cacheDir: string
  promise: Promise<MediaSearchCacheStats>
} | null = null
const MEDIA_CACHE_STATS_TTL_MS = 10_000
const MEDIA_CACHE_STAT_CONCURRENCY = 32
const MEDIA_CACHE_DIRECTORY_CONCURRENCY = 8

function getManifestByteSize(dir: string): number {
  const manifest = path.join(dir, 'manifests', 'video_files.jsonl')
  try {
    return fs.statSync(manifest).size
  } catch {
    return 0
  }
}

function resolveDefaultMediaSearchDir(): string {
  const override =
    process.env.SIFTORY_MEDIA_SEARCH_DIR?.trim() ||
    process.env.FLOATING_CLOCK_MEDIA_SEARCH_DIR?.trim()
  if (override) return path.resolve(override)

  const stableDir = path.join(app.getPath('appData'), 'floating-clock-electron', 'media-search')
  const userDataDir = path.join(app.getPath('userData'), 'media-search')
  const candidates = Array.from(new Set([stableDir, userDataDir].map((dir) => path.resolve(dir))))

  // Keep Media Search data stable across dev/package app names. If one candidate
  // already has scanned videos, use it; otherwise default to the package-name dir.
  let best = path.resolve(stableDir)
  let bestSize = -1
  for (const candidate of candidates) {
    const size = getManifestByteSize(candidate)
    if (size > bestSize) {
      best = candidate
      bestSize = size
    }
  }
  return best
}

export function getMediaSearchDir(): string {
  if (!mediaSearchDir) {
    mediaSearchDir = resolveDefaultMediaSearchDir()
  }
  if (!loggedMediaSearchDir) {
    loggedMediaSearchDir = true
    console.log('[MediaSearch] local data directory initialized')
  }
  return mediaSearchDir
}

export function setMediaSearchDirForTests(dir: string): void {
  mediaSearchDir = dir
  invalidateMediaCacheStats()
}

export function ensureMediaSearchDirs(): void {
  for (const name of [
    'manifests',
    'vectors',
    'thumbnails',
    'frames',
    'transcripts',
    'ocr',
    'temp',
    'stats',
  ]) {
    fs.mkdirSync(path.join(getMediaSearchDir(), name), { recursive: true })
  }
}

interface MediaCacheByteTotals {
  totalBytes: number
  manifestBytes: number
  thumbnailBytes: number
  frameBytes: number
  vectorBytes: number
  tempBytes: number
}

function emptyMediaCacheByteTotals(): MediaCacheByteTotals {
  return {
    totalBytes: 0,
    manifestBytes: 0,
    thumbnailBytes: 0,
    frameBytes: 0,
    vectorBytes: 0,
    tempBytes: 0,
  }
}

function addMediaCacheFileBytes(
  totals: MediaCacheByteTotals,
  cacheDir: string,
  filePath: string,
  size: number,
): void {
  totals.totalBytes += size
  const topLevel = path.relative(cacheDir, filePath).split(path.sep)[0]?.toLowerCase()
  if (topLevel === 'manifests') totals.manifestBytes += size
  else if (topLevel === 'thumbnails') totals.thumbnailBytes += size
  else if (topLevel === 'frames') totals.frameBytes += size
  else if (topLevel === 'vectors') totals.vectorBytes += size
  else if (topLevel === 'temp') totals.tempBytes += size
}

/** One-pass fallback for destructive operations that already run on the main thread. */
function scanMediaCacheBytesSync(cacheDir: string): MediaCacheByteTotals {
  const totals = emptyMediaCacheByteTotals()
  const directories = [cacheDir]
  while (directories.length > 0) {
    const directory = directories.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) directories.push(target)
      else if (entry.isFile()) {
        try {
          addMediaCacheFileBytes(totals, cacheDir, target, fs.statSync(target).size)
        } catch {
          /* The file may disappear while a cleanup task is running. */
        }
      }
    }
  }
  return totals
}

/**
 * Cooperative inventory used by renderer IPC. Directory reads and file stats
 * are bounded and asynchronous so a large frame library cannot freeze every
 * Electron IPC handler for several seconds.
 */
async function scanMediaCacheBytes(cacheDir: string): Promise<MediaCacheByteTotals> {
  const totals = emptyMediaCacheByteTotals()
  const directories = [cacheDir]
  while (directories.length > 0) {
    const directoryBatch = directories.splice(-MEDIA_CACHE_DIRECTORY_CONCURRENCY)
    const batches = await Promise.all(
      directoryBatch.map(async (directory) => {
        try {
          return {
            directory,
            entries: await fs.promises.readdir(directory, { withFileTypes: true }),
          }
        } catch {
          return { directory, entries: [] as fs.Dirent[] }
        }
      }),
    )
    const files: string[] = []
    for (const { directory, entries } of batches) {
      for (const entry of entries) {
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) directories.push(target)
        else if (entry.isFile()) files.push(target)
      }
    }
    for (let offset = 0; offset < files.length; offset += MEDIA_CACHE_STAT_CONCURRENCY) {
      const fileBatch = files.slice(offset, offset + MEDIA_CACHE_STAT_CONCURRENCY)
      const sizes = await Promise.all(
        fileBatch.map(async (filePath) => {
          try {
            return (await fs.promises.stat(filePath)).size
          } catch {
            return 0
          }
        }),
      )
      for (let index = 0; index < fileBatch.length; index += 1) {
        addMediaCacheFileBytes(totals, cacheDir, fileBatch[index], sizes[index])
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return totals
}

export function getMediaCacheStats(options: { force?: boolean } = {}): MediaSearchCacheStats {
  ensureMediaSearchDirs()
  if (
    !options.force &&
    mediaCacheStatsCache &&
    Date.now() - mediaCacheStatsCache.updatedAt < MEDIA_CACHE_STATS_TTL_MS
  ) {
    return mediaCacheStatsCache.value
  }
  const cacheDir = getMediaSearchDir()
  const totals = scanMediaCacheBytesSync(cacheDir)
  const value = {
    cacheDir,
    ...totals,
  }
  mediaCacheStatsCache = { value, updatedAt: Date.now() }
  return value
}

export function invalidateMediaCacheStats(): void {
  mediaCacheStatsCache = null
  mediaCacheStatsGeneration += 1
}

export async function getMediaCacheStatsAsync(
  options: { force?: boolean } = {},
): Promise<MediaSearchCacheStats> {
  ensureMediaSearchDirs()
  if (
    !options.force &&
    mediaCacheStatsCache &&
    Date.now() - mediaCacheStatsCache.updatedAt < MEDIA_CACHE_STATS_TTL_MS
  ) {
    return mediaCacheStatsCache.value
  }
  const cacheDir = path.resolve(getMediaSearchDir())
  if (mediaCacheStatsPromise?.cacheDir === cacheDir) return mediaCacheStatsPromise.promise

  const generation = mediaCacheStatsGeneration
  const promise = scanMediaCacheBytes(cacheDir).then((totals) => {
    const value: MediaSearchCacheStats = { cacheDir, ...totals }
    if (
      generation === mediaCacheStatsGeneration &&
      path.resolve(getMediaSearchDir()) === cacheDir
    ) {
      mediaCacheStatsCache = { value, updatedAt: Date.now() }
    }
    return value
  })
  mediaCacheStatsPromise = { cacheDir, promise }
  try {
    return await promise
  } finally {
    if (mediaCacheStatsPromise?.promise === promise) mediaCacheStatsPromise = null
  }
}

export function clearMediaSearchCache(): MediaSearchClearCacheResult {
  ensureMediaSearchDirs()
  const cacheDir = path.resolve(getMediaSearchDir())
  const before = getMediaCacheStats({ force: true })
  // Keep manifests, extracted frames, frame vectors, and transcripts. They are searchable data,
  // not disposable UI cache, and rebuilding them can be expensive.
  const clearableDirs = ['thumbnails', 'ocr', 'temp']
  let deletedEntries = 0

  for (const name of clearableDirs) {
    const target = path.resolve(cacheDir, name)
    if (target === cacheDir || !target.startsWith(`${cacheDir}${path.sep}`)) {
      return { ok: false, deletedEntries, freedBytes: 0, error: 'Unsafe cache path' }
    }
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true })
        deletedEntries += 1
      }
      fs.mkdirSync(target, { recursive: true })
    } catch (err) {
      return {
        ok: false,
        deletedEntries,
        freedBytes: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  invalidateMediaCacheStats()
  const after = getMediaCacheStats({ force: true })
  return {
    ok: true,
    deletedEntries,
    freedBytes: Math.max(0, before.totalBytes - after.totalBytes),
    stats: after,
  }
}

function normalizePathKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function compactFrameEmbeddingStore(filePath: string, frameRootKey: string): number {
  if (!fs.existsSync(filePath)) return 0
  const tmp = `${filePath}.tmp`
  let removed = 0
  let output = ''
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
  for (const line of lines) {
    if (!line) continue
    let keep = true
    try {
      const row = JSON.parse(line) as { imageId?: unknown }
      if (typeof row.imageId === 'string') {
        const imageKey = normalizePathKey(row.imageId)
        if (imageKey === frameRootKey || imageKey.startsWith(`${frameRootKey}${path.sep}`)) {
          keep = false
          removed += 1
        }
      }
    } catch {
      keep = true
    }
    if (keep) output += `${line}\n`
  }
  fs.writeFileSync(tmp, output, 'utf-8')
  fs.renameSync(tmp, filePath)
  return removed
}

export function clearMediaSearchData(): MediaSearchClearCacheResult & {
  removedEmbeddings?: number
} {
  ensureMediaSearchDirs()
  const cacheDir = path.resolve(getMediaSearchDir())
  const before = getMediaCacheStats({ force: true })
  const frameRootKey = normalizePathKey(path.join(cacheDir, 'frames'))
  const clearableDirs = [
    'manifests',
    'vectors',
    'thumbnails',
    'frames',
    'transcripts',
    'ocr',
    'temp',
    'stats',
  ]
  let deletedEntries = 0
  let removedEmbeddings = 0

  try {
    const storePaths = [
      ...getEmbeddingStorePaths('clip_vit_base_patch32', 'global'),
      ...getEmbeddingStorePaths('dinov2_vitb14', 'global'),
    ]
    for (const filePath of [...new Set(storePaths)]) {
      removedEmbeddings += compactFrameEmbeddingStore(filePath, frameRootKey)
    }
  } catch {
    /* continue clearing media-search data even if old embedding compaction fails */
  }

  for (const name of clearableDirs) {
    const target = path.resolve(cacheDir, name)
    if (target === cacheDir || !target.startsWith(`${cacheDir}${path.sep}`)) {
      return {
        ok: false,
        deletedEntries,
        freedBytes: 0,
        removedEmbeddings,
        error: 'Unsafe media data path',
      }
    }
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true })
        deletedEntries += 1
      }
      fs.mkdirSync(target, { recursive: true })
    } catch (err) {
      return {
        ok: false,
        deletedEntries,
        freedBytes: 0,
        removedEmbeddings,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  invalidateMediaCacheStats()
  const after = getMediaCacheStats({ force: true })
  return {
    ok: true,
    deletedEntries,
    freedBytes: Math.max(0, before.totalBytes - after.totalBytes),
    removedEmbeddings,
    stats: after,
  }
}
