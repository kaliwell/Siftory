import fs from 'fs'
import path from 'path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { AssetLibraryListRequest, AssetRecord } from '../shared/ipc/asset-library'

const CATALOG_SCHEMA_VERSION = 4
const INSERT_BATCH_SIZE = 2048

type NormalizedAssetListRequest = Required<
  Pick<AssetLibraryListRequest, 'offset' | 'limit' | 'sort'>
> &
  Omit<AssetLibraryListRequest, 'offset' | 'limit' | 'sort'>

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function optionalTextValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function recordFromRow(row: Record<string, unknown>): AssetRecord {
  const archived = numberValue(row.archived) === 1
  const archivedAt = numberValue(row.archived_at)
  return {
    id: numberValue(row.id),
    path: textValue(row.path),
    kind: textValue(row.kind) === 'video_frame' ? 'video_frame' : 'image',
    source: textValue(row.source) === 'manual' ? 'manual' : 'image_search',
    width: numberValue(row.width),
    height: numberValue(row.height),
    fileSize: numberValue(row.file_size),
    modifiedTime: numberValue(row.modified_time),
    ...(optionalTextValue(row.diff_hash64) ? { diffHash64: textValue(row.diff_hash64) } : {}),
    ...(optionalTextValue(row.dct_hash64) ? { dctHash64: textValue(row.dct_hash64) } : {}),
    missing: numberValue(row.missing) === 1,
    archived,
    ...(archived && archivedAt > 0 ? { archivedAt } : {}),
    ...(numberValue(row.rating) > 0 ? { rating: numberValue(row.rating) } : {}),
    ...(numberValue(row.favorite) === 1 ? { favorite: true } : {}),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  }
}

function insertValues(record: AssetRecord): SQLInputValue[] {
  const name = path.basename(record.path)
  return [
    record.id,
    record.path,
    record.path.toLowerCase(),
    name.toLowerCase(),
    record.kind,
    record.source,
    record.width,
    record.height,
    record.fileSize,
    record.modifiedTime,
    record.diffHash64 || null,
    record.dctHash64 || null,
    record.missing ? 1 : 0,
    record.archived ? 1 : 0,
    record.archivedAt || null,
    record.rating || 0,
    record.favorite ? 1 : 0,
    record.createdAt,
    record.updatedAt,
  ]
}

export class AssetCatalogProjection {
  private readonly filePath: string
  private initialized = false

  constructor(filePath: string) {
    this.filePath = filePath
  }

  resetStorage(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(`${this.filePath}${suffix}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    this.initialized = false
  }

  private open(): DatabaseSync {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const database = new DatabaseSync(this.filePath)
    try {
      database.exec('PRAGMA busy_timeout = 5000')
      database.exec('PRAGMA synchronous = NORMAL')
      if (!this.initialized) {
        database.exec('PRAGMA journal_mode = WAL')
        this.ensureSchema(database)
        this.initialized = true
      }
      return database
    } catch (error) {
      database.close()
      throw error
    }
  }

  private ensureSchema(database: DatabaseSync): void {
    const versionRow = database.prepare('PRAGMA user_version').get()
    const version = numberValue(versionRow?.user_version)
    if (version !== 0 && version !== CATALOG_SCHEMA_VERSION) {
      database.exec(`
        DROP TRIGGER IF EXISTS assets_fts_insert;
        DROP TRIGGER IF EXISTS assets_fts_delete;
        DROP TRIGGER IF EXISTS assets_fts_update;
        DROP TABLE IF EXISTS asset_path_fts;
        DROP TABLE IF EXISTS assets;
        DROP TABLE IF EXISTS catalog_meta;
      `)
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        search_path TEXT NOT NULL,
        name_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        file_size INTEGER NOT NULL,
        modified_time INTEGER NOT NULL,
        diff_hash64 TEXT,
        dct_hash64 TEXT,
        missing INTEGER NOT NULL,
        archived INTEGER NOT NULL,
        archived_at INTEGER,
        rating INTEGER NOT NULL DEFAULT 0,
        favorite INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assets_active_updated
        ON assets (archived, missing, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_assets_active_name
        ON assets (archived, missing, name_key, search_path, id);
      CREATE INDEX IF NOT EXISTS idx_assets_active_size
        ON assets (archived, missing, file_size DESC, updated_at DESC, id DESC);
      PRAGMA user_version = ${CATALOG_SCHEMA_VERSION};
    `)
  }

  isFresh(sourceFingerprint: string, expectedCount: number): boolean {
    const database = this.open()
    try {
      const fingerprint = database
        .prepare("SELECT value FROM catalog_meta WHERE key = 'source_fingerprint'")
        .get()
      if (textValue(fingerprint?.value) !== sourceFingerprint) return false
      const count = database.prepare('SELECT COUNT(*) AS total FROM assets').get()
      return numberValue(count?.total) === expectedCount
    } finally {
      database.close()
    }
  }

  async replaceAll(
    records: ReadonlyMap<number, AssetRecord>,
    sourceFingerprint: string,
  ): Promise<void> {
    const database = this.open()
    try {
      database.exec('DELETE FROM catalog_meta; DELETE FROM assets;')
      const insert = database.prepare(`
        INSERT INTO assets (
          id, path, search_path, name_key, kind, source, width, height, file_size,
          modified_time, diff_hash64, dct_hash64, missing, archived, archived_at,
          rating, favorite, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const values = [...records.values()]
      let activeCount = 0
      let archivedCount = 0
      for (let offset = 0; offset < values.length; offset += INSERT_BATCH_SIZE) {
        database.exec('BEGIN IMMEDIATE')
        try {
          const end = Math.min(values.length, offset + INSERT_BATCH_SIZE)
          for (let index = offset; index < end; index++) {
            const record = values[index]
            insert.run(...insertValues(record))
            if (record.archived) archivedCount += 1
            else if (!record.missing) activeCount += 1
          }
          database.exec('COMMIT')
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      database.exec('BEGIN IMMEDIATE')
      try {
        const insertMeta = database.prepare('INSERT INTO catalog_meta (key, value) VALUES (?, ?)')
        insertMeta.run('source_fingerprint', sourceFingerprint)
        insertMeta.run('active_count', String(activeCount))
        insertMeta.run('archived_count', String(archivedCount))
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    } finally {
      database.close()
    }
  }

  updateRecords(
    records: readonly AssetRecord[],
    sourceFingerprint: string,
    expectedCount: number,
  ): boolean {
    const database = this.open()
    try {
      const count = database.prepare('SELECT COUNT(*) AS total FROM assets').get()
      if (numberValue(count?.total) !== expectedCount) return false
      const replace = database.prepare(`
        INSERT OR REPLACE INTO assets (
          id, path, search_path, name_key, kind, source, width, height, file_size,
          modified_time, diff_hash64, dct_hash64, missing, archived, archived_at,
          rating, favorite, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      database.exec('BEGIN IMMEDIATE')
      try {
        for (const record of records) replace.run(...insertValues(record))
        const counts = database
          .prepare(
            `
            SELECT
              SUM(CASE WHEN archived = 0 AND missing = 0 THEN 1 ELSE 0 END) AS active_count,
              SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived_count
            FROM assets
          `,
          )
          .get()
        const replaceMeta = database.prepare(
          'INSERT OR REPLACE INTO catalog_meta (key, value) VALUES (?, ?)',
        )
        replaceMeta.run('source_fingerprint', sourceFingerprint)
        replaceMeta.run('active_count', String(numberValue(counts?.active_count)))
        replaceMeta.run('archived_count', String(numberValue(counts?.archived_count)))
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      return true
    } finally {
      database.close()
    }
  }

  list(request: NormalizedAssetListRequest): { records: AssetRecord[]; total: number } {
    const database = this.open()
    try {
      const query = request.query?.trim().toLowerCase() || ''
      const conditions = [request.archivedOnly ? 'archived = 1' : 'archived = 0 AND missing = 0']
      const parameters: SQLInputValue[] = []
      if (query) {
        conditions.push('instr(search_path, ?) > 0')
        parameters.push(query)
      }
      if (request.source) {
        conditions.push('source = ?')
        parameters.push(request.source)
      }
      if (request.kind) {
        conditions.push('kind = ?')
        parameters.push(request.kind)
      }
      if (request.modifiedAfter !== undefined) {
        conditions.push('modified_time >= ?')
        parameters.push(request.modifiedAfter)
      }
      if (request.modifiedBefore !== undefined) {
        conditions.push('modified_time <= ?')
        parameters.push(request.modifiedBefore)
      }
      if (request.minRating !== undefined) {
        conditions.push('rating >= ?')
        parameters.push(request.minRating)
      }
      if (request.favoriteOnly) conditions.push('favorite = 1')
      const where = conditions.join(' AND ')
      let total = 0
      const hasAdditionalFilters = Boolean(
        query ||
        request.source ||
        request.kind ||
        request.modifiedAfter !== undefined ||
        request.modifiedBefore !== undefined ||
        request.minRating !== undefined ||
        request.favoriteOnly,
      )
      if (!hasAdditionalFilters) {
        const countKey = request.archivedOnly ? 'archived_count' : 'active_count'
        const cachedCount = database
          .prepare('SELECT value FROM catalog_meta WHERE key = ?')
          .get(countKey)
        total = Number.parseInt(textValue(cachedCount?.value), 10)
      }
      if (!Number.isFinite(total) || hasAdditionalFilters) {
        const countRow = database
          .prepare(`SELECT COUNT(*) AS total FROM assets WHERE ${where}`)
          .get(...parameters)
        total = numberValue(countRow?.total)
      }
      const orderBy =
        request.sort === 'name_asc'
          ? 'name_key ASC, search_path ASC, id ASC'
          : request.sort === 'size_desc'
            ? 'file_size DESC, updated_at DESC, id DESC'
            : 'updated_at DESC, id DESC'
      const rows = database
        .prepare(`SELECT * FROM assets WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
        .all(...parameters, request.limit, request.offset)
      return {
        records: rows.map((row) => recordFromRow(row)),
        total,
      }
    } finally {
      database.close()
    }
  }
}
