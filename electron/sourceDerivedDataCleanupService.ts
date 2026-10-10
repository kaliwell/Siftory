import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  ImageSearchFolderDataEditResult,
  SourceDerivedDataCategory,
  SourceDerivedDataCleanupProgress,
  SourceDerivedDataCleanupResult,
  SourceDerivedDataHistoryPolicy,
  SourceDerivedDataPreview,
} from '../shared/ipc-contract'
import {
  executeImageSearchFolderDataEdit,
  previewImageSearchFolderDataEdit,
  type FolderDataEditHooks,
} from './imageSearchFolderDataService'
import {
  previewThumbnailCacheForFolder,
  purgeThumbnailCachePlan,
  type ThumbnailCacheFolderPlan,
} from './thumbnailDiskCache'
import {
  extractJsonStringField,
  isImageDataPathWithin,
  normalizedImageDataPathKey,
} from './imageSearchDataPathUtils'
import {
  VIDEO_SEMANTIC_DATABASE_FILENAME,
  VideoSemanticDatabase,
  type VideoSemanticVideoDataStats,
} from './videoSemanticDatabase'
import {
  executeManagedAutomationHistoryCleanup,
  executeSubjectEmbeddingSourceCleanup,
  previewManagedAutomationHistory,
  previewSubjectEmbeddingSourceCleanup,
  type ManagedAutomationHistoryPlan,
  type SourceScopedFilePlan,
} from './sourceScopedTraceCleanup'

const PREVIEW_TTL_MS = 15 * 60 * 1000
const MAX_JSONL_LINE_BYTES = 32 * 1024 * 1024
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024
const MAX_REJECTION_CACHE_BYTES = 64 * 1024 * 1024
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024
const SAFE_VIDEO_ID = /^[a-z0-9][a-z0-9._:-]{0,255}$/i

type JsonlPlanKind =
  | 'video-manifest'
  | 'frame-manifest'
  | 'embedding'
  | 'audio-staging'
  | 'image-log'
type JsonDocumentPlanKind = 'audio-job' | 'frame-checkpoint' | 'image-rejections'

interface FileFingerprint {
  filePath: string
  size: number
  mtimeMs: number
}

interface JsonlEditPlan extends FileFingerprint {
  kind: JsonlPlanKind
  matchedRecords: number
  matchedBytes: number
}

interface JsonDocumentEditPlan extends FileFingerprint {
  kind: JsonDocumentPlanKind
  matchedRecords: number
  matchedBytes?: number
}

interface ArtifactPlan {
  filePath: string
  fileCount: number
  bytes: number
}

interface VideoCleanupPlan {
  mediaRoot: string
  sourceKey: string
  videoIds: string[]
  frameRoots: string[]
  jsonl: JsonlEditPlan[]
  documents: JsonDocumentEditPlan[]
  artifacts: ArtifactPlan[]
  sharedCaches: ArtifactPlan[]
  semanticDatabasePaths: string[]
  semanticStats: VideoSemanticVideoDataStats
  categories: SourceDerivedDataCategory[]
  warnings: string[]
}

interface StoredPreview {
  preview: SourceDerivedDataPreview
  userDataPath: string
  sourceKey: string
  imageToken?: string
  imageVectorBytes: number
  videoEmbeddingRecords: number
  thumbnailSources: Array<{ path: string; mtimeMs: number }>
  thumbnailPlan: ThumbnailCacheFolderPlan
  subjectEmbeddings: SourceScopedFilePlan | null
  managedHistory: ManagedAutomationHistoryPlan
  video: VideoCleanupPlan
}

export interface SourceDerivedDataCleanupHooks {
  image?: FolderDataEditHooks
  cleanupImageArtifacts?: (
    sources: readonly { path: string; mtimeMs: number }[],
    folder: string,
  ) => Promise<{
    deletedFiles: number
    freedBytes: number
    removedRecords?: number
    warnings?: string[]
  }>
  cleanupLegacyFrameVectors?: (frameRoots: readonly string[]) => Promise<{ removed: number }>
  invalidateRuntimeCaches?: () => void
}

const previews = new Map<string, StoredPreview>()
let running = false
let progress: SourceDerivedDataCleanupProgress = {
  state: 'idle',
  processedBytes: 0,
  totalBytes: 0,
  removedRecords: 0,
}

function updateProgress(update: Partial<SourceDerivedDataCleanupProgress>): void {
  progress = { ...progress, ...update, updatedAt: Date.now() }
}

function emptyResult(error?: string): SourceDerivedDataCleanupResult {
  return {
    ok: false,
    imageRecordsRemoved: 0,
    videoRecordsRemoved: 0,
    totalRecordsRemoved: 0,
    deletedFiles: 0,
    freedBytes: 0,
    originalFilesAffected: 0,
    warnings: [],
    ...(error ? { error } : {}),
  }
}

function emptySemanticStats(): VideoSemanticVideoDataStats {
  return { generations: 0, segments: 0, events: 0, persons: 0, jobs: 0, preferences: 0 }
}

function addSemanticStats(
  target: VideoSemanticVideoDataStats,
  source: VideoSemanticVideoDataStats,
): void {
  for (const key of Object.keys(target) as Array<keyof VideoSemanticVideoDataStats>) {
    target[key] += source[key]
  }
}

function semanticRecordCount(stats: VideoSemanticVideoDataStats): number {
  return Object.values(stats).reduce((sum, value) => sum + value, 0)
}

function safeSourceDirectory(rawSourcePath: string): { sourcePath: string; sourceKey: string } {
  if (
    typeof rawSourcePath !== 'string' ||
    !rawSourcePath.trim() ||
    rawSourcePath.length > 1024 ||
    /[\r\n\0]/.test(rawSourcePath)
  ) {
    throw new Error('Invalid source folder path')
  }
  const sourcePath = path.resolve(rawSourcePath.trim())
  const stat = fs.lstatSync(sourcePath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('The selected source must be a regular folder or drive root')
  }
  return { sourcePath, sourceKey: normalizedImageDataPathKey(sourcePath) }
}

function fileFingerprint(filePath: string): FileFingerprint | null {
  try {
    const stat = fs.lstatSync(filePath)
    return stat.isFile() && !stat.isSymbolicLink()
      ? { filePath: path.resolve(filePath), size: stat.size, mtimeMs: stat.mtimeMs }
      : null
  } catch {
    return null
  }
}

function sameFingerprint(plan: FileFingerprint): boolean {
  const current = fileFingerprint(plan.filePath)
  return Boolean(current && current.size === plan.size && current.mtimeMs === plan.mtimeMs)
}

async function* readBoundedJsonLines(
  filePath: string,
): AsyncGenerator<{ line: string; raw: Buffer; physicalBytes: number }> {
  let pending = Buffer.alloc(0)
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
  for await (const chunkValue of stream) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue)
    const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk
    let lineStart = 0
    for (let cursor = 0; cursor < buffer.length; cursor += 1) {
      if (buffer[cursor] !== 0x0a) continue
      const physical = buffer.subarray(lineStart, cursor + 1)
      const rawLine = buffer.subarray(lineStart, cursor)
      if (rawLine.length > MAX_JSONL_LINE_BYTES) {
        throw new Error(`Generated-data row exceeds 32 MiB: ${path.basename(filePath)}`)
      }
      const content = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, rawLine.length - 1) : rawLine
      yield { line: content.toString('utf8'), raw: physical, physicalBytes: physical.length }
      lineStart = cursor + 1
    }
    const remaining = buffer.length - lineStart
    if (remaining > MAX_JSONL_LINE_BYTES) {
      throw new Error(`Generated-data row exceeds 32 MiB: ${path.basename(filePath)}`)
    }
    pending = remaining ? Buffer.from(buffer.subarray(lineStart)) : Buffer.alloc(0)
  }
  if (pending.length) {
    const content = pending.at(-1) === 0x0d ? pending.subarray(0, pending.length - 1) : pending
    yield { line: content.toString('utf8'), raw: pending, physicalBytes: pending.length }
  }
}

function safeVideoId(value: string | undefined): string | null {
  return value && SAFE_VIDEO_ID.test(value) ? value : null
}

function lineVideoId(line: string): string | null {
  return safeVideoId(extractJsonStringField(line, 'videoId'))
}

function lineMatchesScopePath(
  line: string,
  field: 'path' | 'videoPath',
  sourceKey: string,
): boolean {
  const value = extractJsonStringField(line, field)
  return Boolean(value && isImageDataPathWithin(value, sourceKey))
}

function framePathMatches(line: string, frameRoots: readonly string[]): boolean {
  const imageId = extractJsonStringField(line, 'imageId')
  return Boolean(imageId && frameRoots.some((root) => isImageDataPathWithin(imageId, root)))
}

function shouldRemoveLine(
  kind: JsonlPlanKind,
  line: string,
  sourceKey: string,
  videoIds: ReadonlySet<string>,
  frameRoots: readonly string[],
): boolean {
  if (kind === 'image-log') {
    const imageId = extractJsonStringField(line, 'imageId')
    return Boolean(imageId && isImageDataPathWithin(imageId, sourceKey))
  }
  if (kind === 'embedding') return framePathMatches(line, frameRoots)
  const videoId = lineVideoId(line)
  if (kind === 'audio-staging') return Boolean(videoId && videoIds.has(videoId))
  if (videoId && videoIds.has(videoId)) return true
  return lineMatchesScopePath(line, kind === 'video-manifest' ? 'path' : 'videoPath', sourceKey)
}

async function scanJsonlPlan(
  filePath: string,
  kind: JsonlPlanKind,
  sourceKey: string,
  videoIds: ReadonlySet<string>,
  frameRoots: readonly string[],
): Promise<JsonlEditPlan | null> {
  const fingerprint = fileFingerprint(filePath)
  if (!fingerprint) return null
  let matchedRecords = 0
  let matchedBytes = 0
  let processedBytes = 0
  let rows = 0
  for await (const { line, physicalBytes } of readBoundedJsonLines(filePath)) {
    processedBytes += physicalBytes
    if (shouldRemoveLine(kind, line, sourceKey, videoIds, frameRoots)) {
      matchedRecords += 1
      matchedBytes += physicalBytes
    }
    rows += 1
    if (rows % 1000 === 0) {
      updateProgress({ processedBytes: progress.processedBytes + processedBytes })
      processedBytes = 0
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  updateProgress({ processedBytes: progress.processedBytes + processedBytes })
  return { ...fingerprint, kind, matchedRecords, matchedBytes }
}

async function collectIdsFromManifest(
  filePath: string,
  pathField: 'path' | 'videoPath',
  sourceKey: string,
  ids: Set<string>,
): Promise<void> {
  if (!fileFingerprint(filePath)) return
  let rows = 0
  for await (const { line } of readBoundedJsonLines(filePath)) {
    if (lineMatchesScopePath(line, pathField, sourceKey)) {
      const videoId = lineVideoId(line)
      if (videoId) ids.add(videoId)
    }
    rows += 1
    if (rows % 2000 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

async function transcriptFiles(mediaRoot: string): Promise<string[]> {
  const root = path.join(mediaRoot, 'transcripts')
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
      .map((entry) => path.join(root, entry.name))
  } catch {
    return []
  }
}

async function collectIdsFromTranscripts(
  mediaRoot: string,
  sourceKey: string,
  ids: Set<string>,
): Promise<void> {
  for (const filePath of await transcriptFiles(mediaRoot)) {
    try {
      const stat = await fs.promises.lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSCRIPT_BYTES) continue
      const value = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as {
        videoId?: unknown
        videoPath?: unknown
      }
      if (
        typeof value.videoId === 'string' &&
        typeof value.videoPath === 'string' &&
        isImageDataPathWithin(value.videoPath, sourceKey)
      ) {
        const videoId = safeVideoId(value.videoId)
        if (videoId) ids.add(videoId)
      }
    } catch {
      /* malformed transcripts are preserved because their source cannot be proven */
    }
  }
}

async function inventoryPath(filePath: string): Promise<ArtifactPlan | null> {
  let rootStat: fs.Stats
  try {
    rootStat = await fs.promises.lstat(filePath)
  } catch {
    return null
  }
  if (rootStat.isSymbolicLink()) return null
  if (rootStat.isFile()) return { filePath, fileCount: 1, bytes: rootStat.size }
  if (!rootStat.isDirectory()) return null
  const directories = [filePath]
  let fileCount = 0
  let bytes = 0
  while (directories.length) {
    const directory = directories.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) directories.push(target)
      else if (entry.isFile()) {
        try {
          bytes += (await fs.promises.lstat(target)).size
          fileCount += 1
        } catch {
          /* file changed during preview; execution will report the live result */
        }
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return { filePath, fileCount, bytes }
}

async function addArtifact(
  target: string,
  destination: ArtifactPlan[],
  seen: Set<string>,
): Promise<void> {
  const resolved = path.resolve(target)
  const key = normalizedImageDataPathKey(resolved)
  if (seen.has(key)) return
  seen.add(key)
  const plan = await inventoryPath(resolved)
  if (plan) destination.push(plan)
}

async function listJsonlFiles(directory: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(directory, entry.name))
  } catch {
    return []
  }
}

async function checkpointPlans(
  mediaRoot: string,
  videoIds: ReadonlySet<string>,
): Promise<JsonDocumentEditPlan[]> {
  const root = path.join(mediaRoot, 'manifests', 'video-frame-checkpoints')
  const result: JsonDocumentEditPlan[] = []
  const directories = [root]
  let inspected = 0
  while (directories.length && inspected < 4096) {
    const directory = directories.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) directories.push(target)
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        inspected += 1
        const fingerprint = fileFingerprint(target)
        if (!fingerprint || fingerprint.size > 4 * 1024 * 1024) continue
        try {
          const value = JSON.parse(await fs.promises.readFile(target, 'utf8')) as {
            records?: Array<{ videoId?: unknown }>
          }
          const matchedRecords = Array.isArray(value.records)
            ? value.records.filter(
                (record) => typeof record.videoId === 'string' && videoIds.has(record.videoId),
              ).length
            : 0
          if (matchedRecords > 0) {
            result.push({ ...fingerprint, kind: 'frame-checkpoint', matchedRecords })
          }
        } catch {
          /* corrupt checkpoint is not attributed to this source */
        }
      }
    }
  }
  return result
}

async function audioJobPlan(
  mediaRoot: string,
  videoIds: ReadonlySet<string>,
): Promise<JsonDocumentEditPlan | null> {
  const filePath = path.join(mediaRoot, 'audio-semantic', 'build-job.json')
  const fingerprint = fileFingerprint(filePath)
  if (!fingerprint || fingerprint.size > 16 * 1024 * 1024) return null
  try {
    const value = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as {
      videos?: Array<{ videoId?: unknown }>
    }
    const matchedRecords = Array.isArray(value.videos)
      ? value.videos.filter(
          (video) => typeof video.videoId === 'string' && videoIds.has(video.videoId),
        ).length
      : 0
    return matchedRecords > 0 ? { ...fingerprint, kind: 'audio-job', matchedRecords } : null
  } catch {
    return null
  }
}

async function imageDiagnosticLogFiles(userDataPath: string): Promise<string[]> {
  const vectorDb = path.join(path.resolve(userDataPath), 'vector-db')
  try {
    return (await fs.promises.readdir(vectorDb, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          (entry.name === 'embedding_failures.jsonl' ||
            entry.name === 'embedding_diagnostics.jsonl' ||
            /^embedding_diagnostics\.jsonl\..+\.bak$/i.test(entry.name)),
      )
      .map((entry) => path.join(vectorDb, entry.name))
      .sort()
  } catch {
    return []
  }
}

async function imageRejectionPlan(
  userDataPath: string,
  sourceKey: string,
): Promise<JsonDocumentEditPlan | null> {
  const filePath = path.join(
    path.resolve(userDataPath),
    'vector-db',
    'embedding-input-rejections.json',
  )
  const fingerprint = fileFingerprint(filePath)
  if (!fingerprint || fingerprint.size > MAX_REJECTION_CACHE_BYTES) return null
  try {
    const raw = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as {
      entries?: Record<string, unknown>
    }
    if (!raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) return null
    const matches = Object.entries(raw.entries).filter(([imagePath]) =>
      isImageDataPathWithin(imagePath, sourceKey),
    )
    if (matches.length === 0) return null
    return {
      ...fingerprint,
      kind: 'image-rejections',
      matchedRecords: matches.length,
      matchedBytes: matches.reduce(
        (sum, [imagePath, value]) =>
          sum + Buffer.byteLength(JSON.stringify({ [imagePath]: value })),
        0,
      ),
    }
  } catch {
    return null
  }
}

async function collectVideoArtifacts(
  mediaRoot: string,
  ids: ReadonlySet<string>,
): Promise<{ artifacts: ArtifactPlan[]; sharedCaches: ArtifactPlan[] }> {
  const artifacts: ArtifactPlan[] = []
  const sharedCaches: ArtifactPlan[] = []
  const seen = new Set<string>()
  for (const videoId of ids) {
    await addArtifact(path.join(mediaRoot, 'frames', videoId), artifacts, seen)
    await addArtifact(path.join(mediaRoot, 'thumbnails', videoId), artifacts, seen)
    for (const name of [`${videoId}.json`, `${videoId}.srt`, `asr-${videoId}.json`]) {
      await addArtifact(path.join(mediaRoot, 'transcripts', name), artifacts, seen)
    }
    for (const name of [`${videoId}.json`, `${videoId}.jsonl`]) {
      await addArtifact(path.join(mediaRoot, 'ocr', name), artifacts, seen)
    }
    await addArtifact(path.join(mediaRoot, 'ocr', videoId), artifacts, seen)
  }
  const speakerRoot = path.join(mediaRoot, 'audio-semantic', 'speaker-states')
  try {
    for (const entry of await fs.promises.readdir(speakerRoot, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        [...ids].some((videoId) => entry.name.endsWith(`.${videoId}.json`))
      ) {
        await addArtifact(path.join(speakerRoot, entry.name), artifacts, seen)
      }
    }
  } catch {
    /* optional directory */
  }
  if (ids.size > 0) {
    for (const relative of [
      ['vectors', 'frame_embedding_index.jsonl'],
      ['vectors', 'frame_embedding_index.meta.json'],
      ['stats', 'frame_embedding_stats.json'],
      ['audio-semantic', 'transcript-stats.json'],
    ]) {
      await addArtifact(path.join(mediaRoot, ...relative), sharedCaches, seen)
    }
  }
  return { artifacts, sharedCaches }
}

async function collectVectorCacheArtifacts(
  userDataPath: string,
  embeddingPlans: readonly JsonlEditPlan[],
  sharedCaches: ArtifactPlan[],
): Promise<void> {
  if (!embeddingPlans.some((plan) => plan.matchedRecords > 0)) return
  const vectorDb = path.join(userDataPath, 'vector-db')
  const seen = new Set(sharedCaches.map((plan) => normalizedImageDataPathKey(plan.filePath)))
  for (const relative of [
    'vector_index_manifest.json',
    'clip_embedding_cache.json',
    'clip_embedding_cache.f32',
    'clip_embedding_paths.jsonl',
  ]) {
    await addArtifact(path.join(vectorDb, relative), sharedCaches, seen)
  }
  const modelBases = new Set(
    embeddingPlans
      .filter((plan) => path.dirname(plan.filePath).endsWith(`${path.sep}embeddings`))
      .map((plan) => path.basename(plan.filePath, '.jsonl')),
  )
  try {
    const cacheDir = path.join(vectorDb, 'embedding-cache')
    for (const entry of await fs.promises.readdir(cacheDir, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        [...modelBases].some((base) => entry.name.startsWith(`${base}.`))
      ) {
        await addArtifact(path.join(cacheDir, entry.name), sharedCaches, seen)
      }
    }
  } catch {
    /* optional cache directory */
  }
}

function uniqueSemanticDatabasePaths(userDataPath: string, mediaRoot: string): string[] {
  return [
    path.join(userDataPath, 'media-search', VIDEO_SEMANTIC_DATABASE_FILENAME),
    path.join(mediaRoot, VIDEO_SEMANTIC_DATABASE_FILENAME),
  ].filter(
    (candidate, index, values) =>
      values.findIndex(
        (value) => normalizedImageDataPathKey(value) === normalizedImageDataPathKey(candidate),
      ) === index && fileFingerprint(candidate),
  )
}

function category(
  id: SourceDerivedDataCategory['id'],
  recordCount: number,
  files: readonly (ArtifactPlan | JsonlEditPlan)[],
  exactBytes: boolean,
): SourceDerivedDataCategory {
  return {
    id,
    recordCount,
    fileCount: files.reduce(
      (sum, item) => sum + ('fileCount' in item ? item.fileCount : item.matchedRecords > 0 ? 1 : 0),
      0,
    ),
    estimatedBytes: files.reduce(
      (sum, item) => sum + ('bytes' in item ? item.bytes : item.matchedBytes),
      0,
    ),
    exactBytes,
  }
}

async function previewVideoCleanup(options: {
  userDataPath: string
  mediaRoot: string
  sourceKey: string
}): Promise<VideoCleanupPlan> {
  const mediaRoot = path.resolve(options.mediaRoot)
  const videoManifest = path.join(mediaRoot, 'manifests', 'video_files.jsonl')
  const frameManifest = path.join(mediaRoot, 'manifests', 'video_frames.jsonl')
  const videoIds = new Set<string>()
  await collectIdsFromManifest(videoManifest, 'path', options.sourceKey, videoIds)
  await collectIdsFromManifest(frameManifest, 'videoPath', options.sourceKey, videoIds)
  await collectIdsFromTranscripts(mediaRoot, options.sourceKey, videoIds)
  const frameRoots = [...videoIds].map((videoId) => path.join(mediaRoot, 'frames', videoId))
  const jsonl: JsonlEditPlan[] = []
  const appendPlan = async (filePath: string, kind: JsonlPlanKind) => {
    const plan = await scanJsonlPlan(filePath, kind, options.sourceKey, videoIds, frameRoots)
    if (plan) jsonl.push(plan)
  }
  await appendPlan(videoManifest, 'video-manifest')
  await appendPlan(frameManifest, 'frame-manifest')
  const embeddingFiles = [
    path.join(options.userDataPath, 'vector-db', 'image_embeddings.jsonl'),
    ...(await listJsonlFiles(path.join(options.userDataPath, 'vector-db', 'embeddings'))).filter(
      (filePath) => filePath.toLowerCase().endsWith('__global.jsonl'),
    ),
  ]
  for (const filePath of [...new Set(embeddingFiles.map((value) => path.resolve(value)))]) {
    await appendPlan(filePath, 'embedding')
  }
  for (const filePath of await listJsonlFiles(path.join(mediaRoot, 'audio-semantic', 'staging'))) {
    await appendPlan(filePath, 'audio-staging')
  }
  for (const filePath of await imageDiagnosticLogFiles(options.userDataPath)) {
    await appendPlan(filePath, 'image-log')
  }
  const documents = await checkpointPlans(mediaRoot, videoIds)
  const jobPlan = await audioJobPlan(mediaRoot, videoIds)
  if (jobPlan) documents.push(jobPlan)
  const rejectionPlan = await imageRejectionPlan(options.userDataPath, options.sourceKey)
  if (rejectionPlan) documents.push(rejectionPlan)
  const { artifacts, sharedCaches } = await collectVideoArtifacts(mediaRoot, videoIds)
  const embeddingPlans = jsonl.filter((plan) => plan.kind === 'embedding')
  await collectVectorCacheArtifacts(options.userDataPath, embeddingPlans, sharedCaches)
  const semanticDatabasePaths = uniqueSemanticDatabasePaths(options.userDataPath, mediaRoot)
  const semanticStats = emptySemanticStats()
  for (const databasePath of semanticDatabasePaths) {
    const database = new VideoSemanticDatabase(databasePath, {
      readOnly: true,
      immutable: true,
    })
    try {
      addSemanticStats(semanticStats, database.previewVideoData([...videoIds]))
    } finally {
      database.close()
    }
  }
  const videoPlans = jsonl.filter((plan) => plan.kind === 'video-manifest')
  const framePlans = jsonl.filter((plan) => plan.kind === 'frame-manifest')
  const audioPlans = jsonl.filter((plan) => plan.kind === 'audio-staging')
  const videoDocuments = documents.filter((plan) => plan.kind !== 'image-rejections')
  const transcriptArtifacts = artifacts.filter((plan) =>
    ['transcripts', 'ocr', 'audio-semantic'].includes(
      path.relative(mediaRoot, plan.filePath).split(path.sep)[0]?.toLowerCase(),
    ),
  )
  const frameArtifacts = artifacts.filter((plan) => !transcriptArtifacts.includes(plan))
  const categories: SourceDerivedDataCategory[] = [
    category(
      'video-catalog',
      videoPlans.reduce((sum, plan) => sum + plan.matchedRecords, 0),
      videoPlans,
      true,
    ),
    category(
      'video-frames-thumbnails',
      framePlans.reduce((sum, plan) => sum + plan.matchedRecords, 0),
      [...framePlans, ...frameArtifacts],
      true,
    ),
    category(
      'video-model-vectors',
      embeddingPlans.reduce((sum, plan) => sum + plan.matchedRecords, 0),
      embeddingPlans,
      true,
    ),
    category(
      'video-transcripts-ocr',
      audioPlans.reduce((sum, plan) => sum + plan.matchedRecords, 0) +
        videoDocuments.reduce((sum, plan) => sum + plan.matchedRecords, 0),
      [...audioPlans, ...transcriptArtifacts],
      true,
    ),
    {
      id: 'video-semantics',
      recordCount: semanticRecordCount(semanticStats),
      fileCount: semanticRecordCount(semanticStats) > 0 ? semanticDatabasePaths.length : 0,
      estimatedBytes: 0,
      exactBytes: false,
    },
    category('shared-rebuildable-caches', 0, sharedCaches, true),
  ]
  const warnings: string[] = []
  if (videoIds.size === 0) {
    warnings.push('No source-linked video records were found for this folder')
  }
  return {
    mediaRoot,
    sourceKey: options.sourceKey,
    videoIds: [...videoIds],
    frameRoots,
    jsonl,
    documents,
    artifacts,
    sharedCaches,
    semanticDatabasePaths,
    semanticStats,
    categories,
    warnings,
  }
}

function totalCategoryRecords(categories: readonly SourceDerivedDataCategory[]): number {
  return categories.reduce((sum, item) => sum + item.recordCount, 0)
}

function totalCategoryFiles(categories: readonly SourceDerivedDataCategory[]): number {
  return categories.reduce((sum, item) => sum + item.fileCount, 0)
}

function totalCategoryBytes(categories: readonly SourceDerivedDataCategory[]): number {
  return categories.reduce((sum, item) => sum + item.estimatedBytes, 0)
}

export async function previewSourceDerivedDataCleanup(options: {
  userDataPath: string
  mediaRoot: string
  sourcePath: string
  nativeStats: {
    count: number
    totalBytes: number
    replacedCount?: number
    deletedCount?: number
  }
  thumbnailSources?: Array<{ path: string; mtimeMs: number }>
  additionalImagePaths?: string[]
  historyPolicy?: SourceDerivedDataHistoryPolicy
}): Promise<SourceDerivedDataPreview> {
  if (running) {
    return {
      ok: false,
      categories: [],
      imageRecords: 0,
      videoRecords: 0,
      totalRecords: 0,
      fileCount: 0,
      estimatedBytes: 0,
      originalFilesAffected: 0,
      warnings: [],
      error: 'Another source cleanup operation is already running',
    }
  }
  const startedAt = Date.now()
  try {
    const source = safeSourceDirectory(options.sourcePath)
    running = true
    progress = {
      state: 'previewing',
      phase: 'images',
      sourcePath: source.sourcePath,
      processedBytes: 0,
      totalBytes: 0,
      removedRecords: 0,
      startedAt,
      updatedAt: startedAt,
    }
    updateProgress({ phase: 'subject-vectors' })
    const subjectEmbeddings = await previewSubjectEmbeddingSourceCleanup(
      options.userDataPath,
      source.sourcePath,
    )
    const historyPolicy: SourceDerivedDataHistoryPolicy =
      options.historyPolicy === 'remove-source-traces' ? 'remove-source-traces' : 'preserve-audit'
    updateProgress({ phase: 'managed-history' })
    const managedHistory = await previewManagedAutomationHistory(
      options.userDataPath,
      source.sourcePath,
      historyPolicy,
    )
    updateProgress({ phase: 'video-manifests' })
    const video = await previewVideoCleanup({
      userDataPath: path.resolve(options.userDataPath),
      mediaRoot: options.mediaRoot,
      sourceKey: source.sourceKey,
    })
    updateProgress({ phase: 'images' })
    const thumbnailPlan = await previewThumbnailCacheForFolder(
      options.userDataPath,
      source.sourcePath,
      options.thumbnailSources || [],
    )
    const image = await previewImageSearchFolderDataEdit({
      userDataPath: options.userDataPath,
      folder: source.sourcePath,
      layers: ['native', 'dino', 'clip'],
      allowedRoots: [source.sourcePath],
      nativeStats: options.nativeStats,
      allowFilesystemRoot: true,
      additionalFolders: [...video.frameRoots, ...(options.additionalImagePaths || [])],
    })
    if (!image.ok) throw new Error(image.error || 'Could not analyze image-derived data')
    const videoEmbeddingRecords = video.jsonl
      .filter((plan) => plan.kind === 'embedding')
      .reduce((sum, plan) => sum + plan.matchedRecords, 0)
    const videoEmbeddingBytes = video.jsonl
      .filter((plan) => plan.kind === 'embedding')
      .reduce((sum, plan) => sum + plan.matchedBytes, 0)
    const allModelRecords = (image.dino?.recordCount || 0) + (image.clip?.recordCount || 0)
    if (allModelRecords > 0) {
      const vectorDbKey = normalizedImageDataPathKey(
        path.join(path.resolve(options.userDataPath), 'vector-db'),
      )
      const alreadyInventoried = video.sharedCaches.filter((item) =>
        isImageDataPathWithin(item.filePath, vectorDbKey),
      )
      const sharedCategory = video.categories.find(
        (item) => item.id === 'shared-rebuildable-caches',
      )
      if (sharedCategory) {
        sharedCategory.fileCount += Math.max(
          0,
          (image.invalidatedCacheFiles || 0) -
            alreadyInventoried.reduce((sum, item) => sum + item.fileCount, 0),
        )
        sharedCategory.estimatedBytes += Math.max(
          0,
          (image.invalidatedCacheBytes || 0) -
            alreadyInventoried.reduce((sum, item) => sum + item.bytes, 0),
        )
      }
      const seenSharedCaches = new Set(
        video.sharedCaches.map((item) => normalizedImageDataPathKey(item.filePath)),
      )
      const previousCount = video.sharedCaches.length
      await addArtifact(
        path.join(path.resolve(options.userDataPath), 'vector-db', 'vector-store'),
        video.sharedCaches,
        seenSharedCaches,
      )
      const added = video.sharedCaches.slice(previousCount)
      if (sharedCategory) {
        sharedCategory.fileCount += added.reduce((sum, item) => sum + item.fileCount, 0)
        sharedCategory.estimatedBytes += added.reduce((sum, item) => sum + item.bytes, 0)
      }
    }
    const imageModelRecords = Math.max(0, allModelRecords - videoEmbeddingRecords)
    const allModelBytes = (image.dino?.matchedBytes || 0) + (image.clip?.matchedBytes || 0)
    const diagnosticLogs = video.jsonl.filter((plan) => plan.kind === 'image-log')
    const diagnosticDocuments = video.documents.filter((plan) => plan.kind === 'image-rejections')
    const diagnosticRecords =
      diagnosticLogs.reduce((sum, plan) => sum + plan.matchedRecords, 0) +
      diagnosticDocuments.reduce((sum, plan) => sum + plan.matchedRecords, 0)
    const subjectEmbeddingRecords = subjectEmbeddings?.matchedRecords || 0
    const imageRecords =
      (image.native?.count || 0) + imageModelRecords + subjectEmbeddingRecords + diagnosticRecords
    const imageCategories: SourceDerivedDataCategory[] = [
      {
        id: 'image-native-index',
        recordCount: image.native?.count || 0,
        fileCount:
          (image.native?.fileCount || 0) > 0 ||
          Number(options.nativeStats.replacedCount || 0) > 0 ||
          Number(options.nativeStats.deletedCount || 0) > 0
            ? 1
            : 0,
        estimatedBytes: 0,
        exactBytes: false,
      },
      {
        id: 'image-model-vectors',
        recordCount: imageModelRecords,
        fileCount:
          (image.dino?.recordCount ? image.dino.fileCount : 0) +
          (image.clip?.recordCount ? image.clip.fileCount : 0),
        estimatedBytes: Math.max(0, allModelBytes - videoEmbeddingBytes),
        exactBytes: true,
      },
      {
        id: 'image-subject-vectors',
        recordCount: subjectEmbeddingRecords,
        fileCount: subjectEmbeddingRecords > 0 ? 1 : 0,
        estimatedBytes: subjectEmbeddings?.matchedBytes || 0,
        exactBytes: true,
      },
      {
        id: 'image-thumbnails-previews',
        recordCount: 0,
        fileCount: thumbnailPlan.files.length,
        estimatedBytes: thumbnailPlan.files.reduce((sum, item) => sum + item.size, 0),
        exactBytes: thumbnailPlan.complete,
      },
      {
        id: 'image-diagnostics',
        recordCount: diagnosticRecords,
        fileCount:
          diagnosticLogs.filter((plan) => plan.matchedRecords > 0).length +
          diagnosticDocuments.filter((plan) => plan.matchedRecords > 0).length,
        estimatedBytes:
          diagnosticLogs.reduce((sum, plan) => sum + plan.matchedBytes, 0) +
          diagnosticDocuments.reduce((sum, plan) => sum + (plan.matchedBytes || 0), 0),
        exactBytes: false,
      },
    ]
    const managedHistoryCategory: SourceDerivedDataCategory = {
      id: 'managed-automation-history',
      recordCount: historyPolicy === 'remove-source-traces' ? managedHistory.traceRecords : 0,
      fileCount: historyPolicy === 'remove-source-traces' ? managedHistory.files.length : 0,
      estimatedBytes: historyPolicy === 'remove-source-traces' ? managedHistory.traceBytes : 0,
      exactBytes: false,
    }
    const categories = [...imageCategories, ...video.categories, managedHistoryCategory]
    const videoRecords = totalCategoryRecords(video.categories)
    const historyRecords = managedHistoryCategory.recordCount
    const createdAt = Date.now()
    const token = `source-cleanup-${createdAt}-${crypto.randomBytes(16).toString('hex')}`
    const preview: SourceDerivedDataPreview = {
      ok: true,
      token,
      sourcePath: source.sourcePath,
      createdAt,
      expiresAt: createdAt + PREVIEW_TTL_MS,
      categories,
      imageRecords,
      videoRecords,
      totalRecords: imageRecords + videoRecords + historyRecords,
      fileCount: totalCategoryFiles(categories),
      estimatedBytes: totalCategoryBytes(categories),
      originalFilesAffected: 0,
      historyPolicy,
      preservedAuditTraceRecords:
        historyPolicy === 'preserve-audit' ? managedHistory.traceRecords : 0,
      preservedAuditTraceFiles:
        historyPolicy === 'preserve-audit' ? managedHistory.files.length : 0,
      warnings: [
        ...video.warnings,
        ...thumbnailPlan.warnings,
        ...managedHistory.warnings,
        ...(managedHistory.traceRecords > 0 && historyPolicy === 'preserve-audit'
          ? [
              `Preserved ${managedHistory.traceRecords} source path traces in ${managedHistory.files.length} whitelisted value-automation audit files; explicit trace removal was not selected`,
            ]
          : []),
        ...(historyPolicy === 'remove-source-traces'
          ? [
              'Explicit source-trace removal is enabled only for whitelisted value-automation state and output files; all other logs remain untouched',
            ]
          : []),
        ...(Number(options.nativeStats.replacedCount || 0) > 0 ||
        Number(options.nativeStats.deletedCount || 0) > 0
          ? [
              `Native index has ${
                Number(options.nativeStats.replacedCount || 0) +
                Number(options.nativeStats.deletedCount || 0)
              } persisted overlay entries; execution will physically compact them`,
            ]
          : []),
      ],
    }
    previews.clear()
    previews.set(token, {
      preview,
      userDataPath: path.resolve(options.userDataPath),
      sourceKey: source.sourceKey,
      imageToken: image.token,
      imageVectorBytes: (image.dino?.matchedBytes || 0) + (image.clip?.matchedBytes || 0),
      videoEmbeddingRecords,
      thumbnailSources: options.thumbnailSources || [],
      thumbnailPlan,
      subjectEmbeddings,
      managedHistory,
      video,
    })
    updateProgress({ state: 'ready', phase: 'finalizing', finishedAt: Date.now() })
    return preview
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    updateProgress({ state: 'error', error: message, finishedAt: Date.now() })
    return {
      ok: false,
      categories: [],
      imageRecords: 0,
      videoRecords: 0,
      totalRecords: 0,
      fileCount: 0,
      estimatedBytes: 0,
      originalFilesAffected: 0,
      warnings: [],
      error: message,
    }
  } finally {
    running = false
  }
}

function assertVideoPlanFresh(plan: VideoCleanupPlan, includeEmbeddings = true): void {
  for (const item of [
    ...plan.jsonl.filter((entry) => includeEmbeddings || entry.kind !== 'embedding'),
    ...plan.documents,
  ]) {
    if (!sameFingerprint(item)) {
      throw new Error(`Generated data changed after preview: ${path.basename(item.filePath)}`)
    }
  }
}

function persistedJobBusy(plan: VideoCleanupPlan): string | null {
  const selected = new Set(plan.videoIds)
  const audioJobPath = path.join(plan.mediaRoot, 'audio-semantic', 'build-job.json')
  try {
    const job = JSON.parse(fs.readFileSync(audioJobPath, 'utf8')) as {
      state?: unknown
      videos?: Array<{ videoId?: unknown }>
    }
    if (
      (job.state === 'queued' || job.state === 'running') &&
      job.videos?.some((video) => typeof video.videoId === 'string' && selected.has(video.videoId))
    ) {
      return 'An audio semantic build is using this source'
    }
  } catch {
    /* no active persisted audio job */
  }
  for (const databasePath of plan.semanticDatabasePaths) {
    const database = new VideoSemanticDatabase(databasePath, {
      readOnly: true,
      immutable: true,
    })
    try {
      if (
        plan.videoIds.some((videoId) =>
          database
            .listJobs(videoId)
            .some((job) => job.state === 'queued' || job.state === 'running'),
        )
      ) {
        return 'A video semantic build is using this source'
      }
    } finally {
      database.close()
    }
  }
  return null
}

async function finishWriter(writer: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    writer.once('error', reject)
    writer.once('finish', resolve)
    writer.end()
  })
}

async function writeChunk(writer: fs.WriteStream, value: Uint8Array): Promise<void> {
  if (writer.write(value)) return
  await new Promise<void>((resolve, reject) => {
    writer.once('error', reject)
    writer.once('drain', resolve)
  })
}

interface SwitchedFile {
  sourcePath: string
  backupPath: string
  installed: boolean
  removedBytes: number
}

async function rewriteJsonl(
  plan: JsonlEditPlan,
  context: VideoCleanupPlan,
  selected: ReadonlySet<string>,
): Promise<SwitchedFile> {
  const stamp = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
  const temporaryPath = `${plan.filePath}.source-cleanup-${process.pid}-${stamp}.tmp`
  const backupPath = `${plan.filePath}.source-cleanup-backup-${stamp}`
  const writer = fs.createWriteStream(temporaryPath, { flags: 'wx' })
  let removedRecords = 0
  let removedBytes = 0
  try {
    for await (const { line, raw, physicalBytes } of readBoundedJsonLines(plan.filePath)) {
      if (shouldRemoveLine(plan.kind, line, context.sourceKey, selected, context.frameRoots)) {
        removedRecords += 1
        removedBytes += physicalBytes
      } else {
        await writeChunk(writer, raw)
      }
    }
    await finishWriter(writer)
    if (removedRecords !== plan.matchedRecords || removedBytes !== plan.matchedBytes) {
      throw new Error(`Preview no longer matches ${path.basename(plan.filePath)}`)
    }
    if (!sameFingerprint(plan)) {
      throw new Error(`Generated data changed during cleanup: ${path.basename(plan.filePath)}`)
    }
    await fs.promises.rename(plan.filePath, backupPath)
    try {
      await fs.promises.rename(temporaryPath, plan.filePath)
    } catch (error) {
      await fs.promises.rename(backupPath, plan.filePath)
      throw error
    }
    return { sourcePath: plan.filePath, backupPath, installed: true, removedBytes }
  } catch (error) {
    writer.destroy()
    await fs.promises.unlink(temporaryPath).catch(() => {})
    throw error
  }
}

function filteredDocument(
  plan: JsonDocumentEditPlan,
  raw: Record<string, unknown>,
  selected: ReadonlySet<string>,
  sourceKey: string,
): { serialized: string | null; removed: number } {
  if (plan.kind === 'image-rejections') {
    const entries =
      raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)
        ? (raw.entries as Record<string, unknown>)
        : {}
    const retained = Object.fromEntries(
      Object.entries(entries).filter(([imagePath]) => !isImageDataPathWithin(imagePath, sourceKey)),
    )
    return {
      serialized: JSON.stringify({ ...raw, entries: retained }),
      removed: Object.keys(entries).length - Object.keys(retained).length,
    }
  }
  if (plan.kind === 'frame-checkpoint') {
    const records = Array.isArray(raw.records) ? raw.records : []
    const retained = records.filter(
      (record) =>
        !record ||
        typeof record !== 'object' ||
        typeof (record as { videoId?: unknown }).videoId !== 'string' ||
        !selected.has((record as { videoId: string }).videoId),
    )
    return {
      serialized: retained.length ? JSON.stringify({ ...raw, records: retained }) : null,
      removed: records.length - retained.length,
    }
  }
  const videos = Array.isArray(raw.videos) ? raw.videos : []
  const retained = videos.filter(
    (video) =>
      !video ||
      typeof video !== 'object' ||
      typeof (video as { videoId?: unknown }).videoId !== 'string' ||
      !selected.has((video as { videoId: string }).videoId),
  ) as Array<{ chunks?: unknown[] }>
  if (!retained.length) return { serialized: null, removed: videos.length }
  const totalSegments = retained.reduce(
    (sum, video) => sum + (Array.isArray(video.chunks) ? video.chunks.length : 0),
    0,
  )
  const completed = raw.state === 'completed'
  const next: Record<string, unknown> = {
    ...raw,
    videos: retained,
    state: completed ? 'completed' : 'stopped',
    videoCursor: completed ? retained.length : 0,
    segmentCursor: 0,
    totalVideos: retained.length,
    completedVideos: completed ? retained.length : 0,
    totalSegments,
    completedSegments: completed ? totalSegments : 0,
    failedSegments: 0,
    updatedAt: Date.now(),
  }
  delete next.currentVideoId
  delete next.currentStartMs
  delete next.currentEndMs
  return { serialized: JSON.stringify(next), removed: videos.length - retained.length }
}

async function rewriteDocument(
  plan: JsonDocumentEditPlan,
  selected: ReadonlySet<string>,
  sourceKey: string,
): Promise<SwitchedFile> {
  const raw = JSON.parse(await fs.promises.readFile(plan.filePath, 'utf8')) as Record<
    string,
    unknown
  >
  const filtered = filteredDocument(plan, raw, selected, sourceKey)
  if (filtered.removed !== plan.matchedRecords) {
    throw new Error(`Preview no longer matches ${path.basename(plan.filePath)}`)
  }
  const stamp = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
  const backupPath = `${plan.filePath}.source-cleanup-backup-${stamp}`
  const temporaryPath = `${plan.filePath}.source-cleanup-${process.pid}-${stamp}.tmp`
  if (filtered.serialized !== null) {
    await fs.promises.writeFile(temporaryPath, filtered.serialized, {
      encoding: 'utf8',
      flag: 'wx',
    })
  }
  if (!sameFingerprint(plan)) {
    await fs.promises.unlink(temporaryPath).catch(() => {})
    throw new Error(`Generated data changed during cleanup: ${path.basename(plan.filePath)}`)
  }
  await fs.promises.rename(plan.filePath, backupPath)
  if (filtered.serialized !== null) {
    try {
      await fs.promises.rename(temporaryPath, plan.filePath)
    } catch (error) {
      await fs.promises.rename(backupPath, plan.filePath)
      throw error
    }
  }
  return {
    sourcePath: plan.filePath,
    backupPath,
    installed: filtered.serialized !== null,
    removedBytes:
      filtered.serialized === null
        ? plan.size
        : Math.max(0, plan.size - Buffer.byteLength(filtered.serialized)),
  }
}

async function rollbackSwitchedFiles(switched: readonly SwitchedFile[]): Promise<string[]> {
  const warnings: string[] = []
  for (const item of [...switched].reverse()) {
    try {
      if (item.installed) await fs.promises.unlink(item.sourcePath).catch(() => {})
      await fs.promises.rename(item.backupPath, item.sourcePath)
    } catch (error: unknown) {
      warnings.push(
        `Rollback failed for ${path.basename(item.sourcePath)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return warnings
}

async function purgeBackups(switched: readonly SwitchedFile[]): Promise<string[]> {
  const warnings: string[] = []
  for (const item of switched) {
    try {
      await fs.promises.unlink(item.backupPath)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        warnings.push(
          `Could not purge cleanup backup ${path.basename(item.backupPath)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }
  return warnings
}

async function removeArtifact(plan: ArtifactPlan): Promise<{
  deletedFiles: number
  freedBytes: number
  warning?: string
}> {
  const live = await inventoryPath(plan.filePath)
  if (!live) return { deletedFiles: 0, freedBytes: 0 }
  try {
    const stat = await fs.promises.lstat(plan.filePath)
    if (stat.isSymbolicLink())
      return { deletedFiles: 0, freedBytes: 0, warning: 'Skipped linked cache' }
    if (stat.isDirectory()) await fs.promises.rm(plan.filePath, { recursive: true, force: true })
    else if (stat.isFile()) await fs.promises.unlink(plan.filePath)
    return { deletedFiles: live.fileCount, freedBytes: live.bytes }
  } catch (error: unknown) {
    return {
      deletedFiles: 0,
      freedBytes: 0,
      warning: `Could not remove ${path.basename(plan.filePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

async function executeVideoCleanup(
  plan: VideoCleanupPlan,
  hooks: SourceDerivedDataCleanupHooks,
): Promise<{
  removedRecords: number
  deletedFiles: number
  freedBytes: number
  diagnosticRecordsRemoved: number
  warnings: string[]
}> {
  assertVideoPlanFresh(plan, false)
  const busy = persistedJobBusy(plan)
  if (busy) throw new Error(busy)
  const selected = new Set(plan.videoIds)
  const changedJsonl = plan.jsonl.filter(
    (item) => item.kind !== 'embedding' && item.matchedRecords > 0,
  )
  const changedDocuments = plan.documents.filter((item) => item.matchedRecords > 0)
  const requiredBytes =
    changedJsonl.reduce((sum, item) => sum + Math.max(0, item.size - item.matchedBytes), 0) +
    changedDocuments.reduce((sum, item) => sum + item.size, 0) +
    FREE_SPACE_MARGIN_BYTES
  const diskRoot = fileFingerprint(changedJsonl[0]?.filePath || '')?.filePath
  if (diskRoot) {
    const disk = fs.statfsSync(path.dirname(diskRoot))
    if (disk.bavail * disk.bsize < requiredBytes) {
      throw new Error(
        `Not enough free space for atomic source cleanup (${requiredBytes} bytes required)`,
      )
    }
  }
  const switched: SwitchedFile[] = []
  const warnings: string[] = []
  let removedRecords = 0
  let diagnosticRecordsRemoved = 0
  let deletedFiles = 0
  let freedBytes = 0
  try {
    updateProgress({ phase: 'video-manifests' })
    for (const item of changedJsonl) {
      if (item.kind === 'embedding') updateProgress({ phase: 'video-vectors' })
      const switchedFile = await rewriteJsonl(item, plan, selected)
      switched.push(switchedFile)
      if (item.kind === 'image-log') diagnosticRecordsRemoved += item.matchedRecords
      else removedRecords += item.matchedRecords
      freedBytes += switchedFile.removedBytes
      updateProgress({ removedRecords: removedRecords + diagnosticRecordsRemoved })
    }
    for (const item of changedDocuments) {
      const switchedFile = await rewriteDocument(item, selected, plan.sourceKey)
      switched.push(switchedFile)
      if (item.kind === 'image-rejections') diagnosticRecordsRemoved += item.matchedRecords
      else removedRecords += item.matchedRecords
      freedBytes += switchedFile.removedBytes
    }
    for (const databasePath of plan.semanticDatabasePaths) {
      const database = new VideoSemanticDatabase(databasePath)
      try {
        const removed = database.deleteVideoData(plan.videoIds)
        removedRecords += semanticRecordCount(removed)
      } finally {
        database.close()
      }
    }
    if (hooks.cleanupLegacyFrameVectors && plan.frameRoots.length > 0) {
      const legacy = await hooks.cleanupLegacyFrameVectors(plan.frameRoots)
      removedRecords += legacy.removed
    }
    updateProgress({ phase: 'video-artifacts' })
    for (const artifact of [...plan.artifacts, ...plan.sharedCaches]) {
      const removed = await removeArtifact(artifact)
      deletedFiles += removed.deletedFiles
      freedBytes += removed.freedBytes
      if (removed.warning) warnings.push(removed.warning)
    }
    if (changedJsonl.some((item) => item.kind === 'frame-manifest')) {
      const lookupPath = path.join(plan.mediaRoot, 'manifests', 'video_frames.lookup.sqlite')
      for (const candidate of [
        lookupPath,
        `${lookupPath}-journal`,
        `${lookupPath}-wal`,
        `${lookupPath}-shm`,
      ]) {
        try {
          await fs.promises.unlink(candidate)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            warnings.push(`Could not invalidate ${path.basename(candidate)}`)
          }
        }
      }
    }
    warnings.push(...(await purgeBackups(switched)))
    return { removedRecords, diagnosticRecordsRemoved, deletedFiles, freedBytes, warnings }
  } catch (error) {
    warnings.push(...(await rollbackSwitchedFiles(switched)))
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(warnings.length ? `${message}; ${warnings.join('; ')}` : message, {
      cause: error,
    })
  }
}

export async function executeSourceDerivedDataCleanup(options: {
  userDataPath: string
  token: string
  hooks?: SourceDerivedDataCleanupHooks
}): Promise<SourceDerivedDataCleanupResult> {
  if (running) return emptyResult('Another source cleanup operation is already running')
  const stored = previews.get(options.token)
  if (!stored || stored.userDataPath !== path.resolve(options.userDataPath)) {
    return emptyResult('Source cleanup preview is missing or invalid')
  }
  if (!stored.preview.expiresAt || stored.preview.expiresAt < Date.now()) {
    previews.delete(options.token)
    return emptyResult('Source cleanup preview expired; analyze the source again')
  }
  const startedAt = Date.now()
  previews.delete(options.token)
  running = true
  progress = {
    state: 'deleting',
    phase: 'images',
    sourcePath: stored.preview.sourcePath,
    processedBytes: 0,
    totalBytes: stored.preview.estimatedBytes,
    removedRecords: 0,
    startedAt,
    updatedAt: startedAt,
  }
  let imageResult: ImageSearchFolderDataEditResult = { ok: true, removedCount: 0 }
  let imageArtifacts = {
    deletedFiles: 0,
    freedBytes: 0,
    removedRecords: 0,
    warnings: [] as string[],
  }
  let subjectResult = { removedRecords: 0, freedBytes: 0, warnings: [] as string[] }
  let historyResult = { removedRecords: 0, freedBytes: 0, warnings: [] as string[] }
  let imagePhaseCompleted = false
  let videoResult = {
    removedRecords: 0,
    diagnosticRecordsRemoved: 0,
    deletedFiles: 0,
    freedBytes: 0,
    warnings: [] as string[],
  }
  // Each successful phase commits independently. Preserve its actual counters
  // even when a later phase rejects a stale preview or fails.
  const buildResult = (error?: string): SourceDerivedDataCleanupResult => {
    const imageRemovedRows = imageResult.removedRecords
      ? imageResult.removedRecords.native +
        imageResult.removedRecords.dino +
        imageResult.removedRecords.clip
      : imageResult.removedCount || 0
    const removedVideoEmbeddings = imagePhaseCompleted ? stored.videoEmbeddingRecords : 0
    const imageRecordsRemoved =
      Math.max(0, imageRemovedRows - removedVideoEmbeddings) +
      (imageResult.auxiliaryRemoved || 0) +
      imageArtifacts.removedRecords +
      subjectResult.removedRecords +
      videoResult.diagnosticRecordsRemoved
    const videoRecordsRemoved = videoResult.removedRecords + removedVideoEmbeddings
    const automationHistoryRecordsRemoved = historyResult.removedRecords
    const totalRecordsRemoved =
      imageRecordsRemoved + videoRecordsRemoved + automationHistoryRecordsRemoved
    const deletedFiles =
      (imageResult.invalidatedCacheFiles || 0) +
      imageArtifacts.deletedFiles +
      videoResult.deletedFiles
    const freedBytes =
      (imagePhaseCompleted ? stored.imageVectorBytes : 0) +
      (imageResult.invalidatedCacheBytes || 0) +
      imageArtifacts.freedBytes +
      subjectResult.freedBytes +
      videoResult.freedBytes +
      historyResult.freedBytes
    return {
      ok: error === undefined,
      ...(error === undefined
        ? {}
        : {
            error,
            partialCommit: totalRecordsRemoved > 0 || deletedFiles > 0 || freedBytes > 0,
          }),
      sourcePath: stored.preview.sourcePath,
      imageRecordsRemoved,
      videoRecordsRemoved,
      automationHistoryRecordsRemoved,
      totalRecordsRemoved,
      deletedFiles,
      freedBytes,
      originalFilesAffected: 0,
      warnings: [
        ...(imageResult.warnings || []),
        ...imageArtifacts.warnings,
        ...subjectResult.warnings,
        ...videoResult.warnings,
        ...historyResult.warnings,
      ],
    }
  }
  try {
    safeSourceDirectory(stored.preview.sourcePath || '')
    assertVideoPlanFresh(stored.video)
    const persistedBusy = persistedJobBusy(stored.video)
    if (persistedBusy) throw new Error(persistedBusy)
    const hooks = options.hooks || {}
    hooks.invalidateRuntimeCaches?.()
    updateProgress({ phase: 'subject-vectors' })
    subjectResult = await executeSubjectEmbeddingSourceCleanup(
      stored.subjectEmbeddings,
      stored.preview.sourcePath!,
    )
    if (stored.imageToken) {
      imageResult = await executeImageSearchFolderDataEdit({
        userDataPath: options.userDataPath,
        token: stored.imageToken,
        allowedRoots: [stored.preview.sourcePath!],
        hooks: hooks.image,
        purgeBackupsOnSuccess: true,
        forceNativeMaintenance: true,
      })
      if (!imageResult.ok) throw new Error(imageResult.error || 'Image-derived data cleanup failed')
      imagePhaseCompleted = true
    }
    const thumbnails = await purgeThumbnailCachePlan(stored.thumbnailPlan)
    imageArtifacts = {
      deletedFiles: thumbnails.deletedFiles,
      freedBytes: thumbnails.freedBytes,
      removedRecords: 0,
      warnings: thumbnails.warnings,
    }
    if (hooks.cleanupImageArtifacts) {
      const result = await hooks.cleanupImageArtifacts(
        stored.thumbnailSources,
        stored.preview.sourcePath!,
      )
      imageArtifacts = {
        deletedFiles: imageArtifacts.deletedFiles + result.deletedFiles,
        freedBytes: imageArtifacts.freedBytes + result.freedBytes,
        removedRecords: imageArtifacts.removedRecords + (result.removedRecords || 0),
        warnings: [...imageArtifacts.warnings, ...(result.warnings || [])],
      }
    }
    videoResult = await executeVideoCleanup(stored.video, hooks)
    updateProgress({ phase: 'managed-history' })
    historyResult = await executeManagedAutomationHistoryCleanup(stored.managedHistory)
    const result = buildResult()
    updateProgress({
      state: 'completed',
      phase: 'finalizing',
      processedBytes: stored.preview.estimatedBytes,
      removedRecords: result.totalRecordsRemoved,
      finishedAt: Date.now(),
    })
    return result
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const result = buildResult(message)
    updateProgress({
      state: 'error',
      error: message,
      processedBytes: result.freedBytes,
      removedRecords: result.totalRecordsRemoved,
      finishedAt: Date.now(),
    })
    return result
  } finally {
    running = false
  }
}

export function getSourceDerivedDataCleanupProgress(): SourceDerivedDataCleanupProgress {
  return { ...progress }
}

export function isSourceDerivedDataCleanupRunning(): boolean {
  return running
}
