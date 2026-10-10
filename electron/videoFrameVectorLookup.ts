import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { DatabaseSync } from 'node:sqlite'
import {
  expectedFrameVectorDim,
  normalizeFrameKey,
  normalizeFrameVector,
} from './mediaSearchVectorMath'

const LOOKUP_VERSION = 1
export type VideoFrameVectorModel = 'dinov2_vitb14' | 'clip_vit_base_patch32'

function sourceSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

function openLookup(filePath: string, readonly = true): DatabaseSync {
  return new DatabaseSync(filePath, { readOnly: readonly })
}

function isCurrent(indexPath: string, lookupPath: string): boolean {
  try {
    const database = openLookup(lookupPath)
    try {
      const meta = database
        .prepare('SELECT version, source_signature FROM lookup_meta WHERE singleton = 1')
        .get()
      return (
        Number(meta?.version) === LOOKUP_VERSION &&
        String(meta?.source_signature) === sourceSignature(indexPath)
      )
    } finally {
      database.close()
    }
  } catch {
    return false
  }
}

function encodeVector(vector: readonly number[]): Buffer {
  const values = Float32Array.from(vector)
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength)
}

function decodeVector(value: unknown, dim: number): Float32Array | null {
  if (!(value instanceof Uint8Array) || value.byteLength !== dim * 4) return null
  const vector = new Float32Array(dim)
  const bytes = new Uint8Array(vector.buffer)
  bytes.set(value)
  return vector
}

async function rebuildLookup(indexPath: string, lookupPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(lookupPath), { recursive: true })
  const temporaryPath = `${lookupPath}.${process.pid}.${Date.now()}.tmp`
  const expectedSignature = sourceSignature(indexPath)
  const database = openLookup(temporaryPath, false)
  try {
    database.exec('PRAGMA journal_mode = DELETE')
    database.exec('PRAGMA synchronous = FULL')
    database.exec(`
      CREATE TABLE lookup_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        version INTEGER NOT NULL,
        source_signature TEXT NOT NULL
      ) STRICT;
      CREATE TABLE frame_vectors (
        model_name TEXT NOT NULL,
        path_key TEXT NOT NULL,
        image_path TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY(model_name, path_key)
      ) WITHOUT ROWID, STRICT;
    `)
    const upsert = database.prepare(`
      INSERT INTO frame_vectors(model_name, path_key, image_path, dim, vector)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(model_name, path_key) DO UPDATE SET
        image_path = excluded.image_path,
        dim = excluded.dim,
        vector = excluded.vector
    `)
    const remove = database.prepare(
      'DELETE FROM frame_vectors WHERE model_name = ? AND path_key = ?',
    )
    database.exec('BEGIN IMMEDIATE')
    if (fs.existsSync(indexPath)) {
      const lines = readline.createInterface({
        input: fs.createReadStream(indexPath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      })
      for await (const line of lines) {
        if (!line) continue
        try {
          const entry = JSON.parse(line) as {
            imagePath?: unknown
            modelName?: unknown
            dim?: unknown
            vector?: unknown
          }
          if (
            typeof entry.imagePath !== 'string' ||
            (entry.modelName !== 'dinov2_vitb14' && entry.modelName !== 'clip_vit_base_patch32')
          ) {
            continue
          }
          const modelName = entry.modelName
          const key = normalizeFrameKey(entry.imagePath)
          const dim = expectedFrameVectorDim(modelName)
          const vector = entry.dim === dim ? normalizeFrameVector(entry.vector, dim) : null
          if (!vector) remove.run(modelName, key)
          else upsert.run(modelName, key, entry.imagePath, dim, encodeVector(vector))
        } catch {
          // A malformed row cannot identify a canonical key and is skipped like the JSONL reader.
        }
      }
    }
    if (sourceSignature(indexPath) !== expectedSignature) {
      throw new Error('Frame vector source changed during lookup rebuild')
    }
    database
      .prepare('INSERT INTO lookup_meta(singleton, version, source_signature) VALUES (1, ?, ?)')
      .run(LOOKUP_VERSION, expectedSignature)
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // The transaction may not have opened.
    }
    throw error
  } finally {
    database.close()
  }

  const backupPath = `${lookupPath}.bak`
  fs.rmSync(backupPath, { force: true })
  if (fs.existsSync(lookupPath)) fs.renameSync(lookupPath, backupPath)
  try {
    fs.renameSync(temporaryPath, lookupPath)
    fs.rmSync(backupPath, { force: true })
  } catch (error) {
    if (!fs.existsSync(lookupPath) && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, lookupPath)
    }
    throw error
  } finally {
    fs.rmSync(temporaryPath, { force: true })
    fs.rmSync(`${temporaryPath}-journal`, { force: true })
  }
}

let rebuildChain: Promise<void> = Promise.resolve()

export async function ensureVideoFrameVectorLookup(
  indexPath: string,
  lookupPath: string,
): Promise<void> {
  if (isCurrent(indexPath, lookupPath)) return
  const rebuild = rebuildChain.then(async () => {
    if (!isCurrent(indexPath, lookupPath)) await rebuildLookup(indexPath, lookupPath)
  })
  rebuildChain = rebuild.catch(() => undefined)
  await rebuild
}

export function ensureVideoFrameVectorLookupSync(indexPath: string, lookupPath: string): void {
  if (isCurrent(indexPath, lookupPath)) return
  throw new Error('Frame vector lookup requires asynchronous rebuild')
}

export function countVideoFrameVectors(
  lookupPath: string,
  modelName: VideoFrameVectorModel,
): number {
  const database = openLookup(lookupPath)
  try {
    return Number(
      database
        .prepare('SELECT COUNT(*) AS count FROM frame_vectors WHERE model_name = ?')
        .get(modelName)?.count ?? 0,
    )
  } finally {
    database.close()
  }
}

export function findVideoFrameVector(
  lookupPath: string,
  modelName: VideoFrameVectorModel,
  imagePath: string,
): Float32Array | undefined {
  const database = openLookup(lookupPath)
  try {
    const row = database
      .prepare('SELECT dim, vector FROM frame_vectors WHERE model_name = ? AND path_key = ?')
      .get(modelName, normalizeFrameKey(imagePath))
    if (!row) return undefined
    return decodeVector(row.vector, Number(row.dim)) ?? undefined
  } finally {
    database.close()
  }
}

export async function scanVideoFrameVectors(
  lookupPath: string,
  modelName: VideoFrameVectorModel,
  onVector: (imagePath: string, vector: Float32Array) => void,
  options: { isCancelled?: () => boolean; yieldEvery?: number } = {},
): Promise<number> {
  const database = openLookup(lookupPath)
  let scanned = 0
  const yieldEvery = Math.max(128, Math.floor(options.yieldEvery || 1024))
  try {
    const rows = database
      .prepare(
        'SELECT image_path, dim, vector FROM frame_vectors WHERE model_name = ? ORDER BY path_key',
      )
      .iterate(modelName)
    for (const row of rows) {
      if (options.isCancelled?.()) throw new Error('Media search cancelled')
      const vector = decodeVector(row.vector, Number(row.dim))
      if (!vector) continue
      onVector(String(row.image_path), vector)
      scanned++
      if (scanned % yieldEvery === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    return scanned
  } finally {
    database.close()
  }
}

export function loadVideoFrameVectorMap(
  lookupPath: string,
  modelName: VideoFrameVectorModel,
): Map<string, Float32Array> {
  const database = openLookup(lookupPath)
  const result = new Map<string, Float32Array>()
  try {
    for (const row of database
      .prepare('SELECT image_path, dim, vector FROM frame_vectors WHERE model_name = ?')
      .iterate(modelName)) {
      const vector = decodeVector(row.vector, Number(row.dim))
      if (vector) result.set(String(row.image_path), vector)
    }
    return result
  } finally {
    database.close()
  }
}

export function removeVideoFrameVectorLookup(lookupPath: string): void {
  for (const candidate of [lookupPath, `${lookupPath}-journal`, `${lookupPath}.bak`]) {
    fs.rmSync(candidate, { force: true })
  }
}
