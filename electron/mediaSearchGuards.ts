import fs from 'fs'
import path from 'path'
import type { MediaSearchStartScanArgs, MediaSearchTaskType } from '../shared/ipc-contract'
import { isSameOrNestedPath } from './pathGuards'

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.mov',
  '.avi',
  '.webm',
  '.wmv',
  '.m4v',
  '.flv',
  '.m2ts',
])

const MEDIA_TASK_TYPES = new Set<MediaSearchTaskType>([
  'scan-video-files',
  'read-video-metadata',
  'extract-video-frames',
  'prepare-media-library',
  'build-visual-vector',
  'cleanup-cache',
])

export function isVideoPath(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export function isMediaSearchQueryImagePath(filePath: string): boolean {
  return /\.(?:jpe?g|png|webp|bmp|gif)$/i.test(filePath)
}

function normalizeExistingPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const resolved = path.resolve(trimmed)
  try {
    fs.accessSync(resolved, fs.constants.R_OK)
    return resolved
  } catch {
    return null
  }
}

export function normalizeMediaSearchStartScanArgs(input: unknown): MediaSearchStartScanArgs | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as { paths?: unknown; mode?: unknown }
  if (!Array.isArray(raw.paths)) return null

  const paths: string[] = []
  const seen = new Set<string>()
  for (const value of raw.paths) {
    const normalized = normalizeExistingPath(value)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(normalized)
    if (paths.length >= 64) break
  }
  if (paths.length === 0) return null

  const mode = raw.mode === 'thumbnails' || raw.mode === 'metadata' ? raw.mode : 'metadata'

  return { paths, mode }
}

export function normalizeMediaTaskType(input: unknown): MediaSearchTaskType | null {
  return typeof input === 'string' && MEDIA_TASK_TYPES.has(input as MediaSearchTaskType)
    ? (input as MediaSearchTaskType)
    : null
}

export function normalizeTaskId(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const trimmed = input.trim()
  return /^[a-zA-Z0-9_-]{1,80}$/.test(trimmed) ? trimmed : undefined
}

/**
 * Returns true when `candidate` may be revealed in the OS file explorer:
 * either it is a known scan root (dialog-picked or previously scanned,
 * case-insensitive), or it is an existing directory that is an ancestor of
 * at least one video path recorded in the manifest.
 */
export function isRevealableMediaScanPath(
  candidate: string,
  knownRoots: ReadonlySet<string>,
  manifestVideoPaths: readonly string[],
  isDirectory: (p: string) => boolean,
): boolean {
  const normalized = path.normalize(candidate)
  if (knownRoots.has(normalized.toLowerCase())) return true
  if (!isDirectory(normalized)) return false
  return manifestVideoPaths.some((videoPath) => isSameOrNestedPath(normalized, videoPath))
}
