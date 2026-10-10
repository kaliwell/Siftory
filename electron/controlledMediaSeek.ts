import path from 'path'
import type { MediaPlayerHitContext, MediaSearchVideoRecord } from '../shared/ipc/media-search'
import { normalizeMediaPlayerHitContext } from '../shared/mediaPlayerNavigation'

export const MAX_CONTROLLED_MEDIA_SEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface ControlledMediaSeek {
  videoId: string
  videoPath: string
  title: string
  timestampMs: number
  durationMs?: number
  width?: number
  height?: number
  sizeBytes?: number
  mtimeMs?: number
  hitContext?: MediaPlayerHitContext
}

export function resolveControlledMediaSeek(
  raw: unknown,
  videos: readonly MediaSearchVideoRecord[],
): { ok: true; value: ControlledMediaSeek } | { ok: false; error: string } {
  const input = raw as { videoId?: unknown; timestampMs?: unknown; hitContext?: unknown } | null
  const videoId = typeof input?.videoId === 'string' ? input.videoId.trim() : ''
  if (!videoId || videoId.length > 256) return { ok: false, error: 'Invalid video id' }
  const video = videos.find((candidate) => candidate.videoId === videoId)
  if (!video) return { ok: false, error: 'Video not found in manifest' }
  if (video.missing) return { ok: false, error: 'Video file is missing' }
  const timestampMs = input?.timestampMs === undefined ? 0 : input.timestampMs
  if (
    typeof timestampMs !== 'number' ||
    !Number.isSafeInteger(timestampMs) ||
    timestampMs < 0 ||
    timestampMs > MAX_CONTROLLED_MEDIA_SEEK_MS
  ) {
    return { ok: false, error: 'Invalid media timestamp' }
  }
  if (
    typeof video.durationMs === 'number' &&
    Number.isFinite(video.durationMs) &&
    video.durationMs >= 0 &&
    timestampMs > Math.ceil(video.durationMs)
  ) {
    return { ok: false, error: 'Media timestamp exceeds the indexed duration' }
  }
  const hitContext = normalizeMediaPlayerHitContext(
    input?.hitContext,
    video.durationMs,
    timestampMs,
  )
  if (input?.hitContext !== undefined && !hitContext) {
    return { ok: false, error: 'Invalid media hit context' }
  }
  return {
    ok: true,
    value: {
      videoId,
      videoPath: path.resolve(video.path),
      title: video.name || path.basename(video.path),
      timestampMs,
      ...(typeof video.durationMs === 'number' ? { durationMs: video.durationMs } : {}),
      ...(typeof video.width === 'number' ? { width: video.width } : {}),
      ...(typeof video.height === 'number' ? { height: video.height } : {}),
      ...(typeof video.sizeBytes === 'number' ? { sizeBytes: video.sizeBytes } : {}),
      ...(typeof video.mtimeMs === 'number' ? { mtimeMs: video.mtimeMs } : {}),
      ...(hitContext ? { hitContext } : {}),
    },
  }
}
