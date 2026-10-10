import type { EmbeddingBatchMode } from './embeddingBatchPolicy'
import { selectEmbeddingBatchSize, type EmbeddingMemorySnapshot } from './embeddingBatchPolicy'

const GIB = 1024 ** 3

export interface EmbeddingRuntimeResourceInput extends EmbeddingMemorySnapshot {
  backend: 'cpu' | 'gpu' | 'cuda'
  modelName: string
  batchMode: EmbeddingBatchMode
  currentBatchSize: number
  currentConcurrency: number
  providerConcurrencyLimit: number
  pressureReasons?: readonly string[]
}

export interface EmbeddingRuntimeResourceDecision {
  batchSize: number
  concurrency: number
  constrained: boolean
  reason: string
}

function positiveInteger(value: number, fallback = 1): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

/**
 * Computes the next embedding resource envelope from live whole-process RAM and
 * VRAM. Explicit/default batch choices remain immutable; only Auto is retuned.
 * The caller retires only idle workers, so a decision never interrupts a batch.
 */
export function decideEmbeddingRuntimeResources(
  input: EmbeddingRuntimeResourceInput,
): EmbeddingRuntimeResourceDecision {
  const pressure = new Set(input.pressureReasons ?? [])
  const freeRatio =
    input.totalSystemMemoryBytes > 0
      ? input.freeSystemMemoryBytes / input.totalSystemMemoryBytes
      : 0
  const hardPressure = pressure.has('memory') || pressure.has('vram')
  const limitedHeadroom =
    hardPressure ||
    input.freeSystemMemoryBytes < 4 * GIB ||
    freeRatio < 0.22 ||
    (input.freeVideoMemoryBytes !== undefined && input.freeVideoMemoryBytes < 2 * GIB)
  const highHeadroom =
    !limitedHeadroom &&
    input.freeSystemMemoryBytes >= 6 * GIB &&
    freeRatio >= 0.3 &&
    (input.freeVideoMemoryBytes === undefined || input.freeVideoMemoryBytes >= 3 * GIB)

  const providerLimit = positiveInteger(input.providerConcurrencyLimit)
  const currentConcurrency = positiveInteger(input.currentConcurrency)
  const concurrency =
    input.backend === 'gpu' && highHeadroom
      ? providerLimit
      : limitedHeadroom
        ? 1
        : Math.min(providerLimit, currentConcurrency)
  const batchSize =
    input.batchMode === 'auto'
      ? hardPressure
        ? 4
        : selectEmbeddingBatchSize({
            requestedBatchSize: 0,
            backend: input.backend,
            modelName: input.modelName,
            maxConcurrency: concurrency,
            freeSystemMemoryBytes: input.freeSystemMemoryBytes,
            totalSystemMemoryBytes: input.totalSystemMemoryBytes,
            freeVideoMemoryBytes: input.freeVideoMemoryBytes,
            totalVideoMemoryBytes: input.totalVideoMemoryBytes,
          }).batchSize
      : input.currentBatchSize

  return {
    batchSize,
    concurrency,
    constrained: limitedHeadroom,
    reason: hardPressure
      ? `pressure-${[...pressure].sort().join('+')}`
      : limitedHeadroom
        ? 'limited-live-headroom'
        : highHeadroom
          ? 'high-live-headroom'
          : 'stable-live-headroom',
  }
}
