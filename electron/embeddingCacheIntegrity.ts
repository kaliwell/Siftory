// ── Unified integrity proof for persisted F16 vector caches (VAL-038) ──
// Every on-disk F16 segment (authoritative generation files, delta increment
// segments, derived .f16/.paths.jsonl caches) carries a content proof written
// at commit time: the byte size and the SHA-256 of exactly those bytes.
// Consumers never trust a segment that fails its proof — readers fail closed
// (no handle, rebuild/fallback) and the ANN worker rejects the request, so
// post-commit corruption (bitflip, truncation, partial write) can no longer
// flow silently into search or ANN results. Proofs are verified through a
// per-process memo keyed by path+size+mtime so a multi-gigabyte segment is
// hashed at most once per on-disk state.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export interface EmbeddingCacheFileProof {
  /** Committed byte length the hash covers (a prefix for append-only segments). */
  size: number
  sha256: string
}

const MAX_MEMO_ENTRIES = 512
const HASH_CHUNK_BYTES = 1024 * 1024

const hashMemo = new Map<string, string>()

/** Explicit signal that corrupted persisted vectors were refused. */
export function noteEmbeddingCacheIntegrityFailure(scope: string, detail: string): void {
  console.warn(`[vector-integrity] ${scope}: ${detail}`)
}

export function isValidEmbeddingCacheFileProof(value: unknown): value is EmbeddingCacheFileProof {
  if (!value || typeof value !== 'object') return false
  const proof = value as EmbeddingCacheFileProof
  return (
    Number.isSafeInteger(proof.size) &&
    proof.size >= 0 &&
    typeof proof.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(proof.sha256)
  )
}

/**
 * Memoized SHA-256 over the first `size` bytes of a file. The memo key
 * includes the file size and mtime, so any on-disk rewrite (which always
 * changes at least one of them) is hashed again; a memoized hit therefore
 * still proves the current bytes.
 */
export function sha256FilePrefixSync(filePath: string, size: number): string {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('Invalid integrity proof size')
  }
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size < size) {
    throw new Error('Integrity proof target is shorter than its proof')
  }
  const key = `${path.resolve(filePath)} ${stat.size} ${size} ${stat.mtimeMs}`
  const memoized = hashMemo.get(key)
  if (memoized) return memoized
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, size)))
  try {
    let offset = 0
    while (offset < size) {
      const read = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      )
      if (read === 0) throw new Error('Could not read integrity proof range')
      hash.update(buffer.subarray(0, read))
      offset += read
    }
  } finally {
    fs.closeSync(descriptor)
  }
  const digest = hash.digest('hex')
  if (hashMemo.size >= MAX_MEMO_ENTRIES) hashMemo.clear()
  hashMemo.set(key, digest)
  return digest
}

/** Builds the proof of a file's current full content. */
export function createEmbeddingCacheFileProof(filePath: string): EmbeddingCacheFileProof {
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error('Integrity proof target is not a file')
  return { size: stat.size, sha256: sha256FilePrefixSync(filePath, stat.size) }
}

/** Verifies a file against its committed proof; false on any mismatch or I/O error. */
export function verifyEmbeddingCacheFileProof(
  filePath: string,
  proof: EmbeddingCacheFileProof,
): boolean {
  if (!isValidEmbeddingCacheFileProof(proof)) return false
  try {
    return sha256FilePrefixSync(filePath, proof.size) === proof.sha256
  } catch {
    return false
  }
}

export function resetEmbeddingCacheIntegrityMemoForTests(): void {
  hashMemo.clear()
}
