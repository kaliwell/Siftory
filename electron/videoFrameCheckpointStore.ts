import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { MediaSearchVideoFrameRecord, MediaSearchVideoRecord } from '../shared/ipc-contract'

const CHECKPOINT_VERSION = 1
const MAX_CHECKPOINT_DIRECTORIES = 32
const MAX_CHECKPOINT_FILES = 4096
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024
const MAX_RECORDS_PER_CHECKPOINT = 256

interface PersistedVideoFrameCheckpoint {
  version: number
  scopeId: string
  sequence: number
  createdAt: number
  records: MediaSearchVideoFrameRecord[]
}

export interface LoadedVideoFrameCheckpoints {
  records: MediaSearchVideoFrameRecord[]
  nextSequence: number
  inspectedFiles: number
  rejectedFiles: number
}

function normalizePathKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function checkpointRoot(mediaSearchDir: string): string {
  return path.join(mediaSearchDir, 'manifests', 'video-frame-checkpoints')
}

function checkpointScopeDirectory(mediaSearchDir: string, scopeId: string): string {
  if (!/^[a-f0-9]{32}$/.test(scopeId)) throw new Error('Invalid video frame checkpoint scope')
  return path.join(checkpointRoot(mediaSearchDir), scopeId)
}

function pathIsInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath)
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  )
}

function ensureDirectChildDirectory(parent: string, candidate: string): void {
  const resolvedParent = path.resolve(parent)
  const resolvedCandidate = path.resolve(candidate)
  if (path.dirname(resolvedCandidate) !== resolvedParent) {
    throw new Error('Video frame checkpoint directory is not a direct storage child')
  }
  if (fs.existsSync(resolvedCandidate)) {
    const stat = fs.lstatSync(resolvedCandidate)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Video frame checkpoint path is not a regular directory')
    }
  } else {
    fs.mkdirSync(resolvedCandidate)
  }
  if (path.dirname(fs.realpathSync(resolvedCandidate)) !== fs.realpathSync(resolvedParent)) {
    throw new Error('Video frame checkpoint directory escaped its storage parent')
  }
}

function ensureCheckpointScopeDirectory(mediaSearchDir: string, scopeId: string): string {
  const mediaRoot = path.resolve(mediaSearchDir)
  const manifestsRoot = path.join(mediaRoot, 'manifests')
  const root = path.resolve(checkpointRoot(mediaSearchDir))
  const directory = path.resolve(checkpointScopeDirectory(mediaSearchDir, scopeId))
  fs.mkdirSync(mediaRoot, { recursive: true })
  const mediaStat = fs.lstatSync(mediaRoot)
  if (!mediaStat.isDirectory() || mediaStat.isSymbolicLink()) {
    throw new Error('Video frame checkpoint root is not a regular directory')
  }
  ensureDirectChildDirectory(mediaRoot, manifestsRoot)
  ensureDirectChildDirectory(manifestsRoot, root)
  ensureDirectChildDirectory(root, directory)
  const realMediaRoot = fs.realpathSync(mediaRoot)
  const realRoot = fs.realpathSync(root)
  const realDirectory = fs.realpathSync(directory)
  if (!pathIsInside(realMediaRoot, realRoot) || path.dirname(realDirectory) !== realRoot) {
    throw new Error('Video frame checkpoint directory escaped its storage root')
  }
  return directory
}

function safeExistingCheckpointRoot(mediaSearchDir: string): string | null {
  const mediaRoot = path.resolve(mediaSearchDir)
  const manifestsRoot = path.join(mediaRoot, 'manifests')
  const root = path.resolve(checkpointRoot(mediaSearchDir))
  try {
    for (const candidate of [mediaRoot, manifestsRoot, root]) {
      const stat = fs.lstatSync(candidate)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    }
    const realMediaRoot = fs.realpathSync(mediaRoot)
    const realManifestsRoot = fs.realpathSync(manifestsRoot)
    const realRoot = fs.realpathSync(root)
    if (
      path.dirname(realManifestsRoot) !== realMediaRoot ||
      path.dirname(realRoot) !== realManifestsRoot
    ) {
      return null
    }
    return root
  } catch {
    return null
  }
}

export function videoFrameSourceFingerprint(video: MediaSearchVideoRecord): string {
  return crypto
    .createHash('sha256')
    .update(
      [
        video.videoId,
        normalizePathKey(video.path),
        Number(video.sizeBytes) || 0,
        Math.round(Number(video.mtimeMs) || 0),
        Math.round(Number(video.durationMs) || 0),
        Math.round(Number(video.width) || 0),
        Math.round(Number(video.height) || 0),
      ].join('\u001f'),
    )
    .digest('hex')
}

export function currentVideoFrameSourceFingerprint(video: MediaSearchVideoRecord): string | null {
  try {
    const stat = fs.statSync(video.path)
    if (!stat.isFile()) return null
    return videoFrameSourceFingerprint({
      ...video,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    })
  } catch {
    return null
  }
}

export function videoFrameCheckpointScopeId(videos: readonly MediaSearchVideoRecord[]): string {
  const rows = videos
    .map((video) => `${video.videoId}:${videoFrameSourceFingerprint(video)}`)
    .sort()
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 32)
}

function isAuthorizedCheckpointRecord(
  mediaSearchDir: string,
  record: MediaSearchVideoFrameRecord,
  videos: Map<string, MediaSearchVideoRecord>,
): boolean {
  const video = videos.get(record.videoId)
  if (!video || record.status !== 'done' || !record.imagePath) return false
  if (!/^[a-f0-9]{40}$/.test(record.frameId)) return false
  if (!Number.isSafeInteger(record.timestampMs) || record.timestampMs < 0) return false
  if (record.sourceFingerprint !== videoFrameSourceFingerprint(video)) return false
  if (normalizePathKey(record.videoPath) !== normalizePathKey(video.path)) return false
  const expectedImagePath = path.join(
    mediaSearchDir,
    'frames',
    record.videoId,
    `${record.frameId}.jpg`,
  )
  if (normalizePathKey(record.imagePath) !== normalizePathKey(expectedImagePath)) return false
  try {
    const stat = fs.lstatSync(record.imagePath)
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0
  } catch {
    return false
  }
}

function checkpointDirectories(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.isSymbolicLink() && /^[a-f0-9]{32}$/.test(entry.name),
    )
    .flatMap((entry) => {
      const directory = path.join(root, entry.name)
      try {
        const stat = fs.lstatSync(directory)
        return stat.isDirectory() && !stat.isSymbolicLink()
          ? [{ path: directory, mtimeMs: stat.mtimeMs }]
          : []
      } catch {
        return []
      }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_CHECKPOINT_DIRECTORIES)
    .map((entry) => entry.path)
}

export function loadVideoFrameCheckpoints(
  mediaSearchDir: string,
  videos: readonly MediaSearchVideoRecord[],
  currentScopeId: string,
): LoadedVideoFrameCheckpoints {
  const byVideo = new Map(videos.map((video) => [video.videoId, video]))
  const latest = new Map<string, MediaSearchVideoFrameRecord>()
  let nextSequence = 1
  let inspectedFiles = 0
  let rejectedFiles = 0

  const safeRoot = safeExistingCheckpointRoot(mediaSearchDir)
  if (!safeRoot) return { records: [], nextSequence, inspectedFiles, rejectedFiles }
  for (const directory of checkpointDirectories(safeRoot)) {
    const scopeId = path.basename(directory)
    const files = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^checkpoint-\d{8}-[a-f0-9-]+\.json$/.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort()
    for (const filePath of files) {
      if (inspectedFiles >= MAX_CHECKPOINT_FILES) break
      inspectedFiles++
      try {
        const stat = fs.lstatSync(filePath)
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size <= 0 ||
          stat.size > MAX_CHECKPOINT_BYTES
        ) {
          rejectedFiles++
          continue
        }
        const parsed = JSON.parse(
          fs.readFileSync(filePath, 'utf8'),
        ) as PersistedVideoFrameCheckpoint
        if (
          parsed.version !== CHECKPOINT_VERSION ||
          parsed.scopeId !== scopeId ||
          !Number.isSafeInteger(parsed.sequence) ||
          parsed.sequence < 1 ||
          !Array.isArray(parsed.records) ||
          parsed.records.length === 0 ||
          parsed.records.length > MAX_RECORDS_PER_CHECKPOINT
        ) {
          rejectedFiles++
          continue
        }
        if (scopeId === currentScopeId) nextSequence = Math.max(nextSequence, parsed.sequence + 1)
        for (const record of parsed.records) {
          if (!isAuthorizedCheckpointRecord(mediaSearchDir, record, byVideo)) continue
          const key = `${record.videoId}:${record.timestampMs}`
          const previous = latest.get(key)
          if (!previous || record.updatedAt >= previous.updatedAt) latest.set(key, record)
        }
      } catch {
        rejectedFiles++
      }
    }
    if (inspectedFiles >= MAX_CHECKPOINT_FILES) break
  }

  return { records: [...latest.values()], nextSequence, inspectedFiles, rejectedFiles }
}

export function commitVideoFrameCheckpoint(
  mediaSearchDir: string,
  scopeId: string,
  sequence: number,
  records: readonly MediaSearchVideoFrameRecord[],
): string | null {
  if (records.length === 0) return null
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new Error('Invalid checkpoint sequence')
  if (records.length > MAX_RECORDS_PER_CHECKPOINT) {
    throw new Error(`Video frame checkpoint exceeds ${MAX_RECORDS_PER_CHECKPOINT} records`)
  }
  const directory = ensureCheckpointScopeDirectory(mediaSearchDir, scopeId)
  const filename = `checkpoint-${String(sequence).padStart(8, '0')}-${crypto.randomUUID()}.json`
  const filePath = path.join(directory, filename)
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const payload: PersistedVideoFrameCheckpoint = {
    version: CHECKPOINT_VERSION,
    scopeId,
    sequence,
    createdAt: Date.now(),
    records: [...records],
  }
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(payload)}\n`, 'utf8')
    fs.renameSync(temporaryPath, filePath)
    return filePath
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
    } catch {
      /* best-effort cleanup of this checkpoint's private temporary file */
    }
  }
}

export function clearVideoFrameCheckpointScope(mediaSearchDir: string, scopeId: string): void {
  const root = safeExistingCheckpointRoot(mediaSearchDir)
  if (!root) return
  const directory = path.resolve(checkpointScopeDirectory(mediaSearchDir, scopeId))
  if (path.dirname(directory) !== root) throw new Error('Checkpoint scope escaped its root')
  if (!fs.existsSync(directory)) return
  const rootStat = fs.lstatSync(root)
  const directoryStat = fs.lstatSync(directory)
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    path.dirname(fs.realpathSync(directory)) !== fs.realpathSync(root)
  ) {
    throw new Error('Refusing to clear an unsafe video frame checkpoint scope')
  }
  fs.rmSync(directory, { recursive: true, force: true })
}
