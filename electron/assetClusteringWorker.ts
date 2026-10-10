import path from 'path'
import { parentPort, workerData } from 'worker_threads'
import {
  approximateCentroidCandidates,
  clusterCompressedAssetBuckets,
  estimateAdaptiveClusterCount,
  scoreClusterPurity,
  vectorSignature,
} from './assetClustering'
import {
  bestSemanticSeed,
  observeSemanticSeed,
  type SemanticSeed,
} from './clusterSemanticRefinement'
import { ensureEmbeddingF16Cache, streamEmbeddingF16Cache } from './embeddingF16Cache'
import { streamClipEmbeddingsForPaths } from './clipEmbeddingCacheReader'

/**
 * Clustering pipeline worker: micro-bucket routing, compressed k-means, exact
 * purity passes (incl. adaptive residual), and CLIP semantic refinement. Pure
 * compute — the main process owns semantic label generation and all writes.
 * The logic mirrors the pre-worker buildAssetClusters flow exactly.
 */

export interface AssetClusteringWorkerInput {
  cacheDir: string
  modelName: string
  embeddingType: string
  dim: number
  sourcePaths: string[]
  clipVectorDir: string
  scopePaths: string[]
  maxAssets: number
  minClusterSize: number
  minSimilarity: number
  autoClusters: boolean
  requestedMaxClusters: number
  semanticRefine: boolean
  semanticSimilarity: number
  semanticMaxSplits: number
  /** Active assets only; lookup miss means missing/archived/unknown. */
  assets: Array<{ id: number; pathKey: string; path: string }>
}

export interface AssetClusteringWorkerProgress {
  stage: string
  current: number
  total: number
  percent: number
  message: string
}

export interface AssetClusteringClusterResult {
  members: Array<{ assetId: number; similarity: number }>
  avgSimilarity: number
  representativeAssetId: number
}

export interface AssetClusteringWorkerResult {
  stopped: boolean
  viable: AssetClusteringClusterResult[]
  eligibleCount: number
  memberCount: number
  maxClusters: number
  residualCenterCount: number
  semanticEmbeddedCount: number
  semanticSplitCount: number
  semanticRefineSkipped: boolean
}

interface ClusterBucket {
  key: number
  count: number
  sum: Float64Array
  assetIds: number[]
}

// Must stay in sync with pathKey() in electron/assetMetadataStore.ts.
function assetPathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function pathMatchesClusterScope(filePath: string, scopePaths: string[]): boolean {
  if (scopePaths.length === 0) return true
  const candidate = path.resolve(filePath)
  return scopePaths.some((scopePath) => {
    const relative = path.relative(scopePath, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
}

function stopped(stopView: Int32Array): boolean {
  return Atomics.load(stopView, 0) === 1
}

export async function runAssetClusteringPipeline(
  input: AssetClusteringWorkerInput,
  stopView: Int32Array,
  onProgress: (progress: AssetClusteringWorkerProgress) => void,
): Promise<AssetClusteringWorkerResult> {
  const isCancelled = () => stopped(stopView)
  const emit = (stage: string, current: number, total: number, percent: number, message: string) =>
    onProgress({ stage, current, total, percent, message })
  const cancelResult = (): AssetClusteringWorkerResult => ({
    stopped: true,
    viable: [],
    eligibleCount: 0,
    memberCount: 0,
    maxClusters: 0,
    residualCenterCount: 0,
    semanticEmbeddedCount: 0,
    semanticSplitCount: 0,
    semanticRefineSkipped: false,
  })

  const assetIdByPathKey = new Map<string, number>()
  const assetPathById = new Map<number, string>()
  for (const entry of input.assets) {
    assetIdByPathKey.set(entry.pathKey, entry.id)
    assetPathById.set(entry.id, entry.path)
  }

  const cache = await ensureEmbeddingF16Cache({
    cacheDir: input.cacheDir,
    modelName: input.modelName,
    embeddingType: input.embeddingType,
    dim: input.dim,
    sourcePaths: input.sourcePaths,
    isCancelled,
    onProgress: (progress) =>
      emit('cache', progress.current, progress.total, progress.percent, progress.message),
  }).catch((error: unknown) => {
    if (stopped(stopView)) return null
    throw error
  })
  if (!cache && stopped(stopView)) return cancelResult()
  if (!cache || cache.meta.count <= 0) throw new Error('DINO Float16 cache is empty')

  // Pass 1: route active assets into signature micro-buckets.
  const buckets = new Map<number, ClusterBucket>()
  const eligibleAssetIds = new Set<number>()
  try {
    await streamEmbeddingF16Cache(cache, {
      isCancelled,
      shouldStop: () => eligibleAssetIds.size >= input.maxAssets,
      onProgress: (progress) =>
        emit(
          'routing',
          progress.current,
          progress.total,
          progress.percent,
          `Routing ${eligibleAssetIds.size.toLocaleString()} active assets into DINO micro-buckets...`,
        ),
      onVector: (filePath, vector) => {
        if (!pathMatchesClusterScope(filePath, input.scopePaths)) return
        const assetId = assetIdByPathKey.get(assetPathKey(filePath))
        if (assetId === undefined) return
        eligibleAssetIds.add(assetId)
        const signature = vectorSignature(vector)
        let bucket = buckets.get(signature)
        if (!bucket) {
          bucket = { key: signature, count: 0, sum: new Float64Array(vector.length), assetIds: [] }
          buckets.set(signature, bucket)
        }
        bucket.count += 1
        bucket.assetIds.push(assetId)
        for (let index = 0; index < vector.length; index++) bucket.sum[index] += vector[index]
      },
    })
  } catch (error) {
    if (stopped(stopView)) return cancelResult()
    throw error
  }
  if (stopped(stopView)) return cancelResult()
  const populatedBuckets = [...buckets.values()].filter((bucket) => bucket.count > 0)
  if (populatedBuckets.length === 0) {
    throw new Error(
      input.scopePaths.length > 0
        ? 'No DINO image embeddings matched the selected folders or drives'
        : 'No DINO image embeddings matched the asset library',
    )
  }

  const maxClusters = input.autoClusters
    ? estimateAdaptiveClusterCount(populatedBuckets, {
        minClusterSize: input.minClusterSize,
        maxClusters: 256,
      })
    : input.requestedMaxClusters
  emit(
    'centers',
    eligibleAssetIds.size,
    eligibleAssetIds.size,
    100,
    `${input.autoClusters ? 'Adaptive' : 'Manual'} clustering selected ${maxClusters} centers for ${eligibleAssetIds.size.toLocaleString()} assets across ${populatedBuckets.length.toLocaleString()} visual buckets.`,
  )
  const clustered = await clusterCompressedAssetBuckets(populatedBuckets, {
    maxClusters,
    minSimilarity: Math.max(0.2, input.minSimilarity - 0.2),
    includeMembers: false,
    isCancelled,
    onProgress: (progress, message) =>
      emit('clustering', Math.round(progress * 1000), 1000, progress, message),
  })
  if (stopped(stopView)) return cancelResult()

  const clusterBySignature = new Map<number, number>()
  clustered.clusters.forEach((cluster, clusterIndex) => {
    for (const signature of cluster.bucketKeys) {
      clusterBySignature.set(signature, clusterIndex)
    }
  })
  const candidateClustersBySignature = new Map<number, number[]>()
  const centroids = clustered.clusters.map((cluster) => cluster.centroid)
  for (let bucketIndex = 0; bucketIndex < populatedBuckets.length; bucketIndex++) {
    const bucket = populatedBuckets[bucketIndex]
    const candidates = approximateCentroidCandidates(bucket.sum, centroids, 4, 64)
    const routedCluster = clusterBySignature.get(bucket.key)
    if (routedCluster !== undefined && !candidates.includes(routedCluster)) {
      candidates.push(routedCluster)
    }
    candidateClustersBySignature.set(bucket.key, candidates)
    if (bucketIndex % 16 === 0) {
      emit(
        'routing-prep',
        bucketIndex + 1,
        populatedBuckets.length,
        (bucketIndex + 1) / populatedBuckets.length,
        `Preparing multi-center routing ${bucketIndex + 1}/${populatedBuckets.length} visual buckets...`,
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  interface ExactCluster {
    centroid: Float32Array
    members: Array<{ assetId: number; similarity: number }>
    similarityTotal: number
    representativeAssetId: number
    representativeSimilarity: number
  }
  const exactClusters: ExactCluster[] = clustered.clusters.map((cluster) => ({
    centroid: cluster.centroid,
    members: [],
    similarityTotal: 0,
    representativeAssetId: 0,
    representativeSimilarity: -1,
  }))
  const residualAssetIds = new Set<number>()
  const residualBuckets = new Map<number, ClusterBucket>()
  try {
    await streamEmbeddingF16Cache(cache, {
      isCancelled,
      onProgress: (progress) =>
        emit(
          'purifying',
          progress.current,
          progress.total,
          progress.percent,
          `Purifying clusters with exact DINO vectors: ${progress.current.toLocaleString()}/${progress.total.toLocaleString()}`,
        ),
      onVector: (filePath, vector) => {
        const assetId = assetIdByPathKey.get(assetPathKey(filePath))
        if (assetId === undefined || !eligibleAssetIds.has(assetId)) return
        const clusterIndexes = candidateClustersBySignature.get(vectorSignature(vector))
        if (!clusterIndexes || clusterIndexes.length === 0) return
        let clusterIndex = clusterIndexes[0]
        let bestSimilarity = -1
        for (const candidateIndex of clusterIndexes) {
          const similarity = scoreClusterPurity(
            vector,
            exactClusters[candidateIndex].centroid,
            input.minSimilarity,
          ).similarity
          if (similarity > bestSimilarity) {
            bestSimilarity = similarity
            clusterIndex = candidateIndex
          }
        }
        if (bestSimilarity < input.minSimilarity) {
          if (input.autoClusters) {
            residualAssetIds.add(assetId)
            const signature = vectorSignature(vector)
            let bucket = residualBuckets.get(signature)
            if (!bucket) {
              bucket = {
                key: signature,
                count: 0,
                sum: new Float64Array(vector.length),
                assetIds: [],
              }
              residualBuckets.set(signature, bucket)
            }
            bucket.count += 1
            bucket.assetIds.push(assetId)
            for (let index = 0; index < vector.length; index++) bucket.sum[index] += vector[index]
          }
          return
        }
        const target = exactClusters[clusterIndex]
        target.members.push({ assetId, similarity: bestSimilarity })
        target.similarityTotal += bestSimilarity
        if (bestSimilarity > target.representativeSimilarity) {
          target.representativeSimilarity = bestSimilarity
          target.representativeAssetId = assetId
        }
      },
    })
  } catch (error) {
    if (stopped(stopView)) return cancelResult()
    throw error
  }
  if (stopped(stopView)) return cancelResult()

  const residualExactClusters: ExactCluster[] = []
  let residualCenterCount = 0
  const populatedResidualBuckets = [...residualBuckets.values()].filter(
    (bucket) => bucket.count > 0,
  )
  if (input.autoClusters && residualAssetIds.size >= input.minClusterSize * 2) {
    residualCenterCount = estimateAdaptiveClusterCount(populatedResidualBuckets, {
      minClusterSize: input.minClusterSize,
      maxClusters: 128,
    })
    emit(
      'residual-centers',
      residualAssetIds.size,
      eligibleAssetIds.size,
      100,
      `Residual pass selected ${residualCenterCount} new centers for ${residualAssetIds.size.toLocaleString()} high-purity outliers.`,
    )
    const residualClustered = await clusterCompressedAssetBuckets(populatedResidualBuckets, {
      maxClusters: residualCenterCount,
      minSimilarity: Math.max(0.2, input.minSimilarity - 0.2),
      includeMembers: false,
      isCancelled,
      onProgress: (progress, message) =>
        emit(
          'residual-clustering',
          Math.round(progress * 1000),
          1000,
          progress,
          `Residual clustering: ${message}`,
        ),
    })
    if (stopped(stopView)) return cancelResult()
    const residualClusterBySignature = new Map<number, number>()
    residualClustered.clusters.forEach((cluster, clusterIndex) => {
      for (const signature of cluster.bucketKeys) {
        residualClusterBySignature.set(signature, clusterIndex)
      }
    })
    const residualCandidatesBySignature = new Map<number, number[]>()
    const residualCentroids = residualClustered.clusters.map((cluster) => cluster.centroid)
    for (let bucketIndex = 0; bucketIndex < populatedResidualBuckets.length; bucketIndex++) {
      const bucket = populatedResidualBuckets[bucketIndex]
      const candidates = approximateCentroidCandidates(bucket.sum, residualCentroids, 4, 64)
      const routedCluster = residualClusterBySignature.get(bucket.key)
      if (routedCluster !== undefined && !candidates.includes(routedCluster)) {
        candidates.push(routedCluster)
      }
      residualCandidatesBySignature.set(bucket.key, candidates)
      if (bucketIndex % 16 === 0) {
        emit(
          'residual-prep',
          bucketIndex + 1,
          populatedResidualBuckets.length,
          (bucketIndex + 1) / populatedResidualBuckets.length,
          `Preparing residual routes ${bucketIndex + 1}/${populatedResidualBuckets.length}...`,
        )
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    residualExactClusters.push(
      ...residualClustered.clusters.map((cluster) => ({
        centroid: cluster.centroid,
        members: [],
        similarityTotal: 0,
        representativeAssetId: 0,
        representativeSimilarity: -1,
      })),
    )
    try {
      await streamEmbeddingF16Cache(cache, {
        isCancelled,
        onProgress: (progress) =>
          emit(
            'residual-purify',
            progress.current,
            progress.total,
            progress.percent,
            `Purifying residual groups: ${progress.current.toLocaleString()}/${progress.total.toLocaleString()}`,
          ),
        onVector: (filePath, vector) => {
          const assetId = assetIdByPathKey.get(assetPathKey(filePath))
          if (assetId === undefined || !residualAssetIds.has(assetId)) return
          const clusterIndexes = residualCandidatesBySignature.get(vectorSignature(vector))
          if (!clusterIndexes || clusterIndexes.length === 0) return
          let clusterIndex = clusterIndexes[0]
          let bestSimilarity = -1
          for (const candidateIndex of clusterIndexes) {
            const similarity = scoreClusterPurity(
              vector,
              residualExactClusters[candidateIndex].centroid,
              input.minSimilarity,
            ).similarity
            if (similarity > bestSimilarity) {
              bestSimilarity = similarity
              clusterIndex = candidateIndex
            }
          }
          if (bestSimilarity < input.minSimilarity) return
          const target = residualExactClusters[clusterIndex]
          target.members.push({ assetId, similarity: bestSimilarity })
          target.similarityTotal += bestSimilarity
          if (bestSimilarity > target.representativeSimilarity) {
            target.representativeSimilarity = bestSimilarity
            target.representativeAssetId = assetId
          }
        },
      })
    } catch (error) {
      if (stopped(stopView)) return cancelResult()
      throw error
    }
    if (stopped(stopView)) return cancelResult()
  }

  const purified = [...exactClusters, ...residualExactClusters]
    .filter((cluster) => cluster.members.length > 0)
    .map((cluster) => {
      cluster.members.sort((left, right) => right.similarity - left.similarity)
      return {
        members: cluster.members,
        avgSimilarity: cluster.similarityTotal / cluster.members.length,
        representativeAssetId: cluster.representativeAssetId || cluster.members[0].assetId,
      }
    })
    .sort((left, right) => right.members.length - left.members.length)
  const dinoViable = purified.filter((cluster) => cluster.members.length >= input.minClusterSize)
  let viable = dinoViable
  let semanticEmbeddedCount = 0
  let semanticSplitCount = 0
  let semanticRefineSkipped = false

  if (input.semanticRefine && input.semanticMaxSplits > 1 && dinoViable.length > 0) {
    const memberParent = new Map<number, number>()
    const pathsToAssetIds = new Map<string, number>()
    for (let parentIndex = 0; parentIndex < dinoViable.length; parentIndex++) {
      for (const member of dinoViable[parentIndex].members) {
        const assetPath = assetPathById.get(member.assetId)
        if (assetPath === undefined) continue
        memberParent.set(member.assetId, parentIndex)
        pathsToAssetIds.set(assetPath, member.assetId)
      }
    }
    const semanticSeeds = dinoViable.map(() => [] as SemanticSeed[])
    try {
      emit(
        'semantic-seeds',
        0,
        pathsToAssetIds.size,
        0,
        `Learning CLIP semantic centers for ${dinoViable.length} DINO groups...`,
      )
      semanticEmbeddedCount = await streamClipEmbeddingsForPaths(
        input.clipVectorDir,
        pathsToAssetIds,
        {
          isCancelled,
          onProgress: (current, total) =>
            emit(
              'semantic-seeds',
              current,
              total,
              total > 0 ? (current / total) * 100 : 0,
              `Learning CLIP semantic centers: ${current.toLocaleString()}/${total.toLocaleString()} cache rows...`,
            ),
          onVector: (assetId, vector) => {
            const parentIndex = memberParent.get(assetId)
            if (parentIndex === undefined) return
            observeSemanticSeed(
              semanticSeeds[parentIndex],
              vector,
              input.semanticSimilarity,
              input.semanticMaxSplits,
            )
          },
        },
      )

      if (semanticEmbeddedCount > 0) {
        type SemanticMember = { assetId: number; similarity: number }
        interface SemanticBucket {
          seedIndex: number
          members: SemanticMember[]
          dinoSimilarityTotal: number
          representativeAssetId: number
          representativeScore: number
        }
        const memberById = new Map<number, SemanticMember>()
        for (const cluster of dinoViable) {
          for (const member of cluster.members) memberById.set(member.assetId, member)
        }
        const semanticBuckets = semanticSeeds.map((seeds) =>
          seeds.map<SemanticBucket>((_seed, seedIndex) => ({
            seedIndex,
            members: [],
            dinoSimilarityTotal: 0,
            representativeAssetId: 0,
            representativeScore: -1,
          })),
        )
        const assignedAssetIds = new Set<number>()
        await streamClipEmbeddingsForPaths(input.clipVectorDir, pathsToAssetIds, {
          isCancelled,
          onProgress: (current, total) =>
            emit(
              'semantic-assign',
              current,
              total,
              total > 0 ? (current / total) * 100 : 0,
              `Assigning images to CLIP semantic groups: ${current.toLocaleString()}/${total.toLocaleString()} cache rows...`,
            ),
          onVector: (assetId, vector) => {
            const parentIndex = memberParent.get(assetId)
            const member = memberById.get(assetId)
            if (parentIndex === undefined || !member) return
            const match = bestSemanticSeed(vector, semanticSeeds[parentIndex])
            if (match.index < 0) return
            const bucket = semanticBuckets[parentIndex][match.index]
            bucket.members.push(member)
            bucket.dinoSimilarityTotal += member.similarity
            assignedAssetIds.add(assetId)
            const representativeScore = member.similarity * 0.65 + match.similarity * 0.35
            if (representativeScore > bucket.representativeScore) {
              bucket.representativeScore = representativeScore
              bucket.representativeAssetId = assetId
            }
          },
        })

        const refined: typeof dinoViable = []
        for (let parentIndex = 0; parentIndex < dinoViable.length; parentIndex++) {
          const parent = dinoViable[parentIndex]
          const parentBuckets = semanticBuckets[parentIndex]
          if (parentBuckets.length <= 1) {
            refined.push(parent)
            continue
          }
          let largestBucket = parentBuckets[0]
          for (const bucket of parentBuckets) {
            if (bucket.members.length > largestBucket.members.length) largestBucket = bucket
          }
          for (const member of parent.members) {
            if (assignedAssetIds.has(member.assetId)) continue
            largestBucket.members.push(member)
            largestBucket.dinoSimilarityTotal += member.similarity
            if (member.similarity > largestBucket.representativeScore) {
              largestBucket.representativeScore = member.similarity
              largestBucket.representativeAssetId = member.assetId
            }
          }
          const retained = parentBuckets.filter(
            (bucket) => bucket.members.length >= input.minClusterSize,
          )
          if (retained.length === 0) {
            refined.push(parent)
            continue
          }
          for (const bucket of parentBuckets) {
            if (bucket.members.length === 0 || retained.includes(bucket)) continue
            const retainedSeeds = retained.map(
              (candidate) => semanticSeeds[parentIndex][candidate.seedIndex],
            )
            const nearest = bestSemanticSeed(
              semanticSeeds[parentIndex][bucket.seedIndex].center,
              retainedSeeds,
            )
            const target = retained[Math.max(0, nearest.index)]
            target.members.push(...bucket.members)
            target.dinoSimilarityTotal += bucket.dinoSimilarityTotal
            if (bucket.representativeScore > target.representativeScore) {
              target.representativeScore = bucket.representativeScore
              target.representativeAssetId = bucket.representativeAssetId
            }
          }
          for (const bucket of retained) {
            bucket.members.sort((left, right) => right.similarity - left.similarity)
            refined.push({
              members: bucket.members,
              avgSimilarity: bucket.dinoSimilarityTotal / bucket.members.length,
              representativeAssetId: bucket.representativeAssetId || bucket.members[0].assetId,
            })
          }
        }
        refined.sort((left, right) => right.members.length - left.members.length)
        const sourceMemberCount = dinoViable.reduce(
          (total, cluster) => total + cluster.members.length,
          0,
        )
        const refinedMemberCount = refined.reduce(
          (total, cluster) => total + cluster.members.length,
          0,
        )
        if (refinedMemberCount !== sourceMemberCount) {
          throw new Error(
            `Semantic refinement member mismatch: ${refinedMemberCount}/${sourceMemberCount}`,
          )
        }
        viable = refined
        semanticSplitCount = Math.max(0, viable.length - dinoViable.length)
      }
    } catch (error) {
      if (stopped(stopView)) return cancelResult()
      console.warn('[NekoSearch] CLIP semantic cluster refinement skipped:', error)
      viable = dinoViable
      semanticEmbeddedCount = 0
      semanticSplitCount = 0
      semanticRefineSkipped = true
    }
  }

  const memberCount = viable.reduce((total, cluster) => total + cluster.members.length, 0)
  return {
    stopped: false,
    viable,
    eligibleCount: eligibleAssetIds.size,
    memberCount,
    maxClusters,
    residualCenterCount,
    semanticEmbeddedCount,
    semanticSplitCount,
    semanticRefineSkipped,
  }
}

interface WorkerInput {
  input: AssetClusteringWorkerInput
  stopBuffer: SharedArrayBuffer
}

if (parentPort && workerData) {
  const port = parentPort
  const { input, stopBuffer } = workerData as WorkerInput
  const stopView = new Int32Array(stopBuffer)
  const onProgress = (progress: AssetClusteringWorkerProgress) =>
    port.postMessage({ type: 'progress', progress })
  runAssetClusteringPipeline(input, stopView, onProgress)
    .then((result) => {
      port.postMessage(result.stopped ? { type: 'stopped' } : { type: 'result', result })
    })
    .catch((error: unknown) => {
      port.postMessage({ type: 'error', error: String(error) })
    })
}
