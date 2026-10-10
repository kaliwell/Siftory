import fs from 'fs'
import path from 'path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  AssetCategory,
  AssetCategoryAssignment,
  AssetClassificationSuggestion,
  AssetClusterGroup,
  AssetTag,
  AssetTagAssignment,
} from '../shared/ipc/asset-library'
import { initializeAssetLibrarySchema } from './assetLibraryDatabaseMigration'
import {
  CorruptJsonlError,
  TABLE_SPECS,
  canonicalJson,
  domainCategory,
  domainCategoryAssignment,
  domainClusterGroup,
  domainSuggestion,
  domainTag,
  domainTagAssignment,
  errorMessage,
  hashNormalizedRecords,
  isJsonObject,
  numberOr,
  optionalNumber,
  parseIdArray,
  textOr,
  type AssignmentListFilter,
  type ExportReport,
  type ImportReport,
  type JsonObject,
  type SuggestionListFilter,
  type TableSpec,
  type TrashPage,
  type VerifyReport,
  type VerifyTableReport,
} from './assetLibraryDatabaseRecords'

export type {
  AssignmentListFilter,
  ExportReport,
  ImportReport,
  SuggestionListFilter,
  TrashPage,
  TrashPageItem,
  VerifyReport,
  VerifyTableReport,
} from './assetLibraryDatabaseRecords'

const READ_CHUNK_SIZE = 64 * 1024

const DATABASE_FILENAME = 'asset-library.sqlite'
const META_MIGRATED_FROM_JSONL = 'migrated_from_jsonl'
const META_MIGRATED_AT = 'migrated_at'
const META_IMPORT_COUNTS = 'import_counts'
const META_IMPORT_HASHES = 'import_hashes'

/** Read a text file line by line without loading it whole; skips nothing. */
function forEachLine(filePath: string, onLine: (line: string) => void): void {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(READ_CHUNK_SIZE)
    const decoder = new TextDecoder('utf-8')
    let pending = ''
    let bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
    while (bytesRead > 0) {
      pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        onLine(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
    }
    pending += decoder.decode()
    if (pending.length > 0) onLine(pending)
  } finally {
    fs.closeSync(fd)
  }
}
export class AssetLibraryDatabase {
  private readonly assetLibraryDir: string
  private readonly filePath: string
  private database: DatabaseSync | null = null
  private inTransaction = false

  constructor(assetLibraryDir: string) {
    this.assetLibraryDir = assetLibraryDir
    this.filePath = path.join(assetLibraryDir, DATABASE_FILENAME)
  }

  open(): void {
    if (this.database) return
    fs.mkdirSync(this.assetLibraryDir, { recursive: true })
    const database = new DatabaseSync(this.filePath)
    try {
      database.exec('PRAGMA busy_timeout = 5000')
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = FULL')
      const versionRow = database.prepare('PRAGMA user_version').get()
      const version = numberOr(versionRow?.user_version, 0)
      initializeAssetLibrarySchema(database, version)
      this.database = database
    } catch (error) {
      database.close()
      throw error
    }
  }

  close(): void {
    if (!this.database) return
    this.database.close()
    this.database = null
    this.inTransaction = false
  }

  isOpen(): boolean {
    return this.database !== null
  }

  /**
   * Runs fn inside BEGIN IMMEDIATE / COMMIT, rolling back and rethrowing on
   * error. Nested calls join the outer transaction instead of failing.
   */
  transaction<T>(fn: () => T): T {
    const database = this.requireOpen()
    if (this.inTransaction) return fn()
    database.exec('BEGIN IMMEDIATE')
    this.inTransaction = true
    try {
      const result = fn()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  importFromJsonl(): ImportReport {
    this.requireOpen()
    const state = this.getMeta(META_MIGRATED_FROM_JSONL)
    if (state === 'complete') {
      return { skipped: true, counts: this.counts(), hashes: this.storedHashes(), badLines: 0 }
    }
    try {
      return this.transaction(() => {
        if (state === 'importing') this.clearTables()
        this.setMeta(META_MIGRATED_FROM_JSONL, 'importing')
        const inserted = new Map<string, JsonObject[]>()
        for (const spec of TABLE_SPECS) {
          const { records, badLines } = this.readJsonlTable(spec)
          if (badLines > 0) {
            throw new CorruptJsonlError(
              `${spec.file}: ${badLines} malformed line(s); import aborted`,
            )
          }
          this.insertRecords(spec, records)
          const stored = this.tableCount(spec.name)
          if (stored !== records.length) {
            throw new Error(
              `${spec.name}: inserted count ${stored} does not match JSONL count ${records.length}`,
            )
          }
          inserted.set(spec.name, records)
        }
        const counts: Record<string, number> = {}
        const hashes: Record<string, string> = {}
        for (const spec of TABLE_SPECS) {
          const sourceHash = hashNormalizedRecords(inserted.get(spec.name) || [])
          const databaseHash = hashNormalizedRecords(this.readTable(spec))
          if (sourceHash !== databaseHash) {
            throw new Error(`${spec.name}: sampled hash mismatch after import`)
          }
          counts[spec.name] = (inserted.get(spec.name) || []).length
          hashes[spec.name] = sourceHash
          this.setMeta(`next_id:${spec.name}`, String(this.nextId(spec.name)))
        }
        this.setMeta(META_IMPORT_COUNTS, JSON.stringify(counts))
        this.setMeta(META_IMPORT_HASHES, JSON.stringify(hashes))
        this.setMeta(META_MIGRATED_AT, String(Date.now()))
        this.setMeta(META_MIGRATED_FROM_JSONL, 'complete')
        return { skipped: false, counts, hashes, badLines: 0 }
      })
    } catch (error) {
      const detail =
        error instanceof CorruptJsonlError
          ? 'corrupt'
          : errorMessage(error).replace(/\s+/g, ' ').slice(0, 120)
      try {
        this.setMeta(META_MIGRATED_FROM_JSONL, `failed:${detail}`)
      } catch {
        /* the failure meta is best-effort; the original error matters */
      }
      throw error
    }
  }

  exportJsonl(targetDir: string): ExportReport {
    this.requireOpen()
    fs.mkdirSync(targetDir, { recursive: true })
    const counts: Record<string, number> = {}
    for (const spec of TABLE_SPECS) {
      const records = this.readTable(spec)
      const lines = records.map((record) => canonicalJson(record))
      fs.writeFileSync(
        path.join(targetDir, spec.file),
        lines.length > 0 ? `${lines.join('\n')}\n` : '',
        'utf-8',
      )
      counts[spec.name] = records.length
    }
    return { targetDir, counts }
  }

  verifyAgainstJsonl(): VerifyReport {
    this.requireOpen()
    const tables: Record<string, VerifyTableReport> = {}
    let ok = true
    for (const spec of TABLE_SPECS) {
      const { records, badLines } = this.readJsonlTable(spec)
      const databaseRecords = this.readTable(spec)
      const expectedCount = records.length
      const actualCount = databaseRecords.length
      const expectedHash = hashNormalizedRecords(records)
      const actualHash = hashNormalizedRecords(databaseRecords)
      const tableOk = badLines === 0 && expectedCount === actualCount && expectedHash === actualHash
      if (!tableOk) ok = false
      tables[spec.name] = {
        ok: tableOk,
        expectedCount,
        actualCount,
        expectedHash,
        actualHash,
        sourceBadLines: badLines,
      }
    }
    return { ok, tables }
  }

  counts(): Record<string, number> {
    this.requireOpen()
    const result: Record<string, number> = {}
    for (const spec of TABLE_SPECS) result[spec.name] = this.tableCount(spec.name)
    return result
  }

  // -------------------------------------------------------------------------
  // Read API for the service SQL read path. All methods are read-only and
  // return the same record shapes the JSONL stores produce.
  // -------------------------------------------------------------------------

  private select(sql: string, ...params: SQLInputValue[]): JsonObject[] {
    return this.requireOpen()
      .prepare(sql)
      .all(...params)
  }

  listCategories(): AssetCategory[] {
    return this.select('SELECT * FROM categories ORDER BY sort_order, name COLLATE NOCASE, id').map(
      domainCategory,
    )
  }

  listTags(): AssetTag[] {
    return this.select('SELECT * FROM tags ORDER BY name COLLATE NOCASE, id').map(domainTag)
  }

  listClusterGroups(): AssetClusterGroup[] {
    return this.select('SELECT * FROM cluster_groups ORDER BY id').map(domainClusterGroup)
  }

  private assignmentRows(
    table: 'asset_categories' | 'asset_tags',
    filter: AssignmentListFilter,
  ): JsonObject[] {
    const conditions: string[] = []
    const params: SQLInputValue[] = []
    if (filter.formalOnly) {
      conditions.push("status IN ('confirmed', 'manual_override')")
    }
    const targetId = table === 'asset_categories' ? filter.categoryId : filter.tagId
    if (targetId !== undefined) {
      conditions.push(`${table === 'asset_categories' ? 'category_id' : 'tag_id'} = ?`)
      params.push(targetId)
    }
    if (filter.assetIds) {
      if (filter.assetIds.length === 0) return []
      conditions.push(`asset_id IN (${filter.assetIds.map(() => '?').join(', ')})`)
      params.push(...filter.assetIds)
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    return this.select(`SELECT * FROM ${table}${where} ORDER BY id`, ...params)
  }

  listCategoryAssignments(filter: AssignmentListFilter = {}): AssetCategoryAssignment[] {
    return this.assignmentRows('asset_categories', filter).map(domainCategoryAssignment)
  }

  listTagAssignments(filter: AssignmentListFilter = {}): AssetTagAssignment[] {
    return this.assignmentRows('asset_tags', filter).map(domainTagAssignment)
  }

  listSuggestions(filter: SuggestionListFilter = {}): AssetClassificationSuggestion[] {
    const conditions: string[] = []
    const params: SQLInputValue[] = []
    if (filter.status) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    if (filter.source) {
      conditions.push('source = ?')
      params.push(filter.source)
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    return this.select(
      `SELECT * FROM suggestions${where} ORDER BY confidence DESC, updated_at DESC, id`,
      ...params,
    ).map(domainSuggestion)
  }

  /** Asset ids having at least one formal category assignment (may repeat). */
  formalAssignedAssetIds(): number[] {
    return this.select(
      `SELECT asset_id FROM asset_categories WHERE status IN ('confirmed', 'manual_override')`,
    ).map((row) => numberOr(row.asset_id, 0))
  }

  /** Exact formal-assignment asset count after excluding inactive asset ids. */
  formalAssignedAssetCount(inactiveAssetIds: readonly number[]): number {
    const total = numberOr(
      this.select(
        `SELECT COUNT(DISTINCT asset_id) AS total FROM asset_categories
         WHERE status IN ('confirmed', 'manual_override')`,
      )[0]?.total,
      0,
    )
    let inactive = 0
    this.chunked(inactiveAssetIds, (chunk) => {
      inactive += numberOr(
        this.select(
          `SELECT COUNT(DISTINCT asset_id) AS total FROM asset_categories
           WHERE status IN ('confirmed', 'manual_override')
             AND asset_id IN (${chunk.map(() => '?').join(', ')})`,
          ...chunk,
        )[0]?.total,
        0,
      )
    })
    return Math.max(0, total - inactive)
  }

  /** Counts used by the stats response without touching unrelated relation tables. */
  categoryAndTagCounts(): { categories: number; tags: number } {
    return {
      categories: this.tableCount('categories'),
      tags: this.tableCount('tags'),
    }
  }

  /**
   * Exact active-suggestion count for one status:
   * |status rows| - |status rows with an inactive asset| (index-assisted).
   */
  suggestionStatusCount(status: string, inactiveAssetIds: readonly number[]): number {
    const total = numberOr(
      this.select('SELECT COUNT(*) AS total FROM suggestions WHERE status = ?', status)[0]?.total,
      0,
    )
    let inactive = 0
    this.chunked(inactiveAssetIds, (chunk) => {
      inactive += numberOr(
        this.select(
          `SELECT COUNT(*) AS total FROM suggestions INDEXED BY idx_suggestions_asset
           WHERE asset_id IN (${chunk.map(() => '?').join(', ')}) AND status = ?`,
          ...chunk,
          status,
        )[0]?.total,
        0,
      )
    })
    return Math.max(0, total - inactive)
  }

  /** Exact reference row count after excluding inactive asset ids. */
  activeReferenceCount(inactiveAssetIds: readonly number[]): number {
    const total = this.tableCount('category_references')
    let inactive = 0
    this.chunked(inactiveAssetIds, (chunk) => {
      inactive += numberOr(
        this.select(
          `SELECT COUNT(*) AS total FROM category_references INDEXED BY idx_category_references_asset
           WHERE asset_id IN (${chunk.map(() => '?').join(', ')})`,
          ...chunk,
        )[0]?.total,
        0,
      )
    })
    return Math.max(0, total - inactive)
  }

  /** Cluster group ids that have at least one member row. */
  allClusterGroupIdsWithMembers(): number[] {
    return this.select('SELECT DISTINCT cluster_group_id FROM cluster_members').map((row) =>
      numberOr(row.cluster_group_id, 0),
    )
  }

  /** Cluster group ids having at least one member whose asset is in the given set. */
  clusterIdsWithMembersOf(assetIds: readonly number[]): number[] {
    if (assetIds.length === 0) return []
    return this.select(
      `SELECT DISTINCT cluster_group_id FROM cluster_members INDEXED BY idx_cluster_members_asset
       WHERE asset_id IN (${assetIds.map(() => '?').join(', ')})`,
      ...assetIds,
    ).map((row) => numberOr(row.cluster_group_id, 0))
  }

  /** Whether the cluster has at least one member whose asset is NOT in the given set. */
  clusterHasActiveMember(clusterGroupId: number, inactiveAssetIds: readonly number[]): boolean {
    if (inactiveAssetIds.length === 0) {
      return !!this.select(
        'SELECT 1 AS found FROM cluster_members WHERE cluster_group_id = ? LIMIT 1',
        clusterGroupId,
      )[0]
    }
    return !!this.select(
      `SELECT 1 AS found FROM cluster_members
       WHERE cluster_group_id = ? AND asset_id NOT IN (${inactiveAssetIds.map(() => '?').join(', ')})
       LIMIT 1`,
      clusterGroupId,
      ...inactiveAssetIds,
    )[0]
  }

  referenceAssetRows(): Array<{ assetId: number }> {
    return this.select('SELECT asset_id FROM category_references').map((row) => ({
      assetId: numberOr(row.asset_id, 0),
    }))
  }

  referenceWeightRows(): Array<{ assetId: number; categoryId: number; weight: number }> {
    return this.select(
      'SELECT asset_id, category_id, weight FROM category_references ORDER BY id',
    ).map((row) => ({
      assetId: numberOr(row.asset_id, 0),
      categoryId: numberOr(row.category_id, 0),
      weight: numberOr(row.weight, 1),
    }))
  }

  categoryAssignmentPairRows(): Array<{ assetId: number; categoryId: number }> {
    return this.select('SELECT asset_id, category_id FROM asset_categories').map((row) => ({
      assetId: numberOr(row.asset_id, 0),
      categoryId: numberOr(row.category_id, 0),
    }))
  }

  tagAssignmentPairRows(): Array<{ assetId: number; tagId: number }> {
    return this.select('SELECT asset_id, tag_id FROM asset_tags').map((row) => ({
      assetId: numberOr(row.asset_id, 0),
      tagId: numberOr(row.tag_id, 0),
    }))
  }

  /** Reviewed (non-pending) suggestion pairs for one source; targetId may be null. */
  reviewedSuggestionPairRows(
    source: string,
    kind: 'category' | 'tag',
  ): Array<{ assetId: number; targetId: number | null }> {
    const column = kind === 'category' ? 'category_id' : 'tag_id'
    return this.select(
      `SELECT asset_id, ${column} AS target_id FROM suggestions
       WHERE source = ? AND status NOT IN ('suggested', 'low_confidence')`,
      source,
    ).map((row) => ({
      assetId: numberOr(row.asset_id, 0),
      targetId: optionalNumber(row.target_id),
    }))
  }

  clusterMemberAggregates(inactiveAssetIds: readonly number[] = []): Array<{
    clusterGroupId: number
    count: number
    similarityTotal: number
  }> {
    const aggregates = this.select(
      `SELECT cluster_group_id, COUNT(*) AS member_count, SUM(similarity) AS similarity_total
       FROM cluster_members GROUP BY cluster_group_id`,
    ).map((row) => ({
      clusterGroupId: numberOr(row.cluster_group_id, 0),
      count: numberOr(row.member_count, 0),
      similarityTotal: numberOr(row.similarity_total, 0),
    }))
    if (inactiveAssetIds.length === 0) return aggregates
    const byGroup = new Map(aggregates.map((aggregate) => [aggregate.clusterGroupId, aggregate]))
    this.chunked(inactiveAssetIds, (chunk) => {
      const inactiveRows = this.select(
        `SELECT cluster_group_id, COUNT(*) AS member_count, SUM(similarity) AS similarity_total
         FROM cluster_members INDEXED BY idx_cluster_members_asset
         WHERE asset_id IN (${chunk.map(() => '?').join(', ')}) GROUP BY cluster_group_id`,
        ...chunk,
      )
      for (const row of inactiveRows) {
        const aggregate = byGroup.get(numberOr(row.cluster_group_id, 0))
        if (!aggregate) continue
        aggregate.count -= numberOr(row.member_count, 0)
        aggregate.similarityTotal -= numberOr(row.similarity_total, 0)
      }
    })
    return aggregates.filter((aggregate) => aggregate.count > 0)
  }

  /** Streams one group's best members; callers may stop after enough active assets. */
  *iterateClusterMembersBySimilarity(
    clusterGroupId: number,
  ): Generator<{ assetId: number; similarity: number }> {
    const statement = this.requireOpen().prepare(
      `SELECT asset_id, similarity FROM cluster_members
       WHERE cluster_group_id = ? ORDER BY similarity DESC, asset_id`,
    )
    for (const row of statement.iterate(clusterGroupId)) {
      yield {
        assetId: numberOr(row.asset_id, 0),
        similarity: numberOr(row.similarity, 0),
      }
    }
  }

  clusterTopMembers(
    clusterGroupId: number,
    limit: number,
  ): Array<{ assetId: number; similarity: number }> {
    return this.select(
      `SELECT asset_id, similarity FROM cluster_members
       WHERE cluster_group_id = ? ORDER BY similarity DESC, id LIMIT ?`,
      clusterGroupId,
      limit,
    ).map((row) => ({
      assetId: numberOr(row.asset_id, 0),
      similarity: numberOr(row.similarity, 0),
    }))
  }

  listClusterMembersOrdered(): Array<{
    clusterGroupId: number
    assetId: number
    similarity: number
  }> {
    // No ORDER BY on purpose: the rowid (= id) table scan is ~6x faster than
    // any ordered variant and already yields id order, which is what the
    // legacy getAll() iteration order provides.
    return this.select('SELECT cluster_group_id, asset_id, similarity FROM cluster_members').map(
      (row) => ({
        clusterGroupId: numberOr(row.cluster_group_id, 0),
        assetId: numberOr(row.asset_id, 0),
        similarity: numberOr(row.similarity, 0),
      }),
    )
  }

  /** Distinct category/tag ids referenced by suggestions (for dead-target checks). */
  suggestionTargetIds(): { categoryIds: number[]; tagIds: number[] } {
    const categoryIds = this.select(
      'SELECT DISTINCT category_id FROM suggestions WHERE category_id IS NOT NULL',
    ).map((row) => numberOr(row.category_id, 0))
    const tagIds = this.select(
      'SELECT DISTINCT tag_id FROM suggestions WHERE tag_id IS NOT NULL',
    ).map((row) => numberOr(row.tag_id, 0))
    return { categoryIds, tagIds }
  }

  private suggestionTargetConditions(
    deadCategoryIds: readonly number[],
    deadTagIds: readonly number[],
    conditions: string[],
    params: SQLInputValue[],
  ): void {
    if (deadCategoryIds.length > 0) {
      conditions.push(
        `(category_id IS NULL OR category_id NOT IN (${deadCategoryIds.map(() => '?').join(', ')}))`,
      )
      params.push(...deadCategoryIds)
    }
    if (deadTagIds.length > 0) {
      conditions.push(`(tag_id IS NULL OR tag_id NOT IN (${deadTagIds.map(() => '?').join(', ')}))`)
      params.push(...deadTagIds)
    }
  }

  private *iterateSuggestionsForSource(
    options: {
      status?: string
      deadCategoryIds?: readonly number[]
      deadTagIds?: readonly number[]
    },
    source: string | undefined,
  ): Generator<AssetClassificationSuggestion> {
    const conditions: string[] = []
    const params: SQLInputValue[] = []
    if (options.status) {
      conditions.push('status = ?')
      params.push(options.status)
    }
    if (source) {
      conditions.push('source = ?')
      params.push(source)
    }
    this.suggestionTargetConditions(
      options.deadCategoryIds || [],
      options.deadTagIds || [],
      conditions,
      params,
    )
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const statement = this.requireOpen().prepare(
      `SELECT * FROM suggestions${where} ORDER BY confidence DESC, updated_at DESC, id`,
    )
    for (const row of statement.iterate(...params)) {
      yield domainSuggestion(row)
    }
  }

  /**
   * Streams suggestions in review order (confidence DESC, updated_at DESC,
   * id). Dead target ids (referenced categories/tags that no longer exist)
   * are excluded in SQL; the caller applies the asset-active filter while
   * consuming and may stop the iteration early.
   *
   * With a status filter the index (status, source, confidence DESC, ...)
   * only orders within one source, so results are merged per source — this
   * avoids a temp b-tree sort over the whole filtered set.
   */
  *iterateSuggestions(options: {
    status?: string
    source?: string
    deadCategoryIds?: readonly number[]
    deadTagIds?: readonly number[]
  }): Generator<AssetClassificationSuggestion> {
    if (options.source || !options.status) {
      yield* this.iterateSuggestionsForSource(options, options.source)
      return
    }
    const sources = this.select(
      'SELECT DISTINCT source FROM suggestions WHERE status = ?',
      options.status,
    ).map((row) => textOr(row.source, ''))
    if (sources.length <= 1) {
      yield* this.iterateSuggestionsForSource(options, sources[0])
      return
    }
    const iterators = sources.map((source) => this.iterateSuggestionsForSource(options, source))
    const heads = iterators.map((iterator) => iterator.next())
    for (;;) {
      let best = -1
      for (let index = 0; index < heads.length; index++) {
        const head = heads[index]
        if (head.done) continue
        if (best < 0) {
          best = index
          continue
        }
        const current = head.value
        const winner = heads[best].value
        if (
          current.confidence > winner.confidence ||
          (current.confidence === winner.confidence &&
            (current.updatedAt > winner.updatedAt ||
              (current.updatedAt === winner.updatedAt && current.id < winner.id)))
        ) {
          best = index
        }
      }
      if (best < 0) return
      const value = heads[best].value
      heads[best] = iterators[best].next()
      yield value
    }
  }

  /**
   * Exact suggestion count with the legacy semantics (status/source filter,
   * live target, active asset) without scanning full rows:
   *   total = |A| - |A ∩ inactive assets| - |A ∩ dead targets ∩ active assets|
   * where A is the status/source-filtered set.
   */
  suggestionCountExact(options: {
    status?: string
    source?: string
    inactiveAssetIds: readonly number[]
    deadCategoryIds: readonly number[]
    deadTagIds: readonly number[]
  }): number {
    const baseConditions: string[] = []
    const baseParams: SQLInputValue[] = []
    if (options.status) {
      baseConditions.push('status = ?')
      baseParams.push(options.status)
    }
    if (options.source) {
      baseConditions.push('source = ?')
      baseParams.push(options.source)
    }
    const baseWhere = baseConditions.length > 0 ? ` WHERE ${baseConditions.join(' AND ')}` : ''
    const andBase = baseConditions.length > 0 ? ` AND ${baseConditions.join(' AND ')}` : ''
    const countAll = numberOr(
      this.select(`SELECT COUNT(*) AS total FROM suggestions${baseWhere}`, ...baseParams)[0]?.total,
      0,
    )
    let inactiveCount = 0
    if (options.inactiveAssetIds.length > 0) {
      // INDEXED BY: the asset-id IN list is always the selective part here;
      // without the hint the planner prefers the status index and scans it.
      inactiveCount = numberOr(
        this.select(
          `SELECT COUNT(*) AS total FROM suggestions INDEXED BY idx_suggestions_asset WHERE asset_id IN (${options.inactiveAssetIds
            .map(() => '?')
            .join(', ')})${andBase}`,
          ...options.inactiveAssetIds,
          ...baseParams,
        )[0]?.total,
        0,
      )
    }
    let deadCount = 0
    if (options.deadCategoryIds.length > 0 || options.deadTagIds.length > 0) {
      const deadConditions: string[] = []
      const deadParams: SQLInputValue[] = []
      if (options.deadCategoryIds.length > 0) {
        deadConditions.push(`category_id IN (${options.deadCategoryIds.map(() => '?').join(', ')})`)
        deadParams.push(...options.deadCategoryIds)
      }
      if (options.deadTagIds.length > 0) {
        deadConditions.push(`tag_id IN (${options.deadTagIds.map(() => '?').join(', ')})`)
        deadParams.push(...options.deadTagIds)
      }
      const activeConditions =
        options.inactiveAssetIds.length > 0
          ? ` AND asset_id NOT IN (${options.inactiveAssetIds.map(() => '?').join(', ')})`
          : ''
      deadCount = numberOr(
        this.select(
          `SELECT COUNT(*) AS total FROM suggestions WHERE (${deadConditions.join(' OR ')})${activeConditions}${andBase}`,
          ...deadParams,
          ...options.inactiveAssetIds,
          ...baseParams,
        )[0]?.total,
        0,
      )
    }
    return Math.max(0, countAll - inactiveCount - deadCount)
  }

  // -------------------------------------------------------------------------
  // Write API for sqlite-authoritative mode. All methods must be called
  // inside transaction() (directly or via the caller's transaction), so a
  // multi-step write either commits fully or rolls back.
  // -------------------------------------------------------------------------

  private specFor(table: string): TableSpec {
    const spec = TABLE_SPECS.find((candidate) => candidate.name === table)
    if (!spec) throw new Error(`Unknown relation table: ${table}`)
    return spec
  }

  private execute(sql: string, ...params: SQLInputValue[]): void {
    this.requireOpen()
      .prepare(sql)
      .run(...params)
  }

  /** Allocates the next id for a relation table from the library_meta sequence. */
  allocateId(table: string): number {
    this.specFor(table)
    const key = `next_id:${table}`
    const current = Number(this.getMeta(key) ?? '1')
    const id = Number.isSafeInteger(current) && current > 0 ? current : 1
    this.setMeta(key, String(id + 1))
    return id
  }

  /**
   * Advances every table's id sequence past its current MAX(id). Records that
   * entered the database outside allocateId (dual-era shadow reloads, or a v2
   * backup snapshot taken while sequences lagged) can leave a sequence behind,
   * and allocating from it fails with a UNIQUE constraint. Idempotent and
   * cheap (MAX over the primary key index); safe to run on every open.
   */
  reconcileIdSequences(): void {
    this.requireOpen()
    for (const spec of TABLE_SPECS) {
      const key = `next_id:${spec.name}`
      const current = Number(this.getMeta(key) ?? '1')
      const floor = this.nextId(spec.name)
      if (!Number.isSafeInteger(current) || current < floor) {
        this.setMeta(key, String(floor))
      }
    }
  }

  /** Inserts domain records (service shapes) through the shared normalization. */
  insertDomainRecords(table: string, records: readonly unknown[]): void {
    const spec = this.specFor(table)
    const normalized: JsonObject[] = []
    for (const raw of records) {
      if (!isJsonObject(raw)) throw new Error(`${table}: cannot insert a non-object record`)
      const record = spec.fromJson(raw)
      if (!record) throw new Error(`${table}: record failed normalization (id=${String(raw.id)})`)
      normalized.push(record)
    }
    this.insertRecords(spec, normalized)
  }

  private upsertAssignments(
    table: 'asset_categories' | 'asset_tags',
    records: readonly unknown[],
  ): void {
    const spec = this.specFor(table)
    const targetColumn = table === 'asset_categories' ? 'category_id' : 'tag_id'
    const upsert = this.requireOpen().prepare(
      `INSERT INTO ${table} (
        id, asset_id, ${targetColumn}, suggestion_id, confidence, source, status,
        confirmed_by_user, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id, ${targetColumn}) DO UPDATE SET
        suggestion_id = excluded.suggestion_id,
        confidence = excluded.confidence,
        source = excluded.source,
        status = excluded.status,
        confirmed_by_user = excluded.confirmed_by_user,
        updated_at = excluded.updated_at`,
    )
    for (const raw of records) {
      if (!isJsonObject(raw)) throw new Error(`${table}: cannot upsert a non-object record`)
      const record = spec.fromJson(raw)
      if (!record) throw new Error(`${table}: record failed normalization (id=${String(raw.id)})`)
      upsert.run(...spec.toValues(record))
    }
  }

  upsertCategoryAssignments(records: readonly unknown[]): void {
    this.upsertAssignments('asset_categories', records)
  }

  upsertTagAssignments(records: readonly unknown[]): void {
    this.upsertAssignments('asset_tags', records)
  }

  private chunked(ids: readonly number[], run: (chunk: readonly number[]) => void): void {
    for (let offset = 0; offset < ids.length; offset += 500) {
      run(ids.slice(offset, offset + 500))
    }
  }

  private placeholders(count: number): string {
    return new Array(count).fill('?').join(', ')
  }

  deleteAssignmentsByIds(table: 'asset_categories' | 'asset_tags', ids: readonly number[]): void {
    this.specFor(table)
    this.chunked(ids, (chunk) =>
      this.execute(
        `DELETE FROM ${table} WHERE id IN (${this.placeholders(chunk.length)})`,
        ...chunk,
      ),
    )
  }

  deleteAssignmentsForAssets(
    table: 'asset_categories' | 'asset_tags',
    targetId: number,
    assetIds: readonly number[],
  ): void {
    const targetColumn = table === 'asset_categories' ? 'category_id' : 'tag_id'
    this.chunked(assetIds, (chunk) =>
      this.execute(
        `DELETE FROM ${table} WHERE ${targetColumn} = ? AND asset_id IN (${this.placeholders(chunk.length)})`,
        targetId,
        ...chunk,
      ),
    )
  }

  deleteCategoryRelations(categoryId: number): void {
    this.execute('DELETE FROM asset_categories WHERE category_id = ?', categoryId)
    this.execute('DELETE FROM category_references WHERE category_id = ?', categoryId)
    this.execute('DELETE FROM suggestions WHERE category_id = ?', categoryId)
  }

  deleteTagRelations(tagId: number): void {
    this.execute('DELETE FROM asset_tags WHERE tag_id = ?', tagId)
    this.execute('DELETE FROM suggestions WHERE tag_id = ?', tagId)
  }

  deleteSuggestionsForCategoryAssets(categoryId: number, assetIds: readonly number[]): void {
    this.chunked(assetIds, (chunk) =>
      this.execute(
        `DELETE FROM suggestions WHERE category_id = ? AND asset_id IN (${this.placeholders(chunk.length)})`,
        categoryId,
        ...chunk,
      ),
    )
  }

  deleteSuggestionsByIds(ids: readonly number[]): void {
    this.chunked(ids, (chunk) =>
      this.execute(
        `DELETE FROM suggestions WHERE id IN (${this.placeholders(chunk.length)})`,
        ...chunk,
      ),
    )
  }

  /** Replaces pending generated suggestions for one source and target set. */
  deleteGeneratedSuggestions(
    source: string,
    target: 'category' | 'tag',
    targetIds: readonly number[],
  ): void {
    const targetColumn = target === 'category' ? 'category_id' : 'tag_id'
    this.chunked(targetIds, (chunk) =>
      this.execute(
        `DELETE FROM suggestions
         WHERE source = ? AND ${targetColumn} IN (${this.placeholders(chunk.length)})
           AND status IN ('suggested', 'low_confidence')`,
        source,
        ...chunk,
      ),
    )
  }

  updateSuggestionStatus(ids: readonly number[], status: string, updatedAt: number): void {
    this.chunked(ids, (chunk) =>
      this.execute(
        `UPDATE suggestions SET status = ?, updated_at = ? WHERE id IN (${this.placeholders(chunk.length)})`,
        status,
        updatedAt,
        ...chunk,
      ),
    )
  }

  rejectSuggestionAsManualReview(id: number, updatedAt: number): void {
    this.execute(
      "UPDATE suggestions SET confidence = 1, source = 'manual_review', status = 'rejected', updated_at = ? WHERE id = ?",
      updatedAt,
      id,
    )
  }

  insertCategory(record: unknown): void {
    this.insertDomainRecords('categories', [record])
  }

  updateCategory(id: number, patch: Record<string, unknown>): void {
    this.updateRowById('categories', id, patch)
  }

  deleteCategory(id: number): void {
    this.execute('DELETE FROM categories WHERE id = ?', id)
  }

  insertTag(record: unknown): void {
    this.insertDomainRecords('tags', [record])
  }

  updateTag(id: number, patch: Record<string, unknown>): void {
    this.updateRowById('tags', id, patch)
  }

  deleteTag(id: number): void {
    this.execute('DELETE FROM tags WHERE id = ?', id)
  }

  private updateRowById(table: string, id: number, patch: Record<string, unknown>): void {
    const columns: Record<string, string> = {
      name: 'name',
      description: 'description',
      parentId: 'parent_id',
      color: 'color',
      icon: 'icon',
      sortOrder: 'sort_order',
      referenceThreshold: 'reference_threshold',
      sourceClusterGroupId: 'source_cluster_group_id',
      updatedAt: 'updated_at',
      status: 'status',
      labels: 'labels',
      origin: 'origin',
      lineageKey: 'lineage_key',
    }
    const sets: string[] = []
    const params: SQLInputValue[] = []
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue
      sets.push(`${column} = ?`)
      const value = patch[key]
      params.push(
        value === undefined || value === null
          ? null
          : typeof value === 'number'
            ? value
            : typeof value === 'string'
              ? value
              : JSON.stringify(value),
      )
    }
    if (sets.length === 0) return
    this.execute(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
  }

  insertReferenceIgnore(record: unknown): void {
    const spec = this.specFor('category_references')
    if (!isJsonObject(record)) {
      throw new Error('category_references: cannot insert a non-object record')
    }
    const normalized = spec.fromJson(record)
    if (!normalized) throw new Error('category_references: record failed normalization')
    const values = spec.toValues(normalized)
    this.requireOpen()
      .prepare(
        `INSERT OR IGNORE INTO category_references (id, category_id, asset_id, weight, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(...values)
  }

  updateReferenceWeight(categoryId: number, assetId: number, weight: number): void {
    this.execute(
      'UPDATE category_references SET weight = ? WHERE category_id = ? AND asset_id = ?',
      weight,
      categoryId,
      assetId,
    )
  }

  deleteReference(id: number): void {
    this.execute('DELETE FROM category_references WHERE id = ?', id)
  }

  /** Full reference rows (used to prime the in-memory mirror). */
  listReferences(): Array<{
    id: number
    categoryId: number
    assetId: number
    weight: number
    createdAt: number
  }> {
    return this.select(
      'SELECT id, category_id, asset_id, weight, created_at FROM category_references ORDER BY id',
    ).map((row) => ({
      id: numberOr(row.id, 0),
      categoryId: numberOr(row.category_id, 0),
      assetId: numberOr(row.asset_id, 0),
      weight: numberOr(row.weight, 1),
      createdAt: numberOr(row.created_at, 0),
    }))
  }

  /** Full cluster member rows including ids (used to prime the mirror). */
  listClusterMembers(): Array<{
    id: number
    clusterGroupId: number
    assetId: number
    similarity: number
    createdAt: number
  }> {
    return this.select(
      'SELECT id, cluster_group_id, asset_id, similarity, created_at FROM cluster_members ORDER BY id',
    ).map((row) => ({
      id: numberOr(row.id, 0),
      clusterGroupId: numberOr(row.cluster_group_id, 0),
      assetId: numberOr(row.asset_id, 0),
      similarity: numberOr(row.similarity, 0),
      createdAt: numberOr(row.created_at, 0),
    }))
  }

  /** Parsed deletion bundles (used to prime the mirror). */
  listTrashBundles(): JsonObject[] {
    return this.select('SELECT payload FROM metadata_deletion_trash ORDER BY id').map((row) => {
      const parsed: unknown = JSON.parse(textOr(row.payload, '{}'))
      return isJsonObject(parsed) ? parsed : {}
    })
  }

  /** Permanently deletes trash rows; returns the number of rows removed. */
  deleteTrashRows(restoredOnly: boolean): number {
    const result = this.requireOpen()
      .prepare(
        restoredOnly
          ? 'DELETE FROM metadata_deletion_trash WHERE restored_at IS NOT NULL'
          : 'DELETE FROM metadata_deletion_trash',
      )
      .run()
    return Number(result.changes)
  }

  insertTrashBundle(bundle: unknown): void {
    this.insertDomainRecords('metadata_deletion_trash', [bundle])
  }

  markTrashRestored(id: number, restoredAt: number): void {
    this.execute('UPDATE metadata_deletion_trash SET restored_at = ? WHERE id = ?', restoredAt, id)
  }

  /**
   * Trash retention: keep the newest maxRecords bundles within maxBytes,
   * pending (unrestored) records first, always keeping at least the newest
   * one. Mirrors selectRetainedAssetMetadataDeletions with payload_bytes.
   */
  pruneTrash(maxRecords: number, maxBytes: number): number {
    const rows = this.select(
      'SELECT id, deleted_at, restored_at, payload_bytes FROM metadata_deletion_trash',
    )
    const recordLimit = Math.max(1, Math.floor(maxRecords))
    const byteLimit = Math.max(1, Math.floor(maxBytes))
    const prioritized = [...rows].sort(
      (left, right) =>
        Number(optionalNumber(left.restored_at) !== null) -
          Number(optionalNumber(right.restored_at) !== null) ||
        numberOr(right.deleted_at, 0) - numberOr(left.deleted_at, 0) ||
        numberOr(right.id, 0) - numberOr(left.id, 0),
    )
    const retained = new Set<number>()
    let retainedBytes = 0
    for (const row of prioritized) {
      if (retained.size >= recordLimit) break
      const bytes = numberOr(row.payload_bytes, 0)
      if (retained.size > 0 && retainedBytes + bytes > byteLimit) continue
      retained.add(numberOr(row.id, 0))
      retainedBytes += bytes
    }
    const pruned = prioritized.map((row) => numberOr(row.id, 0)).filter((id) => !retained.has(id))
    this.chunked(pruned, (chunk) =>
      this.execute(
        `DELETE FROM metadata_deletion_trash WHERE id IN (${this.placeholders(chunk.length)})`,
        ...chunk,
      ),
    )
    return pruned.length
  }

  deleteClusterGroupsByIds(ids: readonly number[]): void {
    this.chunked(ids, (chunk) => {
      this.execute(
        `DELETE FROM cluster_members WHERE cluster_group_id IN (${this.placeholders(chunk.length)})`,
        ...chunk,
      )
      this.execute(
        `DELETE FROM cluster_groups WHERE id IN (${this.placeholders(chunk.length)})`,
        ...chunk,
      )
    })
  }

  deleteClusterGroupsByAlgorithm(algorithm: string): void {
    this.execute(
      'DELETE FROM cluster_members WHERE cluster_group_id IN (SELECT id FROM cluster_groups WHERE algorithm = ?)',
      algorithm,
    )
    this.execute('DELETE FROM cluster_groups WHERE algorithm = ?', algorithm)
  }

  insertClusterGroups(records: readonly unknown[]): void {
    this.insertDomainRecords('cluster_groups', records)
  }

  insertClusterMembers(records: readonly unknown[]): void {
    this.insertDomainRecords('cluster_members', records)
  }

  deleteClusterMember(clusterGroupId: number, assetId: number): void {
    this.execute(
      'DELETE FROM cluster_members WHERE cluster_group_id = ? AND asset_id = ?',
      clusterGroupId,
      assetId,
    )
  }

  updateClusterGroup(id: number, patch: Record<string, unknown>): void {
    this.updateRowById('cluster_groups', id, patch)
  }

  insertClusterLineage(record: {
    event: string
    groupIds: readonly number[]
    fromGroupIds: readonly number[]
    toGroupId?: number
    memberAssetIds?: readonly number[]
    createdAt: number
  }): number {
    // lineage 写入量少且都在 withSqliteWrite 事务内串行，直接 MAX+1
    const row = this.select('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM cluster_lineage')[0]
    const id = numberOr(row?.next, 1)
    this.execute(
      `INSERT INTO cluster_lineage (id, event, group_ids, from_group_ids, to_group_id, member_asset_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      record.event,
      JSON.stringify(record.groupIds),
      JSON.stringify(record.fromGroupIds),
      record.toGroupId ?? null,
      JSON.stringify(record.memberAssetIds ?? []),
      record.createdAt,
    )
    return id
  }

  listClusterLineage(limit = 500): Array<{
    id: number
    event: string
    groupIds: number[]
    fromGroupIds: number[]
    toGroupId?: number
    memberAssetIds: number[]
    createdAt: number
  }> {
    return this.select(
      'SELECT * FROM cluster_lineage ORDER BY created_at DESC, id DESC LIMIT ?',
      Math.max(1, Math.min(5000, Math.floor(limit))),
    ).map((row) => ({
      id: numberOr(row.id, 0),
      event: textOr(row.event, ''),
      groupIds: parseIdArray(row.group_ids),
      fromGroupIds: parseIdArray(row.from_group_ids),
      ...(optionalNumber(row.to_group_id) !== null
        ? { toGroupId: optionalNumber(row.to_group_id) as number }
        : {}),
      memberAssetIds: parseIdArray(row.member_asset_ids),
      createdAt: numberOr(row.created_at, 0),
    }))
  }

  trashPage(options: {
    status: 'all' | 'pending' | 'restored'
    offset: number
    limit: number
  }): TrashPage {
    const where =
      options.status === 'pending'
        ? ' WHERE restored_at IS NULL'
        : options.status === 'restored'
          ? ' WHERE restored_at IS NOT NULL'
          : ''
    const items = this.select(
      `SELECT id, kind, name, deleted_at, restored_at, relation_count, payload_bytes
       FROM metadata_deletion_trash${where}
       ORDER BY deleted_at DESC, id DESC LIMIT ? OFFSET ?`,
      options.limit,
      options.offset,
    ).map((row) => {
      const restoredAt = optionalNumber(row.restored_at)
      return {
        id: numberOr(row.id, 0),
        kind: textOr(row.kind, ''),
        name: textOr(row.name, ''),
        deletedAt: numberOr(row.deleted_at, 0),
        ...(restoredAt !== null ? { restoredAt } : {}),
        relationCount: numberOr(row.relation_count, 0),
        estimatedBytes: numberOr(row.payload_bytes, 0),
      }
    })
    const totalRow = this.select(`SELECT COUNT(*) AS total FROM metadata_deletion_trash${where}`)[0]
    const bytesRow = this.select(
      'SELECT SUM(payload_bytes) AS total_bytes FROM metadata_deletion_trash',
    )[0]
    return {
      items,
      total: numberOr(totalRow?.total, 0),
      totalBytes: numberOr(bytesRow?.total_bytes, 0),
    }
  }

  private requireOpen(): DatabaseSync {
    if (!this.database) throw new Error('Asset library database is not open')
    return this.database
  }

  private getMeta(key: string): string | null {
    const database = this.requireOpen()
    const row = database.prepare('SELECT value FROM library_meta WHERE key = ?').get(key)
    return row ? textOr(row.value, '') : null
  }

  private setMeta(key: string, value: string): void {
    const database = this.requireOpen()
    database
      .prepare('INSERT OR REPLACE INTO library_meta (key, value) VALUES (?, ?)')
      .run(key, value)
  }

  private storedHashes(): Record<string, string> {
    const raw = this.getMeta(META_IMPORT_HASHES)
    if (!raw) return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isJsonObject(parsed)) return {}
      const result: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') result[key] = value
      }
      return result
    } catch {
      return {}
    }
  }

  private clearTables(): void {
    const database = this.requireOpen()
    for (const spec of TABLE_SPECS) database.exec(`DELETE FROM ${spec.name}`)
  }

  private tableCount(table: string): number {
    const database = this.requireOpen()
    const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()
    return numberOr(row?.total, 0)
  }

  private nextId(table: string): number {
    const database = this.requireOpen()
    const row = database.prepare(`SELECT MAX(id) AS max_id FROM ${table}`).get()
    return numberOr(row?.max_id, 0) + 1
  }

  private readTable(spec: TableSpec): JsonObject[] {
    const database = this.requireOpen()
    const rows = database.prepare(`SELECT * FROM ${spec.name} ORDER BY id`).all()
    return rows.map((row) => spec.fromRow(row))
  }

  private insertRecords(spec: TableSpec, records: readonly JsonObject[]): void {
    if (records.length === 0) return
    const database = this.requireOpen()
    const insert = database.prepare(spec.insertSql)
    for (const record of records) insert.run(...spec.toValues(record))
  }

  /** Streams one JSONL file; missing files are treated as zero rows. */
  private readJsonlTable(spec: TableSpec): { records: JsonObject[]; badLines: number } {
    const filePath = path.join(this.assetLibraryDir, spec.file)
    const records: JsonObject[] = []
    let badLines = 0
    if (!fs.existsSync(filePath)) return { records, badLines }
    forEachLine(filePath, (rawLine) => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (!line.trim()) return
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        badLines += 1
        return
      }
      if (!isJsonObject(parsed)) {
        badLines += 1
        return
      }
      const normalized = spec.fromJson(parsed)
      if (!normalized) badLines += 1
      else records.push(normalized)
    })
    return { records, badLines }
  }
}
