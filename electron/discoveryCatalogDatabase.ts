// ── Discovery Catalog SQLite authority ───────────────────
// Phase 1 unified discovery catalog (design 7.3/7.4). This database is the
// authority for DataSource rows, FileEntry rows, ScanSession rows and D1
// IndexState rows. Per the Phase 0 storage-authority freeze it must not
// write back into the native manifest, assets.jsonl, asset-library.sqlite
// or asset-catalog.sqlite; it is a self-contained authority for the unified
// discovery view and can be rebuilt by rescanning online sources.

import fs from 'fs'
import path from 'path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  DataSource,
  DiscoveredEntry,
  DiscoveryCatalogQueryRequest,
  DiscoveryCatalogQuerySort,
  DiscoveryCatalogResultItem,
  DiscoveryCatalogStats,
  DiscoverySourceListItem,
  IndexStage,
  ScanBackend,
  ScanSession,
  ScanSessionState,
  SourceAvailability,
  SourceScanCapability,
  SourceType,
} from '../shared/ipc/discovery-catalog'

const CATALOG_SCHEMA_VERSION = 1
const BATCH_SIZE = 512

export const DISCOVERY_CATALOG_FILENAME = 'discovery-catalog.sqlite'

export interface CatalogFileActionRecord {
  fileEntryId: string
  displayName: string
  displayPath: string
  sizeBytes: number
  modifiedAt: number
  source: DataSource
}

export interface DiscoveryCatalogConsistencyReport {
  ok: boolean
  schemaVersion: number
  sourceCount: number
  fileCount: number
  indexStateCount: number
  missingFileCount: number
  staleIndexCount: number
  failedIndexCount: number
  orphanFileCount: number
  orphanIndexCount: number
  missingDiscoveryStateCount: number
  invalidIndexStateCount: number
  quickCheckOk: boolean
  foreignKeyViolationCount: number
}

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  root_locator TEXT NOT NULL,
  read_only INTEGER NOT NULL DEFAULT 1,
  availability TEXT NOT NULL DEFAULT 'unknown',
  scan_capability TEXT NOT NULL DEFAULT 'directory',
  last_attempt_at INTEGER,
  last_successful_scan_at INTEGER,
  last_complete_reconcile_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS file_entries (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path_key TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  extension TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  filesystem_identity TEXT,
  availability TEXT NOT NULL DEFAULT 'online',
  first_seen_session_id TEXT,
  last_seen_session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_id, path_key)
);
CREATE INDEX IF NOT EXISTS idx_file_entries_source_name ON file_entries(source_id, name_key);
CREATE INDEX IF NOT EXISTS idx_file_entries_name ON file_entries(name_key);
CREATE INDEX IF NOT EXISTS idx_file_entries_identity ON file_entries(filesystem_identity);
CREATE TABLE IF NOT EXISTS scan_sessions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  backend TEXT NOT NULL DEFAULT 'unknown',
  fallback_reason TEXT,
  fallback_code TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  committed_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_scan_sessions_source ON scan_sessions(source_id, started_at DESC);
CREATE TABLE IF NOT EXISTS index_states (
  file_entry_id INTEGER NOT NULL REFERENCES file_entries(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (file_entry_id, stage)
);
`

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function catalogResultFromRow(row: Record<string, unknown>): DiscoveryCatalogResultItem {
  const indexStateList = textValue(row.index_state_list)
  return {
    fileEntryId: String(numberValue(row.id)),
    displayName: textValue(row.name),
    displayPath: textValue(row.path_key),
    sizeBytes: numberValue(row.size_bytes),
    modifiedAt: numberValue(row.modified_at),
    source: {
      id: textValue(row.source_id),
      name: textValue(row.source_name),
      type: textValue(row.source_type) as SourceType,
      availability: textValue(row.source_availability) as SourceAvailability,
    },
    indexState: indexStateList ? indexStateList.split(',') : [],
  }
}

// Stable Phase 1 file identity (design 6.3/7.2): sourceId + normalized path.
// The native backend does not expose FRN/volume identity yet, so the path
// strategy is the Phase 1 fallback; `filesystem_identity` is reserved.
export function discoveryPathKey(absolutePath: string): string {
  if (absolutePath.startsWith('sftp://')) return absolutePath
  const normalized = path.resolve(absolutePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function sourceFromRow(row: Record<string, unknown>): DataSource {
  return {
    id: textValue(row.id),
    type: textValue(row.type) as SourceType,
    displayName: textValue(row.display_name),
    rootLocator: textValue(row.root_locator),
    readOnly: numberValue(row.read_only) === 1,
    availability: textValue(row.availability) as SourceAvailability,
    scanCapability: textValue(row.scan_capability) as SourceScanCapability,
    ...(optionalNumber(row.last_attempt_at)
      ? { lastAttemptAt: numberValue(row.last_attempt_at) }
      : {}),
    ...(optionalNumber(row.last_successful_scan_at)
      ? { lastSuccessfulScanAt: numberValue(row.last_successful_scan_at) }
      : {}),
    ...(optionalNumber(row.last_complete_reconcile_at)
      ? { lastCompleteReconcileAt: numberValue(row.last_complete_reconcile_at) }
      : {}),
  }
}

function sessionFromRow(row: Record<string, unknown>): ScanSession {
  return {
    id: textValue(row.id),
    sourceId: textValue(row.source_id),
    state: textValue(row.state) as ScanSessionState,
    backend: textValue(row.backend) as ScanBackend,
    ...(optionalText(row.fallback_reason)
      ? { fallbackReason: textValue(row.fallback_reason) }
      : {}),
    ...(optionalText(row.fallback_code) ? { fallbackCode: textValue(row.fallback_code) } : {}),
    startedAt: numberValue(row.started_at),
    ...(optionalNumber(row.finished_at) ? { finishedAt: numberValue(row.finished_at) } : {}),
    discoveredCount: numberValue(row.discovered_count),
    committedCount: numberValue(row.committed_count),
    ...(optionalText(row.error) ? { error: textValue(row.error) } : {}),
  }
}

export class DiscoveryCatalogDatabase {
  private database: DatabaseSync | null = null

  constructor(private readonly filePath: string) {}

  private open(): DatabaseSync {
    if (this.database) return this.database
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const database = new DatabaseSync(this.filePath)
    try {
      database.exec('PRAGMA busy_timeout = 5000')
      database.exec('PRAGMA synchronous = NORMAL')
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA foreign_keys = ON')
      const versionRow = database.prepare('PRAGMA user_version').get()
      const version = numberValue(versionRow?.user_version)
      if (version !== 0 && version !== CATALOG_SCHEMA_VERSION) {
        database.exec(`
          DROP TABLE IF EXISTS index_states;
          DROP TABLE IF EXISTS scan_sessions;
          DROP TABLE IF EXISTS file_entries;
          DROP TABLE IF EXISTS sources;
        `)
      }
      database.exec(SCHEMA_DDL)
      database.exec(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION}`)
      this.database = database
      return database
    } catch (error) {
      database.close()
      throw error
    }
  }

  close(): void {
    if (this.database) {
      this.database.close()
      this.database = null
    }
  }

  // ── Sources ────────────────────────────────────────────

  insertSource(source: DataSource, now: number): void {
    this.open()
      .prepare(
        `INSERT INTO sources (
          id, type, display_name, root_locator, read_only, availability, scan_capability,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        source.id,
        source.type,
        source.displayName,
        source.rootLocator,
        source.readOnly ? 1 : 0,
        source.availability,
        source.scanCapability,
        now,
        now,
      )
  }

  getSource(sourceId: string): DataSource | null {
    const row = this.open().prepare('SELECT * FROM sources WHERE id = ?').get(sourceId)
    return row ? sourceFromRow(row) : null
  }

  updateSourceScanMeta(
    sourceId: string,
    meta: {
      availability?: SourceAvailability
      scanCapability?: SourceScanCapability
      lastAttemptAt?: number
      lastSuccessfulScanAt?: number
      now: number
    },
  ): void {
    const current = this.getSource(sourceId)
    if (!current) return
    this.open()
      .prepare(
        `UPDATE sources SET
          availability = ?, scan_capability = ?, last_attempt_at = ?,
          last_successful_scan_at = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        meta.availability ?? current.availability,
        meta.scanCapability ?? current.scanCapability,
        meta.lastAttemptAt ?? current.lastAttemptAt ?? null,
        meta.lastSuccessfulScanAt ?? current.lastSuccessfulScanAt ?? null,
        meta.now,
        sourceId,
      )
  }

  removeSource(sourceId: string): boolean {
    const database = this.open()
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = database.prepare('DELETE FROM sources WHERE id = ?').run(sourceId)
      database.exec('COMMIT')
      return Number(result.changes) > 0
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  repairMountedSourceRoot(sourceId: string, newRoot: string, now: number): number {
    const database = this.open()
    const source = this.getSource(sourceId)
    if (!source || source.type !== 'mounted-network') return -1
    const entries = database
      .prepare('SELECT id, relative_path FROM file_entries WHERE source_id = ? ORDER BY id ASC')
      .all(sourceId)
    const updateEntry = database.prepare(
      `UPDATE file_entries SET path_key = ?, availability = 'online', updated_at = ? WHERE id = ?`,
    )
    database.exec('BEGIN IMMEDIATE')
    try {
      database
        .prepare(
          `UPDATE sources SET root_locator = ?, availability = 'unknown',
           last_attempt_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(newRoot, now, sourceId)
      for (const entry of entries) {
        const target = path.resolve(newRoot, textValue(entry.relative_path))
        const relative = path.relative(newRoot, target)
        if (
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          throw new Error('Catalog entry escapes the repaired source root')
        }
        updateEntry.run(discoveryPathKey(target), now, numberValue(entry.id))
      }
      database.exec('COMMIT')
      return entries.length
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  getSourceRepairSamples(
    sourceId: string,
    limit = 16,
  ): Array<{ relativePath: string; sizeBytes: number; modifiedAt: number }> {
    return this.open()
      .prepare(
        `SELECT relative_path, size_bytes, modified_at FROM file_entries
         WHERE source_id = ? ORDER BY updated_at DESC, id ASC LIMIT ?`,
      )
      .all(sourceId, Math.max(1, Math.min(32, Math.floor(limit))))
      .map((row) => ({
        relativePath: textValue(row.relative_path),
        sizeBytes: numberValue(row.size_bytes),
        modifiedAt: numberValue(row.modified_at),
      }))
  }

  listSources(): DiscoverySourceListItem[] {
    const rows = this.open()
      .prepare(
        `SELECT
          s.*,
          (SELECT COUNT(*) FROM file_entries f WHERE f.source_id = s.id AND f.availability != 'missing') AS file_count,
          (SELECT COALESCE(SUM(f.size_bytes), 0) FROM file_entries f WHERE f.source_id = s.id AND f.availability != 'missing') AS total_bytes,
          (SELECT state FROM scan_sessions ss WHERE ss.source_id = s.id ORDER BY ss.started_at DESC LIMIT 1) AS last_scan_state,
          (SELECT backend FROM scan_sessions ss WHERE ss.source_id = s.id ORDER BY ss.started_at DESC LIMIT 1) AS last_scan_backend,
          (SELECT fallback_reason FROM scan_sessions ss WHERE ss.source_id = s.id ORDER BY ss.started_at DESC LIMIT 1) AS last_scan_fallback_reason
        FROM sources s
        ORDER BY s.created_at ASC, s.id ASC`,
      )
      .all()
    return rows.map((row) => ({
      ...sourceFromRow(row),
      fileCount: numberValue(row.file_count),
      totalBytes: numberValue(row.total_bytes),
      ...(optionalText(row.last_scan_state)
        ? { lastScanState: textValue(row.last_scan_state) as ScanSessionState }
        : {}),
      ...(optionalText(row.last_scan_backend)
        ? { lastScanBackend: textValue(row.last_scan_backend) as ScanBackend }
        : {}),
      ...(optionalText(row.last_scan_fallback_reason)
        ? { lastScanFallbackReason: textValue(row.last_scan_fallback_reason) }
        : {}),
    }))
  }

  // ── Scan sessions ──────────────────────────────────────

  createSession(session: ScanSession): void {
    this.open()
      .prepare(
        `INSERT INTO scan_sessions (
          id, source_id, state, backend, started_at, discovered_count, committed_count
        ) VALUES (?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(session.id, session.sourceId, session.state, session.backend, session.startedAt)
  }

  updateSessionProgress(
    sessionId: string,
    update: {
      discoveredCount: number
      committedCount: number
      backend?: ScanBackend
      fallbackReason?: string | null
      fallbackCode?: string | null
    },
  ): void {
    this.open()
      .prepare(
        `UPDATE scan_sessions SET
          discovered_count = ?, committed_count = ?,
          backend = COALESCE(?, backend),
          fallback_reason = COALESCE(?, fallback_reason),
          fallback_code = COALESCE(?, fallback_code)
        WHERE id = ?`,
      )
      .run(
        update.discoveredCount,
        update.committedCount,
        update.backend ?? null,
        update.fallbackReason ?? null,
        update.fallbackCode ?? null,
        sessionId,
      )
  }

  finishSession(
    sessionId: string,
    state: Exclude<ScanSessionState, 'running'>,
    finishedAt: number,
    error?: string,
  ): void {
    this.open()
      .prepare('UPDATE scan_sessions SET state = ?, finished_at = ?, error = ? WHERE id = ?')
      .run(state, finishedAt, error ?? null, sessionId)
  }

  getSession(sessionId: string): ScanSession | null {
    const row = this.open().prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId)
    return row ? sessionFromRow(row) : null
  }

  getLatestSession(sourceId: string): ScanSession | null {
    const row = this.open()
      .prepare('SELECT * FROM scan_sessions WHERE source_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(sourceId)
    return row ? sessionFromRow(row) : null
  }

  // ── File entries (D1 discovery batches) ────────────────
  // Upsert keyed by the stable (source_id, path_key) identity: repeated
  // scans, cancel+restart and duplicate batches never create duplicate rows.

  upsertDiscoveredBatch(
    sourceId: string,
    sessionId: string | null,
    entries: readonly DiscoveredEntry[],
    now: number,
  ): number {
    if (entries.length === 0) return 0
    const database = this.open()
    const upsert = database.prepare(
      `INSERT INTO file_entries (
        source_id, path_key, relative_path, name, name_key, extension,
        size_bytes, modified_at, filesystem_identity, availability,
        first_seen_session_id, last_seen_session_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?, ?)
      ON CONFLICT(source_id, path_key) DO UPDATE SET
        relative_path = excluded.relative_path,
        name = excluded.name,
        name_key = excluded.name_key,
        extension = excluded.extension,
        size_bytes = excluded.size_bytes,
        modified_at = excluded.modified_at,
        filesystem_identity = COALESCE(excluded.filesystem_identity, file_entries.filesystem_identity),
        availability = 'online',
        last_seen_session_id = COALESCE(excluded.last_seen_session_id, file_entries.last_seen_session_id),
        updated_at = excluded.updated_at`,
    )
    const markStage = database.prepare(
      `INSERT INTO index_states (file_entry_id, stage, state, updated_at)
        SELECT id, ?, 'ready', ? FROM file_entries WHERE source_id = ? AND path_key = ?
      ON CONFLICT(file_entry_id, stage) DO UPDATE SET
        state = 'ready', updated_at = excluded.updated_at`,
    )
    const previousFreshness = database.prepare(
      'SELECT id, size_bytes, modified_at FROM file_entries WHERE source_id = ? AND path_key = ?',
    )
    const markDerivedStagesStale = database.prepare(
      `UPDATE index_states SET state = 'stale', updated_at = ?
       WHERE file_entry_id = ? AND stage != 'discovered'`,
    )
    let committed = 0
    for (let offset = 0; offset < entries.length; offset += BATCH_SIZE) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const end = Math.min(entries.length, offset + BATCH_SIZE)
        for (let index = offset; index < end; index++) {
          const entry = entries[index]
          const pathKey = discoveryPathKey(entry.absolutePath)
          const previous = previousFreshness.get(sourceId, pathKey)
          upsert.run(
            sourceId,
            pathKey,
            entry.relativePath,
            entry.name,
            entry.name.toLowerCase(),
            entry.extension,
            entry.sizeBytes,
            entry.modifiedAt,
            entry.filesystemIdentity ?? null,
            sessionId,
            sessionId,
            now,
            now,
          )
          markStage.run('discovered', now, sourceId, pathKey)
          if (
            previous &&
            (numberValue(previous.size_bytes) !== entry.sizeBytes ||
              numberValue(previous.modified_at) !== entry.modifiedAt)
          ) {
            markDerivedStagesStale.run(now, numberValue(previous.id))
          }
          committed += 1
        }
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    return committed
  }

  /**
   * Tombstone exact files or complete directory prefixes after an incremental
   * watcher has confirmed that the source root is still online. Rows remain
   * recoverable for reconnect/move repair, but disappear from normal search.
   */
  markFileEntriesMissingByPaths(
    sourceId: string,
    absolutePaths: readonly string[],
    now: number,
  ): number {
    const prefixes = [...new Set(absolutePaths.map(discoveryPathKey))]
    if (!prefixes.length) return 0
    const database = this.open()
    const findRows = database.prepare(
      `SELECT id FROM file_entries
       WHERE source_id = ? AND availability != 'missing'
         AND (path_key = ? OR path_key LIKE ? ESCAPE '!')`,
    )
    const ids = new Set<number>()
    for (const prefix of prefixes) {
      const escaped = prefix.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_')
      const descendants = `${escaped}${path.sep}%`
      for (const row of findRows.all(sourceId, prefix, descendants)) ids.add(numberValue(row.id))
    }
    if (!ids.size) return 0
    database.exec('BEGIN IMMEDIATE')
    try {
      const markMissing = database.prepare(
        `UPDATE file_entries SET availability = 'missing', updated_at = ? WHERE id = ?`,
      )
      const markDerivedStagesStale = database.prepare(
        `UPDATE index_states SET state = 'stale', updated_at = ?
         WHERE file_entry_id = ? AND stage != 'discovered'`,
      )
      for (const id of ids) {
        markMissing.run(now, id)
        markDerivedStagesStale.run(now, id)
      }
      database.exec('COMMIT')
      return ids.size
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Tombstone exact local file paths across every registered local source in
   * one SQLite transaction. Source-file synchronization uses this after it has
   * revalidated the online root and proven the individual files are ENOENT.
   */
  markLocalFileEntriesMissingByPaths(absolutePaths: readonly string[], now: number): number {
    const keys = [...new Set(absolutePaths.map(discoveryPathKey))]
    if (!keys.length) return 0
    const database = this.open()
    const ids = new Set<number>()
    for (let offset = 0; offset < keys.length; offset += 500) {
      const chunk = keys.slice(offset, offset + 500)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = database
        .prepare(
          `SELECT f.id FROM file_entries f
           JOIN sources s ON s.id = f.source_id
           WHERE f.availability != 'missing'
             AND s.type NOT IN ('sftp', 'nas-agent')
             AND f.path_key IN (${placeholders})`,
        )
        .all(...chunk)
      for (const row of rows) ids.add(numberValue(row.id))
    }
    if (!ids.size) return 0
    database.exec('BEGIN IMMEDIATE')
    try {
      const markMissing = database.prepare(
        `UPDATE file_entries SET availability = 'missing', updated_at = ? WHERE id = ?`,
      )
      const markDerivedStagesStale = database.prepare(
        `UPDATE index_states SET state = 'stale', updated_at = ?
         WHERE file_entry_id = ? AND stage != 'discovered'`,
      )
      for (const id of ids) {
        markMissing.run(now, id)
        markDerivedStagesStale.run(now, id)
      }
      database.exec('COMMIT')
      return ids.size
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  countFileEntries(sourceId?: string): number {
    const row = sourceId
      ? this.open()
          .prepare('SELECT COUNT(*) AS total FROM file_entries WHERE source_id = ?')
          .get(sourceId)
      : this.open().prepare('SELECT COUNT(*) AS total FROM file_entries').get()
    return numberValue(row?.total)
  }

  listFileEntryPathKeys(sourceId: string): string[] {
    const rows = this.open()
      .prepare('SELECT path_key FROM file_entries WHERE source_id = ? ORDER BY path_key ASC')
      .all(sourceId)
    return rows.map((row) => textValue(row.path_key))
  }

  getFileEntryForAction(fileEntryId: string): CatalogFileActionRecord | null {
    if (!/^[1-9]\d{0,15}$/.test(fileEntryId)) return null
    const row = this.open()
      .prepare(
        `SELECT f.id AS file_id, f.name, f.path_key, f.size_bytes, f.modified_at, s.*
         FROM file_entries f JOIN sources s ON s.id = f.source_id
         WHERE f.id = ? AND f.availability != 'missing' LIMIT 1`,
      )
      .get(fileEntryId)
    if (!row) return null
    return {
      fileEntryId: String(numberValue(row.file_id)),
      displayName: textValue(row.name),
      displayPath: textValue(row.path_key),
      sizeBytes: numberValue(row.size_bytes),
      modifiedAt: numberValue(row.modified_at),
      source: sourceFromRow(row),
    }
  }

  setFileEntryIndexState(
    fileEntryId: string,
    stage: Exclude<IndexStage, 'discovered'>,
    state: 'ready' | 'failed' | 'retryable' | 'stale',
    now: number,
  ): boolean {
    if (!/^[1-9]\d{0,15}$/.test(fileEntryId)) return false
    const result = this.open()
      .prepare(
        `INSERT INTO index_states (file_entry_id, stage, state, updated_at)
         SELECT id, ?, ?, ? FROM file_entries WHERE id = ?
         ON CONFLICT(file_entry_id, stage) DO UPDATE SET
           state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(stage, state, now, fileEntryId)
    return Number(result.changes) > 0
  }

  // ── Phase 2 filesystem-identity lookups (design 7.2) ───
  // Same-volume move repair: rows carrying a filesystem identity keep their
  // identity across renames, so the catalog re-points path columns instead
  // of duplicating the entry.

  findFileEntryByFilesystemIdentity(
    sourceId: string,
    filesystemIdentity: string,
  ): { id: number; pathKey: string } | null {
    const row = this.open()
      .prepare(
        'SELECT id, path_key FROM file_entries WHERE source_id = ? AND filesystem_identity = ? LIMIT 1',
      )
      .get(sourceId, filesystemIdentity)
    if (!row) return null
    return { id: numberValue(row.id), pathKey: textValue(row.path_key) }
  }

  /**
   * Re-point the catalog row that carries `filesystemIdentity` to the new
   * absolute path after a same-volume move. Returns true when a row moved.
   */
  repathFileEntryByIdentity(
    sourceId: string,
    filesystemIdentity: string,
    entry: { absolutePath: string; relativePath: string; name: string; extension: string },
    now: number,
  ): boolean {
    const result = this.open()
      .prepare(
        `UPDATE file_entries SET
          path_key = ?, relative_path = ?, name = ?, name_key = ?, extension = ?,
          availability = 'online', updated_at = ?
        WHERE source_id = ? AND filesystem_identity = ?`,
      )
      .run(
        discoveryPathKey(entry.absolutePath),
        entry.relativePath,
        entry.name,
        entry.name.toLowerCase(),
        entry.extension,
        now,
        sourceId,
        filesystemIdentity,
      )
    return Number(result.changes) > 0
  }

  /** Re-point every catalog projection of an exact old path after a move. */
  repathFileEntriesByPath(oldPath: string, newPath: string, now: number): number {
    const database = this.open()
    const oldKey = discoveryPathKey(oldPath)
    const newKey = discoveryPathKey(newPath)
    const rows = database
      .prepare(
        `SELECT f.id, f.source_id, s.root_locator
         FROM file_entries f JOIN sources s ON s.id = f.source_id
         WHERE f.path_key = ?`,
      )
      .all(oldKey)
    if (rows.length === 0) return 0
    const name = path.basename(newPath)
    const extension = path.extname(name).replace(/^\./, '').toLowerCase()
    let updated = 0
    database.exec('BEGIN IMMEDIATE')
    try {
      const statement = database.prepare(
        `UPDATE file_entries SET path_key = ?, relative_path = ?, name = ?,
          name_key = ?, extension = ?, availability = 'online', updated_at = ?
         WHERE id = ?`,
      )
      for (const row of rows) {
        const relativePath = path.relative(textValue(row.root_locator), newPath)
        const result = statement.run(
          newKey,
          relativePath,
          name,
          name.toLowerCase(),
          extension,
          now,
          numberValue(row.id),
        )
        updated += Number(result.changes)
      }
      database.exec('COMMIT')
      return updated
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  // ── Catalog query (lexical; works with no AI models) ───

  queryCatalog(request: DiscoveryCatalogQueryRequest): {
    items: DiscoveryCatalogResultItem[]
    total: number
  } {
    const database = this.open()
    const conditions: string[] = []
    const parameters: SQLInputValue[] = []
    const query = request.query?.trim().toLowerCase() || ''
    if (query) {
      conditions.push('(instr(f.name_key, ?) > 0 OR instr(lower(f.relative_path), ?) > 0)')
      parameters.push(query, query)
    }
    if (request.sourceId) {
      conditions.push('f.source_id = ?')
      parameters.push(request.sourceId)
    }
    conditions.unshift("f.availability != 'missing'")
    const where = `WHERE ${conditions.join(' AND ')}`
    const sort: DiscoveryCatalogQuerySort = request.sort ?? 'recent'
    const orderBy =
      sort === 'name_asc'
        ? 'f.name_key ASC, f.path_key ASC, f.id ASC'
        : sort === 'size_desc'
          ? 'f.size_bytes DESC, f.updated_at DESC, f.id DESC'
          : 'f.updated_at DESC, f.id DESC'
    const total = numberValue(
      database.prepare(`SELECT COUNT(*) AS total FROM file_entries f ${where}`).get(...parameters)
        ?.total,
    )
    const limit = Math.max(1, Math.min(request.limit ?? 100, 500))
    const offset = Math.max(0, request.offset ?? 0)
    const rows = database
      .prepare(
        `SELECT f.*, s.display_name AS source_name, s.type AS source_type, s.availability AS source_availability,
          s.root_locator AS source_root,
          (SELECT GROUP_CONCAT(ist.stage || ':' || ist.state, ',') FROM index_states ist WHERE ist.file_entry_id = f.id) AS index_state_list
        FROM file_entries f
        JOIN sources s ON s.id = f.source_id
        ${where}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      )
      .all(...parameters, limit, offset)
    const items = rows.map(catalogResultFromRow)
    return { items, total }
  }

  /** Resolve AI recall paths back to authoritative catalog rows. */
  findFileEntriesByPaths(displayPaths: readonly string[]): DiscoveryCatalogResultItem[] {
    const pathKeys = [...new Set(displayPaths.map(discoveryPathKey))]
    if (pathKeys.length === 0) return []
    const results: DiscoveryCatalogResultItem[] = []
    // Stay below SQLite's conservative host-parameter limit.
    for (let offset = 0; offset < pathKeys.length; offset += 400) {
      const chunk = pathKeys.slice(offset, offset + 400)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = this.open()
        .prepare(
          `SELECT f.*, s.display_name AS source_name, s.type AS source_type,
            s.availability AS source_availability,
            (SELECT GROUP_CONCAT(ist.stage || ':' || ist.state, ',') FROM index_states ist WHERE ist.file_entry_id = f.id) AS index_state_list
          FROM file_entries f
          JOIN sources s ON s.id = f.source_id
          WHERE f.availability != 'missing' AND f.path_key IN (${placeholders})`,
        )
        .all(...chunk)
      results.push(...rows.map(catalogResultFromRow))
    }
    return results
  }

  getStats(): DiscoveryCatalogStats {
    const database = this.open()
    const sourceCount = numberValue(
      database.prepare('SELECT COUNT(*) AS total FROM sources').get()?.total,
    )
    const fileRow = database
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(size_bytes), 0) AS bytes
         FROM file_entries WHERE availability != 'missing'`,
      )
      .get()
    const sessionRow = database
      .prepare('SELECT COUNT(*) AS total, MAX(started_at) AS last FROM scan_sessions')
      .get()
    return {
      sourceCount,
      fileCount: numberValue(fileRow?.total),
      totalBytes: numberValue(fileRow?.bytes),
      sessionCount: numberValue(sessionRow?.total),
      ...(optionalNumber(sessionRow?.last) ? { lastScanAt: numberValue(sessionRow?.last) } : {}),
    }
  }

  /**
   * Bounded, path-free consistency probe for diagnostics. It deliberately
   * returns only aggregate counts so renderer reports cannot disclose source
   * roots, filenames, scan errors, or remote credentials.
   */
  getConsistencyReport(): DiscoveryCatalogConsistencyReport {
    const database = this.open()
    const count = (sql: string): number => numberValue(database.prepare(sql).get()?.total)
    const quickRows = database.prepare('PRAGMA quick_check(1)').all()
    const quickCheckOk =
      quickRows.length === 1 &&
      textValue(Object.values(quickRows[0] as Record<string, unknown>)[0]).toLowerCase() === 'ok'
    const foreignKeyViolationCount = database.prepare('PRAGMA foreign_key_check').all().length
    const sourceCount = count('SELECT COUNT(*) AS total FROM sources')
    const fileCount = count('SELECT COUNT(*) AS total FROM file_entries')
    const indexStateCount = count('SELECT COUNT(*) AS total FROM index_states')
    const missingFileCount = count(
      "SELECT COUNT(*) AS total FROM file_entries WHERE availability = 'missing'",
    )
    const staleIndexCount = count(
      "SELECT COUNT(*) AS total FROM index_states WHERE state = 'stale'",
    )
    const failedIndexCount = count(
      "SELECT COUNT(*) AS total FROM index_states WHERE state IN ('failed', 'retryable')",
    )
    const orphanFileCount = count(
      `SELECT COUNT(*) AS total FROM file_entries f
       LEFT JOIN sources s ON s.id = f.source_id WHERE s.id IS NULL`,
    )
    const orphanIndexCount = count(
      `SELECT COUNT(*) AS total FROM index_states i
       LEFT JOIN file_entries f ON f.id = i.file_entry_id WHERE f.id IS NULL`,
    )
    const missingDiscoveryStateCount = count(
      `SELECT COUNT(*) AS total FROM file_entries f
       LEFT JOIN index_states i ON i.file_entry_id = f.id AND i.stage = 'discovered'
       WHERE i.file_entry_id IS NULL`,
    )
    const invalidIndexStateCount = count(
      `SELECT COUNT(*) AS total FROM index_states
       WHERE stage NOT IN ('discovered', 'metadata-ready', 'preview-ready', 'hash-ready', 'image-embedding-ready')
          OR state NOT IN ('ready', 'failed', 'retryable', 'stale')`,
    )
    const ok =
      quickCheckOk &&
      foreignKeyViolationCount === 0 &&
      orphanFileCount === 0 &&
      orphanIndexCount === 0 &&
      missingDiscoveryStateCount === 0 &&
      invalidIndexStateCount === 0
    return {
      ok,
      schemaVersion: CATALOG_SCHEMA_VERSION,
      sourceCount,
      fileCount,
      indexStateCount,
      missingFileCount,
      staleIndexCount,
      failedIndexCount,
      orphanFileCount,
      orphanIndexCount,
      missingDiscoveryStateCount,
      invalidIndexStateCount,
      quickCheckOk,
      foreignKeyViolationCount,
    }
  }
}
