// ── Subject Embedding Store ────────────────────────────────
// Persistent cache for subject-level embeddings (face / OSNet body /
// DINO subject crops). Identity reranking re-embeds the same library
// images on every Subject search; this store makes repeat searches
// near-instant by keying vectors to (kind, path, mtime).
//
// Storage: append-only JSONL in <userData>/subject-embeddings/, loaded
// into memory on first use. Entries are bounded (MAX_ENTRIES); when the
// cap is exceeded the file is compacted, dropping the oldest quarter.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { classifyEmbeddingVector, MAX_EMBEDDING_VECTOR_DIM } from './embeddingVectorValidation'
import { isImageDataPathWithin, normalizedImageDataPathKey } from './imageSearchDataPathUtils'

export type SubjectEmbeddingKind = 'face' | 'osnet' | string // string allows 'crop:<label>'

interface StoreEntry {
  key: string
  vector: number[]
  createdAt: number
}

const MAX_ENTRIES = 5000
const COMPACT_DROP = 1250

let storeDir: string | null = null
let entries: Map<string, StoreEntry> | null = null
let writeQueue: Promise<void> = Promise.resolve()
let corruptEntryCount = 0
const blockedSourceScopes = new Map<string, number>()

/**
 * Stored vectors must be either an explicit empty negative marker ("no face
 * in this image") or a finite, non-zero embedding within the platform
 * dimension limit (VAL-021 rules). Anything else is corrupt.
 */
function isStorableSubjectVector(vector: unknown): vector is number[] {
  if (!Array.isArray(vector)) return false
  if (vector.length === 0) return true
  if (vector.length < 2 || vector.length > MAX_EMBEDDING_VECTOR_DIM) return false
  return classifyEmbeddingVector(vector, vector.length).ok
}

/** Test/diagnostic helper: entries skipped as corrupt during the last load. */
export function subjectEmbeddingCorruptCount(): number {
  return corruptEntryCount
}

/** Test hook: drop the in-memory view so the next access reloads from disk. */
export function resetSubjectEmbeddingStoreForTests(): void {
  entries = null
  corruptEntryCount = 0
  blockedSourceScopes.clear()
}

/**
 * Extract the source image path from the stable `kind|path|mtime` key. Kinds
 * may contain colons (for example `crop:subject`), while Windows paths cannot
 * contain `|`; using the first and last separators also keeps legacy kinds
 * compatible.
 */
export function subjectEmbeddingPathFromKey(key: string): string | null {
  if (typeof key !== 'string') return null
  const first = key.indexOf('|')
  const last = key.lastIndexOf('|')
  if (first <= 0 || last <= first + 1 || last >= key.length - 1) return null
  const imagePath = key.slice(first + 1, last)
  return imagePath.trim() ? imagePath : null
}

function isBlockedSubjectEmbeddingKey(key: string): boolean {
  const imagePath = subjectEmbeddingPathFromKey(key)
  if (!imagePath) return false
  for (const sourceKey of blockedSourceScopes.keys()) {
    if (isImageDataPathWithin(imagePath, sourceKey)) return true
  }
  return false
}

/** Wait until every append/compaction already accepted by the store is durable. */
export async function flushSubjectEmbeddingStoreWrites(): Promise<void> {
  await writeQueue
}

/**
 * Prevent cache writes for one source while its JSONL file is being replaced.
 * The cache is rebuildable, so a concurrent lookup simply recomputes later.
 */
export function blockSubjectEmbeddingWritesForSource(sourcePath: string): () => void {
  const sourceKey = normalizedImageDataPathKey(sourcePath)
  if (!sourceKey) return () => {}
  blockedSourceScopes.set(sourceKey, (blockedSourceScopes.get(sourceKey) || 0) + 1)
  return () => {
    const remaining = (blockedSourceScopes.get(sourceKey) || 1) - 1
    if (remaining > 0) blockedSourceScopes.set(sourceKey, remaining)
    else blockedSourceScopes.delete(sourceKey)
  }
}

/** Remove only one source from the loaded memory view after an atomic rewrite. */
export function invalidateSubjectEmbeddingsForSource(sourcePath: string): number {
  if (!entries) return 0
  const sourceKey = normalizedImageDataPathKey(sourcePath)
  let removed = 0
  for (const key of [...entries.keys()]) {
    const imagePath = subjectEmbeddingPathFromKey(key)
    if (imagePath && isImageDataPathWithin(imagePath, sourceKey)) {
      entries.delete(key)
      removed += 1
    }
  }
  return removed
}

function resolveStoreDir(): string {
  if (storeDir) return storeDir
  let base: string
  try {
    // electron app when running inside the main process
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron')
    base = app?.getPath ? app.getPath('userData') : os.tmpdir()
  } catch {
    base = os.tmpdir()
  }
  storeDir = path.join(base, 'subject-embeddings')
  fs.mkdirSync(storeDir, { recursive: true })
  return storeDir
}

function storeFile(): string {
  return path.join(resolveStoreDir(), 'embeddings.jsonl')
}

function ensureLoaded(): Map<string, StoreEntry> {
  if (entries) return entries
  entries = new Map()
  corruptEntryCount = 0
  try {
    const file = storeFile()
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue
        try {
          const e = JSON.parse(line) as StoreEntry
          // Corrupt or hostile entries are skipped (tombstoned on load), so a
          // poisoned store can never flow into similarity computations.
          if (e && typeof e.key === 'string' && isStorableSubjectVector(e.vector)) {
            entries.set(e.key, e)
          } else {
            corruptEntryCount += 1
          }
        } catch {
          corruptEntryCount += 1
        }
      }
    }
  } catch {
    // unreadable store → start empty (cache only, never fatal)
  }
  if (corruptEntryCount > 0) {
    console.warn(`[subject-embeddings] skipped ${corruptEntryCount} corrupt cache entries`)
  }
  return entries
}

export function subjectEmbeddingKey(
  kind: SubjectEmbeddingKind,
  imagePath: string,
  mtimeMs: number,
): string {
  return `${kind}|${imagePath}|${Math.round(mtimeMs)}`
}

/** Safe mtime lookup; null when the file is gone/unreadable. */
export function statMtimeMs(imagePath: string): number | null {
  try {
    return fs.statSync(imagePath).mtimeMs
  } catch {
    return null
  }
}

export function getSubjectEmbedding(key: string): number[] | null {
  const e = ensureLoaded().get(key)
  return e ? e.vector : null
}

export function putSubjectEmbedding(key: string, vector: number[]): void {
  if (!isStorableSubjectVector(vector)) {
    // Never persist a hostile/invalid embedding; the caller recomputes next time.
    console.warn('[subject-embeddings] rejected an invalid embedding vector')
    return
  }
  if (isBlockedSubjectEmbeddingKey(key)) return
  const map = ensureLoaded()
  map.set(key, { key, vector, createdAt: Date.now() })
  const line = `${JSON.stringify({ key, vector, createdAt: Date.now() })}\n`
  // serialize appends to avoid interleaved writes
  writeQueue = writeQueue.then(() => fs.promises.appendFile(storeFile(), line).catch(() => {}))
  if (map.size > MAX_ENTRIES) compact(map)
}

function compact(map: Map<string, StoreEntry>): void {
  const sorted = [...map.values()].sort((a, b) => a.createdAt - b.createdAt)
  const drop = new Set(sorted.slice(0, COMPACT_DROP).map((e) => e.key))
  const kept = sorted.slice(COMPACT_DROP)
  for (const key of drop) map.delete(key)
  const body = kept.map((e) => JSON.stringify(e)).join('\n') + '\n'
  writeQueue = writeQueue.then(() => fs.promises.writeFile(storeFile(), body).catch(() => {}))
}

/** Test/diagnostic helper: current in-memory entry count (-1 if not loaded). */
export function subjectEmbeddingCount(): number {
  return entries ? entries.size : -1
}
