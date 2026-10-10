import type { SubjectBBox } from '../shared/ipc/subject-search'
import type {
  UnifiedIndexStateLevel,
  UnifiedSearchFeedbackKind,
  UnifiedSearchFeedbackRequest,
  UnifiedSearchFilters,
  UnifiedSearchMediaType,
  UnifiedSearchOrientation,
  UnifiedSearchRequest,
} from '../shared/ipc/unified-search'
import { clampNumber } from './imageSearchGuards'
import { normalizeUserPath } from './pathGuards'

function normalizeSubject(raw: unknown): SubjectBBox | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Partial<SubjectBBox>
  if (
    ![input.x, input.y, input.w, input.h].every(
      (value) => typeof value === 'number' && Number.isFinite(value),
    ) ||
    (input.x as number) < 0 ||
    (input.y as number) < 0 ||
    (input.w as number) < 4 ||
    (input.h as number) < 4 ||
    (input.w as number) > 100000 ||
    (input.h as number) > 100000
  ) {
    return undefined
  }
  return {
    x: input.x as number,
    y: input.y as number,
    w: input.w as number,
    h: input.h as number,
    confidence:
      typeof input.confidence === 'number' && Number.isFinite(input.confidence)
        ? input.confidence
        : 1,
    label: typeof input.label === 'string' && input.label ? input.label.slice(0, 50) : 'subject',
  }
}

const MEDIA_TYPES = new Set<UnifiedSearchMediaType>(['image', 'video', 'audio', 'file'])
const ORIENTATIONS = new Set<UnifiedSearchOrientation>(['landscape', 'portrait', 'square'])
const INDEX_LEVELS = new Set<UnifiedIndexStateLevel>(['metadata-only', 'partial', 'full'])

function normalizeStringList<T extends string>(
  raw: unknown,
  allowed: ReadonlySet<T>,
  limit: number,
): T[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const values = [
    ...new Set(
      raw
        .filter((value): value is T => typeof value === 'string' && allowed.has(value as T))
        .slice(0, limit),
    ),
  ]
  return values.length ? values : undefined
}

function normalizeSourceIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const values = [
    ...new Set(
      raw
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .slice(0, 64)
        .map((value) => value.slice(0, 128)),
    ),
  ]
  return values.length ? values : undefined
}

function optionalFinite(raw: unknown, maximum: number): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(maximum, Math.max(0, raw))
    : undefined
}

function normalizeFilters(raw: unknown): UnifiedSearchFilters | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Partial<UnifiedSearchFilters>
  const mediaTypes = normalizeStringList(input.mediaTypes, MEDIA_TYPES, MEDIA_TYPES.size)
  const sourceIds = normalizeSourceIds(input.sourceIds)
  const orientations = normalizeStringList(input.orientations, ORIENTATIONS, ORIENTATIONS.size)
  const indexLevels = normalizeStringList(input.indexLevels, INDEX_LEVELS, INDEX_LEVELS.size)
  const rawModifiedAfter = optionalFinite(input.modifiedAfter, 8_640_000_000_000_000)
  const rawModifiedBefore = optionalFinite(input.modifiedBefore, 8_640_000_000_000_000)
  const rawMinDuration = optionalFinite(input.minDurationMs, 315_576_000_000)
  const rawMaxDuration = optionalFinite(input.maxDurationMs, 315_576_000_000)
  const modifiedAfter =
    rawModifiedAfter !== undefined && rawModifiedBefore !== undefined
      ? Math.min(rawModifiedAfter, rawModifiedBefore)
      : rawModifiedAfter
  const modifiedBefore =
    rawModifiedAfter !== undefined && rawModifiedBefore !== undefined
      ? Math.max(rawModifiedAfter, rawModifiedBefore)
      : rawModifiedBefore
  const minDurationMs =
    rawMinDuration !== undefined && rawMaxDuration !== undefined
      ? Math.min(rawMinDuration, rawMaxDuration)
      : rawMinDuration
  const maxDurationMs =
    rawMinDuration !== undefined && rawMaxDuration !== undefined
      ? Math.max(rawMinDuration, rawMaxDuration)
      : rawMaxDuration
  const filters: UnifiedSearchFilters = {
    ...(mediaTypes ? { mediaTypes } : {}),
    ...(sourceIds ? { sourceIds } : {}),
    ...(modifiedAfter !== undefined ? { modifiedAfter } : {}),
    ...(modifiedBefore !== undefined ? { modifiedBefore } : {}),
    ...(minDurationMs !== undefined ? { minDurationMs } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    ...(orientations ? { orientations } : {}),
    ...(indexLevels ? { indexLevels } : {}),
  }
  return Object.keys(filters).length ? filters : undefined
}

export function normalizeUnifiedSearchQuery(raw: unknown): UnifiedSearchRequest {
  const input = (raw ?? {}) as Partial<UnifiedSearchRequest>
  const referenceImagePath = normalizeUserPath(input.referenceImagePath)
  const subject = normalizeSubject(input.subject)
  const segmentationSessionId =
    typeof input.segmentationSessionId === 'string' &&
    /^[0-9a-f-]{16,128}$/i.test(input.segmentationSessionId)
      ? input.segmentationSessionId
      : undefined
  const filters = normalizeFilters(input.filters)
  return {
    ...(typeof input.query === 'string' ? { query: input.query.slice(0, 500) } : {}),
    ...(referenceImagePath ? { referenceImagePath } : {}),
    ...(referenceImagePath && subject ? { subject } : {}),
    ...(referenceImagePath && subject && segmentationSessionId ? { segmentationSessionId } : {}),
    ...(typeof input.sourceId === 'string' ? { sourceId: input.sourceId.slice(0, 128) } : {}),
    ...(filters ? { filters } : {}),
    offset: Math.floor(clampNumber(input.offset, 0, 0, 10_000_000)),
    limit: Math.floor(clampNumber(input.limit, 100, 1, 500)),
  }
}

const FEEDBACK_KINDS = new Set<UnifiedSearchFeedbackKind>([
  'relevant',
  'irrelevant',
  'timestamp-wrong',
])

function feedbackIdentifier(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().slice(0, 512)
  return value || undefined
}

export function normalizeUnifiedSearchFeedback(
  raw: unknown,
): UnifiedSearchFeedbackRequest | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Partial<UnifiedSearchFeedbackRequest>
  if (!input.target || typeof input.target !== 'object' || !FEEDBACK_KINDS.has(input.kind!)) {
    return undefined
  }
  const fileEntryId = feedbackIdentifier(input.target.fileEntryId)
  if (!fileEntryId) return undefined
  const timestampMs = optionalFinite(input.target.timestampMs, 315_576_000_000)
  if (input.kind === 'timestamp-wrong' && timestampMs === undefined) return undefined
  return {
    search: normalizeUnifiedSearchQuery(input.search),
    target: {
      fileEntryId,
      ...(feedbackIdentifier(input.target.assetId)
        ? { assetId: feedbackIdentifier(input.target.assetId) }
        : {}),
      ...(feedbackIdentifier(input.target.videoId)
        ? { videoId: feedbackIdentifier(input.target.videoId) }
        : {}),
      ...(timestampMs !== undefined ? { timestampMs: Math.floor(timestampMs) } : {}),
    },
    kind: input.kind!,
  }
}

export function normalizeUnifiedSearchFeedbackId(raw: unknown): string | undefined {
  const value = feedbackIdentifier(raw)
  return value && /^[0-9a-f-]{16,128}$/i.test(value) ? value : undefined
}
