import path from 'path'
import type {
  UnifiedDegradedReason,
  UnifiedSearchEvidence,
  UnifiedSearchExportFormat,
  UnifiedSearchExportRequest,
  UnifiedSearchRequest,
  UnifiedSearchResultItem,
  UnifiedTimelineFrameRate,
  UnifiedVideoEvidenceSource,
} from '../shared/ipc/unified-search'
import { normalizeUnifiedSearchQuery } from './unifiedSearchGuards'

const MAX_EXPORT_ITEMS = 500
const TIMELINE_FRAME_RATES = new Set<UnifiedTimelineFrameRate>([
  23.976, 24, 25, 29.97, 30, 50, 59.94, 60,
])
const SOURCE_TYPES = new Set([
  'local-ntfs',
  'local-generic',
  'removable',
  'mounted-network',
  'sftp',
  'nas-agent',
])
const SOURCE_AVAILABILITY = new Set(['online', 'offline', 'degraded', 'unknown'])
const HIT_TYPES = new Set([
  'filename',
  'image-semantic',
  'subject',
  'duplicate',
  'video-visual',
  'video-semantic',
  'dialogue',
  'mixed',
])
const LANES = new Set([
  'lexical',
  'semantic',
  'subject',
  'duplicate',
  'video-frame',
  'video-semantic',
  'subtitle',
])
const EVIDENCE_SOURCES = new Set([
  'cached-frame',
  'embedded-subtitle',
  'ai-visual-semantic',
  'ocr',
  'transcript-reference',
  'audio-event',
])
const DEGRADED_REASONS = new Set<UnifiedDegradedReason>([
  'vector-corrupt',
  'model-missing',
  'task-failed',
  'index-stale',
  'source-offline',
  'remote-content-required',
])

function boundedText(raw: unknown, maximum = 2_000): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().slice(0, maximum)
  return value || undefined
}

function boundedNumber(raw: unknown, maximum: number): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.min(maximum, raw)
    : undefined
}

function normalizeEvidence(raw: unknown): UnifiedSearchEvidence | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Partial<UnifiedSearchEvidence>
  const summary = boundedText(input.summary)
  if (!summary || !LANES.has(input.lane!) || !HIT_TYPES.has(input.hitType!)) return undefined
  const startMs = boundedNumber(input.startMs, 604_800_000)
  const rawEndMs = boundedNumber(input.endMs, 604_800_000)
  const endMs =
    rawEndMs !== undefined && startMs !== undefined && rawEndMs >= startMs ? rawEndMs : undefined
  const confidence = boundedNumber(input.confidence, 1)
  const evidenceSources = Array.isArray(input.evidenceSources)
    ? [
        ...new Set(
          input.evidenceSources
            .filter((value): value is UnifiedVideoEvidenceSource => EVIDENCE_SOURCES.has(value))
            .slice(0, EVIDENCE_SOURCES.size),
        ),
      ]
    : []
  const modelSources = Array.isArray(input.modelSources)
    ? input.modelSources.slice(0, 8).flatMap((model) => {
        const modelId = boundedText(model?.modelId, 256)
        if (!modelId) return []
        const modelRevision = boundedText(model?.modelRevision, 256)
        return [{ modelId, ...(modelRevision ? { modelRevision } : {}) }]
      })
    : []
  return {
    lane: input.lane!,
    hitType: input.hitType!,
    summary,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(startMs !== undefined ? { startMs: Math.floor(startMs) } : {}),
    ...(endMs !== undefined ? { endMs: Math.floor(endMs) } : {}),
    ...(evidenceSources.length ? { evidenceSources } : {}),
    ...(modelSources.length ? { modelSources } : {}),
  }
}

function normalizeItem(raw: unknown): UnifiedSearchResultItem | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Partial<UnifiedSearchResultItem>
  const fileEntryId = boundedText(input.fileEntryId, 512)
  const displayName = boundedText(input.displayName, 512)
  const displayPath = boundedText(input.displayPath, 4_096)
  const mediaType = boundedText(input.mediaType, 32)
  const source = input.source
  const sourceId = boundedText(source?.id, 256)
  const sourceName = boundedText(source?.name, 512)
  if (
    !fileEntryId ||
    !displayName ||
    !displayPath ||
    !mediaType ||
    !sourceId ||
    !sourceName ||
    !SOURCE_TYPES.has(source!.type) ||
    !SOURCE_AVAILABILITY.has(source!.availability)
  ) {
    return undefined
  }
  const sizeBytes = boundedNumber(input.sizeBytes, Number.MAX_SAFE_INTEGER) ?? 0
  const modifiedAt = boundedNumber(input.modifiedAt, 8_640_000_000_000_000) ?? 0
  const durationMs = boundedNumber(input.durationMs, 604_800_000)
  const width = boundedNumber(input.width, 100_000)
  const height = boundedNumber(input.height, 100_000)
  const score = boundedNumber(input.score, 100)
  const evidence = Array.isArray(input.evidence)
    ? input.evidence
        .slice(0, 12)
        .map(normalizeEvidence)
        .filter((entry): entry is UnifiedSearchEvidence => Boolean(entry))
    : []
  const indexState = Array.isArray(input.indexState)
    ? input.indexState
        .slice(0, 20)
        .map((value) => boundedText(value, 128))
        .filter((value): value is string => Boolean(value))
    : []
  return {
    fileEntryId,
    ...(boundedText(input.assetId, 512) ? { assetId: boundedText(input.assetId, 512) } : {}),
    mediaType,
    displayName,
    displayPath,
    sizeBytes: Math.floor(sizeBytes),
    modifiedAt,
    ...(boundedText(input.videoId, 512) ? { videoId: boundedText(input.videoId, 512) } : {}),
    ...(durationMs !== undefined ? { durationMs: Math.floor(durationMs) } : {}),
    ...(width !== undefined ? { width: Math.floor(width) } : {}),
    ...(height !== undefined ? { height: Math.floor(height) } : {}),
    source: {
      id: sourceId,
      name: sourceName,
      type: source!.type,
      availability: source!.availability,
    },
    indexState,
    ...(DEGRADED_REASONS.has(input.degradedReason!)
      ? { degradedReason: input.degradedReason }
      : {}),
    ...(score !== undefined ? { score } : {}),
    evidence,
  }
}

export function normalizeUnifiedSearchExportRequest(
  raw: unknown,
): UnifiedSearchExportRequest | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Partial<UnifiedSearchExportRequest>
  if (
    (input.format !== 'json' &&
      input.format !== 'csv' &&
      input.format !== 'edl' &&
      input.format !== 'fcpxml') ||
    !Array.isArray(input.items)
  ) {
    return undefined
  }
  const frameRate = TIMELINE_FRAME_RATES.has(input.frameRate!) ? input.frameRate : undefined
  if ((input.format === 'edl' || input.format === 'fcpxml') && frameRate === undefined) {
    return undefined
  }
  const items = input.items
    .slice(0, MAX_EXPORT_ITEMS)
    .map(normalizeItem)
    .filter((item): item is UnifiedSearchResultItem => Boolean(item))
  if (!items.length) return undefined
  return {
    format: input.format,
    search: normalizeUnifiedSearchQuery(input.search),
    items,
    ...(frameRate !== undefined ? { frameRate } : {}),
  }
}

interface ExportEvidenceRecord {
  hitType: UnifiedSearchEvidence['hitType']
  lane: UnifiedSearchEvidence['lane']
  summary: string
  startMs?: number
  endMs?: number
  confidence?: number
  evidenceSources: string[]
  models: string[]
}

interface ExportResultRecord {
  fileEntryId: string
  assetId?: string
  videoId?: string
  displayName: string
  displayPath: string
  mediaType: string
  sizeBytes: number
  modifiedAt: string
  source: UnifiedSearchResultItem['source']
  durationMs?: number
  width?: number
  height?: number
  indexState: string[]
  degradedReason?: UnifiedDegradedReason
  score?: number
  evidence: ExportEvidenceRecord[]
}

export interface UnifiedSearchExportDocument {
  schema: 'siftory-unified-search-export/v1'
  exportedAt: string
  query: {
    text?: string
    referenceImageUsed: boolean
    sourceId?: string
    filters?: UnifiedSearchRequest['filters']
  }
  resultCount: number
  results: ExportResultRecord[]
}

function projectEvidence(evidence: UnifiedSearchEvidence): ExportEvidenceRecord {
  return {
    hitType: evidence.hitType,
    lane: evidence.lane,
    summary: evidence.summary,
    ...(evidence.startMs !== undefined ? { startMs: evidence.startMs } : {}),
    ...(evidence.endMs !== undefined ? { endMs: evidence.endMs } : {}),
    ...(evidence.confidence !== undefined ? { confidence: evidence.confidence } : {}),
    evidenceSources: [...(evidence.evidenceSources ?? [])],
    models: (evidence.modelSources ?? []).map((model) =>
      model.modelRevision ? `${model.modelId}@${model.modelRevision}` : model.modelId,
    ),
  }
}

export function projectUnifiedSearchExportDocument(
  request: UnifiedSearchExportRequest,
  exportedAt = Date.now(),
): UnifiedSearchExportDocument {
  return {
    schema: 'siftory-unified-search-export/v1',
    exportedAt: new Date(exportedAt).toISOString(),
    query: {
      ...(request.search.query?.trim() ? { text: request.search.query.trim() } : {}),
      referenceImageUsed: Boolean(request.search.referenceImagePath),
      ...(request.search.sourceId ? { sourceId: request.search.sourceId } : {}),
      ...(request.search.filters ? { filters: request.search.filters } : {}),
    },
    resultCount: request.items.length,
    results: request.items.map((item) => ({
      fileEntryId: item.fileEntryId,
      ...(item.assetId ? { assetId: item.assetId } : {}),
      ...(item.videoId ? { videoId: item.videoId } : {}),
      displayName: item.displayName,
      displayPath: item.displayPath,
      mediaType: item.mediaType,
      sizeBytes: item.sizeBytes,
      modifiedAt: new Date(item.modifiedAt).toISOString(),
      source: { ...item.source },
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
      ...(item.width !== undefined ? { width: item.width } : {}),
      ...(item.height !== undefined ? { height: item.height } : {}),
      indexState: [...item.indexState],
      ...(item.degradedReason ? { degradedReason: item.degradedReason } : {}),
      ...(item.score !== undefined ? { score: item.score } : {}),
      evidence: item.evidence.map(projectEvidence),
    })),
  }
}

function safeCsvCell(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

export function serializeUnifiedSearchExport(
  request: UnifiedSearchExportRequest,
  exportedAt = Date.now(),
): string {
  const document = projectUnifiedSearchExportDocument(request, exportedAt)
  if (request.format === 'json') return `${JSON.stringify(document, null, 2)}\n`
  if (request.format !== 'csv') throw new Error('Structured serializer only supports JSON or CSV')
  const headers = [
    'query',
    'reference_image_used',
    'file_entry_id',
    'asset_id',
    'video_id',
    'display_name',
    'display_path',
    'media_type',
    'source_id',
    'source_name',
    'modified_at',
    'duration_ms',
    'index_state',
    'degraded_reason',
    'score',
    'hit_type',
    'hit_start_ms',
    'hit_end_ms',
    'confidence',
    'summary',
    'evidence_sources',
    'models',
  ]
  const rows: unknown[][] = []
  for (const result of document.results) {
    const evidenceRows = result.evidence.length ? result.evidence : [undefined]
    for (const evidence of evidenceRows) {
      rows.push([
        document.query.text,
        document.query.referenceImageUsed,
        result.fileEntryId,
        result.assetId,
        result.videoId,
        result.displayName,
        result.displayPath,
        result.mediaType,
        result.source.id,
        result.source.name,
        result.modifiedAt,
        result.durationMs,
        result.indexState.join(' + '),
        result.degradedReason,
        result.score,
        evidence?.hitType,
        evidence?.startMs,
        evidence?.endMs,
        evidence?.confidence,
        evidence?.summary,
        evidence?.evidenceSources.join(' + '),
        evidence?.models.join(' + '),
      ])
    }
  }
  return `\uFEFF${[headers, ...rows].map((row) => row.map(safeCsvCell).join(',')).join('\r\n')}\r\n`
}

export function normalizeUnifiedSearchExportPath(
  selectedPath: string,
  format: UnifiedSearchExportFormat,
): string | undefined {
  if (!path.isAbsolute(selectedPath) || selectedPath.includes('\0')) return undefined
  const resolved = path.resolve(selectedPath)
  const expectedExtension = `.${format}`
  return resolved.toLowerCase().endsWith(expectedExtension)
    ? resolved
    : `${resolved}${expectedExtension}`
}
