export const EMBEDDING_TENSOR_PREFETCH_DEPTH = 1
export const EMBEDDING_TENSOR_PREFETCH_MAX_BATCH_SIZE = 16
export const EMBEDDING_TENSOR_PREFETCH_MAX_BYTES = 16 * 1024 * 1024
export const EMBEDDING_TENSOR_PREFETCH_MIN_FREE_BYTES = 1024 * 1024 * 1024

export interface EmbeddingTensorPrefetchDecisionInput {
  requested: boolean
  backend: 'cpu' | 'gpu' | 'cuda'
  paused: boolean
  stopping: boolean
  queueLength: number
  assignedTasks: number
  batchSize: number
  freeSystemMemoryBytes: number
}

export interface EmbeddingTensorPrefetchDecision {
  allowed: boolean
  reason:
    | 'enabled'
    | 'not-requested'
    | 'unsupported-backend'
    | 'paused'
    | 'stopping'
    | 'queue-empty'
    | 'invalid-batch-size'
    | 'lookahead-full'
    | 'low-system-memory'
}

export function embeddingTensorPrefetchRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REASONIX_EMBEDDING_TENSOR_PREFETCH === '1'
}

/**
 * Allows exactly one next batch per child. This policy is shared by the
 * production dispatcher and benchmarks so a candidate cannot silently use a
 * deeper queue during measurement than it would use in the application.
 */
export function decideEmbeddingTensorPrefetch(
  input: EmbeddingTensorPrefetchDecisionInput,
): EmbeddingTensorPrefetchDecision {
  if (!input.requested) return { allowed: false, reason: 'not-requested' }
  if (input.backend !== 'gpu') return { allowed: false, reason: 'unsupported-backend' }
  if (input.paused) return { allowed: false, reason: 'paused' }
  if (input.stopping) return { allowed: false, reason: 'stopping' }
  if (input.queueLength <= 0) return { allowed: false, reason: 'queue-empty' }
  if (
    !Number.isInteger(input.batchSize) ||
    input.batchSize < 1 ||
    input.batchSize > EMBEDDING_TENSOR_PREFETCH_MAX_BATCH_SIZE
  ) {
    return { allowed: false, reason: 'invalid-batch-size' }
  }
  if (input.assignedTasks < 1 || input.assignedTasks > input.batchSize) {
    return { allowed: false, reason: 'lookahead-full' }
  }
  if (
    !Number.isFinite(input.freeSystemMemoryBytes) ||
    input.freeSystemMemoryBytes < EMBEDDING_TENSOR_PREFETCH_MIN_FREE_BYTES
  ) {
    return { allowed: false, reason: 'low-system-memory' }
  }
  return { allowed: true, reason: 'enabled' }
}

/** Counts only typed-array payloads retained by processor tensors. */
export function embeddingTensorPayloadBytes(inputs: Record<string, unknown>): number {
  let total = 0
  for (const value of Object.values(inputs)) {
    if (!value || typeof value !== 'object') continue
    const data = (value as { data?: unknown }).data
    if (!ArrayBuffer.isView(data)) continue
    total += data.byteLength
    if (!Number.isSafeInteger(total) || total > EMBEDDING_TENSOR_PREFETCH_MAX_BYTES) return total
  }
  return total
}
