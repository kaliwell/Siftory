import fs from 'node:fs/promises'
import path from 'node:path'
import type { GlobalHotkeyEntry } from '../shared/ipc-contract'
import type { WindowVisibilitySnapshot } from './windowVisibilityState'

const EVENT_CODES = [
  'initialized',
  'transition',
  'hidden',
  'prewarmed',
  'visible',
  'show-timeout',
  'fallback-without-shape',
  'stale-ack',
  'stale-mouse',
  'stale-shape',
  'shape-applied',
  'mouse-applied',
  'shape-failed',
  'mouse-failed',
  'recovery-failed',
  'hotkey-registered',
  'hotkey-conflicted',
  'hotkey-failed',
  'hotkey-disabled',
  'hotkey-repeat',
] as const
type EventCode = (typeof EVENT_CODES)[number]
const HOTKEY_IDS = [
  'toggle-primary',
  'toggle-legacy',
  'snap-panels',
  'show-all',
  'arrange-row',
  'arrange-grid',
  'arrange-column',
  'quit',
] as const
const STATES = ['visible', 'preparing-hide', 'hidden', 'preparing-show'] as const
const REASONS = ['hotkey', 'settings', 'second-instance', 'ai-control', 'recovery'] as const

interface DiagnosticDetails {
  hotkey?: GlobalHotkeyEntry['id']
  ignoreMouse?: boolean
  shapeCount?: number
}

interface DiagnosticEvent extends DiagnosticDetails {
  sequence: number
  at: number
  code: EventCode
  state: WindowVisibilitySnapshot['state']
  generation: number
  reason: WindowVisibilitySnapshot['reason']
}

/** Fixed-field diagnostics: no paths, accelerators, exception messages or renderer text. */
export class WindowVisibilityDiagnostics {
  private readonly events: DiagnosticEvent[] = []
  private readonly hotkeys = new Map<GlobalHotkeyEntry['id'], GlobalHotkeyEntry['status']>()
  private sequence = 0
  private revision = 0
  private persistedRevision = 0
  private writeFailures = 0
  private timer: NodeJS.Timeout | null = null
  private pendingWrite: Promise<void> | null = null
  private closed = false
  private readonly filePath: string
  private readonly startedAt = Date.now()

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'diagnostics', 'window-visibility.json')
  }

  record(code: EventCode, state: WindowVisibilitySnapshot, details: DiagnosticDetails = {}): void {
    if (this.closed || !EVENT_CODES.includes(code)) return
    const event: DiagnosticEvent = {
      sequence: ++this.sequence,
      at: Date.now(),
      code,
      state: STATES.includes(state.state) ? state.state : 'hidden',
      generation:
        Number.isSafeInteger(state.generation) && state.generation >= 0 ? state.generation : 0,
      reason: REASONS.includes(state.reason) ? state.reason : 'recovery',
    }
    if (HOTKEY_IDS.includes(details.hotkey!)) event.hotkey = details.hotkey
    if (typeof details.ignoreMouse === 'boolean') event.ignoreMouse = details.ignoreMouse
    if (Number.isSafeInteger(details.shapeCount) && details.shapeCount! >= 0) {
      event.shapeCount = Math.min(64, details.shapeCount!)
    }
    if (event.hotkey) {
      if (code === 'hotkey-registered') this.hotkeys.set(event.hotkey, 'registered')
      if (code === 'hotkey-conflicted' || code === 'hotkey-failed')
        this.hotkeys.set(event.hotkey, 'conflicted')
      if (code === 'hotkey-disabled') this.hotkeys.set(event.hotkey, 'disabled')
    }
    this.events.push(event)
    if (this.events.length > 128) this.events.shift()
    this.revision++
    this.scheduleWrite()
  }

  snapshot() {
    return {
      schemaVersion: 1,
      startedAt: this.startedAt,
      capacity: 128,
      totalEvents: this.sequence,
      droppedEvents: Math.max(0, this.sequence - this.events.length),
      writeFailures: this.writeFailures,
      hotkeys: [...this.hotkeys].map(([id, status]) => ({ id, status })),
      events: this.events.map((event) => ({ ...event })),
    }
  }

  private scheduleWrite(): void {
    if (this.timer || this.pendingWrite || this.closed) return
    // A fixed coalescing interval, not a debounce: continuous activity cannot starve persistence.
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, 1_000)
    this.timer.unref?.()
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pendingWrite) {
      await this.pendingWrite
      if (this.persistedRevision < this.revision) await this.flush()
      return
    }
    if (this.persistedRevision >= this.revision) return
    const revision = this.revision
    const payload = JSON.stringify(this.snapshot())
    this.pendingWrite = (async () => {
      const temporary = `${this.filePath}.tmp`
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true })
        await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
        await fs.rename(temporary, this.filePath)
        this.persistedRevision = revision
      } catch {
        // Best effort: diagnostics must never fail the window operation or leak an OS path.
        this.writeFailures++
        await fs.unlink(temporary).catch(() => {})
      }
    })()
    await this.pendingWrite
    this.pendingWrite = null
    // Retry only on new activity or an explicit flush; no idle retry loop on read-only disks.
    if (this.revision > revision && !this.closed) this.scheduleWrite()
  }

  async close(): Promise<void> {
    this.closed = true
    await this.flush()
  }
}
