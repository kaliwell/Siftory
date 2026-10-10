// ── Vector Database Service ────────────────────────────────
// Lightweight file-based storage for embeddings, crops, features.
// Uses JSON-lines + index files; no external SQLite dependency.
// Schema matches the spec: image_embeddings, embedding_jobs,
// object_crops, image_color_features, image_shape_features.

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type {
  EmbeddingEntry,
  EmbeddingJob,
  ObjectCropEntry,
  ColorFeature,
  ShapeFeature,
  EmbeddingType,
} from '../shared/vectorTypes'
import { selectRetainedEmbeddingJobs } from './embeddingLogRetention'
import { authoritativeVectorStoreRootFromCacheDir } from './authoritativeVectorStore'
import {
  appendEmbeddingIncrementRow,
  discardEmbeddingIncrementAsync,
  prepareEmbeddingIncrement,
  type EmbeddingIncrementContext,
} from './embeddingIncrementLog'
import { invalidateEmbeddingF16CacheMetadata } from './embeddingF16Cache'
import { requireNormalizedEmbeddingVector } from './embeddingVectorValidation'
import { getVisionModelCapability, isVisionModelName } from './modelRegistry'

// ── Paths ──────────────────────────────────────────────────

let dbDir = ''

function getDbDir(): string {
  if (!dbDir) {
    dbDir = path.join(app.getPath('userData'), 'vector-db')
  }
  return dbDir
}

/** Stable root for vector sidecars such as the source-invalidation outbox. */
export function getVectorDatabaseDir(): string {
  return getDbDir()
}

/** Shared Float16 embedding cache directory (authoritative store lives alongside it). */
export function getEmbeddingCacheDir(): string {
  return path.join(getDbDir(), 'embedding-cache')
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

// ── Generic JSON-lines store ──────────────────────────────

export interface VectorStorePersistenceStatus {
  filename: string
  pendingWrites: number
  lastWriteError?: string
  lastWriteErrorAt?: number
  lastSuccessfulWriteAt?: number
  unavailableError?: string
  unavailableAt?: number
  readOnly: boolean
  corruptedRows: number
}

export interface JsonLinesStoreDeferredSnapshot {
  serialized: string
  nextId: number
}

export interface DeferredJsonLinesStore {
  beginDeferredWrites(): Promise<JsonLinesStoreDeferredSnapshot>
  getDeferredSnapshotText(): string
  getPersistenceFilePath(): string
  commitDeferredWrites(): void
  rollbackDeferredWrites(snapshot: JsonLinesStoreDeferredSnapshot): void
  markUnavailable(error: unknown): void
}

export interface JsonLinesStoreOptions<T = unknown> {
  /** Single serialized line limit. Lines beyond this are corrupt on load and rejected on write. */
  maxLineBytes?: number
  /** Whole-file size limit. Exceeding it marks the store unavailable (fail-closed). */
  maxFileBytes?: number
  /** Record count limit. Exceeding it on load marks the store unavailable; writes that would exceed it are rejected. */
  maxRecords?: number
  /** Per-record field validator; returns an error message for invalid records, null when valid. */
  validate?: (record: unknown) => string | null
  /** Optional unique-key selector for O(1) point lookups. */
  uniqueKey?: (record: T) => string
}

const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024

export class JsonLinesStore<T extends { id?: number }> {
  private filename: string
  private getBaseDir: () => string
  private options: Required<Pick<JsonLinesStoreOptions<T>, 'maxLineBytes'>> &
    JsonLinesStoreOptions<T>
  private cache: T[] | null = null
  private uniqueIndex: Map<string, T> | null = null
  private nextId: number = 1
  private _saveMutex: Promise<void> = Promise.resolve()
  private pendingWrites = 0
  private lastWriteError: string | null = null
  private lastWriteErrorAt: number | null = null
  private lastSuccessfulWriteAt: number | null = null
  private unavailableError: string | null = null
  private unavailableAt: number | null = null
  private corruptedRows = 0
  private deferredWrites = false
  private memoryOnly = false

  /**
   * In memory-only mode mutations update the in-memory cache but never touch
   * the persistence file. Used when SQLite is the authoritative store and the
   * JSONL store acts as a read-through mirror.
   */
  setMemoryOnly(enabled: boolean): void {
    this.memoryOnly = enabled
  }

  constructor(
    filename: string,
    getBaseDir: () => string = getDbDir,
    options: JsonLinesStoreOptions<T> = {},
  ) {
    this.filename = filename
    this.getBaseDir = getBaseDir
    this.options = { maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, ...options }
  }

  private get filePath(): string {
    return path.join(this.getBaseDir(), this.filename)
  }

  private serializeSnapshot(): string {
    const records = this.cache || []
    return records.length > 0 ? `${records.map((r) => JSON.stringify(r)).join('\n')}\n` : ''
  }

  private writeSnapshot(lines: string): void {
    ensureDir(this.getBaseDir())
    const tmp = this.filePath + '.tmp'
    fs.writeFileSync(tmp, lines, 'utf-8')
    fs.renameSync(tmp, this.filePath)
  }

  private recordCorruptions(rows: Array<{ lineNumber: number; error: string; raw: string }>): void {
    if (rows.length === 0) return
    this.corruptedRows += rows.length
    try {
      const reportPath = `${this.filePath}.corruptions.jsonl`
      const detectedAt = Date.now()
      const output = rows
        .map((row) => JSON.stringify({ ...row, detectedAt, source: this.filename }))
        .join('\n')
      fs.appendFileSync(reportPath, `${output}\n`, 'utf-8')
    } catch {
      /* a read can still recover valid rows when the report cannot be written */
    }
  }

  private enqueueWrite(write: () => void, recoverySnapshot: () => string): void {
    const previous = this._saveMutex
    this.pendingWrites += 1
    const task = previous
      .catch(() => {})
      .then(() => {
        if (this.lastWriteError) this.writeSnapshot(recoverySnapshot())
        else write()
        this.lastWriteError = null
        this.lastWriteErrorAt = null
        this.lastSuccessfulWriteAt = Date.now()
      })
      .catch((error: unknown) => {
        this.lastWriteError = error instanceof Error ? error.message : String(error)
        this.lastWriteErrorAt = Date.now()
        throw error
      })
      .finally(() => {
        this.pendingWrites = Math.max(0, this.pendingWrites - 1)
      })
    this._saveMutex = task
    void task.catch(() => {})
  }

  private unavailableException(): Error {
    return new Error(
      `JSONL store ${this.filename} is unavailable and cannot be modified: ${this.unavailableError || 'unknown persistence error'}`,
    )
  }

  private assertWritable(): void {
    if (this.unavailableError) throw this.unavailableException()
    if (this.corruptedRows > 0) {
      throw new Error(
        `JSONL store ${this.filename} contains ${this.corruptedRows} malformed row(s); writing is disabled until the file is repaired`,
      )
    }
  }

  private load(): T[] {
    if (this.cache !== null) return this.cache
    if (this.unavailableError) throw this.unavailableException()
    try {
      ensureDir(this.getBaseDir())
      if (this.options.maxFileBytes !== undefined) {
        try {
          const size = fs.statSync(this.filePath).size
          if (size > this.options.maxFileBytes) {
            this.markUnavailable(
              `JSONL store ${this.filename} exceeds maxFileBytes (${size} > ${this.options.maxFileBytes})`,
            )
            throw this.unavailableException()
          }
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
        }
      }
      const lines = fs.readFileSync(this.filePath, 'utf-8').split('\n').filter(Boolean)
      const records: T[] = []
      const corruptions: Array<{ lineNumber: number; error: string; raw: string }> = []
      lines.forEach((line, index) => {
        try {
          if (Buffer.byteLength(line, 'utf8') > this.options.maxLineBytes) {
            throw new Error(`Line exceeds maxLineBytes (${this.options.maxLineBytes})`)
          }
          const parsed = JSON.parse(line) as unknown
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Expected a JSON object')
          }
          if (this.options.validate) {
            const validationError = this.options.validate(parsed)
            if (validationError) throw new Error(validationError)
          }
          records.push(parsed as T)
        } catch (error: unknown) {
          corruptions.push({
            lineNumber: index + 1,
            error: error instanceof Error ? error.message : String(error),
            raw: line.slice(0, 2048),
          })
        }
      })
      this.cache = records
      this.recordCorruptions(corruptions)
      if (this.options.maxRecords !== undefined && records.length > this.options.maxRecords) {
        this.markUnavailable(
          `JSONL store ${this.filename} exceeds maxRecords (${records.length} > ${this.options.maxRecords})`,
        )
        throw this.unavailableException()
      }
      for (const record of this.cache) {
        if (record.id !== undefined && record.id >= this.nextId) {
          this.nextId = record.id + 1
        }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.cache = []
      } else {
        if (!this.unavailableError) {
          const message = error instanceof Error ? error.message : String(error)
          this.markUnavailable(`Could not read ${this.filePath}: ${message}`)
        }
        throw this.unavailableException()
      }
    }
    return this.cache
  }

  private ensureUniqueIndex(): Map<string, T> | null {
    const selector = this.options.uniqueKey
    if (!selector) return null
    if (!this.uniqueIndex) {
      this.uniqueIndex = new Map(this.load().map((record) => [selector(record), record]))
    }
    return this.uniqueIndex
  }

  private assertRecordAllowed(record: unknown): void {
    if (this.options.validate) {
      const validationError = this.options.validate(record)
      if (validationError) {
        throw new Error(`JSONL store ${this.filename} rejected record: ${validationError}`)
      }
    }
    const lineBytes = Buffer.byteLength(JSON.stringify(record), 'utf8')
    if (lineBytes > this.options.maxLineBytes) {
      throw new Error(
        `JSONL store ${this.filename} rejected record: serialized line exceeds maxLineBytes (${lineBytes} > ${this.options.maxLineBytes})`,
      )
    }
  }

  private assertRecordCapacity(additional: number): void {
    if (this.options.maxRecords === undefined) return
    const current = this.load().length
    if (current + additional > this.options.maxRecords) {
      throw new Error(
        `JSONL store ${this.filename} rejected write: record count would exceed maxRecords (${current + additional} > ${this.options.maxRecords})`,
      )
    }
  }

  private save(): void {
    if (this.memoryOnly) return
    this.assertWritable()
    if (this.deferredWrites) {
      return
    }
    const snapshot = this.serializeSnapshot()
    this.enqueueWrite(
      () => this.writeSnapshot(snapshot),
      () => snapshot,
    )
  }

  getAll(): T[] {
    return [...this.load()]
  }

  getById(id: number): T | undefined {
    return this.load().find((r) => r.id === id)
  }

  getByUniqueKey(key: string): T | undefined {
    return this.ensureUniqueIndex()?.get(key)
  }

  insert(record: Omit<T, 'id'> & { id?: number }): T {
    const records = this.load()
    this.assertWritable()
    const rec = { ...record, id: record.id ?? this.nextId } as T
    this.assertRecordAllowed(rec)
    this.assertRecordCapacity(1)
    if (record.id === undefined) this.nextId++
    records.push(rec)
    this.cache = records
    if (this.uniqueIndex && this.options.uniqueKey) {
      this.uniqueIndex.set(this.options.uniqueKey(rec), rec)
    }
    this.append(rec)
    return rec
  }

  insertMany(newRecords: (Omit<T, 'id'> & { id?: number })[]): T[] {
    const records = this.load()
    this.assertWritable()
    const staged: T[] = []
    let stagedNextId = this.nextId
    for (const r of newRecords) {
      const rec = { ...r, id: r.id ?? stagedNextId } as T
      this.assertRecordAllowed(rec)
      if (r.id === undefined) stagedNextId++
      staged.push(rec)
    }
    this.assertRecordCapacity(staged.length)
    for (const rec of staged) records.push(rec)
    this.nextId = stagedNextId
    this.cache = records
    if (this.uniqueIndex && this.options.uniqueKey) {
      for (const rec of staged) this.uniqueIndex.set(this.options.uniqueKey(rec), rec)
    }
    this.save()
    return staged
  }

  replaceAll(newRecords: (Omit<T, 'id'> & { id?: number })[]): T[] {
    this.load()
    this.assertWritable()
    if (this.options.maxRecords !== undefined && newRecords.length > this.options.maxRecords) {
      throw new Error(
        `JSONL store ${this.filename} rejected write: record count would exceed maxRecords (${newRecords.length} > ${this.options.maxRecords})`,
      )
    }
    this.nextId = 1
    const result: T[] = []
    for (const record of newRecords) {
      const id = record.id ?? this.nextId
      const stored = { ...record, id } as T
      this.assertRecordAllowed(stored)
      result.push(stored)
      this.nextId = Math.max(this.nextId, id + 1)
    }
    this.cache = result
    this.uniqueIndex = null
    this.save()
    return [...result]
  }

  update(id: number, patch: Partial<T>): boolean {
    const records = this.load()
    this.assertWritable()
    const idx = records.findIndex((r) => r.id === id)
    if (idx === -1) return false
    const previous = records[idx]
    const updated = { ...records[idx], ...patch }
    this.assertRecordAllowed(updated)
    records[idx] = updated
    this.cache = records
    if (this.uniqueIndex && this.options.uniqueKey) {
      this.uniqueIndex.delete(this.options.uniqueKey(previous))
      this.uniqueIndex.set(this.options.uniqueKey(updated), updated)
    }
    this.save()
    return true
  }

  deleteById(id: number): boolean {
    const records = this.load()
    this.assertWritable()
    const idx = records.findIndex((r) => r.id === id)
    if (idx === -1) return false
    records.splice(idx, 1)
    this.cache = records
    this.uniqueIndex = null
    this.save()
    return true
  }

  deleteWhere(predicate: (r: T) => boolean): number {
    const records = this.load()
    this.assertWritable()
    const before = records.length
    this.cache = records.filter((r) => !predicate(r))
    const after = this.cache.length
    if (before !== after) {
      this.uniqueIndex = null
      this.save()
    }
    return before - after
  }

  find(predicate: (r: T) => boolean): T[] {
    return this.load().filter(predicate)
  }

  count(): number {
    return this.load().length
  }

  clear(): void {
    this.load()
    this.assertWritable()
    this.cache = []
    this.uniqueIndex = null
    this.save()
  }

  flush(): Promise<void> {
    return this._saveMutex
  }

  async beginDeferredWrites(): Promise<JsonLinesStoreDeferredSnapshot> {
    if (this.deferredWrites) throw new Error(`Deferred write already active for ${this.filename}`)
    await this.flush()
    this.load()
    this.assertWritable()
    this.deferredWrites = true
    return { serialized: this.serializeSnapshot(), nextId: this.nextId }
  }

  getDeferredSnapshotText(): string {
    if (!this.deferredWrites) throw new Error(`No deferred write active for ${this.filename}`)
    return this.serializeSnapshot()
  }

  getPersistenceFilePath(): string {
    return this.filePath
  }

  commitDeferredWrites(): void {
    if (!this.deferredWrites) throw new Error(`No deferred write active for ${this.filename}`)
    this.deferredWrites = false
    this.lastWriteError = null
    this.lastWriteErrorAt = null
    this.lastSuccessfulWriteAt = Date.now()
  }

  rollbackDeferredWrites(snapshot: JsonLinesStoreDeferredSnapshot): void {
    if (!this.deferredWrites) throw new Error(`No deferred write active for ${this.filename}`)
    const records = snapshot.serialized
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T)
    this.cache = records
    this.uniqueIndex = null
    this.nextId = snapshot.nextId
    this.deferredWrites = false
  }

  markUnavailable(error: unknown): void {
    this.unavailableError = error instanceof Error ? error.message : String(error)
    this.unavailableAt = Date.now()
  }

  getPersistenceStatus(): VectorStorePersistenceStatus {
    return {
      filename: this.filename,
      pendingWrites: this.pendingWrites,
      ...(this.lastWriteError ? { lastWriteError: this.lastWriteError } : {}),
      ...(this.lastWriteErrorAt ? { lastWriteErrorAt: this.lastWriteErrorAt } : {}),
      ...(this.lastSuccessfulWriteAt ? { lastSuccessfulWriteAt: this.lastSuccessfulWriteAt } : {}),
      ...(this.unavailableError ? { unavailableError: this.unavailableError } : {}),
      ...(this.unavailableAt ? { unavailableAt: this.unavailableAt } : {}),
      readOnly: !!this.unavailableError || this.corruptedRows > 0,
      corruptedRows: this.corruptedRows,
    }
  }

  reset(): void {
    this.cache = null
    this.uniqueIndex = null
    this.nextId = 1
    this.lastWriteError = null
    this.lastWriteErrorAt = null
    this.lastSuccessfulWriteAt = null
    this.unavailableError = null
    this.unavailableAt = null
    this.corruptedRows = 0
    this.deferredWrites = false
  }

  private append(record: T): void {
    if (this.memoryOnly) return
    this.assertWritable()
    if (this.deferredWrites) {
      return
    }
    const serializedRecord = JSON.stringify(record)
    this.enqueueWrite(
      () => {
        ensureDir(this.getBaseDir())
        fs.appendFileSync(this.filePath, `${serializedRecord}\n`, 'utf-8')
      },
      () => this.serializeSnapshot(),
    )
  }
}

// ── Stores ─────────────────────────────────────────────────

export const embeddingStore = new JsonLinesStore<EmbeddingEntry>('image_embeddings.jsonl')
export const jobStore = new JsonLinesStore<EmbeddingJob>('embedding_jobs.jsonl')
export const cropStore = new JsonLinesStore<ObjectCropEntry>('object_crops.jsonl')
export const colorFeatureStore = new JsonLinesStore<ColorFeature>(
  'image_color_features.jsonl',
  getDbDir,
  {
    uniqueKey: (feature) => feature.imageId,
  },
)
export const shapeFeatureStore = new JsonLinesStore<ShapeFeature>(
  'image_shape_features.jsonl',
  getDbDir,
  {
    uniqueKey: (feature) => feature.imageId,
  },
)

const vectorStores = [embeddingStore, jobStore, cropStore, colorFeatureStore, shapeFeatureStore]
let embeddingAppendChain: Promise<void> = Promise.resolve()

/**
 * Runs a short authoritative embedding-shard mutation in the same order as
 * vector appends. GC uses this only for its identity recheck and atomic switch:
 * appends accepted before the switch finish first, while later appends land in
 * the newly switched shard instead of the backup.
 */
export async function serializeEmbeddingShardMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const write = embeddingAppendChain.then(mutation)
  embeddingAppendChain = write.then(
    () => undefined,
    () => undefined,
  )
  return write
}

export function enforceEmbeddingJobRetention(now = Date.now()): {
  before: number
  kept: number
  removed: number
} {
  const jobs = jobStore.getAll()
  const retained = selectRetainedEmbeddingJobs(jobs, now)
  if (retained.length !== jobs.length) jobStore.replaceAll(retained)
  return { before: jobs.length, kept: retained.length, removed: jobs.length - retained.length }
}

export async function flushVectorDatabaseWrites(): Promise<void> {
  // Appends to the large per-model embedding shards do not flow through a
  // JsonLinesStore. Observe the append-chain identity and repeat when a writer
  // joined while this barrier was draining, so callers really get a quiescent
  // point for both storage families (GC/migration depend on this contract).
  for (;;) {
    const appendBarrier = embeddingAppendChain
    await Promise.all([appendBarrier, ...vectorStores.map((store) => store.flush())])
    if (
      appendBarrier === embeddingAppendChain &&
      vectorStores.every((store) => store.getPersistenceStatus().pendingWrites === 0)
    ) {
      return
    }
  }
}

export function getVectorDatabasePersistenceStatus(): VectorStorePersistenceStatus[] {
  return vectorStores.map((store) => store.getPersistenceStatus())
}

function sanitizeEmbeddingPathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96) || 'unknown'
}

export function getLegacyEmbeddingStorePath(): string {
  ensureDir(getDbDir())
  return path.join(getDbDir(), 'image_embeddings.jsonl')
}

export function getEmbeddingStorePath(
  modelName?: string,
  embeddingType: EmbeddingType = 'global',
): string {
  if (!modelName) return getLegacyEmbeddingStorePath()
  const dir = path.join(getDbDir(), 'embeddings')
  ensureDir(dir)
  const fileName = `${sanitizeEmbeddingPathPart(modelName)}__${sanitizeEmbeddingPathPart(
    embeddingType,
  )}.jsonl`
  return path.join(dir, fileName)
}

export function getEmbeddingStorePaths(
  modelName?: string,
  embeddingType: EmbeddingType = 'global',
): string[] {
  const paths: string[] = []
  // The legacy store predates per-model shards. Scan it first so a current
  // shard revision deterministically wins across files.
  const legacyPath = getLegacyEmbeddingStorePath()
  if (fs.existsSync(legacyPath)) paths.push(legacyPath)
  if (modelName) {
    const shardPath = getEmbeddingStorePath(modelName, embeddingType)
    if (fs.existsSync(shardPath)) paths.push(shardPath)
  }
  return [...new Set(paths)]
}

// ── D3 increment log double-write ─────────────────────────
// After the JSONL append, the same row is mirrored into the CURRENT
// generation's increment log (electron/embeddingIncrementLog.ts). The JSONL
// shard stays authoritative; any increment failure degrades to JSONL-only.

function prepareEmbeddingIncrementSafely(
  entry: Omit<EmbeddingEntry, 'id'>,
  targetPath: string,
): EmbeddingIncrementContext | null {
  try {
    return prepareEmbeddingIncrement(
      authoritativeVectorStoreRootFromCacheDir(getEmbeddingCacheDir()),
      entry.modelName,
      entry.embeddingType || 'global',
      targetPath,
    )
  } catch {
    return null
  }
}

function commitEmbeddingIncrementSafely(
  context: EmbeddingIncrementContext | null,
  entry: Omit<EmbeddingEntry, 'id'>,
  normalized: number[],
): void {
  if (!context) return
  try {
    appendEmbeddingIncrementRow(context, entry.imageId, normalized)
  } catch {
    /* The increment log is a subordinate copy; the JSONL append already landed. */
  }
}

function validateEmbeddingEntryVector(entry: Omit<EmbeddingEntry, 'id'>): number[] {
  const expectedDim = isVisionModelName(entry.modelName)
    ? getVisionModelCapability(entry.modelName).dim
    : entry.dim
  if (entry.dim !== expectedDim) {
    throw new Error(
      `Embedding dimension ${entry.dim} does not match ${entry.modelName} capability ${expectedDim}`,
    )
  }
  return requireNormalizedEmbeddingVector(entry.vector, expectedDim)
}

export function appendEmbeddingNoUpsert(entry: Omit<EmbeddingEntry, 'id'>): void {
  const normalized = validateEmbeddingEntryVector(entry)
  ensureDir(getDbDir())
  const targetPath = getEmbeddingStorePath(entry.modelName, entry.embeddingType || 'global')
  const increment = prepareEmbeddingIncrementSafely(entry, targetPath)
  fs.appendFileSync(
    targetPath,
    `${JSON.stringify({
      ...entry,
      vector: normalized,
      norm: 1.0,
      updatedAt: Date.now(),
    })}\n`,
    'utf-8',
  )
  commitEmbeddingIncrementSafely(increment, entry, normalized)
}

const GLOBAL_EMBEDDING_MODEL_BY_LAYER = {
  dino: 'dinov2_vitb14',
  clip: 'clip_vit_base_patch32',
} as const
const EMBEDDING_TOMBSTONE_BUILD_CHUNK_SIZE = 2_048
const MAX_EMBEDDING_TOMBSTONE_PATH_BYTES = 32 * 1024
const MAX_EMBEDDING_TOMBSTONE_APPEND_BYTES = 8 * 1024 * 1024

export type GlobalEmbeddingInvalidationLayer = keyof typeof GLOBAL_EMBEDDING_MODEL_BY_LAYER

export interface GlobalEmbeddingInvalidationShardAppend {
  modelName: (typeof GLOBAL_EMBEDDING_MODEL_BY_LAYER)[GlobalEmbeddingInvalidationLayer]
  filePath: string
  rows: number
  bytes: number
}

export interface GlobalEmbeddingInvalidationResult {
  requestedPaths: number
  uniquePaths: number
  appendedRows: number
  appendedBytes: number
  shards: GlobalEmbeddingInvalidationShardAppend[]
}

export class GlobalEmbeddingInvalidationError extends Error {
  constructor(
    message: string,
    readonly result: GlobalEmbeddingInvalidationResult,
  ) {
    super(message)
    this.name = 'GlobalEmbeddingInvalidationError'
  }
}

function embeddingTombstonePathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

async function uniqueEmbeddingTombstonePaths(imageIds: readonly string[]): Promise<string[]> {
  const unique = new Map<string, string>()
  for (let index = 0; index < imageIds.length; index++) {
    const imageId = typeof imageIds[index] === 'string' ? imageIds[index] : ''
    if (
      imageId.trim() &&
      !imageId.includes('\0') &&
      Buffer.byteLength(imageId, 'utf8') <= MAX_EMBEDDING_TOMBSTONE_PATH_BYTES
    ) {
      const key = embeddingTombstonePathKey(imageId)
      if (key && !unique.has(key)) unique.set(key, imageId)
    }
    if ((index + 1) % EMBEDDING_TOMBSTONE_BUILD_CHUNK_SIZE === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return [...unique.values()]
}

async function appendEmbeddingTombstones(
  modelName: GlobalEmbeddingInvalidationShardAppend['modelName'],
  filePath: string,
  imageIds: readonly string[],
): Promise<{ rows: number; bytes: number }> {
  let payload = ''
  let payloadBytes = 0
  let payloadRows = 0
  let rows = 0
  let bytes = 0
  const flush = async () => {
    if (!payload) return
    try {
      await fs.promises.appendFile(filePath, payload, 'utf8')
    } catch (error) {
      throw new EmbeddingTombstoneAppendError(
        `Could not append embedding tombstone chunk: ${
          error instanceof Error ? error.message : String(error)
        }`,
        rows,
        bytes,
        { cause: error },
      )
    }
    rows += payloadRows
    bytes += payloadBytes
    payload = ''
    payloadBytes = 0
    payloadRows = 0
  }
  for (let index = 0; index < imageIds.length; index++) {
    const line = `${JSON.stringify({
      modelName,
      embeddingType: 'global',
      imageId: imageIds[index],
      invalid: true,
    })}\n`
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (payload && payloadBytes + lineBytes > MAX_EMBEDDING_TOMBSTONE_APPEND_BYTES) {
      await flush()
    }
    payload += line
    payloadBytes += lineBytes
    payloadRows += 1
    if ((index + 1) % EMBEDDING_TOMBSTONE_BUILD_CHUNK_SIZE === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  await flush()
  return { rows, bytes }
}

class EmbeddingTombstoneAppendError extends Error {
  constructor(
    message: string,
    readonly appendedRows: number,
    readonly appendedBytes: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'EmbeddingTombstoneAppendError'
  }
}

/**
 * Serializes JSONL appends without blocking Electron's main event loop.
 * The chain also prevents concurrent appendFile calls from interleaving rows.
 * Each chain step appends the JSONL row first, then mirrors it into the
 * generation increment log and commits its delta.json (D3 double-write).
 */
export async function appendEmbeddingNoUpsertAsync(
  entry: Omit<EmbeddingEntry, 'id'>,
): Promise<void> {
  const normalized = validateEmbeddingEntryVector(entry)
  ensureDir(getDbDir())
  const targetPath = getEmbeddingStorePath(entry.modelName, entry.embeddingType || 'global')
  const line = `${JSON.stringify({
    ...entry,
    vector: normalized,
    norm: 1.0,
    updatedAt: Date.now(),
  })}\n`
  const write = embeddingAppendChain.then(async () => {
    const increment = prepareEmbeddingIncrementSafely(entry, targetPath)
    await fs.promises.appendFile(targetPath, line, 'utf8')
    commitEmbeddingIncrementSafely(increment, entry, normalized)
  })
  embeddingAppendChain = write.catch(() => {})
  await write
}

/**
 * Appends compact invalid latest revisions for paths removed from source data.
 * Existing DINO/CLIP global shards receive bounded bulk appends. Keeping this
 * work on embeddingAppendChain prevents a concurrent valid embedding append
 * from landing behind a tombstone that was requested later. The invalid row is
 * still recognizable by latest-wins readers, which claim its path before
 * vector validation and therefore cannot resurrect an older valid revision.
 * It is deliberately not mirrored into the valid-vector-only D3 increment:
 * growth of the authoritative JSONL source makes that increment incomplete,
 * so strict readers and the next writer must revalidate instead of serving it
 * as a fresh snapshot.
 */
export async function appendGlobalEmbeddingInvalidationTombstonesAsync(
  imageIds: readonly string[],
  layers: readonly GlobalEmbeddingInvalidationLayer[] = ['dino', 'clip'],
): Promise<GlobalEmbeddingInvalidationResult> {
  const requestedImageIds = [...imageIds]
  const selectedTargets: Array<{
    modelName: GlobalEmbeddingInvalidationShardAppend['modelName']
    filePath: string
  }> = []
  const selectedModels = new Set<string>()
  for (const layer of layers) {
    if (layer !== 'dino' && layer !== 'clip') continue
    const modelName = GLOBAL_EMBEDDING_MODEL_BY_LAYER[layer]
    if (selectedModels.has(modelName)) continue
    selectedModels.add(modelName)
    selectedTargets.push({
      modelName,
      filePath: getEmbeddingStorePath(modelName, 'global'),
    })
  }

  const write = embeddingAppendChain.then(async (): Promise<GlobalEmbeddingInvalidationResult> => {
    const uniquePaths = await uniqueEmbeddingTombstonePaths(requestedImageIds)
    const shards: GlobalEmbeddingInvalidationShardAppend[] = []
    const failures: string[] = []
    const cacheDir = getEmbeddingCacheDir()
    const vectorStoreRoot = authoritativeVectorStoreRootFromCacheDir(cacheDir)
    if (uniquePaths.length > 0) {
      for (const target of selectedTargets) {
        try {
          // A current per-model shard may legitimately be absent on upgraded
          // installations whose only rows live in image_embeddings.jsonl.
          // Creating a compact tombstone-only shard is required so its newer
          // source order can mask those legacy rows.
          const appended = await appendEmbeddingTombstones(
            target.modelName,
            target.filePath,
            uniquePaths,
          )
          if (appended.rows > 0) {
            shards.push({
              ...target,
              rows: appended.rows,
              bytes: appended.bytes,
            })
          }
        } catch (error) {
          if (error instanceof EmbeddingTombstoneAppendError && error.appendedRows > 0) {
            shards.push({
              ...target,
              rows: error.appendedRows,
              bytes: error.appendedBytes,
            })
          }
          failures.push(
            `${target.modelName}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        const invalidations = await Promise.allSettled([
          discardEmbeddingIncrementAsync(vectorStoreRoot, target.modelName, 'global'),
          invalidateEmbeddingF16CacheMetadata(cacheDir, target.modelName, 'global'),
        ])
        for (const invalidation of invalidations) {
          if (invalidation.status === 'rejected') {
            failures.push(
              `${target.modelName}: ${
                invalidation.reason instanceof Error
                  ? invalidation.reason.message
                  : String(invalidation.reason)
              }`,
            )
          }
        }
      }
    }
    const result = {
      requestedPaths: requestedImageIds.length,
      uniquePaths: uniquePaths.length,
      appendedRows: shards.reduce((sum, shard) => sum + shard.rows, 0),
      appendedBytes: shards.reduce((sum, shard) => sum + shard.bytes, 0),
      shards,
    }
    if (failures.length > 0) {
      throw new GlobalEmbeddingInvalidationError(
        `Global embedding invalidation was incomplete: ${failures.join('; ')}`,
        result,
      )
    }
    return result
  })
  embeddingAppendChain = write.then(
    () => undefined,
    () => undefined,
  )
  return write
}

function readEmbeddingEntriesByModel(
  modelName: string,
  embeddingType?: EmbeddingType,
  imageId?: string,
): EmbeddingEntry[] {
  const paths = getEmbeddingStorePaths(modelName, embeddingType || 'global')
  const out: EmbeddingEntry[] = []
  const modelNeedle = `"modelName":${JSON.stringify(modelName)}`
  const typeNeedle = embeddingType ? `"embeddingType":${JSON.stringify(embeddingType)}` : ''
  for (const filePath of paths) {
    let lines: string[]
    try {
      lines = fs.readFileSync(filePath, 'utf-8').split('\n')
    } catch {
      continue
    }
    for (const line of lines) {
      if (!line || !line.includes(modelNeedle)) continue
      if (typeNeedle && !line.includes(typeNeedle)) continue
      if (imageId && !line.includes(JSON.stringify(imageId))) continue
      try {
        const entry = JSON.parse(line) as EmbeddingEntry
        if (entry.modelName !== modelName) continue
        if (embeddingType && entry.embeddingType !== embeddingType) continue
        if (imageId && entry.imageId !== imageId) continue
        out.push(entry)
      } catch {
        /* skip malformed embedding row */
      }
    }
  }
  return out
}

// ── High-level operations ─────────────────────────────────

/** Get embedding for an image by imageId, model, and type. */
export function getEmbedding(
  imageId: string,
  modelName: string,
  embeddingType: EmbeddingType = 'global',
): EmbeddingEntry | undefined {
  return readEmbeddingEntriesByModel(modelName, embeddingType, imageId).at(-1)
}

/** Get all embeddings for a given model. */
export function getEmbeddingsByModel(
  modelName: string,
  embeddingType?: EmbeddingType,
): EmbeddingEntry[] {
  return readEmbeddingEntriesByModel(modelName, embeddingType)
}

/** Upsert an embedding (replace if same imageId+model+type exists). */
export function upsertEmbedding(entry: Omit<EmbeddingEntry, 'id'>): EmbeddingEntry {
  const normalized = validateEmbeddingEntryVector(entry)
  const existing = getEmbedding(entry.imageId, entry.modelName, entry.embeddingType)

  if (existing && existing.id !== undefined) {
    embeddingStore.update(existing.id, {
      ...entry,
      vector: normalized,
      norm: 1.0,
      updatedAt: Date.now(),
    })
    const updated = embeddingStore.getById(existing.id)
    return updated!
  }
  return embeddingStore.insert({
    ...entry,
    vector: normalized,
    norm: 1.0,
    updatedAt: Date.now(),
  })
}

/** Get color feature by imageId. */
export function getColorFeature(imageId: string): ColorFeature | undefined {
  return colorFeatureStore.getByUniqueKey(imageId)
}

/** Upsert color feature. */
export function upsertColorFeature(feature: Omit<ColorFeature, 'id'>): ColorFeature {
  const existing = colorFeatureStore.getByUniqueKey(feature.imageId)
  if (existing && existing.id !== undefined) {
    colorFeatureStore.update(existing.id, { ...feature, updatedAt: Date.now() })
    return colorFeatureStore.getById(existing.id)!
  }
  return colorFeatureStore.insert({ ...feature, updatedAt: Date.now() })
}

/** Get shape feature by imageId. */
export function getShapeFeature(imageId: string): ShapeFeature | undefined {
  return shapeFeatureStore.getByUniqueKey(imageId)
}

/** Upsert shape feature. */
export function upsertShapeFeature(feature: Omit<ShapeFeature, 'id'>): ShapeFeature {
  const existing = shapeFeatureStore.getByUniqueKey(feature.imageId)
  if (existing && existing.id !== undefined) {
    shapeFeatureStore.update(existing.id, { ...feature, updatedAt: Date.now() })
    return shapeFeatureStore.getById(existing.id)!
  }
  return shapeFeatureStore.insert({ ...feature, updatedAt: Date.now() })
}

/** Remove all data related to a deleted/replaced image. */
export function removeImageData(imageId: string): void {
  removeImageDataBatch([imageId])
}

/** Remove a committed scan chunk with one rewrite per store instead of one rewrite per image. */
export function removeImageDataBatch(imageIds: readonly string[]): number {
  const selected = new Set(
    imageIds
      .filter(
        (imageId): imageId is string => typeof imageId === 'string' && imageId.trim().length > 0,
      )
      .map(embeddingTombstonePathKey)
      .filter(Boolean),
  )
  if (selected.size === 0) return 0
  const matches = (candidate: unknown) =>
    typeof candidate === 'string' && selected.has(embeddingTombstonePathKey(candidate))
  return (
    embeddingStore.deleteWhere((entry) => matches(entry.imageId)) +
    jobStore.deleteWhere((entry) => matches(entry.imageId) || matches(entry.path)) +
    cropStore.deleteWhere((entry) => matches(entry.imageId)) +
    colorFeatureStore.deleteWhere((entry) => matches(entry.imageId)) +
    shapeFeatureStore.deleteWhere((entry) => matches(entry.imageId))
  )
}

function vectorDataPathKey(value: string): string {
  const raw = String(value || '')
    .trim()
    .replace(/\//g, '\\')
  if (!raw) return ''
  const absolute =
    /^[a-zA-Z]:/.test(raw) || raw.startsWith('\\\\')
      ? path.win32.resolve(raw)
      : path.resolve(raw).replace(/\//g, '\\')
  const normalized = absolute.toLowerCase()
  if (/^[a-z]:\\$/.test(normalized)) return normalized
  return normalized.replace(/\\+$/, '')
}

function vectorDataPathIsWithin(candidate: string, folderKey: string): boolean {
  const candidateKey = vectorDataPathKey(candidate)
  if (!candidateKey || !folderKey) return false
  if (candidateKey === folderKey) return true
  return folderKey.endsWith('\\')
    ? candidateKey.startsWith(folderKey)
    : candidateKey.startsWith(`${folderKey}\\`)
}

/**
 * Removes small/legacy vector stores and embedding job rows for a folder.
 * Multi-gigabyte model shards are handled by imageSearchFolderDataService;
 * loading those through JsonLinesStore would exhaust memory.
 */
export async function removeImageDataFolder(
  folder: string,
  layers: readonly ('native' | 'dino' | 'clip')[],
): Promise<{ removed: number; embeddings: number; jobs: number; features: number }> {
  return removeImageDataFolders([folder], layers)
}

/** Batch form used by source-scoped video cleanup so thousands of frame
 * directories require one in-memory pass and one persistence flush. */
export async function removeImageDataFolders(
  folders: readonly string[],
  layers: readonly ('native' | 'dino' | 'clip')[],
): Promise<{ removed: number; embeddings: number; jobs: number; features: number }> {
  const selected = new Set(layers)
  const folderKeys = [...new Set(folders.map(vectorDataPathKey).filter(Boolean))]
  if (folderKeys.length === 0) {
    return { removed: 0, embeddings: 0, jobs: 0, features: 0 }
  }
  const isWithinSelectedFolder = (candidate: string): boolean =>
    folderKeys.some((folderKey) => vectorDataPathIsWithin(candidate, folderKey))
  const selectedModel = (modelName: string): boolean => {
    const lowered = String(modelName || '').toLowerCase()
    return (
      (selected.has('dino') && lowered.includes('dino')) ||
      (selected.has('clip') && lowered.includes('clip'))
    )
  }
  const embeddings = embeddingStore.deleteWhere(
    (entry) => selectedModel(entry.modelName) && isWithinSelectedFolder(entry.imageId),
  )
  const jobs = jobStore.deleteWhere(
    (entry) =>
      selectedModel(entry.modelName) &&
      (isWithinSelectedFolder(entry.imageId) || isWithinSelectedFolder(entry.path)),
  )
  let features = 0
  if (selected.has('native')) {
    features += cropStore.deleteWhere((entry) => isWithinSelectedFolder(entry.imageId))
    features += colorFeatureStore.deleteWhere((entry) => isWithinSelectedFolder(entry.imageId))
    features += shapeFeatureStore.deleteWhere((entry) => isWithinSelectedFolder(entry.imageId))
  }
  await flushVectorDatabaseWrites()
  return { removed: embeddings + jobs + features, embeddings, jobs, features }
}

/** Purge all embeddings for a specific model (for model upgrade/reinstall). */
export function purgeModelEmbeddings(modelName: string): number {
  return embeddingStore.deleteWhere((e) => e.modelName === modelName)
}

/** Remove vector/feature data for images whose files no longer exist on disk. */
export function cleanupOrphanVectorData(): { embeddings: number; jobs: number; features: number } {
  const isOrphan = (imageId: string): boolean => {
    try {
      return !fs.existsSync(imageId)
    } catch {
      return true
    }
  }
  const orphanEmbeddingIds = new Set(
    embeddingStore
      .getAll()
      .map((entry) => entry.imageId)
      .filter(isOrphan),
  )
  const orphanJobIds = new Set(
    jobStore
      .getAll()
      .map((entry) => entry.imageId)
      .filter(isOrphan),
  )
  const orphanFeatureIds = new Set(
    [...colorFeatureStore.getAll(), ...shapeFeatureStore.getAll()]
      .map((entry) => entry.imageId)
      .filter(isOrphan),
  )

  const embeddings = embeddingStore.deleteWhere((entry) => orphanEmbeddingIds.has(entry.imageId))
  const jobs = jobStore.deleteWhere((entry) => orphanJobIds.has(entry.imageId))
  const colorFeatures = colorFeatureStore.deleteWhere((entry) =>
    orphanFeatureIds.has(entry.imageId),
  )
  const shapeFeatures = shapeFeatureStore.deleteWhere((entry) =>
    orphanFeatureIds.has(entry.imageId),
  )

  return { embeddings, jobs, features: colorFeatures + shapeFeatures }
}

// ── Init ───────────────────────────────────────────────────

export function initVectorDatabase(userDataPath?: string): void {
  if (userDataPath) {
    const nextDbDir = path.join(userDataPath, 'vector-db')
    if (dbDir && dbDir !== nextDbDir) {
      const pendingStore = vectorStores.find(
        (store) => store.getPersistenceStatus().pendingWrites > 0,
      )
      if (pendingStore) {
        throw new Error(
          `Cannot change vector database directory while ${pendingStore.getPersistenceStatus().filename} has pending writes`,
        )
      }
      vectorStores.forEach((store) => store.reset())
    }
    dbDir = nextDbDir
  }
  ensureDir(getDbDir())
}
