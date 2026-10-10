import path from 'path'
import type {
  DataSource,
  DiscoveredEntry,
  DiscoveryBatch,
  EnumerateRequest,
  SourceAdapter,
  SourceProbeResult,
} from '../shared/ipc/discovery-catalog'
import type { RemoteDirectoryPage, RemoteTerminalProfile } from '../shared/ipc-contract'
import { listRemoteDirectoryPaged } from './remoteSftpService'
import { resolveStoredCredential } from './remoteTerminalCredential'
import { listProfiles } from './remoteTerminalService'
import { SourceAdapterError } from './sourceAdapterErrors'
import { parseSftpSourceLocator, sftpEntryLocator } from './sftpSourceLocator'

const DEFAULT_BATCH_SIZE = 256
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const MAX_DISCOVERED_ENTRIES = 2_000_000

export interface SftpListRequest {
  profileId: string
  remotePath: string
  cursor?: string
  password?: string
  passphrase?: string
}

export interface SftpSourceAdapterOptions {
  userDataPath: string
  batchSize?: number
  maxDiscoveredEntries?: number
  operationTimeoutMs?: number
  getProfiles?: () => RemoteTerminalProfile[]
  resolveCredential?: typeof resolveStoredCredential
  listDirectory?: typeof listRemoteDirectoryPaged
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(maximum, Math.floor(value!)))
}

function remoteFailure(result: RemoteDirectoryPage): SourceAdapterError {
  const message = result.error || 'SFTP directory listing failed.'
  if (/host key changed/i.test(message)) return new SourceAdapterError('HOST_KEY_CHANGED', message)
  if (/unknown ssh host key/i.test(message)) {
    return new SourceAdapterError('HOST_KEY_UNVERIFIED', message)
  }
  if (
    /permission denied|authentication failed|all configured authentication methods failed/i.test(
      message,
    )
  ) {
    return new SourceAdapterError('CREDENTIAL_UNAVAILABLE', message)
  }
  return new SourceAdapterError('SOURCE_OFFLINE', message)
}

export class SftpSourceAdapter implements SourceAdapter {
  private readonly userDataPath: string
  private readonly batchSize: number
  private readonly maxDiscoveredEntries: number
  private readonly operationTimeoutMs: number
  private readonly getProfiles: () => RemoteTerminalProfile[]
  private readonly resolveCredential: typeof resolveStoredCredential
  private readonly listDirectory: typeof listRemoteDirectoryPaged

  constructor(options: SftpSourceAdapterOptions) {
    this.userDataPath = options.userDataPath
    this.batchSize = boundedInteger(options.batchSize, DEFAULT_BATCH_SIZE, 2048)
    this.maxDiscoveredEntries = boundedInteger(
      options.maxDiscoveredEntries,
      MAX_DISCOVERED_ENTRIES,
      MAX_DISCOVERED_ENTRIES,
    )
    this.operationTimeoutMs = boundedInteger(
      options.operationTimeoutMs,
      DEFAULT_OPERATION_TIMEOUT_MS,
      120_000,
    )
    this.getProfiles = options.getProfiles ?? listProfiles
    this.resolveCredential = options.resolveCredential ?? resolveStoredCredential
    this.listDirectory = options.listDirectory ?? listRemoteDirectoryPaged
  }

  private resolveSource(source: DataSource): {
    profile: RemoteTerminalProfile
    profileId: string
    remoteRoot: string
  } {
    const locator = parseSftpSourceLocator(source.rootLocator)
    if (!locator) throw new SourceAdapterError('SCAN_START_FAILED', 'Invalid SFTP source locator.')
    const profile = this.getProfiles().find((candidate) => candidate.id === locator.profileId)
    if (!profile) throw new SourceAdapterError('ADAPTER_UNAVAILABLE', 'SFTP profile not found.')
    if (!profile.hostFingerprint) {
      throw new SourceAdapterError(
        'HOST_KEY_UNVERIFIED',
        'SFTP profile has no confirmed host fingerprint.',
      )
    }
    if (profile.hostFingerprint !== locator.hostFingerprint) {
      throw new SourceAdapterError(
        'HOST_KEY_CHANGED',
        'SFTP profile fingerprint changed after this source was registered. Connection blocked.',
      )
    }
    return { profile, profileId: locator.profileId, remoteRoot: locator.remoteRoot }
  }

  private async listPage(
    profile: RemoteTerminalProfile,
    remotePath: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<RemoteDirectoryPage> {
    const request = await this.resolveCredential(this.userDataPath, profile, {
      profileId: profile.id,
      remotePath,
      ...(cursor ? { cursor } : {}),
    })
    return new Promise<RemoteDirectoryPage>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        callback()
      }
      const onAbort = () =>
        finish(() =>
          reject(new SourceAdapterError('SCAN_CANCELLED', 'SFTP source scan cancelled.')),
        )
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(new SourceAdapterError('SOURCE_OFFLINE', 'SFTP directory listing timed out.')),
          ),
        this.operationTimeoutMs,
      )
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      void this.listDirectory(profile, request).then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error)),
      )
    })
  }

  async probe(source: DataSource): Promise<SourceProbeResult> {
    try {
      const { profile, remoteRoot } = this.resolveSource(source)
      const result = await this.listPage(profile, remoteRoot)
      if (!result.ok) throw remoteFailure(result)
      return {
        availability: 'online',
        scanCapability: 'remote-list',
        nativeConnected: false,
        detail: 'SFTP profile, pinned host key, credential and remote root are available.',
      }
    } catch (error) {
      const failure =
        error instanceof SourceAdapterError
          ? error
          : new SourceAdapterError('SOURCE_OFFLINE', 'SFTP source is unavailable.')
      return {
        availability: failure.code === 'SOURCE_OFFLINE' ? 'offline' : 'degraded',
        scanCapability: 'remote-list',
        nativeConnected: false,
        detail: failure.message,
      }
    }
  }

  async *enumerate(request: EnumerateRequest): AsyncIterable<DiscoveryBatch> {
    const { profile, profileId, remoteRoot } = this.resolveSource(request.source)
    const directories = [remoteRoot]
    let discoveredCount = 0
    let visitedEntryCount = 0
    let batch: DiscoveredEntry[] = []
    try {
      while (directories.length > 0) {
        const directory = directories.shift()!
        let cursor: string | undefined
        do {
          if (request.signal.aborted) {
            throw new SourceAdapterError('SCAN_CANCELLED', 'SFTP source scan cancelled.')
          }
          const result = await this.listPage(profile, directory, cursor, request.signal)
          if (!result.ok) throw remoteFailure(result)
          for (const entry of result.entries) {
            if (request.signal.aborted) {
              throw new SourceAdapterError('SCAN_CANCELLED', 'SFTP source scan cancelled.')
            }
            if (entry.type === 'symlink' || entry.type === 'other') continue
            visitedEntryCount += 1
            if (visitedEntryCount > this.maxDiscoveredEntries) {
              throw new SourceAdapterError(
                'SCAN_START_FAILED',
                `SFTP source exceeds the ${this.maxDiscoveredEntries} entry safety limit.`,
              )
            }
            if (entry.type === 'directory') {
              directories.push(entry.path)
              continue
            }
            const name = path.posix.basename(entry.path)
            batch.push({
              absolutePath: sftpEntryLocator(profileId, entry.path),
              relativePath: path.posix.relative(remoteRoot, entry.path) || name,
              name,
              extension: path.posix.extname(name).replace(/^\./, '').toLowerCase(),
              sizeBytes: Number(entry.size) || 0,
              modifiedAt: Number(entry.modifiedAt) || 0,
            })
            discoveredCount += 1
            if (batch.length >= this.batchSize) {
              yield {
                entries: batch,
                progress: { discoveredCount, backend: 'remote-list', currentPath: directory },
                final: false,
              }
              batch = []
            }
          }
          cursor = result.hasMore ? result.cursor : undefined
        } while (cursor)
      }
    } catch (error) {
      if (!(error instanceof SourceAdapterError) || error.code !== 'SCAN_CANCELLED') throw error
    }
    yield {
      entries: batch,
      progress: { discoveredCount, backend: 'remote-list' },
      final: true,
    }
  }
}
