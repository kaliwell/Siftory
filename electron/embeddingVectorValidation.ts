export type EmbeddingVectorIssue =
  | 'invalid-container'
  | 'dimension-mismatch'
  | 'non-finite'
  | 'zero-norm'

export const MAX_EMBEDDING_VECTOR_DIM = 16_384

export type EmbeddingVectorValidationResult =
  | { ok: true; scale: number; scaledNorm: number }
  | {
      ok: false
      issue: EmbeddingVectorIssue
      expectedDim: number
      actualDim?: number
      index?: number
    }

export class EmbeddingVectorValidationError extends Error {
  readonly code = 'INVALID_EMBEDDING_VECTOR'

  constructor(readonly result: Extract<EmbeddingVectorValidationResult, { ok: false }>) {
    const detail =
      result.issue === 'invalid-container'
        ? 'expected a number array or Float32Array'
        : result.issue === 'dimension-mismatch'
          ? `expected ${result.expectedDim} dimensions, got ${result.actualDim ?? 'unknown'}`
          : result.issue === 'non-finite'
            ? `component ${result.index ?? 'unknown'} is not a finite number`
            : 'vector has an exact zero norm'
    super(`Invalid embedding vector: ${detail}`)
    this.name = 'EmbeddingVectorValidationError'
  }
}

/**
 * Validates and L2-normalizes an embedding without coercing values. Scaling by
 * the largest component keeps very small and very large finite vectors away
 * from underflow/overflow while preserving an exact-zero rejection rule.
 */
export function classifyEmbeddingVector(
  input: unknown,
  expectedDim: number,
): EmbeddingVectorValidationResult {
  if (
    !Number.isSafeInteger(expectedDim) ||
    expectedDim <= 0 ||
    expectedDim > MAX_EMBEDDING_VECTOR_DIM
  ) {
    throw new RangeError(
      `Embedding dimension must be a positive safe integer <= ${MAX_EMBEDDING_VECTOR_DIM}, got ${expectedDim}`,
    )
  }
  if (!Array.isArray(input) && !(input instanceof Float32Array)) {
    return { ok: false, issue: 'invalid-container', expectedDim }
  }
  if (input.length !== expectedDim) {
    return {
      ok: false,
      issue: 'dimension-mismatch',
      expectedDim,
      actualDim: input.length,
    }
  }

  let scale = 0
  for (let index = 0; index < expectedDim; index++) {
    const value: unknown = input[index]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, issue: 'non-finite', expectedDim, actualDim: input.length, index }
    }
    scale = Math.max(scale, Math.abs(value))
  }
  if (scale === 0) {
    return { ok: false, issue: 'zero-norm', expectedDim, actualDim: input.length }
  }

  let scaledNormSquared = 0
  for (let index = 0; index < expectedDim; index++) {
    const scaled = (input[index] as number) / scale
    scaledNormSquared += scaled * scaled
  }
  const scaledNorm = Math.sqrt(scaledNormSquared)
  return { ok: true, scale, scaledNorm }
}

/** Backwards-compatible name for the allocation-free classifier. */
export const validateEmbeddingVector = classifyEmbeddingVector

export function isValidEmbeddingVector(input: unknown, expectedDim: number): boolean {
  return classifyEmbeddingVector(input, expectedDim).ok
}

export function requireNormalizedEmbeddingVector(input: unknown, expectedDim: number): number[] {
  const result = classifyEmbeddingVector(input, expectedDim)
  if (!result.ok) throw new EmbeddingVectorValidationError(result)
  const values = input as number[] | Float32Array
  const normalized = new Array<number>(expectedDim)
  for (let index = 0; index < expectedDim; index++) {
    normalized[index] = values[index] / result.scale / result.scaledNorm
  }
  return normalized
}

export function requireNormalizedEmbeddingVectorFloat32(
  input: unknown,
  expectedDim: number,
): Float32Array {
  const result = classifyEmbeddingVector(input, expectedDim)
  if (!result.ok) throw new EmbeddingVectorValidationError(result)
  const values = input as number[] | Float32Array
  const normalized = new Float32Array(expectedDim)
  for (let index = 0; index < expectedDim; index++) {
    normalized[index] = values[index] / result.scale / result.scaledNorm
  }
  return normalized
}
