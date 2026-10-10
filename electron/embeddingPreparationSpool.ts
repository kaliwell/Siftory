import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

export interface PreparedEmbeddingInput {
  imageId: string
  imagePath: string
}

export interface PreparedEmbeddingInputWindow {
  ids: number[]
  items: PreparedEmbeddingInput[]
}

/** Child-owned disk state for existing-ID lookup and candidate handoff. */
export class EmbeddingPreparationSpool {
  readonly filePath: string
  private database: DatabaseSync | null
  private insertExisting: StatementSync
  private deleteExisting: StatementSync
  private existingTransaction = false

  constructor(
    filePath = path.join(os.tmpdir(), `siftory-embedding-prep-${crypto.randomUUID()}.sqlite`),
  ) {
    this.filePath = filePath
    const database = new DatabaseSync(filePath)
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = NORMAL')
    database.exec(`
      CREATE TABLE existing_ids (
        path_key TEXT PRIMARY KEY
      ) WITHOUT ROWID, STRICT;
      CREATE TABLE candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path_key TEXT NOT NULL UNIQUE,
        image_id TEXT NOT NULL,
        image_path TEXT NOT NULL
      ) STRICT;
      CREATE TABLE project_previews (
        path_key TEXT PRIMARY KEY,
        preview_path TEXT NOT NULL
      ) WITHOUT ROWID, STRICT;
    `)
    this.database = database
    this.insertExisting = database.prepare(
      'INSERT OR IGNORE INTO existing_ids(path_key) VALUES (?)',
    )
    this.deleteExisting = database.prepare('DELETE FROM existing_ids WHERE path_key = ?')
  }

  private open(): DatabaseSync {
    if (!this.database) throw new Error('Embedding preparation spool is closed')
    return this.database
  }

  beginExistingLoad(): void {
    if (this.existingTransaction) return
    this.open().exec('BEGIN IMMEDIATE')
    this.existingTransaction = true
  }

  endExistingLoad(): void {
    if (!this.existingTransaction) return
    this.open().exec('COMMIT')
    this.existingTransaction = false
  }

  add(value: string): this {
    this.insertExisting.run(value)
    return this
  }

  delete(value: string): boolean {
    return Number(this.deleteExisting.run(value).changes) > 0
  }

  get size(): number {
    return Number(
      this.open().prepare('SELECT COUNT(*) AS count FROM existing_ids').get()?.count ?? 0,
    )
  }

  hasExisting(pathKey: string): boolean {
    return Boolean(
      this.open().prepare('SELECT 1 AS found FROM existing_ids WHERE path_key = ?').get(pathKey),
    )
  }

  addProjectPreview(pathKey: string, previewPath: string): void {
    this.open()
      .prepare('INSERT OR REPLACE INTO project_previews(path_key, preview_path) VALUES (?, ?)')
      .run(pathKey, previewPath)
  }

  findProjectPreview(pathKey: string): string | null {
    const row = this.open()
      .prepare('SELECT preview_path FROM project_previews WHERE path_key = ?')
      .get(pathKey)
    return row ? String(row.preview_path) : null
  }

  addCandidate(pathKey: string, input: PreparedEmbeddingInput): boolean {
    const result = this.open()
      .prepare('INSERT OR IGNORE INTO candidates(path_key, image_id, image_path) VALUES (?, ?, ?)')
      .run(pathKey, input.imageId, input.imagePath)
    return Number(result.changes) > 0
  }

  candidateCount(): number {
    return Number(this.open().prepare('SELECT COUNT(*) AS count FROM candidates').get()?.count ?? 0)
  }

  peekCandidates(limit = 256): PreparedEmbeddingInputWindow {
    const rows = this.open()
      .prepare('SELECT id, image_id, image_path FROM candidates ORDER BY id LIMIT ?')
      .all(Math.max(1, Math.min(256, Math.floor(limit))))
    return {
      ids: rows.map((row) => Number(row.id)),
      items: rows.map((row) => ({
        imageId: String(row.image_id),
        imagePath: String(row.image_path),
      })),
    }
  }

  acknowledgeCandidates(ids: readonly number[]): void {
    if (ids.length === 0) return
    if (ids.length > 256 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error('Embedding preparation ACK is invalid')
    }
    const placeholders = ids.map(() => '?').join(',')
    this.open()
      .prepare(`DELETE FROM candidates WHERE id IN (${placeholders})`)
      .run(...ids)
  }

  dispose(): void {
    if (!this.database) return
    if (this.existingTransaction) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // Closing the database remains the final ownership boundary.
      }
      this.existingTransaction = false
    }
    this.database.close()
    this.database = null
    for (const candidate of [this.filePath, `${this.filePath}-wal`, `${this.filePath}-shm`]) {
      try {
        fs.unlinkSync(candidate)
      } catch {
        // SQLite may already have checkpointed or removed the journal files.
      }
    }
  }
}
