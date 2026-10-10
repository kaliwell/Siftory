import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Worker } from 'worker_threads'
import { app } from 'electron'
import {
  embeddingF16CacheSourceFingerprint,
  type EmbeddingF16CacheHandle,
} from './embeddingF16Cache'
import { requireNormalizedEmbeddingVector } from './embeddingVectorValidation'
import { createRuntimeMemoryChildRunId, emitRuntimeMemoryTrace } from './runtimeMemoryTrace'

export interface VectorAnnSearchProgress {
  phase: 'building'
  current: number
  total: number
  percent: number
  elapsedMs?: number
}

export interface VectorAnnSearchResult {
  results: Array<{ path: string; row: number; score: number }>
  /** Present only for a multi-center request; scope/index loading is shared. */
  queryResults?: Array<{
    results: Array<{ path: string; row: number; score: number }>
    candidateCount: number
  }>
  candidateCount: number
  indexedCount: number
  built: boolean
  buildMode: 'none' | 'incremental' | 'full'
  snapshotLoadMode: 'none' | 'metadata-only' | 'delta-only' | 'full'
  vectorBytesRead: number
  pathBytesRead: number
  reusedVectorBytes: number
  loadMs: number
  searchMs: number
  memory?: VectorAnnOwnedMemoryStats
}

export interface VectorAnnOwnedMemoryStats {
  vectorBytes: number
  signatureBytes: number
  projectionBytes: number
  projectionMetadataBytes: number
  pathUtf8Bytes: number
  pathSlotBytesApprox: number
  metadataBytesApprox: number
  totalOwnedBytesApprox: number
  rowCount: number
}

export interface VectorAnnRuntimeMemorySnapshot {
  workerResident: boolean
  lifecycleState: VectorAnnWorkerLifecycleState
  lifecycleGeneration: number
  lifecycleReason: string
  lifecycleChangedAt: number
  lateMessageCount: number
  residentModel: string | null
  residentKey: string | null
  activeKind: 'search' | 'prewarm' | null
  queuedPrewarm: boolean
  memoryPressureReleasePending: boolean
  idleTimerScheduled: boolean
  owned: VectorAnnOwnedMemoryStats | null
}

export type VectorAnnWorkerLifecycleState = 'absent' | 'loading' | 'active' | 'idle' | 'disposing'

interface PendingSearch {
  stopView: Int32Array
  cancelPoll: ReturnType<typeof setInterval>
  resolve: (result: VectorAnnSearchResult) => void
  reject: (error: Error) => void
  onProgress?: (progress: VectorAnnSearchProgress) => void
}

export interface VectorAnnPrewarmOptions {
  isCancelled?: () => boolean
  onProgress?: (progress: VectorAnnSearchProgress) => void
}

export interface VectorAnnSearchOptions {
  isCancelled?: () => boolean
  onProgress?: (progress: VectorAnnSearchProgress) => void
  /** Scope snapshot applied inside the worker before topK selection. */
  acceptPathKeys?: readonly string[]
  /** Optional bounded recall budget. Omit to use the production Image Search default. */
  candidateRatio?: number
}

interface ActiveRequest {
  requestId: number
  kind: 'search' | 'prewarm'
  cacheKey?: string
  promise?: Promise<VectorAnnSearchResult>
  pending: PendingSearch
  traceRunId: string | null
  modelName: string
}

interface QueuedPrewarm {
  key: string
  cache: EmbeddingF16CacheHandle
  options: VectorAnnPrewarmOptions
  promise: Promise<VectorAnnSearchResult>
  resolve: (result: VectorAnnSearchResult) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let nextRequestId = 1
let active: ActiveRequest | null = null
let queuedPrewarm: QueuedPrewarm | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let idleTraceRunId: string | null = null
let lastOwnedMemory: VectorAnnOwnedMemoryStats | null = null
let lastResidentModel: string | null = null
let lastResidentCacheKey: string | null = null
let lifecycleState: VectorAnnWorkerLifecycleState = 'absent'
let lifecycleGeneration = 0
let lifecycleReason = 'initial'
let lifecycleChangedAt = Date.now()
let lateMessageCount = 0
let memoryPressureReleasePending = false
const WORKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000
let workerIdleTimeoutMs = WORKER_IDLE_TIMEOUT_MS

function transitionLifecycle(next: VectorAnnWorkerLifecycleState, reason: string): void {
  lifecycleState = next
  lifecycleReason = reason.slice(0, 80)
  lifecycleChangedAt = Date.now()
}

function annCacheKey(cache: EmbeddingF16CacheHandle): string {
  return `${cache.vectorPath}:${embeddingF16CacheSourceFingerprint(cache)}`
}

function safeResidentKey(key: string | null): string | null {
  return key ? crypto.createHash('sha256').update(key).digest('hex') : null
}

function replacementReason(currentModel: string | null | undefined, nextModel: string): string {
  return currentModel && currentModel !== nextModel ? 'model-switch' : 'generation-switch'
}

function prepareIdleWorkerForCache(cache: EmbeddingF16CacheHandle, key: string): void {
  if (!active && worker && lastResidentCacheKey && lastResidentCacheKey !== key) {
    const reason = replacementReason(lastResidentModel, cache.meta.modelName)
    stopWorker(new Error(`ANN worker released for ${reason}`), reason)
  }
}

function workerPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'vectorAnnWorker.js')
  const local = path.join(__dirname, 'vectorAnnWorker.js')
  if (fs.existsSync(local)) return local
  return path.join(__dirname, '..', 'dist-electron', 'vectorAnnWorker.js')
}

function settleActive(finish: (pending: PendingSearch) => void, startQueued = true): void {
  const current = active
  if (!current) return
  active = null
  clearInterval(current.pending.cancelPoll)
  finish(current.pending)
  if (startQueued) startQueuedPrewarm()
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (idleTraceRunId) {
    emitRuntimeMemoryTrace({ runId: idleTraceRunId, stage: 'idle', phase: 'cancel' })
    idleTraceRunId = null
  }
}

function scheduleIdleStop(): void {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (!active && worker) {
      const runId = idleTraceRunId
      idleTraceRunId = null
      if (runId) {
        emitRuntimeMemoryTrace({
          runId,
          stage: 'idle',
          phase: 'finish',
          model: lastResidentModel || 'unknown',
          provider: 'node-worker',
        })
      }
      stopWorker(new Error('ANN worker idle timeout'), 'idle-timeout')
    }
  }, workerIdleTimeoutMs)
  idleTimer.unref()
  idleTraceRunId = createRuntimeMemoryChildRunId('ann-idle')
  if (idleTraceRunId) {
    emitRuntimeMemoryTrace({
      runId: idleTraceRunId,
      stage: 'idle',
      phase: 'start',
      model: lastResidentModel || 'unknown',
      provider: 'node-worker',
      metrics: { timeoutMs: workerIdleTimeoutMs },
    })
  }
}

function stopWorker(error: Error, reason = 'dispose'): void {
  if (!worker && !active && !queuedPrewarm) {
    clearIdleTimer()
    lastOwnedMemory = null
    lastResidentModel = null
    transitionLifecycle('absent', `${reason}:already-absent`)
    return
  }
  const traceRunId = createRuntimeMemoryChildRunId('ann-dispose')
  const disposedModel = lastResidentModel || active?.modelName || 'unknown'
  if (traceRunId) {
    emitRuntimeMemoryTrace({
      runId: traceRunId,
      stage: 'dispose',
      phase: 'start',
      model: disposedModel,
      provider: 'node-worker',
    })
  }
  clearIdleTimer()
  const currentWorker = worker
  const stoppedGeneration = lifecycleGeneration
  transitionLifecycle('disposing', reason)
  worker = null
  lastOwnedMemory = null
  lastResidentModel = null
  lastResidentCacheKey = null
  memoryPressureReleasePending = false
  const queued = queuedPrewarm
  queuedPrewarm = null
  if (active?.traceRunId) {
    emitRuntimeMemoryTrace({
      runId: active.traceRunId,
      stage: active.kind,
      phase: 'cancel',
      model: active.modelName,
      provider: 'node-worker',
    })
  }
  settleActive((pending) => pending.reject(error), false)
  queued?.reject(error)
  const finishDisposeTrace = () => {
    if (traceRunId) {
      emitRuntimeMemoryTrace({
        runId: traceRunId,
        stage: 'dispose',
        phase: 'finish',
        model: disposedModel,
        provider: 'node-worker',
      })
    }
  }
  if (currentWorker) {
    void currentWorker
      .terminate()
      .catch(() => undefined)
      .finally(() => {
        if (worker === null && lifecycleGeneration === stoppedGeneration) {
          transitionLifecycle('absent', `${reason}:terminated`)
        }
        finishDisposeTrace()
      })
  } else {
    transitionLifecycle('absent', `${reason}:no-worker`)
    finishDisposeTrace()
  }
}

function ensureWorker(): Worker {
  if (worker) return worker
  lifecycleGeneration += 1
  transitionLifecycle('loading', 'worker-create')
  const created = new Worker(workerPath())
  worker = created
  created.on('message', (message: Record<string, unknown>) => {
    if (worker !== created || !active || message.requestId !== active.requestId) {
      lateMessageCount += 1
      return
    }
    if (message.type === 'progress') {
      active.pending.onProgress?.(message as unknown as VectorAnnSearchProgress)
      return
    }
    if (message.type === 'result') {
      const result = message.result as VectorAnnSearchResult
      lastOwnedMemory = result.memory ?? null
      lastResidentModel = active.modelName
      lastResidentCacheKey = active.cacheKey ?? null
      const traceRunId = active.traceRunId
      if (traceRunId) {
        if (active.kind === 'search') {
          emitRuntimeMemoryTrace({
            runId: traceRunId,
            stage: 'rerank',
            phase: 'finish',
            durationMs: result.searchMs,
            model: active.modelName,
            provider: 'node-worker',
            metrics: { candidateCount: result.candidateCount, indexedCount: result.indexedCount },
          })
        }
        emitRuntimeMemoryTrace({
          runId: traceRunId,
          stage: active.kind,
          phase: 'finish',
          durationMs: result.loadMs + result.searchMs,
          model: active.modelName,
          provider: 'node-worker',
        })
      }
      settleActive((pending) => pending.resolve(result))
      if (!active) {
        if (memoryPressureReleasePending) {
          memoryPressureReleasePending = false
          stopWorker(new Error('ANN worker released for memory pressure'), 'memory-pressure')
        } else {
          transitionLifecycle('idle', 'request-completed')
          scheduleIdleStop()
        }
      }
      return
    }
    if (message.type === 'cancelled') {
      if (active.traceRunId) {
        emitRuntimeMemoryTrace({
          runId: active.traceRunId,
          stage: active.kind,
          phase: 'cancel',
          model: active.modelName,
          provider: 'node-worker',
        })
      }
      settleActive((pending) => pending.reject(new Error('ANN search cancelled')))
      if (!active) {
        if (memoryPressureReleasePending) {
          memoryPressureReleasePending = false
          stopWorker(new Error('ANN worker released for memory pressure'), 'memory-pressure')
        } else {
          transitionLifecycle('idle', 'request-cancelled')
          scheduleIdleStop()
        }
      }
      return
    }
    if (message.type === 'error') {
      if (active.traceRunId) {
        emitRuntimeMemoryTrace({
          runId: active.traceRunId,
          stage: active.kind,
          phase: 'error',
          model: active.modelName,
          provider: 'node-worker',
        })
      }
      settleActive((pending) => pending.reject(new Error(String(message.error || 'ANN error'))))
      if (!active) {
        if (memoryPressureReleasePending) {
          memoryPressureReleasePending = false
          stopWorker(new Error('ANN worker released for memory pressure'), 'memory-pressure')
        } else {
          transitionLifecycle('idle', 'request-error')
          scheduleIdleStop()
        }
      }
    }
  })
  created.once('online', () => {
    if (worker === created && !active) transitionLifecycle('idle', 'worker-online')
  })
  created.once('error', (error) => {
    if (worker === created) stopWorker(error, 'worker-error')
  })
  created.once('exit', (code) => {
    if (worker === created) stopWorker(new Error(`ANN worker exited (${code})`), 'worker-exit')
  })
  return created
}

function submitVectorAnnSearch(
  cache: EmbeddingF16CacheHandle,
  payload:
    | { type: 'search'; queryVector: number[]; topK: number }
    | { type: 'search-batch'; queryVectors: number[][]; topK: number },
  options: VectorAnnSearchOptions,
): Promise<VectorAnnSearchResult> {
  const key = annCacheKey(cache)
  clearIdleTimer()
  if (active?.cacheKey && active.cacheKey !== key) {
    const reason = replacementReason(active.modelName, cache.meta.modelName)
    stopWorker(new Error(`ANN request replaced for ${reason}`), reason)
  } else {
    prepareIdleWorkerForCache(cache, key)
  }
  if (active) {
    if (active.traceRunId) {
      emitRuntimeMemoryTrace({
        runId: active.traceRunId,
        stage: active.kind,
        phase: 'cancel',
        model: active.modelName,
        provider: 'node-worker',
      })
    }
    Atomics.store(active.pending.stopView, 0, 1)
    settleActive((pending) => pending.reject(new Error('ANN search superseded')), false)
  }
  const requestId = nextRequestId++
  const traceRunId = createRuntimeMemoryChildRunId('ann-search')
  if (traceRunId) {
    emitRuntimeMemoryTrace({
      runId: traceRunId,
      stage: 'search',
      phase: 'start',
      model: cache.meta.modelName,
      provider: 'node-worker',
    })
  }
  const stopBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const stopView = new Int32Array(stopBuffer)
  return new Promise((resolve, reject) => {
    const cancelPoll = setInterval(() => {
      if (options.isCancelled?.()) Atomics.store(stopView, 0, 1)
    }, 20)
    cancelPoll.unref()
    const targetWorker = ensureWorker()
    active = {
      requestId,
      kind: 'search',
      cacheKey: key,
      traceRunId,
      modelName: cache.meta.modelName,
      pending: { stopView, cancelPoll, resolve, reject, onProgress: options.onProgress },
    }
    transitionLifecycle('active', 'search-start')
    try {
      targetWorker.postMessage({
        ...payload,
        requestId,
        cache,
        stopBuffer,
        ...(options.acceptPathKeys ? { acceptPathKeys: [...options.acceptPathKeys] } : {}),
        ...(options.candidateRatio !== undefined ? { candidateRatio: options.candidateRatio } : {}),
      })
    } catch (error) {
      settleActive((pending) =>
        pending.reject(error instanceof Error ? error : new Error(String(error))),
      )
      if (!active && worker) {
        transitionLifecycle('idle', 'search-post-error')
        scheduleIdleStop()
      }
    }
  })
}

export function searchVectorAnn(
  cache: EmbeddingF16CacheHandle,
  queryVector: Float32Array | number[],
  topK: number,
  options: VectorAnnSearchOptions = {},
): Promise<VectorAnnSearchResult> {
  try {
    return submitVectorAnnSearch(
      cache,
      {
        type: 'search',
        queryVector: requireNormalizedEmbeddingVector(queryVector, cache.meta.dim),
        topK,
      },
      options,
    )
  } catch (error) {
    return Promise.reject(error)
  }
}

export function searchVectorAnnBatch(
  cache: EmbeddingF16CacheHandle,
  queryVectors: readonly (Float32Array | number[])[],
  topK: number,
  options: VectorAnnSearchOptions = {},
): Promise<VectorAnnSearchResult> {
  try {
    if (queryVectors.length === 0 || queryVectors.length > 8) {
      throw new RangeError('ANN batch query count must be between 1 and 8')
    }
    return submitVectorAnnSearch(
      cache,
      {
        type: 'search-batch',
        queryVectors: queryVectors.map((query) =>
          requireNormalizedEmbeddingVector(query, cache.meta.dim),
        ),
        topK,
      },
      options,
    )
  } catch (error) {
    return Promise.reject(error)
  }
}

export function disposeVectorAnnWorker(): void {
  stopWorker(new Error('ANN worker disposed'), 'explicit-dispose')
}

export function requestVectorAnnMemoryPressureRelease(): {
  released: boolean
  deferred: boolean
} {
  if (!worker) return { released: false, deferred: false }
  if (active?.kind === 'search') {
    memoryPressureReleasePending = true
    if (queuedPrewarm) {
      queuedPrewarm.reject(new Error('ANN prewarm cancelled for memory pressure'))
      queuedPrewarm = null
    }
    return { released: false, deferred: true }
  }
  stopWorker(new Error('ANN worker released for memory pressure'), 'memory-pressure')
  return { released: true, deferred: false }
}

export function setVectorAnnWorkerIdleTimeoutForTests(timeoutMs: number): () => void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10 || timeoutMs > WORKER_IDLE_TIMEOUT_MS) {
    throw new RangeError('ANN worker test idle timeout must be between 10 ms and 5 minutes')
  }
  const previous = workerIdleTimeoutMs
  workerIdleTimeoutMs = Math.floor(timeoutMs)
  return () => {
    workerIdleTimeoutMs = previous
  }
}

export function getVectorAnnRuntimeMemorySnapshot(): VectorAnnRuntimeMemorySnapshot {
  return {
    workerResident: worker !== null,
    lifecycleState,
    lifecycleGeneration,
    lifecycleReason,
    lifecycleChangedAt,
    lateMessageCount,
    residentModel: lastResidentModel,
    residentKey: safeResidentKey(lastResidentCacheKey),
    activeKind: active?.kind ?? null,
    queuedPrewarm: queuedPrewarm !== null,
    memoryPressureReleasePending,
    idleTimerScheduled: idleTimer !== null,
    owned: lastOwnedMemory ? { ...lastOwnedMemory } : null,
  }
}

function startPrewarmRequest(
  cache: EmbeddingF16CacheHandle,
  options: VectorAnnPrewarmOptions,
  key: string,
): Promise<VectorAnnSearchResult> {
  clearIdleTimer()
  prepareIdleWorkerForCache(cache, key)
  const requestId = nextRequestId++
  const traceRunId = createRuntimeMemoryChildRunId('ann-prewarm')
  if (traceRunId) {
    emitRuntimeMemoryTrace({
      runId: traceRunId,
      stage: 'prewarm',
      phase: 'start',
      model: cache.meta.modelName,
      provider: 'node-worker',
    })
  }
  const stopBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const stopView = new Int32Array(stopBuffer)
  const promise = new Promise<VectorAnnSearchResult>((resolve, reject) => {
    const cancelPoll = setInterval(() => {
      if (options.isCancelled?.()) Atomics.store(stopView, 0, 1)
    }, 20)
    cancelPoll.unref()
    const targetWorker = ensureWorker()
    active = {
      requestId,
      kind: 'prewarm',
      cacheKey: key,
      traceRunId,
      modelName: cache.meta.modelName,
      pending: { stopView, cancelPoll, resolve, reject, onProgress: options.onProgress },
    }
    transitionLifecycle('active', 'prewarm-start')
    try {
      targetWorker.postMessage({ type: 'prewarm', requestId, cache, stopBuffer })
    } catch (error) {
      settleActive((pending) =>
        pending.reject(error instanceof Error ? error : new Error(String(error))),
      )
      if (!active && worker) {
        transitionLifecycle('idle', 'prewarm-post-error')
        scheduleIdleStop()
      }
    }
  })
  if (active?.kind === 'prewarm' && active.requestId === requestId) active.promise = promise
  return promise
}

function startQueuedPrewarm(): void {
  if (active || !worker || !queuedPrewarm) return
  const next = queuedPrewarm
  queuedPrewarm = null
  startPrewarmRequest(next.cache, next.options, next.key).then(next.resolve, next.reject)
}

/**
 * VAL-031 background index warm-up. Runs the worker's ensureLoaded path so a
 * later real search finds the index already loaded. Low priority by design:
 * a real search always supersedes an in-flight prewarm, while a prewarm
 * requested during a search waits behind it instead of disturbing it.
 * Concurrent prewarms of the same cache generation share one request.
 */
export function prewarmVectorAnn(
  cache: EmbeddingF16CacheHandle,
  options: VectorAnnPrewarmOptions = {},
): Promise<VectorAnnSearchResult> {
  const key = annCacheKey(cache)
  if (active) {
    if (active.kind === 'prewarm') {
      if (active.cacheKey === key && active.promise) return active.promise
      // A newer generation's prewarm supersedes the stale one.
      if (active.traceRunId) {
        emitRuntimeMemoryTrace({
          runId: active.traceRunId,
          stage: 'prewarm',
          phase: 'cancel',
          model: active.modelName,
          provider: 'node-worker',
        })
      }
      stopWorker(
        new Error('ANN prewarm superseded'),
        replacementReason(active.modelName, cache.meta.modelName),
      )
    } else {
      if (queuedPrewarm) {
        if (queuedPrewarm.key === key) return queuedPrewarm.promise
        queuedPrewarm.reject(new Error('ANN prewarm replaced'))
        queuedPrewarm = null
      }
      let resolveQueued!: (result: VectorAnnSearchResult) => void
      let rejectQueued!: (error: Error) => void
      const promise = new Promise<VectorAnnSearchResult>((resolve, reject) => {
        resolveQueued = resolve
        rejectQueued = reject
      })
      queuedPrewarm = { key, cache, options, promise, resolve: resolveQueued, reject: rejectQueued }
      return promise
    }
  }
  return startPrewarmRequest(cache, options, key)
}
