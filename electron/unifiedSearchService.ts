// ── Unified search service (Phase 3, design 9.2 / 9.3) ───
// One main-process search entry that merges the recall lanes: lexical
// metadata/filename (Discovery Catalog SQL), semantic vector recall, subject
// recall and duplicate-group recall. Design 9.2 constraints implemented here:
// - the base metadata query works with no AI model available;
// - vector corruption, missing models and task failures surface as explicit,
//   actionable lane states — never as a misleading empty result;
// - when AI recall is unavailable the response still carries the lexical
//   results marked 'metadata-only'; once indexing completes the same query
//   merges semantic scores and re-ranks (incremental enhancement).
// Pure module with injected recall lanes, so node --test drives it without
// electron, models or native addons.

import type { DiscoveryCatalogResultItem } from '../shared/ipc/discovery-catalog'
import { UNIFIED_MEDIA_EXTENSIONS } from '../shared/ipc/unified-search'
import type {
  UnifiedDegradedReason,
  UnifiedIndexStateLevel,
  UnifiedSearchEvidence,
  UnifiedSearchLane,
  UnifiedSearchLaneStatus,
  UnifiedSearchFilters,
  UnifiedSearchModelSource,
  UnifiedSearchRequest,
  UnifiedSearchRankingFeedback,
  UnifiedSearchResponse,
  UnifiedSearchResultItem,
  UnifiedVideoEvidenceSource,
  UnifiedVideoHit,
} from '../shared/ipc/unified-search'
import type { VectorIndexHealth } from './vectorIndexHealth'
import type { SubjectMaskSessionData } from './subjectMaskSession'

const VIDEO_EVIDENCE_FUSION_TOLERANCE_MS = 2_000
const MAX_VIDEO_EVIDENCE_FUSION_WINDOW_MS = 30_000
const MAX_RAW_VIDEO_EVIDENCE_HITS = 32
const MAX_FUSED_VIDEO_EVIDENCE_HITS = 8
const MAX_RESULT_EVIDENCE = 12
const VIDEO_EVIDENCE_SOURCE_ORDER: readonly UnifiedVideoEvidenceSource[] = [
  'cached-frame',
  'ai-visual-semantic',
  'ocr',
  'embedded-subtitle',
  'transcript-reference',
  'audio-event',
]

function videoHitEndMs(hit: UnifiedVideoHit): number {
  return Math.max(hit.timestampMs, hit.endMs ?? hit.timestampMs)
}

function uniqueVideoEvidenceSources(
  hits: readonly UnifiedVideoHit[],
): UnifiedVideoEvidenceSource[] {
  const present = new Set(hits.flatMap((hit) => hit.evidenceSources))
  return VIDEO_EVIDENCE_SOURCE_ORDER.filter((source) => present.has(source))
}

function uniqueVideoEvidenceModels(
  hits: readonly UnifiedVideoHit[],
): NonNullable<UnifiedVideoHit['generatedByAll']> {
  const models = new Map<string, { modelId: string; modelRevision?: string }>()
  for (const hit of hits) {
    for (const model of [
      ...(hit.generatedByAll ?? []),
      ...(hit.generatedBy ? [hit.generatedBy] : []),
    ]) {
      if (!model.modelId) continue
      models.set(`${model.modelId}\u0000${model.modelRevision ?? ''}`, {
        modelId: model.modelId.slice(0, 256),
        ...(model.modelRevision ? { modelRevision: model.modelRevision.slice(0, 256) } : {}),
      })
      if (models.size >= 8) break
    }
    if (models.size >= 8) break
  }
  return [...models.values()]
}

function fusedVideoEvidenceText(hits: readonly UnifiedVideoHit[]): string | undefined {
  const values = [
    ...new Set(
      hits.map((hit) => hit.text?.trim()).filter((value): value is string => Boolean(value)),
    ),
  ]
  return values.length ? values.join(' · ').slice(0, 2_000) : undefined
}

function fuseVideoEvidenceCluster(cluster: readonly UnifiedVideoHit[]): UnifiedVideoHit[] {
  const sources = uniqueVideoEvidenceSources(cluster)
  if (cluster.length < 2 || sources.length < 2) return [...cluster]
  const startMs = Math.min(...cluster.map((hit) => hit.timestampMs))
  const endMs = Math.max(...cluster.map(videoHitEndMs))
  const models = uniqueVideoEvidenceModels(cluster)
  const text = fusedVideoEvidenceText(cluster)
  return [
    {
      timestampMs: startMs,
      ...(endMs > startMs ? { endMs } : {}),
      score: Math.max(...cluster.map((hit) => hit.score)),
      kind: 'fused',
      evidenceSources: sources,
      ...(text ? { text } : {}),
      ...(models.length === 1 ? { generatedBy: models[0] } : {}),
      ...(models.length ? { generatedByAll: models } : {}),
    },
  ]
}

function fuseUnifiedVideoEvidence(hits: readonly UnifiedVideoHit[]): UnifiedVideoHit[] {
  const ordered = hits
    .slice(0, MAX_RAW_VIDEO_EVIDENCE_HITS)
    .sort((left, right) => left.timestampMs - right.timestampMs || right.score - left.score)
  const clusters: UnifiedVideoHit[][] = []
  for (const hit of ordered) {
    const current = clusters.at(-1)
    const currentEnd = current ? Math.max(...current.map(videoHitEndMs)) : -1
    const clusterStart = current?.[0]?.timestampMs ?? hit.timestampMs
    if (
      current &&
      hit.timestampMs <= currentEnd + VIDEO_EVIDENCE_FUSION_TOLERANCE_MS &&
      videoHitEndMs(hit) - clusterStart <= MAX_VIDEO_EVIDENCE_FUSION_WINDOW_MS
    ) {
      current.push(hit)
    } else {
      clusters.push([hit])
    }
  }
  return clusters
    .flatMap(fuseVideoEvidenceCluster)
    .sort(
      (left, right) =>
        new Set(right.evidenceSources).size - new Set(left.evidenceSources).size ||
        right.score - left.score ||
        left.timestampMs - right.timestampMs,
    )
    .slice(0, MAX_FUSED_VIDEO_EVIDENCE_HITS)
}

function clampEvidenceConfidence(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(1, value))
}

function boundedEvidenceText(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback.trim() || 'result').slice(0, 2_000)
}

function boundedModelSources(
  values: readonly UnifiedSearchModelSource[] | undefined,
): UnifiedSearchModelSource[] | undefined {
  if (!values?.length) return undefined
  const unique = new Map<string, UnifiedSearchModelSource>()
  for (const value of values) {
    const modelId = value.modelId.trim().slice(0, 256)
    const modelRevision = value.modelRevision?.trim().slice(0, 256)
    if (!modelId) continue
    unique.set(`${modelId}\u0000${modelRevision ?? ''}`, {
      modelId,
      ...(modelRevision ? { modelRevision } : {}),
    })
    if (unique.size >= 8) break
  }
  return unique.size ? [...unique.values()] : undefined
}

function recallHitType(lane: UnifiedSearchLane): UnifiedSearchEvidence['hitType'] {
  if (lane === 'image-fingerprint') return 'image-fingerprint'
  if (lane === 'semantic') return 'image-semantic'
  if (lane === 'subject') return 'subject'
  if (lane === 'duplicate') return 'duplicate'
  if (lane === 'video-frame') return 'video-visual'
  if (lane === 'video-semantic') return 'video-semantic'
  if (lane === 'subtitle') return 'dialogue'
  return 'filename'
}

function evidenceFromRecall(
  lane: UnifiedSearchLane,
  hit: UnifiedRecallHit,
  fallbackSummary: string,
): UnifiedSearchEvidence {
  const modelSources = boundedModelSources(hit.modelSources)
  return {
    lane,
    hitType: recallHitType(lane),
    summary: boundedEvidenceText(hit.evidenceSummary, fallbackSummary),
    ...(clampEvidenceConfidence(hit.score) !== undefined
      ? { confidence: clampEvidenceConfidence(hit.score) }
      : {}),
    ...(modelSources ? { modelSources } : {}),
  }
}

function evidenceFromVideoHit(hit: UnifiedVideoHit): UnifiedSearchEvidence {
  const modelSources = boundedModelSources([
    ...(hit.generatedByAll ?? []),
    ...(hit.generatedBy ? [hit.generatedBy] : []),
  ])
  const lane: UnifiedSearchLane =
    hit.kind === 'subtitle'
      ? 'subtitle'
      : hit.kind === 'semantic' || hit.kind === 'fused'
        ? 'video-semantic'
        : 'video-frame'
  return {
    lane,
    hitType:
      hit.kind === 'fused'
        ? 'mixed'
        : hit.kind === 'subtitle'
          ? 'dialogue'
          : hit.kind === 'semantic'
            ? 'video-semantic'
            : 'video-visual',
    summary: boundedEvidenceText(hit.text, hit.frameId ?? hit.evidenceSources.join(' + ')),
    confidence: clampEvidenceConfidence(hit.score) ?? 0,
    startMs: Math.max(0, Math.floor(hit.timestampMs)),
    ...(hit.endMs !== undefined
      ? { endMs: Math.max(Math.floor(hit.timestampMs), Math.floor(hit.endMs)) }
      : {}),
    evidenceSources: [...new Set(hit.evidenceSources)].slice(0, 8),
    ...(modelSources ? { modelSources } : {}),
  }
}

function appendEvidence(item: UnifiedSearchResultItem, evidence: UnifiedSearchEvidence): void {
  const key = `${evidence.lane}:${evidence.hitType}:${evidence.startMs ?? ''}:${evidence.endMs ?? ''}:${evidence.summary}`
  const exists = item.evidence.some(
    (entry) =>
      `${entry.lane}:${entry.hitType}:${entry.startMs ?? ''}:${entry.endMs ?? ''}:${entry.summary}` ===
      key,
  )
  if (!exists && item.evidence.length < MAX_RESULT_EVIDENCE) item.evidence.push(evidence)
}

export interface UnifiedSearchExecutionContext {
  subjectMaskSession?: SubjectMaskSessionData
  subjectMaskError?: string
}

export interface UnifiedRecallHit {
  displayPath: string
  score: number
  videoId?: string
  durationMs?: number
  width?: number
  height?: number
  videoHit?: UnifiedVideoHit
  /** Optional authoritative detail used by the main process evidence projector. */
  evidenceSummary?: string
  modelSources?: UnifiedSearchModelSource[]
}

export class UnifiedRecallError extends Error {
  constructor(
    message: string,
    readonly degradedReason: UnifiedDegradedReason,
    readonly actionableHint?: string,
  ) {
    super(message)
    this.name = 'UnifiedRecallError'
  }
}

export interface UnifiedLexicalRecallResult {
  items: DiscoveryCatalogResultItem[]
  total: number
  candidateTruncated?: boolean
}

export interface UnifiedSearchServiceDeps {
  lexicalRecall: (
    request: UnifiedSearchRequest,
  ) => UnifiedLexicalRecallResult | Promise<UnifiedLexicalRecallResult>
  imageFingerprintRecall?: (request: UnifiedSearchRequest) => Promise<UnifiedRecallHit[]>
  semanticRecall?: (request: UnifiedSearchRequest) => Promise<UnifiedRecallHit[]>
  subjectRecall?: (
    request: UnifiedSearchRequest,
    context?: UnifiedSearchExecutionContext,
  ) => Promise<UnifiedRecallHit[]>
  duplicateRecall?: (request: UnifiedSearchRequest) => Promise<UnifiedRecallHit[]>
  videoRecall?: (request: UnifiedSearchRequest) => Promise<UnifiedRecallHit[]>
  videoSemanticRecall?: (request: UnifiedSearchRequest) => Promise<UnifiedRecallHit[]>
  subtitleRecall?: (request: UnifiedSearchRequest) => Promise<UnifiedRecallHit[]>
  /** Probe the authoritative vector store before trusting semantic recall. */
  vectorHealth?: () => VectorIndexHealth | Promise<VectorIndexHealth>
  videoSemanticHealth?: () => {
    status: 'ready' | UnifiedDegradedReason
    detail?: string
    actionableHint?: string
  }
  /** Resolve AI hits back to authoritative Discovery Catalog rows. */
  hydrateRecallItems?: (
    displayPaths: readonly string[],
    request: UnifiedSearchRequest,
  ) => Promise<DiscoveryCatalogResultItem[]> | DiscoveryCatalogResultItem[]
  /** Read-only AssetId lookup keyed by normalized path (Phase 2 mapping). */
  resolveAssetId?: (
    displayPath: string,
    item: DiscoveryCatalogResultItem,
  ) => Promise<string | undefined> | string | undefined
  resolveMediaMetadata?: (
    displayPath: string,
    item: DiscoveryCatalogResultItem,
  ) =>
    | Promise<{ width?: number; height?: number; durationMs?: number } | undefined>
    | { width?: number; height?: number; durationMs?: number }
    | undefined
  resolveRankingFeedback?: (
    request: UnifiedSearchRequest,
    item: UnifiedSearchResultItem,
  ) => UnifiedSearchRankingFeedback | undefined
}

const HINTS: Record<UnifiedDegradedReason, string> = {
  'vector-corrupt': '向量索引内容证明校验失败，重建向量索引后语义搜索自动恢复',
  'model-missing': '视觉/文本模型不可用，安装模型后语义搜索自动恢复',
  'task-failed': '召回任务执行失败，可重试搜索或重建对应索引',
  'index-stale': '向量索引尚未建立或已过期，运行 embedding 阶段后排序自动增强',
  'source-offline': '来源离线，恢复连接后可获得完整结果',
  'remote-content-required': '远程视频仅有元数据；先受控取回原文件，再建立视频帧或字幕索引',
}

const MEDIA_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(UNIFIED_MEDIA_EXTENSIONS).flatMap(([type, extensions]) =>
    extensions.map((extension) => [extension, type]),
  ),
)

function normalizePathKey(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function mediaTypeFor(displayPath: string): string {
  const extension = displayPath.split('.').pop()?.toLowerCase() ?? ''
  return MEDIA_TYPES[extension] ?? 'file'
}

export function classifyUnifiedOrientation(
  width?: number,
  height?: number,
): 'landscape' | 'portrait' | 'square' | undefined {
  if (!width || !height || width <= 0 || height <= 0) return undefined
  const ratio = width / height
  if (ratio >= 0.95 && ratio <= 1.05) return 'square'
  return ratio > 1 ? 'landscape' : 'portrait'
}

export function matchesUnifiedSearchFilters(
  item: UnifiedSearchResultItem,
  filters?: UnifiedSearchFilters,
): boolean {
  if (!filters) return true
  if (filters.mediaTypes?.length && !filters.mediaTypes.some((type) => type === item.mediaType)) {
    return false
  }
  if (filters.sourceIds?.length && !filters.sourceIds.includes(item.source.id)) return false
  if (filters.modifiedAfter !== undefined && item.modifiedAt < filters.modifiedAfter) return false
  if (filters.modifiedBefore !== undefined && item.modifiedAt > filters.modifiedBefore) return false
  if (filters.minDurationMs !== undefined || filters.maxDurationMs !== undefined) {
    if (item.durationMs === undefined) return false
    if (filters.minDurationMs !== undefined && item.durationMs < filters.minDurationMs) return false
    if (filters.maxDurationMs !== undefined && item.durationMs > filters.maxDurationMs) return false
  }
  if (filters.orientations?.length) {
    const orientation = classifyUnifiedOrientation(item.width, item.height)
    if (!orientation || !filters.orientations.includes(orientation)) return false
  }
  if (
    filters.indexLevels?.length &&
    !filters.indexLevels.includes(item.indexState[0] as UnifiedIndexStateLevel)
  ) {
    return false
  }
  return true
}

export class UnifiedSearchService {
  constructor(private readonly deps: UnifiedSearchServiceDeps) {}

  async search(
    request: UnifiedSearchRequest,
    context?: UnifiedSearchExecutionContext,
  ): Promise<UnifiedSearchResponse> {
    const lanes: UnifiedSearchLaneStatus[] = []
    const offset = Math.max(0, Math.floor(request.offset ?? 0))
    const limit = Math.max(1, Math.min(500, Math.floor(request.limit ?? 100)))
    const hasFilters = Boolean(request.filters && Object.keys(request.filters).length)
    const recallRequest: UnifiedSearchRequest = {
      ...request,
      offset: 0,
      limit: hasFilters ? 500 : Math.min(500, offset + limit),
    }

    // 1. Lexical metadata/filename recall — always runs, model-free.
    let lexical: UnifiedLexicalRecallResult = { items: [], total: 0 }
    let candidateTruncated = false
    const mediaMetadata = new Map<
      string,
      Awaited<ReturnType<NonNullable<UnifiedSearchServiceDeps['resolveMediaMetadata']>>>
    >()
    const resolveMetadata = async (item: DiscoveryCatalogResultItem) => {
      const key = normalizePathKey(item.displayPath)
      if (!mediaMetadata.has(key))
        mediaMetadata.set(key, await this.deps.resolveMediaMetadata?.(item.displayPath, item))
      return mediaMetadata.get(key)
    }
    try {
      lexical = await this.deps.lexicalRecall(recallRequest)
      candidateTruncated = Boolean(lexical.candidateTruncated)
      if (hasFilters) {
        const accepted: DiscoveryCatalogResultItem[] = []
        const awaitingRecallMetadata: DiscoveryCatalogResultItem[] = []
        let scanned = 0
        const deadline = Date.now() + 3000
        // Deterministic SQL filters run in the provider. Metadata-only filters
        // may need later pages; never treat an unfiltered top-500 as the library.
        for (;;) {
          for (const item of lexical.items) {
            const metadata = await resolveMetadata(item)
            const missingDuration =
              metadata?.durationMs === undefined &&
              (request.filters?.minDurationMs !== undefined ||
                request.filters?.maxDurationMs !== undefined)
            const missingOrientation =
              Boolean(request.filters?.orientations?.length) &&
              classifyUnifiedOrientation(metadata?.width, metadata?.height) === undefined
            if (
              matchesUnifiedSearchFilters(
                {
                  ...item,
                  ...metadata,
                  mediaType: mediaTypeFor(item.displayPath),
                } as UnifiedSearchResultItem,
                {
                  ...request.filters,
                  indexLevels: undefined,
                  ...(missingDuration
                    ? { minDurationMs: undefined, maxDurationMs: undefined }
                    : {}),
                  ...(missingOrientation ? { orientations: undefined } : {}),
                },
              )
            ) {
              // AI lanes may contribute dimensions/duration later. Preserve
              // authoritative identities for that merge instead of dropping them.
              if (missingDuration || missingOrientation) awaitingRecallMetadata.push(item)
              else accepted.push(item)
            }
          }
          scanned += lexical.items.length
          const exhausted = scanned >= lexical.total || !lexical.items.length
          if (exhausted || accepted.length >= 500 || scanned >= 25000 || Date.now() >= deadline) {
            candidateTruncated =
              candidateTruncated || !exhausted || awaitingRecallMetadata.length > 500
            break
          }
          await new Promise<void>((resolve) => setImmediate(resolve))
          lexical = await this.deps.lexicalRecall({ ...recallRequest, offset: scanned, limit: 500 })
          candidateTruncated = candidateTruncated || Boolean(lexical.candidateTruncated)
        }
        lexical = {
          items: [...accepted.slice(0, 500), ...awaitingRecallMetadata.slice(0, 500)],
          total: accepted.length,
        }
      }
      lanes.push({ lane: 'lexical', status: 'ok' })
    } catch (error) {
      lanes.push({
        lane: 'lexical',
        status: 'degraded',
        degradedReason: 'task-failed',
        detail: error instanceof Error ? error.message : String(error),
        actionableHint: HINTS['task-failed'],
      })
    }

    // 2. AI lanes. Semantic recall is gated on vector index health so a
    // corrupted generation fails closed with an explicit reason (VAL-038).
    const aiLanes: Array<{
      lane: Exclude<UnifiedSearchLane, 'lexical'>
      recall?: (
        request: UnifiedSearchRequest,
        context?: UnifiedSearchExecutionContext,
      ) => Promise<UnifiedRecallHit[]>
      hits: UnifiedRecallHit[]
      applicable: boolean
    }> = [
      ...(this.deps.imageFingerprintRecall
        ? [
            {
              lane: 'image-fingerprint' as const,
              recall: this.deps.imageFingerprintRecall,
              hits: [],
              applicable: Boolean(request.referenceImagePath && !request.subject),
            },
          ]
        : []),
      {
        lane: 'semantic',
        recall: this.deps.semanticRecall,
        hits: [],
        applicable: Boolean(request.query?.trim()),
      },
      {
        lane: 'subject',
        recall: this.deps.subjectRecall,
        hits: [],
        applicable: Boolean(request.referenceImagePath),
      },
      {
        lane: 'duplicate',
        recall: this.deps.duplicateRecall,
        hits: [],
        applicable: Boolean(request.referenceImagePath),
      },
      {
        lane: 'video-frame',
        recall: this.deps.videoRecall,
        hits: [],
        applicable: Boolean(
          (!request.filters?.mediaTypes?.length || request.filters.mediaTypes.includes('video')) &&
          this.deps.videoRecall &&
          (request.query?.trim() || request.referenceImagePath),
        ),
      },
      {
        lane: 'video-semantic',
        recall: this.deps.videoSemanticRecall,
        hits: [],
        applicable: Boolean(
          (!request.filters?.mediaTypes?.length || request.filters.mediaTypes.includes('video')) &&
          (this.deps.videoSemanticRecall || this.deps.videoSemanticHealth) &&
          request.query?.trim(),
        ),
      },
      {
        lane: 'subtitle',
        recall: this.deps.subtitleRecall,
        hits: [],
        applicable: Boolean(
          (!request.filters?.mediaTypes?.length || request.filters.mediaTypes.includes('video')) &&
          this.deps.subtitleRecall &&
          request.query?.trim(),
        ),
      },
    ]
    const laneStatuses = new Map<UnifiedSearchLane, UnifiedSearchLaneStatus>()
    await Promise.all(
      aiLanes.map(async (aiLane) => {
        if (!aiLane.applicable) {
          const detail =
            aiLane.lane === 'semantic' ||
            aiLane.lane === 'video-semantic' ||
            aiLane.lane === 'subtitle'
              ? 'Text query not supplied'
              : 'Reference image not supplied'
          laneStatuses.set(aiLane.lane, {
            lane: aiLane.lane,
            status: 'not-applicable',
            detail,
          })
          return
        }
        if (!aiLane.recall) {
          const reason: UnifiedDegradedReason =
            aiLane.lane === 'duplicate'
              ? 'task-failed'
              : aiLane.lane === 'subtitle'
                ? 'index-stale'
                : 'model-missing'
          laneStatuses.set(aiLane.lane, {
            lane: aiLane.lane,
            status: 'unavailable',
            degradedReason: reason,
            detail: `No ${aiLane.lane} recall provider is configured`,
            actionableHint: HINTS[reason],
          })
          return
        }
        if (aiLane.lane === 'semantic' && this.deps.vectorHealth) {
          const health = await this.deps.vectorHealth()
          if (health.status !== 'ready') {
            const reason: UnifiedDegradedReason =
              health.status === 'vector-corrupt' ? 'vector-corrupt' : 'index-stale'
            laneStatuses.set(aiLane.lane, {
              lane: 'semantic',
              status: 'unavailable',
              degradedReason: reason,
              ...(health.detail !== undefined ? { detail: health.detail } : {}),
              actionableHint: HINTS[reason],
            })
            return
          }
        }
        if (aiLane.lane === 'video-semantic' && this.deps.videoSemanticHealth) {
          const health = this.deps.videoSemanticHealth()
          if (health.status !== 'ready') {
            const reason = health.status
            laneStatuses.set(aiLane.lane, {
              lane: 'video-semantic',
              status: reason === 'task-failed' ? 'degraded' : 'unavailable',
              degradedReason: reason,
              ...(health.detail !== undefined ? { detail: health.detail } : {}),
              actionableHint: health.actionableHint ?? HINTS[reason],
            })
            return
          }
        }
        try {
          aiLane.hits = await aiLane.recall(recallRequest, context)
          laneStatuses.set(aiLane.lane, { lane: aiLane.lane, status: 'ok' })
        } catch (error) {
          const recallError = error instanceof UnifiedRecallError ? error : undefined
          const reason = recallError?.degradedReason ?? 'task-failed'
          laneStatuses.set(aiLane.lane, {
            lane: aiLane.lane,
            status: 'degraded',
            degradedReason: reason,
            detail: error instanceof Error ? error.message : String(error),
            actionableHint: recallError?.actionableHint ?? HINTS[reason],
          })
        }
      }),
    )
    for (const aiLane of aiLanes) {
      const status = laneStatuses.get(aiLane.lane)
      if (status) lanes.push(status)
    }

    // 3. Merge: lexical base ∪ AI hits, deduplicated by normalized path key,
    // AI scores folded into scoreBreakdown (design 9.2 rerank step).
    const items = new Map<string, UnifiedSearchResultItem>()
    const lexicalOrder: string[] = []
    const recallPaths = aiLanes.flatMap((lane) => lane.hits.map((hit) => hit.displayPath))
    const hydrated = this.deps.hydrateRecallItems
      ? await this.deps.hydrateRecallItems(recallPaths, recallRequest)
      : []
    const catalogItems = new Map<string, DiscoveryCatalogResultItem>()
    const lexicalFileEntryIds = new Set(lexical.items.map((item) => item.fileEntryId))
    for (const item of lexical.items) {
      catalogItems.set(normalizePathKey(item.displayPath), item)
    }
    for (const item of hydrated) {
      for (const [key, existing] of catalogItems) {
        if (existing.fileEntryId === item.fileEntryId) catalogItems.delete(key)
      }
      catalogItems.set(normalizePathKey(item.recallPath ?? item.displayPath), item)
    }
    for (const [key, item] of catalogItems) {
      if (lexicalFileEntryIds.has(item.fileEntryId)) {
        lexicalOrder.push(key)
      }
      const assetId = this.deps.resolveAssetId
        ? await this.deps.resolveAssetId(item.displayPath, item)
        : undefined
      const mediaMetadata = await resolveMetadata(item)
      items.set(key, {
        fileEntryId: item.fileEntryId,
        mediaType: mediaTypeFor(item.displayPath),
        displayName: item.displayName,
        displayPath: item.displayPath,
        sizeBytes: item.sizeBytes,
        modifiedAt: item.modifiedAt,
        source: item.source,
        indexState: [...item.indexState],
        evidence: lexicalFileEntryIds.has(item.fileEntryId)
          ? [
              {
                lane: 'lexical',
                hitType: 'filename',
                summary: item.displayName.slice(0, 2_000),
              },
            ]
          : [],
        ...(assetId ? { assetId } : {}),
        ...(mediaMetadata?.width ? { width: mediaMetadata.width } : {}),
        ...(mediaMetadata?.height ? { height: mediaMetadata.height } : {}),
        ...(mediaMetadata?.durationMs !== undefined
          ? { durationMs: mediaMetadata.durationMs }
          : {}),
      })
    }
    let anyAiContribution = false
    for (const aiLane of aiLanes) {
      for (const hit of aiLane.hits) {
        const key = normalizePathKey(hit.displayPath)
        const existing = items.get(key)
        if (existing) {
          const previousLaneScore = existing.scoreBreakdown?.[aiLane.lane] ?? 0
          existing.scoreBreakdown = {
            ...existing.scoreBreakdown,
            [aiLane.lane]: Math.max(previousLaneScore, hit.score),
          }
          existing.score = Object.values(existing.scoreBreakdown).reduce(
            (total, laneScore) => total + laneScore,
            0,
          )
          if (hit.videoId) existing.videoId = hit.videoId
          if (hit.durationMs !== undefined) existing.durationMs = hit.durationMs
          if (hit.width !== undefined) existing.width = hit.width
          if (hit.height !== undefined) existing.height = hit.height
          if (!hit.videoHit) {
            appendEvidence(existing, evidenceFromRecall(aiLane.lane, hit, existing.displayName))
          }
          if (hit.videoHit) {
            const hitKey = `${hit.videoHit.kind}:${hit.videoHit.timestampMs}:${hit.videoHit.frameId ?? ''}`
            const videoHits = [...(existing.videoHits ?? [])]
            if (
              !videoHits.some(
                (entry) => `${entry.kind}:${entry.timestampMs}:${entry.frameId ?? ''}` === hitKey,
              )
            ) {
              videoHits.push(hit.videoHit)
            }
            videoHits.sort(
              (left, right) => right.score - left.score || left.timestampMs - right.timestampMs,
            )
            existing.videoHits = videoHits.slice(0, MAX_RAW_VIDEO_EVIDENCE_HITS)
            existing.videoHitMs = existing.videoHits[0]?.timestampMs
          }
          if (aiLane.lane !== 'image-fingerprint') anyAiContribution = true
        }
      }
    }

    for (const item of items.values()) {
      if (item.videoHits?.length) {
        item.videoHits = fuseUnifiedVideoEvidence(item.videoHits)
        item.videoHitMs = item.videoHits[0]?.timestampMs
        for (const hit of item.videoHits) appendEvidence(item, evidenceFromVideoHit(hit))
      }
      if (!item.evidence.length) {
        appendEvidence(item, {
          lane: 'lexical',
          hitType: 'filename',
          summary: item.displayName.slice(0, 2_000),
        })
      }
    }

    // 4. Per-item index state level + degradation propagation (design 9.3).
    const degradedAiLane = lanes.find(
      (lane) =>
        lane.lane !== 'lexical' &&
        lane.lane !== 'image-fingerprint' &&
        lane.status !== 'ok' &&
        lane.status !== 'not-applicable' &&
        lane.degradedReason,
    )
    const aiUnavailableReason = degradedAiLane?.degradedReason
    for (const item of items.values()) {
      const hasAiScores = Object.keys(item.scoreBreakdown ?? {}).some(
        (lane) => lane !== 'image-fingerprint',
      )
      const level: UnifiedIndexStateLevel = hasAiScores
        ? anyAiContribution && aiUnavailableReason
          ? 'partial'
          : 'full'
        : 'metadata-only'
      item.indexState = [level, ...item.indexState]
      if (item.source.availability === 'offline') {
        item.degradedReason = 'source-offline'
      } else if (
        item.mediaType === 'video' &&
        item.source.type === 'sftp' &&
        !item.videoHits?.length
      ) {
        item.degradedReason = 'remote-content-required'
      } else if (level === 'metadata-only' && aiUnavailableReason) {
        item.degradedReason = aiUnavailableReason
      }
      const rankingFeedback = this.deps.resolveRankingFeedback?.(request, item)
      if (rankingFeedback) {
        item.rankingFeedback = rankingFeedback
        if (rankingFeedback.incorrectTimestamps?.length && item.videoHits?.length) {
          const rejected = new Set(rankingFeedback.incorrectTimestamps)
          const isRejected = (hit: UnifiedVideoHit) =>
            [...rejected].some((timestamp) => Math.abs(timestamp - hit.timestampMs) <= 1_500)
          const alternatives = item.videoHits.filter((hit) => !isRejected(hit))
          if (alternatives.length) {
            item.videoHits = [...alternatives, ...item.videoHits.filter((hit) => isRejected(hit))]
            item.videoHitMs = alternatives[0].timestampMs
          }
        }
      }
    }

    // 5. Rerank: AI-scored items first (score desc), then lexical order.
    const lexicalRank = new Map(lexicalOrder.map((key, index) => [key, index]))
    const merged = [...items.entries()]
      .filter(([, item]) => matchesUnifiedSearchFilters(item, request.filters))
      .sort(([leftKey, left], [rightKey, right]) => {
        const leftScore = (left.score ?? 0) + (left.rankingFeedback?.adjustment ?? 0)
        const rightScore = (right.score ?? 0) + (right.rankingFeedback?.adjustment ?? 0)
        if (leftScore !== rightScore) return rightScore - leftScore
        return (
          (lexicalRank.get(leftKey) ?? Number.MAX_SAFE_INTEGER) -
          (lexicalRank.get(rightKey) ?? Number.MAX_SAFE_INTEGER)
        )
      })

    const applicableAiLanes = lanes.filter(
      (lane) =>
        lane.lane !== 'lexical' &&
        lane.lane !== 'image-fingerprint' &&
        lane.status !== 'not-applicable',
    )
    const anyAiLaneReady = applicableAiLanes.some((lane) => lane.status === 'ok')
    const aiEnhancement: UnifiedSearchResponse['aiEnhancement'] =
      applicableAiLanes.length === 0
        ? 'ready'
        : anyAiLaneReady
          ? 'ready'
          : aiUnavailableReason
            ? 'unavailable'
            : 'pending'
    const degradedLane = lanes.find(
      (lane) => lane.status !== 'ok' && lane.status !== 'not-applicable',
    )
    return {
      candidateTruncated: candidateTruncated || (!hasFilters && lexical.total > 500),
      items: merged.slice(offset, offset + limit).map(([, item]) => item),
      total: hasFilters ? merged.length : Math.max(lexical.total, items.size),
      lanes,
      aiEnhancement,
      ...(degradedLane?.degradedReason
        ? {
            degradedReason: degradedLane.degradedReason,
            ...(degradedLane.actionableHint !== undefined
              ? { actionableHint: degradedLane.actionableHint }
              : {}),
          }
        : {}),
    }
  }
}
