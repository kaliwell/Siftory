import type {
  MediaPlayerEvidenceSource,
  MediaPlayerHit,
  MediaPlayerHitContext,
  MediaPlayerHitKind,
} from './ipc/media-search'

export const MAX_MEDIA_PLAYER_HITS = 32
export const MAX_MEDIA_PLAYER_TIMESTAMP_MS = 7 * 24 * 60 * 60 * 1_000

const HIT_KINDS = new Set<MediaPlayerHitKind>(['visual', 'subtitle', 'semantic', 'fused'])
const EVIDENCE_SOURCES = new Set<MediaPlayerEvidenceSource>([
  'cached-frame',
  'embedded-subtitle',
  'ai-visual-semantic',
  'ocr',
  'transcript-reference',
  'audio-event',
])

function boundedTimestamp(raw: unknown, durationMs?: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return undefined
  const maximum = Math.min(
    MAX_MEDIA_PLAYER_TIMESTAMP_MS,
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
      ? Math.ceil(durationMs)
      : MAX_MEDIA_PLAYER_TIMESTAMP_MS,
  )
  return raw <= maximum ? raw : undefined
}

function normalizeHit(raw: unknown, durationMs?: number): MediaPlayerHit | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Partial<MediaPlayerHit>
  const startMs = boundedTimestamp(input.startMs, durationMs)
  if (startMs === undefined || !HIT_KINDS.has(input.kind!)) return undefined
  const rawEndMs = boundedTimestamp(input.endMs, durationMs)
  const endMs = rawEndMs !== undefined && rawEndMs >= startMs ? rawEndMs : undefined
  const evidenceSources = Array.isArray(input.evidenceSources)
    ? [
        ...new Set(
          input.evidenceSources
            .filter((source): source is MediaPlayerEvidenceSource =>
              EVIDENCE_SOURCES.has(source as MediaPlayerEvidenceSource),
            )
            .slice(0, EVIDENCE_SOURCES.size),
        ),
      ]
    : []
  return {
    startMs,
    ...(endMs !== undefined ? { endMs } : {}),
    kind: input.kind!,
    ...(typeof input.text === 'string' && input.text.trim()
      ? { text: input.text.trim().slice(0, 1_000) }
      : {}),
    evidenceSources,
  }
}

export function nearestMediaPlayerHitIndex(
  hits: readonly MediaPlayerHit[],
  timestampMs: number,
): number {
  if (!hits.length) return 0
  let bestIndex = 0
  let bestDistance = Math.abs(hits[0].startMs - timestampMs)
  for (let index = 1; index < hits.length; index += 1) {
    const distance = Math.abs(hits[index].startMs - timestampMs)
    if (distance < bestDistance) {
      bestIndex = index
      bestDistance = distance
    }
  }
  return bestIndex
}

export function normalizeMediaPlayerHitContext(
  raw: unknown,
  durationMs?: number,
  anchorTimestampMs = 0,
): MediaPlayerHitContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Partial<MediaPlayerHitContext>
  if (!Array.isArray(input.hits)) return undefined
  const hits = input.hits
    .slice(0, MAX_MEDIA_PLAYER_HITS)
    .map((hit) => normalizeHit(hit, durationMs))
    .filter((hit): hit is MediaPlayerHit => Boolean(hit))
    .sort((left, right) => left.startMs - right.startMs || (left.endMs ?? 0) - (right.endMs ?? 0))
  if (!hits.length) return undefined
  return {
    ...(typeof input.query === 'string' && input.query.trim()
      ? { query: input.query.trim().slice(0, 500) }
      : {}),
    selectedIndex: nearestMediaPlayerHitIndex(hits, anchorTimestampMs),
    hits,
  }
}

export function stepMediaPlayerHitIndex(
  context: MediaPlayerHitContext,
  currentIndex: number,
  direction: -1 | 1,
): number {
  return Math.max(0, Math.min(context.hits.length - 1, currentIndex + direction))
}

export interface MediaContainRect {
  width: number
  height: number
  left: number
  top: number
}

export function computeMediaContainRect(
  containerWidth: number,
  containerHeight: number,
  mediaWidth: number,
  mediaHeight: number,
): MediaContainRect {
  const safeContainerWidth = Math.max(0, Number.isFinite(containerWidth) ? containerWidth : 0)
  const safeContainerHeight = Math.max(0, Number.isFinite(containerHeight) ? containerHeight : 0)
  if (
    safeContainerWidth === 0 ||
    safeContainerHeight === 0 ||
    !Number.isFinite(mediaWidth) ||
    !Number.isFinite(mediaHeight) ||
    mediaWidth <= 0 ||
    mediaHeight <= 0
  ) {
    return { width: safeContainerWidth, height: safeContainerHeight, left: 0, top: 0 }
  }
  const scale = Math.min(safeContainerWidth / mediaWidth, safeContainerHeight / mediaHeight)
  const roundLayoutValue = (value: number) => Math.round(value * 1_000_000) / 1_000_000
  const width = roundLayoutValue(mediaWidth * scale)
  const height = roundLayoutValue(mediaHeight * scale)
  return {
    width,
    height,
    left: roundLayoutValue((safeContainerWidth - width) / 2),
    top: roundLayoutValue((safeContainerHeight - height) / 2),
  }
}
