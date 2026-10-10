import crypto from 'crypto'
import fsp from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import type { RemoteTerminalProfile } from '../shared/ipc-contract'
import type { CatalogFileActionRecord } from './discoveryCatalogDatabase'
import { readRemoteFileBounded } from './remoteFileReadService'
import { resolveStoredCredential } from './remoteTerminalCredential'
import { resolveRemoteCatalogDownloadClaim } from './remoteCatalogDownload'

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.avif',
  '.tif',
  '.tiff',
])
const MAX_REMOTE_SOURCE_BYTES = 32 * 1024 * 1024
const MAX_CACHE_BYTES = 256 * 1024 * 1024
const MAX_QUEUE = 64
const CONCURRENCY = 2
const READ_TIMEOUT_MS = 30_000

export interface RemotePreviewResult {
  ok: boolean
  fileEntryId: string
  dataUrl?: string
  status: 'metadata-only' | 'preview-ready'
  cached?: boolean
  error?: string
}

interface RemotePreviewServiceOptions {
  userDataPath: string
  getRecord: (fileEntryId: string) => CatalogFileActionRecord | null
  setPreviewState: (fileEntryId: string, state: 'ready' | 'failed' | 'retryable' | 'stale') => void
  getProfiles: () => readonly RemoteTerminalProfile[]
  resolveCredential?: typeof resolveStoredCredential
  readRemote?: typeof readRemoteFileBounded
}

interface QueueJob {
  fileEntryId: string
  run: () => Promise<RemotePreviewResult>
  resolve: (result: RemotePreviewResult) => void
}

export class RemotePreviewService {
  private active = 0
  private readonly queue: QueueJob[] = []
  private readonly pending = new Map<string, Promise<RemotePreviewResult>>()
  private readonly cacheDir: string

  constructor(private readonly options: RemotePreviewServiceOptions) {
    this.cacheDir = path.join(options.userDataPath, 'remote-preview-cache', 'v1')
  }

  get(fileEntryId: string, rawMaxDim: number): Promise<RemotePreviewResult> {
    const maxDim = Math.max(64, Math.min(256, Math.floor(rawMaxDim || 160)))
    const key = `${fileEntryId}:${maxDim}`
    const existing = this.pending.get(key)
    if (existing) return existing
    if (this.active + this.queue.length >= MAX_QUEUE + CONCURRENCY) {
      return Promise.resolve({
        ok: false,
        fileEntryId,
        status: 'metadata-only',
        error: 'Remote preview queue is full',
      })
    }
    const promise = new Promise<RemotePreviewResult>((resolve) => {
      this.queue.push({ fileEntryId, run: () => this.create(fileEntryId, maxDim), resolve })
      this.pump()
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, promise)
    return promise
  }

  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.active += 1
      void job
        .run()
        .then(job.resolve)
        .catch((error) =>
          job.resolve({
            ok: false,
            fileEntryId: job.fileEntryId,
            status: 'metadata-only',
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          this.active -= 1
          this.pump()
        })
    }
  }

  private async create(fileEntryId: string, maxDim: number): Promise<RemotePreviewResult> {
    const record = this.options.getRecord(fileEntryId)
    const extension = record ? path.posix.extname(record.displayPath).toLowerCase() : ''
    if (!record || !SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      return {
        ok: false,
        fileEntryId,
        status: 'metadata-only',
        error: record ? 'Remote preview format is not supported' : 'Catalog file not found',
      }
    }
    if (record.sizeBytes > MAX_REMOTE_SOURCE_BYTES) {
      return {
        ok: false,
        fileEntryId,
        status: 'metadata-only',
        error: 'Remote file exceeds preview read limit',
      }
    }
    const cachePath = this.cachePath(record, maxDim)
    try {
      const cached = await fsp.readFile(cachePath)
      void fsp.utimes(cachePath, new Date(), new Date()).catch(() => {})
      this.options.setPreviewState(fileEntryId, 'ready')
      return {
        ok: true,
        fileEntryId,
        dataUrl: `data:image/webp;base64,${cached.toString('base64')}`,
        status: 'preview-ready',
        cached: true,
      }
    } catch {
      // Cache miss.
    }

    const resolved = resolveRemoteCatalogDownloadClaim(record, this.options.getProfiles())
    if (!resolved.ok) return { ...resolved, fileEntryId, status: 'metadata-only' }

    const profile = this.options.getProfiles().find((item) => item.id === resolved.claim.profileId)!
    try {
      const credentialResolver = this.options.resolveCredential ?? resolveStoredCredential
      const credential = await credentialResolver(this.options.userDataPath, profile, {
        profileId: profile.id,
        password: undefined as string | undefined,
        passphrase: undefined as string | undefined,
      })
      const readRemote = this.options.readRemote ?? readRemoteFileBounded
      const source = await readRemote(profile, {
        profileId: profile.id,
        remotePath: resolved.claim.remotePath,
        maxBytes: MAX_REMOTE_SOURCE_BYTES,
        timeoutMs: READ_TIMEOUT_MS,
        password: credential.password,
        passphrase: credential.passphrase,
      })
      const preview = await sharp(source, {
        animated: false,
        limitInputPixels: 80_000_000,
        sequentialRead: true,
      })
        .rotate()
        .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
        .webp({ effort: 2, quality: 78 })
        .toBuffer()
      await fsp.mkdir(this.cacheDir, { recursive: true })
      const temporaryPath = `${cachePath}.${crypto.randomUUID()}.tmp`
      await fsp.writeFile(temporaryPath, preview, { mode: 0o600 })
      await fsp.rename(temporaryPath, cachePath)
      this.options.setPreviewState(fileEntryId, 'ready')
      void this.evict().catch(() => {})
      return {
        ok: true,
        fileEntryId,
        dataUrl: `data:image/webp;base64,${preview.toString('base64')}`,
        status: 'preview-ready',
        cached: false,
      }
    } catch (error) {
      this.options.setPreviewState(fileEntryId, 'retryable')
      return {
        ok: false,
        fileEntryId,
        status: 'metadata-only',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private cachePath(record: CatalogFileActionRecord, maxDim: number): string {
    const key = crypto
      .createHash('sha256')
      .update(
        `v1|${record.source.id}|${record.displayPath}|${record.sizeBytes}|${record.modifiedAt}|${maxDim}`,
      )
      .digest('hex')
    return path.join(this.cacheDir, `${key}.webp`)
  }

  private async evict(): Promise<void> {
    const entries = await fsp.readdir(this.cacheDir, { withFileTypes: true })
    const files = (
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.webp'))
          .map(async (entry) => {
            const filePath = path.join(this.cacheDir, entry.name)
            const stat = await fsp.stat(filePath)
            return { filePath, size: stat.size, atimeMs: stat.atimeMs }
          }),
      )
    ).sort((left, right) => left.atimeMs - right.atimeMs)
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files) {
      if (total <= MAX_CACHE_BYTES) break
      await fsp.rm(file.filePath, { force: true })
      total -= file.size
    }
  }
}

let sharedRemotePreviewService: RemotePreviewService | null = null

export function getRemotePreviewService(
  options: RemotePreviewServiceOptions,
): RemotePreviewService {
  if (!sharedRemotePreviewService) sharedRemotePreviewService = new RemotePreviewService(options)
  return sharedRemotePreviewService
}
