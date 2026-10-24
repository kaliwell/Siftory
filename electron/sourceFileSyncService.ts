import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  SourceFileSyncPreview,
  SourceFileSyncProgress,
  SourceFileSyncResult,
} from '../shared/ipc/source-derived-data'

export interface SourceFileSyncImageRecord {
  path: string
  fileSize?: number
  modifiedTime?: number
}

export interface SourceFileSyncVideoRecord {
  videoId: string
  path: string
  sizeBytes?: number
  missing?: boolean
}

export interface SourceFileSyncDependencies {
  listImageRecords(): SourceFileSyncImageRecord[] | Promise<SourceFileSyncImageRecord[]>
  listVideoRecords(): SourceFileSyncVideoRecord[] | Promise<SourceFileSyncVideoRecord[]>
  deleteImageRecords(
    paths: string[],
    onProgress?: (processed: number, total: number) => void,
  ): Promise<{
    ok: boolean
    removed: number
    vectorRecordsRemoved: number
    warnings?: string[]
    error?: string
  }>
  markVideoRecordsMissing(videoIds: string[]): Promise<{ removed: number }>
  markCatalogRecordsMissing?(paths: string[]): Promise<{ removed: number }> | { removed: number }
  purgeImageThumbnails(
    records: SourceFileSyncImageRecord[],
    onProgress?: (processed: number, total: number) => void,
  ): Promise<{
    deletedFiles: number
    freedBytes: number
    warnings?: string[]
  }>
  startAssetLibrarySync(): { ok: boolean; taskId?: string; error?: string }
  /** Acquire the cross-service maintenance barrier before the first mutation. */
  beginMaintenance?(): void | Promise<void>
  /** Durably stage any write-ahead recovery intent before the final root recheck. */
  prepareMutation?(imagePaths: string[], videoIds: string[]): void | Promise<void>
  /** Persist a restart-safe Asset Library compensation marker before image-index mutation. */
  prepareAssetLibraryRecovery?(sourcePath: string): void | Promise<void>
  /** Remove the compensation marker only after Asset Library reaches a successful terminal state. */
  completeAssetLibraryRecovery?(): void | Promise<void>
  /** Retain the marker and attach a bounded diagnostic for startup retry. */
  recordAssetLibraryRecoveryFailure?(error: string): void | Promise<void>
  /** Optional main-process terminal wait. When present, the maintenance lock stays held. */
  waitForAssetLibrarySync?(taskId: string): Promise<{ ok: boolean; error?: string }>
  /** Future cancellation hook used by non-IPC callers and deterministic tests. */
  isCancelled?(): boolean
  /** Per-file lstat deadline. A timeout is preserved as inaccessible, never missing. */
  probeTimeoutMs?: number
}

interface SyncPlan {
  token: string
  sourcePath: string
  sourceRealPath: string
  sourceDev: number
  sourceIno: number
  probeTimeoutMs: number
  createdAt: number
  expiresAt: number
  images: SourceFileSyncImageRecord[]
  videos: SourceFileSyncVideoRecord[]
  preview: SourceFileSyncPreview
}

interface SyncExecution {
  expiresAt: number
  settled: boolean
  result: Promise<SourceFileSyncResult>
}

const PREVIEW_TTL_MS = 30 * 60 * 1000
const EXECUTION_RESULT_TTL_MS = 30 * 60 * 1000
const MAX_RECORDS = 1_000_000
const STAT_CONCURRENCY = 32
const DEFAULT_PROBE_TIMEOUT_MS = 15_000
const MIN_PROBE_TIMEOUT_MS = 10
const MAX_PROBE_TIMEOUT_MS = 120_000
const ASSET_LIBRARY_RECOVERY_VERSION = 1
const ASSET_LIBRARY_RECOVERY_FILENAME = 'source-file-sync-recovery.json'
const MAX_ASSET_LIBRARY_RECOVERY_BYTES = 64 * 1024
const plans = new Map<string, SyncPlan>()
const executions = new Map<string, SyncExecution>()
const assetLibraryRecoveryChains = new Map<string, Promise<void>>()
let running = false
let shuttingDown = false
let mutationEpoch = 0
let progress: SourceFileSyncProgress = {
  state: 'idle',
  checkedRecords: 0,
  totalRecords: 0,
  changedRecords: 0,
}

export interface SourceFileSyncAssetLibraryRecovery {
  version: typeof ASSET_LIBRARY_RECOVERY_VERSION
  sourcePath: string
  createdAt: number
  updatedAt: number
  attempts: number
  lastError?: string
}

interface StoredSourceFileSyncAssetLibraryRecovery extends SourceFileSyncAssetLibraryRecovery {
  checksum: string
}

function sourceFileSyncAssetLibraryRecoveryPath(userDataPath: string): string {
  const root = path.resolve(userDataPath)
  if (!root || root === path.parse(root).root) {
    throw new Error('Refusing to store source synchronization recovery at a filesystem root')
  }
  return path.join(root, 'asset-library', ASSET_LIBRARY_RECOVERY_FILENAME)
}

function assetLibraryRecoveryChecksum(recovery: SourceFileSyncAssetLibraryRecovery): string {
  return crypto.createHash('sha256').update(JSON.stringify(recovery), 'utf8').digest('hex')
}

function validateAssetLibraryRecovery(raw: unknown): SourceFileSyncAssetLibraryRecovery {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid Asset Library recovery marker')
  const stored = raw as Partial<StoredSourceFileSyncAssetLibraryRecovery>
  if (
    stored.version !== ASSET_LIBRARY_RECOVERY_VERSION ||
    typeof stored.sourcePath !== 'string' ||
    !stored.sourcePath.trim() ||
    stored.sourcePath.length > 1_024 ||
    /[\r\n\0]/.test(stored.sourcePath) ||
    !Number.isSafeInteger(stored.createdAt) ||
    Number(stored.createdAt) <= 0 ||
    !Number.isSafeInteger(stored.updatedAt) ||
    Number(stored.updatedAt) < Number(stored.createdAt) ||
    !Number.isSafeInteger(stored.attempts) ||
    Number(stored.attempts) < 0 ||
    (stored.lastError !== undefined &&
      (typeof stored.lastError !== 'string' || stored.lastError.length > 1_000)) ||
    typeof stored.checksum !== 'string' ||
    !/^[a-f\d]{64}$/.test(stored.checksum)
  ) {
    throw new Error('Invalid Asset Library recovery marker metadata')
  }
  const recovery: SourceFileSyncAssetLibraryRecovery = {
    version: ASSET_LIBRARY_RECOVERY_VERSION,
    sourcePath: stored.sourcePath,
    createdAt: Number(stored.createdAt),
    updatedAt: Number(stored.updatedAt),
    attempts: Number(stored.attempts),
    ...(stored.lastError ? { lastError: stored.lastError } : {}),
  }
  if (assetLibraryRecoveryChecksum(recovery) !== stored.checksum) {
    throw new Error('Asset Library recovery marker checksum mismatch')
  }
  return recovery
}

async function syncRecoveryDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.promises.open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is not available on every Windows filesystem.
  }
}

async function readAssetLibraryRecoveryFile(
  filePath: string,
): Promise<SourceFileSyncAssetLibraryRecovery | null> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.size > MAX_ASSET_LIBRARY_RECOVERY_BYTES) {
    throw new Error('Asset Library recovery marker exceeds its file limit')
  }
  const serialized = await fs.promises.readFile(filePath, 'utf8')
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ASSET_LIBRARY_RECOVERY_BYTES) {
    throw new Error('Asset Library recovery marker exceeds its file limit')
  }
  return validateAssetLibraryRecovery(JSON.parse(serialized))
}

async function writeAssetLibraryRecoveryFile(
  filePath: string,
  recovery: SourceFileSyncAssetLibraryRecovery,
): Promise<void> {
  const stored: StoredSourceFileSyncAssetLibraryRecovery = {
    ...recovery,
    checksum: assetLibraryRecoveryChecksum(recovery),
  }
  const serialized = JSON.stringify(stored)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ASSET_LIBRARY_RECOVERY_BYTES) {
    throw new Error('Asset Library recovery marker exceeds its file limit')
  }
  const directory = path.dirname(filePath)
  await fs.promises.mkdir(directory, { recursive: true })
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(temporary, 'wx')
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.promises.rename(temporary, filePath)
    await syncRecoveryDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.promises.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function serializeAssetLibraryRecovery<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(filePath).toLowerCase()
  const previous = assetLibraryRecoveryChains.get(key) || Promise.resolve()
  const run = previous.catch(() => {}).then(operation)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  assetLibraryRecoveryChains.set(key, tail)
  try {
    return await run
  } finally {
    if (assetLibraryRecoveryChains.get(key) === tail) assetLibraryRecoveryChains.delete(key)
  }
}

export async function prepareSourceFileSyncAssetLibraryRecovery(
  userDataPath: string,
  sourcePath: string,
): Promise<SourceFileSyncAssetLibraryRecovery> {
  if (
    typeof sourcePath !== 'string' ||
    !sourcePath.trim() ||
    sourcePath.length > 1_024 ||
    /[\r\n\0]/.test(sourcePath)
  ) {
    throw new Error('Invalid Asset Library recovery source path')
  }
  const filePath = sourceFileSyncAssetLibraryRecoveryPath(userDataPath)
  return serializeAssetLibraryRecovery(filePath, async () => {
    const existing = await readAssetLibraryRecoveryFile(filePath)
    const now = Date.now()
    const recovery: SourceFileSyncAssetLibraryRecovery = {
      version: ASSET_LIBRARY_RECOVERY_VERSION,
      sourcePath: path.resolve(sourcePath),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      attempts: existing?.attempts || 0,
      ...(existing?.lastError ? { lastError: existing.lastError } : {}),
    }
    await writeAssetLibraryRecoveryFile(filePath, recovery)
    return recovery
  })
}

export async function getSourceFileSyncAssetLibraryRecovery(
  userDataPath: string,
): Promise<SourceFileSyncAssetLibraryRecovery | null> {
  const filePath = sourceFileSyncAssetLibraryRecoveryPath(userDataPath)
  return serializeAssetLibraryRecovery(filePath, () => readAssetLibraryRecoveryFile(filePath))
}

export async function recordSourceFileSyncAssetLibraryRecoveryFailure(
  userDataPath: string,
  error: string,
): Promise<SourceFileSyncAssetLibraryRecovery | null> {
  const filePath = sourceFileSyncAssetLibraryRecoveryPath(userDataPath)
  return serializeAssetLibraryRecovery(filePath, async () => {
    const existing = await readAssetLibraryRecoveryFile(filePath)
    if (!existing) return null
    const recovery: SourceFileSyncAssetLibraryRecovery = {
      ...existing,
      updatedAt: Date.now(),
      attempts: existing.attempts + 1,
      lastError: String(error || 'Asset Library synchronization failed').slice(0, 1_000),
    }
    await writeAssetLibraryRecoveryFile(filePath, recovery)
    return recovery
  })
}

export async function completeSourceFileSyncAssetLibraryRecovery(
  userDataPath: string,
): Promise<boolean> {
  const filePath = sourceFileSyncAssetLibraryRecoveryPath(userDataPath)
  return serializeAssetLibraryRecovery(filePath, async () => {
    try {
      await fs.promises.rm(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    await syncRecoveryDirectory(path.dirname(filePath))
    return true
  })
}

export interface SourceFileSyncAssetLibraryRecoveryRetryOptions {
  userDataPath: string
  /** Read-only readiness check. A non-empty reason defers without consuming an attempt. */
  getBusyReason(): string | null
  /** Atomically reserves the shared maintenance lane; null means the retry must be deferred. */
  acquireMaintenance(): (() => void) | null
  startAssetLibrarySync(): { ok: boolean; taskId?: string; error?: string }
  waitForAssetLibrarySync(taskId: string): Promise<{ ok: boolean; error?: string }>
}

export interface SourceFileSyncAssetLibraryRecoveryRetryResult {
  state: 'none' | 'deferred' | 'completed' | 'failed'
  reason?: string
}

/**
 * Performs one restart-recovery attempt. Scheduling and backoff stay with the
 * process owner, while marker settlement remains deterministic and testable.
 */
export async function retrySourceFileSyncAssetLibraryRecovery(
  options: SourceFileSyncAssetLibraryRecoveryRetryOptions,
): Promise<SourceFileSyncAssetLibraryRecoveryRetryResult> {
  const recovery = await getSourceFileSyncAssetLibraryRecovery(options.userDataPath)
  if (!recovery) return { state: 'none' }

  const busyReason = options.getBusyReason()
  if (busyReason) return { state: 'deferred', reason: busyReason }

  const releaseMaintenance = options.acquireMaintenance()
  if (!releaseMaintenance) {
    return { state: 'deferred', reason: 'Vector maintenance lane is busy' }
  }

  try {
    const started = options.startAssetLibrarySync()
    if (!started.ok || !started.taskId) {
      const reason = started.error || 'Asset Library recovery could not be started'
      await recordSourceFileSyncAssetLibraryRecoveryFailure(options.userDataPath, reason)
      return { state: 'failed', reason }
    }

    const settled = await options.waitForAssetLibrarySync(started.taskId)
    if (!settled.ok) {
      const reason = settled.error || 'Asset Library recovery did not complete'
      await recordSourceFileSyncAssetLibraryRecoveryFailure(options.userDataPath, reason)
      return { state: 'failed', reason }
    }

    await completeSourceFileSyncAssetLibraryRecovery(options.userDataPath)
    return { state: 'completed' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await recordSourceFileSyncAssetLibraryRecoveryFailure(options.userDataPath, reason).catch(
      () => undefined,
    )
    return { state: 'failed', reason }
  } finally {
    releaseMaintenance()
  }
}

function updateProgress(update: Partial<SourceFileSyncProgress>): void {
  progress = { ...progress, ...update, updatedAt: Date.now() }
}

function normalizePathKey(value: string): string {
  const resolved = path.resolve(value)
  const root = path.parse(resolved).root
  const normalized = resolved === root ? root : resolved.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathInScope(candidate: string, sourceKey: string): boolean {
  if (typeof candidate !== 'string' || !candidate || candidate.length > 32_768) return false
  const key = normalizePathKey(candidate)
  const prefix = sourceKey.endsWith(path.sep) ? sourceKey : `${sourceKey}${path.sep}`
  return key === sourceKey || key.startsWith(prefix)
}

async function validateSource(sourcePath: string): Promise<{
  sourcePath: string
  realPath: string
  dev: number
  ino: number
}> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      readSourceIdentity(sourcePath),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Source folder check timed out; records were preserved')),
          DEFAULT_PROBE_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readSourceIdentity(sourcePath: string): Promise<{
  sourcePath: string
  realPath: string
  dev: number
  ino: number
}> {
  if (
    typeof sourcePath !== 'string' ||
    !sourcePath.trim() ||
    sourcePath.length > 1024 ||
    /[\r\n\0]/.test(sourcePath)
  ) {
    throw new Error('Invalid source folder path')
  }
  const resolved = path.resolve(sourcePath.trim())
  let stat: fs.Stats
  let realPath: string
  let confirmedStat: fs.Stats
  try {
    stat = await fs.promises.lstat(resolved)
    realPath = await fs.promises.realpath(resolved)
    confirmedStat = await fs.promises.lstat(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error('Source folder is offline or no longer exists; synchronization was blocked', {
        cause: error,
      })
    }
    throw error
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !confirmedStat.isDirectory() ||
    confirmedStat.isSymbolicLink() ||
    (Number(stat.dev) > 0 &&
      Number(confirmedStat.dev) > 0 &&
      Number(stat.dev) !== Number(confirmedStat.dev)) ||
    (Number(stat.ino) > 0 &&
      Number(confirmedStat.ino) > 0 &&
      Number(stat.ino) !== Number(confirmedStat.ino))
  ) {
    throw new Error('The selected source must be an online regular folder or drive root')
  }
  return {
    sourcePath: resolved,
    realPath,
    dev: Number(confirmedStat.dev) || 0,
    ino: Number(confirmedStat.ino) || 0,
  }
}

type ProbeResult = 'available' | 'missing' | 'inaccessible'

function normalizedProbeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_PROBE_TIMEOUT_MS
  return Math.max(MIN_PROBE_TIMEOUT_MS, Math.min(MAX_PROBE_TIMEOUT_MS, Math.floor(value!)))
}

async function probeFile(filePath: string, timeoutMs: number): Promise<ProbeResult> {
  let timer: NodeJS.Timeout | undefined
  const probe = fs.promises
    .lstat(filePath)
    .then((stat) =>
      stat.isFile() && !stat.isSymbolicLink() ? ('available' as const) : ('inaccessible' as const),
    )
    .catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException)?.code
      return code === 'ENOENT' || code === 'ENOTDIR'
        ? ('missing' as const)
        : ('inaccessible' as const)
    })
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => resolve('inaccessible'), timeoutMs)
  })
  try {
    return await Promise.race([probe, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function findUnavailable<T extends { path: string }>(
  records: T[],
  onChecked: () => void,
  options: { timeoutMs: number; isCancelled?: () => boolean },
): Promise<{ missing: T[]; inaccessible: number }> {
  const missing: T[] = []
  let inaccessible = 0
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(STAT_CONCURRENCY, Math.max(1, records.length)) },
    async () => {
      for (;;) {
        if (options.isCancelled?.()) throw new Error('Source synchronization was cancelled')
        const index = cursor++
        if (index >= records.length) return
        const record = records[index]
        const state = await probeFile(record.path, options.timeoutMs)
        if (state === 'missing') missing.push(record)
        else if (state === 'inaccessible') inaccessible += 1
        onChecked()
      }
    },
  )
  await Promise.all(workers)
  return { missing, inaccessible }
}

function sameSourceIdentity(
  expected: { realPath: string; dev: number; ino: number },
  current: { realPath: string; dev: number; ino: number },
): boolean {
  return (
    normalizePathKey(current.realPath) === normalizePathKey(expected.realPath) &&
    !(expected.dev > 0 && current.dev > 0 && expected.dev !== current.dev) &&
    !(expected.ino > 0 && current.ino > 0 && expected.ino !== current.ino)
  )
}

async function revalidateSourceIdentity(expected: {
  sourcePath: string
  realPath: string
  dev: number
  ino: number
}): Promise<void> {
  const current = await validateSource(expected.sourcePath)
  if (!sameSourceIdentity(expected, current)) {
    throw new Error('Source identity changed after preview; run the analysis again')
  }
}

function emptyPreview(error?: string): SourceFileSyncPreview {
  return {
    ok: false,
    checkedImageRecords: 0,
    checkedVideoRecords: 0,
    missingImageRecords: 0,
    missingVideoRecords: 0,
    inaccessibleRecords: 0,
    staleIndexedSourceBytes: 0,
    originalFilesAffected: 0,
    warnings: [],
    ...(error ? { error } : {}),
  }
}

function emptyResult(error?: string): SourceFileSyncResult {
  return {
    ok: false,
    imageRecordsRemoved: 0,
    imageVectorRecordsRemoved: 0,
    videoRecordsMarkedMissing: 0,
    recoveredBeforeApply: 0,
    thumbnailFilesRemoved: 0,
    freedBytes: 0,
    assetLibrarySyncStarted: false,
    originalFilesAffected: 0,
    warnings: [],
    ...(error ? { error } : {}),
  }
}

function prunePlans(now = Date.now()): void {
  for (const [token, plan] of plans) {
    if (plan.expiresAt <= now) plans.delete(token)
  }
  for (const [token, execution] of executions) {
    if (execution.settled && execution.expiresAt <= now) executions.delete(token)
  }
}

export async function previewSourceFileSync(options: {
  sourcePath: string
  dependencies: SourceFileSyncDependencies
  canRetireMissingPath?: (filePath: string) => boolean
}): Promise<SourceFileSyncPreview> {
  if (running) return emptyPreview('Another source synchronization operation is running')
  const startedAt = Date.now()
  running = true
  progress = {
    state: 'checking',
    phase: 'validating-source',
    sourcePath: options.sourcePath,
    checkedRecords: 0,
    totalRecords: 0,
    changedRecords: 0,
    startedAt,
    updatedAt: startedAt,
  }
  try {
    const source = await validateSource(options.sourcePath)
    if (shuttingDown) throw new Error('Source synchronization is shutting down')
    const sourceKey = normalizePathKey(source.sourcePath)
    const [allImages, allVideos] = await Promise.all([
      options.dependencies.listImageRecords(),
      options.dependencies.listVideoRecords(),
    ])
    const images = allImages.filter((record) => isPathInScope(record.path, sourceKey))
    const videos = allVideos.filter(
      (record) => !record.missing && isPathInScope(record.path, sourceKey),
    )
    if (images.length + videos.length > MAX_RECORDS) {
      throw new Error('Source synchronization record count exceeds the safety limit')
    }
    updateProgress({
      phase: 'checking-records',
      sourcePath: source.sourcePath,
      totalRecords: images.length + videos.length,
    })
    let checked = 0
    const probeTimeoutMs = normalizedProbeTimeout(options.dependencies.probeTimeoutMs)
    const probeOptions = {
      timeoutMs: probeTimeoutMs,
      isCancelled: options.dependencies.isCancelled,
    }
    const onChecked = () => {
      checked += 1
      if (checked % 128 === 0 || checked === images.length + videos.length) {
        updateProgress({ checkedRecords: checked })
      }
    }
    const [imageState, videoState] = await Promise.all([
      findUnavailable(images, onChecked, probeOptions),
      findUnavailable(videos, onChecked, probeOptions),
    ])
    // A drive can disappear while thousands of lstat calls are in flight. Do
    // not issue a confirmation token unless the same root is still online.
    await revalidateSourceIdentity(source)
    const inaccessible = imageState.inaccessible + videoState.inaccessible
    const eligibleImages = imageState.missing.filter(
      (record) => options.canRetireMissingPath?.(record.path) ?? true,
    )
    const eligibleVideos = videoState.missing.filter(
      (record) => options.canRetireMissingPath?.(record.path) ?? true,
    )
    const staleIndexedSourceBytes =
      imageState.missing.reduce((sum, record) => sum + Math.max(0, record.fileSize || 0), 0) +
      videoState.missing.reduce((sum, record) => sum + Math.max(0, record.sizeBytes || 0), 0)
    const createdAt = Date.now()
    const token = `source-sync-${createdAt}-${crypto.randomBytes(16).toString('hex')}`
    const preview: SourceFileSyncPreview = {
      ok: true,
      token,
      sourcePath: source.sourcePath,
      createdAt,
      expiresAt: createdAt + PREVIEW_TTL_MS,
      checkedImageRecords: images.length,
      checkedVideoRecords: videos.length,
      missingImageRecords: eligibleImages.length,
      missingVideoRecords: eligibleVideos.length,
      pendingMissingRecords:
        imageState.missing.length +
        videoState.missing.length -
        eligibleImages.length -
        eligibleVideos.length,
      inaccessibleRecords: inaccessible,
      staleIndexedSourceBytes,
      originalFilesAffected: 0,
      warnings:
        inaccessible > 0
          ? [`Preserved ${inaccessible} inaccessible records because deletion could not be proven`]
          : [],
    }
    prunePlans(createdAt)
    // A preview owns large record arrays. Keep only the newest actionable plan
    // so repeated Analyze clicks cannot retain multiple million-row snapshots.
    plans.clear()
    plans.set(token, {
      token,
      sourcePath: source.sourcePath,
      sourceRealPath: source.realPath,
      sourceDev: source.dev,
      sourceIno: source.ino,
      probeTimeoutMs,
      createdAt,
      expiresAt: preview.expiresAt!,
      images: eligibleImages,
      videos: eligibleVideos,
      preview,
    })
    progress = {
      ...progress,
      state: 'ready',
      checkedRecords: images.length + videos.length,
      changedRecords: imageState.missing.length + videoState.missing.length,
      finishedAt: Date.now(),
      updatedAt: Date.now(),
    }
    return preview
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    progress = { ...progress, state: 'error', error: message, finishedAt: Date.now() }
    return emptyPreview(message)
  } finally {
    running = false
  }
}

async function executeSourceFileSyncPlan(options: {
  plan: SyncPlan
  dependencies: SourceFileSyncDependencies
}): Promise<SourceFileSyncResult> {
  const { plan } = options
  const startedAt = Date.now()
  running = true
  progress = {
    state: 'applying',
    phase: 'validating-source',
    sourcePath: plan.sourcePath,
    checkedRecords: 0,
    totalRecords: plan.images.length + plan.videos.length,
    changedRecords: 0,
    startedAt,
    updatedAt: startedAt,
  }
  let imageRecordsRemoved = 0
  let imageVectorRecordsRemoved = 0
  let videoRecordsMarkedMissing = 0
  let catalogRecordsMarkedMissing = 0
  let recoveredBeforeApply = 0
  let thumbnailFilesRemoved = 0
  let freedBytes = 0
  let assetLibrarySyncStarted = false
  let assetLibrarySyncCompleted: boolean | undefined
  let assetLibraryTaskId: string | undefined
  let assetLibrarySyncAttempted = false
  const warnings = [...plan.preview.warnings]

  const retainAssetLibraryRecovery = async (reason: string): Promise<void> => {
    if (!options.dependencies.recordAssetLibraryRecoveryFailure) return
    try {
      await options.dependencies.recordAssetLibraryRecoveryFailure(reason)
    } catch (error) {
      warnings.push(
        `Asset Library recovery remains required, but its diagnostic could not be updated: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const ensureAssetLibrarySync = async (): Promise<void> => {
    if (assetLibrarySyncAttempted || imageRecordsRemoved <= 0) return
    assetLibrarySyncAttempted = true
    updateProgress({
      changedRecords: imageRecordsRemoved + videoRecordsMarkedMissing,
      phase: 'syncing-library',
    })
    let assetSync: ReturnType<SourceFileSyncDependencies['startAssetLibrarySync']>
    try {
      assetSync = options.dependencies.startAssetLibrarySync()
    } catch (error) {
      const reason = `Image index was synchronized, but the asset library sync could not start: ${
        error instanceof Error ? error.message : String(error)
      }`
      warnings.push(reason)
      assetLibrarySyncCompleted = false
      await retainAssetLibraryRecovery(reason)
      return
    }
    assetLibrarySyncStarted = assetSync.ok
    assetLibraryTaskId = assetSync.taskId
    if (!assetSync.ok) {
      const reason = `Image index was synchronized, but the asset library sync did not start: ${assetSync.error || 'busy'}`
      warnings.push(reason)
      assetLibrarySyncCompleted = false
      await retainAssetLibraryRecovery(reason)
      return
    }
    if (!assetLibraryTaskId) {
      const reason = 'Asset library synchronization started without a task ID'
      warnings.push(reason)
      assetLibrarySyncCompleted = false
      await retainAssetLibraryRecovery(reason)
      return
    }
    if (!options.dependencies.waitForAssetLibrarySync) return
    try {
      const terminal = await options.dependencies.waitForAssetLibrarySync(assetLibraryTaskId)
      assetLibrarySyncCompleted = terminal.ok
      if (!terminal.ok) {
        const reason = `Image index was synchronized, but the asset library sync failed: ${terminal.error || 'unknown error'}`
        warnings.push(reason)
        await retainAssetLibraryRecovery(reason)
      } else if (options.dependencies.completeAssetLibraryRecovery) {
        try {
          await options.dependencies.completeAssetLibraryRecovery()
        } catch (error) {
          const reason = `Asset Library synchronized, but its durable recovery marker could not be cleared: ${
            error instanceof Error ? error.message : String(error)
          }`
          warnings.push(reason)
          assetLibrarySyncCompleted = false
          await retainAssetLibraryRecovery(reason)
        }
      }
    } catch (error) {
      assetLibrarySyncCompleted = false
      const reason = `Image index was synchronized, but waiting for the asset library sync failed: ${
        error instanceof Error ? error.message : String(error)
      }`
      warnings.push(reason)
      await retainAssetLibraryRecovery(reason)
    }
  }
  try {
    await revalidateSourceIdentity({
      sourcePath: plan.sourcePath,
      realPath: plan.sourceRealPath,
      dev: plan.sourceDev,
      ino: plan.sourceIno,
    })
    updateProgress({
      phase: 'rechecking-records',
      checkedRecords: 0,
      totalRecords: plan.images.length + plan.videos.length,
    })
    let checked = 0
    const onChecked = () => {
      checked += 1
      if (checked % 128 === 0 || checked === plan.images.length + plan.videos.length) {
        updateProgress({ checkedRecords: checked })
      }
    }
    const [imageState, videoState] = await Promise.all([
      findUnavailable(plan.images, onChecked, {
        timeoutMs: plan.probeTimeoutMs,
        isCancelled: options.dependencies.isCancelled,
      }),
      findUnavailable(plan.videos, onChecked, {
        timeoutMs: plan.probeTimeoutMs,
        isCancelled: options.dependencies.isCancelled,
      }),
    ])
    // This is the final authorization boundary. No mutation may happen after a
    // removable/network source disappears or is remounted under the same path.
    await revalidateSourceIdentity({
      sourcePath: plan.sourcePath,
      realPath: plan.sourceRealPath,
      dev: plan.sourceDev,
      ino: plan.sourceIno,
    })
    if (imageState.missing.length + videoState.missing.length > 0) {
      // The IPC layer may drain in-flight searches and acquire its cross-service
      // maintenance barrier here. A rejection is still a zero-write outcome.
      await options.dependencies.beginMaintenance?.()
      if (imageState.missing.length > 0) {
        await options.dependencies.prepareAssetLibraryRecovery?.(plan.sourcePath)
      }
      await options.dependencies.prepareMutation?.(
        imageState.missing.map((record) => record.path),
        videoState.missing.map((record) => record.videoId),
      )
      // The barrier and durable intent can both wait on I/O, so close that final
      // gap before advancing the mutation generation.
      await revalidateSourceIdentity({
        sourcePath: plan.sourcePath,
        realPath: plan.sourceRealPath,
        dev: plan.sourceDev,
        ino: plan.sourceIno,
      })
      mutationEpoch += 1
    }
    recoveredBeforeApply =
      plan.images.length +
      plan.videos.length -
      imageState.missing.length -
      videoState.missing.length
    const recheckInaccessible = imageState.inaccessible + videoState.inaccessible
    if (recheckInaccessible > 0) {
      warnings.push(
        `Preserved ${recheckInaccessible} records that became inaccessible before confirmation`,
      )
    }
    updateProgress({
      phase: 'removing-index',
      checkedRecords: 0,
      totalRecords: imageState.missing.length,
    })
    const catalogPaths = [
      ...imageState.missing.map((record) => record.path),
      ...videoState.missing.map((record) => record.path),
    ]
    if (catalogPaths.length > 0 && options.dependencies.markCatalogRecordsMissing) {
      const catalogDelete = await options.dependencies.markCatalogRecordsMissing(catalogPaths)
      catalogRecordsMarkedMissing = Math.max(0, Number(catalogDelete.removed) || 0)
    }
    const imageDelete = await options.dependencies.deleteImageRecords(
      imageState.missing.map((record) => record.path),
      (processed, total) => updateProgress({ checkedRecords: processed, totalRecords: total }),
    )
    imageRecordsRemoved = Math.max(0, Number(imageDelete.removed) || 0)
    imageVectorRecordsRemoved = Math.max(0, Number(imageDelete.vectorRecordsRemoved) || 0)
    warnings.push(...(imageDelete.warnings || []))
    if (!imageDelete.ok) throw new Error(imageDelete.error || 'Could not update the image index')
    const videoDelete = await options.dependencies.markVideoRecordsMissing(
      videoState.missing.map((record) => record.videoId),
    )
    videoRecordsMarkedMissing = Math.max(0, Number(videoDelete.removed) || 0)
    updateProgress({
      phase: 'removing-thumbnails',
      checkedRecords: 0,
      totalRecords: imageState.missing.length,
    })
    const thumbnails = await options.dependencies.purgeImageThumbnails(
      imageState.missing,
      (processed, total) => updateProgress({ checkedRecords: processed, totalRecords: total }),
    )
    thumbnailFilesRemoved = Math.max(0, Number(thumbnails.deletedFiles) || 0)
    freedBytes = Math.max(0, Number(thumbnails.freedBytes) || 0)
    warnings.push(...(thumbnails.warnings || []))
    await ensureAssetLibrarySync()
    const assetCompensationFailed = assetLibrarySyncCompleted === false
    const assetCompensationError = assetCompensationFailed
      ? 'Image index synchronization completed, but Asset Library reconciliation did not complete'
      : undefined
    const result: SourceFileSyncResult = {
      ok: !assetCompensationFailed,
      sourcePath: plan.sourcePath,
      imageRecordsRemoved,
      imageVectorRecordsRemoved,
      videoRecordsMarkedMissing,
      catalogRecordsMarkedMissing,
      recoveredBeforeApply,
      thumbnailFilesRemoved,
      freedBytes,
      assetLibrarySyncStarted,
      ...(assetLibrarySyncCompleted !== undefined ? { assetLibrarySyncCompleted } : {}),
      ...(assetLibraryTaskId ? { assetLibraryTaskId } : {}),
      originalFilesAffected: 0,
      warnings,
      ...(assetCompensationFailed ? { partialCommit: true, error: assetCompensationError } : {}),
    }
    progress = {
      ...progress,
      state: assetCompensationFailed ? 'error' : 'completed',
      changedRecords: imageRecordsRemoved + videoRecordsMarkedMissing,
      ...(assetCompensationError ? { error: assetCompensationError } : {}),
      finishedAt: Date.now(),
      updatedAt: Date.now(),
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await ensureAssetLibrarySync()
    progress = { ...progress, state: 'error', error: message, finishedAt: Date.now() }
    const partialCommit =
      imageRecordsRemoved > 0 ||
      imageVectorRecordsRemoved > 0 ||
      videoRecordsMarkedMissing > 0 ||
      catalogRecordsMarkedMissing > 0 ||
      thumbnailFilesRemoved > 0
    return {
      ...emptyResult(message),
      sourcePath: plan.sourcePath,
      imageRecordsRemoved,
      imageVectorRecordsRemoved,
      videoRecordsMarkedMissing,
      catalogRecordsMarkedMissing,
      recoveredBeforeApply,
      thumbnailFilesRemoved,
      freedBytes,
      assetLibrarySyncStarted,
      ...(assetLibrarySyncCompleted !== undefined ? { assetLibrarySyncCompleted } : {}),
      ...(assetLibraryTaskId ? { assetLibraryTaskId } : {}),
      ...(partialCommit ? { partialCommit: true } : {}),
      warnings,
    }
  } finally {
    running = false
  }
}

export function executeSourceFileSync(options: {
  token: string
  dependencies: SourceFileSyncDependencies
}): Promise<SourceFileSyncResult> {
  prunePlans()
  const existingExecution = executions.get(options.token)
  if (existingExecution) return existingExecution.result
  if (shuttingDown) return Promise.resolve(emptyResult('Source synchronization is shutting down'))
  if (running) {
    return Promise.resolve(emptyResult('Another source synchronization operation is running'))
  }
  const plan = plans.get(options.token)
  if (!plan) {
    return Promise.resolve(emptyResult('Source synchronization preview is missing or expired'))
  }
  plans.delete(options.token)
  const result = executeSourceFileSyncPlan({ plan, dependencies: options.dependencies })
  const execution: SyncExecution = { expiresAt: Number.POSITIVE_INFINITY, settled: false, result }
  executions.set(options.token, execution)
  void result.then(
    () => {
      if (executions.get(options.token) !== execution) return
      execution.settled = true
      execution.expiresAt = Date.now() + EXECUTION_RESULT_TTL_MS
    },
    () => {
      if (executions.get(options.token) !== execution) return
      execution.settled = true
      execution.expiresAt = Date.now() + EXECUTION_RESULT_TTL_MS
    },
  )
  return result
}

export function getExistingSourceFileSyncExecution(
  token: string,
): Promise<SourceFileSyncResult> | undefined {
  prunePlans()
  return executions.get(token)?.result
}

export function getSourceFileSyncProgress(): SourceFileSyncProgress {
  return { ...progress }
}

/** Stop new work and drain committed transactions before closing index and library stores. */
export async function shutdownSourceFileSync(): Promise<void> {
  shuttingDown = true
  await Promise.allSettled([...executions.values()].map((execution) => execution.result))
  await Promise.allSettled([...assetLibraryRecoveryChains.values()])
}

export function isSourceFileSyncRunning(): boolean {
  return running
}

/** Monotonic generation used to reject search results that raced a mutation. */
export function getSourceFileSyncMutationEpoch(): number {
  return mutationEpoch
}
