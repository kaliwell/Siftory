import { requireNormalizedEmbeddingVector } from './embeddingVectorValidation'

export function normalizeEmbeddingVector(values: number[], expectedDim = values.length): number[] {
  return requireNormalizedEmbeddingVector(values, expectedDim)
}

export function poolDinoEmbedding(
  data: ArrayLike<number>,
  dims: number[] | undefined,
  dim: number,
  batchIndex = 0,
): number[] {
  if (!dims || dims.length < 3) {
    if (batchIndex !== 0 || data.length !== dim) {
      throw new Error(`DINO output shape is missing for ${data.length} values and dim ${dim}`)
    }
    return normalizeEmbeddingVector(Array.from(data), dim)
  }

  const tokenCount = dims[dims.length - 2]
  const hiddenSize = dims[dims.length - 1]
  const batchCount = dims.length >= 3 ? dims[dims.length - 3] : 1
  if (
    !Number.isInteger(tokenCount) ||
    tokenCount <= 0 ||
    !Number.isInteger(hiddenSize) ||
    hiddenSize !== dim ||
    !Number.isInteger(batchCount) ||
    batchCount <= 0 ||
    batchIndex < 0 ||
    batchIndex >= batchCount ||
    data.length !== batchCount * tokenCount * hiddenSize
  ) {
    throw new Error(
      `DINO output shape mismatch: ${dims.join('x')} with ${data.length} values for dim ${dim}`,
    )
  }

  const startToken = tokenCount > 1 ? 1 : 0
  const usedTokens = Math.max(1, tokenCount - startToken)
  const batchOffset = batchIndex * tokenCount * hiddenSize
  const pooled = new Array(dim).fill(0)
  for (let token = startToken; token < tokenCount; token++) {
    const base = batchOffset + token * hiddenSize
    for (let index = 0; index < dim; index++) {
      const value: unknown = data[base + index]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`DINO output component ${base + index} is not finite`)
      }
      pooled[index] += value
    }
  }
  for (let index = 0; index < dim; index++) pooled[index] /= usedTokens
  return normalizeEmbeddingVector(pooled, dim)
}
