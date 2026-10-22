// Phase 3 unified staged tasks & unified search contracts.
// Design: docs/designs/2026-08-11-local-nas-ai-asset-discovery-architecture.md
// sections 8 (staged pipeline), 9 (unified search & result contract),
// 14 (Phase 3 acceptance). Storage authority unchanged: the scheduler and
// search service never write to assets.jsonl, asset-library.sqlite or the
// native manifest (docs/reference/2026-08-11-storage-authority-boundaries.md).

import type { SourceAvailability, SourceType } from './discovery-catalog'
import type { SubjectBBox } from './subject-search'

// ── Staged task scheduling (design 8.1 / 8.2) ────────────
// Stage ladder D1-D6. D1 discovery must never be starved by D3-D6; GPU-heavy
// stages (D5 embedding, D6 video deep indexing) run on an isolated lane so
// they cannot block native discovery, SQLite queries or file operations.

export type UnifiedTaskStage =
  | 'discovery' // D1
  | 'metadata' // D2
  | 'preview' // D3
  | 'hash' // D4
  | 'embedding' // D5
  | 'video-deep' // D6

export type UnifiedTaskLane = 'local' | 'gpu'

/** Design 8.2 priorities: P0 visible/explicit → P4 background maintenance. */
export type UnifiedTaskPriority = 0 | 1 | 2 | 3 | 4

export interface UnifiedSchedulerLaneStats {
  running: number
  queued: number
  completed: number
  failed: number
  cancelled: number
}

export type UnifiedResourceProfile = 'power-saver' | 'balanced' | 'quality'
export type UnifiedResourcePressureReason = 'cpu' | 'memory' | 'vram' | 'disk' | 'battery'

export interface UnifiedResourcePolicySnapshot {
  localConcurrency: number
  gpuConcurrency: number
  ioConcurrency: number
  maxQueued: number
  cpuTargetPercent: number
  maxWorkingSetBytes: number
  minFreeMemoryBytes: number
  minFreeVideoMemoryBytes: number
  minFreeDiskBytes: number
}

export interface UnifiedResourceGovernorStats {
  profile: UnifiedResourceProfile
  policy: UnifiedResourcePolicySnapshot
  effectiveLocalConcurrency: number
  effectiveGpuConcurrency: number
  backgroundPaused: boolean
  pressureReasons: UnifiedResourcePressureReason[]
  cancelledForPolicy: number
}

export interface UnifiedSchedulerStats {
  lanes: Record<UnifiedTaskLane, UnifiedSchedulerLaneStats>
  resource: UnifiedResourceGovernorStats
}

// ── Unified search (design 9.2 / 9.3) ────────────────────

/** Actionable degradation causes; never silently return an empty result. */
export type UnifiedDegradedReason =
  | 'vector-corrupt'
  | 'model-missing'
  | 'task-failed'
  | 'index-stale'
  | 'source-offline'
  | 'remote-content-required'

export type UnifiedSearchLane =
  | 'lexical'
  | 'image-fingerprint'
  | 'semantic'
  | 'subject'
  | 'duplicate'
  | 'video-frame'
  | 'video-semantic'
  | 'subtitle'

export interface UnifiedSearchLaneStatus {
  lane: UnifiedSearchLane
  /** not-applicable means this request did not supply the lane's required input. */
  status: 'ok' | 'degraded' | 'unavailable' | 'not-applicable'
  degradedReason?: UnifiedDegradedReason
  detail?: string
  /** User-actionable next step, e.g. rebuild the vector index. */
  actionableHint?: string
}

/** Summary index-state levels attached to every result item (design 9.3). */
export type UnifiedIndexStateLevel = 'metadata-only' | 'partial' | 'full'

export type UnifiedSearchMediaType = 'image' | 'video' | 'audio' | 'file'
export type UnifiedSearchOrientation = 'landscape' | 'portrait' | 'square'

export interface UnifiedSearchFilters {
  mediaTypes?: UnifiedSearchMediaType[]
  sourceIds?: string[]
  modifiedAfter?: number
  modifiedBefore?: number
  minDurationMs?: number
  maxDurationMs?: number
  orientations?: UnifiedSearchOrientation[]
  indexLevels?: UnifiedIndexStateLevel[]
}

export interface UnifiedSearchRequest {
  query?: string
  /** Optional image query. Enables subject and persisted duplicate-group recall. */
  referenceImagePath?: string
  /** Optional user-selected subject region within referenceImagePath. */
  subject?: SubjectBBox
  /** Opaque, sender-scoped capability for an authoritative SAM mask. */
  segmentationSessionId?: string
  sourceId?: string
  filters?: UnifiedSearchFilters
  offset?: number
  limit?: number
}

export interface UnifiedVideoHit {
  timestampMs: number
  score: number
  kind: 'visual' | 'subtitle' | 'semantic' | 'fused'
  /** Main-process evidence projection; Renderer never infers provenance from text. */
  evidenceSources: UnifiedVideoEvidenceSource[]
  frameId?: string
  text?: string
  endMs?: number
  generatedBy?: {
    modelId: string
    modelRevision?: string
  }
  /** Every bounded model authority contributing to a fused time window. */
  generatedByAll?: Array<{
    modelId: string
    modelRevision?: string
  }>
}

export type UnifiedVideoEvidenceSource =
  | 'cached-frame'
  | 'embedded-subtitle'
  | 'ai-visual-semantic'
  | 'ocr'
  | 'transcript-reference'
  | 'audio-event'

export type UnifiedSearchHitType =
  | 'filename'
  | 'image-fingerprint'
  | 'image-semantic'
  | 'subject'
  | 'duplicate'
  | 'video-visual'
  | 'video-semantic'
  | 'dialogue'
  | 'mixed'

export interface UnifiedSearchModelSource {
  modelId: string
  modelRevision?: string
}

/**
 * Main-process evidence projection attached to a result. The Renderer formats
 * these fields but never derives provenance from filenames, free text or scores.
 */
export interface UnifiedSearchEvidence {
  lane: UnifiedSearchLane
  hitType: UnifiedSearchHitType
  summary: string
  confidence?: number
  startMs?: number
  endMs?: number
  evidenceSources?: UnifiedVideoEvidenceSource[]
  modelSources?: UnifiedSearchModelSource[]
}

export type UnifiedSearchFeedbackKind = 'relevant' | 'irrelevant' | 'timestamp-wrong'

export interface UnifiedSearchFeedbackTarget {
  fileEntryId: string
  assetId?: string
  videoId?: string
  timestampMs?: number
}

export interface UnifiedSearchFeedbackRequest {
  search: UnifiedSearchRequest
  target: UnifiedSearchFeedbackTarget
  kind: UnifiedSearchFeedbackKind
}

export interface UnifiedSearchFeedbackMutationResult {
  ok: boolean
  feedbackId?: string
  error?: string
}

export interface UnifiedSearchRankingFeedback {
  adjustment: number
  reason:
    | 'relevant'
    | 'irrelevant'
    | 'timestamp-wrong'
    | 'relevant-and-timestamp-wrong'
    | 'irrelevant-and-timestamp-wrong'
  feedbackCount: number
  updatedAt: number
  incorrectTimestamps?: number[]
}

export type UnifiedSearchExportFormat = 'json' | 'csv' | 'edl' | 'fcpxml'
export type UnifiedTimelineFrameRate = 23.976 | 24 | 25 | 29.97 | 30 | 50 | 59.94 | 60

export interface UnifiedSearchExportRequest {
  format: UnifiedSearchExportFormat
  search: UnifiedSearchRequest
  items: UnifiedSearchResultItem[]
  frameRate?: UnifiedTimelineFrameRate
}

export interface UnifiedSearchExportResult {
  ok: boolean
  filePath?: string
  exportedCount?: number
  skippedCount?: number
  clampedCount?: number
  error?: string
}

export interface UnifiedSearchResultItem {
  fileEntryId: string
  assetId?: string
  mediaType: string
  displayName: string
  displayPath: string
  sizeBytes: number
  modifiedAt: number
  /** Media Search authority; lets the existing safe videoId action open a hit. */
  videoId?: string
  durationMs?: number
  width?: number
  height?: number
  /** Best hit retained for compact result cards; videoHits keeps alternatives. */
  videoHitMs?: number
  videoHits?: UnifiedVideoHit[]
  source: {
    id: string
    name: string
    type: SourceType
    availability: SourceAvailability
  }
  /** Summary level first, then the underlying catalog stage states. */
  indexState: string[]
  degradedReason?: UnifiedDegradedReason
  score?: number
  scoreBreakdown?: Record<string, number>
  /** Bounded, authoritative explanations for why this item matched. */
  evidence: UnifiedSearchEvidence[]
  /** Local-only, deterministic personal ranking correction. */
  rankingFeedback?: UnifiedSearchRankingFeedback
}

export interface UnifiedSearchResponse {
  items: UnifiedSearchResultItem[]
  total: number
  lanes: UnifiedSearchLaneStatus[]
  /**
   * 'ready' — AI recall merged into this response; 'pending' — AI indexing
   * still running, re-query later for enhanced ranking; 'unavailable' — AI
   * cannot run (see lanes[].degradedReason). Metadata results are returned in
   * every state.
   */
  aiEnhancement: 'ready' | 'pending' | 'unavailable'
  degradedReason?: UnifiedDegradedReason
  actionableHint?: string
}

export const UNIFIED_SEARCH_IPC = {
  QUERY: 'catalog:unifiedSearch/query',
  SET_VISIBLE_PATHS: 'catalog:unifiedSearch/setVisiblePaths',
  SCHEDULER_STATS: 'catalog:unifiedSearch/schedulerStats',
  RESOURCE_PROFILE_SET: 'catalog:unifiedSearch/resourceProfile/set',
  RESOURCE_BACKGROUND_CANCEL: 'catalog:unifiedSearch/resourceBackground/cancel',
  FEEDBACK_SAVE: 'catalog:unifiedSearch/feedbackSave',
  FEEDBACK_UNDO: 'catalog:unifiedSearch/feedbackUndo',
  EXPORT_SAVE: 'catalog:unifiedSearch/exportSave',
} as const
