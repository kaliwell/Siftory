import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import {
  extractJsonStringFieldBuffer,
  normalizedImageDataPathKey,
} from './imageSearchDataPathUtils'

/**
 * Read-only embedding jobs classifier.
 *
 * `embedding_jobs.jsonl` is a state snapshot. Legacy rows may not have build
 * epoch, owner or heartbeat fields, while current rows use those fields to
 * distinguish live work from an interrupted build. This module produces a *preview*
 * classification only — it never writes to or deletes the jobs file — so a
 * later, user-confirmed migration can act on evidence instead of guesses.
 *
 * Classification dimensions:
 * - malformed rows (unparseable or missing required fields), counted + bytes;
 * - terminal rows (completed/failed/skipped), counted by status;
 * - pending/running rows: age buckets, future-schema owner/heartbeat fields,
 *   duplicate (imageId, modelName, embeddingType) keys, and stale candidates
 *   (older than `staleAgeMs`, no owner, no recent heartbeat);
 * - optionally, which stale candidates already have an embedding in the
 *   authoritative shards (`checkEmbeddings`), intersected via a streaming
 *   key-only shard scan that never parses vector arrays.
 */

export interface EmbeddingJobsPreviewOptions {
  now?: number
  staleAgeMs?: number
  shardPaths?: string[]
  maxRowBytes?: number
}

export interface EmbeddingJobsPreview {
  jobsPath: string
  fileBytes: number
  totalRows: number
  malformedRows: number
  malformedBytes: number
  terminal: { completed: number; failed: number; skipped: number }
  pending: number
  running: number
  ageBuckets: { under24h: number; under7d: number; under30d: number; over30d: number }
  rowsWithOwnerFields: number
  duplicatePendingRows: number
  staleAgeMs: number
  staleCandidates: { rows: number; bytes: number }
  staleWithEmbedding: { rows: number; bytes: number } | null
  elapsedMs: number
}

const DEFAULT_STALE_AGE_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_ROW_BYTES = 1024 * 1024
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'skipped'])

interface PendingRowInfo {
  key: string
  bytes: number
  stale: boolean
}

export function pendingJobKey(imageId: string, modelName: string, embeddingType: string): string {
  return `${modelName}\u001f${embeddingType}\u001f${normalizedImageDataPathKey(imageId)}`
}

export function shardEmbeddingKey(line: string): string | undefined {
  const imageId = extractJsonStringFieldBuffer(Buffer.from(line, 'utf8'), 'imageId')
  const modelName = extractJsonStringFieldBuffer(Buffer.from(line, 'utf8'), 'modelName')
  const embeddingType = extractJsonStringFieldBuffer(Buffer.from(line, 'utf8'), 'embeddingType')
  if (!imageId || !modelName || !embeddingType) return undefined
  return pendingJobKey(imageId, modelName, embeddingType)
}

export async function previewEmbeddingJobs(
  jobsPath: string,
  options: EmbeddingJobsPreviewOptions = {},
): Promise<EmbeddingJobsPreview> {
  const started = Date.now()
  const now = options.now ?? started
  const staleAgeMs = options.staleAgeMs ?? DEFAULT_STALE_AGE_MS
  const maxRowBytes = options.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES
  const preview: EmbeddingJobsPreview = {
    jobsPath: '',
    fileBytes: 0,
    totalRows: 0,
    malformedRows: 0,
    malformedBytes: 0,
    terminal: { completed: 0, failed: 0, skipped: 0 },
    pending: 0,
    running: 0,
    ageBuckets: { under24h: 0, under7d: 0, under30d: 0, over30d: 0 },
    rowsWithOwnerFields: 0,
    duplicatePendingRows: 0,
    staleAgeMs,
    staleCandidates: { rows: 0, bytes: 0 },
    staleWithEmbedding: null,
    elapsedMs: 0,
  }
  try {
    const stat = await fs.promises.stat(jobsPath)
    if (!stat.isFile()) return finalize(preview, started)
    preview.fileBytes = stat.size
  } catch {
    return finalize(preview, started)
  }
  preview.jobsPath = path.basename(jobsPath)

  const seenPendingKeys = new Set<string>()
  const staleCandidates: PendingRowInfo[] = []
  const reader = readline.createInterface({
    input: fs.createReadStream(jobsPath, { encoding: 'utf8', highWaterMark: 4 * 1024 * 1024 }),
    crlfDelay: Infinity,
  })
  for await (const line of reader) {
    if (!line) continue
    preview.totalRows++
    const rowBytes = Buffer.byteLength(`${line}\n`, 'utf8')
    if (rowBytes > maxRowBytes) {
      preview.malformedRows++
      preview.malformedBytes += rowBytes
      continue
    }
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      preview.malformedRows++
      preview.malformedBytes += rowBytes
      continue
    }
    const status = typeof row.status === 'string' ? row.status : ''
    if (TERMINAL_STATUSES.has(status)) {
      preview.terminal[status as keyof EmbeddingJobsPreview['terminal']]++
      continue
    }
    if (status !== 'pending' && status !== 'running') {
      preview.malformedRows++
      preview.malformedBytes += rowBytes
      continue
    }
    if (
      typeof row.imageId !== 'string' ||
      !row.imageId ||
      typeof row.modelName !== 'string' ||
      !row.modelName ||
      typeof row.embeddingType !== 'string' ||
      !row.embeddingType ||
      typeof row.createdAt !== 'number' ||
      !Number.isFinite(row.createdAt)
    ) {
      preview.malformedRows++
      preview.malformedBytes += rowBytes
      continue
    }
    if (status === 'pending') preview.pending++
    else preview.running++
    if (
      typeof row.owner === 'string' ||
      typeof row.heartbeatAt === 'number' ||
      typeof row.epoch === 'number'
    ) {
      preview.rowsWithOwnerFields++
    }
    const age = now - row.createdAt
    if (age < 24 * 60 * 60 * 1000) preview.ageBuckets.under24h++
    else if (age < 7 * 24 * 60 * 60 * 1000) preview.ageBuckets.under7d++
    else if (age < 30 * 24 * 60 * 60 * 1000) preview.ageBuckets.under30d++
    else preview.ageBuckets.over30d++

    const key = pendingJobKey(row.imageId, row.modelName, row.embeddingType)
    if (seenPendingKeys.has(key)) {
      preview.duplicatePendingRows++
    } else {
      seenPendingKeys.add(key)
    }
    const hasLiveOwner =
      typeof row.owner === 'string' &&
      typeof row.heartbeatAt === 'number' &&
      row.heartbeatAt <= now &&
      now - row.heartbeatAt < staleAgeMs
    const activityAt = [row.heartbeatAt, row.updatedAt, row.startedAt, row.createdAt].find(
      (value) => typeof value === 'number' && Number.isFinite(value),
    ) as number
    const stale = activityAt <= now && now - activityAt >= staleAgeMs && !hasLiveOwner
    if (stale) {
      preview.staleCandidates.rows++
      preview.staleCandidates.bytes += rowBytes
      if (options.shardPaths?.length) staleCandidates.push({ key, bytes: rowBytes, stale })
    }
  }

  if (options.shardPaths?.length) {
    const candidateKeys = new Set(staleCandidates.map((candidate) => candidate.key))
    const matchedKeys = new Set<string>()
    for (const shardPath of options.shardPaths) {
      const shardReader = readline.createInterface({
        input: fs.createReadStream(shardPath, {
          encoding: 'utf8',
          highWaterMark: 4 * 1024 * 1024,
        }),
        crlfDelay: Infinity,
      })
      try {
        for await (const line of shardReader) {
          if (!line) continue
          const key = shardEmbeddingKey(line)
          if (key && candidateKeys.has(key)) matchedKeys.add(key)
        }
      } catch {
        // An unreadable shard only shrinks the confirmed set (fail closed).
      }
    }
    let rows = 0
    let bytes = 0
    for (const candidate of staleCandidates) {
      if (matchedKeys.has(candidate.key)) {
        rows++
        bytes += candidate.bytes
      }
    }
    preview.staleWithEmbedding = { rows, bytes }
  }
  return finalize(preview, started)
}

function finalize(preview: EmbeddingJobsPreview, started: number): EmbeddingJobsPreview {
  preview.elapsedMs = Date.now() - started
  return preview
}
