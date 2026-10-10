import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { app } from 'electron'
import type {
  VectorFailureRetryCandidates,
  VectorFailureSummaryItem,
  VectorMaintenanceStats,
  VectorRecentFailure,
} from '../shared/ipc-contract'
import {
  enforceEmbeddingJobRetention,
  flushVectorDatabaseWrites,
  getVectorDatabasePersistenceStatus,
} from './vectorDatabaseService'
import { getEmbeddingLogHealth } from './embeddingLogRetention'
import { readCurrentAuthoritativeManifest } from './authoritativeVectorStore'
import { readEmbeddingIncrementSnapshot } from './embeddingIncrementLog'
import { buildStorageInventory, type StorageInventoryOccupancy } from './storageInventory'

let exclusiveReservations = 0
let activeMutations = 0
let activeSearches = 0
const activeExclusiveMaintenanceLeases = new WeakSet<() => void>()

declare const vectorExclusiveMaintenanceLeaseBrand: unique symbol
export type VectorExclusiveMaintenanceLease = (() => void) & {
  readonly [vectorExclusiveMaintenanceLeaseBrand]: true
}

function releaseReservationOnce(release: () => void): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    release()
  }
}

/** Atomically joins the shared vector-write lane unless exclusive maintenance is starting. */
export function tryAcquireVectorMutationReservation(
  owner?: VectorExclusiveMaintenanceLease,
): (() => void) | null {
  const ownsExclusiveReservation = Boolean(owner && activeExclusiveMaintenanceLeases.has(owner))
  if ((exclusiveReservations > 0 && !ownsExclusiveReservation) || activeSearches > 0) return null
  activeMutations += 1
  return releaseReservationOnce(() => {
    activeMutations = Math.max(0, activeMutations - 1)
  })
}

/** Joins the search lane and prevents exclusive maintenance until every reader releases. */
export function tryAcquireVectorSearchReservation(): (() => void) | null {
  if (exclusiveReservations > 0 || activeMutations > 0) return null
  activeSearches += 1
  return releaseReservationOnce(() => {
    activeSearches = Math.max(0, activeSearches - 1)
  })
}

/** Atomically reserves GC/migration/reset startup against registered readers and writers. */
export function tryAcquireVectorExclusiveMaintenance(): VectorExclusiveMaintenanceLease | null {
  if (exclusiveReservations > 0 || activeMutations > 0 || activeSearches > 0) return null
  exclusiveReservations += 1
  let release: VectorExclusiveMaintenanceLease
  release = releaseReservationOnce(() => {
    activeExclusiveMaintenanceLeases.delete(release)
    exclusiveReservations = Math.max(0, exclusiveReservations - 1)
  }) as VectorExclusiveMaintenanceLease
  activeExclusiveMaintenanceLeases.add(release)
  return release
}

export function isVectorExclusiveMaintenanceReserved(): boolean {
  return exclusiveReservations > 0
}

export function isVectorMutationReservationActive(): boolean {
  return activeMutations > 0
}

export function isVectorSearchReservationActive(): boolean {
  return activeSearches > 0
}

export function isVectorMaintenanceReservationActive(): boolean {
  return exclusiveReservations > 0 || activeMutations > 0 || activeSearches > 0
}

function getVectorDbDir(): string {
  return path.join(app.getPath('userData'), 'vector-db')
}

function bytesToMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100
}

function statFile(filePath: string): { exists: boolean; sizeBytes: number; sizeMb: number } {
  try {
    const stat = fs.statSync(filePath)
    return { exists: true, sizeBytes: stat.size, sizeMb: bytesToMb(stat.size) }
  } catch {
    return { exists: false, sizeBytes: 0, sizeMb: 0 }
  }
}

async function countJsonlStringFieldStats(
  filePath: string,
  fieldName: string,
): Promise<{ records: number; unique: number }> {
  try {
    if (!fs.existsSync(filePath)) return { records: 0, unique: 0 }
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0) return { records: 0, unique: 0 }
    const values = new Set<string>()
    const fieldNeedle = `"${fieldName}":`
    let records = 0
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line) continue
      records++
      const start = line.indexOf(fieldNeedle)
      if (start < 0) continue
      let i = start + fieldNeedle.length
      while (line[i] === ' ') i++
      if (line[i] !== '"') continue
      i++
      let escaped = false
      let value = ''
      for (; i < line.length; i++) {
        const ch = line[i]
        if (escaped) {
          value += `\\${ch}`
          escaped = false
          continue
        }
        if (ch === '\\') {
          escaped = true
          continue
        }
        if (ch === '"') break
        value += ch
      }
      try {
        values.add(JSON.parse(`"${value}"`))
      } catch {
        values.add(value)
      }
    }
    return { records, unique: values.size }
  } catch {
    return { records: 0, unique: 0 }
  }
}

/**
 * Reads unique path values from a generation/delta path index
 * (`{"row":N,"path":"..."}` lines). When maxRows is set, only the first
 * maxRows committed lines count; an uncommitted tail is ignored. Returns
 * false when the index is unreadable or malformed.
 */
async function collectPathIndexPaths(
  filePath: string,
  maxRows: number | undefined,
  into: Set<string>,
): Promise<boolean> {
  try {
    if (!fs.existsSync(filePath)) return false
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
      crlfDelay: Infinity,
    })
    let rows = 0
    for await (const line of rl) {
      if (!line) continue
      if (maxRows !== undefined && rows >= maxRows) break
      rows++
      try {
        const parsed = JSON.parse(line) as { path?: unknown }
        if (typeof parsed.path === 'string') into.add(parsed.path)
      } catch {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * Diagnostic record/unique-image counts from the authoritative composite
 * snapshot (base generation + committed increment), read from the path
 * indexes instead of scanning the multi-GiB JSONL shards (D3 stage 3). The
 * record count follows the composite caliber `sourceRecordCount + δ`: rows a
 * rebuild would skip advance the source anchors without a delta row, the
 * same approximation the freshness fingerprint uses. Returns null when no
 * valid generation exists — the caller then falls back to the JSONL scan,
 * which is exactly the pre-D3 behavior.
 */
export async function readCompositeEmbeddingShardStats(options: {
  storeRoot: string
  modelName: string
  embeddingType: string
  sourcePaths: string[]
}): Promise<{ records: number; unique: number } | null> {
  try {
    const manifest = readCurrentAuthoritativeManifest(options.storeRoot)
    const entry = manifest?.entries.find(
      (candidate) =>
        candidate.modelName === options.modelName &&
        candidate.embeddingType === options.embeddingType,
    )
    if (!manifest || !entry) return null
    const unique = new Set<string>()
    const basePathIndex = path.join(
      options.storeRoot,
      'generations',
      manifest.generation,
      entry.paths.name,
    )
    if (!(await collectPathIndexPaths(basePathIndex, undefined, unique))) return null
    let records = entry.sourceRecordCount
    const snapshot = readEmbeddingIncrementSnapshot(
      options.storeRoot,
      options.modelName,
      options.embeddingType,
      entry.dim,
      options.sourcePaths,
    )
    if (
      snapshot &&
      (await collectPathIndexPaths(snapshot.pathIndexPath, snapshot.commit.deltaCount, unique))
    ) {
      records += snapshot.commit.deltaCount
    }
    return { records, unique: unique.size }
  } catch {
    return null
  }
}

export async function getVectorMaintenanceShardStats(vectorDbDir = getVectorDbDir()): Promise<{
  dinoEmbeddingRecords: number
  dinoUniqueImages: number
  clipEmbeddingRecords: number
  clipUniqueImages: number
}> {
  const embeddingsDir = path.join(vectorDbDir, 'embeddings')
  const dinoShard = path.join(embeddingsDir, 'dinov2_vitb14__global.jsonl')
  const clipShard = path.join(embeddingsDir, 'clip_vit_base_patch32__global.jsonl')
  const legacyShard = path.join(vectorDbDir, 'image_embeddings.jsonl')
  const storeRoot = path.join(vectorDbDir, 'vector-store')
  const compositeShardStats = (modelName: string, shardPath: string) =>
    readCompositeEmbeddingShardStats({
      storeRoot,
      modelName,
      embeddingType: 'global',
      sourcePaths: [shardPath, legacyShard].filter((sourcePath) => fs.existsSync(sourcePath)),
    }).then((composite) => composite ?? countJsonlStringFieldStats(shardPath, 'imageId'))
  const [dinoStats, clipStats] = await Promise.all([
    compositeShardStats('dinov2_vitb14', dinoShard),
    compositeShardStats('clip_vit_base_patch32', clipShard),
  ])
  return {
    dinoEmbeddingRecords: dinoStats.records,
    dinoUniqueImages: dinoStats.unique,
    clipEmbeddingRecords: clipStats.records,
    clipUniqueImages: clipStats.unique,
  }
}

function dirSize(dirPath: string): number {
  let total = 0
  if (!fs.existsSync(dirPath)) return 0
  const stack = [dirPath]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(fullPath).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total
}

function listEmbeddingShards(): VectorMaintenanceStats['embeddingShards'] {
  const dir = path.join(getVectorDbDir(), 'embeddings')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => {
      const filePath = path.join(dir, entry.name)
      const stat = statFile(filePath)
      return {
        name: entry.name,
        path: filePath,
        sizeBytes: stat.sizeBytes,
        sizeMb: stat.sizeMb,
      }
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
}

function listDiagnosticBackups(): VectorMaintenanceStats['diagnosticBackups'] {
  const dir = getVectorDbDir()
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith('embedding_diagnostics.jsonl.') &&
        entry.name.endsWith('.bak'),
    )
    .map((entry) => {
      const filePath = path.join(dir, entry.name)
      const stat = statFile(filePath)
      return {
        name: entry.name,
        path: filePath,
        sizeBytes: stat.sizeBytes,
        sizeMb: stat.sizeMb,
      }
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
}

function topSummary(map: Map<string, number>, limit = 5): VectorFailureSummaryItem[] {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit)
}

function classifyFailureReason(error: unknown): string {
  const raw = String(error || 'Unknown embedding error').trim()
  const text = raw.toLowerCase()
  if (!raw) return 'Unknown embedding error'
  if (text.includes('out of memory') || text.includes('allocation') || text.includes('oom')) {
    return 'Out of memory'
  }
  if (text.includes('timeout') || text.includes('timed out')) return 'Timeout'
  if (text.includes('no such file') || text.includes('enoent') || text.includes('not found')) {
    return 'File missing'
  }
  if (text.includes('permission') || text.includes('access denied') || text.includes('eperm')) {
    return 'Permission denied'
  }
  if (
    text.includes('decode') ||
    text.includes('unsupported image') ||
    text.includes('invalid image')
  ) {
    return 'Image decode failed'
  }
  if (text.includes('directml') || text.includes('dml') || text.includes('gpu')) {
    return 'GPU inference failed'
  }
  if (
    text.includes('model') ||
    text.includes('onnx') ||
    text.includes('missing the following inputs')
  ) {
    return 'Model execution failed'
  }
  return raw.length > 96 ? `${raw.slice(0, 96)}...` : raw
}

async function summarizeFailures(filePath: string): Promise<{
  count: number
  byModel: VectorFailureSummaryItem[]
  byReason: VectorFailureSummaryItem[]
  recent: VectorRecentFailure[]
}> {
  const byModel = new Map<string, number>()
  const byReason = new Map<string, number>()
  const recent: VectorRecentFailure[] = []
  let count = 0
  try {
    if (!fs.existsSync(filePath)) return { count, byModel: [], byReason: [], recent: [] }
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line) continue
      count++
      try {
        const row = JSON.parse(line) as {
          time?: string
          imageId?: string
          modelName?: string
          error?: string
        }
        const modelName = row.modelName || 'unknown'
        const reason = classifyFailureReason(row.error)
        byModel.set(modelName, (byModel.get(modelName) || 0) + 1)
        byReason.set(reason, (byReason.get(reason) || 0) + 1)
        recent.push({
          time: row.time,
          imageId: row.imageId,
          modelName,
          error: String(row.error || 'Unknown embedding error'),
        })
        if (recent.length > 5) recent.shift()
      } catch {
        const reason = 'Malformed failure row'
        byReason.set(reason, (byReason.get(reason) || 0) + 1)
      }
    }
  } catch {
    /* ignore */
  }
  return {
    count,
    byModel: topSummary(byModel),
    byReason: topSummary(byReason),
    recent: recent.reverse(),
  }
}

export async function getVectorMaintenanceStats(
  occupancy: StorageInventoryOccupancy = {},
): Promise<VectorMaintenanceStats> {
  const dir = getVectorDbDir()
  const embeddingsDir = path.join(dir, 'embeddings')
  const embeddingShards = listEmbeddingShards()
  const diagnosticBackups = listDiagnosticBackups()
  const totalBytes = dirSize(dir)
  const clipCachePaths = path.join(
    dir,
    'embedding-cache',
    'clip_vit_base_patch32__global.paths.jsonl',
  )
  const failurePath = path.join(dir, 'embedding_failures.jsonl')
  const embeddingsDirBytes = dirSize(embeddingsDir)
  // D3 stage 3: shard record/unique stats read the composite snapshot
  // (generation + committed increment path indexes); the multi-GiB JSONL
  // scan only runs as the fallback when no valid generation exists. Keep this
  // callable independently so maintenance validation does not need to scan
  // unrelated image-index and asset-library inventory.
  const [shardStats, clipCacheStats, failureSummary] = await Promise.all([
    getVectorMaintenanceShardStats(dir),
    countJsonlStringFieldStats(clipCachePaths, 'path'),
    summarizeFailures(failurePath),
  ])
  const storageInventory = await buildStorageInventory(app.getPath('userData'), occupancy)
  return {
    vectorDbPath: dir,
    totalBytes,
    totalMb: bytesToMb(totalBytes),
    embeddingsDirBytes,
    embeddingsDirMb: bytesToMb(embeddingsDirBytes),
    dinoEmbeddingRecords: shardStats.dinoEmbeddingRecords,
    dinoUniqueImages: shardStats.dinoUniqueImages,
    clipEmbeddingRecords: shardStats.clipEmbeddingRecords,
    clipUniqueImages: shardStats.clipUniqueImages,
    clipCacheRecords: clipCacheStats.records,
    clipCacheUniquePaths: clipCacheStats.unique,
    failureCount: failureSummary.count,
    failureByModel: failureSummary.byModel,
    failureByReason: failureSummary.byReason,
    recentFailures: failureSummary.recent,
    storageInventory: { ...storageInventory, scannedAt: Date.now() },
    embeddingShards,
    jobs: statFile(path.join(dir, 'embedding_jobs.jsonl')),
    failures: statFile(failurePath),
    diagnostics: statFile(path.join(dir, 'embedding_diagnostics.jsonl')),
    diagnosticBackups,
    logHealth: getEmbeddingLogHealth(),
    persistence: getVectorDatabasePersistenceStatus(),
    clipCache: {
      vectors: statFile(path.join(dir, 'embedding-cache', 'clip_vit_base_patch32__global.f16')),
      paths: statFile(
        path.join(dir, 'embedding-cache', 'clip_vit_base_patch32__global.paths.jsonl'),
      ),
      meta: statFile(path.join(dir, 'embedding-cache', 'clip_vit_base_patch32__global.f16.json')),
    },
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function getVectorFailureRetryCandidates(req?: {
  modelName?: string
  reason?: string
  limit?: number
}): Promise<VectorFailureRetryCandidates> {
  const filePath = path.join(getVectorDbDir(), 'embedding_failures.jsonl')
  const limit = Math.max(1, Math.min(5000, Number(req?.limit) || 500))
  const modelName = typeof req?.modelName === 'string' ? req.modelName : undefined
  const reason =
    typeof req?.reason === 'string' && req.reason.trim() ? req.reason.trim() : undefined
  const rows: string[] = []
  let totalMatched = 0
  let skippedMissing = 0
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: true, imageIds: [], totalMatched: 0, skippedMissing: 0 }
    }
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line) continue
      try {
        const row = JSON.parse(line) as { imageId?: string; modelName?: string; error?: string }
        if (!row.imageId || typeof row.imageId !== 'string') continue
        if (modelName && row.modelName !== modelName) continue
        if (reason && classifyFailureReason(row.error) !== reason) continue
        totalMatched++
        rows.push(row.imageId)
      } catch {
        /* ignore malformed retry row */
      }
    }
    const unique = new Set<string>()
    const imageIds: string[] = []
    for (let i = rows.length - 1; i >= 0 && imageIds.length < limit; i--) {
      const imageId = rows[i]
      if (unique.has(imageId)) continue
      unique.add(imageId)
      try {
        if (!fs.existsSync(imageId) || !fs.statSync(imageId).isFile()) {
          skippedMissing++
          continue
        }
      } catch {
        skippedMissing++
        continue
      }
      imageIds.push(imageId)
    }
    return { ok: true, imageIds, totalMatched, skippedMissing }
  } catch (err: unknown) {
    return { ok: false, imageIds: [], totalMatched, skippedMissing, error: errorMessage(err) }
  }
}

export function clearVectorDiagnostics(): {
  ok: boolean
  deleted: number
  freedBytes: number
  error?: string
} {
  let deleted = 0
  let freedBytes = 0
  try {
    for (const item of listDiagnosticBackups()) {
      if (!item.path) continue
      freedBytes += item.sizeBytes
      fs.unlinkSync(item.path)
      deleted++
    }
    return { ok: true, deleted, freedBytes }
  } catch (err: unknown) {
    return { ok: false, deleted, freedBytes, error: errorMessage(err) }
  }
}

export function clearVectorFailures(): {
  ok: boolean
  cleared: boolean
  freedBytes: number
  error?: string
} {
  const filePath = path.join(getVectorDbDir(), 'embedding_failures.jsonl')
  const stat = statFile(filePath)
  try {
    if (stat.exists) fs.writeFileSync(filePath, '', 'utf8')
    return { ok: true, cleared: stat.exists, freedBytes: stat.sizeBytes }
  } catch (err: unknown) {
    return { ok: false, cleared: false, freedBytes: 0, error: errorMessage(err) }
  }
}

export async function compactVectorJobs(): Promise<{
  ok: boolean
  beforeBytes: number
  afterBytes: number
  kept: number
  removed: number
  error?: string
}> {
  const filePath = path.join(getVectorDbDir(), 'embedding_jobs.jsonl')
  const before = statFile(filePath)
  if (!before.exists) return { ok: true, beforeBytes: 0, afterBytes: 0, kept: 0, removed: 0 }
  try {
    const retention = enforceEmbeddingJobRetention()
    await flushVectorDatabaseWrites()
    const after = statFile(filePath)
    return {
      ok: true,
      beforeBytes: before.sizeBytes,
      afterBytes: after.sizeBytes,
      kept: retention.kept,
      removed: retention.removed,
    }
  } catch (err: unknown) {
    return {
      ok: false,
      beforeBytes: before.sizeBytes,
      afterBytes: before.sizeBytes,
      kept: 0,
      removed: 0,
      error: errorMessage(err),
    }
  }
}
