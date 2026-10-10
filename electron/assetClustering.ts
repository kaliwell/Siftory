export interface CompressedAssetVectorBucket {
  key?: number
  count: number
  sum: Float64Array
  assetIds: number[]
}

export interface CompressedAssetCluster {
  members: Array<{ assetId: number; similarity: number }>
  avgSimilarity: number
  representativeAssetId: number
  centroid: Float32Array
  bucketKeys: number[]
  compressedAssetCount: number
}

export interface CompressedAssetClusteringResult {
  clusters: CompressedAssetCluster[]
  unclusteredAssets: number
}

interface BucketPoint {
  bucket: CompressedAssetVectorBucket
  centroid: Float32Array
}

interface ClusterOptions {
  maxClusters: number
  minSimilarity: number
  iterations?: number
  includeMembers?: boolean
  isCancelled?: () => boolean
  onProgress?: (progress: number, message: string) => void
}

export function estimateAdaptiveClusterCount(
  buckets: Array<Pick<CompressedAssetVectorBucket, 'count'>>,
  options: { minClusterSize: number; maxClusters?: number },
): number {
  const counts = buckets.map((bucket) => Math.max(0, bucket.count)).filter((count) => count > 0)
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (total <= 0 || counts.length <= 1) return Math.min(2, Math.max(1, counts.length))

  let entropy = 0
  for (const count of counts) {
    const probability = count / total
    entropy -= probability * Math.log(probability)
  }
  const normalizedEntropy = Math.max(0, Math.min(1, entropy / Math.log(counts.length)))
  const sizeBase = 0.42 * Math.sqrt(total)
  const diversityFactor = 0.55 + 0.75 * Math.pow(normalizedEntropy, 1.5)
  const capacity = Math.max(2, Math.floor(total / Math.max(2, options.minClusterSize)))
  const upper = Math.max(2, Math.min(256, options.maxClusters ?? 256, counts.length, capacity))
  return Math.max(2, Math.min(upper, Math.round(sizeBase * diversityFactor)))
}

export function approximateCentroidCandidates(
  values: Float64Array,
  centroids: Float32Array[],
  candidateCount = 4,
  sampleCount = 64,
): number[] {
  if (values.length === 0 || centroids.length === 0) return []
  const desired = Math.max(1, Math.min(candidateCount, centroids.length))
  const samples = Math.max(1, Math.min(sampleCount, values.length))
  const scored: Array<{ index: number; score: number }> = []
  for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex++) {
    const centroid = centroids[centroidIndex]
    let dot = 0
    let leftNormSquared = 0
    let rightNormSquared = 0
    for (let sample = 0; sample < samples; sample++) {
      const valueIndex = Math.min(
        values.length - 1,
        Math.floor(((sample + 0.5) * values.length) / samples),
      )
      const left = values[valueIndex]
      const right = centroid[valueIndex] || 0
      dot += left * right
      leftNormSquared += left * left
      rightNormSquared += right * right
    }
    const denominator = Math.sqrt(leftNormSquared * rightNormSquared)
    const score = denominator > 0 ? dot / denominator : -1
    const insertAt = scored.findIndex((item) => score > item.score)
    if (insertAt >= 0) scored.splice(insertAt, 0, { index: centroidIndex, score })
    else scored.push({ index: centroidIndex, score })
    if (scored.length > desired) scored.pop()
  }
  return scored.map((item) => item.index)
}

function normalize(values: Float64Array): Float32Array {
  let normSquared = 0
  for (const value of values) normSquared += value * value
  const norm = Math.sqrt(normSquared)
  const result = new Float32Array(values.length)
  if (norm <= 0) return result
  for (let index = 0; index < values.length; index++) result[index] = values[index] / norm
  return result
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length)
  if (length === 0) return 0
  let dot = 0
  let leftNormSquared = 0
  let rightNormSquared = 0
  for (let index = 0; index < length; index++) {
    const leftValue = left[index]
    const rightValue = right[index]
    dot += leftValue * rightValue
    leftNormSquared += leftValue * leftValue
    rightNormSquared += rightValue * rightValue
  }
  const denominator = Math.sqrt(leftNormSquared * rightNormSquared)
  if (!(denominator > 0)) return 0
  return Math.max(-1, Math.min(1, dot / denominator))
}

/** 12-bit sign signature over evenly spaced vector lanes (micro-bucket key). */
export function vectorSignature(vector: Float32Array, bitCount = 12): number {
  let signature = 0
  for (let bit = 0; bit < bitCount; bit++) {
    const index = Math.min(vector.length - 1, Math.floor(((bit + 0.5) * vector.length) / bitCount))
    if (vector[index] >= 0) signature |= 1 << bit
  }
  return signature
}

export function scoreClusterPurity(
  vector: Float32Array,
  centroid: Float32Array,
  minSimilarity: number,
): { accepted: boolean; similarity: number } {
  const similarity = cosineSimilarity(vector, centroid)
  return { accepted: similarity >= minSimilarity, similarity }
}

function bestCentroid(
  point: Float32Array,
  centroids: Float32Array[],
): {
  index: number
  score: number
} {
  let bestIndex = 0
  let bestScore = cosineSimilarity(point, centroids[0])
  for (let index = 1; index < centroids.length; index++) {
    const score = cosineSimilarity(point, centroids[index])
    if (score > bestScore) {
      bestIndex = index
      bestScore = score
    }
  }
  return { index: bestIndex, score: bestScore }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function selectDiverseCentroids(
  points: BucketPoint[],
  maxClusters: number,
  options: ClusterOptions,
): Promise<Float32Array[]> {
  const centroids = [points[0].centroid]
  const selected = new Set<number>([0])
  const desired = Math.min(maxClusters, points.length)

  while (centroids.length < desired) {
    if (options.isCancelled?.()) throw new Error('Asset library task cancelled')
    let bestPoint = -1
    let bestPriority = -1
    for (let index = 0; index < points.length; index++) {
      if (selected.has(index)) continue
      const nearest = bestCentroid(points[index].centroid, centroids).score
      const diversity = 1 - nearest
      const priority = diversity * (1 + Math.log1p(points[index].bucket.count))
      if (priority > bestPriority) {
        bestPriority = priority
        bestPoint = index
      }
      if (index % 32 === 0) await yieldToEventLoop()
    }
    if (bestPoint < 0 || bestPriority <= 1e-6) break
    selected.add(bestPoint)
    centroids.push(points[bestPoint].centroid)
    options.onProgress?.(
      (centroids.length / Math.max(1, desired)) * 0.2,
      `Selecting ${centroids.length}/${desired} cluster seeds...`,
    )
  }
  return centroids
}

export async function clusterCompressedAssetBuckets(
  buckets: CompressedAssetVectorBucket[],
  options: ClusterOptions,
): Promise<CompressedAssetClusteringResult> {
  const usable = buckets
    .filter((bucket) => bucket.count > 0 && bucket.assetIds.length > 0 && bucket.sum.length > 0)
    .sort((left, right) => right.count - left.count)
  if (usable.length === 0) return { clusters: [], unclusteredAssets: 0 }

  const points = usable.map((bucket) => ({ bucket, centroid: normalize(bucket.sum) }))
  let centroids = await selectDiverseCentroids(points, Math.max(1, options.maxClusters), options)
  const iterations = Math.max(1, Math.min(8, options.iterations ?? 4))

  for (let iteration = 0; iteration < iterations; iteration++) {
    if (options.isCancelled?.()) throw new Error('Asset library task cancelled')
    const sums = centroids.map((centroid) => new Float64Array(centroid.length))
    const weights = new Uint32Array(centroids.length)
    for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
      const point = points[pointIndex]
      const match = bestCentroid(point.centroid, centroids)
      if (match.score < options.minSimilarity) {
        if (pointIndex % 32 === 0) await yieldToEventLoop()
        continue
      }
      const target = match.index
      weights[target] += point.bucket.count
      const source = point.bucket.sum
      const targetSum = sums[target]
      const length = Math.min(source.length, targetSum.length)
      for (let valueIndex = 0; valueIndex < length; valueIndex++) {
        targetSum[valueIndex] += source[valueIndex]
      }
      if (pointIndex % 32 === 0) await yieldToEventLoop()
    }
    centroids = centroids.map((centroid, index) =>
      weights[index] > 0 ? normalize(sums[index]) : centroid,
    )
    options.onProgress?.(
      0.2 + ((iteration + 1) / iterations) * 0.55,
      `Refining clusters ${iteration + 1}/${iterations}...`,
    )
  }

  const grouped = centroids.map(() => ({
    members: [] as Array<{ assetId: number; similarity: number }>,
    memberCount: 0,
    representativeAssetId: 0,
    weightedSimilarity: 0,
    bucketKeys: [] as number[],
  }))
  let unclusteredAssets = 0
  for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
    if (options.isCancelled?.()) throw new Error('Asset library task cancelled')
    const point = points[pointIndex]
    const match = bestCentroid(point.centroid, centroids)
    if (match.score < options.minSimilarity) {
      unclusteredAssets += point.bucket.assetIds.length
    } else {
      const cluster = grouped[match.index]
      cluster.weightedSimilarity += match.score * point.bucket.assetIds.length
      cluster.memberCount += point.bucket.assetIds.length
      if (!cluster.representativeAssetId) {
        cluster.representativeAssetId = point.bucket.assetIds[0]
      }
      if (point.bucket.key !== undefined) cluster.bucketKeys.push(point.bucket.key)
      if (options.includeMembers !== false) {
        for (const assetId of point.bucket.assetIds) {
          cluster.members.push({ assetId, similarity: match.score })
        }
      }
    }
    if (pointIndex % 32 === 0) {
      options.onProgress?.(
        0.75 + ((pointIndex + 1) / points.length) * 0.25,
        'Assigning assets to stable groups...',
      )
      await yieldToEventLoop()
    }
  }

  const clusters = grouped
    .map((cluster, index) => {
      cluster.members.sort((left, right) => right.similarity - left.similarity)
      return {
        members: cluster.members,
        avgSimilarity: cluster.weightedSimilarity / cluster.memberCount,
        representativeAssetId: cluster.members[0]?.assetId || cluster.representativeAssetId,
        centroid: centroids[index],
        bucketKeys: cluster.bucketKeys,
        compressedAssetCount: cluster.memberCount,
      }
    })
    .filter((cluster) => cluster.compressedAssetCount > 0)
    .sort((left, right) => right.compressedAssetCount - left.compressedAssetCount)

  options.onProgress?.(1, 'Cluster groups ready.')
  return { clusters, unclusteredAssets }
}
