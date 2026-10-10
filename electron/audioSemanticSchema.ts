import crypto from 'crypto'
import {
  AUDIO_SEMANTIC_EMOTIONS,
  AUDIO_SEMANTIC_EVENT_LABELS,
  AUDIO_SEMANTIC_LANGUAGES,
  AUDIO_SEMANTIC_MAX_CHUNK_MS,
  AUDIO_SEMANTIC_SCHEMA_VERSION,
  type AudioSemanticEmotion,
  type AudioSemanticEvent,
  type AudioSemanticEventLabel,
  type AudioSemanticLanguage,
  type AudioSemanticModelIdentity,
  type AudioSemanticSegmentRecord,
  type AudioSemanticSpeaker,
} from '../shared/audioSemantic'

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/i
const MODEL_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}(?:\/[a-z0-9][a-z0-9._:-]{0,127})?$/i
const SPEAKER_PATTERN = /^speaker-[1-9][0-9]{0,3}$/

export interface AudioSemanticAuthority {
  generationId: string
  assetId: string
  videoId: string
  startMs: number
  endMs: number
  sourceFingerprint: string
  model: AudioSemanticModelIdentity
  createdAt: number
  speakerModel?: { modelId: string; modelRevision: string }
}

export interface AudioSemanticRuntimeOutput {
  text?: unknown
  language?: unknown
  emotion?: unknown
  audioEvents?: unknown
  speakerId?: unknown
}

export type AudioSemanticSchemaResult =
  | { ok: true; value: AudioSemanticSegmentRecord }
  | { ok: false; error: string }

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return IDENTIFIER_PATTERN.test(normalized) ? normalized : undefined
}

function safeModelIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length <= 256 && MODEL_IDENTIFIER_PATTERN.test(normalized)
    ? normalized
    : undefined
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === 'string'
    ? value.replaceAll('\u0000', '').replace(/\s+/g, ' ').trim().slice(0, maximum)
    : ''
}

function normalizedConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000
    : 0.5
}

function hasValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value as T[number])
}

function normalizeEvents(value: unknown, startMs: number, endMs: number): AudioSemanticEvent[] {
  if (!Array.isArray(value)) return []
  const result: AudioSemanticEvent[] = []
  const seen = new Set<AudioSemanticEventLabel>()
  for (const item of value) {
    const source =
      typeof item === 'string'
        ? { label: item }
        : item && typeof item === 'object' && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : undefined
    if (!source || !hasValue(AUDIO_SEMANTIC_EVENT_LABELS, source.label) || seen.has(source.label)) {
      continue
    }
    seen.add(source.label)
    result.push({
      label: source.label,
      startMs,
      endMs,
      confidence: normalizedConfidence(source.confidence),
    })
    if (result.length >= 16) break
  }
  return result
}

export function deriveAudioSemanticSegmentId(authority: {
  generationId: string
  videoId: string
  startMs: number
  endMs: number
}): string {
  return crypto
    .createHash('sha1')
    .update(
      `${authority.generationId}\u0000${authority.videoId}\u0000${authority.startMs}\u0000${authority.endMs}`,
    )
    .digest('hex')
}

export function normalizeAudioSemanticOutput(
  raw: AudioSemanticRuntimeOutput,
  authority: AudioSemanticAuthority,
): AudioSemanticSchemaResult {
  const generationId = safeIdentifier(authority.generationId)
  const assetId = safeIdentifier(authority.assetId)
  const videoId = safeIdentifier(authority.videoId)
  const sourceFingerprint = safeIdentifier(authority.sourceFingerprint)
  const modelId = safeModelIdentifier(authority.model.modelId)
  const modelRevision = safeIdentifier(authority.model.modelRevision)
  const quantization = safeIdentifier(authority.model.quantization)
  if (!generationId || !assetId || !videoId || !sourceFingerprint) {
    return { ok: false, error: 'Audio semantic authority identity is invalid' }
  }
  if (!modelId || !modelRevision || !quantization) {
    return { ok: false, error: 'Audio semantic model identity is invalid' }
  }
  if (
    !Number.isSafeInteger(authority.startMs) ||
    !Number.isSafeInteger(authority.endMs) ||
    authority.startMs < 0 ||
    authority.endMs <= authority.startMs ||
    authority.endMs - authority.startMs > AUDIO_SEMANTIC_MAX_CHUNK_MS
  ) {
    return { ok: false, error: 'Audio semantic segment range is invalid' }
  }
  if (!Number.isSafeInteger(authority.createdAt) || authority.createdAt < 0) {
    return { ok: false, error: 'Audio semantic creation time is invalid' }
  }

  const language: AudioSemanticLanguage = hasValue(AUDIO_SEMANTIC_LANGUAGES, raw.language)
    ? raw.language
    : 'nospeech'
  const emotion: AudioSemanticEmotion = hasValue(AUDIO_SEMANTIC_EMOTIONS, raw.emotion)
    ? raw.emotion
    : 'unknown'
  const text = boundedText(raw.text, 8_000)
  const audioEvents = normalizeEvents(raw.audioEvents, authority.startMs, authority.endMs)
  if (!text && language !== 'nospeech' && audioEvents.length === 0) {
    return { ok: false, error: 'Audio semantic output has no usable evidence' }
  }

  let speaker: AudioSemanticSpeaker | undefined
  if (typeof raw.speakerId === 'string') {
    if (!SPEAKER_PATTERN.test(raw.speakerId) || !authority.speakerModel) {
      return { ok: false, error: 'Speaker output requires an approved diarization model' }
    }
    const speakerModelId = safeIdentifier(authority.speakerModel.modelId)
    const speakerModelRevision = safeIdentifier(authority.speakerModel.modelRevision)
    if (!speakerModelId || !speakerModelRevision) {
      return { ok: false, error: 'Speaker model identity is invalid' }
    }
    speaker = {
      localId: raw.speakerId,
      modelId: speakerModelId,
      modelRevision: speakerModelRevision,
    }
  }

  const segmentId = deriveAudioSemanticSegmentId(authority)
  return {
    ok: true,
    value: {
      schemaVersion: AUDIO_SEMANTIC_SCHEMA_VERSION,
      segmentId,
      generationId,
      assetId,
      videoId,
      startMs: authority.startMs,
      endMs: authority.endMs,
      text,
      language,
      emotion,
      audioEvents,
      transcriptRef: `asr:${segmentId}`,
      ...(speaker ? { speaker } : {}),
      modelId,
      modelRevision,
      runtime: authority.model.runtime,
      quantization,
      sourceFingerprint,
      createdAt: authority.createdAt,
    },
  }
}
