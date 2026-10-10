// ── Host for the CLIP semantic vector search worker (VAL-028) ──
// Single worker, FIFO queue (a concurrent query waits instead of blocking the
// main process with the in-process scan), SharedArrayBuffer cancellation,
// idle recycling, and a per-worker scope cache so large scope snapshots are
// structured-cloned only when they actually change (VAL-035). Any worker
// failure rejects the request; semanticSearchService then falls back to the
// in-process exact scan, so a crashed or missing worker never breaks search.

import fs from 'fs'
import path from 'path'
import { Worker } from 'worker_threads'
import { app } from 'electron'
import type { EmbeddingF16CacheHandle } from './embeddingF16Cache'
import { requireNormalizedEmbeddingVector } from './embeddingVectorValidation'
import type { SemanticClipCandidate } from './semanticClipScan'

export interface SemanticVectorScanProgress {
  scanned: number
  total: number
  percent: number
}

export interface SemanticVectorScanOutcome {
  candidates: SemanticClipCandidate[]
  scanned: number
  total: number
  loadMs: number
  searchMs: number
  cacheReused: boolean
}

interface PendingScan {
  requestId: number
  cache: EmbeddingF16CacheHandle
  queryVector: number[]
  candidateK: number
  scopeKeys?: string[]
  stopBuffer: SharedArrayBuffer
  stopView: Int32Array
  cancelPoll: ReturnType<typeof setInterval> | null
  isCancelled?: () => boolean
  onProgress?: (progress: SemanticVectorScanProgress) => void
  resolve: (result: SemanticVectorScanOutcome) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let nextRequestId = 1
let active: PendingScan | null = null
const queue: PendingScan[] = []
let idleTimer: ReturnType<typeof setTimeout> | null = null
// Scope snapshot held by the current worker instance: resent only on change.
let sentScope: { id: number; keys: readonly string[] } | null = null
let nextScopeId = 1
const WORKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000

function workerPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'semanticVectorSearchWorker.js')
  const local = path.join(__dirname, 'semanticVectorSearchWorker.js')
  if (fs.existsSync(local)) return local
  return path.join(__dirname, '..', 'dist-electron', 'semanticVectorSearchWorker.js')
}

function sameScopeKeys(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
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
    if (!active && queue.length === 0 && worker) {
      stopWorker(new Error('Semantic vector worker idle timeout'))
    }
  }, WORKER_IDLE_TIMEOUT_MS)
  idleTimer.unref()
}

function finishScan(pending: PendingScan, finish: () => void): void {
  if (pending.cancelPoll) {
    clearInterval(pending.cancelPoll)
    pending.cancelPoll = null
  }
  finish()
}

function stopWorker(error: Error): void {
  clearIdleTimer()
  const currentWorker = worker
  worker = null
  sentScope = null
  if (active) {
    const pending = active
    active = null
    finishScan(pending, () => pending.reject(error))
  }
  while (queue.length > 0) {
    const pending = queue.shift()!
    finishScan(pending, () => pending.reject(error))
  }
  void currentWorker?.terminate()
}

function dispatchNext(): void {
  while (!active && worker && queue.length > 0) {
    const pending = queue.shift()!
    if (pending.isCancelled?.()) {
      finishScan(pending, () => pending.reject(new Error('Semantic search cancelled')))
      continue
    }
    // Only a dispatched request can establish a worker scope. A cancelled
    // queue item must not become the payload provider for later requests.
    const keys = pending.scopeKeys
    const reuseScope = keys && sentScope && sameScopeKeys(sentScope.keys, keys)
    const scope = keys ? (reuseScope ? sentScope! : { id: nextScopeId++, keys }) : null
    active = pending
    try {
      worker.postMessage({
        type: 'search',
        requestId: pending.requestId,
        cache: pending.cache,
        queryVector: pending.queryVector,
        candidateK: pending.candidateK,
        stopBuffer: pending.stopBuffer,
        scopeId: scope?.id ?? 0,
        ...(scope && !reuseScope ? { scopeKeys: scope.keys } : {}),
      })
      sentScope = scope
    } catch (error) {
      active = null
      sentScope = null
      finishScan(pending, () =>
        pending.reject(error instanceof Error ? error : new Error(String(error))),
      )
    }
  }
  if (!active && queue.length === 0) scheduleIdleStop()
}

function settleActive(finish: (pending: PendingScan) => void): void {
  const pending = active
  if (!pending) return
  active = null
  finishScan(pending, () => finish(pending))
  dispatchNext()
  if (!active && queue.length === 0) scheduleIdleStop()
}

function ensureWorker(): Worker {
  if (worker) return worker
  const created = new Worker(workerPath())
  worker = created
  sentScope = null
  // Never keep the host process alive solely for an idle worker; the idle
  // timer recycles it and dispose hooks terminate it on shutdown/reset.
  created.unref()
  created.on('message', (message: Record<string, unknown>) => {
    if (worker !== created || !active || message.requestId !== active.requestId) return
    if (message.type === 'progress') {
      active.onProgress?.({
        scanned: Number(message.scanned) || 0,
        total: Number(message.total) || 0,
        percent: Number(message.percent) || 0,
      })
      return
    }
    if (message.type === 'result') {
      settleActive((pending) => pending.resolve(message.result as SemanticVectorScanOutcome))
      return
    }
    if (message.type === 'cancelled') {
      sentScope = null
      settleActive((pending) => pending.reject(new Error('Semantic search cancelled')))
      return
    }
    if (message.type === 'error') {
      // Loading can fail before the worker consumes the supplied scope.
      sentScope = null
      settleActive((pending) =>
        pending.reject(new Error(String(message.error || 'Semantic vector worker error'))),
      )
    }
  })
  created.once('error', (error) => {
    if (worker === created) stopWorker(error)
  })
  created.once('exit', (code) => {
    if (worker === created) stopWorker(new Error(`Semantic vector worker exited (${code})`))
  })
  return created
}

export function searchSemanticVectorScan(
  cache: EmbeddingF16CacheHandle,
  queryVector: Float32Array | number[],
  candidateK: number,
  options: {
    isCancelled?: () => boolean
    onProgress?: (progress: SemanticVectorScanProgress) => void
    /** Normalized scope keys; undefined/empty accepts every row. */
    acceptPathKeys?: readonly string[]
  } = {},
): Promise<SemanticVectorScanOutcome> {
  let normalizedQuery: number[]
  try {
    normalizedQuery = requireNormalizedEmbeddingVector(queryVector, cache.meta.dim)
  } catch (error) {
    return Promise.reject(error)
  }
  clearIdleTimer()
  const requestId = nextRequestId++
  const stopBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const stopView = new Int32Array(stopBuffer)
  const scopeKeys = options.acceptPathKeys?.length ? [...options.acceptPathKeys] : undefined
  return new Promise((resolve, reject) => {
    const pending: PendingScan = {
      requestId,
      cache,
      queryVector: normalizedQuery,
      candidateK,
      scopeKeys,
      stopBuffer,
      stopView,
      cancelPoll: null,
      isCancelled: options.isCancelled,
      onProgress: options.onProgress,
      resolve,
      reject,
    }
    pending.cancelPoll = setInterval(() => {
      if (!options.isCancelled?.()) return
      Atomics.store(stopView, 0, 1)
      // A queued scan is rejected immediately instead of waiting for the
      // worker to finish the active request first.
      if (active !== pending) {
        const index = queue.indexOf(pending)
        if (index >= 0) {
          queue.splice(index, 1)
          finishScan(pending, () => pending.reject(new Error('Semantic search cancelled')))
          dispatchNext()
          if (!active && queue.length === 0) scheduleIdleStop()
        }
      }
    }, 20)
    pending.cancelPoll.unref()
    queue.push(pending)
    try {
      ensureWorker()
      dispatchNext()
    } catch (error) {
      stopWorker(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export function disposeSemanticVectorSearchWorker(): void {
  stopWorker(new Error('Semantic vector worker disposed'))
}
