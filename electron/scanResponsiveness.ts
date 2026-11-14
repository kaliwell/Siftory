import { randomUUID } from 'node:crypto'

type Sink = (id: string, event: string, detail: unknown) => void
type Source = { ordinal: number; extension: string }
type Stage = {
  count: number
  totalMs: number
  maxMs: number
  maxSyncMs: number
  slowestSource?: Source
  mostBlockingSource?: Source
}

/** Numeric, bounded scan telemetry. No source paths, names, or image bytes. */
export class ScanResponsiveness {
  readonly id = randomUUID()
  private stages = new Map<string, Stage>()
  private pending = new Map<number, string>()
  private sequence = 0
  private maxLagMs = 0
  private lastTick = performance.now()
  private lastFlush = this.lastTick
  private timer: ReturnType<typeof setInterval>
  private closed = false
  private context: Source | undefined
  private lastRendererAt = -Infinity

  constructor(private sink: Sink) {
    this.write('preview-scan-start', {})
    this.timer = setInterval(() => {
      const now = performance.now()
      this.maxLagMs = Math.max(this.maxLagMs, now - this.lastTick - 200)
      this.lastTick = now
      if (now - this.lastFlush >= 5000) this.flush()
    }, 200)
    this.timer.unref()
  }

  source(ordinal: number, extension: string): void {
    this.context = { ordinal, extension: /^\.[a-z0-9]{1,12}$/i.test(extension) ? extension : '' }
  }

  measure<T>(name: string, operation: () => T): T {
    const start = performance.now()
    const source = this.context
    const token = ++this.sequence
    this.pending.set(token, name)
    let syncMs = 0
    const finish = () => {
      this.pending.delete(token)
      if (this.closed) return
      const ms = performance.now() - start
      const stage = this.stages.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, maxSyncMs: 0 }
      stage.count++
      stage.totalMs += ms
      if (ms > stage.maxMs) stage.slowestSource = source
      if (syncMs > stage.maxSyncMs) stage.mostBlockingSource = source
      stage.maxMs = Math.max(stage.maxMs, ms)
      stage.maxSyncMs = Math.max(stage.maxSyncMs, syncMs)
      this.stages.set(name, stage)
    }
    try {
      const result = operation()
      syncMs = performance.now() - start
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            finish()
            return value
          },
          (error) => {
            finish()
            throw error
          },
        ) as T
      }
      finish()
      return result
    } catch (error) {
      syncMs = performance.now() - start
      finish()
      throw error
    }
  }

  renderer(value: unknown): boolean {
    if (this.closed || !value || typeof value !== 'object') return false
    const input = value as Record<string, unknown>
    const keys = ['elapsedMs', 'maxTimerLagMs', 'maxFrameGapMs', 'longTaskCount', 'longTaskMaxMs']
    if (
      Object.keys(input).length !== keys.length ||
      keys.some(
        (key) =>
          typeof input[key] !== 'number' ||
          !Number.isFinite(input[key]) ||
          (input[key] as number) < 0 ||
          (input[key] as number) > 86_400_000,
      )
    )
      return false
    const now = performance.now()
    if (now - this.lastRendererAt < 1000) return false
    this.lastRendererAt = now
    this.write('preview-renderer-window', Object.fromEntries(keys.map((key) => [key, input[key]])))
    if ((input.maxTimerLagMs as number) >= 100 || (input.longTaskMaxMs as number) >= 100)
      this.write('stall-detected', { thread: 'renderer', ...input })
    return true
  }

  private write(event: string, detail: unknown): void {
    try {
      this.sink(this.id, event, detail)
    } catch {
      /* Diagnostics must never interrupt a scan. */
    }
  }

  event(name: string, detail: unknown): void {
    if (!this.closed) this.write(name, { source: this.context, detail })
  }

  checkpoint(): void {
    if (!this.closed) this.flush()
  }

  private flush(): void {
    const now = performance.now()
    const maxTimerLagMs = Math.max(this.maxLagMs, now - this.lastTick - 200, 0)
    if (maxTimerLagMs >= 100)
      this.write('stall-detected', {
        thread: 'main',
        maxTimerLagMs,
        source: this.context,
        pendingStages: [...this.pending.values()],
      })
    this.write('preview-main-window', {
      elapsedMs: now - this.lastFlush,
      maxTimerLagMs,
      pendingStages: [...this.pending.values()],
      source: this.context,
      stages: Object.fromEntries(this.stages),
    })
    this.lastFlush = now
    this.lastTick = now
    this.maxLagMs = 0
    this.stages.clear()
  }

  close(): void {
    if (this.closed) return
    this.flush()
    this.closed = true
    clearInterval(this.timer)
    this.write('preview-scan-end', {})
  }
}
