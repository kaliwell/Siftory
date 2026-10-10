export interface EmbeddingInferenceRateInput {
  completed: number
  failed: number
  pending: number
  running: number
  state: string
  inferenceStartedAt?: number
  inferencePausedAt?: number
  inferencePausedTotalMs?: number
  now?: number
}

export interface EmbeddingInferenceRate {
  itemsPerSecond: number
  etaMs?: number
  activeElapsedMs: number
}

export function calculateEmbeddingInferenceRate(
  input: EmbeddingInferenceRateInput,
): EmbeddingInferenceRate {
  if (!input.inferenceStartedAt) {
    return { itemsPerSecond: 0, activeElapsedMs: 0 }
  }
  const now = input.now ?? Date.now()
  const currentPauseMs = input.inferencePausedAt ? Math.max(0, now - input.inferencePausedAt) : 0
  const activeElapsedMs = Math.max(
    0,
    now -
      input.inferenceStartedAt -
      Math.max(0, input.inferencePausedTotalMs || 0) -
      currentPauseMs,
  )
  const processed = Math.max(0, input.completed + input.failed)
  const itemsPerSecond =
    activeElapsedMs > 0 && processed > 0 ? processed / (activeElapsedMs / 1000) : 0
  const remaining = Math.max(0, input.pending + input.running)
  const etaMs =
    input.state === 'running' && itemsPerSecond > 0
      ? Math.round((remaining / itemsPerSecond) * 1000)
      : undefined
  return {
    itemsPerSecond: Number.isFinite(itemsPerSecond) ? itemsPerSecond : 0,
    etaMs,
    activeElapsedMs,
  }
}
