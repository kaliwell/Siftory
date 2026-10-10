// ── Local NTFS source adapter ────────────────────────────
// Phase 1 adapter wrapping the existing native local scan (design 6.2
// constraint 4): the current USN/MFT backend stays preferred, the existing
// directory-enumeration fallback and its degradation reason are surfaced
// unchanged. Discovery batches stream from records the native scanner has
// already committed to its index, so the unified catalog can consume
// committed batches while the scan is still running.
//
// Scope note: the native scanner currently enumerates image files. The
// catalog therefore mirrors that discovery surface in Phase 1; extending
// enumeration to every file type needs a native enumerate-all entry point
// and is tracked as a follow-up.

import fs from 'fs'
import path from 'path'
import type {
  DataSource,
  DiscoveredEntry,
  DiscoveryBatch,
  EnumerateRequest,
  ScanBackend,
  SourceAdapter,
  SourceProbeResult,
} from '../shared/ipc/discovery-catalog'
import type { NativeAddon } from './imageSearchNativeTypes'
import type { ImageSearchDataRecord } from './imageSearchService'
import { MountedNetworkSourceAdapter } from './mountedNetworkSourceAdapter'
import { SftpSourceAdapter } from './sftpSourceAdapter'
import { SourceAdapterError } from './sourceAdapterErrors'

export { SourceAdapterError } from './sourceAdapterErrors'

const DEFAULT_POLL_INTERVAL_MS = 250
const DISCOVERY_BATCH_SIZE = 256

type DiscoveryNativeRecord = Pick<ImageSearchDataRecord, 'path' | 'fileSize' | 'modifiedTime'>

let cachedAddon: NativeAddon | null | undefined

export function loadNativeScannerAddon(): NativeAddon | null {
  if (cachedAddon !== undefined) return cachedAddon
  const candidates = [
    path.resolve(__dirname, '..', 'native', 'build', 'Release', 'fast_scanner.node'),
    path.resolve(__dirname, '..', '..', 'native', 'build', 'Release', 'fast_scanner.node'),
    path.join(process.resourcesPath || '', 'fast_scanner.node'),
  ]
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(candidate) as NativeAddon
      if (mod && typeof mod.getNativeVersion === 'function') {
        cachedAddon = mod
        return cachedAddon
      }
    } catch {
      /* next candidate */
    }
  }
  cachedAddon = null
  return cachedAddon
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toDiscoveredEntry(root: string, record: DiscoveryNativeRecord): DiscoveredEntry {
  const name = path.basename(record.path)
  const extension = path.extname(name).replace(/^\./, '').toLowerCase()
  const relativePath = path.relative(root, record.path) || name
  return {
    absolutePath: record.path,
    relativePath,
    name,
    extension,
    sizeBytes: Number(record.fileSize) || 0,
    modifiedAt: Number(record.modifiedTime) || 0,
  }
}

function backendFromProgress(backend: string | undefined): ScanBackend {
  if (backend === 'USN') return 'usn'
  if (backend === 'enum') return 'directory'
  return 'unknown'
}

export interface LocalNtfsSourceAdapterOptions {
  addon?: NativeAddon | null
  pollIntervalMs?: number
}

export class LocalNtfsSourceAdapter implements SourceAdapter {
  private readonly addon: NativeAddon | null
  private readonly pollIntervalMs: number

  constructor(options: LocalNtfsSourceAdapterOptions = {}) {
    this.addon = options.addon !== undefined ? options.addon : loadNativeScannerAddon()
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  async probe(source: DataSource): Promise<SourceProbeResult> {
    if (!this.addon) {
      return {
        availability: 'degraded',
        scanCapability: 'directory',
        nativeConnected: false,
        detail: 'Native scanner addon is not connected; local NTFS discovery is unavailable.',
      }
    }
    try {
      const stat = fs.statSync(source.rootLocator)
      if (!stat.isDirectory()) {
        return {
          availability: 'offline',
          scanCapability: 'usn',
          nativeConnected: true,
          detail: 'Source root is not a directory.',
        }
      }
    } catch {
      return {
        availability: 'offline',
        scanCapability: 'usn',
        nativeConnected: true,
        detail: 'Source root is not accessible.',
      }
    }
    return {
      availability: 'online',
      scanCapability: 'usn',
      nativeConnected: true,
      detail: 'USN/MFT backend preferred; directory enumeration fallback active when USN fails.',
    }
  }

  private async *snapshotRecordPages(
    generation: number,
    checkOwned: () => unknown,
    checkCancelled: () => void,
  ): AsyncIterable<readonly DiscoveryNativeRecord[]> {
    const addon = this.addon!
    let cursor: string | undefined
    let failure: unknown
    const close = async () => {
      try {
        const result = await addon.closeIndexExport!(cursor!)
        if (!result?.ok) throw new Error('Native export close failed')
      } catch (error) {
        const original = failure instanceof Error ? failure.message : failure ? String(failure) : ''
        const detail = error instanceof Error ? error.message : String(error)
        throw new SourceAdapterError(
          'SCAN_FAILED',
          `${original ? `${original}; ` : ''}Native snapshot cleanup failed: ${detail}`,
        )
      }
    }
    try {
      const snapshot = await addon.snapshotScanRecordsAsync!(generation)
      cursor = snapshot?.cursor
      checkCancelled()
      checkOwned()
      if (!snapshot?.ok || typeof cursor !== 'string' || !cursor) {
        throw new SourceAdapterError(
          'SCAN_FAILED',
          snapshot?.error || 'Invalid Native scan snapshot',
        )
      }
      if (snapshot.generation !== generation) {
        throw new SourceAdapterError('SCAN_FAILED', 'Native snapshot generation mismatch')
      }
      const count = snapshot.recordCount
      if (
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > 1_000_000
      ) {
        throw new SourceAdapterError('SCAN_FAILED', 'Invalid Native snapshot record count')
      }
      let offset = 0
      while (offset < count) {
        checkCancelled()
        checkOwned()
        const page = addon.readScanExportPage!(cursor, generation, offset, DISCOVERY_BATCH_SIZE)
        if (!page?.ok || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') {
          throw new SourceAdapterError(
            'SCAN_FAILED',
            page?.error || 'Invalid Native scan export page',
          )
        }
        if (page.generation !== generation)
          throw new SourceAdapterError('SCAN_FAILED', 'Native page generation mismatch')
        if (page.hasMore && page.records.length === 0) {
          throw new SourceAdapterError('SCAN_FAILED', 'Native scan export made no progress')
        }
        if (
          page.records.length > DISCOVERY_BATCH_SIZE ||
          page.nextOffset !== offset + page.records.length
        ) {
          throw new SourceAdapterError('SCAN_FAILED', 'Native scan export page bounds mismatch')
        }
        offset = page.nextOffset
        if (offset > count || page.hasMore !== offset < count) {
          throw new SourceAdapterError('SCAN_FAILED', 'Native snapshot count mismatch')
        }
        yield page.records
      }
    } catch (error) {
      failure = error
      checkCancelled()
      checkOwned()
      if (error instanceof SourceAdapterError) throw error
      throw new SourceAdapterError(
        'SCAN_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      if (cursor) await close()
    }
  }

  async *enumerate(request: EnumerateRequest): AsyncIterable<DiscoveryBatch> {
    const addon = this.addon
    if (!addon) {
      throw new SourceAdapterError(
        'ADAPTER_UNAVAILABLE',
        'Native scanner addon is not connected; cannot enumerate a local NTFS source.',
      )
    }
    const checkCancelled = () => {
      if (request.signal.aborted) {
        throw new SourceAdapterError('SCAN_CANCELLED', 'Local source discovery cancelled')
      }
    }
    checkCancelled()
    if (
      typeof addon.stopScanGenerationAsync !== 'function' ||
      typeof addon.snapshotScanRecordsAsync !== 'function' ||
      typeof addon.readScanExportPage !== 'function' ||
      typeof addon.closeIndexExport !== 'function'
    ) {
      throw new SourceAdapterError(
        'ADAPTER_UNAVAILABLE',
        'Update the Native scanner to support generation-bound asynchronous discovery.',
      )
    }
    const stopOwnedScan = addon.stopScanGenerationAsync.bind(addon)
    const root = request.source.rootLocator
    const started = addon.scanDirectory(root, request.scanMode ?? 'update')
    if (!started.ok) {
      throw new SourceAdapterError(
        'SCAN_START_FAILED',
        started.error || 'Native scanner failed to start.',
      )
    }
    const generation = started.generation
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
      throw new SourceAdapterError(
        'SCAN_FAILED',
        'Native scanner returned an invalid scan generation',
      )
    }

    const readOwnedProgress = () => {
      const progress = addon.getScanProgress()
      if (progress.generation !== generation) {
        throw new SourceAdapterError(
          'SCAN_FAILED',
          'Local discovery scan was replaced by another scan generation',
        )
      }
      if (progress.state === 'error') {
        throw new SourceAdapterError(
          'SCAN_FAILED',
          progress.lastError || progress.error || 'Native scanner failed',
        )
      }
      if (progress.cancelled) {
        throw new SourceAdapterError(
          'SCAN_CANCELLED',
          'Local discovery scan was stopped before completion',
        )
      }
      if (!['scanning', 'paused', 'stopping', 'idle'].includes(progress.state)) {
        throw new SourceAdapterError('SCAN_FAILED', 'Invalid Native scan progress state')
      }
      return progress
    }

    // The native index is process-global and may hold records from other
    // roots (previous scans, the image-search service); only project
    // records that belong to this source root. Compare case-insensitively
    // on win32 because native and user-supplied roots may differ in case.
    const rootKey = process.platform === 'win32' ? root.toLowerCase() : root

    // Records already surfaced this session, keyed by normalized path so a
    // changed file is re-yielded exactly once with its new size/mtime.
    const yielded = new Map<string, { sizeBytes: number; modifiedAt: number }>()
    let completed = false
    let failure: unknown
    let stopping: ReturnType<typeof stopOwnedScan> | undefined
    const stopOnce = () => (stopping ??= Promise.resolve().then(() => stopOwnedScan(generation)))
    const onAbort = () => {
      if (!completed) void stopOnce().catch(() => undefined)
    }
    const cleanup = async () => {
      try {
        const stopped = await stopOnce()
        if (!stopped?.ok) throw new Error(stopped?.error || 'Native scanner stop failed')
      } catch (cleanupError) {
        const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        const original = failure instanceof Error ? failure.message : failure ? String(failure) : ''
        throw new SourceAdapterError(
          'SCAN_FAILED',
          `${original ? `${original}; ` : ''}Native scanner cleanup failed: ${detail}`,
        )
      }
    }

    request.signal.addEventListener('abort', onAbort, { once: true })
    try {
      for (;;) {
        checkCancelled()
        const progress = readOwnedProgress()
        const scanning = progress.state !== 'idle'
        const backend = backendFromProgress(progress.backend)
        const batchProgress = () => ({
          discoveredCount: yielded.size,
          backend,
          ...(progress.fallbackReason ? { fallbackReason: progress.fallbackReason } : {}),
          ...(progress.fallbackCode ? { fallbackCode: progress.fallbackCode } : {}),
          ...(progress.currentPath ? { currentPath: progress.currentPath } : {}),
        })
        for await (const records of this.snapshotRecordPages(
          generation,
          readOwnedProgress,
          checkCancelled,
        )) {
          checkCancelled()
          const entries: DiscoveredEntry[] = []
          for (const record of records) {
            if (
              !record ||
              typeof record.path !== 'string' ||
              !path.isAbsolute(record.path) ||
              record.path.includes('\0') ||
              !Number.isFinite(record.fileSize) ||
              record.fileSize < 0 ||
              !Number.isFinite(record.modifiedTime)
            ) {
              throw new SourceAdapterError('SCAN_FAILED', 'Invalid Native discovery record')
            }
            const recordKey = process.platform === 'win32' ? record.path.toLowerCase() : record.path
            const relative = path.relative(rootKey, recordKey)
            if (
              !relative ||
              relative === '..' ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative)
            )
              continue
            const sizeBytes = record.fileSize
            const modifiedAt = record.modifiedTime
            const previous = yielded.get(recordKey)
            if (
              previous &&
              previous.sizeBytes === sizeBytes &&
              previous.modifiedAt === modifiedAt
            ) {
              continue
            }
            yielded.set(recordKey, { sizeBytes, modifiedAt })
            entries.push(toDiscoveredEntry(root, record))
          }
          if (entries.length) yield { entries, progress: batchProgress(), final: false }
          // Yield even when a page contains only duplicates or other roots.
          await new Promise<void>((resolve) => setImmediate(resolve))
          checkCancelled()
          // The consumer or another service may have started a replacement scan
          // while this iterator was suspended. Never continue its reads/completion.
          readOwnedProgress()
        }
        // Closing the cursor is asynchronous too; revalidate after its completion.
        checkCancelled()
        readOwnedProgress()
        if (!scanning) {
          checkCancelled()
          completed = true
          yield { entries: [], progress: batchProgress(), final: true }
          return
        }
        await sleep(this.pollIntervalMs)
      }
    } catch (error) {
      failure = error
      throw error
    } finally {
      request.signal.removeEventListener('abort', onAbort)
      // Also run when the consumer breaks/throws while a batch is suspended.
      // A rejected start never enters this block and cannot stop another owner.
      if (!completed) await cleanup()
    }
  }
}

export interface SourceAdapterFactoryOptions extends LocalNtfsSourceAdapterOptions {
  userDataPath?: string
}

export function createSourceAdapter(
  source: DataSource,
  options: SourceAdapterFactoryOptions = {},
): SourceAdapter {
  if (
    source.type === 'local-ntfs' ||
    source.type === 'removable' ||
    source.type === 'local-generic'
  ) {
    return new LocalNtfsSourceAdapter(options)
  }
  if (source.type === 'mounted-network') return new MountedNetworkSourceAdapter()
  if (source.type === 'sftp' && options.userDataPath) {
    return new SftpSourceAdapter({ userDataPath: options.userDataPath })
  }
  throw new SourceAdapterError(
    'ADAPTER_UNAVAILABLE',
    `Source type '${source.type}' has no adapter implementation in Phase 1.`,
  )
}
