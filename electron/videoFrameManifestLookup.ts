import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import type { MediaSearchVideoFrameRecord } from '../shared/ipc-contract'

const SCHEMA_VERSION = 1
const READ_CHUNK_BYTES = 64 * 1024

function sourceSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath)
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  } catch {
    return 'missing'
  }
}

function forEachLine(filePath: string, onLine: (line: string) => void): void {
  const descriptor = fs.openSync(filePath, 'r')
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  const decoder = new TextDecoder('utf-8')
  let pending = ''
  try {
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (read === 0) break
      pending += decoder.decode(chunk.subarray(0, read), { stream: true })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        onLine(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
      if (pending.length > 8 * 1024 * 1024) throw new Error('Video frame manifest row too large')
    }
    pending += decoder.decode()
    if (pending) onLine(pending)
  } finally {
    fs.closeSync(descriptor)
  }
}

function openDatabase(filePath: string): DatabaseSync {
  const database = new DatabaseSync(filePath)
  database.exec('PRAGMA journal_mode = DELETE')
  database.exec('PRAGMA synchronous = FULL')
  database.exec(`
    CREATE TABLE IF NOT EXISTS manifest_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS frame_records (
      frame_id TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      image_path TEXT,
      json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_frame_records_ordinal ON frame_records(ordinal DESC);
    CREATE INDEX IF NOT EXISTS idx_frame_records_status ON frame_records(status);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `)
  return database
}

function parseRecord(line: string): MediaSearchVideoFrameRecord | null {
  try {
    const record = JSON.parse(line) as Partial<MediaSearchVideoFrameRecord>
    return typeof record.frameId === 'string' && typeof record.videoId === 'string'
      ? (record as MediaSearchVideoFrameRecord)
      : null
  } catch {
    return null
  }
}

function replaceFile(temporary: string, target: string): void {
  try {
    fs.renameSync(temporary, target)
  } catch {
    try {
      fs.unlinkSync(target)
    } catch {
      // Target may not exist.
    }
    fs.renameSync(temporary, target)
  }
}

function buildDatabase(
  targetPath: string,
  manifestPath: string,
  records?: Iterable<MediaSearchVideoFrameRecord>,
): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const temporary = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const database = openDatabase(temporary)
  try {
    const insert = database.prepare(
      `INSERT INTO frame_records(frame_id, ordinal, status, image_path, json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(frame_id) DO UPDATE SET ordinal=excluded.ordinal,
         status=excluded.status, image_path=excluded.image_path, json=excluded.json`,
    )
    database.exec('BEGIN IMMEDIATE')
    try {
      let ordinal = 0
      const append = (record: MediaSearchVideoFrameRecord) => {
        insert.run(
          record.frameId,
          ordinal++,
          record.status,
          record.imagePath ?? null,
          JSON.stringify(record),
        )
      }
      if (records) {
        for (const record of records) append(record)
      } else if (fs.existsSync(manifestPath)) {
        forEachLine(manifestPath, (line) => {
          if (!line) return
          const record = parseRecord(line)
          if (record) append(record)
        })
      }
      database
        .prepare('INSERT OR REPLACE INTO manifest_meta(key, value) VALUES (?, ?)')
        .run('source_signature', sourceSignature(manifestPath))
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  } finally {
    database.close()
  }
  try {
    replaceFile(temporary, targetPath)
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    } catch {
      // A later rebuild can replace an abandoned derived database.
    }
  }
}

export class VideoFrameManifestLookup {
  constructor(
    private readonly manifestPath: string,
    private readonly databasePath: string,
  ) {}

  private withFreshDatabase<T>(read: (database: DatabaseSync) => T): T {
    let fresh = false
    try {
      const database = new DatabaseSync(this.databasePath, { readOnly: true })
      try {
        const version = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
        const signature = database
          .prepare("SELECT value FROM manifest_meta WHERE key='source_signature'")
          .get()?.value
        fresh = version === SCHEMA_VERSION && signature === sourceSignature(this.manifestPath)
      } finally {
        database.close()
      }
    } catch {
      // Missing, stale, or corrupt derived databases are rebuilt below.
    }
    if (!fresh) buildDatabase(this.databasePath, this.manifestPath)
    const database = new DatabaseSync(this.databasePath, { readOnly: true })
    try {
      database.exec('PRAGMA query_only = ON')
      return read(database)
    } finally {
      database.close()
    }
  }

  replace(records: Iterable<MediaSearchVideoFrameRecord>): void {
    buildDatabase(this.databasePath, this.manifestPath, records)
  }

  listAll(): MediaSearchVideoFrameRecord[] {
    return this.withFreshDatabase((database) =>
      database
        .prepare('SELECT json FROM frame_records ORDER BY ordinal')
        .all()
        .map((row) => JSON.parse(String(row.json)) as MediaSearchVideoFrameRecord),
    )
  }

  countDone(): number {
    return this.withFreshDatabase((database) =>
      Number(
        database.prepare("SELECT COUNT(*) AS count FROM frame_records WHERE status='done'").get()
          ?.count ?? 0,
      ),
    )
  }

  preview(limit: number): { frames: MediaSearchVideoFrameRecord[]; total: number } {
    return this.withFreshDatabase((database) => ({
      frames: database
        .prepare('SELECT json FROM frame_records ORDER BY ordinal DESC LIMIT ?')
        .all(Math.max(1, Math.min(2000, Math.floor(limit))))
        .map((row) => JSON.parse(String(row.json)) as MediaSearchVideoFrameRecord),
      total: Number(
        database.prepare('SELECT COUNT(*) AS count FROM frame_records').get()?.count ?? 0,
      ),
    }))
  }

  findReady(frameId: string): MediaSearchVideoFrameRecord | null {
    return this.withFreshDatabase((database) => {
      const row = database
        .prepare("SELECT json FROM frame_records WHERE frame_id=? AND status='done'")
        .get(frameId)
      return row ? (JSON.parse(String(row.json)) as MediaSearchVideoFrameRecord) : null
    })
  }

  listReady(): MediaSearchVideoFrameRecord[] {
    return this.withFreshDatabase((database) =>
      database
        .prepare("SELECT json FROM frame_records WHERE status='done' ORDER BY ordinal")
        .all()
        .map((row) => JSON.parse(String(row.json)) as MediaSearchVideoFrameRecord),
    )
  }
}
