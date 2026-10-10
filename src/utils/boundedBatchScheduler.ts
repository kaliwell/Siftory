export interface BoundedBatchSchedulerOptions<Input, Output> {
  batchSize: number
  delayMs: number
  keyOf: (input: Input) => string
  loadBatch: (inputs: Input[]) => Promise<ReadonlyMap<string, Output>>
  maxQueued: number
}

interface Subscriber<Output> {
  resolve: (value: Output | null) => void
  signal?: AbortSignal
  abort?: () => void
}

interface QueueEntry<Input, Output> {
  input: Input
  key: string
  priority: number
  sequence: number
  state: 'queued' | 'inflight'
  subscribers: Set<Subscriber<Output>>
}

/**
 * Bounded, de-duplicating batch scheduler for viewport-driven work.
 * Queued requests with no subscribers are removed, and queue pressure evicts
 * the oldest lowest-priority work before it can consume backend resources.
 */
export class BoundedBatchScheduler<Input, Output> {
  private readonly entries = new Map<string, QueueEntry<Input, Output>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private loading = false
  private sequence = 0

  constructor(private readonly options: BoundedBatchSchedulerOptions<Input, Output>) {}

  request(
    input: Input,
    options: { priority?: number; signal?: AbortSignal } = {},
  ): Promise<Output | null> {
    if (options.signal?.aborted) return Promise.resolve(null)
    const key = this.options.keyOf(input)
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        input,
        key,
        priority: options.priority ?? 0,
        sequence: ++this.sequence,
        state: 'queued',
        subscribers: new Set(),
      }
      this.entries.set(key, entry)
    } else if (entry.state === 'queued') {
      entry.priority = Math.max(entry.priority, options.priority ?? 0)
    }

    const promise = new Promise<Output | null>((resolve) => {
      const subscriber: Subscriber<Output> = { resolve, signal: options.signal }
      const abort = () => {
        this.finishSubscriber(entry as QueueEntry<Input, Output>, subscriber, null)
        if (entry?.state === 'queued' && entry.subscribers.size === 0) this.entries.delete(key)
      }
      subscriber.abort = abort
      options.signal?.addEventListener('abort', abort, { once: true })
      entry?.subscribers.add(subscriber)
    })

    this.enforceQueueLimit()
    this.schedule()
    return promise
  }

  queuedCount(): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.state === 'queued') count += 1
    return count
  }

  clearQueued(): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.state !== 'queued') continue
      this.entries.delete(entry.key)
      this.finishEntry(entry, null)
    }
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(): void {
    if (this.loading || this.timer !== null || this.queuedCount() === 0) return
    this.timer = setTimeout(
      () => {
        this.timer = null
        void this.flush()
      },
      Math.max(0, this.options.delayMs),
    )
  }

  private enforceQueueLimit(): void {
    const maxQueued = Math.max(1, this.options.maxQueued)
    while (this.queuedCount() > maxQueued) {
      const candidate = [...this.entries.values()]
        .filter((entry) => entry.state === 'queued')
        .sort((a, b) => a.priority - b.priority || a.sequence - b.sequence)[0]
      if (!candidate) break
      this.entries.delete(candidate.key)
      this.finishEntry(candidate, null)
    }
  }

  private async flush(): Promise<void> {
    if (this.loading) return
    const entries = [...this.entries.values()]
      .filter((entry) => entry.state === 'queued' && entry.subscribers.size > 0)
      .sort((a, b) => b.priority - a.priority || a.sequence - b.sequence)
      .slice(0, Math.max(1, this.options.batchSize))
    if (entries.length === 0) return
    this.loading = true
    for (const entry of entries) entry.state = 'inflight'
    try {
      const outputs = await this.options.loadBatch(entries.map((entry) => entry.input))
      for (const entry of entries) this.finishEntry(entry, outputs.get(entry.key) ?? null)
    } catch {
      for (const entry of entries) this.finishEntry(entry, null)
    } finally {
      for (const entry of entries) this.entries.delete(entry.key)
      this.loading = false
      this.schedule()
    }
  }

  private finishEntry(entry: QueueEntry<Input, Output>, value: Output | null): void {
    for (const subscriber of [...entry.subscribers]) this.finishSubscriber(entry, subscriber, value)
  }

  private finishSubscriber(
    entry: QueueEntry<Input, Output>,
    subscriber: Subscriber<Output>,
    value: Output | null,
  ): void {
    if (!entry.subscribers.delete(subscriber)) return
    if (subscriber.abort && subscriber.signal) {
      subscriber.signal.removeEventListener('abort', subscriber.abort)
    }
    subscriber.resolve(value)
  }
}
