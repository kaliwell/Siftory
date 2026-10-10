export const AUDIO_SEMANTIC_SCHEMA_VERSION = 1 as const
export const AUDIO_SEMANTIC_MAX_CHUNK_MS = 30_000

export const AUDIO_SEMANTIC_LANGUAGES = ['zh', 'en', 'yue', 'ja', 'ko', 'nospeech'] as const
export type AudioSemanticLanguage = (typeof AUDIO_SEMANTIC_LANGUAGES)[number]

export const AUDIO_SEMANTIC_EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'unknown',
] as const
export type AudioSemanticEmotion = (typeof AUDIO_SEMANTIC_EMOTIONS)[number]

export const AUDIO_SEMANTIC_EVENT_LABELS = [
  'speech',
  'bgm',
  'applause',
  'laughter',
  'cry',
  'cough',
  'sneeze',
  'unknown',
] as const
export type AudioSemanticEventLabel = (typeof AUDIO_SEMANTIC_EVENT_LABELS)[number]

export interface AudioSemanticModelIdentity {
  modelId: string
  modelRevision: string
  runtime: 'fake' | 'funasr' | 'sensevoice-gguf'
  quantization: string
}

export interface AudioSemanticRuntimeStatus {
  adapterId: string
  state: 'not-installed' | 'ready' | 'busy' | 'unavailable' | 'error'
  reason?: string
  model?: AudioSemanticModelIdentity
}

export interface AudioSemanticEvent {
  label: AudioSemanticEventLabel
  startMs: number
  endMs: number
  confidence: number
}

export interface AudioSemanticSpeaker {
  localId: string
  modelId: string
  modelRevision: string
}

export interface AudioSemanticSegmentRecord {
  schemaVersion: typeof AUDIO_SEMANTIC_SCHEMA_VERSION
  segmentId: string
  generationId: string
  assetId: string
  videoId: string
  startMs: number
  endMs: number
  text: string
  language: AudioSemanticLanguage
  emotion: AudioSemanticEmotion
  audioEvents: AudioSemanticEvent[]
  transcriptRef: string
  speaker?: AudioSemanticSpeaker
  modelId: string
  modelRevision: string
  runtime: AudioSemanticModelIdentity['runtime']
  quantization: string
  sourceFingerprint: string
  createdAt: number
}
