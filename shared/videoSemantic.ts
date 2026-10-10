export const VIDEO_SEMANTIC_PROFILE_REVISION = '2026-08-14.v1'
export const VIDEO_SEMANTIC_SCHEMA_VERSION = 1

/**
 * Explicitly approved local evaluation identity. This is not a bundled model and must never be
 * used as permission to pull, create, or update an Ollama model from the application.
 */
export const VIDEO_SEMANTIC_OLLAMA_TEST_IDENTITY = Object.freeze({
  modelName: 'qwen3-vl:2b',
  modelDigest: '0635d9d857d497aeadba3d7d27485746c50554446f9f6ec01ef39788221adbe8',
  quantization: 'Q4_K_M',
})

export const VIDEO_SEMANTIC_PROFILE_IDS = [
  'general',
  'film-series-animation',
  'short-form-vlog',
  'meeting-interview-podcast',
  'course-tutorial-screen',
  'game-stream',
  'surveillance-fixed',
  'sports',
] as const

export type VideoSemanticProfileId = (typeof VIDEO_SEMANTIC_PROFILE_IDS)[number]

export type VideoSemanticEvidenceKind =
  | 'visual'
  | 'subtitle'
  | 'speech'
  | 'ocr'
  | 'audio-event'
  | 'motion'

export interface VideoSemanticProfilePolicy {
  minSegmentMs: number
  targetSegmentMs: number
  maxSegmentMs: number
  minFrames: number
  maxFrames: number
  preferredFrameWidth: number
  skipStaticSegments: boolean
  evidencePriority: readonly VideoSemanticEvidenceKind[]
}

export interface VideoSemanticProfileDefinition {
  id: VideoSemanticProfileId
  displayName: string
  description: string
  policy: VideoSemanticProfilePolicy
}

export interface VideoSemanticProfileSignals {
  durationMs?: number
  width?: number
  height?: number
  /** Normalized 0..1. Higher values mean more frequent scene transitions. */
  shotChangeRate?: number
  /** Normalized 0..1 share of the duration containing speech. */
  speechRatio?: number
  /** Normalized 0..1 share of sampled frames containing meaningful text. */
  ocrCoverage?: number
  /** Normalized 0..1 visual motion/activity density. */
  motionDensity?: number
  /** Normalized 0..1 confidence that the content is a screen capture. */
  screenContentRatio?: number
  /** Normalized 0..1 confidence that the camera is fixed. */
  fixedCameraScore?: number
  /** Normalized 0..1 frequency of strong audio peaks. */
  audioPeakDensity?: number
  fileName?: string
  pathHints?: readonly string[]
  userOverride?: VideoSemanticProfileId | 'auto'
}

export type VideoSemanticProfileDecision = 'automatic' | 'fallback' | 'user-override'

export interface VideoSemanticProfilePlan {
  profileId: VideoSemanticProfileId
  profileRevision: string
  decision: VideoSemanticProfileDecision
  confidence: number
  reasons: readonly string[]
  scores: Readonly<Record<VideoSemanticProfileId, number>>
  policy: VideoSemanticProfilePolicy
}

export interface VideoSemanticEvent {
  label: string
  description: string
  startMs: number
  endMs: number
  confidence: number
}

export interface VideoSemanticPerson {
  /** Anonymous identifier scoped to one video generation, never a real-world identity claim. */
  localId: string
  description: string
  actions: string[]
  confidence: number
}

export interface VideoSemanticSegmentRecord {
  schemaVersion: typeof VIDEO_SEMANTIC_SCHEMA_VERSION
  segmentId: string
  generationId: string
  assetId: string
  videoId: string
  startMs: number
  endMs: number
  profileId: VideoSemanticProfileId
  summary: string
  scenes: string[]
  events: VideoSemanticEvent[]
  persons: VideoSemanticPerson[]
  objects: string[]
  searchTags: string[]
  visualText: string[]
  transcriptRefs: string[]
  audioEvents: string[]
  language?: string
  warnings: string[]
  evidenceFrameIds: string[]
  evidenceFrameDigest: string
  modelId: string
  modelRevision: string
  quantization: string
  promptVersion: string
  profileRevision: string
  sourceFingerprint: string
  createdAt: number
  updatedAt: number
}

export interface VideoSemanticGenerationIdentity {
  assetId: string
  videoId: string
  startMs: number
  endMs: number
  profileId: VideoSemanticProfileId
  evidenceFrameDigest: string
  modelId: string
  modelRevision: string
  quantization: string
  promptVersion: string
  profileRevision: string
  sourceFingerprint: string
}

export type VideoSemanticInvalidationReason =
  | 'asset-changed'
  | 'video-changed'
  | 'segment-boundary-changed'
  | 'profile-changed'
  | 'evidence-frames-changed'
  | 'model-changed'
  | 'prompt-changed'
  | 'source-fingerprint-changed'

export const VIDEO_SEMANTIC_JOB_STATES = [
  'queued',
  'running',
  'paused',
  'stopped',
  'done',
  'error',
] as const

export type VideoSemanticJobState = (typeof VIDEO_SEMANTIC_JOB_STATES)[number]

export interface VideoSemanticPlannedSegment {
  segmentId: string
  startMs: number
  endMs: number
  evidenceFrameIds: string[]
  evidenceFrameDigest: string
}

export interface VideoSemanticJobRecord {
  jobId: string
  assetId: string
  videoId: string
  generationId: string
  profileId: VideoSemanticProfileId
  planFingerprint: string
  segments: VideoSemanticPlannedSegment[]
  state: VideoSemanticJobState
  cursor: number
  completedSegments: number
  failedSegments: number
  attemptsBySegment: Record<string, number>
  currentSegmentId?: string
  lastError?: string
  createdAt: number
  updatedAt: number
}

export type VideoSemanticDeviceTier = 'low-vram-4g' | 'standard-vram' | 'cpu-memory' | 'unsupported'

export interface VideoSemanticResourceSnapshot {
  gpuTotalBytes?: number
  gpuFreeBytes?: number
  systemMemoryTotalBytes?: number
}

export interface VideoSemanticResourceBudget {
  tier: VideoSemanticDeviceTier
  execution: 'gpu' | 'cpu' | 'unavailable'
  maxConcurrency: 1
  maxFramesPerSegment: number
  preferredFrameWidth: number
  contextTokens: number
  maximumContextTokens: number
  maximumOutputTokens: number
  segmentTimeoutMs: number
  minimumFreeGpuBytes: number
  systemMemorySoftLimitBytes: number
  gpuLayers?: number
}

export type VideoSemanticResourceState = 'ready' | 'waiting-gpu' | 'unsupported'

export interface VideoSemanticResourceDecision {
  state: VideoSemanticResourceState
  budget: VideoSemanticResourceBudget
  reason?: string
}

export type VideoSemanticRuntimeState = 'not-installed' | 'ready' | 'busy' | 'unavailable' | 'error'

export interface VideoSemanticModelIdentity {
  modelId: string
  modelRevision: string
  quantization: string
}

export interface VideoSemanticRuntimeStatus {
  adapterId: string
  state: VideoSemanticRuntimeState
  model?: VideoSemanticModelIdentity
  reason?: string
}

export const VIDEO_SEMANTIC_PROFILES: Readonly<
  Record<VideoSemanticProfileId, VideoSemanticProfileDefinition>
> = {
  general: {
    id: 'general',
    displayName: 'General video',
    description:
      'Balanced visual-first policy for material without a confident specialized profile.',
    policy: {
      minSegmentMs: 15_000,
      targetSegmentMs: 22_000,
      maxSegmentMs: 30_000,
      minFrames: 4,
      maxFrames: 8,
      preferredFrameWidth: 384,
      skipStaticSegments: false,
      evidencePriority: ['visual', 'subtitle', 'speech', 'ocr', 'audio-event', 'motion'],
    },
  },
  'film-series-animation': {
    id: 'film-series-animation',
    displayName: 'Film, series, or animation',
    description: 'Shot-aware visual and dialogue policy for narrative video.',
    policy: {
      minSegmentMs: 15_000,
      targetSegmentMs: 24_000,
      maxSegmentMs: 30_000,
      minFrames: 4,
      maxFrames: 8,
      preferredFrameWidth: 448,
      skipStaticSegments: false,
      evidencePriority: ['visual', 'subtitle', 'speech', 'audio-event', 'ocr', 'motion'],
    },
  },
  'short-form-vlog': {
    id: 'short-form-vlog',
    displayName: 'Short-form video or vlog',
    description: 'Dense visual, speech, and on-screen-text policy for short edited content.',
    policy: {
      minSegmentMs: 8_000,
      targetSegmentMs: 14_000,
      maxSegmentMs: 20_000,
      minFrames: 4,
      maxFrames: 8,
      preferredFrameWidth: 384,
      skipStaticSegments: false,
      evidencePriority: ['visual', 'speech', 'ocr', 'subtitle', 'audio-event', 'motion'],
    },
  },
  'meeting-interview-podcast': {
    id: 'meeting-interview-podcast',
    displayName: 'Meeting, interview, or podcast',
    description: 'Speech-first policy with sparse visual sampling for long conversations.',
    policy: {
      minSegmentMs: 30_000,
      targetSegmentMs: 45_000,
      maxSegmentMs: 60_000,
      minFrames: 2,
      maxFrames: 4,
      preferredFrameWidth: 384,
      skipStaticSegments: false,
      evidencePriority: ['speech', 'subtitle', 'visual', 'audio-event', 'ocr', 'motion'],
    },
  },
  'course-tutorial-screen': {
    id: 'course-tutorial-screen',
    displayName: 'Course, tutorial, or screen recording',
    description: 'OCR and speech-led policy aligned to slide or interface changes.',
    policy: {
      minSegmentMs: 10_000,
      targetSegmentMs: 15_000,
      maxSegmentMs: 20_000,
      minFrames: 3,
      maxFrames: 6,
      preferredFrameWidth: 448,
      skipStaticSegments: false,
      evidencePriority: ['ocr', 'speech', 'visual', 'subtitle', 'motion', 'audio-event'],
    },
  },
  'game-stream': {
    id: 'game-stream',
    displayName: 'Game or live stream',
    description: 'Motion, HUD text, visual-event, and commentary policy for gameplay.',
    policy: {
      minSegmentMs: 10_000,
      targetSegmentMs: 15_000,
      maxSegmentMs: 20_000,
      minFrames: 4,
      maxFrames: 8,
      preferredFrameWidth: 448,
      skipStaticSegments: false,
      evidencePriority: ['visual', 'ocr', 'motion', 'speech', 'audio-event', 'subtitle'],
    },
  },
  'surveillance-fixed': {
    id: 'surveillance-fixed',
    displayName: 'Surveillance or fixed camera',
    description:
      'Change-triggered policy that skips static intervals and preserves event boundaries.',
    policy: {
      minSegmentMs: 5_000,
      targetSegmentMs: 10_000,
      maxSegmentMs: 15_000,
      minFrames: 3,
      maxFrames: 6,
      preferredFrameWidth: 384,
      skipStaticSegments: true,
      evidencePriority: ['motion', 'visual', 'audio-event', 'ocr', 'speech', 'subtitle'],
    },
  },
  sports: {
    id: 'sports',
    displayName: 'Sports',
    description: 'High-motion, score-overlay, and audio-peak policy for sports events.',
    policy: {
      minSegmentMs: 5_000,
      targetSegmentMs: 10_000,
      maxSegmentMs: 15_000,
      minFrames: 6,
      maxFrames: 10,
      preferredFrameWidth: 448,
      skipStaticSegments: false,
      evidencePriority: ['motion', 'visual', 'ocr', 'audio-event', 'speech', 'subtitle'],
    },
  },
}

export function isVideoSemanticProfileId(value: unknown): value is VideoSemanticProfileId {
  return (
    typeof value === 'string' && (VIDEO_SEMANTIC_PROFILE_IDS as readonly string[]).includes(value)
  )
}

export function videoSemanticGenerationIdentity(
  record: VideoSemanticSegmentRecord,
): VideoSemanticGenerationIdentity {
  return {
    assetId: record.assetId,
    videoId: record.videoId,
    startMs: record.startMs,
    endMs: record.endMs,
    profileId: record.profileId,
    evidenceFrameDigest: record.evidenceFrameDigest,
    modelId: record.modelId,
    modelRevision: record.modelRevision,
    quantization: record.quantization,
    promptVersion: record.promptVersion,
    profileRevision: record.profileRevision,
    sourceFingerprint: record.sourceFingerprint,
  }
}

export function getVideoSemanticInvalidationReasons(
  current: VideoSemanticGenerationIdentity,
  expected: VideoSemanticGenerationIdentity,
): VideoSemanticInvalidationReason[] {
  const reasons: VideoSemanticInvalidationReason[] = []
  if (current.assetId !== expected.assetId) reasons.push('asset-changed')
  if (current.videoId !== expected.videoId) reasons.push('video-changed')
  if (current.startMs !== expected.startMs || current.endMs !== expected.endMs) {
    reasons.push('segment-boundary-changed')
  }
  if (
    current.profileId !== expected.profileId ||
    current.profileRevision !== expected.profileRevision
  ) {
    reasons.push('profile-changed')
  }
  if (current.evidenceFrameDigest !== expected.evidenceFrameDigest) {
    reasons.push('evidence-frames-changed')
  }
  if (
    current.modelId !== expected.modelId ||
    current.modelRevision !== expected.modelRevision ||
    current.quantization !== expected.quantization
  ) {
    reasons.push('model-changed')
  }
  if (current.promptVersion !== expected.promptVersion) reasons.push('prompt-changed')
  if (current.sourceFingerprint !== expected.sourceFingerprint) {
    reasons.push('source-fingerprint-changed')
  }
  return reasons
}
