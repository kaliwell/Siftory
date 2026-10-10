import fs from 'node:fs'
import path from 'node:path'

/**
 * Persisted Vector GC reclaimable estimate.
 *
 * A full active-set GC preview scans the authoritative JSONL shards and is
 * far too expensive for every storage-inventory call. Instead, each preview
 * persists a small per-shard fingerprint (size + mtime) plus the measured
 * reclaimable bytes; the inventory then reports the estimate only for
 * shards whose fingerprint still matches, and fails closed to zero the
 * moment any shard changes (including a real GC run).
 */

export interface VectorGcEstimateShard {
  name: string
  sizeBytes: number
  mtimeMs: number
  reclaimableBytes: number
  predictedBytes: number
}

export interface VectorGcEstimateReadResult {
  reclaimableBytes: number
  matchedShards: number
  totalShards: number
  estimatedAt?: number
}

const ESTIMATE_FILENAME = 'vector-gc-estimate.json'
const ESTIMATE_MAX_BYTES = 256 * 1024

function estimatePath(userDataPath: string): string {
  return path.join(userDataPath, 'vector-db', ESTIMATE_FILENAME)
}

/**
 * Persist the estimate produced by a GC preview. Shard fingerprints are
 * re-stat-ed here so callers only pass preview results. A write failure
 * never fails the preview: a missing estimate only hides the reclaimable
 * hint in the storage inventory.
 */
export async function writeVectorGcEstimate(
  userDataPath: string,
  shards: Array<{ shardPath: string; reclaimableBytes: number; predictedBytes: number }>,
): Promise<void> {
  try {
    const estimateShards: VectorGcEstimateShard[] = []
    for (const shard of shards) {
      try {
        const stat = await fs.promises.stat(shard.shardPath)
        if (!stat.isFile()) continue
        estimateShards.push({
          name: path.basename(shard.shardPath),
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          reclaimableBytes: shard.reclaimableBytes,
          predictedBytes: shard.predictedBytes,
        })
      } catch {
        // A shard that cannot be stat-ed is excluded from the estimate.
      }
    }
    const targetPath = estimatePath(userDataPath)
    const temporaryPath = `${targetPath}.tmp`
    await fs.promises.writeFile(
      temporaryPath,
      `${JSON.stringify({ schemaVersion: 1, createdAt: Date.now(), shards: estimateShards }, null, 2)}\n`,
      'utf8',
    )
    await fs.promises.rename(temporaryPath, targetPath)
  } catch {
    // A missing estimate only hides the reclaimable hint; never throw.
  }
}

/**
 * Read the persisted estimate, counting reclaimable bytes only for shards
 * whose size + mtime still match the preview fingerprint (fail closed).
 */
export async function readVectorGcEstimate(
  userDataPath: string,
): Promise<VectorGcEstimateReadResult> {
  const empty = { reclaimableBytes: 0, matchedShards: 0, totalShards: 0 }
  try {
    const targetPath = estimatePath(userDataPath)
    const stat = await fs.promises.stat(targetPath)
    if (!stat.isFile() || stat.size > ESTIMATE_MAX_BYTES) return empty
    const parsed = JSON.parse(await fs.promises.readFile(targetPath, 'utf8')) as {
      schemaVersion?: unknown
      createdAt?: unknown
      shards?: unknown
    }
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.shards)) return empty
    let reclaimableBytes = 0
    let matchedShards = 0
    let totalShards = 0
    for (const rawShard of parsed.shards) {
      if (!rawShard || typeof rawShard !== 'object' || Array.isArray(rawShard)) continue
      const shard = rawShard as {
        name?: unknown
        sizeBytes?: unknown
        mtimeMs?: unknown
        reclaimableBytes?: unknown
      }
      if (
        typeof shard.name !== 'string' ||
        path.basename(shard.name) !== shard.name ||
        !shard.name.endsWith('.jsonl') ||
        typeof shard.sizeBytes !== 'number' ||
        typeof shard.mtimeMs !== 'number' ||
        typeof shard.reclaimableBytes !== 'number' ||
        shard.reclaimableBytes < 0
      ) {
        continue
      }
      totalShards++
      try {
        const current = await fs.promises.stat(
          path.join(userDataPath, 'vector-db', 'embeddings', shard.name),
        )
        if (
          current.isFile() &&
          current.size === shard.sizeBytes &&
          current.mtimeMs === shard.mtimeMs
        ) {
          matchedShards++
          reclaimableBytes += shard.reclaimableBytes
        }
      } catch {
        // Shard disappeared since the estimate; excluded above.
      }
    }
    return {
      reclaimableBytes,
      matchedShards,
      totalShards,
      estimatedAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : undefined,
    }
  } catch {
    return empty
  }
}
