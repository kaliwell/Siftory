import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { readImageIndexAssets } from './imageIndexAssetSource'
import { discardEmbeddingIncrement } from './embeddingIncrementLog'
import { writeVectorGcEstimate } from './vectorGcEstimate'
import type { VectorGcPreview, VectorGcProgress } from '../shared/ipc-contract'
import { MAX_EMBEDDING_VECTOR_DIM, validateEmbeddingVector } from './embeddingVectorValidation'
import { getVisionModelCapability, isVisionModelName } from './modelRegistry'
import { serializeEmbeddingShardMutation } from './vectorDatabaseService'

export interface VectorGcShardPreview {
  shardPath: string
  sourceBytes: number
  totalRecords: number
  activeRecords: number
  staleRecords: number
  duplicateRecords: number
  malformedRecords: number
  predictedBytes: number
  reclaimableBytes: number
  modelName?: string
  embeddingType?: string
  dim?: number
}

export interface VectorGcOptions {
  isCancelled?: () => boolean
  onProgress?: (currentBytes: number, totalBytes: number) => void
  availableBytes?: number
  renameFile?: (from: string, to: string) => Promise<void>
}

interface ValidRow {
  imageId: string
  modelName: string
  embeddingType: string
  dim: number
  vector: number[]
}

interface RecognizedRow {
  imageId: string
  modelName: string
  embeddingType: string
  dim?: unknown
  vector?: unknown
}

interface ScanState {
  preview: VectorGcShardPreview
  latestActiveRows: Map<string, number>
}

interface VectorShardIdentity {
  size: number
  mtimeMs: number
  dev: number
  ino: number
  sampleSha256: string
}

const VECTOR_SHARD_IDENTITY_WINDOW_BYTES = 64 * 1024

/**
 * Cheap closed-loop identity used around multi-pass compaction. Size/stat catch
 * normal appends while hashes of both boundary windows catch same-size rewrites
 * without adding another full multi-gigabyte read.
 */
function vectorShardIdentity(filePath: string): VectorShardIdentity {
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error('Vector shard is not a file')
  const descriptor = fs.openSync(filePath, 'r')
  const hash = crypto.createHash('sha256')
  try {
    const headSize = Math.min(stat.size, VECTOR_SHARD_IDENTITY_WINDOW_BYTES)
    const tailOffset = Math.max(0, stat.size - VECTOR_SHARD_IDENTITY_WINDOW_BYTES)
    const tailSize = stat.size - tailOffset
    const head = Buffer.allocUnsafe(headSize)
    const tail = Buffer.allocUnsafe(tailSize)
    if (headSize > 0 && fs.readSync(descriptor, head, 0, headSize, 0) !== headSize) {
      throw new Error('Could not read vector shard identity head')
    }
    if (tailSize > 0 && fs.readSync(descriptor, tail, 0, tailSize, tailOffset) !== tailSize) {
      throw new Error('Could not read vector shard identity tail')
    }
    hash.update(String(stat.size))
    hash.update('\0')
    hash.update(head)
    hash.update('\0')
    hash.update(tail)
  } finally {
    fs.closeSync(descriptor)
  }
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    dev: stat.dev,
    ino: stat.ino,
    sampleSha256: hash.digest('hex'),
  }
}

function sameVectorShardIdentity(left: VectorShardIdentity, right: VectorShardIdentity): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.sampleSha256 === right.sampleSha256
  )
}

function pathKey(value: string): string {
  return path.resolve(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function parseRecognizedRow(line: string): RecognizedRow | undefined {
  try {
    const row = JSON.parse(line) as Partial<RecognizedRow>
    if (
      typeof row.imageId !== 'string' ||
      !row.imageId ||
      typeof row.modelName !== 'string' ||
      !row.modelName ||
      typeof row.embeddingType !== 'string' ||
      !row.embeddingType
    ) {
      return undefined
    }
    return row as RecognizedRow
  } catch {
    return undefined
  }
}

function validRow(row: RecognizedRow): ValidRow | undefined {
  if (
    !Number.isSafeInteger(row.dim) ||
    (row.dim as number) <= 0 ||
    (row.dim as number) > MAX_EMBEDDING_VECTOR_DIM ||
    !Array.isArray(row.vector) ||
    !validateEmbeddingVector(row.vector, row.dim as number).ok
  ) {
    return undefined
  }
  return row as ValidRow
}

function parseRow(line: string): ValidRow | undefined {
  const row = parseRecognizedRow(line)
  return row ? validRow(row) : undefined
}

async function scanShard(
  shardPath: string,
  activeKeys: Set<string>,
  options: VectorGcOptions = {},
): Promise<ScanState> {
  const sourceBytes = (await fs.promises.stat(shardPath)).size
  const preview: VectorGcShardPreview = {
    shardPath,
    sourceBytes,
    totalRecords: 0,
    activeRecords: 0,
    staleRecords: 0,
    duplicateRecords: 0,
    malformedRecords: 0,
    predictedBytes: 0,
    reclaimableBytes: 0,
  }
  const latestActiveRows = new Map<string, number>()
  const latestBytes = new Map<string, number>()
  const seenActiveKeys = new Set<string>()
  let bytesRead = 0
  const reader = readline.createInterface({
    input: fs.createReadStream(shardPath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
    crlfDelay: Infinity,
  })
  for await (const line of reader) {
    if (options.isCancelled?.()) throw new Error('Vector GC cancelled')
    bytesRead += Buffer.byteLength(line, 'utf8') + 1
    const rowIndex = preview.totalRecords++
    const recognized = parseRecognizedRow(line)
    const row = recognized ? validRow(recognized) : undefined
    if (!recognized) {
      preview.malformedRecords++
      continue
    }
    if (!preview.modelName) {
      const registryDim = isVisionModelName(recognized.modelName)
        ? getVisionModelCapability(recognized.modelName).dim
        : undefined
      if (!row || (registryDim !== undefined && recognized.dim !== registryDim)) {
        preview.malformedRecords++
        continue
      }
      preview.modelName = row.modelName
      preview.embeddingType = row.embeddingType
      preview.dim = row.dim
    } else if (
      recognized.modelName !== preview.modelName ||
      recognized.embeddingType !== preview.embeddingType
    ) {
      preview.malformedRecords++
      continue
    }
    const key = pathKey(recognized.imageId)
    if (!activeKeys.has(key)) {
      preview.staleRecords++
      continue
    }
    if (seenActiveKeys.has(key)) preview.duplicateRecords++
    seenActiveKeys.add(key)
    latestActiveRows.delete(key)
    latestBytes.delete(key)
    if (recognized.dim !== preview.dim || !row) {
      preview.malformedRecords++
      continue
    }
    latestActiveRows.set(key, rowIndex)
    latestBytes.set(key, Buffer.byteLength(line, 'utf8') + 1)
    if (preview.totalRecords % 1000 === 0) {
      options.onProgress?.(Math.min(sourceBytes, bytesRead), sourceBytes)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  preview.activeRecords = latestActiveRows.size
  preview.predictedBytes = [...latestBytes.values()].reduce((sum, bytes) => sum + bytes, 0)
  preview.reclaimableBytes = Math.max(0, sourceBytes - preview.predictedBytes)
  options.onProgress?.(sourceBytes, sourceBytes)
  return { preview, latestActiveRows }
}

export async function previewVectorGcShard(
  shardPath: string,
  activePaths: Iterable<string>,
  options: VectorGcOptions = {},
): Promise<VectorGcShardPreview> {
  const activeKeys = new Set([...activePaths].map(pathKey))
  return (await scanShard(shardPath, activeKeys, options)).preview
}

function vectorHash(vector: number[]): string {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(vector.length * 4)
  for (let index = 0; index < vector.length; index++) {
    buffer.writeFloatLE(vector[index], index * 4)
  }
  return hash.update(buffer).digest('hex')
}

function cosine(left: number[], right: number[]): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0
}

function sampleRanking(rows: ValidRow[]): string[] {
  if (rows.length === 0) return []
  const query = rows[0].vector
  return rows
    .map((row) => ({ key: pathKey(row.imageId), score: cosine(query, row.vector) }))
    .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key))
    .map((item) => item.key)
}

async function validateCompactedShard(
  filePath: string,
  expected: VectorGcShardPreview,
  expectedSamples: ValidRow[],
): Promise<void> {
  let records = 0
  const keys = new Set<string>()
  const samples: ValidRow[] = []
  const reader = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
    crlfDelay: Infinity,
  })
  for await (const line of reader) {
    const row = parseRow(line)
    if (
      !row ||
      row.modelName !== expected.modelName ||
      row.embeddingType !== expected.embeddingType ||
      row.dim !== expected.dim
    ) {
      throw new Error('Compacted vector shard failed schema validation')
    }
    const key = pathKey(row.imageId)
    if (keys.has(key)) throw new Error('Compacted vector shard contains duplicate image IDs')
    keys.add(key)
    records++
    if (samples.length < expectedSamples.length) samples.push(row)
  }
  if (records !== expected.activeRecords) {
    throw new Error(`Compacted vector shard count mismatch: ${records}/${expected.activeRecords}`)
  }
  const expectedHashes = expectedSamples.map((row) => vectorHash(row.vector))
  const actualHashes = samples.map((row) => vectorHash(row.vector))
  if (JSON.stringify(expectedHashes) !== JSON.stringify(actualHashes)) {
    throw new Error('Compacted vector shard sample hashes changed')
  }
  if (JSON.stringify(sampleRanking(expectedSamples)) !== JSON.stringify(sampleRanking(samples))) {
    throw new Error('Compacted vector shard sample ranking changed')
  }
}

export async function compactVectorGcShard(
  shardPath: string,
  activePaths: Iterable<string>,
  options: VectorGcOptions = {},
): Promise<{
  preview: VectorGcShardPreview
  backupPath: string
  actualBytes: number
}> {
  const resolved = path.resolve(shardPath)
  const activeKeys = new Set([...activePaths].map(pathKey))
  const sourceIdentity = vectorShardIdentity(resolved)
  const scan = await scanShard(resolved, activeKeys, options)
  if (!scan.preview.modelName || !scan.preview.dim || !scan.preview.embeddingType) {
    throw new Error('Vector shard contains no valid embedding rows')
  }
  const directory = path.dirname(resolved)
  const stamp = Date.now()
  const temporaryPath = `${resolved}.gc-${process.pid}-${stamp}.tmp`
  const backupPath = `${resolved}.gc-backup-${stamp}`
  const disk = fs.statfsSync(directory)
  const availableBytes = options.availableBytes ?? disk.bavail * disk.bsize
  if (availableBytes < scan.preview.predictedBytes + 16 * 1024 * 1024) {
    throw new Error('Not enough free space to build the compacted vector shard')
  }
  const writer = fs.createWriteStream(temporaryPath, { encoding: 'utf8', flags: 'wx' })
  const samples: ValidRow[] = []
  let rowIndex = 0
  let written = 0
  try {
    const reader = readline.createInterface({
      input: fs.createReadStream(resolved, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
      crlfDelay: Infinity,
    })
    for await (const line of reader) {
      if (options.isCancelled?.()) throw new Error('Vector GC cancelled')
      const row = parseRow(line)
      if (row && scan.latestActiveRows.get(pathKey(row.imageId)) === rowIndex) {
        if (!writer.write(`${line}\n`)) {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              writer.off('drain', onDrain)
              writer.off('error', onError)
            }
            const onDrain = () => {
              cleanup()
              resolve()
            }
            const onError = (error: Error) => {
              cleanup()
              reject(error)
            }
            writer.once('drain', onDrain)
            writer.once('error', onError)
          })
        }
        written += Buffer.byteLength(line, 'utf8') + 1
        if (samples.length < 32) samples.push(row)
      }
      rowIndex++
      if (rowIndex % 1000 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await new Promise<void>((resolve, reject) => {
      writer.end(resolve)
      writer.once('error', reject)
    })
    await validateCompactedShard(temporaryPath, scan.preview, samples)
    if ((await fs.promises.stat(temporaryPath)).size !== written) {
      throw new Error('Compacted vector shard byte count changed before switch')
    }
    await serializeEmbeddingShardMutation(async () => {
      const currentIdentity = vectorShardIdentity(resolved)
      if (!sameVectorShardIdentity(sourceIdentity, currentIdentity)) {
        throw new Error('Vector shard changed during compaction; retry after active appends finish')
      }
      const renameFile = options.renameFile || fs.promises.rename
      await renameFile(resolved, backupPath)
      try {
        await renameFile(temporaryPath, resolved)
      } catch (error) {
        await renameFile(backupPath, resolved)
        throw error
      }
    })
    return { preview: scan.preview, backupPath, actualBytes: written }
  } catch (error) {
    writer.destroy()
    try {
      await fs.promises.unlink(temporaryPath)
    } catch {
      /* temporary output may not exist */
    }
    throw error
  }
}

interface StoredVectorGcPreview {
  preview: VectorGcPreview
  activePaths: string[]
  shardPaths: string[]
}

const storedPreviews = new Map<string, StoredVectorGcPreview>()
let cancelRequested = false
let shuttingDown = false
let currentExecution: Promise<void> | null = null
let gcProgress: VectorGcProgress = {
  state: 'idle',
  completedShards: 0,
  totalShards: 0,
  freedBytes: 0,
  pendingReleaseBytes: 0,
  backups: 0,
  errors: [],
}

function gcId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function embeddingShardPaths(userDataPath: string): string[] {
  const directory = path.join(userDataPath, 'vector-db', 'embeddings')
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('__global.jsonl'))
      .map((entry) => path.join(directory, entry.name))
  } catch {
    return []
  }
}

async function readJsonlPathField(filePath: string, fieldName: string): Promise<string[]> {
  const values: string[] = []
  if (!fs.existsSync(filePath)) return values
  const reader = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
    crlfDelay: Infinity,
  })
  let lineNumber = 0
  for await (const line of reader) {
    lineNumber++
    if (!line) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      throw new Error(
        `Active-path authority is malformed: ${path.basename(filePath)} line ${lineNumber}`,
      )
    }
    const value = row[fieldName]
    if (typeof value === 'string' && value) values.push(value)
  }
  return values
}

async function supplementalActivePaths(userDataPath: string): Promise<string[]> {
  const mediaFrames = await readJsonlPathField(
    path.join(userDataPath, 'media-search', 'manifests', 'video_frames.jsonl'),
    'imagePath',
  )
  const legacyAssets = await readJsonlPathField(
    path.join(userDataPath, 'asset-library', 'assets.jsonl'),
    'path',
  )
  return [...mediaFrames, ...legacyAssets]
}

export async function previewVectorGc(
  userDataPath: string,
  imageIndexPath: string,
  options: VectorGcOptions = {},
): Promise<VectorGcPreview> {
  const index = await readImageIndexAssets(imageIndexPath, {
    isCancelled: options.isCancelled,
  })
  const activePaths = [
    ...index.assets.map((asset) => asset.path),
    ...(await supplementalActivePaths(userDataPath)),
  ]
  const shardPaths = embeddingShardPaths(userDataPath)
  const shards: VectorGcPreview['shards'] = []
  for (const shardPath of shardPaths) {
    const report = await previewVectorGcShard(shardPath, activePaths, options)
    shards.push({
      name: path.basename(shardPath),
      sourceBytes: report.sourceBytes,
      totalRecords: report.totalRecords,
      activeRecords: report.activeRecords,
      staleRecords: report.staleRecords,
      duplicateRecords: report.duplicateRecords,
      malformedRecords: report.malformedRecords,
      predictedBytes: report.predictedBytes,
      reclaimableBytes: report.reclaimableBytes,
      modelName: report.modelName,
      embeddingType: report.embeddingType,
      dim: report.dim,
    })
  }
  const preview: VectorGcPreview = {
    token: gcId('vector-gc-preview'),
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
    activeAssetCount: new Set(activePaths.map(pathKey)).size,
    shards,
    reclaimableBytes: shards.reduce((sum, shard) => sum + shard.reclaimableBytes, 0),
  }
  storedPreviews.clear()
  storedPreviews.set(preview.token, { preview, activePaths, shardPaths })
  await writeVectorGcEstimate(
    userDataPath,
    shardPaths.map((shardPath, index) => ({
      shardPath,
      reclaimableBytes: shards[index].reclaimableBytes,
      predictedBytes: shards[index].predictedBytes,
    })),
  )
  return preview
}

function updateGcProgress(update: Partial<VectorGcProgress>): void {
  gcProgress = { ...gcProgress, ...update, updatedAt: Date.now() }
}

async function executeVectorGc(stored: StoredVectorGcPreview): Promise<void> {
  for (let index = 0; index < stored.shardPaths.length; index++) {
    if (cancelRequested) {
      updateGcProgress({ state: 'cancelled', finishedAt: Date.now() })
      return
    }
    const shardPath = stored.shardPaths[index]
    updateGcProgress({ currentShard: path.basename(shardPath) })
    try {
      const result = await compactVectorGcShard(shardPath, stored.activePaths, {
        isCancelled: () => cancelRequested,
      })
      // The compacted shard no longer matches any increment anchor (the file
      // shrank), so the increment directory anchored on it is permanently
      // stale; remove it instead of leaving an orphan (D3 stage 2 rule).
      if (result.preview.modelName && result.preview.embeddingType) {
        const storeRoot = path.join(path.dirname(path.dirname(shardPath)), 'vector-store')
        discardEmbeddingIncrement(storeRoot, result.preview.modelName, result.preview.embeddingType)
      }
      const snapshotMetadata = {
        version: 1,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        source: path.basename(shardPath),
        backup: path.basename(result.backupPath),
        beforeBytes: result.preview.sourceBytes,
        afterBytes: result.actualBytes,
        activeRecords: result.preview.activeRecords,
      }
      await fs.promises.writeFile(
        `${result.backupPath}.json`,
        JSON.stringify(snapshotMetadata, null, 2),
        { encoding: 'utf8', flag: 'wx' },
      )
      updateGcProgress({
        completedShards: index + 1,
        pendingReleaseBytes:
          gcProgress.pendingReleaseBytes +
          Math.max(0, result.preview.sourceBytes - result.actualBytes),
        backups: gcProgress.backups + 1,
      })
    } catch (error: unknown) {
      if (cancelRequested) {
        updateGcProgress({ state: 'cancelled', finishedAt: Date.now() })
        return
      }
      updateGcProgress({
        state: 'error',
        finishedAt: Date.now(),
        errors: [
          ...gcProgress.errors,
          error instanceof Error ? error.message : String(error),
        ].slice(-20),
      })
      return
    }
  }
  updateGcProgress({ state: 'completed', currentShard: undefined, finishedAt: Date.now() })
}

export function startVectorGc(token: string): { ok: boolean; taskId?: string; error?: string } {
  if (shuttingDown) return { ok: false, error: 'Vector GC is shutting down' }
  if (gcProgress.state === 'running') return { ok: false, error: 'Vector GC is already running' }
  const stored = storedPreviews.get(token)
  if (!stored) return { ok: false, error: 'Vector GC preview is missing or invalid' }
  if (stored.preview.expiresAt < Date.now()) {
    storedPreviews.delete(token)
    return { ok: false, error: 'Vector GC preview expired; scan again' }
  }
  const taskId = gcId('vector-gc')
  cancelRequested = false
  gcProgress = {
    taskId,
    state: 'running',
    completedShards: 0,
    totalShards: stored.shardPaths.length,
    freedBytes: 0,
    pendingReleaseBytes: 0,
    backups: 0,
    errors: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  storedPreviews.delete(token)
  currentExecution = executeVectorGc(stored)
    .catch((error: unknown) => {
      updateGcProgress({
        state: 'error',
        finishedAt: Date.now(),
        errors: [error instanceof Error ? error.message : String(error)],
      })
    })
    .finally(() => {
      currentExecution = null
    })
  return { ok: true, taskId }
}

export function cancelVectorGc(): { ok: boolean } {
  if (gcProgress.state === 'running') cancelRequested = true
  return { ok: true }
}

export function getVectorGcProgress(): VectorGcProgress {
  return { ...gcProgress, errors: [...gcProgress.errors] }
}

export function isVectorGcRunning(): boolean {
  return gcProgress.state === 'running'
}

/** Drain the atomic shard handoff and recovery metadata before process exit. */
export async function shutdownVectorGc(): Promise<void> {
  shuttingDown = true
  cancelVectorGc()
  await currentExecution
}

export function resetVectorGcForTests(): void {
  if (currentExecution) throw new Error('Cannot reset an active Vector GC transaction')
  shuttingDown = false
  storedPreviews.clear()
  cancelRequested = false
  gcProgress = {
    state: 'idle',
    completedShards: 0,
    totalShards: 0,
    freedBytes: 0,
    pendingReleaseBytes: 0,
    backups: 0,
    errors: [],
  }
}
