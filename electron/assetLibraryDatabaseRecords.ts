import { createHash } from 'crypto'
import type { SQLInputValue } from 'node:sqlite'
import type {
  AssetCategory,
  AssetCategoryAssignment,
  AssetClassificationSuggestion,
  AssetClusterGroup,
  AssetTag,
  AssetTagAssignment,
} from '../shared/ipc/asset-library'

const SAMPLE_LIMIT = 100

export interface ImportReport {
  skipped: boolean
  counts: Record<string, number>
  hashes: Record<string, string>
  badLines: number
}

export interface ExportReport {
  targetDir: string
  counts: Record<string, number>
}

export interface VerifyTableReport {
  ok: boolean
  expectedCount: number
  actualCount: number
  expectedHash: string
  actualHash: string
  sourceBadLines: number
}

export interface VerifyReport {
  ok: boolean
  tables: Record<string, VerifyTableReport>
}

export type JsonObject = Record<string, unknown>

export interface TableSpec {
  /** SQLite table name. */
  name: string
  /** JSONL file name inside the asset library directory. */
  file: string
  insertSql: string
  /** Normalize a parsed JSONL record; returns null when the record is unusable. */
  fromJson(record: JsonObject): JsonObject | null
  /** Normalize a SQLite row back into the same shape fromJson produces. */
  fromRow(row: JsonObject): JsonObject
  /** Bind values for insertSql, taken from a normalized record. */
  toValues(record: JsonObject): SQLInputValue[]
}

export class CorruptJsonlError extends Error {}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function numberOr(value: unknown, fallback: number): number {
  return finiteNumber(value) ?? fallback
}

export function optionalNumber(value: unknown): number | null {
  return finiteNumber(value)
}

export function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function requiredText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === 'string')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (isJsonObject(value)) {
    const result: JsonObject = {}
    for (const key of Object.keys(value).sort()) {
      const item = value[key]
      if (item !== undefined) result[key] = canonicalize(item)
    }
    return result
  }
  return value ?? null
}

/** Deterministic JSON: object keys sorted recursively, so key order never affects hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** Head/middle/tail sample (up to SAMPLE_LIMIT each) over an id-sorted row list. */
function sampleIndices(length: number): number[] {
  const size = Math.min(SAMPLE_LIMIT, length)
  const indices = new Set<number>()
  for (let index = 0; index < size; index++) indices.add(index)
  const middleStart = Math.max(0, Math.floor(length / 2) - Math.floor(size / 2))
  for (let index = middleStart; index < Math.min(length, middleStart + size); index++) {
    indices.add(index)
  }
  for (let index = Math.max(0, length - size); index < length; index++) indices.add(index)
  return [...indices].sort((left, right) => left - right)
}

export function hashNormalizedRecords(records: readonly JsonObject[]): string {
  const sorted = [...records].sort((left, right) => numberOr(left.id, 0) - numberOr(right.id, 0))
  const hash = createHash('sha256')
  for (const index of sampleIndices(sorted.length)) {
    hash.update(`${canonicalJson(sorted[index])}\n`)
  }
  return hash.digest('hex')
}

function normalizeCategory(record: JsonObject): JsonObject | null {
  const id = finiteNumber(record.id)
  const name = requiredText(record.name)
  if (id === null || name === null) return null
  return {
    id,
    name,
    description: textOr(record.description, ''),
    parentId: optionalNumber(record.parentId),
    color: textOr(record.color, ''),
    icon: textOr(record.icon, ''),
    sortOrder: numberOr(record.sortOrder, 0),
    referenceThreshold: optionalNumber(record.referenceThreshold),
    sourceClusterGroupId: optionalNumber(record.sourceClusterGroupId),
    createdAt: numberOr(record.createdAt, 0),
    updatedAt: numberOr(record.updatedAt, 0),
  }
}

function categoryFromRow(row: JsonObject): JsonObject {
  return {
    id: numberOr(row.id, 0),
    name: textOr(row.name, ''),
    description: textOr(row.description, ''),
    parentId: optionalNumber(row.parent_id),
    color: textOr(row.color, ''),
    icon: textOr(row.icon, ''),
    sortOrder: numberOr(row.sort_order, 0),
    referenceThreshold: optionalNumber(row.reference_threshold),
    sourceClusterGroupId: optionalNumber(row.source_cluster_group_id),
    createdAt: numberOr(row.created_at, 0),
    updatedAt: numberOr(row.updated_at, 0),
  }
}

function normalizeTag(record: JsonObject): JsonObject | null {
  const id = finiteNumber(record.id)
  const name = requiredText(record.name)
  if (id === null || name === null) return null
  return {
    id,
    name,
    color: textOr(record.color, ''),
    createdAt: numberOr(record.createdAt, 0),
    updatedAt: numberOr(record.updatedAt, 0),
  }
}

function tagFromRow(row: JsonObject): JsonObject {
  return {
    id: numberOr(row.id, 0),
    name: textOr(row.name, ''),
    color: textOr(row.color, ''),
    createdAt: numberOr(row.created_at, 0),
    updatedAt: numberOr(row.updated_at, 0),
  }
}

function makeAssignmentNormalizer(targetKey: 'categoryId' | 'tagId') {
  return (record: JsonObject): JsonObject | null => {
    const id = finiteNumber(record.id)
    const assetId = finiteNumber(record.assetId)
    const targetId = finiteNumber(record[targetKey])
    if (id === null || assetId === null || targetId === null) return null
    return {
      id,
      assetId,
      [targetKey]: targetId,
      suggestionId: optionalNumber(record.suggestionId),
      confidence: numberOr(record.confidence, 1),
      source: textOr(record.source, ''),
      status: textOr(record.status, ''),
      confirmedByUser: record.confirmedByUser === true,
      createdAt: numberOr(record.createdAt, 0),
      updatedAt: numberOr(record.updatedAt, 0),
    }
  }
}

function makeAssignmentRowReader(targetKey: 'categoryId' | 'tagId', targetColumn: string) {
  return (row: JsonObject): JsonObject => ({
    id: numberOr(row.id, 0),
    assetId: numberOr(row.asset_id, 0),
    [targetKey]: numberOr(row[targetColumn], 0),
    suggestionId: optionalNumber(row.suggestion_id),
    confidence: numberOr(row.confidence, 1),
    source: textOr(row.source, ''),
    status: textOr(row.status, ''),
    confirmedByUser: numberOr(row.confirmed_by_user, 0) === 1,
    createdAt: numberOr(row.created_at, 0),
    updatedAt: numberOr(row.updated_at, 0),
  })
}

function assignmentValues(record: JsonObject, targetKey: 'categoryId' | 'tagId'): SQLInputValue[] {
  return [
    numberOr(record.id, 0),
    numberOr(record.assetId, 0),
    numberOr(record[targetKey], 0),
    optionalNumber(record.suggestionId),
    numberOr(record.confidence, 1),
    textOr(record.source, ''),
    textOr(record.status, ''),
    record.confirmedByUser === true ? 1 : 0,
    numberOr(record.createdAt, 0),
    numberOr(record.updatedAt, 0),
  ]
}

function normalizeReference(record: JsonObject): JsonObject | null {
  const id = finiteNumber(record.id)
  const categoryId = finiteNumber(record.categoryId)
  const assetId = finiteNumber(record.assetId)
  if (id === null || categoryId === null || assetId === null) return null
  return {
    id,
    categoryId,
    assetId,
    weight: numberOr(record.weight, 1),
    createdAt: numberOr(record.createdAt, 0),
  }
}

function referenceFromRow(row: JsonObject): JsonObject {
  return {
    id: numberOr(row.id, 0),
    categoryId: numberOr(row.category_id, 0),
    assetId: numberOr(row.asset_id, 0),
    weight: numberOr(row.weight, 1),
    createdAt: numberOr(row.created_at, 0),
  }
}

export function parseIdArray(value: unknown): number[] {
  if (typeof value !== 'string' || !value) return []
  try {
    return numberArray(JSON.parse(value))
  } catch {
    return []
  }
}

function normalizeSuggestion(record: JsonObject): JsonObject | null {
  const id = finiteNumber(record.id)
  const assetId = finiteNumber(record.assetId)
  if (id === null || assetId === null) return null
  return {
    id,
    assetId,
    categoryId: optionalNumber(record.categoryId),
    tagId: optionalNumber(record.tagId),
    confidence: numberOr(record.confidence, 0),
    source: textOr(record.source, ''),
    status: textOr(record.status, ''),
    evidenceAssetIds: numberArray(record.evidenceAssetIds),
    createdAt: numberOr(record.createdAt, 0),
    updatedAt: numberOr(record.updatedAt, 0),
  }
}

function suggestionFromRow(row: JsonObject): JsonObject {
  return {
    id: numberOr(row.id, 0),
    assetId: numberOr(row.asset_id, 0),
    categoryId: optionalNumber(row.category_id),
    tagId: optionalNumber(row.tag_id),
    confidence: numberOr(row.confidence, 0),
    source: textOr(row.source, ''),
    status: textOr(row.status, ''),
    evidenceAssetIds: parseIdArray(row.evidence_asset_ids),
    createdAt: numberOr(row.created_at, 0),
    updatedAt: numberOr(row.updated_at, 0),
  }
}

function normalizeClusterGroup(record: JsonObject): JsonObject | null {
  const id = finiteNumber(record.id)
  const name = requiredText(record.name)
  const algorithm = requiredText(record.algorithm)
  const status = requiredText(record.status)
  if (id === null || name === null || algorithm === null || status === null) return null
  return {
    id,
    name,
    algorithm,
    status,
    assetCount: numberOr(record.assetCount, 0),
    avgSimilarity: numberOr(record.avgSimilarity, 0),
    representativeAssetId: numberOr(record.representativeAssetId, 0),
    sourceCategoryId: optionalNumber(record.sourceCategoryId),
    labels: stringArray(record.labels),
    origin: textOr(record.origin, 'auto'),
    lineageKey:
      typeof record.lineageKey === 'string' && record.lineageKey ? record.lineageKey : null,
    createdAt: numberOr(record.createdAt, 0),
    updatedAt: numberOr(record.updatedAt, 0),
  }
}

function parseLabels(value: unknown): string[] | null {
  if (typeof value !== 'string' || !value) return null
  try {
    return stringArray(JSON.parse(value))
  } catch {
    return null
  }
}

function clusterGroupFromRow(row: JsonObject): JsonObject {
  return {
    id: numberOr(row.id, 0),
    name: textOr(row.name, ''),
    algorithm: textOr(row.algorithm, ''),
    status: textOr(row.status, ''),
    assetCount: numberOr(row.asset_count, 0),
    avgSimilarity: numberOr(row.avg_similarity, 0),
    representativeAssetId: numberOr(row.representative_asset_id, 0),
    sourceCategoryId: optionalNumber(row.source_category_id),
    labels: parseLabels(row.labels),
    origin: textOr(row.origin, 'auto'),
    lineageKey: typeof row.lineage_key === 'string' && row.lineage_key ? row.lineage_key : null,
    createdAt: numberOr(row.created_at, 0),
    updatedAt: numberOr(row.updated_at, 0),
  }
}

function normalizeClusterMember(record: JsonObject): JsonObject | null {
  const id = finiteNumber(record.id)
  const clusterGroupId = finiteNumber(record.clusterGroupId)
  const assetId = finiteNumber(record.assetId)
  if (id === null || clusterGroupId === null || assetId === null) return null
  return {
    id,
    clusterGroupId,
    assetId,
    similarity: numberOr(record.similarity, 0),
    createdAt: numberOr(record.createdAt, 0),
  }
}

function clusterMemberFromRow(row: JsonObject): JsonObject {
  return {
    id: numberOr(row.id, 0),
    clusterGroupId: numberOr(row.cluster_group_id, 0),
    assetId: numberOr(row.asset_id, 0),
    similarity: numberOr(row.similarity, 0),
    createdAt: numberOr(row.created_at, 0),
  }
}

function relationCountOfBundle(record: JsonObject): number {
  let total = 0
  for (const key of ['categoryAssignments', 'tagAssignments', 'references', 'suggestions']) {
    const value = record[key]
    if (Array.isArray(value)) total += value.length
  }
  return total
}

/** Trash rows keep the full deletion bundle; the normalized form is the bundle itself. */
function normalizeTrashBundle(record: JsonObject): JsonObject | null {
  const id = finiteNumber(record.id)
  const kind = requiredText(record.kind)
  const name = requiredText(record.name)
  const deletedAt = finiteNumber(record.deletedAt)
  if (id === null || kind === null || name === null || deletedAt === null) return null
  return record
}

// ---------------------------------------------------------------------------
// Domain record readers for the SQL read path. They rebuild the exact shapes
// the JSONL stores return (optional keys are omitted, never null), so callers
// can swap data sources without changing their output contracts.
// Formal assignment statuses ('confirmed', 'manual_override') are inlined in
// the SQL below and mirror formalStatus() in assetLibraryService.ts.
// ---------------------------------------------------------------------------

export function domainCategory(row: JsonObject): AssetCategory {
  const record = categoryFromRow(row)
  return {
    id: record.id as number,
    name: record.name as string,
    description: record.description as string,
    parentId: record.parentId as number | null,
    color: record.color as string,
    icon: record.icon as string,
    sortOrder: record.sortOrder as number,
    ...(record.referenceThreshold !== null
      ? { referenceThreshold: record.referenceThreshold as number }
      : {}),
    ...(record.sourceClusterGroupId !== null
      ? { sourceClusterGroupId: record.sourceClusterGroupId as number }
      : {}),
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  }
}

export function domainTag(row: JsonObject): AssetTag {
  const record = tagFromRow(row)
  return {
    id: record.id as number,
    name: record.name as string,
    color: record.color as string,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  }
}

export function domainCategoryAssignment(row: JsonObject): AssetCategoryAssignment {
  const record = makeAssignmentRowReader('categoryId', 'category_id')(row)
  return {
    id: record.id as number,
    assetId: record.assetId as number,
    categoryId: record.categoryId as number,
    ...(record.suggestionId !== null ? { suggestionId: record.suggestionId as number } : {}),
    confidence: record.confidence as number,
    source: record.source as AssetCategoryAssignment['source'],
    status: record.status as AssetCategoryAssignment['status'],
    confirmedByUser: record.confirmedByUser === true,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  }
}

export function domainTagAssignment(row: JsonObject): AssetTagAssignment {
  const record = makeAssignmentRowReader('tagId', 'tag_id')(row)
  return {
    id: record.id as number,
    assetId: record.assetId as number,
    tagId: record.tagId as number,
    ...(record.suggestionId !== null ? { suggestionId: record.suggestionId as number } : {}),
    confidence: record.confidence as number,
    source: record.source as AssetTagAssignment['source'],
    status: record.status as AssetTagAssignment['status'],
    confirmedByUser: record.confirmedByUser === true,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  }
}

export function domainSuggestion(row: JsonObject): AssetClassificationSuggestion {
  const record = suggestionFromRow(row)
  return {
    id: record.id as number,
    assetId: record.assetId as number,
    ...(record.categoryId !== null ? { categoryId: record.categoryId as number } : {}),
    ...(record.tagId !== null ? { tagId: record.tagId as number } : {}),
    confidence: record.confidence as number,
    source: record.source as AssetClassificationSuggestion['source'],
    status: record.status as AssetClassificationSuggestion['status'],
    evidenceAssetIds: record.evidenceAssetIds as number[],
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  }
}

export function domainClusterGroup(row: JsonObject): AssetClusterGroup {
  const record = clusterGroupFromRow(row)
  return {
    id: record.id as number,
    name: record.name as string,
    algorithm: record.algorithm as AssetClusterGroup['algorithm'],
    status: record.status as AssetClusterGroup['status'],
    assetCount: record.assetCount as number,
    avgSimilarity: record.avgSimilarity as number,
    representativeAssetId: record.representativeAssetId as number,
    ...(record.sourceCategoryId !== null
      ? { sourceCategoryId: record.sourceCategoryId as number }
      : {}),
    ...(record.labels !== null ? { labels: record.labels as string[] } : {}),
    // origin 默认 'auto'，为保持与旧 JSONL 记录形状一致（deepEqual 回归），非默认才输出
    ...(record.origin !== null && record.origin !== 'auto'
      ? { origin: record.origin as AssetClusterGroup['origin'] }
      : {}),
    ...(record.lineageKey !== null ? { lineageKey: record.lineageKey as string } : {}),
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  }
}

export interface AssignmentListFilter {
  formalOnly?: boolean
  categoryId?: number
  tagId?: number
  assetIds?: readonly number[]
}

export interface SuggestionListFilter {
  status?: string
  source?: string
}

export interface TrashPageItem {
  id: number
  kind: string
  name: string
  deletedAt: number
  restoredAt?: number
  relationCount: number
  estimatedBytes: number
}

export interface TrashPage {
  items: TrashPageItem[]
  total: number
  totalBytes: number
}

function trashFromRow(row: JsonObject): JsonObject {
  try {
    const parsed: unknown = JSON.parse(textOr(row.payload, ''))
    if (isJsonObject(parsed)) return parsed
  } catch {
    /* fall through to the minimal shape */
  }
  return { id: numberOr(row.id, 0) }
}

export const TABLE_SPECS: TableSpec[] = [
  {
    name: 'categories',
    file: 'categories.jsonl',
    insertSql: `INSERT INTO categories (
      id, name, description, parent_id, color, icon, sort_order,
      reference_threshold, source_cluster_group_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    fromJson: normalizeCategory,
    fromRow: categoryFromRow,
    toValues: (record) => [
      numberOr(record.id, 0),
      textOr(record.name, ''),
      textOr(record.description, ''),
      optionalNumber(record.parentId),
      textOr(record.color, ''),
      textOr(record.icon, ''),
      numberOr(record.sortOrder, 0),
      optionalNumber(record.referenceThreshold),
      optionalNumber(record.sourceClusterGroupId),
      numberOr(record.createdAt, 0),
      numberOr(record.updatedAt, 0),
    ],
  },
  {
    name: 'tags',
    file: 'tags.jsonl',
    insertSql: 'INSERT INTO tags (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    fromJson: normalizeTag,
    fromRow: tagFromRow,
    toValues: (record) => [
      numberOr(record.id, 0),
      textOr(record.name, ''),
      textOr(record.color, ''),
      numberOr(record.createdAt, 0),
      numberOr(record.updatedAt, 0),
    ],
  },
  {
    name: 'category_references',
    file: 'category_references.jsonl',
    insertSql:
      'INSERT INTO category_references (id, category_id, asset_id, weight, created_at) VALUES (?, ?, ?, ?, ?)',
    fromJson: normalizeReference,
    fromRow: referenceFromRow,
    toValues: (record) => [
      numberOr(record.id, 0),
      numberOr(record.categoryId, 0),
      numberOr(record.assetId, 0),
      numberOr(record.weight, 1),
      numberOr(record.createdAt, 0),
    ],
  },
  {
    name: 'asset_categories',
    file: 'asset_categories.jsonl',
    insertSql: `INSERT INTO asset_categories (
      id, asset_id, category_id, suggestion_id, confidence, source, status,
      confirmed_by_user, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    fromJson: makeAssignmentNormalizer('categoryId'),
    fromRow: makeAssignmentRowReader('categoryId', 'category_id'),
    toValues: (record) => assignmentValues(record, 'categoryId'),
  },
  {
    name: 'asset_tags',
    file: 'asset_tags.jsonl',
    insertSql: `INSERT INTO asset_tags (
      id, asset_id, tag_id, suggestion_id, confidence, source, status,
      confirmed_by_user, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    fromJson: makeAssignmentNormalizer('tagId'),
    fromRow: makeAssignmentRowReader('tagId', 'tag_id'),
    toValues: (record) => assignmentValues(record, 'tagId'),
  },
  {
    name: 'suggestions',
    file: 'suggestions.jsonl',
    insertSql: `INSERT INTO suggestions (
      id, asset_id, category_id, tag_id, confidence, source, status,
      evidence_asset_ids, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    fromJson: normalizeSuggestion,
    fromRow: suggestionFromRow,
    toValues: (record) => [
      numberOr(record.id, 0),
      numberOr(record.assetId, 0),
      optionalNumber(record.categoryId),
      optionalNumber(record.tagId),
      numberOr(record.confidence, 0),
      textOr(record.source, ''),
      textOr(record.status, ''),
      JSON.stringify(numberArray(record.evidenceAssetIds)),
      numberOr(record.createdAt, 0),
      numberOr(record.updatedAt, 0),
    ],
  },
  {
    name: 'cluster_groups',
    file: 'cluster_groups.jsonl',
    insertSql: `INSERT INTO cluster_groups (
      id, name, algorithm, status, asset_count, avg_similarity,
      representative_asset_id, source_category_id, labels, origin, lineage_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    fromJson: normalizeClusterGroup,
    fromRow: clusterGroupFromRow,
    toValues: (record) => {
      const labels = stringArray(record.labels)
      return [
        numberOr(record.id, 0),
        textOr(record.name, ''),
        textOr(record.algorithm, ''),
        textOr(record.status, ''),
        numberOr(record.assetCount, 0),
        numberOr(record.avgSimilarity, 0),
        numberOr(record.representativeAssetId, 0),
        optionalNumber(record.sourceCategoryId),
        labels ? JSON.stringify(labels) : null,
        textOr(record.origin, 'auto'),
        typeof record.lineageKey === 'string' && record.lineageKey ? record.lineageKey : null,
        numberOr(record.createdAt, 0),
        numberOr(record.updatedAt, 0),
      ]
    },
  },
  {
    name: 'cluster_members',
    file: 'cluster_group_assets.jsonl',
    insertSql:
      'INSERT INTO cluster_members (id, cluster_group_id, asset_id, similarity, created_at) VALUES (?, ?, ?, ?, ?)',
    fromJson: normalizeClusterMember,
    fromRow: clusterMemberFromRow,
    toValues: (record) => [
      numberOr(record.id, 0),
      numberOr(record.clusterGroupId, 0),
      numberOr(record.assetId, 0),
      numberOr(record.similarity, 0),
      numberOr(record.createdAt, 0),
    ],
  },
  {
    name: 'metadata_deletion_trash',
    file: 'metadata_deletion_trash.jsonl',
    insertSql: `INSERT INTO metadata_deletion_trash (
      id, kind, name, payload, payload_bytes, relation_count, deleted_at, restored_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    fromJson: normalizeTrashBundle,
    fromRow: trashFromRow,
    toValues: (record) => {
      const payload = canonicalJson(record)
      return [
        numberOr(record.id, 0),
        textOr(record.kind, ''),
        textOr(record.name, ''),
        payload,
        Buffer.byteLength(payload, 'utf8') + 1,
        relationCountOfBundle(record),
        numberOr(record.deletedAt, 0),
        optionalNumber(record.restoredAt),
      ]
    },
  },
]
