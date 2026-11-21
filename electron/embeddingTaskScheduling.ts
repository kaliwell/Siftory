import type { RuntimeOperationResult } from '../shared/runtimeErrors'
import type { EmbeddingProgress, VectorBuildRequest } from '../shared/vectorTypes'
import {
  failActiveEmbeddingBuild,
  finishQueuedEmbeddingBuild,
  getEmbeddingProgress,
  onEmbeddingProgress,
  reserveEmbeddingBuild,
  startEmbeddingBuild,
} from './embeddingService'
import type { UnifiedTaskSubmitter } from './unifiedTaskSubmission'

export interface EmbeddingTaskSchedulingDeps {
  reserve: (request: VectorBuildRequest) => RuntimeOperationResult
  start: (
    request: VectorBuildRequest,
    options: { acceptQueuedReservation: true; preferCudaForAutoClip?: boolean },
  ) => Promise<RuntimeOperationResult>
  getProgress: () => EmbeddingProgress
  onProgress: (callback: (progress: EmbeddingProgress) => void) => () => void
  finishQueued: (error?: unknown) => boolean
  failActive: (error: unknown) => boolean
}

export function createEmbeddingTaskScheduling(deps: EmbeddingTaskSchedulingDeps): {
  queue: (
    request: VectorBuildRequest,
    scheduler: UnifiedTaskSubmitter,
    manual?: boolean,
  ) => RuntimeOperationResult
  cancelQueued: () => boolean
} {
  let nextReservationId = 1
  let activeReservationId: number | null = null
  let queuedTask: {
    id: number
    reservationId: number
    scheduler: UnifiedTaskSubmitter
  } | null = null

  const waitForTerminal = (): Promise<void> => {
    const current = deps.getProgress()
    if (current.state === 'done' || current.state === 'error') return Promise.resolve()
    return new Promise<void>((resolve) => {
      const unsubscribe = deps.onProgress((next) => {
        if (next.state !== 'done' && next.state !== 'error') return
        unsubscribe()
        resolve()
      })
    })
  }

  const queue = (
    request: VectorBuildRequest,
    scheduler: UnifiedTaskSubmitter,
    manual = false,
  ): RuntimeOperationResult => {
    const reserved = deps.reserve(request)
    if (!reserved.ok) return reserved
    const reservationId = nextReservationId++
    activeReservationId = reservationId
    let startedByScheduler = false
    const handle = scheduler.enqueue({
      stage: 'embedding',
      ...(manual
        ? { priority: 2, manualEmbedding: request.backend === 'gpu' ? 'gpu' : 'cpu' }
        : {}),
      paths: request.imageIds ?? request.scanPaths ?? [],
      label: `embedding build: ${request.modelName}`,
      run: async () => {
        startedByScheduler = true
        queuedTask = null
        if (activeReservationId !== reservationId || deps.getProgress().state !== 'queued') {
          return
        }
        // Sample at admission, since system and video memory may change while queued.
        const useAutoGpu =
          manual &&
          request.backend === 'auto' &&
          (request.modelName === 'dinov2_vitb14' ||
            request.modelName === 'clip_vit_base_patch32') &&
          scheduler.selectAutoDinoBackend?.() === 'gpu'
        const executionRequest: VectorBuildRequest =
          useAutoGpu && request.modelName === 'dinov2_vitb14'
            ? {
                ...request,
                backend: 'gpu',
                maxConcurrentEmbeddings: 1,
                batchSize:
                  request.batchSize && request.batchSize < 4 ? request.batchSize : undefined,
              }
            : request
        const started = await deps.start(executionRequest, {
          acceptQueuedReservation: true,
          ...(useAutoGpu && request.modelName === 'clip_vit_base_patch32'
            ? { preferCudaForAutoClip: true }
            : {}),
        })
        if (!started.ok) {
          const error = started.error ?? started.runtimeError?.detail ?? 'Embedding build failed'
          deps.finishQueued(error)
          throw new Error(error)
        }
        await waitForTerminal()
        const terminal = deps.getProgress()
        if (terminal.state === 'error') throw new Error(terminal.error || 'Embedding build failed')
      },
    })
    if (!startedByScheduler) queuedTask = { id: handle.id, reservationId, scheduler }
    void handle.promise
      .catch((error) => {
        if (activeReservationId === reservationId && !deps.finishQueued(error)) {
          deps.failActive(error)
        }
      })
      .finally(() => {
        if (activeReservationId === reservationId) activeReservationId = null
      })
    return { ok: true }
  }

  const cancelQueued = (): boolean => {
    if (
      !queuedTask ||
      activeReservationId !== queuedTask.reservationId ||
      deps.getProgress().state !== 'queued'
    ) {
      return false
    }
    if (!queuedTask.scheduler.cancel?.(queuedTask.id)) return false
    queuedTask = null
    deps.finishQueued()
    return true
  }

  return { queue, cancelQueued }
}

const runtimeScheduling = createEmbeddingTaskScheduling({
  reserve: reserveEmbeddingBuild,
  start: startEmbeddingBuild,
  getProgress: getEmbeddingProgress,
  onProgress: onEmbeddingProgress,
  finishQueued: finishQueuedEmbeddingBuild,
  failActive: failActiveEmbeddingBuild,
})

export const queueEmbeddingBuild = runtimeScheduling.queue
export const cancelQueuedEmbeddingBuild = runtimeScheduling.cancelQueued
