import crypto from 'crypto'
import fs from 'fs'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'

export interface ModelDownloadProgress {
  bytesDownloaded: number
  totalBytes: number
}

export interface ModelDownloadStreamOptions {
  signal: AbortSignal
  totalBytes: number
  progressIntervalMs?: number
  progressByteInterval?: number
  onProgress?: (progress: ModelDownloadProgress) => void
}

export async function streamModelBodyToFile(
  body: AsyncIterable<Uint8Array>,
  destPath: string,
  options: ModelDownloadStreamOptions,
): Promise<{ bytesDownloaded: number; sha256: string }> {
  const hash = crypto.createHash('sha256')
  const progressIntervalMs = Math.max(50, options.progressIntervalMs ?? 200)
  const progressByteInterval = Math.max(64 * 1024, options.progressByteInterval ?? 4 * 1024 * 1024)
  let bytesDownloaded = 0
  let lastProgressAt = Date.now()
  let lastProgressBytes = 0

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      bytesDownloaded += chunk.length
      const now = Date.now()
      if (
        now - lastProgressAt >= progressIntervalMs ||
        bytesDownloaded - lastProgressBytes >= progressByteInterval
      ) {
        lastProgressAt = now
        lastProgressBytes = bytesDownloaded
        options.onProgress?.({ bytesDownloaded, totalBytes: options.totalBytes })
      }
      callback(null, chunk)
    },
  })

  await pipeline(Readable.from(body), meter, fs.createWriteStream(destPath), {
    signal: options.signal,
  })
  if (bytesDownloaded !== lastProgressBytes) {
    options.onProgress?.({ bytesDownloaded, totalBytes: options.totalBytes })
  }
  return { bytesDownloaded, sha256: hash.digest('hex') }
}
