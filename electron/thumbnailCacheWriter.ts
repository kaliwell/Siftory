import fsp from 'fs/promises'
import { BoundedAsyncQueue } from './boundedAsyncQueue'

interface ThumbnailCacheWrite {
  destination: string
  dataUrl: string
}

/**
 * Bounded write-behind queue used by bulk thumbnail rebuilds.
 *
 * Generators only wait when the queue reaches capacity. File writes happen on
 * independent lanes, keeping synchronous NTFS work out of the Electron main
 * thread while still bounding retained data URLs.
 */
export class ThumbnailCacheWriter {
  private readonly queue: BoundedAsyncQueue<ThumbnailCacheWrite>
  private readonly workers: Array<Promise<void>>
  private acceptedCount = 0
  private completedCount = 0
  private failedCount = 0
  private closed = false

  constructor(
    concurrency = 2,
    capacity = 32,
    private readonly writeFile: (destination: string, dataUrl: string) => Promise<void> = async (
      destination,
      dataUrl,
    ) => {
      await fsp.writeFile(destination, dataUrl, 'utf8')
    },
  ) {
    const laneCount = Math.max(1, Math.floor(concurrency))
    this.queue = new BoundedAsyncQueue<ThumbnailCacheWrite>(Math.max(laneCount, capacity))
    this.workers = Array.from({ length: laneCount }, () => this.runWorker())
  }

  get depth(): number {
    return this.queue.size
  }

  get accepted(): number {
    return this.acceptedCount
  }

  get completed(): number {
    return this.completedCount
  }

  get failed(): number {
    return this.failedCount
  }

  async enqueue(destination: string, dataUrl: string): Promise<boolean> {
    if (this.closed) return false
    const accepted = await this.queue.push({ destination, dataUrl })
    if (accepted) this.acceptedCount += 1
    return accepted
  }

  async closeAndDrain(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.queue.close()
    }
    await Promise.all(this.workers)
  }

  private async runWorker(): Promise<void> {
    for (;;) {
      const item = await this.queue.take()
      if (!item) return
      try {
        await this.writeFile(item.destination, item.dataUrl)
        this.completedCount += 1
      } catch {
        // Thumbnail caching is best effort. A later request can regenerate it.
        this.failedCount += 1
      }
    }
  }
}
