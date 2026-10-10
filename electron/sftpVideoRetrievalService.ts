import crypto from 'crypto'
import fsp from 'fs/promises'
import path from 'path'
import type { RemoteTerminalProfile } from '../shared/ipc-contract'
import type { RemoteCatalogDownloadClaim } from './remoteCatalogDownload'
import { downloadRemoteFileBounded } from './remoteFileDownloadService'
import { isVideoPath } from './mediaSearchGuards'

export const MAX_SFTP_VIDEO_BYTES = 8 * 1024 * 1024 * 1024
export const DEFAULT_SFTP_VIDEO_CACHE_BYTES = 20 * 1024 * 1024 * 1024
const MAX_QUEUE = 8

type Downloader = typeof downloadRemoteFileBounded

export interface SftpVideoRetrievalResult {
  ok: boolean
  localPath?: string
  cached?: boolean
  transferredBytes?: number
  speedBytesPerSecond?: number
  error?: string
}

export class SftpVideoRetrievalService {
  private active = 0
  private readonly queue: Array<() => void> = []
  private readonly pending = new Map<string, Promise<SftpVideoRetrievalResult>>()

  constructor(
    private readonly cacheDir: string,
    private readonly options: {
      maxCacheBytes?: number
      maxFileBytes?: number
      downloader?: Downloader
    } = {},
  ) {}

  retrieve(
    claim: RemoteCatalogDownloadClaim,
    profile: RemoteTerminalProfile,
    credential: { password?: string; passphrase?: string },
  ): Promise<SftpVideoRetrievalResult> {
    if (!isVideoPath(claim.remotePath)) {
      return Promise.resolve({ ok: false, error: 'Catalog item is not a supported video' })
    }
    const maxFileBytes = this.options.maxFileBytes ?? MAX_SFTP_VIDEO_BYTES
    if (
      !Number.isSafeInteger(claim.totalBytes) ||
      claim.totalBytes < 1 ||
      claim.totalBytes > maxFileBytes
    ) {
      return Promise.resolve({ ok: false, error: 'Remote video size exceeds the retrieval limit' })
    }
    const key = this.cacheKey(claim)
    const existing = this.pending.get(key)
    if (existing) return existing
    if (this.active + this.queue.length >= MAX_QUEUE + 1) {
      return Promise.resolve({ ok: false, error: 'Remote video retrieval queue is full' })
    }
    const promise = new Promise<SftpVideoRetrievalResult>((resolve) => {
      this.queue.push(() => {
        this.active += 1
        void this.run(key, claim, profile, credential)
          .then((result) => {
            this.active -= 1
            this.pending.delete(key)
            this.pump()
            resolve(result)
          })
          .catch((error) => {
            this.active -= 1
            this.pending.delete(key)
            this.pump()
            resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
          })
      })
      this.pump()
    })
    this.pending.set(key, promise)
    return promise
  }

  private pump(): void {
    if (this.active >= 1) return
    this.queue.shift()?.()
  }

  private async run(
    key: string,
    claim: RemoteCatalogDownloadClaim,
    profile: RemoteTerminalProfile,
    credential: { password?: string; passphrase?: string },
  ): Promise<SftpVideoRetrievalResult> {
    await fsp.mkdir(this.cacheDir, { recursive: true })
    const extension = path.posix.extname(claim.remotePath).toLowerCase()
    const finalPath = path.join(this.cacheDir, `${key}${extension}`)
    try {
      const stat = await fsp.stat(finalPath)
      if (stat.isFile() && stat.size === claim.totalBytes) {
        await fsp.utimes(finalPath, new Date(), new Date())
        return {
          ok: true,
          localPath: finalPath,
          cached: true,
          transferredBytes: 0,
          speedBytesPerSecond: 0,
        }
      }
      await fsp.rm(finalPath, { force: true })
    } catch {
      // Cache miss.
    }
    const maxCacheBytes = this.options.maxCacheBytes ?? DEFAULT_SFTP_VIDEO_CACHE_BYTES
    if (claim.totalBytes > maxCacheBytes) {
      return { ok: false, error: 'Remote video exceeds the cache capacity' }
    }
    await this.evict(Math.max(0, maxCacheBytes - claim.totalBytes), finalPath)
    const temporaryPath = `${finalPath}.${crypto.randomUUID()}.part`
    try {
      const downloader = this.options.downloader ?? downloadRemoteFileBounded
      const transfer = await downloader(profile, {
        remotePath: claim.remotePath,
        destinationPath: temporaryPath,
        maxBytes: claim.totalBytes,
        timeoutMs: 24 * 60 * 60_000,
        ...credential,
      })
      const stat = await fsp.stat(temporaryPath)
      if (
        !stat.isFile() ||
        stat.size !== claim.totalBytes ||
        transfer.transferredBytes !== stat.size
      ) {
        throw new Error('Remote video changed during retrieval')
      }
      await fsp.rename(temporaryPath, finalPath)
      return {
        ok: true,
        localPath: finalPath,
        cached: false,
        transferredBytes: transfer.transferredBytes,
        speedBytesPerSecond: Math.round(
          (transfer.transferredBytes * 1000) / Math.max(1, transfer.elapsedMs),
        ),
      }
    } catch (error) {
      await fsp.rm(temporaryPath, { force: true })
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private cacheKey(claim: RemoteCatalogDownloadClaim): string {
    return crypto
      .createHash('sha256')
      .update(`${claim.profileId}|${claim.hostFingerprint}|${claim.remotePath}|${claim.totalBytes}`)
      .digest('hex')
  }

  private async evict(targetBytes: number, keepPath: string): Promise<void> {
    let entries
    try {
      entries = await fsp.readdir(this.cacheDir, { withFileTypes: true })
    } catch {
      return
    }
    const files = (
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && !entry.name.endsWith('.part'))
          .map(async (entry) => {
            const filePath = path.join(this.cacheDir, entry.name)
            const stat = await fsp.stat(filePath)
            return { filePath, size: stat.size, atimeMs: stat.atimeMs }
          }),
      )
    ).sort((left, right) => left.atimeMs - right.atimeMs)
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files) {
      if (total <= targetBytes) break
      if (path.resolve(file.filePath) === path.resolve(keepPath)) continue
      await fsp.rm(file.filePath, { force: true })
      total -= file.size
    }
  }
}
