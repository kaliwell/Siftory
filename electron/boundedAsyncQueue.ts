/**
 * Small reusable bounded queue for independent async pipeline stages.
 * Producers pause only when the queue reaches capacity; consumers never wait
 * for every item in a producer batch to finish.
 */
export class BoundedAsyncQueue<T> {
  private readonly items: T[] = []
  private readonly takers: Array<(item: T | undefined) => void> = []
  private readonly pushWaiters: Array<() => void> = []
  private closed = false

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`Invalid async queue capacity: ${capacity}`)
    }
  }

  get size(): number {
    return this.items.length
  }

  async push(item: T): Promise<boolean> {
    while (!this.closed && this.items.length >= this.capacity) {
      await new Promise<void>((resolve) => this.pushWaiters.push(resolve))
    }
    if (this.closed) return false
    const taker = this.takers.shift()
    if (taker) taker(item)
    else this.items.push(item)
    return true
  }

  async take(): Promise<T | undefined> {
    const item = this.items.shift()
    if (item !== undefined) {
      this.pushWaiters.shift()?.()
      return item
    }
    if (this.closed) return undefined
    return new Promise<T | undefined>((resolve) => this.takers.push(resolve))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const resolve of this.takers.splice(0)) resolve(undefined)
    for (const resolve of this.pushWaiters.splice(0)) resolve()
  }
}

export interface BoundedLruCacheStats {
  entries: number
  totalWeight: number
  maxEntries: number
  maxWeight: number
}

/**
 * In-memory LRU constrained by both entry count and a caller-supplied weight.
 * The weight is normally an estimated UTF-8 byte count. Oversized values are
 * returned to the caller but deliberately not retained by this cache.
 */
export class BoundedLruCache<K, V> {
  private readonly entries = new Map<K, { value: V; weight: number }>()
  private retainedWeight = 0

  constructor(
    readonly maxEntries: number,
    readonly maxWeight: number,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error(`Invalid LRU entry limit: ${maxEntries}`)
    }
    if (!Number.isSafeInteger(maxWeight) || maxWeight < 1) {
      throw new Error(`Invalid LRU weight limit: ${maxWeight}`)
    }
  }

  get size(): number {
    return this.entries.size
  }

  get totalWeight(): number {
    return this.retainedWeight
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: K, value: V, weight: number): boolean {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new Error(`Invalid LRU entry weight: ${weight}`)
    }

    this.delete(key)
    if (weight > this.maxWeight) return false

    this.entries.set(key, { value, weight })
    this.retainedWeight += weight
    this.evictToBudget()
    return this.entries.has(key)
  }

  delete(key: K): boolean {
    const existing = this.entries.get(key)
    if (!existing) return false
    this.entries.delete(key)
    this.retainedWeight = Math.max(0, this.retainedWeight - existing.weight)
    return true
  }

  clear(): void {
    this.entries.clear()
    this.retainedWeight = 0
  }

  stats(): BoundedLruCacheStats {
    return {
      entries: this.entries.size,
      totalWeight: this.retainedWeight,
      maxEntries: this.maxEntries,
      maxWeight: this.maxWeight,
    }
  }

  private evictToBudget(): void {
    while (this.entries.size > this.maxEntries || this.retainedWeight > this.maxWeight) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.delete(oldest.value)
    }
  }
}
