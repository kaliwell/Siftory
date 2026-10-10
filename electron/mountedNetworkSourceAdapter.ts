import fs from 'fs'
import path from 'path'
import type {
  DataSource,
  DiscoveredEntry,
  DiscoveryBatch,
  EnumerateRequest,
  SourceAdapter,
  SourceProbeResult,
} from '../shared/ipc/discovery-catalog'
import { SourceAdapterError } from './sourceAdapterErrors'

const DEFAULT_BATCH_SIZE = 256
const DEFAULT_STAT_CONCURRENCY = 4
const DEFAULT_OPERATION_TIMEOUT_MS = 15_000
const MAX_DISCOVERED_ENTRIES = 2_000_000

interface NetworkDirent {
  name: string
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

interface NetworkStat {
  isDirectory(): boolean
  isFile(): boolean
  size: number
  mtimeMs: number
}

export interface MountedNetworkIo {
  readdir(directory: string): Promise<NetworkDirent[]>
  stat(filePath: string): Promise<NetworkStat>
}

export interface MountedNetworkSourceAdapterOptions {
  batchSize?: number
  statConcurrency?: number
  operationTimeoutMs?: number
  maxDiscoveredEntries?: number
  io?: MountedNetworkIo
}

const defaultIo: MountedNetworkIo = {
  readdir: (directory) => fs.promises.readdir(directory, { withFileTypes: true }),
  stat: (filePath) => fs.promises.stat(filePath),
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(maximum, Math.floor(value!)))
}

function sourceError(error: unknown, operation: string): SourceAdapterError {
  if (error instanceof SourceAdapterError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM') {
    return new SourceAdapterError(
      'PERMISSION_DENIED',
      `Network source permission denied during ${operation}.`,
    )
  }
  return new SourceAdapterError('SOURCE_OFFLINE', `Network source unavailable during ${operation}.`)
}

function waitForOperation<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new SourceAdapterError('SCAN_CANCELLED', 'Network source scan cancelled.'),
    )
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () =>
      finish(() =>
        reject(new SourceAdapterError('SCAN_CANCELLED', 'Network source scan cancelled.')),
      )
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new SourceAdapterError('SOURCE_OFFLINE', `Network source timed out during ${label}.`),
          ),
        ),
      timeoutMs,
    )
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(sourceError(error, label))),
      )
  })
}

function toDiscoveredEntry(root: string, filePath: string, stat: NetworkStat): DiscoveredEntry {
  const name = path.basename(filePath)
  return {
    absolutePath: filePath,
    relativePath: path.relative(root, filePath) || name,
    name,
    extension: path.extname(name).replace(/^\./, '').toLowerCase(),
    sizeBytes: Number(stat.size) || 0,
    modifiedAt: Number(stat.mtimeMs) || 0,
  }
}

export class MountedNetworkSourceAdapter implements SourceAdapter {
  private readonly batchSize: number
  private readonly statConcurrency: number
  private readonly operationTimeoutMs: number
  private readonly maxDiscoveredEntries: number
  private readonly io: MountedNetworkIo

  constructor(options: MountedNetworkSourceAdapterOptions = {}) {
    this.batchSize = boundedInteger(options.batchSize, DEFAULT_BATCH_SIZE, 2048)
    this.statConcurrency = boundedInteger(options.statConcurrency, DEFAULT_STAT_CONCURRENCY, 8)
    this.operationTimeoutMs = boundedInteger(
      options.operationTimeoutMs,
      DEFAULT_OPERATION_TIMEOUT_MS,
      120_000,
    )
    this.maxDiscoveredEntries = boundedInteger(
      options.maxDiscoveredEntries,
      MAX_DISCOVERED_ENTRIES,
      MAX_DISCOVERED_ENTRIES,
    )
    this.io = options.io ?? defaultIo
  }

  async probe(source: DataSource): Promise<SourceProbeResult> {
    const controller = new AbortController()
    try {
      const stat = await waitForOperation(
        () => this.io.stat(source.rootLocator),
        this.operationTimeoutMs,
        controller.signal,
        'probe',
      )
      if (!stat.isDirectory()) {
        return {
          availability: 'offline',
          scanCapability: 'directory',
          nativeConnected: false,
          detail: 'Network source root is not a directory.',
        }
      }
      return {
        availability: 'online',
        scanCapability: 'directory',
        nativeConnected: false,
        detail: 'Mounted network source uses bounded directory enumeration.',
      }
    } catch (error) {
      const failure = sourceError(error, 'probe')
      return {
        availability: failure.code === 'PERMISSION_DENIED' ? 'degraded' : 'offline',
        scanCapability: 'directory',
        nativeConnected: false,
        detail: failure.message,
      }
    }
  }

  async *enumerate(request: EnumerateRequest): AsyncIterable<DiscoveryBatch> {
    const root = path.resolve(request.source.rootLocator)
    const directories = [root]
    let discoveredCount = 0
    let visitedEntryCount = 0
    let batch: DiscoveredEntry[] = []
    try {
      while (directories.length > 0) {
        const directory = directories.shift()!
        const children = await waitForOperation(
          () => this.io.readdir(directory),
          this.operationTimeoutMs,
          request.signal,
          'directory listing',
        )
        const files: string[] = []
        for (const child of children) {
          if (request.signal.aborted) {
            throw new SourceAdapterError('SCAN_CANCELLED', 'Network source scan cancelled.')
          }
          if (child.name === '.' || child.name === '..' || child.isSymbolicLink()) continue
          visitedEntryCount += 1
          if (visitedEntryCount > this.maxDiscoveredEntries) {
            throw new SourceAdapterError(
              'SCAN_START_FAILED',
              `Network source exceeds the ${this.maxDiscoveredEntries} entry safety limit.`,
            )
          }
          const childPath = path.join(directory, child.name)
          if (child.isDirectory()) directories.push(childPath)
          else if (child.isFile()) files.push(childPath)
        }
        for (let offset = 0; offset < files.length; offset += this.statConcurrency) {
          const window = files.slice(offset, offset + this.statConcurrency)
          const stats = await Promise.all(
            window.map((filePath) =>
              waitForOperation(
                () => this.io.stat(filePath),
                this.operationTimeoutMs,
                request.signal,
                'file metadata',
              ),
            ),
          )
          for (let index = 0; index < window.length; index += 1) {
            if (!stats[index].isFile()) continue
            batch.push(toDiscoveredEntry(root, window[index], stats[index]))
            discoveredCount += 1
            if (batch.length >= this.batchSize) {
              yield {
                entries: batch,
                progress: { discoveredCount, backend: 'directory', currentPath: directory },
                final: false,
              }
              batch = []
            }
          }
        }
      }
    } catch (error) {
      const failure = sourceError(error, 'enumeration')
      if (failure.code !== 'SCAN_CANCELLED') throw failure
    }
    yield {
      entries: batch,
      progress: { discoveredCount, backend: 'directory' },
      final: true,
    }
  }
}
