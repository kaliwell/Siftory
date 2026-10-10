import crypto from 'node:crypto'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import type { AssetLibraryListRequest, AssetRecord } from '../shared/ipc/asset-library'
import { AssetCatalogProjection } from './assetCatalogProjection'
import {
  recoverAssetMetadataTransaction,
  runAssetMetadataTransaction,
} from './assetMetadataTransaction'
import type { ImageIndexAssetSourceRecord } from './imageIndexAssetSource'

interface AssetMetadataState {
  nextId: number
  lastSyncAt?: number
  sourceManifest?: string
}

interface AssetArchiveEntry {
  path: string
  archivedAt: number
}

export interface AssetMetadataSyncResult {
  added: number
  updated: number
  missing: number
  total: number
  lastSyncAt: number
  sourceManifest: string
}

export interface ManualAssetVerificationResult {
  checked: number
  updated: number
  missing: number
  changedAssetIds: number[]
}

export interface AssetMetadataPersistenceStatus {
  state: 'ready' | 'read_only' | 'unavailable'
  corruptRows: number
  error?: string
}

const DEFAULT_STATE: AssetMetadataState = { nextId: 1 }
const MANUAL_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.svg',
  '.avif',
  '.ico',
  '.tiff',
  '.tif',
  '.psd',
])

function pathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function isCancellationError(error: unknown): boolean {
  return /cancelled/i.test(errorMessage(error))
}

function archiveSnapshotContents(archivedByPath: ReadonlyMap<string, AssetArchiveEntry>): string {
  const entries = [...archivedByPath.values()]
    .map((entry) => ({ ...entry }))
    .sort((a, b) => a.path.localeCompare(b.path))
  return JSON.stringify({ version: 1, entries })
}

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await fs.promises.open(directoryPath, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is unavailable on some Windows filesystems.
  }
}

async function writeLine(stream: fs.WriteStream, line: string): Promise<void> {
  if (stream.write(line)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener('drain', onDrain)
      stream.removeListener('error', onError)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    stream.once('drain', onDrain)
    stream.once('error', onError)
  })
}

async function destroyWriteStream(stream: fs.WriteStream): Promise<void> {
  if (stream.closed) return
  stream.destroy()
  await new Promise<void>((resolve) => stream.once('close', resolve))
}

interface RankedAssetRecord {
  record: AssetRecord
  name: string
}

function compareRankedAssets(
  left: RankedAssetRecord,
  right: RankedAssetRecord,
  sort: 'updated_desc' | 'name_asc' | 'size_desc',
): number {
  if (sort === 'name_asc') {
    return (
      left.name.localeCompare(right.name) ||
      left.record.path.localeCompare(right.record.path) ||
      left.record.id - right.record.id
    )
  }
  if (sort === 'size_desc') {
    return (
      right.record.fileSize - left.record.fileSize ||
      right.record.updatedAt - left.record.updatedAt ||
      right.record.id - left.record.id
    )
  }
  return right.record.updatedAt - left.record.updatedAt || right.record.id - left.record.id
}

function pushBoundedBest(
  heap: RankedAssetRecord[],
  candidate: RankedAssetRecord,
  limit: number,
  compare: (left: RankedAssetRecord, right: RankedAssetRecord) => number,
): void {
  if (limit <= 0) return
  if (heap.length < limit) {
    heap.push(candidate)
    let index = heap.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (compare(heap[index], heap[parent]) <= 0) break
      ;[heap[index], heap[parent]] = [heap[parent], heap[index]]
      index = parent
    }
    return
  }
  if (compare(candidate, heap[0]) >= 0) return
  heap[0] = candidate
  let index = 0
  for (;;) {
    const left = index * 2 + 1
    if (left >= heap.length) break
    const right = left + 1
    const worseChild = right < heap.length && compare(heap[right], heap[left]) > 0 ? right : left
    if (compare(heap[worseChild], heap[index]) <= 0) break
    ;[heap[index], heap[worseChild]] = [heap[worseChild], heap[index]]
    index = worseChild
  }
}

export class AssetMetadataStore {
  private readonly baseDir: string
  private readonly filePath: string
  private readonly statePath: string
  private readonly archivePath: string
  private readonly catalog: AssetCatalogProjection
  private readonly records = new Map<number, AssetRecord>()
  private readonly idsByPath = new Map<string, number>()
  private readonly archivedByPath = new Map<string, AssetArchiveEntry>()
  private state: AssetMetadataState = { ...DEFAULT_STATE }
  private loadPromise: Promise<void> | null = null
  private writeMutex: Promise<void> = Promise.resolve()
  private archiveWriteMutex: Promise<void> = Promise.resolve()
  private catalogQueue: Promise<void> = Promise.resolve()
  private catalogGeneration = 0
  private catalogReady = false
  private corruptRows = 0
  private readOnlyReason = ''
  private unavailableReason = ''

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.filePath = path.join(baseDir, 'assets.jsonl')
    this.statePath = path.join(baseDir, 'state.json')
    this.archivePath = path.join(baseDir, 'archived-assets.json')
    this.catalog = new AssetCatalogProjection(path.join(baseDir, 'asset-catalog.sqlite'))
  }

  private async sourceFingerprint(
    records: ReadonlyMap<number, AssetRecord> = this.records,
    state: Readonly<AssetMetadataState> = this.state,
  ): Promise<string> {
    const fileFingerprint = async (filePath: string): Promise<string> => {
      try {
        const stat = await fs.promises.stat(filePath)
        return `${stat.size}:${Math.round(stat.mtimeMs * 1000)}`
      } catch {
        return 'missing'
      }
    }
    const [assets, stateFile, archive] = await Promise.all([
      fileFingerprint(this.filePath),
      fileFingerprint(this.statePath),
      fileFingerprint(this.archivePath),
    ])
    return [
      'asset-catalog-v1',
      records.size,
      state.nextId,
      state.lastSyncAt || 0,
      state.sourceManifest || '',
      assets,
      stateFile,
      archive,
    ].join('|')
  }

  private queueCatalogRebuild(
    records: ReadonlyMap<number, AssetRecord> = this.records,
    state: Readonly<AssetMetadataState> = this.state,
  ): Promise<void> {
    const generation = ++this.catalogGeneration
    this.catalogReady = false
    const run = async () => {
      const fingerprint = await this.sourceFingerprint(records, state)
      try {
        await this.catalog.replaceAll(records, fingerprint)
      } catch (error) {
        try {
          this.catalog.resetStorage()
          await this.catalog.replaceAll(records, fingerprint)
        } catch (retryError) {
          console.warn('[NekoSearch] SQLite catalog rebuild failed:', errorMessage(retryError))
          return
        }
      }
      if (generation === this.catalogGeneration) this.catalogReady = true
    }
    const pending = this.catalogQueue.catch(() => {}).then(run)
    this.catalogQueue = pending.catch((error) => {
      console.warn('[NekoSearch] SQLite catalog queue failed:', errorMessage(error))
    })
    return this.catalogQueue
  }

  private queueCatalogUpdate(records: readonly AssetRecord[]): Promise<void> {
    const generation = ++this.catalogGeneration
    const canPatch = this.catalogReady
    this.catalogReady = false
    const run = async () => {
      const fingerprint = await this.sourceFingerprint()
      try {
        const patched =
          canPatch && this.catalog.updateRecords(records, fingerprint, this.records.size)
        if (!patched) await this.catalog.replaceAll(this.records, fingerprint)
      } catch (error) {
        console.warn('[NekoSearch] SQLite catalog update failed:', errorMessage(error))
        return
      }
      if (generation === this.catalogGeneration) this.catalogReady = true
    }
    const pending = this.catalogQueue.catch(() => {}).then(run)
    this.catalogQueue = pending.catch((error) => {
      console.warn('[NekoSearch] SQLite catalog update queue failed:', errorMessage(error))
    })
    return this.catalogQueue
  }

  private async initializeCatalog(): Promise<void> {
    const fingerprint = await this.sourceFingerprint()
    try {
      if (this.catalog.isFresh(fingerprint, this.records.size)) {
        this.catalogReady = true
        return
      }
    } catch (error) {
      console.warn('[NekoSearch] SQLite catalog validation failed:', errorMessage(error))
      try {
        this.catalog.resetStorage()
      } catch {
        /* the in-memory listing remains available when the cache cannot be reset */
      }
    }
    void this.queueCatalogRebuild()
  }

  private async loadArchive(): Promise<void> {
    this.archivedByPath.clear()
    let raw: string
    try {
      raw = await fs.promises.readFile(this.archivePath, 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) return
      throw new Error(`Could not read archived-assets.json: ${errorMessage(error)}`, {
        cause: error,
      })
    }
    let parsed: { entries?: unknown }
    try {
      parsed = JSON.parse(raw) as { entries?: unknown }
    } catch (error) {
      throw new Error(`Invalid archived-assets.json: ${errorMessage(error)}`, { cause: error })
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      throw new Error('Invalid archived-assets.json: entries must be an array')
    }
    for (const value of parsed.entries) {
      if (!value || typeof value !== 'object') {
        throw new Error('Invalid archived-assets.json: every entry must be an object')
      }
      const entry = value as Partial<AssetArchiveEntry>
      if (typeof entry.path !== 'string' || !entry.path.trim() || entry.path.includes('\0')) {
        throw new Error('Invalid archived-assets.json: every entry requires a valid path')
      }
      if (
        entry.archivedAt !== undefined &&
        (typeof entry.archivedAt !== 'number' || !Number.isFinite(entry.archivedAt))
      ) {
        throw new Error('Invalid archived-assets.json: archivedAt must be a finite number')
      }
      const key = pathKey(entry.path)
      if (this.archivedByPath.has(key)) {
        throw new Error(`Invalid archived-assets.json: duplicate path ${entry.path}`)
      }
      this.archivedByPath.set(key, {
        path: entry.path,
        archivedAt: entry.archivedAt ?? Date.now(),
      })
    }
    for (const record of this.records.values()) {
      record.archived = false
      delete record.archivedAt
      const entry = this.archivedByPath.get(pathKey(record.path))
      if (entry) {
        record.archived = true
        record.archivedAt = entry.archivedAt
      }
    }
  }

  private async persistArchiveSnapshot(
    archivedByPath: ReadonlyMap<string, AssetArchiveEntry>,
  ): Promise<void> {
    this.assertWritable()
    const contents = archiveSnapshotContents(archivedByPath)
    const run = async () => {
      this.assertWritable()
      await fs.promises.mkdir(this.baseDir, { recursive: true })
      const temporaryPath = `${this.archivePath}.tmp`
      let handle: fs.promises.FileHandle | undefined
      try {
        await fs.promises.unlink(temporaryPath).catch(() => {})
        handle = await fs.promises.open(temporaryPath, 'wx')
        await handle.writeFile(contents, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await fs.promises.rename(temporaryPath, this.archivePath)
        await syncDirectory(this.baseDir)
      } catch (error) {
        await handle?.close().catch(() => {})
        await fs.promises.unlink(temporaryPath).catch(() => {})
        throw this.markUnavailable(error, 'Asset archive persistence failed')
      }
    }
    const pending = this.archiveWriteMutex.catch(() => {}).then(run)
    this.archiveWriteMutex = pending
    await pending
  }

  private async load(): Promise<void> {
    await fs.promises.mkdir(this.baseDir, { recursive: true })
    recoverAssetMetadataTransaction(this.baseDir)
    this.records.clear()
    this.idsByPath.clear()
    this.corruptRows = 0
    this.readOnlyReason = ''
    let rawState: unknown
    let hasStateFile = false
    try {
      rawState = JSON.parse(await fs.promises.readFile(this.statePath, 'utf8'))
      hasStateFile = true
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw new Error(`Invalid state.json: ${errorMessage(error)}`, { cause: error })
      }
    }
    if (!hasStateFile) {
      this.state = { ...DEFAULT_STATE }
    } else {
      if (!rawState || typeof rawState !== 'object') {
        throw new Error('Invalid state.json: expected an object')
      }
      const stateValue = rawState as Partial<AssetMetadataState>
      const nextId = stateValue.nextId
      if (typeof nextId !== 'number' || !Number.isInteger(nextId) || nextId < 1) {
        throw new Error('Invalid state.json: nextId must be a positive integer')
      }
      if (
        stateValue.lastSyncAt !== undefined &&
        (typeof stateValue.lastSyncAt !== 'number' ||
          !Number.isFinite(stateValue.lastSyncAt) ||
          stateValue.lastSyncAt < 0)
      ) {
        throw new Error('Invalid state.json: lastSyncAt must be a non-negative finite number')
      }
      if (
        stateValue.sourceManifest !== undefined &&
        typeof stateValue.sourceManifest !== 'string'
      ) {
        throw new Error('Invalid state.json: sourceManifest must be a string')
      }
      this.state = {
        nextId,
        ...(stateValue.lastSyncAt !== undefined ? { lastSyncAt: stateValue.lastSyncAt } : {}),
        ...(stateValue.sourceManifest !== undefined
          ? { sourceManifest: stateValue.sourceManifest }
          : {}),
      }
    }

    let assetFileStat: fs.Stats | null = null
    try {
      assetFileStat = await fs.promises.lstat(this.filePath)
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw new Error(`Could not inspect assets.jsonl: ${errorMessage(error)}`, { cause: error })
      }
    }
    if (!assetFileStat) {
      await this.loadArchive()
      await this.initializeCatalog()
      return
    }
    if (!assetFileStat.isFile() || assetFileStat.isSymbolicLink()) {
      throw new Error('Invalid assets.jsonl: expected a regular file')
    }
    const input = fs.createReadStream(this.filePath, { encoding: 'utf8' })
    const lines = readline.createInterface({ input, crlfDelay: Infinity })
    let row = 0
    for await (const line of lines) {
      row += 1
      if (!line) continue
      try {
        const record = JSON.parse(line) as AssetRecord
        if (!Number.isInteger(record.id) || record.id <= 0) {
          throw new Error('Asset id must be a positive integer')
        }
        if (typeof record.path !== 'string' || !record.path.trim() || record.path.includes('\0')) {
          throw new Error('Asset path must be a non-empty string without null bytes')
        }
        const key = pathKey(record.path)
        if (this.records.has(record.id)) throw new Error(`Duplicate asset id ${record.id}`)
        if (this.idsByPath.has(key)) throw new Error(`Duplicate asset path ${record.path}`)
        record.archived = false
        delete record.archivedAt
        this.records.set(record.id, record)
        this.idsByPath.set(key, record.id)
        this.state.nextId = Math.max(this.state.nextId, record.id + 1)
      } catch (error) {
        this.corruptRows += 1
        this.readOnlyReason = `assets.jsonl contains ${this.corruptRows.toLocaleString()} malformed row(s)`
        try {
          await fs.promises.appendFile(
            `${this.filePath}.corruptions.jsonl`,
            `${JSON.stringify({ row, error: errorMessage(error), raw: line.slice(0, 2048) })}\n`,
            'utf8',
          )
        } catch {
          /* valid rows remain usable when the corruption report cannot be written */
        }
      }
      if (row % 4096 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await this.loadArchive()
    await this.initializeCatalog()
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load()
    try {
      await this.loadPromise
    } catch (error) {
      throw this.markUnavailable(error, 'Asset metadata load failed')
    }
  }

  private markUnavailable(error: unknown, context: string): Error {
    if (!this.unavailableReason) this.unavailableReason = `${context}: ${errorMessage(error)}`
    return new Error(`${this.unavailableReason}; writing is disabled until the data is repaired`)
  }

  private assertWritable(): void {
    if (this.unavailableReason) {
      throw new Error(`${this.unavailableReason}; writing is disabled until the data is repaired`)
    }
    if (this.readOnlyReason) {
      throw new Error(`${this.readOnlyReason}; writing is disabled until the data is repaired`)
    }
  }

  getPersistenceStatus(): AssetMetadataPersistenceStatus {
    if (this.unavailableReason) {
      return { state: 'unavailable', corruptRows: this.corruptRows, error: this.unavailableReason }
    }
    if (this.readOnlyReason) {
      return { state: 'read_only', corruptRows: this.corruptRows, error: this.readOnlyReason }
    }
    return { state: 'ready', corruptRows: 0 }
  }

  getState(): Readonly<AssetMetadataState> {
    return this.state
  }

  getById(id: number): AssetRecord | undefined {
    return this.records.get(id)
  }

  getByPath(filePath: string): AssetRecord | undefined {
    const id = this.idsByPath.get(pathKey(filePath))
    return id ? this.records.get(id) : undefined
  }

  getMany(ids: Iterable<number>): AssetRecord[] {
    const result: AssetRecord[] = []
    for (const id of ids) {
      const record = this.records.get(id)
      if (record) result.push(record)
    }
    return result
  }

  activeCount(): number {
    let count = 0
    for (const record of this.records.values()) {
      if (!record.missing && !record.archived) count += 1
    }
    return count
  }

  /** One-pass activity snapshot for stats and relation aggregate filters. */
  activitySummary(): { activeCount: number; archivedCount: number; inactiveIds: number[] } {
    let activeCount = 0
    let archivedCount = 0
    const inactiveIds: number[] = []
    for (const record of this.records.values()) {
      if (record.archived) archivedCount += 1
      if (record.missing || record.archived) inactiveIds.push(record.id)
      else activeCount += 1
    }
    return { activeCount, archivedCount, inactiveIds }
  }

  /**
   * Active (non-missing, non-archived) assets as id + normalized path key +
   * raw path tuples. Snapshot for long-task workers, which cannot share this
   * store's in-memory index.
   */
  activePathIndexEntries(): Array<{ id: number; pathKey: string; path: string }> {
    const entries: Array<{ id: number; pathKey: string; path: string }> = []
    for (const record of this.records.values()) {
      if (record.missing || record.archived) continue
      entries.push({ id: record.id, pathKey: pathKey(record.path), path: record.path })
    }
    return entries
  }

  archivedCount(): number {
    let count = 0
    for (const record of this.records.values()) {
      if (record.archived) count += 1
    }
    return count
  }

  /** Ids of assets that are missing or archived (i.e. not active). */
  inactiveIds(): number[] {
    const ids: number[] = []
    for (const record of this.records.values()) {
      if (record.missing || record.archived) ids.push(record.id)
    }
    return ids
  }

  async setArchived(assetIds: number[], archived: boolean): Promise<number> {
    await this.ensureLoaded()
    this.assertWritable()
    const now = Date.now()
    let affected = 0
    const changedRecords: AssetRecord[] = []
    const stagedArchive = new Map(this.archivedByPath)
    for (const assetId of new Set(assetIds)) {
      const record = this.records.get(assetId)
      if (!record || Boolean(record.archived) === archived) continue
      const key = pathKey(record.path)
      let next: AssetRecord
      if (archived) {
        const entry = { path: record.path, archivedAt: now }
        stagedArchive.set(key, entry)
        next = { ...record, archived: true, archivedAt: now }
      } else {
        stagedArchive.delete(key)
        next = { ...record, archived: false }
        delete next.archivedAt
      }
      changedRecords.push(next)
      affected += 1
    }
    if (affected > 0) {
      await this.persistArchiveSnapshot(stagedArchive)
      this.archivedByPath.clear()
      for (const [key, entry] of stagedArchive) this.archivedByPath.set(key, entry)
      for (const record of changedRecords) this.records.set(record.id, record)
      await this.queueCatalogUpdate(changedRecords)
    }
    return affected
  }

  async setUserMetadata(
    assetIds: number[],
    patch: { rating?: number; favorite?: boolean },
  ): Promise<number> {
    await this.ensureLoaded()
    this.assertWritable()
    const stagedRecords = new Map(this.records)
    const changedRecords: AssetRecord[] = []
    const now = Date.now()
    for (const assetId of new Set(assetIds)) {
      const record = stagedRecords.get(assetId)
      if (!record || record.missing || record.archived) continue
      const rating = patch.rating === undefined ? record.rating : patch.rating || undefined
      const favorite = patch.favorite === undefined ? record.favorite : patch.favorite || undefined
      if (record.rating === rating && record.favorite === favorite) continue
      const next = { ...record, rating, favorite, updatedAt: now }
      stagedRecords.set(assetId, next)
      changedRecords.push(next)
    }
    if (changedRecords.length === 0) return 0
    await this.persistSnapshot(stagedRecords, this.state)
    this.records.clear()
    for (const [id, record] of stagedRecords) this.records.set(id, record)
    return changedRecords.length
  }

  async importManualImages(filePaths: string[]): Promise<AssetRecord[]> {
    await this.ensureLoaded()
    this.assertWritable()
    const stagedRecords = new Map(this.records)
    const stagedIdsByPath = new Map(this.idsByPath)
    const stagedArchive = new Map(this.archivedByPath)
    const stagedState: AssetMetadataState = { ...this.state }
    const uniquePaths = new Map<string, string>()
    for (const rawPath of filePaths.slice(0, 50)) {
      if (typeof rawPath !== 'string' || rawPath.includes('\0')) continue
      const resolved = path.resolve(rawPath)
      if (!MANUAL_IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) continue
      uniquePaths.set(pathKey(resolved), resolved)
    }

    const imported: AssetRecord[] = []
    const now = Date.now()
    let changed = false
    let archiveChanged = false
    for (const [key, filePath] of uniquePaths) {
      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(filePath)
      } catch {
        continue
      }
      if (!stat.isFile()) continue

      const existingId = stagedIdsByPath.get(key)
      const existing = existingId ? stagedRecords.get(existingId) : undefined
      if (existing) {
        if (existing.archived) {
          stagedArchive.delete(key)
          archiveChanged = true
        }
        const next: AssetRecord = {
          ...existing,
          fileSize: Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : 0,
          modifiedTime: Math.max(0, Math.round(stat.mtimeMs)),
          missing: false,
          archived: false,
          updatedAt: now,
        }
        delete next.archivedAt
        stagedRecords.set(existing.id, next)
        imported.push(next)
        changed = true
        continue
      }

      const id = stagedState.nextId++
      const record: AssetRecord = {
        id,
        path: filePath,
        kind: 'image',
        source: 'manual',
        width: 0,
        height: 0,
        fileSize: Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : 0,
        modifiedTime: Math.max(0, Math.round(stat.mtimeMs)),
        missing: false,
        archived: false,
        createdAt: now,
        updatedAt: now,
      }
      stagedRecords.set(id, record)
      stagedIdsByPath.set(key, id)
      imported.push(record)
      changed = true
    }

    if (changed) {
      await this.persistSnapshot(
        stagedRecords,
        stagedState,
        undefined,
        archiveChanged ? stagedArchive : undefined,
      )
    } else if (archiveChanged) {
      await this.persistArchiveSnapshot(stagedArchive)
    }
    if (changed || archiveChanged) {
      this.records.clear()
      for (const [id, record] of stagedRecords) this.records.set(id, record)
      this.idsByPath.clear()
      for (const [key, id] of stagedIdsByPath) this.idsByPath.set(key, id)
      this.archivedByPath.clear()
      for (const [key, entry] of stagedArchive) this.archivedByPath.set(key, entry)
      this.state = stagedState
    }
    return imported
  }

  async verifyManualAssets(
    assetIds: Iterable<number>,
    isCancelled: () => boolean = () => false,
  ): Promise<ManualAssetVerificationResult> {
    await this.ensureLoaded()
    this.assertWritable()
    const stagedRecords = new Map(this.records)
    const changedAssetIds: number[] = []
    let checked = 0
    let missing = 0
    const now = Date.now()

    for (const assetId of new Set(assetIds)) {
      if (isCancelled()) throw new Error('Asset library task cancelled')
      const current = stagedRecords.get(assetId)
      if (!current || current.source !== 'manual') continue
      checked += 1
      let stat: fs.Stats | null = null
      try {
        const value = await fs.promises.stat(current.path)
        if (value.isFile()) stat = value
      } catch {
        /* missing manual references remain in the library for later recovery */
      }

      if (!stat) {
        missing += 1
        if (!current.missing) {
          stagedRecords.set(assetId, { ...current, missing: true, updatedAt: now })
          changedAssetIds.push(assetId)
        }
      } else {
        const fileSize = Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : 0
        const modifiedTime = Math.max(0, Math.round(stat.mtimeMs))
        if (
          current.missing ||
          current.fileSize !== fileSize ||
          current.modifiedTime !== modifiedTime
        ) {
          stagedRecords.set(assetId, {
            ...current,
            fileSize,
            modifiedTime,
            missing: false,
            updatedAt: now,
          })
          changedAssetIds.push(assetId)
        }
      }
      if (checked % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }

    if (changedAssetIds.length > 0) {
      await this.persistSnapshot(stagedRecords, this.state, isCancelled)
      this.records.clear()
      this.idsByPath.clear()
      for (const [id, record] of stagedRecords) {
        this.records.set(id, record)
        this.idsByPath.set(pathKey(record.path), id)
      }
    }

    return {
      checked,
      updated: changedAssetIds.length,
      missing,
      changedAssetIds,
    }
  }

  async list(
    request: Required<Pick<AssetLibraryListRequest, 'offset' | 'limit' | 'sort'>> &
      Omit<AssetLibraryListRequest, 'offset' | 'limit' | 'sort'>,
    include?: (assetId: number) => boolean,
  ): Promise<{ records: AssetRecord[]; total: number }> {
    if (!include && this.catalogReady) {
      try {
        return this.catalog.list(request)
      } catch (error) {
        console.warn('[NekoSearch] SQLite catalog query failed:', errorMessage(error))
        void this.queueCatalogRebuild()
      }
    }
    const query = request.query?.trim().toLowerCase() || ''
    const pageEnd = request.offset + request.limit
    const best: RankedAssetRecord[] = []
    const compare = (left: RankedAssetRecord, right: RankedAssetRecord) =>
      compareRankedAssets(left, right, request.sort)
    let total = 0
    let visited = 0
    for (const record of this.records.values()) {
      const archived = record.archived === true
      if (
        (request.archivedOnly ? archived : !archived && !record.missing) &&
        (!include || include(record.id)) &&
        (!request.source || record.source === request.source) &&
        (!request.kind || record.kind === request.kind) &&
        (request.modifiedAfter === undefined || record.modifiedTime >= request.modifiedAfter) &&
        (request.modifiedBefore === undefined || record.modifiedTime <= request.modifiedBefore) &&
        (request.minRating === undefined || (record.rating || 0) >= request.minRating) &&
        (!request.favoriteOnly || record.favorite === true) &&
        (!query || record.path.toLowerCase().includes(query))
      ) {
        total += 1
        pushBoundedBest(
          best,
          { record, name: request.sort === 'name_asc' ? path.basename(record.path) : '' },
          pageEnd,
          compare,
        )
      }
      visited += 1
      if (visited % 8192 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    best.sort(compare)
    return {
      records: best.slice(request.offset, pageEnd).map((item) => item.record),
      total,
    }
  }

  async replaceFromImageIndex(
    sourceRecords: ImageIndexAssetSourceRecord[],
    sourceManifest: string,
    isCancelled: () => boolean,
    onProgress?: (current: number, total: number) => void,
  ): Promise<AssetMetadataSyncResult> {
    await this.ensureLoaded()
    this.assertWritable()
    const now = Date.now()
    const stagedRecords = new Map(this.records)
    const stagedIdsByPath = new Map(this.idsByPath)
    const stagedState: AssetMetadataState = { ...this.state }
    const seen = new Set<number>()
    let added = 0
    let updated = 0

    for (let index = 0; index < sourceRecords.length; index++) {
      if (isCancelled()) throw new Error('Asset sync cancelled')
      const source = sourceRecords[index]
      const key = pathKey(source.path)
      const existingId = stagedIdsByPath.get(key)
      if (existingId) {
        const existing = stagedRecords.get(existingId)
        if (existing) {
          const changed =
            existing.missing ||
            existing.modifiedTime !== source.modifiedTime ||
            existing.fileSize !== source.fileSize ||
            existing.width !== source.width ||
            existing.height !== source.height ||
            existing.diffHash64 !== source.diffHash64 ||
            existing.dctHash64 !== source.dctHash64
          stagedRecords.set(existingId, {
            ...existing,
            ...source,
            kind: 'image',
            source: 'image_search',
            missing: false,
            updatedAt: changed ? now : existing.updatedAt,
          })
          if (changed) updated += 1
          seen.add(existingId)
        }
      } else {
        const id = stagedState.nextId++
        const record: AssetRecord = {
          id,
          ...source,
          kind: 'image',
          source: 'image_search',
          missing: false,
          createdAt: now,
          updatedAt: now,
        }
        stagedRecords.set(id, record)
        stagedIdsByPath.set(key, id)
        seen.add(id)
        added += 1
      }
      if (index % 2048 === 0) {
        onProgress?.(index, sourceRecords.length)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }

    let missing = 0
    let checked = 0
    for (const [id, record] of stagedRecords) {
      if (checked % 2048 === 0) {
        if (isCancelled()) throw new Error('Asset sync cancelled')
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      if (record.source === 'image_search' && !seen.has(id) && !record.missing) {
        stagedRecords.set(id, { ...record, missing: true, updatedAt: now })
        missing += 1
      }
      checked += 1
    }
    stagedState.lastSyncAt = now
    stagedState.sourceManifest = sourceManifest
    await this.persistSnapshot(stagedRecords, stagedState, isCancelled)

    this.records.clear()
    for (const [id, record] of stagedRecords) this.records.set(id, record)
    this.idsByPath.clear()
    for (const [key, id] of stagedIdsByPath) this.idsByPath.set(key, id)
    this.state = stagedState
    return {
      added,
      updated,
      missing,
      total: sourceRecords.length,
      lastSyncAt: now,
      sourceManifest,
    }
  }

  private async persistSnapshot(
    records: ReadonlyMap<number, AssetRecord>,
    state: Readonly<AssetMetadataState>,
    isCancelled?: () => boolean,
    archivedByPath?: ReadonlyMap<string, AssetArchiveEntry>,
  ): Promise<void> {
    this.assertWritable()
    const run = async () => {
      this.assertWritable()
      try {
        await runAssetMetadataTransaction(
          this.baseDir,
          async ({ assetsPath, statePath, archivePath }) => {
            const stream = fs.createWriteStream(assetsPath, { encoding: 'utf8', flags: 'wx' })
            const assetsHash = crypto.createHash('sha256')
            let assetsBytes = 0
            try {
              let row = 0
              for (const record of records.values()) {
                if (row % 4096 === 0 && isCancelled?.()) throw new Error('Asset sync cancelled')
                const persistedRecord = { ...record }
                delete persistedRecord.archived
                delete persistedRecord.archivedAt
                const line = `${JSON.stringify(persistedRecord)}\n`
                assetsHash.update(line, 'utf8')
                assetsBytes += Buffer.byteLength(line, 'utf8')
                await writeLine(stream, line)
                row += 1
                if (row % 4096 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
              }
              await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                  stream.removeListener('close', onClose)
                  stream.removeListener('error', onError)
                }
                const onClose = () => {
                  cleanup()
                  resolve()
                }
                const onError = (error: Error) => {
                  cleanup()
                  reject(error)
                }
                stream.once('close', onClose)
                stream.once('error', onError)
                stream.end()
              })
            } catch (error) {
              await destroyWriteStream(stream)
              throw error
            }

            const assetsHandle = await fs.promises.open(assetsPath, 'r+')
            try {
              await assetsHandle.sync()
            } finally {
              await assetsHandle.close()
            }
            const stateContents = JSON.stringify(state, null, 2)
            const stateHandle = await fs.promises.open(statePath, 'wx')
            try {
              await stateHandle.writeFile(stateContents, 'utf8')
              await stateHandle.sync()
            } finally {
              await stateHandle.close()
            }
            let archiveFingerprint: { bytes: number; sha256: string } | undefined
            if (archivedByPath) {
              const archiveContents = archiveSnapshotContents(archivedByPath)
              const archiveHandle = await fs.promises.open(archivePath, 'wx')
              try {
                await archiveHandle.writeFile(archiveContents, 'utf8')
                await archiveHandle.sync()
              } finally {
                await archiveHandle.close()
              }
              archiveFingerprint = {
                bytes: Buffer.byteLength(archiveContents, 'utf8'),
                sha256: crypto.createHash('sha256').update(archiveContents, 'utf8').digest('hex'),
              }
            }
            if (isCancelled?.()) throw new Error('Asset sync cancelled')
            return {
              assets: { bytes: assetsBytes, sha256: assetsHash.digest('hex') },
              state: {
                bytes: Buffer.byteLength(stateContents, 'utf8'),
                sha256: crypto.createHash('sha256').update(stateContents, 'utf8').digest('hex'),
              },
              archive: archiveFingerprint,
            }
          },
          { includeArchive: Boolean(archivedByPath) },
        )
        await this.queueCatalogRebuild(records, state)
      } catch (error) {
        if (isCancellationError(error)) throw error
        throw this.markUnavailable(error, 'Asset metadata persistence failed')
      }
    }
    const ready = archivedByPath
      ? Promise.all([this.writeMutex.catch(() => {}), this.archiveWriteMutex.catch(() => {})])
      : this.writeMutex.catch(() => {})
    const pending = ready.then(run)
    this.writeMutex = pending
    if (archivedByPath) this.archiveWriteMutex = pending
    await pending
  }

  async persist(): Promise<void> {
    await this.ensureLoaded()
    this.assertWritable()
    await this.persistSnapshot(this.records, this.state)
  }

  /**
   * Same-volume move repair (Phase 2): re-point an asset record to its new
   * path while keeping the stable asset id, so tags, categories and index
   * rows keyed by that id follow the file. The identity match (filesystem
   * identity, not path equality) is the caller's job.
   */
  async repathAsset(assetId: number, newPath: string): Promise<AssetRecord | null> {
    await this.ensureLoaded()
    this.assertWritable()
    const record = this.records.get(assetId)
    if (!record) return null
    const resolved = path.resolve(newPath)
    const oldKey = pathKey(record.path)
    const newKey = pathKey(resolved)
    if (oldKey === newKey) return record
    const stagedRecords = new Map(this.records)
    const stagedIdsByPath = new Map(this.idsByPath)
    const next: AssetRecord = { ...record, path: resolved, missing: false, updatedAt: Date.now() }
    stagedRecords.set(assetId, next)
    stagedIdsByPath.delete(oldKey)
    stagedIdsByPath.set(newKey, assetId)
    await this.persistSnapshot(stagedRecords, this.state)
    this.records.clear()
    for (const [id, staged] of stagedRecords) this.records.set(id, staged)
    this.idsByPath.clear()
    for (const [key, id] of stagedIdsByPath) this.idsByPath.set(key, id)
    return next
  }

  async flush(): Promise<void> {
    if (this.loadPromise) await this.loadPromise
    await Promise.all([this.writeMutex, this.archiveWriteMutex, this.catalogQueue])
  }
}
