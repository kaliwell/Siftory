import crypto from 'node:crypto'
import path from 'node:path'
import { redactDiagnosticText } from './diagnosticRedaction'

export interface NativeFailurePage {
  generation: number
  cursor: number
  total: number
  retained: number
  omitted: number
  counts: Record<string, number>
  entries: { code: string; source: string; message: string }[]
}
type Sink = (id: string, event: string, detail: unknown) => void
export class ScanErrorRecorder {
  private sink: Sink = () => {}
  private settle: () => Promise<void> = async () => {}
  private ready: () => boolean = () => true
  private id = crypto.randomUUID()
  private key = crypto.randomBytes(32)
  private paths = new Map<string, string>()
  private pathBytes = 0
  private pending: Record<string, unknown>[] = []
  private counts: Record<string, number> = {}
  private generation = -1
  private cursor = 0
  private nativeSummary?: Omit<NativeFailurePage, 'entries'>
  private stored = 0
  private omittedPaths = 0
  private activeDrain?: { generation: number; promise: Promise<void> }

  configure(sink: Sink, settle?: () => Promise<void>, ready?: () => boolean): void {
    this.sink = sink
    if (settle) this.settle = settle
    if (ready) this.ready = ready
  }
  begin(reader?: (cursor: number, limit: number) => NativeFailurePage): void {
    this.flush()
    this.id = crypto.randomUUID()
    this.counts = {}
    this.cursor = 0
    this.nativeSummary = undefined
    try {
      this.generation = reader ? reader(0, 1).generation : -1
    } catch (error) {
      this.generation = -1
      this.record('diagnostics', 'COLLECTION_FAILED', undefined, error)
    }
    this.write('scan-start', { nativeDetailsSupported: !!reader })
  }
  record(
    stage: string,
    code: string,
    source?: string,
    error?: unknown,
    severity = 'error',
    details?: unknown,
  ): void {
    const safeCode = /^[A-Za-z0-9_:-]{1,80}$/.test(code) ? code : 'UNKNOWN_ERROR'
    this.counts[`${stage}:${safeCode}`] = (this.counts[`${stage}:${safeCode}`] ?? 0) + 1
    let sourceId: string | undefined
    if (source) {
      sourceId = crypto
        .createHmac('sha256', this.key)
        .update(process.platform === 'win32' ? source.toLowerCase() : source)
        .digest('hex')
        .slice(0, 24)
      if (!this.paths.has(sourceId)) {
        const bytes = Buffer.byteLength(source)
        if (this.paths.size < 8192 && this.pathBytes + bytes <= 8 * 1024 * 1024) {
          this.paths.set(sourceId, source)
          this.pathBytes += bytes
        } else this.omittedPaths++
      }
    }
    const reason = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    this.pending.push({
      at: new Date().toISOString(),
      stage,
      code: safeCode,
      severity,
      sourceId,
      extension: source ? path.extname(source).toLowerCase().slice(0, 16) : undefined,
      reason: redactDiagnosticText(reason, 512),
      details,
    })
    this.stored++
    if (this.pending.length >= 8) this.flush()
  }
  collect(reader: (cursor: number, limit: number) => NativeFailurePage): boolean {
    if (!this.ready()) return false
    let page: NativeFailurePage
    try {
      page = reader(this.cursor, 128)
    } catch (error) {
      this.record('diagnostics', 'COLLECTION_FAILED', undefined, error)
      return false
    }
    if (page.generation !== this.generation) return false
    if (
      !Array.isArray(page.entries) ||
      page.entries.length > 128 ||
      !Number.isSafeInteger(page.cursor) ||
      (page.entries.length > 0 && page.cursor <= this.cursor)
    ) {
      this.record('diagnostics', 'INVALID_FAILURE_PAGE')
      return false
    }
    for (const item of page.entries)
      this.record('native-scan', item.code, item.source, item.message, 'skipped')
    this.cursor = page.cursor
    this.nativeSummary = {
      generation: page.generation,
      cursor: page.cursor,
      total: page.total,
      retained: page.retained,
      omitted: page.omitted,
      counts: page.counts,
    }
    return page.cursor < page.retained && page.entries.length > 0
  }
  drain(reader: (cursor: number, limit: number) => NativeFailurePage): Promise<void> {
    if (this.activeDrain?.generation === this.generation) return this.activeDrain.promise
    const job = { generation: this.generation, promise: this.finishDrain(reader) }
    this.activeDrain = job
    void job.promise
      .finally(() => {
        if (this.activeDrain === job) this.activeDrain = undefined
      })
      .catch(() => {})
    return job.promise
  }
  async waitForCollection(): Promise<void> {
    await this.activeDrain?.promise
  }
  private async finishDrain(
    reader: (cursor: number, limit: number) => NativeFailurePage,
  ): Promise<void> {
    const generation = this.generation
    while (generation === this.generation) {
      await this.settle()
      if (generation !== this.generation) return
      if (!this.ready()) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
        continue
      }
      if (!this.collect(reader)) break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (generation !== this.generation) return
    this.write('native-scan-summary', this.nativeSummary ?? { unavailable: true })
    this.flush()
    await this.settle()
  }
  flush(): void {
    if (!this.pending.length) return
    const items = this.pending
    this.pending = []
    this.write('file-failures', { items })
  }
  status() {
    return {
      capturedThisSession: this.stored,
      counts: this.counts,
      nativeSummary: this.nativeSummary,
      omittedPaths: this.omittedPaths,
    }
  }
  pathMappings(include: boolean) {
    return include ? Object.fromEntries(this.paths) : undefined
  }
  private write(event: string, detail: unknown): void {
    try {
      this.sink(this.id, event, detail)
    } catch {
      /* Error collection must not abort indexing. */
    }
  }
}

export const scanErrorRecorder = new ScanErrorRecorder()
