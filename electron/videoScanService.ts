import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import type { MediaSearchVideoRecord } from '../shared/ipc-contract'
import {
  generateVideoCoverThumbnailAsync,
  isToolNotFoundError,
  readVideoMetadataAsync,
} from './ffmpegService'
import { ensureMediaSearchDirs, getMediaSearchDir } from './mediaCacheService'
import { isVideoPath } from './mediaSearchGuards'

export interface VideoScanProgressEvent {
  phase: 'enumerating' | 'processing'
  currentPath?: string
  scannedEntries: number
  videoCount: number
  processedVideos: number
  failed: number
  capped: boolean
}

export interface VideoScanResult {
  records: MediaSearchVideoRecord[]
  discovered: number
  updated: number
  unchanged: number
  failed: number
  scannedEntries: number
  capped: boolean
}

interface ScanOptions {
  paths: string[]
  onProgress?: (progress: VideoScanProgressEvent) => void
  isCancelled?: () => boolean
}

const DEFAULT_SCAN_CONCURRENCY = 6
const SKIP_DIRECTORY_NAMES = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'recovery',
  '$windows.~bt',
  '$windows.~ws',
])

function getMaxScanEntries(): number {
  const raw = Number(process.env.FLOATING_CLOCK_MEDIA_MAX_SCAN_ENTRIES || 0)
  if (!Number.isFinite(raw) || raw <= 0) return Number.POSITIVE_INFINITY
  return Math.max(1_000, Math.floor(raw))
}

function getScanConcurrency(): number {
  const raw = Number(process.env.FLOATING_CLOCK_MEDIA_SCAN_CONCURRENCY || DEFAULT_SCAN_CONCURRENCY)
  if (!Number.isFinite(raw)) return DEFAULT_SCAN_CONCURRENCY
  return Math.max(1, Math.min(6, Math.floor(raw)))
}

function shouldSkipDirectory(inputPath: string, dirent?: fs.Dirent): boolean {
  const name = (dirent?.name || path.basename(inputPath)).toLowerCase()
  if (!SKIP_DIRECTORY_NAMES.has(name)) return false
  const parent = path.dirname(path.resolve(inputPath))
  const root = path.parse(path.resolve(inputPath)).root
  return parent.toLowerCase() === root.toLowerCase()
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      await worker(items[index], index)
    }
  })
  await Promise.all(workers)
}

function manifestPath(): string {
  return path.join(getMediaSearchDir(), 'manifests', 'video_files.jsonl')
}

function videoIdForPath(filePath: string): string {
  return crypto.createHash('sha1').update(filePath.toLowerCase()).digest('hex')
}

function thumbnailPathForVideo(videoId: string): string {
  return path.join(getMediaSearchDir(), 'thumbnails', videoId, 'cover.jpg')
}

function normalizePathKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isPathInScanScope(filePath: string, scopePaths: string[]): boolean {
  if (scopePaths.length === 0) return true
  const key = normalizePathKey(filePath)
  return scopePaths.some((scopePath) => {
    const prefix = scopePath.endsWith(path.sep) ? scopePath : `${scopePath}${path.sep}`
    return key === scopePath || key.startsWith(prefix)
  })
}

function parseRecord(line: string): MediaSearchVideoRecord | null {
  try {
    const value = JSON.parse(line) as Partial<MediaSearchVideoRecord>
    if (typeof value.path !== 'string' || typeof value.videoId !== 'string') return null
    return value as MediaSearchVideoRecord
  } catch {
    return null
  }
}

let videoManifestCache: { signature: string; records: MediaSearchVideoRecord[] } | null = null
let videoManifestCountCache: { signature: string; count: number } | null = null
let videoManifestMissingIdsCache: { signature: string; ids: Set<string> } | null = null
let videoManifestPreviewCache: {
  signature: string
  records: MediaSearchVideoRecord[]
  total: number
} | null = null
const VIDEO_MANIFEST_PREVIEW_CACHE_ROWS = 1000

function fileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath)
    return `${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return `${path.resolve(filePath)}:missing`
  }
}

export function invalidateVideoManifestCache(): void {
  videoManifestCache = null
  videoManifestCountCache = null
  videoManifestMissingIdsCache = null
  videoManifestPreviewCache = null
}

function cacheVideoManifestPreview(signature: string, records: MediaSearchVideoRecord[]): void {
  const available = records.filter((record) => !record.missing)
  videoManifestPreviewCache = {
    signature,
    records: available.slice(-VIDEO_MANIFEST_PREVIEW_CACHE_ROWS).reverse(),
    total: available.length,
  }
  videoManifestMissingIdsCache = {
    signature,
    ids: new Set(records.filter((record) => record.missing).map((record) => record.videoId)),
  }
}

export function getMissingVideoIds(): Set<string> {
  ensureMediaSearchDirs()
  const signature = fileSignature(manifestPath())
  if (videoManifestMissingIdsCache?.signature === signature) {
    return new Set(videoManifestMissingIdsCache.ids)
  }
  const records = loadVideoManifest()
  return new Set(records.filter((record) => record.missing).map((record) => record.videoId))
}

export function loadVideoManifest(): MediaSearchVideoRecord[] {
  ensureMediaSearchDirs()
  const filePath = manifestPath()
  const signature = fileSignature(filePath)
  if (videoManifestCache?.signature === signature) return videoManifestCache.records
  try {
    if (!fs.existsSync(filePath)) {
      videoManifestCache = { signature, records: [] }
      return []
    }
    const records = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(parseRecord)
      .filter(
        (record): record is MediaSearchVideoRecord =>
          Boolean(record) && isVideoPath((record as MediaSearchVideoRecord).path),
      )
    const loadedSignature = fileSignature(filePath)
    videoManifestCache = { signature: loadedSignature, records }
    cacheVideoManifestPreview(loadedSignature, records)
    return records
  } catch {
    return []
  }
}

export function loadVideoManifestPreview(limit: number): {
  records: MediaSearchVideoRecord[]
  total: number
} {
  ensureMediaSearchDirs()
  const filePath = manifestPath()
  const maxRows = Math.max(1, Math.min(1000, Math.floor(limit)))
  const signature = fileSignature(filePath)
  if (videoManifestPreviewCache?.signature === signature) {
    return {
      records: videoManifestPreviewCache.records.slice(0, maxRows),
      total: videoManifestPreviewCache.total,
    }
  }
  if (videoManifestCache?.signature === signature) {
    cacheVideoManifestPreview(signature, videoManifestCache.records)
    return {
      records: videoManifestPreviewCache?.records.slice(0, maxRows) ?? [],
      total: videoManifestPreviewCache?.total ?? 0,
    }
  }
  try {
    if (!fs.existsSync(filePath)) return { records: [], total: 0 }
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
    const records: MediaSearchVideoRecord[] = []
    const missingIds = new Set<string>()
    let total = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line) continue
      if (line.includes('"missing"')) {
        const missingRecord = parseRecord(line)
        if (missingRecord?.missing) {
          missingIds.add(missingRecord.videoId)
          continue
        }
      }
      if (!line.includes('"videoId"') || !line.includes('"path"')) continue
      total += 1
      if (records.length >= VIDEO_MANIFEST_PREVIEW_CACHE_ROWS) continue
      const record = parseRecord(line)
      if (record && isVideoPath(record.path)) records.push(record)
    }
    const loadedSignature = fileSignature(filePath)
    videoManifestPreviewCache = {
      signature: loadedSignature,
      records,
      total,
    }
    videoManifestMissingIdsCache = { signature: loadedSignature, ids: missingIds }
    return { records: records.slice(0, maxRows), total }
  } catch {
    const records = loadVideoManifest().filter((record) => !record.missing)
    return { records: records.slice(0, maxRows), total: records.length }
  }
}

function writeVideoManifest(records: MediaSearchVideoRecord[]): void {
  ensureMediaSearchDirs()
  const filePath = manifestPath()
  const tmp = `${filePath}.tmp`
  const lines = records.map((record) => JSON.stringify(record)).join('\n')
  fs.writeFileSync(tmp, lines ? `${lines}\n` : '', 'utf-8')
  fs.renameSync(tmp, filePath)
  const signature = fileSignature(filePath)
  videoManifestCache = { signature, records }
  videoManifestCountCache = {
    signature,
    count: records.filter((record) => !record.missing).length,
  }
  cacheVideoManifestPreview(signature, records)
}

/** Persist unified source policy without re-reading video metadata or changing videoId. */
export function assignVideoManifestSources(
  assignments: readonly {
    videoId: string
    sourceId: string
    sourceType: 'local' | 'mounted-network' | 'sftp'
  }[],
): number {
  if (assignments.length === 0) return 0
  const byVideoId = new Map(assignments.map((assignment) => [assignment.videoId, assignment]))
  const records = loadVideoManifest()
  let updated = 0
  const next = records.map((record) => {
    const assignment = byVideoId.get(record.videoId)
    if (
      !assignment ||
      (record.sourceId === assignment.sourceId && record.sourceType === assignment.sourceType)
    ) {
      return record
    }
    updated += 1
    return { ...record, sourceId: assignment.sourceId, sourceType: assignment.sourceType }
  })
  if (updated > 0) writeVideoManifest(next)
  return updated
}

async function collectVideoFiles(
  inputPath: string,
  state: VideoScanProgressEvent,
  output: string[],
  maxScanEntries: number,
  isCancelled?: () => boolean,
  onProgress?: (progress: VideoScanProgressEvent) => void,
  dirent?: fs.Dirent,
): Promise<void> {
  if (isCancelled?.() || state.scannedEntries >= maxScanEntries) {
    if (state.scannedEntries >= maxScanEntries) state.capped = true
    return
  }
  state.scannedEntries += 1
  state.currentPath = inputPath
  if (state.scannedEntries % 200 === 0) onProgress?.({ ...state })

  let isFile = dirent?.isFile() ?? false
  let isDirectory = dirent?.isDirectory() ?? false
  if (!dirent || (!isFile && !isDirectory)) {
    try {
      const stat = await fsp.stat(inputPath)
      isFile = stat.isFile()
      isDirectory = stat.isDirectory()
    } catch {
      state.failed += 1
      return
    }
  }

  if (isFile) {
    if (isVideoPath(inputPath)) {
      output.push(inputPath)
      state.videoCount = output.length
    }
    return
  }

  if (!isDirectory) return
  if (shouldSkipDirectory(inputPath, dirent)) return

  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(inputPath, { withFileTypes: true })
  } catch {
    state.failed += 1
    return
  }

  for (const entry of entries) {
    if (isCancelled?.() || state.scannedEntries >= maxScanEntries) break
    await collectVideoFiles(
      path.join(inputPath, entry.name),
      state,
      output,
      maxScanEntries,
      isCancelled,
      onProgress,
      entry,
    )
  }
  if (state.scannedEntries >= maxScanEntries) state.capped = true
}

export async function scanVideoFiles(options: ScanOptions): Promise<VideoScanResult> {
  ensureMediaSearchDirs()
  const startedAt = Date.now()
  // Fail closed before touching the manifest. An unplugged drive and a folder
  // whose contents were deleted both enumerate as zero items; only the latter
  // is allowed to retire records.
  for (const inputPath of options.paths) {
    let stat: fs.Stats
    try {
      stat = await fsp.stat(inputPath)
    } catch {
      throw new Error(`Video source is offline or unavailable: ${inputPath}`)
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(`Video source is not a regular file or folder: ${inputPath}`)
    }
  }
  const existing = loadVideoManifest()
  const byPath = new Map(existing.map((record) => [record.path.toLowerCase(), record]))
  const discoveredPaths: string[] = []
  const maxScanEntries = getMaxScanEntries()
  const scopePaths = options.paths.map(normalizePathKey)
  const scanState: VideoScanProgressEvent = {
    phase: 'enumerating',
    scannedEntries: 0,
    videoCount: 0,
    processedVideos: 0,
    failed: 0,
    capped: false,
  }

  for (const rootPath of options.paths) {
    if (options.isCancelled?.()) break
    await collectVideoFiles(
      rootPath,
      scanState,
      discoveredPaths,
      maxScanEntries,
      options.isCancelled,
      options.onProgress,
    )
  }
  const enumerationFailed = scanState.failed

  const nextRecords = new Map<string, MediaSearchVideoRecord>()
  for (const record of existing) {
    if (!isVideoPath(record.path)) continue
    const key = record.path.toLowerCase()
    nextRecords.set(key, {
      ...record,
      missing: record.missing,
    })
  }

  let discovered = 0
  let updated = 0
  let unchanged = 0
  let processedVideos = 0
  const processJobs: Array<{
    filePath: string
    key: string
    next: MediaSearchVideoRecord
    changed: boolean
  }> = []
  for (const filePath of discoveredPaths) {
    try {
      const stat = await fsp.stat(filePath)
      const key = filePath.toLowerCase()
      const prev = byPath.get(key)
      const next: MediaSearchVideoRecord = {
        videoId: prev?.videoId ?? videoIdForPath(filePath),
        path: filePath,
        name: path.basename(filePath),
        ext: path.extname(filePath).toLowerCase(),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        discoveredAt: prev?.discoveredAt ?? startedAt,
        updatedAt: startedAt,
        metadataStatus: 'pending',
      }
      const changed =
        !prev ||
        prev.sizeBytes !== next.sizeBytes ||
        prev.mtimeMs !== next.mtimeMs ||
        prev.missing === true
      if (!prev) {
        discovered += 1
      } else if (changed) {
        updated += 1
      } else {
        unchanged += 1
        next.updatedAt = prev.updatedAt
        next.durationMs = prev.durationMs
        next.width = prev.width
        next.height = prev.height
        next.videoCodec = prev.videoCodec
        next.audioCodec = prev.audioCodec
        next.containerFormat = prev.containerFormat
        next.metadataStatus = prev.metadataStatus
        next.metadataError = prev.metadataError
        next.thumbnailPath = prev.thumbnailPath
        next.thumbnailStatus = prev.thumbnailStatus
        next.thumbnailError = prev.thumbnailError
      }

      const targetThumbnailPath = next.thumbnailPath ?? thumbnailPathForVideo(next.videoId)
      const shouldGenerateThumbnail =
        changed || !next.thumbnailPath || !fs.existsSync(targetThumbnailPath)
      if (changed || shouldGenerateThumbnail) processJobs.push({ filePath, key, next, changed })
      else nextRecords.set(key, next)
    } catch {
      scanState.failed += 1
    }
  }

  await mapLimit(processJobs, getScanConcurrency(), async (job) => {
    if (options.isCancelled?.()) return
    try {
      if (job.changed) {
        const metadataResult = await readVideoMetadataAsync(job.filePath)
        if (metadataResult.ok && metadataResult.metadata) {
          Object.assign(job.next, metadataResult.metadata, {
            metadataStatus: 'done' as const,
            metadataError: undefined,
          })
        } else {
          job.next.metadataStatus = isToolNotFoundError(metadataResult.error)
            ? 'unavailable'
            : 'error'
          job.next.metadataError = metadataResult.error
        }
      }

      const targetThumbnailPath = job.next.thumbnailPath ?? thumbnailPathForVideo(job.next.videoId)
      const shouldGenerateThumbnail =
        job.changed || !job.next.thumbnailPath || !fs.existsSync(targetThumbnailPath)
      if (shouldGenerateThumbnail) {
        const timestampMs = Math.max(
          1000,
          Math.min(5000, Math.floor((job.next.durationMs ?? 10000) / 10)),
        )
        const thumbnailResult = await generateVideoCoverThumbnailAsync({
          filePath: job.filePath,
          outputPath: targetThumbnailPath,
          timestampMs,
          width: 320,
          preferHardwareDecode: true,
        })
        job.next.thumbnailPath = targetThumbnailPath
        if (thumbnailResult.ok) {
          job.next.thumbnailStatus = 'done'
          job.next.thumbnailError = undefined
        } else {
          job.next.thumbnailStatus = isToolNotFoundError(thumbnailResult.error)
            ? 'unavailable'
            : 'error'
          job.next.thumbnailError = thumbnailResult.error
        }
      }
      nextRecords.set(job.key, job.next)
      processedVideos += 1
      scanState.phase = 'processing'
      scanState.processedVideos = processedVideos
      options.onProgress?.({
        ...scanState,
        currentPath: job.filePath,
        videoCount: discoveredPaths.length,
      })
    } catch {
      scanState.failed += 1
    }
  })

  // Reconcile only after the entire enumeration/processing lifecycle remains
  // valid. Cancellation, entry caps and unreadable directories preserve the
  // previous manifest because absence was not proven.
  const scanCompletedSafely =
    !scanState.capped && enumerationFailed === 0 && options.isCancelled?.() !== true
  if (scanCompletedSafely) {
    const discoveredKeys = new Set(discoveredPaths.map((filePath) => filePath.toLowerCase()))
    for (const [key, record] of nextRecords) {
      if (isPathInScanScope(record.path, scopePaths) && !discoveredKeys.has(key)) {
        nextRecords.set(key, { ...record, missing: true, updatedAt: Date.now() })
      }
    }
  }

  const records = [...nextRecords.values()].sort((a, b) => a.path.localeCompare(b.path))
  writeVideoManifest(records)
  options.onProgress?.({
    ...scanState,
    currentPath: undefined,
    videoCount: discoveredPaths.length,
    processedVideos,
  })

  return {
    records,
    discovered,
    updated,
    unchanged,
    failed: scanState.failed,
    scannedEntries: scanState.scannedEntries,
    capped: scanState.capped,
  }
}

/** Mark exact videos unavailable without deleting source files or rebuilding metadata. */
export async function markVideoManifestRecordsMissing(videoIds: readonly string[]): Promise<{
  removed: number
}> {
  const selected = new Set(
    videoIds.filter((videoId): videoId is string => typeof videoId === 'string' && !!videoId),
  )
  if (selected.size === 0) return { removed: 0 }
  const records = loadVideoManifest()
  let removed = 0
  const updatedAt = Date.now()
  const next = records.map((record) => {
    if (!selected.has(record.videoId) || record.missing) return record
    removed += 1
    return { ...record, missing: true, updatedAt }
  })
  if (removed > 0) writeVideoManifest(next)
  return { removed }
}

export function getVideoManifestCount(): number {
  ensureMediaSearchDirs()
  const filePath = manifestPath()
  const signature = fileSignature(filePath)
  if (videoManifestCountCache?.signature === signature) return videoManifestCountCache.count
  try {
    if (!fs.existsSync(filePath)) {
      videoManifestCountCache = { signature, count: 0 }
      return 0
    }
    let count = 0
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
    for (const line of lines) {
      if (!line || line.includes('"missing":true')) continue
      if (!line.includes('"videoId"') || !line.includes('"path"')) continue
      count += 1
    }
    videoManifestCountCache = { signature: fileSignature(filePath), count }
    return count
  } catch {
    return loadVideoManifest().filter((record) => !record.missing).length
  }
}
