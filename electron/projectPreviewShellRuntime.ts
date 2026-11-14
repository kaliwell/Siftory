import { fork, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

type OwnedChild = {
  child: ChildProcess
  cleanup: () => Promise<void>
  ready?: boolean
  retiring?: Promise<void>
}
export interface ShellPreviewMetrics {
  childPid?: number
  durationMs: number
  queueMs: number
  outcome: string
  durations: Record<string, number>
  errorCode?: string
  activeStep?: string
  activeStepMs?: number
}
export interface ShellPreviewOptions {
  isCancelled?: () => boolean
  timeoutMs?: number
  onMetrics?: (metrics: ShellPreviewMetrics) => void
}
const failure = (code: string) => Object.assign(new Error(code), { code })
let diagnosticSink: ((metrics: ShellPreviewMetrics) => void) | undefined
export function setShellPreviewDiagnosticSink(sink: (metrics: ShellPreviewMetrics) => void): void {
  diagnosticSink = sink
}

async function launchShellChild(nonce: string): Promise<OwnedChild> {
  const { app } = await import('electron')
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'siftory-shell-preview-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SIFTORY_SHELL_PREVIEW_NONCE: nonce,
    SIFTORY_SHELL_PREVIEW_PROFILE: profile,
  }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = fork(app.getAppPath(), [`--siftory-shell-preview=${nonce}`], {
      execPath: process.execPath,
      execArgv: [],
      env,
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    })
    return {
      child,
      cleanup: () =>
        fsp.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    }
  } catch (error) {
    await fsp.rm(profile, { recursive: true, force: true })
    throw error
  }
}

/** One reusable Electron process; no native Shell API is called in this host. */
export class ShellPreviewRuntime {
  private lane: Promise<unknown> = Promise.resolve()
  private slot?: OwnedChild
  private nonce = ''
  private idleTimer?: ReturnType<typeof setTimeout>
  private cancelActive?: () => Promise<void>
  private closed = false
  private sequence = 0
  private owned = new Set<OwnedChild>()
  private lastRun?: ShellPreviewMetrics

  constructor(private launch: (nonce: string) => Promise<OwnedChild> = launchShellChild) {}

  stats() {
    return {
      pids: [...this.owned].map((s) => s.child.pid),
      busy: !!this.cancelActive,
      lastRun: this.lastRun,
    }
  }

  terminateOwnedProcesses(): void {
    for (const slot of this.owned) {
      try {
        slot.child.kill('SIGKILL')
      } catch {
        /* Already exited. */
      }
    }
  }

  private retire(slot: OwnedChild): Promise<void> {
    if (slot.retiring) return slot.retiring
    if (this.slot === slot) this.slot = undefined
    slot.retiring = (async () => {
      const child = slot.child
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer)
            resolve()
          }
          const timer = setTimeout(() => {
            child.removeListener('exit', done)
            this.closed = true
            reject(failure('SHELL_PREVIEW_TERMINATION_FAILED'))
          }, 3000)
          child.once('exit', done)
          child.kill('SIGKILL')
        })
      }
      this.owned.delete(slot)
      await slot.cleanup()
    })()
    return slot.retiring
  }

  run(source: string, options: ShellPreviewOptions = {}): Promise<Buffer | null> {
    const enqueued = performance.now()
    const task = this.lane.then(async () => {
      if (this.closed || options.isCancelled?.()) throw failure('PROJECT_PREVIEW_CANCELLED')
      clearTimeout(this.idleTimer)
      // An idle crash/expiry must be reaped before a replacement is launched.
      await Promise.all([...this.owned].filter((s) => s.retiring).map((s) => s.retiring))
      if (this.closed || options.isCancelled?.()) throw failure('PROJECT_PREVIEW_CANCELLED')
      const started = performance.now()
      if (!this.slot) {
        this.nonce = crypto.randomBytes(16).toString('hex')
        this.slot = await this.launch(this.nonce)
        const slot = this.slot
        this.owned.add(slot)
        slot.child.on('error', () => {
          if (!this.cancelActive) void this.retire(slot).catch(() => {})
        })
        slot.child.once('exit', () => {
          void this.retire(slot).catch(() => {})
        })
      }
      const slot = this.slot
      const child = slot.child
      child.ref()
      child.channel?.ref()
      const requestId = ++this.sequence
      const nonce = this.nonce
      return new Promise<Buffer | null>((resolve, reject) => {
        let settled = false
        let sent = false
        let stepStarted = performance.now()
        const metrics: ShellPreviewMetrics = {
          childPid: child.pid,
          durationMs: 0,
          queueMs: started - enqueued,
          outcome: 'error',
          durations: {},
        }
        const finish = async (error?: Error, bytes: Buffer | null = null) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          clearInterval(cancelTimer)
          child.removeListener('message', message)
          child.removeListener('exit', exit)
          child.removeListener('error', fail)
          this.cancelActive = undefined
          if (error) {
            metrics.errorCode = (error as { code?: string }).code ?? 'SHELL_PREVIEW_PROCESS_ERROR'
            try {
              await this.retire(slot)
            } catch (retireError) {
              error = retireError as Error
            }
          } else {
            child.unref()
            child.channel?.unref()
            this.idleTimer = setTimeout(() => {
              void this.retire(slot).catch(() => {})
            }, 15_000)
            this.idleTimer.unref()
          }
          metrics.durationMs = performance.now() - started
          if (metrics.activeStep) metrics.activeStepMs = performance.now() - stepStarted
          this.lastRun = metrics
          try {
            if (options.onMetrics) options.onMetrics(metrics)
            else diagnosticSink?.(metrics)
          } catch {
            /* Logging cannot fail a preview. */
          }
          if (error) reject(error)
          else resolve(bytes)
        }
        const send = () => {
          if (sent || settled) return
          sent = true
          child.send({ nonce, requestId, source }, (error) => {
            if (error) void finish(error)
          })
        }
        const message = (raw: unknown) => {
          const m = raw as {
            nonce?: string
            kind?: string
            requestId?: number
            bytes?: unknown
            durations?: Record<string, unknown>
            outcome?: string
            name?: string
          }
          if (m?.nonce !== nonce) return
          if (
            m.kind === 'step' &&
            m.requestId === requestId &&
            ['stat', 'thumbnail', 'icon', 'compare', 'encode'].includes(m.name ?? '')
          ) {
            metrics.activeStep = m.name
            stepStarted = performance.now()
            return
          }
          if (m.kind === 'ready') {
            slot.ready = true
            send()
            return
          }
          if (m.kind !== 'result' || m.requestId !== requestId) return
          if (
            m.bytes !== null &&
            (!Buffer.isBuffer(m.bytes) || m.bytes.length > 16 * 1024 * 1024)
          ) {
            void finish(failure('SHELL_PREVIEW_INVALID_RESULT'))
            return
          }
          metrics.outcome = ['ready', 'unavailable', 'icon-only', 'source-limit', 'error'].includes(
            m.outcome ?? '',
          )
            ? m.outcome!
            : 'error'
          for (const name of ['stat', 'thumbnail', 'icon', 'compare', 'encode']) {
            const value = m.durations?.[name]
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
              metrics.durations[name] = value
          }
          void finish(undefined, m.bytes as Buffer | null)
        }
        const exit = () => void finish(failure('SHELL_PREVIEW_PROCESS_EXIT'))
        const fail = () => void finish(failure('SHELL_PREVIEW_PROCESS_ERROR'))
        const timeout = setTimeout(
          () => void finish(failure('SHELL_PREVIEW_TIMEOUT')),
          Math.max(1, (options.timeoutMs ?? 15_000) - (performance.now() - started)),
        )
        const cancel = () => finish(failure('PROJECT_PREVIEW_CANCELLED'))
        this.cancelActive = cancel
        const cancelTimer = setInterval(() => {
          if (options.isCancelled?.()) void cancel()
        }, 50)
        child.on('message', message)
        child.once('exit', exit)
        child.once('error', fail)
        if (this.closed || options.isCancelled?.()) void cancel()
        else if (slot.ready) send()
      })
    })
    this.lane = task.catch(() => {})
    return task
  }

  async stop(): Promise<void> {
    this.closed = true
    clearTimeout(this.idleTimer)
    await this.cancelActive?.()
    await this.lane
    await Promise.all([...this.owned].map((s) => this.retire(s)))
  }
}

const runtime = new ShellPreviewRuntime()
process.once('exit', () => runtime.terminateOwnedProcesses())
export const runShellPreviewCompute = (source: string, options?: ShellPreviewOptions) =>
  process.platform === 'win32' ? runtime.run(source, options) : Promise.resolve(null)
export const stopShellPreviewCompute = () => runtime.stop()
