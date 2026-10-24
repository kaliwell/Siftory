// ── Source catalog service ───────────────────────────────
// Phase 1 application service (design section 5 layer: Application
// Services). Orchestrates sources, scan sessions and the Discovery Catalog:
// adapters stream discovery batches, each batch is committed to the catalog
// in its own transaction so committed rows are queryable while the scan is
// still running (Phase 1 acceptance). Cancel keeps committed batches and
// marks the session cancelled; only a fully completed scan is recorded as a
// successful scan — missing-file reconcile is intentionally out of Phase 1
// scope (design 6.2 constraint 3).

import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  DataSource,
  DiscoveredEntry,
  DiscoveryAddSourceRequest,
  DiscoveryAddSourceResult,
  DiscoveryCatalogQueryRequest,
  DiscoveryCatalogQueryResponse,
  DiscoveryCatalogStats,
  DiscoveryIncrementalWatchStatus,
  DiscoveryProbeResult,
  DiscoveryScanStartResult,
  DiscoveryScanStatus,
  DiscoverySourceListItem,
  ScanSession,
  SourceAdapter,
  SourceScanCapability,
} from '../shared/ipc/discovery-catalog'
import type { MediaSearchVideoRecord } from '../shared/ipc/media-search'
import { SourceAdapterError, createSourceAdapter } from './sourceAdapter'
import {
  DISCOVERY_CATALOG_FILENAME,
  DiscoveryCatalogDatabase,
  discoveryPathKey,
} from './discoveryCatalogDatabase'
import { normalizeFsPath } from './imageSearchGuards'
import { parseSftpSourceLocator } from './sftpSourceLocator'

const IMPLEMENTED_SOURCE_TYPES = new Set([
  'local-ntfs',
  'local-generic',
  'removable',
  'mounted-network',
  'sftp',
])

export interface SourceCatalogServiceOptions {
  databasePath: string
  adapterFactory?: (source: DataSource) => SourceAdapter
  watcherFactory?: SourceCatalogWatcherFactory
  incrementalWatch?: boolean
  watchDebounceMs?: number
  taskScheduler?: {
    enqueue<T>(request: {
      stage: 'discovery'
      priority: 1
      paths: readonly string[]
      label: string
      run: () => Promise<T>
    }): { id: number; promise: Promise<T> }
    cancel(id: number): boolean
  }
  now?: () => number
}

interface ActiveScan {
  controller: AbortController
  sessionId: string
  discoveredCount: number
  committedCount: number
  taskId?: number
}

export interface SourceCatalogWatcher {
  close(): void
}

export type SourceCatalogWatcherFactory = (
  rootLocator: string,
  onChange: (eventType: string, filename: string | Buffer | null) => void,
  onError: (error: Error) => void,
) => SourceCatalogWatcher

interface ActiveSourceWatch {
  watcher?: SourceCatalogWatcher
  pendingPaths: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  status: DiscoveryIncrementalWatchStatus
}

export interface SourceIncrementalUpdateResult {
  ok: boolean
  upserted: number
  missing: number
  ignored: number
  offline: boolean
  error?: string
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
}

function capabilityForBackend(backend: string): SourceScanCapability | undefined {
  if (backend === 'usn') return 'usn'
  if (backend === 'directory') return 'directory'
  if (backend === 'remote-list') return 'remote-list'
  return undefined
}

function defaultWatcherFactory(
  rootLocator: string,
  onChange: (eventType: string, filename: string | Buffer | null) => void,
  onError: (error: Error) => void,
): SourceCatalogWatcher {
  const watcher = fs.watch(rootLocator, { recursive: true, persistent: false }, onChange)
  watcher.on('error', onError)
  return watcher
}

function watchableSource(source: DataSource): boolean {
  return (
    source.type === 'local-ntfs' ||
    source.type === 'local-generic' ||
    source.type === 'removable' ||
    source.type === 'mounted-network'
  )
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
}

export class SourceCatalogService {
  private readonly database: DiscoveryCatalogDatabase
  private readonly databasePath: string
  private readonly adapterFactory: (source: DataSource) => SourceAdapter
  private readonly now: () => number
  private readonly taskScheduler: SourceCatalogServiceOptions['taskScheduler']
  private readonly watcherFactory: SourceCatalogWatcherFactory
  private readonly incrementalWatchEnabled: boolean
  private readonly watchDebounceMs: number
  private readonly activeScans = new Map<string, ActiveScan>()
  private readonly sourceWatches = new Map<string, ActiveSourceWatch>()
  private statusListeners = new Set<(status: DiscoveryScanStatus) => void>()
  private closed = false

  constructor(options: SourceCatalogServiceOptions) {
    this.databasePath = path.resolve(options.databasePath)
    this.database = new DiscoveryCatalogDatabase(options.databasePath)
    this.adapterFactory =
      options.adapterFactory ??
      ((source) =>
        createSourceAdapter(source, { userDataPath: path.dirname(options.databasePath) }))
    this.taskScheduler = options.taskScheduler
    this.now = options.now ?? (() => Date.now())
    this.watcherFactory = options.watcherFactory ?? defaultWatcherFactory
    this.incrementalWatchEnabled = options.incrementalWatch !== false
    this.watchDebounceMs = Math.max(50, Math.min(10_000, options.watchDebounceMs ?? 600))
    if (this.incrementalWatchEnabled) {
      for (const source of this.database.listSources()) this.startIncrementalWatcher(source)
    }
  }

  close(): void {
    this.closed = true
    for (const active of this.activeScans.values()) active.controller.abort()
    for (const sourceId of [...this.sourceWatches.keys()]) this.stopIncrementalWatcher(sourceId)
    this.database.close()
  }

  onScanStatus(listener: (status: DiscoveryScanStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private emitStatus(sourceId: string): void {
    const status = this.getScanStatus(sourceId)[0]
    if (!status) return
    for (const listener of this.statusListeners) listener(status)
  }

  private getIncrementalWatchStatus(
    sourceId: string,
    source = this.database.getSource(sourceId) ?? undefined,
  ): DiscoveryIncrementalWatchStatus {
    const active = this.sourceWatches.get(sourceId)
    if (active) {
      return { ...active.status, pendingCount: active.pendingPaths.size }
    }
    return {
      state:
        !this.incrementalWatchEnabled || !source || !watchableSource(source)
          ? 'unsupported'
          : 'error',
      pendingCount: 0,
      ...(!source || !watchableSource(source)
        ? {}
        : { lastError: 'Incremental watcher is not active' }),
    }
  }

  private startIncrementalWatcher(source: DataSource): void {
    if (!this.incrementalWatchEnabled || !watchableSource(source)) {
      this.stopIncrementalWatcher(source.id)
      this.sourceWatches.set(source.id, {
        pendingPaths: new Set(),
        timer: null,
        status: { state: 'unsupported', pendingCount: 0 },
      })
      return
    }
    this.stopIncrementalWatcher(source.id)
    try {
      if (!fs.statSync(source.rootLocator).isDirectory()) {
        throw new Error('Source root is not a directory')
      }
    } catch (error) {
      this.sourceWatches.set(source.id, {
        pendingPaths: new Set(),
        timer: null,
        status: {
          state: 'paused-offline',
          pendingCount: 0,
          lastError: error instanceof Error ? error.message : String(error),
        },
      })
      this.database.updateSourceScanMeta(source.id, {
        availability: 'offline',
        now: this.now(),
      })
      return
    }
    const active: ActiveSourceWatch = {
      pendingPaths: new Set(),
      timer: null,
      status: { state: 'watching', pendingCount: 0 },
    }
    this.sourceWatches.set(source.id, active)
    try {
      active.watcher = this.watcherFactory(
        source.rootLocator,
        (_eventType, filename) => this.queueIncrementalChange(source.id, filename),
        (error) => this.handleIncrementalWatchError(source.id, error),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      active.status = { state: 'error', pendingCount: 0, lastError: message }
      this.database.updateSourceScanMeta(source.id, {
        availability: 'degraded',
        now: this.now(),
      })
    }
  }

  private stopIncrementalWatcher(sourceId: string): void {
    const active = this.sourceWatches.get(sourceId)
    if (!active) return
    if (active.timer) clearTimeout(active.timer)
    try {
      active.watcher?.close()
    } catch {
      // Watcher close is best effort during source removal and application quit.
    }
    this.sourceWatches.delete(sourceId)
  }

  private pauseIncrementalWatcher(sourceId: string, detail?: string): void {
    const source = this.database.getSource(sourceId)
    if (!source || !watchableSource(source)) return
    this.stopIncrementalWatcher(sourceId)
    this.sourceWatches.set(sourceId, {
      pendingPaths: new Set(),
      timer: null,
      status: {
        state: 'paused-offline',
        pendingCount: 0,
        ...(detail ? { lastError: detail.slice(0, 1_000) } : {}),
      },
    })
    this.database.updateSourceScanMeta(sourceId, {
      availability: 'offline',
      now: this.now(),
    })
    this.emitStatus(sourceId)
  }

  private handleIncrementalWatchError(sourceId: string, error: Error): void {
    const source = this.database.getSource(sourceId)
    if (!source) return
    const offline = (() => {
      try {
        return !fs.statSync(source.rootLocator).isDirectory()
      } catch {
        return true
      }
    })()
    if (offline) {
      this.pauseIncrementalWatcher(sourceId, error.message)
      return
    }
    const active = this.sourceWatches.get(sourceId)
    if (!active) return
    active.status = {
      ...active.status,
      state: 'error',
      pendingCount: active.pendingPaths.size,
      lastError: error.message.slice(0, 1_000),
    }
    this.database.updateSourceScanMeta(sourceId, {
      availability: 'degraded',
      now: this.now(),
    })
    this.emitStatus(sourceId)
  }

  private queueIncrementalChange(sourceId: string, filename: string | Buffer | null): void {
    const active = this.sourceWatches.get(sourceId)
    const source = this.database.getSource(sourceId)
    if (!active || !source || active.status.state !== 'watching') return
    const rawPath = Buffer.isBuffer(filename) ? filename.toString('utf8') : filename
    if (!rawPath?.trim()) {
      active.status = {
        ...active.status,
        lastError: 'Filesystem change did not include a path; run a source scan to reconcile it',
      }
      return
    }
    const absolutePath = path.resolve(source.rootLocator, rawPath)
    const relative = path.relative(source.rootLocator, absolutePath)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return
    }
    const databaseKey = discoveryPathKey(this.databasePath)
    const eventKey = discoveryPathKey(absolutePath)
    if (eventKey === databaseKey || eventKey.startsWith(`${databaseKey}-`)) return
    active.pendingPaths.add(absolutePath)
    active.status = {
      ...active.status,
      pendingCount: active.pendingPaths.size,
      lastEventAt: this.now(),
      lastError: undefined,
    }
    if (active.timer) clearTimeout(active.timer)
    active.timer = setTimeout(() => {
      active.timer = null
      void this.flushIncrementalChanges(sourceId)
    }, this.watchDebounceMs)
    active.timer.unref?.()
  }

  private async flushIncrementalChanges(sourceId: string): Promise<void> {
    const active = this.sourceWatches.get(sourceId)
    if (!active || active.status.state !== 'watching') return
    const paths = [...active.pendingPaths]
    active.pendingPaths.clear()
    active.status = { ...active.status, pendingCount: 0 }
    if (!paths.length) return
    const result = await this.applyIncrementalChanges(sourceId, paths)
    const latest = this.sourceWatches.get(sourceId)
    if (!latest || latest.status.state !== 'watching') return
    latest.status = {
      ...latest.status,
      pendingCount: latest.pendingPaths.size,
      ...(result.ok ? { lastAppliedAt: this.now(), lastError: undefined } : {}),
      ...(!result.ok && result.error ? { lastError: result.error.slice(0, 1_000) } : {}),
    }
    this.emitStatus(sourceId)
  }

  private async collectIncrementalDirectoryFiles(
    root: string,
    directory: string,
    remaining: number,
  ): Promise<Array<{ path: string; stat: fs.Stats }>> {
    const files: Array<{ path: string; stat: fs.Stats }> = []
    const pending = [directory]
    while (pending.length && files.length < remaining) {
      const current = pending.shift()!
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (files.length >= remaining || entry.isSymbolicLink()) break
        const candidate = path.join(current, entry.name)
        const relative = path.relative(root, candidate)
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue
        if (entry.isDirectory()) {
          pending.push(candidate)
        } else if (entry.isFile()) {
          try {
            files.push({ path: candidate, stat: await fs.promises.stat(candidate) })
          } catch {
            // The file changed again before the debounced batch was projected.
          }
        }
      }
    }
    return files
  }

  async applyIncrementalChanges(
    sourceId: string,
    rawPaths: readonly string[],
  ): Promise<SourceIncrementalUpdateResult> {
    const source = this.database.getSource(sourceId)
    if (!source || !watchableSource(source)) {
      return {
        ok: false,
        upserted: 0,
        missing: 0,
        ignored: rawPaths.length,
        offline: false,
        error: 'Source does not support local incremental watching',
      }
    }
    const root = path.resolve(source.rootLocator)
    try {
      if (!(await fs.promises.stat(root)).isDirectory())
        throw new Error('Source root is not a directory')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.pauseIncrementalWatcher(sourceId, message)
      return { ok: false, upserted: 0, missing: 0, ignored: 0, offline: true, error: message }
    }

    const targets = new Map<string, string>()
    let ignored = Math.max(0, rawPaths.length - 2_048)
    for (const rawPath of rawPaths.slice(0, 2_048)) {
      if (typeof rawPath !== 'string' || !rawPath.trim()) {
        ignored += 1
        continue
      }
      const absolutePath = path.resolve(root, rawPath)
      const relative = path.relative(root, absolutePath)
      if (
        relative === '' ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        ignored += 1
        continue
      }
      const databaseKey = discoveryPathKey(this.databasePath)
      const targetKey = discoveryPathKey(absolutePath)
      if (targetKey === databaseKey || targetKey.startsWith(`${databaseKey}-`)) {
        ignored += 1
        continue
      }
      targets.set(targetKey, absolutePath)
    }

    const existing: Array<{ path: string; stat: fs.Stats }> = []
    const missingCandidates: string[] = []
    for (const target of targets.values()) {
      try {
        const stat = await fs.promises.lstat(target)
        if (stat.isSymbolicLink()) {
          ignored += 1
        } else if (stat.isFile()) {
          existing.push({ path: target, stat })
        } else if (stat.isDirectory()) {
          const discovered = await this.collectIncrementalDirectoryFiles(
            root,
            target,
            Math.max(0, 2_048 - existing.length),
          )
          existing.push(...discovered)
        } else {
          ignored += 1
        }
      } catch (error) {
        const code = errorCode(error)
        if (code === 'ENOENT' || code === 'ENOTDIR') missingCandidates.push(target)
        else ignored += 1
      }
    }

    try {
      if (!(await fs.promises.stat(root)).isDirectory()) throw new Error('Source root went offline')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.pauseIncrementalWatcher(sourceId, message)
      return {
        ok: false,
        upserted: 0,
        missing: 0,
        ignored,
        offline: true,
        error: message,
      }
    }

    const entries: DiscoveredEntry[] = existing.map(({ path: filePath, stat }) => ({
      absolutePath: filePath,
      relativePath: path.relative(root, filePath),
      name: path.basename(filePath),
      extension: path.extname(filePath).replace(/^\./, '').toLowerCase(),
      sizeBytes: stat.size,
      modifiedAt: stat.mtimeMs,
      ...(stat.ino > 0 ? { filesystemIdentity: `${stat.dev}:${stat.ino}` } : {}),
    }))
    for (const entry of entries) {
      if (!entry.filesystemIdentity) continue
      const previous = this.database.findFileEntryByFilesystemIdentity(
        sourceId,
        entry.filesystemIdentity,
      )
      if (previous && previous.pathKey !== discoveryPathKey(entry.absolutePath)) {
        this.database.repathFileEntryByIdentity(
          sourceId,
          entry.filesystemIdentity,
          entry,
          this.now(),
        )
      }
    }
    const upserted = this.database.upsertDiscoveredBatch(sourceId, null, entries, this.now())
    const missing = this.database.markFileEntriesMissingByPaths(
      sourceId,
      missingCandidates,
      this.now(),
    )
    this.database.updateSourceScanMeta(sourceId, {
      availability: 'online',
      now: this.now(),
    })
    return { ok: true, upserted, missing, ignored, offline: false }
  }

  // ── Sources ────────────────────────────────────────────

  addSource(request: DiscoveryAddSourceRequest): DiscoveryAddSourceResult {
    const type = typeof request.type === 'string' ? request.type : ''
    if (!IMPLEMENTED_SOURCE_TYPES.has(type)) {
      return {
        ok: false,
        error: `Source type '${type}' is reserved but not implemented in Phase 1.`,
      }
    }
    const displayName = typeof request.displayName === 'string' ? request.displayName.trim() : ''
    if (!displayName) return { ok: false, error: 'displayName is required' }
    const rootLocator = normalizeFsPath(request.rootLocator)
    if (!rootLocator) return { ok: false, error: 'A valid root path is required' }
    const mountedNetwork = type === 'mounted-network'
    const sftp = type === 'sftp'
    if (mountedNetwork) {
      if (!path.isAbsolute(rootLocator)) {
        return { ok: false, error: 'An absolute mounted network path is required' }
      }
    } else if (sftp) {
      if (!parseSftpSourceLocator(rootLocator)) {
        return { ok: false, error: 'A valid SFTP source locator is required' }
      }
    } else {
      try {
        if (!fs.statSync(rootLocator).isDirectory()) {
          return { ok: false, error: 'Source root is not a directory' }
        }
      } catch {
        return { ok: false, error: 'Source root is not accessible' }
      }
    }
    const resolvedRoot = sftp ? rootLocator : path.resolve(rootLocator)
    const duplicate = this.database
      .listSources()
      .find((source) =>
        sftp
          ? source.rootLocator === resolvedRoot
          : path.resolve(source.rootLocator) === resolvedRoot,
      )
    if (duplicate) {
      return { ok: false, error: `Source root is already registered as '${duplicate.displayName}'` }
    }
    const source: DataSource = {
      id: newId('src'),
      type: type as DataSource['type'],
      displayName,
      rootLocator: resolvedRoot,
      readOnly: mountedNetwork || sftp ? true : request.readOnly !== false,
      availability: 'unknown',
      scanCapability: sftp ? 'remote-list' : mountedNetwork ? 'directory' : 'usn',
    }
    this.database.insertSource(source, this.now())
    this.startIncrementalWatcher(source)
    return {
      ok: true,
      source: sftp
        ? { ...source, rootLocator: `${request.sftpProfileId}:${request.sftpRemoteRoot}` }
        : source,
    }
  }

  listSources(): DiscoverySourceListItem[] {
    return this.database.listSources().map((source) => {
      const projected =
        source.type !== 'sftp'
          ? source
          : (() => {
              const locator = parseSftpSourceLocator(source.rootLocator)
              return {
                ...source,
                rootLocator: locator
                  ? `${locator.profileId}:${locator.remoteRoot}`
                  : 'Invalid SFTP source',
                displayLocator: locator
                  ? `${locator.profileId}:${locator.remoteRoot}`
                  : 'Invalid SFTP source',
              }
            })()
      return {
        ...projected,
        incrementalWatch: this.getIncrementalWatchStatus(source.id, source),
      }
    })
  }

  removeSource(sourceId: string): { ok: boolean; error?: string } {
    if (this.activeScans.has(sourceId)) {
      return { ok: false, error: 'Cancel the running scan before removing the source' }
    }
    if (!this.database.removeSource(sourceId)) return { ok: false, error: 'Source not found' }
    this.stopIncrementalWatcher(sourceId)
    return { ok: true }
  }

  async repairMountedSourceRoot(
    sourceId: string,
    rawRoot: string,
  ): Promise<{ ok: boolean; source?: DataSource; repairedEntries?: number; error?: string }> {
    if (this.activeScans.has(sourceId)) {
      return { ok: false, error: 'Cancel the running scan before repairing the source' }
    }
    const source = this.database.getSource(sourceId)
    if (!source) return { ok: false, error: 'Source not found' }
    if (source.type !== 'mounted-network') {
      return { ok: false, error: 'Only mounted network sources support root repair' }
    }
    const normalized = normalizeFsPath(rawRoot)
    if (!normalized || !path.isAbsolute(normalized)) {
      return { ok: false, error: 'An absolute mounted network path is required' }
    }
    const newRoot = path.resolve(normalized)
    try {
      if (!fs.statSync(newRoot).isDirectory()) {
        return { ok: false, error: 'Replacement source root is not a directory' }
      }
    } catch {
      return { ok: false, error: 'Replacement source root is not accessible' }
    }
    const duplicate = this.database
      .listSources()
      .find(
        (candidate) =>
          candidate.id !== sourceId &&
          candidate.type !== 'sftp' &&
          path.resolve(candidate.rootLocator) === newRoot,
      )
    if (duplicate) {
      return { ok: false, error: `Source root is already registered as '${duplicate.displayName}'` }
    }
    const samples = this.database.getSourceRepairSamples(sourceId)
    let matchingSamples = 0
    for (const sample of samples) {
      try {
        const candidate = path.resolve(newRoot, sample.relativePath)
        const relative = path.relative(newRoot, candidate)
        if (
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          return { ok: false, error: 'Catalog entry escapes the replacement source root' }
        }
        const stat = fs.statSync(candidate)
        if (
          stat.isFile() &&
          stat.size === sample.sizeBytes &&
          Math.floor(stat.mtimeMs / 1000) === Math.floor(sample.modifiedAt / 1000)
        ) {
          matchingSamples += 1
        }
      } catch {
        // A stale sample can be absent; at least one exact match is required below.
      }
    }
    if (samples.length > 0 && matchingSamples === 0) {
      return {
        ok: false,
        error: 'Replacement root does not match sampled catalog file identities',
      }
    }
    const repairedEntries = this.database.repairMountedSourceRoot(sourceId, newRoot, this.now())
    this.stopIncrementalWatcher(sourceId)
    const repairedSource = this.database.getSource(sourceId)!
    this.startIncrementalWatcher(repairedSource)
    return {
      ok: true,
      source: repairedSource,
      repairedEntries,
    }
  }

  async probeSource(sourceId: string): Promise<DiscoveryProbeResult> {
    const source = this.database.getSource(sourceId)
    if (!source) {
      return {
        ok: false,
        availability: 'unknown',
        scanCapability: 'directory',
        nativeConnected: false,
        error: 'Source not found',
      }
    }
    try {
      const result = await this.adapterFactory(source).probe(source)
      this.database.updateSourceScanMeta(sourceId, {
        availability: result.availability,
        scanCapability: result.scanCapability,
        now: this.now(),
      })
      if (result.availability === 'online')
        this.startIncrementalWatcher(this.database.getSource(sourceId)!)
      else if (result.availability === 'offline')
        this.pauseIncrementalWatcher(sourceId, result.detail)
      return { ok: true, ...result }
    } catch (error) {
      return {
        ok: false,
        availability: 'degraded',
        scanCapability: source.scanCapability,
        nativeConnected: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // ── Scan sessions ──────────────────────────────────────

  startScan(sourceId: string): DiscoveryScanStartResult {
    const source = this.database.getSource(sourceId)
    if (!source) return { ok: false, error: 'Source not found' }
    if (this.activeScans.has(sourceId)) {
      return { ok: false, error: 'A scan is already running for this source' }
    }
    const nativeSingletonBusy = [...this.activeScans.keys()].some((activeSourceId) => {
      const activeSource = this.database.getSource(activeSourceId)
      return activeSource?.type !== 'mounted-network' && activeSource?.type !== 'sftp'
    })
    const remoteSource = source.type === 'mounted-network' || source.type === 'sftp'
    const networkScanBusy = [...this.activeScans.keys()].some((activeSourceId) => {
      const activeType = this.database.getSource(activeSourceId)?.type
      return activeType === 'mounted-network' || activeType === 'sftp'
    })
    if (!remoteSource && nativeSingletonBusy) {
      // The native scanner is a process-wide singleton; serialize scans.
      return { ok: false, error: 'Another source scan is already running' }
    }
    if (remoteSource && networkScanBusy) {
      return { ok: false, error: 'Another remote source scan is already running' }
    }
    const session: ScanSession = {
      id: newId('scan'),
      sourceId,
      state: 'running',
      backend: 'unknown',
      startedAt: this.now(),
      discoveredCount: 0,
      committedCount: 0,
    }
    this.database.createSession(session)
    this.database.updateSourceScanMeta(sourceId, {
      lastAttemptAt: session.startedAt,
      now: this.now(),
    })
    const controller = new AbortController()
    this.activeScans.set(sourceId, {
      controller,
      sessionId: session.id,
      discoveredCount: 0,
      committedCount: 0,
    })
    this.emitStatus(sourceId)
    if (this.taskScheduler && !remoteSource) {
      const task = this.taskScheduler.enqueue({
        stage: 'discovery',
        priority: 1,
        paths: [source.rootLocator],
        label: `discover source ${source.id}`,
        run: () => this.runScan(source, session, controller),
      })
      const active = this.activeScans.get(sourceId)
      if (active) active.taskId = task.id
      void task.promise.catch((error) => {
        // A queued task can be cancelled before runScan starts. Running tasks
        // handle their own abort/error state inside runScan.
        if (!this.activeScans.has(sourceId)) return
        const cancelled = controller.signal.aborted
        this.database.finishSession(
          session.id,
          cancelled ? 'cancelled' : 'error',
          this.now(),
          cancelled ? undefined : error instanceof Error ? error.message : String(error),
        )
        this.activeScans.delete(sourceId)
        this.emitStatus(sourceId)
      })
    } else {
      // Network discovery uses its adapter's own concurrency/timeout budget
      // and must not consume a local-disk scheduler slot.
      void this.runScan(source, session, controller)
    }
    return { ok: true, session }
  }

  cancelScan(sourceId: string): { ok: boolean; error?: string } {
    const active = this.activeScans.get(sourceId)
    if (!active) return { ok: false, error: 'No scan is running for this source' }
    active.controller.abort()
    if (active.taskId !== undefined) this.taskScheduler?.cancel(active.taskId)
    return { ok: true }
  }

  getScanStatus(sourceId?: string): DiscoveryScanStatus[] {
    const sources = sourceId
      ? ([this.database.getSource(sourceId)].filter(Boolean) as DataSource[])
      : this.database.listSources()
    return sources.map((source) => ({
      sourceId: source.id,
      running: this.activeScans.has(source.id),
      session: this.database.getLatestSession(source.id),
    }))
  }

  private async runScan(
    source: DataSource,
    session: ScanSession,
    controller: AbortController,
  ): Promise<void> {
    const active = this.activeScans.get(source.id)
    try {
      const adapter = this.adapterFactory(source)
      for await (const batch of adapter.enumerate({ source, signal: controller.signal })) {
        if (batch.entries.length > 0) {
          const committed = this.database.upsertDiscoveredBatch(
            source.id,
            session.id,
            batch.entries,
            this.now(),
          )
          if (active) active.committedCount += committed
        }
        if (active) active.discoveredCount = batch.progress.discoveredCount
        this.database.updateSessionProgress(session.id, {
          discoveredCount: active?.discoveredCount ?? batch.progress.discoveredCount,
          committedCount: active?.committedCount ?? 0,
          backend: batch.progress.backend,
          fallbackReason: batch.progress.fallbackReason ?? null,
          fallbackCode: batch.progress.fallbackCode ?? null,
        })
        const capability = capabilityForBackend(batch.progress.backend)
        this.database.updateSourceScanMeta(source.id, {
          availability: 'online',
          ...(capability ? { scanCapability: capability } : {}),
          now: this.now(),
        })
        this.emitStatus(source.id)
        if (batch.final) break
      }
      const cancelled = controller.signal.aborted
      this.database.finishSession(session.id, cancelled ? 'cancelled' : 'completed', this.now())
      if (cancelled) {
        // Committed batches stay queryable; the source keeps its rows.
      } else {
        this.database.updateSourceScanMeta(source.id, {
          lastSuccessfulScanAt: this.now(),
          availability: 'online',
          now: this.now(),
        })
        this.startIncrementalWatcher(this.database.getSource(source.id) ?? source)
      }
    } catch (error) {
      const offline = error instanceof SourceAdapterError && error.code === 'SOURCE_OFFLINE'
      const cancelled =
        controller.signal.aborted ||
        (error instanceof SourceAdapterError && error.code === 'SCAN_CANCELLED')
      this.database.finishSession(
        session.id,
        cancelled ? 'cancelled' : 'error',
        this.now(),
        cancelled ? undefined : error instanceof Error ? error.message : String(error),
      )
      if (!cancelled) {
        this.database.updateSourceScanMeta(source.id, {
          availability: offline ? 'offline' : 'degraded',
          now: this.now(),
        })
        if (offline)
          this.pauseIncrementalWatcher(
            source.id,
            error instanceof Error ? error.message : String(error),
          )
      }
    } finally {
      this.activeScans.delete(source.id)
      this.emitStatus(source.id)
    }
  }

  // ── Catalog queries (lexical; independent of AI models) ─

  queryCatalog(request: DiscoveryCatalogQueryRequest): DiscoveryCatalogQueryResponse {
    if (this.closed) return { items: [], total: 0 }
    return this.database.queryCatalog(request)
  }

  findFileEntriesByPaths(displayPaths: readonly string[]) {
    if (this.closed) return []
    return this.database.findFileEntriesByPaths(displayPaths)
  }

  /** Project only files proven present in an existing search index; never scan new folders. */
  async projectExistingSearchFiles(
    displayPaths: readonly string[],
    isIndexed: (file: string) => boolean,
    sourceIds: readonly string[] = [],
  ): Promise<void> {
    const files = [...new Set(displayPaths.slice(0, 2000))].filter(
      (file) => path.isAbsolute(file) && isIndexed(file),
    )
    const stats = new Map<string, fs.Stats>()
    let timedOut = false
    for (let offset = 0; offset < files.length && !timedOut; offset += 16) {
      await Promise.all(
        files.slice(offset, offset + 16).map(async (file) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const stat = await Promise.race([
              fs.promises.stat(file),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  timedOut = true
                  reject(new Error('Existing index file probe timed out'))
                }, 1500)
              }),
            ])
            if (stat.isFile()) stats.set(file, stat)
          } catch {
            // Unavailable sources are never converted into missing-file writes.
          } finally {
            if (timer) clearTimeout(timer)
          }
        }),
      )
    }
    // Resolve sources after asynchronous probes so concurrent projections share
    // already-created durable identities instead of creating duplicate sources.
    if (this.closed) return
    const sources: DataSource[] = this.database
      .listSources()
      .filter(
        (source) =>
          source.type !== 'sftp' &&
          source.type !== 'nas-agent' &&
          (!sourceIds.length || sourceIds.includes(source.id)),
      )
    const groups = new Map<string, DiscoveredEntry[]>()
    for (const [file, stat] of stats) {
      let source = sources
        .filter((candidate) => {
          const relative = path.relative(candidate.rootLocator, file)
          return (
            relative !== '' &&
            relative !== '..' &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative)
          )
        })
        .sort((left, right) => right.rootLocator.length - left.rootLocator.length)[0]
      if (!source) {
        if (sourceIds.length) continue
        const root = path.dirname(file)
        source = {
          id: newId('src'),
          type: 'local-generic',
          displayName: `Existing index · ${path.basename(root) || root}`,
          rootLocator: root,
          readOnly: true,
          availability: 'online',
          scanCapability: 'directory',
        }
        this.database.insertSource(source, this.now())
        sources.push(source)
      }
      const entries = groups.get(source.id) ?? []
      entries.push({
        absolutePath: file,
        relativePath: path.relative(source.rootLocator, file),
        name: path.basename(file),
        extension: path.extname(file).slice(1).toLowerCase(),
        sizeBytes: stat.size,
        modifiedAt: stat.mtimeMs,
      })
      groups.set(source.id, entries)
    }
    for (const [sourceId, entries] of groups) {
      this.database.upsertDiscoveredBatch(sourceId, null, entries, this.now())
    }
  }

  markLocalFileEntriesMissingByPaths(displayPaths: readonly string[]): number {
    return this.database.markLocalFileEntriesMissingByPaths(displayPaths, this.now())
  }

  /** Project Media Search's authoritative local video manifest into registered unified sources. */
  projectMediaSearchVideos(records: readonly MediaSearchVideoRecord[]): {
    projected: number
    unmatched: number
    assignments: Array<{
      videoId: string
      sourceId: string
      sourceType: 'local' | 'mounted-network'
    }>
  } {
    const sources = this.database
      .listSources()
      .filter((source) => source.type !== 'sftp' && source.type !== 'nas-agent')
      .map((source) => ({ source, root: path.resolve(source.rootLocator) }))
      .sort((left, right) => right.root.length - left.root.length)
    const grouped = new Map<
      string,
      { source: DataSource; entries: import('../shared/ipc/discovery-catalog').DiscoveredEntry[] }
    >()
    let unmatched = 0
    const assignments: Array<{
      videoId: string
      sourceId: string
      sourceType: 'local' | 'mounted-network'
    }> = []
    for (const record of records) {
      if (record.missing) continue
      const absolutePath = path.resolve(record.path)
      const sourceMatch = sources.find(({ root }) => {
        const relative = path.relative(root, absolutePath)
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
      })
      if (!sourceMatch) {
        unmatched += 1
        continue
      }
      const group = grouped.get(sourceMatch.source.id) ?? {
        source: sourceMatch.source,
        entries: [],
      }
      assignments.push({
        videoId: record.videoId,
        sourceId: sourceMatch.source.id,
        sourceType: sourceMatch.source.type === 'mounted-network' ? 'mounted-network' : 'local',
      })
      group.entries.push({
        absolutePath,
        relativePath: path.relative(sourceMatch.root, absolutePath) || path.basename(absolutePath),
        name: path.basename(absolutePath),
        extension: path.extname(absolutePath).replace(/^\./, '').toLowerCase(),
        sizeBytes: record.sizeBytes,
        modifiedAt: record.mtimeMs,
      })
      grouped.set(sourceMatch.source.id, group)
    }
    let projected = 0
    for (const { source, entries } of grouped.values()) {
      projected += this.database.upsertDiscoveredBatch(source.id, null, entries, this.now())
      for (const item of this.database
        .findFileEntriesByPaths(entries.map((entry) => entry.absolutePath))
        .filter((item) => item.source.id === source.id)) {
        this.database.setFileEntryIndexState(
          item.fileEntryId,
          'metadata-ready',
          'ready',
          this.now(),
        )
      }
    }
    return { projected, unmatched, assignments }
  }

  getFileEntryForAction(fileEntryId: string) {
    return this.database.getFileEntryForAction(fileEntryId)
  }

  setPreviewIndexState(
    fileEntryId: string,
    state: 'ready' | 'failed' | 'retryable' | 'stale',
  ): boolean {
    return this.database.setFileEntryIndexState(fileEntryId, 'preview-ready', state, this.now())
  }

  repairMovedPath(oldPath: string, newPath: string): number {
    return this.database.repathFileEntriesByPath(oldPath, newPath, this.now())
  }

  getStats(): DiscoveryCatalogStats {
    return this.database.getStats()
  }

  getConsistencyReport() {
    return this.database.getConsistencyReport()
  }
}

// ── Main-process singleton ───────────────────────────────

let sharedService: SourceCatalogService | null = null

export function initSourceCatalogService(
  userDataPath: string,
  options: Pick<SourceCatalogServiceOptions, 'taskScheduler'> = {},
): SourceCatalogService {
  if (sharedService) return sharedService
  sharedService = new SourceCatalogService({
    databasePath: path.join(userDataPath, DISCOVERY_CATALOG_FILENAME),
    ...options,
  })
  return sharedService
}

export function getSourceCatalogService(): SourceCatalogService | null {
  return sharedService
}

export function shutdownSourceCatalogService(): void {
  sharedService?.close()
  sharedService = null
}
