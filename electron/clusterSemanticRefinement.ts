export interface SemanticSeed {
  center: Float32Array
  sum: Float64Array
  count: number
}

function cosine(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index++) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  const denominator = Math.sqrt(leftNorm * rightNorm)
  return denominator > 0 ? dot / denominator : -1
}

function normalize(values: Float64Array): Float32Array {
  let normSquared = 0
  for (const value of values) normSquared += value * value
  const norm = Math.sqrt(normSquared)
  const result = new Float32Array(values.length)
  if (norm > 0)
    for (let index = 0; index < values.length; index++) result[index] = values[index] / norm
  return result
}

export function bestSemanticSeed(
  vector: Float32Array,
  seeds: SemanticSeed[],
): {
  index: number
  similarity: number
} {
  if (seeds.length === 0) return { index: -1, similarity: -1 }
  let index = 0
  let similarity = cosine(vector, seeds[0].center)
  for (let candidate = 1; candidate < seeds.length; candidate++) {
    const score = cosine(vector, seeds[candidate].center)
    if (score > similarity) {
      index = candidate
      similarity = score
    }
  }
  return { index, similarity }
}

export function observeSemanticSeed(
  seeds: SemanticSeed[],
  vector: Float32Array,
  splitSimilarity: number,
  maxSeeds: number,
): number {
  const match = bestSemanticSeed(vector, seeds)
  if (match.index < 0 || (match.similarity < splitSimilarity && seeds.length < maxSeeds)) {
    seeds.push({
      center: vector.slice(),
      sum: Float64Array.from(vector),
      count: 1,
    })
    return seeds.length - 1
  }
  const target = seeds[match.index]
  target.count += 1
  for (let index = 0; index < vector.length; index++) target.sum[index] += vector[index]
  target.center = normalize(target.sum)
  return match.index
}
