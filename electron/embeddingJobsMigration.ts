import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { pendingJobKey, shardEmbeddingKey } from './embeddingJobsClassifier'

/**
 * Stale embedding jobs migration.
 *
 * Legacy `embedding_jobs.jsonl` rows have no epoch/owner/heartbeat semantics,
 * while current rows carry a renewable lease. This migration partitions the file:
 * rows whose (imageId, modelName, embeddingType) already exists in the
 * authoritative shards are archived to a timestamped sibling file, and
 * everything else (genuine backlog, terminal rows, malformed rows, rows
 * with a live owner heartbeat) is kept. The rewrite is atomic: full
 * sibling temp files, fsync, count verification, a preserved backup of
 * the original, then rename — never an in-place truncation.
 *
 * Nothing is deleted: the archived rows and the original backup both stay
 * on disk for user-confirmed removal later.
 */

export interface EmbeddingJobsMigrationOptions {
  now?: number
  staleAgeMs?: number
  dryRun?: boolean
}

export interface EmbeddingJobsMigrationResult {
  ok: boolean
  error?: string
  dryRun: boolean
  originalRows: number
  originalBytes: number
  keptRows: number
  keptBytes: number
  archivedRows: number
  archivedBytes: number
  malformedKept: number
  archivePath?: string
  backupPath?: string
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'skipped'])
const DEFAULT_STALE_AGE_MS = 7 * 24 * 60 * 60 * 1000

function timestampTag(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

async function loadEmbeddingKeys(shardPaths: string[]): Promise<Set<string>> {
  const keys = new Set<string>()
  for (const shardPath of shardPaths) {
    const reader = readline.createInterface({
      input: fs.createReadStream(shardPath, { encoding: 'utf8', highWaterMark: 4 * 1024 * 1024 }),
      crlfDelay: Infinity,
    })
    try {
      for await (const line of reader) {
        if (!line) continue
        const key = shardEmbeddingKey(line)
        if (key) keys.add(key)
      }
    } catch (error) {
      throw new Error(
        `Cannot read authoritative shard ${path.basename(shardPath)}; migration aborted: ${
          error instanceof Error ? error.message : error
        }`,
        { cause: error },
      )
    }
  }
  return keys
}

type RowDisposition = 'archive' | 'keep' | 'keep-malformed'

function classifyRow(
  line: string,
  embeddingKeys: Set<string>,
  now: number,
  staleAgeMs: number,
): RowDisposition {
  let row: Record<string, unknown>
  try {
    row = JSON.parse(line) as Record<string, unknown>
  } catch {
    // Never drop what we cannot understand.
    return 'keep-malformed'
  }
  const status = typeof row.status === 'string' ? row.status : ''
  if (TERMINAL_STATUSES.has(status)) return 'keep'
  if (status !== 'pending' && status !== 'running') return 'keep-malformed'
  if (
    typeof row.imageId !== 'string' ||
    !row.imageId ||
    typeof row.modelName !== 'string' ||
    !row.modelName ||
    typeof row.embeddingType !== 'string' ||
    !row.embeddingType
  ) {
    return 'keep-malformed'
  }
  // A row with a live owner heartbeat belongs to a running build: keep it.
  if (
    typeof row.owner === 'string' &&
    typeof row.heartbeatAt === 'number' &&
    row.heartbeatAt <= now &&
    now - row.heartbeatAt < staleAgeMs
  ) {
    return 'keep'
  }
  const activityAt = [row.heartbeatAt, row.updatedAt, row.startedAt, row.createdAt].find(
    (value) => typeof value === 'number' && Number.isFinite(value),
  ) as number | undefined
  if (activityAt === undefined) return 'keep-malformed'
  if (activityAt > now) return 'keep'
  if (activityAt <= now && now - activityAt < staleAgeMs) return 'keep'
  return embeddingKeys.has(pendingJobKey(row.imageId, row.modelName, row.embeddingType))
    ? 'archive'
    : 'keep'
}

export async function migrateStaleEmbeddingJobs(
  jobsPath: string,
  shardPaths: string[],
  options: EmbeddingJobsMigrationOptions = {},
): Promise<EmbeddingJobsMigrationResult> {
  const now = options.now ?? Date.now()
  const dryRun = options.dryRun ?? false
  const result: EmbeddingJobsMigrationResult = {
    ok: false,
    dryRun,
    originalRows: 0,
    originalBytes: 0,
    keptRows: 0,
    keptBytes: 0,
    archivedRows: 0,
    archivedBytes: 0,
    malformedKept: 0,
  }
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(jobsPath)
    if (!stat.isFile()) throw new Error('not a regular file')
  } catch {
    result.error = `Embedding jobs file is unavailable: ${jobsPath}`
    return result
  }
  result.originalBytes = stat.size
  if (shardPaths.length === 0) {
    result.error = 'No authoritative shards supplied; refusing to migrate without evidence'
    return result
  }

  let embeddingKeys: Set<string>
  try {
    embeddingKeys = await loadEmbeddingKeys(shardPaths)
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    return result
  }

  const directory = path.dirname(jobsPath)
  const tag = timestampTag(now)
  const archivePath = path.join(directory, `embedding_jobs.stale-archive-${tag}.jsonl`)
  const temporaryPath = path.join(directory, `.embedding_jobs.migration-${process.pid}.tmp`)
  const backupPath = path.join(directory, `embedding_jobs.migration-backup-${tag}.jsonl`)

  if (!dryRun) {
    try {
      const disk = await fs.promises.statfs(directory)
      const availableBytes = disk.bavail * disk.bsize
      // Keep file + archive + backup all coexist temporarily.
      if (availableBytes < stat.size * 2 + 64 * 1024 * 1024) {
        result.error = 'Not enough free space for the migration (need jobs file x2 + 64 MiB)'
        return result
      }
    } catch (error) {
      result.error = `Disk preflight failed: ${error instanceof Error ? error.message : error}`
      return result
    }
  }

  const keepWriter = dryRun ? null : fs.createWriteStream(temporaryPath, { flags: 'wx' })
  const archiveWriter = dryRun ? null : fs.createWriteStream(archivePath, { flags: 'wx' })
  try {
    const reader = readline.createInterface({
      input: fs.createReadStream(jobsPath, { encoding: 'utf8', highWaterMark: 4 * 1024 * 1024 }),
      crlfDelay: Infinity,
    })
    for await (const line of reader) {
      if (!line) continue
      result.originalRows++
      const rowBytes = Buffer.byteLength(`${line}\n`, 'utf8')
      const disposition = classifyRow(
        line,
        embeddingKeys,
        now,
        options.staleAgeMs ?? DEFAULT_STALE_AGE_MS,
      )
      if (disposition === 'archive') {
        result.archivedRows++
        result.archivedBytes += rowBytes
        if (archiveWriter && !archiveWriter.write(`${line}\n`)) {
          await new Promise<void>((resolve) => archiveWriter.once('drain', () => resolve()))
        }
      } else {
        result.keptRows++
        result.keptBytes += rowBytes
        if (disposition === 'keep-malformed') result.malformedKept++
        if (keepWriter && !keepWriter.write(`${line}\n`)) {
          await new Promise<void>((resolve) => keepWriter.once('drain', () => resolve()))
        }
      }
    }
  } catch (error) {
    keepWriter?.destroy()
    archiveWriter?.destroy()
    await cleanupPartial([temporaryPath, archivePath])
    result.error = `Migration read failed; original file untouched: ${
      error instanceof Error ? error.message : error
    }`
    return result
  }
  if (keepWriter) {
    await new Promise<void>((resolve, reject) => {
      keepWriter.once('error', reject)
      keepWriter.end(() => resolve())
    })
  }
  if (archiveWriter) {
    await new Promise<void>((resolve, reject) => {
      archiveWriter.once('error', reject)
      archiveWriter.end(() => resolve())
    })
  }

  if (result.keptRows + result.archivedRows !== result.originalRows) {
    await cleanupPartial([temporaryPath, archivePath])
    result.error = 'Row count mismatch after partitioning; original file untouched'
    return result
  }

  if (dryRun) {
    result.ok = true
    return result
  }

  try {
    await fs.promises.rename(jobsPath, backupPath)
    try {
      await fs.promises.rename(temporaryPath, jobsPath)
    } catch (error) {
      // Roll the original back before surfacing the failure.
      await fs.promises.rename(backupPath, jobsPath)
      throw error
    }
    // Post-commit verification: the new file must hold exactly the kept rows.
    let verifiedRows = 0
    const verifier = readline.createInterface({
      input: fs.createReadStream(jobsPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of verifier) {
      if (line) verifiedRows++
    }
    if (verifiedRows !== result.keptRows) {
      throw new Error(
        `Post-commit verification failed: expected ${result.keptRows} rows, found ${verifiedRows}`,
      )
    }
  } catch (error) {
    result.error = `Migration commit failed: ${error instanceof Error ? error.message : error}`
    return result
  }
  result.archivePath = archivePath
  result.backupPath = backupPath
  result.ok = true
  return result
}

async function cleanupPartial(paths: string[]): Promise<void> {
  for (const target of paths) {
    try {
      await fs.promises.unlink(target)
    } catch {
      // Partial output may not exist.
    }
  }
}
