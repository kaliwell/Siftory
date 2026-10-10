import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type {
  GenerationRecallReport,
  GenerationRecallVectorSource,
  RecallThresholds,
} from './vectorGenerationRecall'

/**
 * Host side of the recall observation worker (VAL-032). Mirrors the
 * vectorAnnWorkerHost contract — one active evaluation, a newer request
 * supersedes the in-flight one, cooperative cancellation through a
 * SharedArrayBuffer stop flag, and an unref'd idle timer recycles the worker
 * — but stays electron-free so the value-observation scripts (plain node)
 * can run the recall gate off their main thread too.
 */

export interface RecallWorkerEvaluateOptions {
  queryCount?: number
  topK?: number
  seed?: number
  thresholds?: RecallThresholds
  memoryCeilingBytes?: number
  matrixCacheDir?: string
}

export interface RecallWorkerHostOptions {
  isCancelled?: () => boolean
  onProgress?: (info: { phase: string; current: number; total: number }) => void
  /** Test/diagnostic override for the compiled worker bundle. */
  workerPath?: string
}

interface PendingEvaluation {
  stopView: Int32Array
  cancelPoll: ReturnType<typeof setInterval>
  resolve: (report: GenerationRecallReport) => void
  reject: (error: Error) => void
  onProgress?: (info: { phase: string; current: number; total: number }) => void
}

interface ActiveEvaluation {
  requestId: number
  pending: PendingEvaluation
}

let worker: Worker | null = null
let nextRequestId = 1
let active: ActiveEvaluation | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let workerPathOverride: string | undefined
const WORKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000

function defaultWorkerPath(): string {
  const local = path.join(__dirname, 'vectorGenerationRecallWorker.js')
  if (fs.existsSync(local)) return local
  return path.join(__dirname, '..', 'dist-electron', 'vectorGenerationRecallWorker.js')
}

function resolveWorkerPath(): string {
  const resolved = workerPathOverride ?? defaultWorkerPath()
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Recall worker bundle is missing: ${resolved}; run npm run build:renderer first`,
    )
  }
  return resolved
}

function clearIdleTimer(): void {
  if (!idleTimer) return
  clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleStop(): void {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (!active && worker) void stopWorker(new Error('Recall worker idle timeout'))
  }, WORKER_IDLE_TIMEOUT_MS)
  idleTimer.unref()
}

function settleActive(finish: (pending: PendingEvaluation) => void): void {
  const current = active
  if (!current) return
  active = null
  clearInterval(current.pending.cancelPoll)
  finish(current.pending)
}

function stopWorker(error: Error): Promise<number> | undefined {
  clearIdleTimer()
  const currentWorker = worker
  worker = null
  settleActive((pending) => pending.reject(error))
  return currentWorker?.terminate()
}

function ensureWorker(): Worker {
  if (worker) return worker
  const created = new Worker(resolveWorkerPath())
  worker = created
  created.on('message', (message: Record<string, unknown>) => {
    if (!active || message.requestId !== active.requestId) return
    if (message.type === 'progress') {
      active.pending.onProgress?.({
        phase: String(message.phase),
        current: Number(message.current),
        total: Number(message.total),
      })
      return
    }
    if (message.type === 'result') {
      settleActive((pending) => pending.resolve(message.report as GenerationRecallReport))
      scheduleIdleStop()
      return
    }
    if (message.type === 'cancelled') {
      settleActive((pending) => pending.reject(new Error('Recall evaluation cancelled')))
      scheduleIdleStop()
      return
    }
    if (message.type === 'error') {
      settleActive((pending) => pending.reject(new Error(String(message.error || 'Recall error'))))
      scheduleIdleStop()
    }
  })
  created.once('error', (error) => {
    if (worker === created) void stopWorker(error)
  })
  created.once('exit', (code) => {
    if (worker === created) void stopWorker(new Error(`Recall worker exited (${code})`))
  })
  return created
}

/**
 * Run the recall gate inside the low-priority worker. A second call while
 * one is in flight stops and supersedes it, matching the observation
 * scheduler's "only the latest cycle matters" semantics.
 */
export function evaluateGenerationRecallInWorker(
  jsonlPaths: readonly string[],
  handle: GenerationRecallVectorSource,
  recallOptions: RecallWorkerEvaluateOptions = {},
  hostOptions: RecallWorkerHostOptions = {},
): Promise<GenerationRecallReport> {
  workerPathOverride = hostOptions.workerPath
  clearIdleTimer()
  if (active) {
    Atomics.store(active.pending.stopView, 0, 1)
    settleActive((pending) => pending.reject(new Error('Recall evaluation superseded')))
  }
  const requestId = nextRequestId++
  const stopBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const stopView = new Int32Array(stopBuffer)
  // Check once synchronously: an already-cancelled caller must not race the
  // first 20 ms poll and slip a full evaluation through.
  if (hostOptions.isCancelled?.()) Atomics.store(stopView, 0, 1)
  return new Promise((resolve, reject) => {
    const cancelPoll = setInterval(() => {
      if (hostOptions.isCancelled?.()) Atomics.store(stopView, 0, 1)
    }, 20)
    cancelPoll.unref()
    active = {
      requestId,
      pending: { stopView, cancelPoll, resolve, reject, onProgress: hostOptions.onProgress },
    }
    try {
      ensureWorker().postMessage({
        type: 'evaluate',
        requestId,
        jsonlPaths: [...jsonlPaths],
        handle,
        options: recallOptions,
        stopBuffer,
      })
    } catch (error) {
      settleActive((pending) =>
        pending.reject(error instanceof Error ? error : new Error(String(error))),
      )
    }
  })
}

export async function disposeVectorGenerationRecallWorker(): Promise<void> {
  await stopWorker(new Error('Recall worker disposed'))
}
