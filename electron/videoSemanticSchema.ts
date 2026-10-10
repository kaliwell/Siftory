import crypto from 'crypto'
import {
  VIDEO_SEMANTIC_PROFILE_REVISION,
  VIDEO_SEMANTIC_SCHEMA_VERSION,
  isVideoSemanticProfileId,
  type VideoSemanticEvent,
  type VideoSemanticPerson,
  type VideoSemanticSegmentRecord,
} from '../shared/videoSemantic'

const MAX_VIDEO_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const FRAME_ID_PATTERN = /^[a-f0-9]{40}$/i

export type VideoSemanticSchemaResult =
  | { ok: true; value: VideoSemanticSegmentRecord; migratedFrom?: number }
  | { ok: false; error: string }

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replaceAll('\u0000', '')
  if (!normalized) return undefined
  return normalized.slice(0, maxLength)
}

function safeIdentifier(value: unknown, maxLength = 256): string | undefined {
  const normalized = boundedString(value, maxLength)
  if (!normalized || /[\r\n]/.test(normalized)) return undefined
  return normalized
}

function safeInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined
  if (value < min || value > max) return undefined
  return value
}

function normalizedConfidence(value: unknown, fallback = 0.5): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000
}

function stringList(value: unknown, maximum: number, itemLength: number): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const normalized = boundedString(item, itemLength)
    if (!normalized) continue
    const key = normalized.toLocaleLowerCase('zh-CN')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
    if (result.length >= maximum) break
  }
  return result
}

function eventList(
  value: unknown,
  segmentStartMs: number,
  segmentEndMs: number,
): VideoSemanticEvent[] {
  if (!Array.isArray(value)) return []
  const events: VideoSemanticEvent[] = []
  for (const raw of value) {
    const event = objectValue(raw)
    if (!event) continue
    const label = boundedString(event.label, 160)
    const description = boundedString(event.description, 1_000)
    if (!label || !description) continue
    const rawStart = safeInteger(event.startMs, 0, MAX_VIDEO_DURATION_MS) ?? segmentStartMs
    const rawEnd = safeInteger(event.endMs, 0, MAX_VIDEO_DURATION_MS) ?? segmentEndMs
    const startMs = Math.max(segmentStartMs, Math.min(segmentEndMs - 1, rawStart))
    const endMs = Math.max(startMs + 1, Math.min(segmentEndMs, rawEnd))
    events.push({
      label,
      description,
      startMs,
      endMs,
      confidence: normalizedConfidence(event.confidence),
    })
    if (events.length >= 64) break
  }
  return events
}

function personList(value: unknown): VideoSemanticPerson[] {
  if (!Array.isArray(value)) return []
  const people: VideoSemanticPerson[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    const person = objectValue(raw)
    if (!person) continue
    const localId = safeIdentifier(person.localId, 80)
    const description = boundedString(person.description, 1_000)
    if (!localId || !description || ids.has(localId)) continue
    ids.add(localId)
    people.push({
      localId,
      description,
      actions: stringList(person.actions, 32, 160),
      confidence: normalizedConfidence(person.confidence),
    })
    if (people.length >= 32) break
  }
  return people
}

export function deriveVideoSemanticSegmentId(input: {
  videoId: string
  startMs: number
  endMs: number
  generationId: string
}): string {
  return crypto
    .createHash('sha1')
    .update(`${input.videoId}\u0000${input.startMs}\u0000${input.endMs}\u0000${input.generationId}`)
    .digest('hex')
}

function migrateLegacyRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const startMs = safeInteger(raw.startMs, 0, MAX_VIDEO_DURATION_MS) ?? 0
  const endMs = safeInteger(raw.endMs, 1, MAX_VIDEO_DURATION_MS) ?? startMs + 1
  const generationId = safeIdentifier(raw.generationId) ?? 'legacy-generation'
  const videoId = safeIdentifier(raw.videoId) ?? 'legacy-video'
  const people = Array.isArray(raw.people)
    ? raw.people.map((description, index) => ({
        localId: `person-${index + 1}`,
        description,
        actions: [],
        confidence: 0.5,
      }))
    : raw.persons
  const events = Array.isArray(raw.eventDescriptions)
    ? raw.eventDescriptions.map((description) => ({
        label: 'legacy-event',
        description,
        startMs,
        endMs,
        confidence: 0.5,
      }))
    : raw.events
  return {
    ...raw,
    schemaVersion: VIDEO_SEMANTIC_SCHEMA_VERSION,
    segmentId:
      safeIdentifier(raw.segmentId) ||
      deriveVideoSemanticSegmentId({ videoId, startMs, endMs, generationId }),
    generationId,
    videoId,
    startMs,
    endMs,
    profileId: isVideoSemanticProfileId(raw.profileId) ? raw.profileId : 'general',
    profileRevision: safeIdentifier(raw.profileRevision) ?? VIDEO_SEMANTIC_PROFILE_REVISION,
    scenes: raw.scenes ?? [],
    events,
    persons: people,
    objects: raw.objects ?? [],
    searchTags: raw.searchTags ?? raw.tags ?? [],
    visualText: raw.visualText ?? [],
    transcriptRefs: raw.transcriptRefs ?? [],
    audioEvents: raw.audioEvents ?? [],
    warnings: raw.warnings ?? ['migrated-legacy-record'],
    evidenceFrameIds: raw.evidenceFrameIds ?? [],
    quantization: raw.quantization ?? 'unknown',
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? Date.now(),
  }
}

export function normalizeVideoSemanticSegmentRecord(rawValue: unknown): VideoSemanticSchemaResult {
  const input = objectValue(rawValue)
  if (!input) return { ok: false, error: 'Video semantic segment must be an object' }
  const schemaVersion = input.schemaVersion === undefined ? 0 : input.schemaVersion
  if (schemaVersion !== 0 && schemaVersion !== VIDEO_SEMANTIC_SCHEMA_VERSION) {
    return { ok: false, error: 'Unsupported video semantic schema version' }
  }
  const raw = schemaVersion === 0 ? migrateLegacyRecord(input) : input

  const assetId = safeIdentifier(raw.assetId)
  const videoId = safeIdentifier(raw.videoId)
  const generationId = safeIdentifier(raw.generationId)
  const startMs = safeInteger(raw.startMs, 0, MAX_VIDEO_DURATION_MS)
  const endMs = safeInteger(raw.endMs, 1, MAX_VIDEO_DURATION_MS)
  const profileId = isVideoSemanticProfileId(raw.profileId) ? raw.profileId : undefined
  if (!assetId || !videoId || !generationId || startMs === undefined || endMs === undefined) {
    return { ok: false, error: 'Video semantic segment identity is invalid' }
  }
  if (endMs <= startMs) return { ok: false, error: 'Video semantic segment range is invalid' }
  if (!profileId) return { ok: false, error: 'Video semantic profile is invalid' }

  const segmentId =
    safeIdentifier(raw.segmentId) ||
    deriveVideoSemanticSegmentId({ videoId, startMs, endMs, generationId })
  const summary = boundedString(raw.summary, 2_000)
  const evidenceFrameDigest = safeIdentifier(raw.evidenceFrameDigest, 256)
  const modelId = safeIdentifier(raw.modelId)
  const modelRevision = safeIdentifier(raw.modelRevision)
  const quantization = safeIdentifier(raw.quantization, 80)
  const promptVersion = safeIdentifier(raw.promptVersion, 80)
  const profileRevision = safeIdentifier(raw.profileRevision, 80)
  const sourceFingerprint = safeIdentifier(raw.sourceFingerprint, 512)
  const createdAt = safeInteger(raw.createdAt, 0, Number.MAX_SAFE_INTEGER)
  const updatedAt = safeInteger(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER)
  if (
    !summary ||
    !evidenceFrameDigest ||
    !modelId ||
    !modelRevision ||
    !quantization ||
    !promptVersion ||
    !profileRevision ||
    !sourceFingerprint ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return { ok: false, error: 'Video semantic segment version metadata is invalid' }
  }

  const evidenceFrameIds = stringList(raw.evidenceFrameIds, 16, 40).filter((frameId) =>
    FRAME_ID_PATTERN.test(frameId),
  )
  if (evidenceFrameIds.length === 0) {
    return { ok: false, error: 'Video semantic segment has no valid evidence frames' }
  }

  const record: VideoSemanticSegmentRecord = {
    schemaVersion: VIDEO_SEMANTIC_SCHEMA_VERSION,
    segmentId,
    generationId,
    assetId,
    videoId,
    startMs,
    endMs,
    profileId,
    summary,
    scenes: stringList(raw.scenes, 32, 160),
    events: eventList(raw.events, startMs, endMs),
    persons: personList(raw.persons),
    objects: stringList(raw.objects, 128, 160),
    searchTags: stringList(raw.searchTags, 128, 160),
    visualText: stringList(raw.visualText, 128, 500),
    transcriptRefs: stringList(raw.transcriptRefs, 128, 256),
    audioEvents: stringList(raw.audioEvents, 64, 160),
    ...(boundedString(raw.language, 35) ? { language: boundedString(raw.language, 35) } : {}),
    warnings: stringList(raw.warnings, 64, 300),
    evidenceFrameIds,
    evidenceFrameDigest,
    modelId,
    modelRevision,
    quantization,
    promptVersion,
    profileRevision,
    sourceFingerprint,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
  }
  return {
    ok: true,
    value: record,
    ...(schemaVersion === 0 ? { migratedFrom: 0 } : {}),
  }
}
