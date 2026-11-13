import { fork, type ChildProcess, type ForkOptions } from 'child_process'
import { projectPreviewWorkerPaths } from './projectPreviewWorkerPaths'

const PDF_TIMEOUT_MS = 15_000
const PDF_MAX_RSS_BYTES = 512 * 1024 * 1024
let lane: Promise<unknown> = Promise.resolve()
const active = new Set<() => Promise<void>>()
let closing = false
let lastRun: { durationMs: number; peakRssBytes: number; errorCode?: string } | undefined
const childPids = new Set<number>()
let currentRssBytes = 0
let idleChild: ChildProcess | undefined
let idleTimer: ReturnType<typeof setTimeout> | undefined
const exiting = new Set<Promise<void>>()

process.once('exit', () => {
  idleChild?.kill()
})

function retire(child: ChildProcess) {
  const stopped = waitForExit(child)
  exiting.add(stopped)
  void stopped.finally(() => exiting.delete(stopped))
}

function park(child: ChildProcess) {
  idleChild = child
  const clearIdle = () => {
    if (idleChild === child) idleChild = undefined
  }
  child.once('exit', clearIdle)
  child.once('error', () => {
    clearIdle()
    retire(child)
  })
  child.unref()
  child.channel?.unref()
  idleTimer = setTimeout(() => {
    if (idleChild !== child) return
    idleChild = undefined
    retire(child)
  }, 15_000)
  idleTimer.unref()
}

export function getPdfPreviewRuntimeStats() {
  return {
    activePids: [...childPids],
    idlePid: idleChild?.pid,
    currentRssBytes,
    lastRun: lastRun ? { ...lastRun } : undefined,
  }
}

export interface PdfPreviewOptions {
  isCancelled?: () => boolean
  timeoutMs?: number
  maxRssBytes?: number
}

function failure(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
    // Only this runtime's owned process is terminated; worker threads share it.
    child.kill()
  })
}

export function runPdfPreviewCompute(
  input: unknown,
  options: PdfPreviewOptions = {},
): Promise<unknown> {
  const task = lane.then(async () => {
    if (closing || options.isCancelled?.()) throw failure('PROJECT_PREVIEW_CANCELLED')
    await Promise.all(exiting)
    if (closing || options.isCancelled?.()) throw failure('PROJECT_PREVIEW_CANCELLED')
    const setup = projectPreviewWorkerPaths()
    const childOptions: ForkOptions & { windowsHide: boolean } = {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    }
    clearTimeout(idleTimer)
    const reusable = idleChild
    idleChild = undefined
    const child =
      reusable?.connected && reusable.exitCode === null
        ? reusable
        : fork(setup.childPath, [], childOptions)
    if (reusable && child !== reusable) await waitForExit(reusable)
    child.removeAllListeners('error')
    child.removeAllListeners('exit')
    child.ref()
    child.channel?.ref()
    const startedAt = Date.now()
    let peakRssBytes = 0
    if (child.pid) childPids.add(child.pid)
    return new Promise((resolve, reject) => {
      let settled = false
      let result: unknown
      const finish = async (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        clearInterval(cancelTimer)
        active.delete(cancel)
        process.removeListener('exit', terminate)
        if (error) await waitForExit(child)
        if (child.pid) childPids.delete(child.pid)
        currentRssBytes = 0
        lastRun = {
          durationMs: Date.now() - startedAt,
          peakRssBytes,
          ...(error ? { errorCode: (error as { code?: string }).code ?? error.message } : {}),
        }
        child.removeListener('message', onMessage)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        if (!error && !closing) park(child)
        else if (!error) await waitForExit(child)
        if (error) reject(error)
        else resolve(result)
      }
      const cancel = async () => finish(failure('PROJECT_PREVIEW_CANCELLED'))
      const terminate = () => {
        child.kill()
      }
      const timeout = setTimeout(
        () => void finish(failure('PDF_PREVIEW_TIMEOUT')),
        options.timeoutMs ?? PDF_TIMEOUT_MS,
      )
      const cancelTimer = setInterval(() => {
        if (options.isCancelled?.()) void cancel()
      }, 50)
      active.add(cancel)
      process.once('exit', terminate)
      const onError = (error: Error) => void finish(error)
      const onExit = () => void finish(failure('PDF_PREVIEW_PROCESS_EXIT'))
      const onMessage = (message: {
        kind?: string
        rss?: number
        error?: string
        result?: unknown
      }) => {
        if (message.kind === 'memory') {
          currentRssBytes = Number(message.rss) || 0
          peakRssBytes = Math.max(peakRssBytes, Number(message.rss) || 0)
          if (Number(message.rss) > (options.maxRssBytes ?? PDF_MAX_RSS_BYTES))
            void finish(failure('PDF_PREVIEW_MEMORY_BUDGET'))
        } else if (message.kind === 'result') {
          result = message.result
          void finish(message.error ? failure('PDF_PREVIEW_DECODE_FAILED') : undefined)
        }
      }
      child.on('error', onError)
      child.on('exit', onExit)
      child.on('message', onMessage)
      child.send({ workerPath: setup.workerPath, workerData: setup.workerData, input }, (error) => {
        if (error) void finish(error)
      })
    })
  })
  lane = task.catch(() => {})
  return task
}

export async function stopPdfPreviewCompute(): Promise<void> {
  closing = true
  await Promise.all([...active].map((cancel) => cancel()))
  await lane
  clearTimeout(idleTimer)
  const child = idleChild
  idleChild = undefined
  if (child) await waitForExit(child)
  await Promise.all(exiting)
}
