import crypto from 'crypto'
import fs from 'fs'
import readline from 'readline'
import path from 'path'
import type {
  MediaSearchFrameEmbeddingStats,
  MediaSearchFrameSearchResponse,
  MediaSearchVideoFrameRecord,
  MediaSearchVideoRecord,
} from '../shared/ipc-contract'
import {
  generateVideoCoverThumbnailAsync,
  generateVideoFramesBatchAsync,
  generateVideoFramesSingleInputAsync,
} from './ffmpegService'
import { ensureMediaSearchDirs, getMediaSearchDir } from './mediaCacheService'
import { readPersistedStats, writePersistedStats } from './persistedStatsService'
import { getMissingVideoIds, loadVideoManifest } from './videoScanService'
import { getEmbeddingCacheDir, getEmbeddingStorePaths } from './vectorDatabaseService'
import {
  expectedFrameVectorDim,
  normalizeFrameKey,
  normalizeFrameVector,
  normalizedCosineScore,
} from './mediaSearchVectorMath'
import {
  describeEmbeddingVectorSource,
  ensureEmbeddingF16Cache,
  readEmbeddingF16CachePaths,
} from './embeddingF16Cache'
import { pruneTopKCandidates } from './mediaSearchTopK'
import { createMediaSearchScopeMatcher } from './mediaSearchScope'
import {
  clearVideoFrameCheckpointScope,
  commitVideoFrameCheckpoint,
  currentVideoFrameSourceFingerprint,
  loadVideoFrameCheckpoints,
  videoFrameCheckpointScopeId,
  videoFrameSourceFingerprint,
} from './videoFrameCheckpointStore'
import { VideoFrameManifestLookup } from './videoFrameManifestLookup'

export interface VideoFrameBuildProgressEvent {
  currentPath?: string
  completed: number
  total: number
  failed: number
  startedAt?: number
  elapsedMs?: number
  itemsPerSecond?: number
  etaMs?: number
}

export interface VideoFrameBuildResult {
  records: MediaSearchVideoFrameRecord[]
  total: number
  completed: number
  failed: number
  unavailable: number
  preserved: number
  sourceChanged: number
  invalidatedImagePaths: string[]
}

export interface VideoFrameCheckpointEvent {
  kind: 'existing' | 'checkpoint' | 'final'
  scopeId: string
  sequence: number
  records: MediaSearchVideoFrameRecord[]
  readyRecords: MediaSearchVideoFrameRecord[]
  completed: number
  total: number
}

interface BuildOptions {
  videos?: MediaSearchVideoRecord[]
  maxFramesPerVideo?: number
  intervalMs?: number
  width?: number
  localFrameExtractionMode?: 'legacy' | 'single-input'
  networkFrameExtractionMode?: 'multi-input' | 'single-input'
  isCancelled?: () => boolean
  onProgress?: (progress: VideoFrameBuildProgressEvent) => void
  onCheckpoint?: (checkpoint: VideoFrameCheckpointEvent) => void
}

// Default sampling policy: 20 frames per minute (one every 3s), spread
// uniformly across the WHOLE duration — a 1-hour video yields ~1200 frames,
// not just its opening minutes. Videos longer than 3h hit the frame cap and
// widen the spacing to keep the coverage uniform.
const DEFAULT_INTERVAL_MS = 3_000
const DEFAULT_MAX_FRAMES_PER_VIDEO = 3_600
const DEFAULT_FRAME_WIDTH = 384
const DEFAULT_FRAME_CONCURRENCY = 1
const DEFAULT_LOCAL_FRAME_BATCH_SIZE = 12
const DEFAULT_LOCAL_FRAME_BATCH_SPAN_MS = 30_000
const NETWORK_INTERVAL_MS = 15_000
const NETWORK_MAX_FRAMES_PER_VIDEO = 240
const NETWORK_FRAME_WIDTH = 256
const DEFAULT_NETWORK_FRAME_BATCH_SIZE = 3
const DEFAULT_NETWORK_FRAME_BATCH_SPAN_MS = 30_000

function frameManifestPath(): string {
  return path.join(getMediaSearchDir(), 'manifests', 'video_frames.jsonl')
}

function frameManifestLookup(): VideoFrameManifestLookup {
  return new VideoFrameManifestLookup(
    frameManifestPath(),
    path.join(getMediaSearchDir(), 'manifests', 'video_frames.lookup.sqlite'),
  )
}

function frameEmbeddingStatsPath(): string {
  return path.join(getMediaSearchDir(), 'stats', 'frame_embedding_stats.json')
}

function frameIdFor(videoId: string, timestampMs: number): string {
  return crypto.createHash('sha1').update(`${videoId}:${timestampMs}`).digest('hex')
}

function frameImagePathFor(videoId: string, frameId: string): string {
  return path.join(getMediaSearchDir(), 'frames', videoId, `${frameId}.jpg`)
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

function getFrameConcurrency(): number {
  const raw = Number(
    process.env.FLOATING_CLOCK_MEDIA_FRAME_CONCURRENCY || DEFAULT_FRAME_CONCURRENCY,
  )
  if (!Number.isFinite(raw)) return DEFAULT_FRAME_CONCURRENCY
  return Math.max(1, Math.min(3, Math.floor(raw)))
}

function shouldUseFrameHardwareDecode(): boolean {
  return process.env.FLOATING_CLOCK_MEDIA_FRAME_HWACCEL === '1'
}

function boundedEnvironmentInteger(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(maximum, Math.floor(value)))
}

function localFrameExtractionMode(options: BuildOptions): 'legacy' | 'single-input' {
  if (options.localFrameExtractionMode) return options.localFrameExtractionMode
  return process.env.FLOATING_CLOCK_MEDIA_LOCAL_FRAME_MODE === 'legacy' ? 'legacy' : 'single-input'
}

function networkFrameExtractionMode(options: BuildOptions): 'multi-input' | 'single-input' {
  if (options.networkFrameExtractionMode) return options.networkFrameExtractionMode
  return process.env.FLOATING_CLOCK_MEDIA_NETWORK_FRAME_MODE === 'single-input'
    ? 'single-input'
    : 'multi-input'
}

function applyBuildMetrics(
  progress: VideoFrameBuildProgressEvent,
  startedAt: number,
): VideoFrameBuildProgressEvent {
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  const processed = Math.max(0, progress.completed + progress.failed)
  const seconds = elapsedMs / 1000
  const itemsPerSecond = seconds > 0 ? processed / seconds : 0
  const remaining = Math.max(0, progress.total - processed)
  return {
    ...progress,
    startedAt,
    elapsedMs,
    itemsPerSecond: Number.isFinite(itemsPerSecond) ? itemsPerSecond : 0,
    etaMs: itemsPerSecond > 0 ? Math.round((remaining / itemsPerSecond) * 1000) : undefined,
  }
}

export function getVideoFramesDir(): string {
  ensureMediaSearchDirs()
  return path.join(getMediaSearchDir(), 'frames')
}

let frameManifestCache: { signature: string; records: MediaSearchVideoFrameRecord[] } | null = null
let frameManifestDoneCountCache: { signature: string; count: number } | null = null
let readyFrameManifestCache: { signature: string; records: MediaSearchVideoFrameRecord[] } | null =
  null
let frameManifestPreviewCache: {
  signature: string
  frames: MediaSearchVideoFrameRecord[]
  total: number
} | null = null
const FRAME_MANIFEST_PREVIEW_CACHE_ROWS = 2000

function fileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath)
    return `${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return `${path.resolve(filePath)}:missing`
  }
}

export function invalidateVideoFrameManifestCache(): void {
  frameManifestCache = null
  frameManifestDoneCountCache = null
  readyFrameManifestCache = null
  frameManifestPreviewCache = null
  frameEmbeddingStatsCache = null
}

function cacheVideoFrameManifestPreview(
  signature: string,
  records: MediaSearchVideoFrameRecord[],
): void {
  frameManifestPreviewCache = {
    signature,
    frames: records.slice(-FRAME_MANIFEST_PREVIEW_CACHE_ROWS).reverse(),
    total: records.length,
  }
}

export function planVideoFrameTimestamps(
  durationMs: number | undefined,
  maxFrames = DEFAULT_MAX_FRAMES_PER_VIDEO,
  intervalMs = DEFAULT_INTERVAL_MS,
): number[] {
  const safeMax = Math.max(1, Math.min(10_800, Math.floor(maxFrames)))
  const safeInterval = Math.max(1000, Math.min(10 * 60_000, Math.floor(intervalMs)))
  const duration =
    Number.isFinite(durationMs) && durationMs && durationMs > 0 ? durationMs : safeInterval
  const start = Math.min(1000, Math.max(0, duration - 1000))
  const last = Math.max(start, duration - 1000)
  // Uniform full-duration coverage: take as many samples as the duration
  // allows at the target rate (capped by safeMax), then spread them evenly
  // between start and last instead of stopping after the opening minutes.
  const count = Math.min(safeMax, Math.max(1, Math.floor(duration / safeInterval)))
  if (count === 1) return [Math.floor((start + last) / 2)]
  const step = (last - start) / count
  const timestamps: number[] = []
  for (let i = 0; i < count; i++) {
    timestamps.push(Math.floor(start + i * step))
  }
  return timestamps
}

export function videoFramePolicyFor(video: MediaSearchVideoRecord): {
  mode: 'local-per-frame' | 'network-batch'
  maxFramesPerVideo: number
  intervalMs: number
  width: number
} {
  return video.sourceType === 'mounted-network'
    ? {
        mode: 'network-batch',
        maxFramesPerVideo: NETWORK_MAX_FRAMES_PER_VIDEO,
        intervalMs: NETWORK_INTERVAL_MS,
        width: NETWORK_FRAME_WIDTH,
      }
    : {
        mode: 'local-per-frame',
        maxFramesPerVideo: DEFAULT_MAX_FRAMES_PER_VIDEO,
        intervalMs: DEFAULT_INTERVAL_MS,
        width: DEFAULT_FRAME_WIDTH,
      }
}

export function loadVideoFrameManifest(): MediaSearchVideoFrameRecord[] {
  ensureMediaSearchDirs()
  const filePath = frameManifestPath()
  const signature = fileSignature(filePath)
  if (frameManifestCache?.signature === signature) return frameManifestCache.records
  try {
    if (!fs.existsSync(filePath)) {
      frameManifestCache = { signature, records: [] }
      return []
    }
    const records = frameManifestLookup().listAll()
    const loadedSignature = fileSignature(filePath)
    frameManifestCache = { signature: loadedSignature, records }
    cacheVideoFrameManifestPreview(loadedSignature, records)
    return records
  } catch {
    return []
  }
}

function filterAvailableVideoFrames(
  records: readonly MediaSearchVideoFrameRecord[],
): MediaSearchVideoFrameRecord[] {
  const missingVideoIds = getMissingVideoIds()
  return missingVideoIds.size > 0
    ? records.filter((record) => !missingVideoIds.has(record.videoId))
    : [...records]
}

export function loadAvailableVideoFrameManifest(): MediaSearchVideoFrameRecord[] {
  return filterAvailableVideoFrames(loadVideoFrameManifest())
}

export function findReadyVideoFrameById(frameId: string): MediaSearchVideoFrameRecord | null {
  const normalized = frameId.trim()
  if (!/^[a-f0-9]{40}$/i.test(normalized)) return null
  const record = frameManifestLookup().findReady(normalized)
  if (!record?.imagePath) return null
  return getMissingVideoIds().has(record.videoId) ? null : record
}

export function loadVideoFrameManifestPreview(limit: number): {
  frames: MediaSearchVideoFrameRecord[]
  total: number
} {
  ensureMediaSearchDirs()
  const filePath = frameManifestPath()
  const maxRows = Math.max(1, Math.min(2000, Math.floor(limit)))
  const missingVideoIds = getMissingVideoIds()
  if (missingVideoIds.size > 0) {
    const frames = loadVideoFrameManifest().filter((record) => !missingVideoIds.has(record.videoId))
    return { frames: frames.slice(-maxRows).reverse(), total: frames.length }
  }
  const signature = fileSignature(filePath)
  if (frameManifestPreviewCache?.signature === signature) {
    return {
      frames: frameManifestPreviewCache.frames.slice(0, maxRows),
      total: frameManifestPreviewCache.total,
    }
  }
  if (frameManifestCache?.signature === signature) {
    cacheVideoFrameManifestPreview(signature, frameManifestCache.records)
    return {
      frames: frameManifestPreviewCache?.frames.slice(0, maxRows) ?? [],
      total: frameManifestPreviewCache?.total ?? 0,
    }
  }
  try {
    if (!fs.existsSync(filePath)) return { frames: [], total: 0 }
    const { frames, total } = frameManifestLookup().preview(FRAME_MANIFEST_PREVIEW_CACHE_ROWS)
    frameManifestPreviewCache = {
      signature: fileSignature(filePath),
      frames,
      total,
    }
    return { frames: frames.slice(0, maxRows), total }
  } catch {
    const frames = loadVideoFrameManifest()
    return { frames: frames.slice(0, maxRows), total: frames.length }
  }
}

function writeVideoFrameManifest(records: MediaSearchVideoFrameRecord[]): void {
  ensureMediaSearchDirs()
  const filePath = frameManifestPath()
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const descriptor = fs.openSync(tmp, 'w')
  try {
    try {
      for (const record of records) fs.writeSync(descriptor, `${JSON.stringify(record)}\n`)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.renameSync(tmp, filePath)
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* best-effort cleanup of this manifest's private temporary file */
    }
  }
  try {
    frameManifestLookup().replace(records)
  } catch {
    // JSONL is the crash-safe authority; the lookup is rebuilt lazily on read.
  }
  const signature = fileSignature(filePath)
  frameManifestCache = { signature, records }
  frameManifestDoneCountCache = {
    signature,
    count: records.filter((record) => record.status === 'done').length,
  }
  readyFrameManifestCache = {
    signature,
    records: records.filter(
      (record) => record.status === 'done' && record.imagePath && fs.existsSync(record.imagePath),
    ),
  }
  cacheVideoFrameManifestPreview(signature, records)
  frameEmbeddingStatsCache = null
}

export function getVideoFrameManifestCount(): number {
  ensureMediaSearchDirs()
  const filePath = frameManifestPath()
  const signature = fileSignature(filePath)
  if (frameManifestDoneCountCache?.signature === signature) return frameManifestDoneCountCache.count
  try {
    if (!fs.existsSync(filePath)) {
      frameManifestDoneCountCache = { signature, count: 0 }
      return 0
    }
    const count = frameManifestLookup().countDone()
    frameManifestDoneCountCache = { signature: fileSignature(filePath), count }
    return count
  } catch {
    return loadVideoFrameManifest().filter((record) => record.status === 'done').length
  }
}

export function getReadyVideoFrameCount(): number {
  return loadReadyVideoFrameManifest().length
}

export function loadReadyVideoFrameManifest(): MediaSearchVideoFrameRecord[] {
  const filePath = frameManifestPath()
  const signature = fileSignature(filePath)
  if (readyFrameManifestCache?.signature === signature) {
    return filterAvailableVideoFrames(readyFrameManifestCache.records)
  }
  const records = frameManifestLookup()
    .listReady()
    .filter(
      (record) => record.status === 'done' && record.imagePath && fs.existsSync(record.imagePath),
    )
  readyFrameManifestCache = { signature, records }
  return filterAvailableVideoFrames(records)
}

export async function collectEmbeddedImageIds(
  modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32',
  frameImagePaths: Set<string>,
  options: { useCache?: boolean } = {},
): Promise<Set<string>> {
  const embedded = new Set<string>()
  if (frameImagePaths.size === 0) return embedded
  const framePathByKey = new Map<string, string>()
  for (const imagePath of frameImagePaths) {
    framePathByKey.set(normalizeFrameKey(imagePath), imagePath)
  }
  // Prefer the authoritative generation / shared F16 cache: its path index
  // covers the same sources (model shard + legacy image_embeddings.jsonl), so
  // the coverage set is identical for well-formed rows. Fall back to the
  // legacy full JSONL stream scan when no snapshot can be built.
  const cache =
    options.useCache === false
      ? null
      : await ensureEmbeddingF16Cache({
          cacheDir: getEmbeddingCacheDir(),
          modelName,
          embeddingType: 'global',
          dim: expectedFrameVectorDim(modelName),
          sourcePaths: getEmbeddingStorePaths(modelName, 'global'),
        })
  if (cache) {
    for (const embeddedPath of readEmbeddingF16CachePaths(cache)) {
      const framePath = framePathByKey.get(normalizeFrameKey(embeddedPath))
      if (framePath) embedded.add(framePath)
    }
    return embedded
  }
  const modelNeedle = `"modelName":${JSON.stringify(modelName)}`
  const typeNeedle = '"embeddingType":"global"'
  const expectedDim = expectedFrameVectorDim(modelName)
  const latestByKey = new Set<string>()
  for (const filePath of getEmbeddingStorePaths(modelName, 'global')) {
    let stream: fs.ReadStream
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    } catch {
      continue
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line || !line.includes(modelNeedle) || !line.includes(typeNeedle)) continue
      try {
        const row = JSON.parse(line) as {
          imageId?: unknown
          modelName?: unknown
          embeddingType?: unknown
          dim?: unknown
          vector?: unknown
        }
        if (
          row.modelName !== modelName ||
          row.embeddingType !== 'global' ||
          typeof row.imageId !== 'string'
        ) {
          continue
        }
        const key = normalizeFrameKey(row.imageId)
        if (!framePathByKey.has(key)) continue
        // Every matching model/type/path row is a revision. Delete first so
        // malformed, zero, or wrong-dimension latest rows tombstone older
        // legacy/current entries; a later valid row repairs the key.
        latestByKey.delete(key)
        if (row.dim !== expectedDim || !normalizeFrameVector(row.vector, expectedDim)) continue
        latestByKey.add(key)
      } catch {
        /* skip malformed embedding rows */
      }
    }
  }
  for (const key of latestByKey) {
    const framePath = framePathByKey.get(key)
    if (framePath) embedded.add(framePath)
  }
  return embedded
}

let frameEmbeddingStatsCache: { signature: string; value: MediaSearchFrameEmbeddingStats } | null =
  null

function fileStatSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath)
    return `${filePath}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return `${filePath}:missing`
  }
}

async function getFrameEmbeddingStatsSignature(frameCount: number): Promise<string> {
  const { hasFrameIndex, getFrameEmbeddingCacheOptions } = await import('./mediaSearchFrameIndex')
  const frameIndexPath = path.join(getMediaSearchDir(), 'vectors', 'frame_embedding_index.jsonl')
  const paths = [frameManifestPath(), ...(hasFrameIndex() ? [frameIndexPath] : [])]
  const parts = [String(frameCount), ...[...new Set(paths)].sort().map(fileStatSignature)]
  // Hang model freshness on the authoritative generation identity when
  // CURRENT (or its committed increment) matches the shards, otherwise on
  // the shard stats themselves — equivalent to the old raw shard signature
  // whenever no generation is live. The full fingerprint also invalidates
  // stats after committed appends, repairs, or invalid latest tombstones.
  for (const modelName of ['dinov2_vitb14', 'clip_vit_base_patch32'] as const) {
    const source = describeEmbeddingVectorSource(getFrameEmbeddingCacheOptions(modelName))
    parts.push(`${modelName}:${source.fingerprint}`)
  }
  return parts.join('|')
}

function isFrameEmbeddingStats(value: unknown): value is MediaSearchFrameEmbeddingStats {
  if (!value || typeof value !== 'object') return false
  const stats = value as Partial<MediaSearchFrameEmbeddingStats>
  return (
    typeof stats.readyFrames === 'number' &&
    typeof stats.dinoEmbeddedFrames === 'number' &&
    typeof stats.clipEmbeddedFrames === 'number' &&
    typeof stats.missingDinoFrames === 'number' &&
    typeof stats.missingClipFrames === 'number'
  )
}

function minimumUsefulScore(_modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32'): number {
  return 0
}

function rankAndFilterFrames(
  candidates: Array<MediaSearchVideoFrameRecord & { vectorScore: number }>,
  modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32',
  topK: number,
): Array<MediaSearchVideoFrameRecord & { vectorScore: number }> {
  if (candidates.length === 0) return []
  const sorted = [...candidates].sort((a, b) => b.vectorScore - a.vectorScore)
  const cutoff = minimumUsefulScore(modelName)
  return sorted
    .filter(
      (frame) =>
        frame.vectorScore >= cutoff &&
        Boolean(frame.imagePath) &&
        fs.existsSync(frame.imagePath as string),
    )
    .slice(0, topK)
}

function getScoredFrameValue(
  candidate: MediaSearchVideoFrameRecord & { vectorScore: number },
): number {
  return candidate.vectorScore
}

function driveLabelForPath(filePath: string): string {
  const parsed = path.parse(filePath)
  const root = parsed.root || ''
  if (/^[A-Za-z]:[\\/]/.test(root)) return root.slice(0, 2).toUpperCase()
  return root || '(other)'
}

export async function searchSimilarVideoFrames(input: {
  frameId: string
  modelName?: 'dinov2_vitb14' | 'clip_vit_base_patch32'
  topK?: number
  scanPaths?: string[]
  onProgress?: (progress: import('./videoFrameSearchService').MediaSearchProgress) => void
}): Promise<MediaSearchFrameSearchResponse> {
  const searchStartedAt = performance.now()
  const manifestStartedAt = performance.now()
  const frames = loadReadyVideoFrameManifest()
  const isInScope = createMediaSearchScopeMatcher(input.scanPaths ?? [])
  const byImagePath = new Map(
    frames
      .filter((record) => record.imagePath && isInScope(record.videoPath))
      .map((record) => [normalizeFrameKey(record.imagePath as string), record]),
  )
  const query = frames.find((record) => record.frameId === input.frameId)
  const manifestMs = performance.now() - manifestStartedAt
  if (!query?.imagePath || !fs.existsSync(query.imagePath)) {
    return { ok: false, results: [], totalCandidates: 0, error: 'Query frame image is missing' }
  }

  const modelName = input.modelName ?? 'clip_vit_base_patch32'
  const topK = Math.max(1, Math.min(200, Math.floor(input.topK ?? 50)))
  const minScore = minimumUsefulScore(modelName)
  const indexStartedAt = performance.now()
  const {
    ensureFrameIndexFreshAsync,
    findFrameVector,
    getFrameIndexVectorCount,
    scanFrameIndexVectors,
  } = await import('./mediaSearchFrameIndex')
  input.onProgress?.({
    phase: 'indexing',
    shardIndex: 0,
    shardTotal: 1,
    candidatesScanned: 0,
  })
  await ensureFrameIndexFreshAsync()

  const indexMs = performance.now() - indexStartedAt
  const frameVectorCount = await getFrameIndexVectorCount(modelName)
  if (frameVectorCount === 0) {
    return {
      ok: false,
      queryFrameId: query.frameId,
      modelName,
      results: [],
      totalCandidates: 0,
      error: `No ${modelName} frame index. Build frame embeddings first.`,
    }
  }

  const queryVector = findFrameVector(query.imagePath, modelName)
  if (!queryVector) {
    return {
      ok: false,
      queryFrameId: query.frameId,
      modelName,
      results: [],
      totalCandidates: 0,
      error: `Query frame has no ${modelName} embedding. Build frame embeddings first.`,
    }
  }

  const candidates: Array<MediaSearchVideoFrameRecord & { vectorScore: number }> = []
  const scoringStartedAt = performance.now()
  let totalCandidates = 0

  const progressEvery = Math.max(200, Math.floor(frameVectorCount / 100))
  await scanFrameIndexVectors(modelName, (imagePath, vector) => {
    if (imagePath === query.imagePath) return
    if (vector.length !== queryVector.length) return
    const frame = byImagePath.get(normalizeFrameKey(imagePath))
    if (!frame) return
    totalCandidates += 1
    if (totalCandidates % progressEvery === 0) {
      input.onProgress?.({
        phase: 'scanning',
        shardIndex: totalCandidates,
        shardTotal: Math.max(1, byImagePath.size),
        candidatesScanned: totalCandidates,
      })
    }
    const vectorScore = normalizedCosineScore(queryVector, vector)
    if (vectorScore < minScore) return
    candidates.push({ ...frame, vectorScore })
    pruneTopKCandidates(candidates, topK, getScoredFrameValue)
  })

  const top = rankAndFilterFrames(candidates, modelName, topK)
  const scoringMs = performance.now() - scoringStartedAt
  input.onProgress?.({
    phase: 'scanning',
    shardIndex: Math.max(1, byImagePath.size),
    shardTotal: Math.max(1, byImagePath.size),
    candidatesScanned: totalCandidates,
  })
  return {
    ok: true,
    queryFrameId: query.frameId,
    modelName,
    results: top,
    totalCandidates,
    timings: {
      manifestMs,
      indexMs,
      embeddingMs: 0,
      scoringMs,
      totalMs: performance.now() - searchStartedAt,
    },
  }
}

export async function getFrameEmbeddingStats(): Promise<MediaSearchFrameEmbeddingStats> {
  const frames = loadAvailableVideoFrameManifest()
  const readyFrames = frames.filter((record) => record.status === 'done' && record.imagePath)
  const frameImagePaths = new Set(readyFrames.map((record) => record.imagePath as string))
  const signature = await getFrameEmbeddingStatsSignature(frameImagePaths.size)
  if (frameEmbeddingStatsCache?.signature === signature) return frameEmbeddingStatsCache.value
  const persisted = readPersistedStats(frameEmbeddingStatsPath(), signature, isFrameEmbeddingStats)
  if (persisted) {
    frameEmbeddingStatsCache = { signature, value: persisted }
    return persisted
  }
  const { collectFrameIndexImagePaths, isFrameIndexFresh } = await import('./mediaSearchFrameIndex')
  // A compact index is only a coverage authority when its complete source
  // fingerprint is current. On drift, scan JSONL so an invalid latest row can
  // tombstone an older indexed value instead of inflating coverage.
  const freshIndex = isFrameIndexFresh()
  const indexedDino = freshIndex
    ? new Set(
        [...collectFrameIndexImagePaths('dinov2_vitb14')].filter((imagePath) =>
          frameImagePaths.has(imagePath),
        ),
      )
    : new Set<string>()
  const indexedClip = freshIndex
    ? new Set(
        [...collectFrameIndexImagePaths('clip_vit_base_patch32')].filter((imagePath) =>
          frameImagePaths.has(imagePath),
        ),
      )
    : new Set<string>()
  const [shardDino, shardClip] = await Promise.all([
    indexedDino.size > 0
      ? Promise.resolve(new Set<string>())
      : collectEmbeddedImageIds('dinov2_vitb14', frameImagePaths),
    indexedClip.size > 0
      ? Promise.resolve(new Set<string>())
      : collectEmbeddedImageIds('clip_vit_base_patch32', frameImagePaths),
  ])
  const dinoCount = indexedDino.size || shardDino.size
  const clipCount = indexedClip.size || shardClip.size
  const coverage = new Map<
    string,
    {
      drive: string
      videos: Set<string>
      readyFrames: number
      dinoEmbeddedFrames: number
      clipEmbeddedFrames: number
    }
  >()
  for (const frame of readyFrames) {
    const drive = driveLabelForPath(frame.videoPath)
    const row = coverage.get(drive) ?? {
      drive,
      videos: new Set<string>(),
      readyFrames: 0,
      dinoEmbeddedFrames: 0,
      clipEmbeddedFrames: 0,
    }
    row.videos.add(frame.videoId)
    row.readyFrames += 1
    const imagePath = frame.imagePath as string
    if (indexedDino.has(imagePath) || shardDino.has(imagePath)) row.dinoEmbeddedFrames += 1
    if (indexedClip.has(imagePath) || shardClip.has(imagePath)) row.clipEmbeddedFrames += 1
    coverage.set(drive, row)
  }
  const value = {
    readyFrames: frameImagePaths.size,
    dinoEmbeddedFrames: dinoCount,
    clipEmbeddedFrames: clipCount,
    missingDinoFrames: Math.max(0, frameImagePaths.size - dinoCount),
    missingClipFrames: Math.max(0, frameImagePaths.size - clipCount),
    coverageByDrive: [...coverage.values()]
      .map((row) => ({
        drive: row.drive,
        videos: row.videos.size,
        readyFrames: row.readyFrames,
        dinoEmbeddedFrames: row.dinoEmbeddedFrames,
        clipEmbeddedFrames: row.clipEmbeddedFrames,
      }))
      .sort((a, b) => a.drive.localeCompare(b.drive)),
  }
  frameEmbeddingStatsCache = { signature, value }
  writePersistedStats(frameEmbeddingStatsPath(), signature, value)
  return value
}

export async function buildVideoFrameIndex(
  options: BuildOptions = {},
): Promise<VideoFrameBuildResult> {
  ensureMediaSearchDirs()
  const startedAt = Date.now()
  const videos = (options.videos ?? loadVideoManifest()).filter(
    (video) => !video.missing && fs.existsSync(video.path),
  )
  const checkpointScopeId = videoFrameCheckpointScopeId(videos)
  const sourceFingerprintByVideo = new Map(
    videos.map((video) => [video.videoId, videoFrameSourceFingerprint(video)]),
  )
  const manifestRecords = loadVideoFrameManifest()
  const loadedCheckpoints = loadVideoFrameCheckpoints(
    getMediaSearchDir(),
    videos,
    checkpointScopeId,
  )
  let checkpointSequence = loadedCheckpoints.nextSequence
  const existingByKey = new Map(
    manifestRecords.map((record) => [`${record.videoId}:${record.timestampMs}`, record]),
  )
  for (const record of loadedCheckpoints.records) {
    existingByKey.set(`${record.videoId}:${record.timestampMs}`, record)
  }
  const existingRecords = [...existingByKey.values()]
  const existing = new Map(
    existingRecords.map((record) => [`${record.videoId}:${record.timestampMs}`, record]),
  )
  const planned = videos.flatMap((video) => {
    const policy = videoFramePolicyFor(video)
    const maxFrames = options.maxFramesPerVideo ?? policy.maxFramesPerVideo
    const intervalMs = options.intervalMs ?? policy.intervalMs
    return planVideoFrameTimestamps(video.durationMs, maxFrames, intervalMs).map((timestampMs) => ({
      video,
      timestampMs,
      width: Math.max(128, Math.min(960, Math.floor(options.width ?? policy.width))),
      mode: policy.mode,
    }))
  })

  const targetVideoIds = new Set(videos.map((video) => video.videoId))
  const output = new Map<string, MediaSearchVideoFrameRecord>()
  let preserved = 0
  for (const record of manifestRecords) {
    if (targetVideoIds.has(record.videoId)) continue
    output.set(`${record.videoId}:${record.timestampMs}`, record)
    preserved += 1
  }
  let completed = 0
  let failed = 0
  let unavailable = 0
  const jobs: Array<{
    video: MediaSearchVideoRecord
    timestampMs: number
    width: number
    mode: 'local-per-frame' | 'network-batch'
  }> = []

  for (const item of planned) {
    if (options.isCancelled?.()) break
    const { video, timestampMs, width } = item
    const frameId = frameIdFor(video.videoId, timestampMs)
    const imagePath = frameImagePathFor(video.videoId, frameId)
    const key = `${video.videoId}:${timestampMs}`
    const prev = existing.get(key)
    let record: MediaSearchVideoFrameRecord = {
      frameId,
      videoId: video.videoId,
      videoPath: video.path,
      timestampMs,
      imagePath,
      width,
      sourceFingerprint: sourceFingerprintByVideo.get(video.videoId),
      status: 'pending',
      createdAt: prev?.createdAt ?? startedAt,
      updatedAt: startedAt,
    }

    if (
      prev?.status === 'done' &&
      prev.sourceFingerprint === sourceFingerprintByVideo.get(video.videoId) &&
      prev.imagePath &&
      fs.existsSync(prev.imagePath)
    ) {
      record = {
        ...prev,
        videoPath: video.path,
        width,
        sourceFingerprint: sourceFingerprintByVideo.get(video.videoId),
        updatedAt: startedAt,
      }
      completed += 1
      options.onProgress?.(
        applyBuildMetrics(
          {
            currentPath: video.path,
            completed: completed + failed + unavailable,
            total: planned.length,
            failed,
          },
          startedAt,
        ),
      )
    } else {
      jobs.push(item)
    }

    output.set(key, record)
  }

  const emitCheckpoint = (
    kind: VideoFrameCheckpointEvent['kind'],
    sequence: number,
    records: MediaSearchVideoFrameRecord[],
  ): void => {
    const readyRecords = records.filter(
      (record) => record.status === 'done' && record.imagePath && fs.existsSync(record.imagePath),
    )
    options.onCheckpoint?.({
      kind,
      scopeId: checkpointScopeId,
      sequence,
      records,
      readyRecords,
      completed,
      total: planned.length,
    })
  }

  const reusedReadyRecords = [...output.values()].filter(
    (record) => targetVideoIds.has(record.videoId) && record.status === 'done',
  )
  if (reusedReadyRecords.length > 0) emitCheckpoint('existing', 0, reusedReadyRecords)

  const markFrameResult = (
    job: { video: MediaSearchVideoRecord; timestampMs: number },
    ok: boolean,
    error?: string,
  ) => {
    const key = `${job.video.videoId}:${job.timestampMs}`
    const prev = output.get(key)
    if (!prev) return
    if (ok) {
      prev.status = 'done'
      prev.error = undefined
      completed += 1
    } else {
      prev.status = error?.includes('ffmpeg is not available') ? 'unavailable' : 'error'
      prev.error = error
      if (prev.status === 'unavailable') unavailable += 1
      else failed += 1
    }
    prev.updatedAt = Date.now()
    output.set(key, prev)
    options.onProgress?.(
      applyBuildMetrics(
        {
          currentPath: job.video.path,
          completed: completed + failed + unavailable,
          total: planned.length,
          failed,
        },
        startedAt,
      ),
    )
  }

  type FrameJob = (typeof jobs)[number]
  const sourceStillCurrent = (job: FrameJob): boolean =>
    currentVideoFrameSourceFingerprint(job.video) ===
    sourceFingerprintByVideo.get(job.video.videoId)

  const removeDerivedFrame = (job: FrameJob): void => {
    try {
      const outputPath = frameImagePathFor(
        job.video.videoId,
        frameIdFor(job.video.videoId, job.timestampMs),
      )
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    } catch {
      /* best-effort removal of a frame derived from a changed source */
    }
  }

  const commitJobs = (batch: FrameJob[]): void => {
    const records = batch
      .map((job) => output.get(`${job.video.videoId}:${job.timestampMs}`))
      .filter((record): record is MediaSearchVideoFrameRecord => record?.status === 'done')
    if (records.length === 0) return
    const sequence = checkpointSequence++
    commitVideoFrameCheckpoint(getMediaSearchDir(), checkpointScopeId, sequence, records)
    emitCheckpoint('checkpoint', sequence, records)
  }

  const runLegacyLocalFrame = async (job: FrameJob): Promise<void> => {
    if (options.isCancelled?.()) return
    if (!sourceStillCurrent(job)) {
      removeDerivedFrame(job)
      markFrameResult(job, false, 'source changed during frame extraction; rescan required')
      return
    }
    const imagePath = frameImagePathFor(
      job.video.videoId,
      frameIdFor(job.video.videoId, job.timestampMs),
    )
    const result = await generateVideoCoverThumbnailAsync({
      filePath: job.video.path,
      outputPath: imagePath,
      timestampMs: job.timestampMs,
      width: job.width,
      preferHardwareDecode: shouldUseFrameHardwareDecode(),
    })
    if (!sourceStillCurrent(job)) {
      removeDerivedFrame(job)
      markFrameResult(job, false, 'source changed during frame extraction; rescan required')
      return
    }
    markFrameResult(job, result.ok, result.error)
  }

  const createBatches = (
    entries: FrameJob[],
    maxFrames: number,
    maxSpanMs: number,
  ): FrameJob[][] => {
    const byVideo = new Map<string, FrameJob[]>()
    for (const job of entries) {
      const group = byVideo.get(job.video.videoId) ?? []
      group.push(job)
      byVideo.set(job.video.videoId, group)
    }
    const batches: FrameJob[][] = []
    for (const group of byVideo.values()) {
      group.sort((left, right) => left.timestampMs - right.timestampMs)
      let batch: FrameJob[] = []
      for (const job of group) {
        if (
          batch.length > 0 &&
          (batch.length >= maxFrames || job.timestampMs - batch[0].timestampMs > maxSpanMs)
        ) {
          batches.push(batch)
          batch = []
        }
        batch.push(job)
      }
      if (batch.length > 0) batches.push(batch)
    }
    return batches
  }

  const outputPathFor = (job: FrameJob): string =>
    frameImagePathFor(job.video.videoId, frameIdFor(job.video.videoId, job.timestampMs))

  const localJobs = jobs.filter((job) => job.mode === 'local-per-frame')
  if (localFrameExtractionMode(options) === 'legacy') {
    await mapLimit(localJobs, getFrameConcurrency(), runLegacyLocalFrame)
  } else {
    const localBatches = createBatches(
      localJobs,
      boundedEnvironmentInteger(
        'FLOATING_CLOCK_MEDIA_LOCAL_FRAME_BATCH_SIZE',
        DEFAULT_LOCAL_FRAME_BATCH_SIZE,
        32,
      ),
      boundedEnvironmentInteger(
        'FLOATING_CLOCK_MEDIA_LOCAL_FRAME_BATCH_SPAN_MS',
        DEFAULT_LOCAL_FRAME_BATCH_SPAN_MS,
        120_000,
      ),
    )
    await mapLimit(localBatches, getFrameConcurrency(), async (batch) => {
      if (options.isCancelled?.()) return
      if (batch.length === 1) {
        await runLegacyLocalFrame(batch[0])
        commitJobs(batch)
        return
      }
      if (!sourceStillCurrent(batch[0])) {
        for (const job of batch) {
          removeDerivedFrame(job)
          markFrameResult(job, false, 'source changed during frame extraction; rescan required')
        }
        return
      }
      const result = await generateVideoFramesSingleInputAsync({
        filePath: batch[0].video.path,
        frames: batch.map((job) => ({
          timestampMs: job.timestampMs,
          outputPath: outputPathFor(job),
        })),
        width: batch[0].width,
        preferHardwareDecode: shouldUseFrameHardwareDecode(),
      })
      if (!sourceStillCurrent(batch[0])) {
        for (const job of batch) {
          removeDerivedFrame(job)
          markFrameResult(job, false, 'source changed during frame extraction; rescan required')
        }
        return
      }
      const missing: FrameJob[] = []
      for (const job of batch) {
        if (result.created.has(outputPathFor(job))) markFrameResult(job, true)
        else missing.push(job)
      }
      if (missing.length === 0) {
        commitJobs(batch)
        return
      }
      if (options.isCancelled?.()) {
        for (const job of missing) markFrameResult(job, false, result.error || 'cancelled')
        commitJobs(batch)
        return
      }
      if (result.error?.includes('ffmpeg is not available')) {
        for (const job of missing) markFrameResult(job, false, result.error)
        commitJobs(batch)
        return
      }
      for (const job of missing) await runLegacyLocalFrame(job)
      commitJobs(batch)
    })
  }

  const networkJobs = new Map<string, typeof jobs>()
  for (const job of jobs.filter((entry) => entry.mode === 'network-batch')) {
    const group = networkJobs.get(job.video.videoId) ?? []
    group.push(job)
    networkJobs.set(job.video.videoId, group)
  }
  // One video at a time. Mounted-network sampling remains sparse, and the
  // existing multi-input path stays the default unless the measured grouped
  // single-input mode is explicitly selected.
  for (const videoJobs of networkJobs.values()) {
    if (options.isCancelled?.()) break
    if (!sourceStillCurrent(videoJobs[0])) {
      for (const job of videoJobs) {
        removeDerivedFrame(job)
        markFrameResult(job, false, 'source changed during frame extraction; rescan required')
      }
      continue
    }
    if (networkFrameExtractionMode(options) === 'single-input') {
      const batches = createBatches(
        videoJobs,
        boundedEnvironmentInteger(
          'FLOATING_CLOCK_MEDIA_NETWORK_FRAME_BATCH_SIZE',
          DEFAULT_NETWORK_FRAME_BATCH_SIZE,
          32,
        ),
        boundedEnvironmentInteger(
          'FLOATING_CLOCK_MEDIA_NETWORK_FRAME_BATCH_SPAN_MS',
          DEFAULT_NETWORK_FRAME_BATCH_SPAN_MS,
          120_000,
        ),
      )
      for (const batch of batches) {
        if (options.isCancelled?.()) break
        const result = await generateVideoFramesSingleInputAsync({
          filePath: batch[0].video.path,
          frames: batch.map((job) => ({
            timestampMs: job.timestampMs,
            outputPath: outputPathFor(job),
          })),
          width: batch[0].width,
          preferHardwareDecode: false,
        })
        if (!sourceStillCurrent(batch[0])) {
          for (const job of batch) {
            removeDerivedFrame(job)
            markFrameResult(job, false, 'source changed during frame extraction; rescan required')
          }
          continue
        }
        const missing = batch.filter((job) => !result.created.has(outputPathFor(job)))
        for (const job of batch) {
          if (result.created.has(outputPathFor(job))) markFrameResult(job, true)
        }
        if (missing.length === 0) {
          commitJobs(batch)
          continue
        }
        if (options.isCancelled?.()) {
          for (const job of missing) markFrameResult(job, false, result.error || 'cancelled')
          commitJobs(batch)
          break
        }
        const fallback = await generateVideoFramesBatchAsync({
          filePath: missing[0].video.path,
          frames: missing.map((job) => ({
            timestampMs: job.timestampMs,
            outputPath: outputPathFor(job),
          })),
          width: missing[0].width,
          preferHardwareDecode: false,
        })
        for (const job of missing) {
          const outputPath = outputPathFor(job)
          markFrameResult(job, fallback.created.has(outputPath), fallback.error || result.error)
        }
        commitJobs(batch)
      }
      continue
    }
    const result = await generateVideoFramesBatchAsync({
      filePath: videoJobs[0].video.path,
      frames: videoJobs.map((job) => ({
        timestampMs: job.timestampMs,
        outputPath: outputPathFor(job),
      })),
      width: videoJobs[0].width,
      preferHardwareDecode: false,
    })
    if (!sourceStillCurrent(videoJobs[0])) {
      for (const job of videoJobs) {
        removeDerivedFrame(job)
        markFrameResult(job, false, 'source changed during frame extraction; rescan required')
      }
      continue
    }
    for (const job of videoJobs) {
      const outputPath = outputPathFor(job)
      markFrameResult(job, result.created.has(outputPath), result.error)
    }
    commitJobs(videoJobs)
  }

  const invalidatedImagePaths: string[] = []
  let sourceChanged = 0
  for (const video of videos) {
    if (currentVideoFrameSourceFingerprint(video) === sourceFingerprintByVideo.get(video.videoId)) {
      continue
    }
    sourceChanged += 1
    for (const record of output.values()) {
      if (record.videoId !== video.videoId || record.status !== 'done') continue
      if (record.imagePath) {
        invalidatedImagePaths.push(record.imagePath)
        try {
          if (fs.existsSync(record.imagePath)) fs.unlinkSync(record.imagePath)
        } catch {
          /* final manifest excludes the stale frame even if cleanup is delayed */
        }
      }
      record.status = 'error'
      record.error = 'source changed during frame extraction; rescan required'
      record.updatedAt = Date.now()
      completed = Math.max(0, completed - 1)
      failed += 1
    }
  }

  const records = [...output.values()].sort(
    (a, b) => a.videoPath.localeCompare(b.videoPath) || a.timestampMs - b.timestampMs,
  )
  writeVideoFrameManifest(records)
  const finalReadyRecords = records.filter(
    (record) => targetVideoIds.has(record.videoId) && record.status === 'done',
  )
  emitCheckpoint('final', checkpointSequence, finalReadyRecords)
  clearVideoFrameCheckpointScope(getMediaSearchDir(), checkpointScopeId)
  options.onProgress?.(
    applyBuildMetrics(
      {
        completed: completed + failed + unavailable,
        total: planned.length,
        failed,
      },
      startedAt,
    ),
  )

  return {
    records,
    total: planned.length,
    completed,
    failed,
    unavailable,
    preserved,
    sourceChanged,
    invalidatedImagePaths,
  }
}
