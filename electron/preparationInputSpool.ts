import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'

export interface PreparationSpoolWindow {
  ids: number[]
  paths: string[]
}

function pathKey(value: string): string {
  const resolved = path.resolve(value).replace(/\//g, '\\').replace(/\\+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Durable, bounded-memory scan→embedding handoff with explicit ACK. */
export class PreparationInputSpool {
  readonly filePath: string
  private database: DatabaseSync | null

  constructor(
    filePath = path.join(os.tmpdir(), `siftory-preparation-${crypto.randomUUID()}.sqlite`),
  ) {
    this.filePath = filePath
    const database = new DatabaseSync(filePath)
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = NORMAL')
    database.exec(`
      CREATE TABLE IF NOT EXISTS pending_inputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path_key TEXT NOT NULL UNIQUE,
        image_path TEXT NOT NULL
      ) STRICT;
    `)
    this.database = database
  }

  private open(): DatabaseSync {
    if (!this.database) throw new Error('Preparation input spool is closed')
    return this.database
  }

  add(paths: readonly string[]): string[] {
    const database = this.open()
    const insert = database.prepare(
      'INSERT OR IGNORE INTO pending_inputs(path_key, image_path) VALUES (?, ?)',
    )
    const accepted: string[] = []
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const imagePath of paths) {
        const result = insert.run(pathKey(imagePath), imagePath)
        if (Number(result.changes) > 0) accepted.push(imagePath)
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return accepted
  }

  count(): number {
    return Number(
      this.open().prepare('SELECT COUNT(*) AS count FROM pending_inputs').get()?.count ?? 0,
    )
  }

  peek(limit: number): PreparationSpoolWindow {
    const rows = this.open()
      .prepare('SELECT id, image_path FROM pending_inputs ORDER BY id LIMIT ?')
      .all(Math.max(1, Math.min(256, Math.floor(limit))))
    return {
      ids: rows.map((row) => Number(row.id)),
      paths: rows.map((row) => String(row.image_path)),
    }
  }

  acknowledge(ids: readonly number[]): void {
    if (ids.length === 0) return
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || ids.length > 256) {
      throw new Error('Preparation input ACK is invalid')
    }
    const placeholders = ids.map(() => '?').join(',')
    this.open()
      .prepare(`DELETE FROM pending_inputs WHERE id IN (${placeholders})`)
      .run(...ids)
  }

  dispose(): void {
    if (!this.database) return
    this.database.close()
    this.database = null
    for (const candidate of [this.filePath, `${this.filePath}-wal`, `${this.filePath}-shm`]) {
      try {
        fs.unlinkSync(candidate)
      } catch {
        // The file may not exist after SQLite checkpoint/close.
      }
    }
  }
}
