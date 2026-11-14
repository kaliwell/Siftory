import { ScanResponsiveness } from './scanResponsiveness'

type Sink = (id: string, event: string, detail: unknown) => void

/** Owns a user test session independently of scan start/stop or cancellation. */
export class PerformanceDiagnosticSession {
  recorder?: ScanResponsiveness
  private lastMarkAt = -Infinity
  private lastPhase = ''

  constructor(
    private sink: Sink,
    private environment: () => unknown,
  ) {}

  start(): ScanResponsiveness {
    if (this.recorder) return this.recorder
    this.recorder = new ScanResponsiveness(this.sink)
    this.lastMarkAt = -Infinity
    this.lastPhase = ''
    try {
      this.write('manual-test-start', this.environment())
    } catch {
      /* Optional metadata. */
    }
    return this.recorder
  }

  mark(): boolean {
    if (!this.recorder || performance.now() - this.lastMarkAt < 1000) return false
    this.lastMarkAt = performance.now()
    this.write('user-stutter-marker', {})
    return true
  }

  stop(): void {
    if (!this.recorder) return
    this.write('manual-test-stop', {})
    this.recorder.close()
    this.recorder = undefined
  }

  phase(state: string, indexedCount: number): void {
    if (!this.recorder || state === this.lastPhase) return
    this.lastPhase = state
    this.write('scan-state', { state, indexedCount })
  }

  private write(event: string, detail: unknown): void {
    try {
      if (this.recorder) this.sink(this.recorder.id, event, detail)
    } catch {
      /* Keep app usable if logging fails. */
    }
  }
}

/** A readable index into raw events, not a claim about the cause of a stall. */
export function summarizeResponsiveness(records: unknown[]) {
  let mainMaxDelayMs = 0,
    rendererMaxDelayMs = 0,
    frameMaxGapMs = 0,
    longTaskMaxMs = 0
  let markers = 0,
    mainWindows = 0,
    rendererWindows = 0,
    stallSignals = 0
  const stages = new Map<
    string,
    { name: string; maxSyncMs: number; maxMs: number; count: number }
  >()
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as { event?: string; detail?: Record<string, unknown> }
    const d = r.detail ?? {}
    const number = (v: unknown) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(v, 0) : 0
    if (r.event === 'user-stutter-marker') markers++
    if (r.event === 'stall-detected') stallSignals++
    if (r.event === 'preview-main-window' || r.event === 'preview-stage-window') {
      if (r.event === 'preview-main-window') {
        mainWindows++
        mainMaxDelayMs = Math.max(mainMaxDelayMs, number(d.maxTimerLagMs))
      }
      if (d.stages && typeof d.stages === 'object') {
        for (const [name, value] of Object.entries(d.stages)) {
          if (!value || typeof value !== 'object') continue
          const s = value as Record<string, unknown>
          const previous = stages.get(name) ?? { name, maxSyncMs: 0, maxMs: 0, count: 0 }
          previous.maxSyncMs = Math.max(previous.maxSyncMs, number(s.maxSyncMs))
          previous.maxMs = Math.max(previous.maxMs, number(s.maxMs))
          previous.count += number(s.count)
          stages.set(name, previous)
        }
      }
    }
    if (r.event === 'preview-renderer-window') {
      rendererWindows++
      rendererMaxDelayMs = Math.max(rendererMaxDelayMs, number(d.maxTimerLagMs))
      frameMaxGapMs = Math.max(frameMaxGapMs, number(d.maxFrameGapMs))
      longTaskMaxMs = Math.max(longTaskMaxMs, number(d.longTaskMaxMs))
    }
  }
  return {
    mainMaxDelayMs,
    rendererMaxDelayMs,
    frameMaxGapMs,
    longTaskMaxMs,
    markers,
    mainWindows,
    rendererWindows,
    stallSignals,
    slowestSynchronousSteps: [...stages.values()]
      .sort((a, b) => b.maxSyncMs - a.maxSyncMs)
      .slice(0, 10),
    interpretation:
      'Timer delay and long tasks are signals, not a root-cause diagnosis. Hidden windows are excluded from renderer sampling. Missing samples do not prove responsiveness. Nested step durations must not be added together.',
  }
}
