import { performance } from 'perf_hooks'
import type { EmbeddingProgress } from '../shared/vectorTypes'
import {
  addEmbeddingBatchMetrics,
  addEmbeddingPersistenceEnqueued,
  addEmbeddingPersistenceFinished,
  embeddingStageMetricsEnabled,
  type EmbeddingWorkerBatchMetrics,
} from './embeddingChildLineFraming'
import { calculateEmbeddingInferenceRate } from './embeddingProgressRate'
import { emitRuntimeMemoryTrace } from './runtimeMemoryTrace'

export function embeddingProcessMemorySnapshot(): Record<string, number> {
  const usage = process.memoryUsage()
  return {
    rssMb: Math.round(usage.rss / 1024 / 1024),
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(usage.heapTotal / 1024 / 1024),
    externalMb: Math.round(usage.external / 1024 / 1024),
  }
}

export function recordEmbeddingBatchRuntime(input: {
  metrics: EmbeddingWorkerBatchMetrics
  runId: string
  provider: string
  stageMetrics: EmbeddingProgress['stageMetrics']
}): EmbeddingProgress['stageMetrics'] {
  for (const [stage, durationMs] of [
    ['decode', input.metrics.decodeNormalizeMs],
    ['preprocess', input.metrics.preprocessMs],
    ['inference', input.metrics.inferenceMs],
  ] as const) {
    emitRuntimeMemoryTrace({
      runId: input.runId,
      stage,
      phase: 'point',
      model: input.metrics.model,
      provider: input.provider || 'unknown',
      durationMs,
      metrics: {
        batchSize: input.metrics.batchSize,
        tensorBytes: input.metrics.tensorBytes,
        temporaryTensorBytes: input.metrics.temporaryTensorBytes,
        decodedPixelBytes: input.metrics.decodedPixelBytes,
        rssBytes: input.metrics.rssBytes,
        privateBytes: input.metrics.privateBytes,
        externalBytes: input.metrics.externalBytes,
        arrayBuffersBytes: input.metrics.arrayBuffersBytes,
        fallback: input.metrics.fallback,
      },
    })
  }
  return embeddingStageMetricsEnabled()
    ? addEmbeddingBatchMetrics(input.stageMetrics!, input.metrics)
    : input.stageMetrics
}

export function recordEmbeddingPersistenceEnqueuedRuntime(
  stageMetrics: EmbeddingProgress['stageMetrics'],
  pendingPersistence: number,
): EmbeddingProgress['stageMetrics'] {
  return embeddingStageMetricsEnabled()
    ? addEmbeddingPersistenceEnqueued(stageMetrics!, pendingPersistence)
    : stageMetrics
}

export function recordEmbeddingPersistenceFinishedRuntime(input: {
  startedAt: number
  runId: string
  model: string
  provider: string
  pendingPersistence: number
  stageMetrics: EmbeddingProgress['stageMetrics']
}): EmbeddingProgress['stageMetrics'] {
  const elapsedMs = Math.max(0, performance.now() - input.startedAt)
  emitRuntimeMemoryTrace({
    runId: input.runId,
    stage: 'commit',
    phase: 'point',
    model: input.model || 'unknown',
    provider: input.provider || 'unknown',
    durationMs: elapsedMs,
    metrics: { pendingPersistence: input.pendingPersistence },
  })
  return embeddingStageMetricsEnabled()
    ? addEmbeddingPersistenceFinished(input.stageMetrics!, elapsedMs)
    : input.stageMetrics
}

export function nextEmbeddingProgress(
  current: EmbeddingProgress,
  patch: Partial<EmbeddingProgress>,
  timing: {
    inferenceStartedAt?: number
    inferencePausedAt?: number
    inferencePausedTotalMs: number
    now?: number
  },
): EmbeddingProgress {
  const next = { ...current, ...patch }
  if (next.startedAt) {
    const now = timing.now ?? Date.now()
    const rate = calculateEmbeddingInferenceRate({
      completed: next.completed,
      failed: next.failed,
      pending: next.pending,
      running: next.running,
      state: next.state,
      inferenceStartedAt: timing.inferenceStartedAt,
      inferencePausedAt: timing.inferencePausedAt,
      inferencePausedTotalMs: timing.inferencePausedTotalMs,
      now,
    })
    next.elapsedMs = Math.max(0, now - next.startedAt)
    next.itemsPerSecond = rate.itemsPerSecond
    next.etaMs = rate.etaMs
  }
  next.running = Math.max(0, next.running)
  next.pending = Math.max(0, next.pending)
  return next
}
