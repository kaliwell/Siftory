import { parentPort, workerData } from 'worker_threads'
import { ensureEmbeddingF16Cache, streamEmbeddingF16Cache } from './embeddingF16Cache'
import {
  pushBoundedScoredCandidate,
  shiftedCosineNormalized,
  type ScoredAssetCandidate,
} from './assetLibraryScoring'
import { requireNormalizedEmbeddingVectorFloat32 } from './embeddingVectorValidation'

/**
 * Similar-search scan worker: streams the DINO Float16 cache and keeps a
 * bounded top-K heap by shifted-cosine against the query vector. Pure compute
 * — the main process owns asset metadata, result assembly and all writes.
 */

export interface AssetSimilarSearchAssetEntry {
  id: number
  /** Normalized path key (assetMetadataStore pathKey semantics). */
  pathKey: string
}

export interface AssetSimilarSearchScanInput {
  cacheDir: string
  modelName: string
  embeddingType: string
  dim: number
  sourcePaths: string[]
  queryVector: number[]
  topK: number
  excludeAssetId: number
  /** Active assets only; lookup miss means missing/archived/unknown. */
  assets: AssetSimilarSearchAssetEntry[]
  /** Asset ids to skip (already reviewed in the target category). */
  reviewedAssetIds: number[]
}

export interface AssetSimilarSearchWorkerProgress {
  phase: 'cache' | 'scan'
  current: number
  total: number
  percent: number
  message: string
}

export interface AssetSimilarSearchScanResult {
  stopped: boolean
  scanned: number
  candidates: ScoredAssetCandidate[]
}

// Must stay in sync with pathKey() in electron/assetMetadataStore.ts.
function assetPathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function stopped(stopView: Int32Array): boolean {
  return Atomics.load(stopView, 0) === 1
}

export async function runAssetSimilarSearchScan(
  input: AssetSimilarSearchScanInput,
  stopView: Int32Array,
  onProgress: (progress: AssetSimilarSearchWorkerProgress) => void,
): Promise<AssetSimilarSearchScanResult> {
  const isCancelled = () => stopped(stopView)
  const queryVector = requireNormalizedEmbeddingVectorFloat32(input.queryVector, input.dim)
  let cache
  try {
    cache = await ensureEmbeddingF16Cache({
      cacheDir: input.cacheDir,
      modelName: input.modelName,
      embeddingType: input.embeddingType,
      dim: input.dim,
      sourcePaths: input.sourcePaths,
      isCancelled,
      onProgress: (progress) =>
        onProgress({
          phase: 'cache',
          current: progress.current,
          total: progress.total,
          percent: progress.percent,
          message: progress.message,
        }),
    })
  } catch (error) {
    // ensureEmbeddingF16Cache throws on cancellation instead of returning null.
    if (stopped(stopView)) return { stopped: true, scanned: 0, candidates: [] }
    throw error
  }
  if (stopped(stopView)) return { stopped: true, scanned: 0, candidates: [] }
  if (!cache || cache.meta.count <= 0) throw new Error('DINO Float16 cache is empty')

  const assetIdByPathKey = new Map<string, number>()
  for (const entry of input.assets) assetIdByPathKey.set(entry.pathKey, entry.id)
  const reviewed = new Set(input.reviewedAssetIds)
  const candidates: ScoredAssetCandidate[] = []
  const seenAssetIds = new Set<number>()

  let scanned = 0
  try {
    scanned = await streamEmbeddingF16Cache(cache, {
      isCancelled,
      onProgress: (progress) =>
        onProgress({
          phase: 'scan',
          current: progress.current,
          total: progress.total,
          percent: progress.percent,
          message: progress.message,
        }),
      onVector: (filePath, vector) => {
        const assetId = assetIdByPathKey.get(assetPathKey(filePath))
        if (assetId === undefined || assetId === input.excludeAssetId) return
        if (seenAssetIds.has(assetId)) return
        seenAssetIds.add(assetId)
        if (reviewed.has(assetId)) return
        pushBoundedScoredCandidate(
          candidates,
          { assetId, confidence: shiftedCosineNormalized(queryVector, vector) },
          input.topK,
        )
      },
    })
  } catch (error) {
    if (stopped(stopView)) return { stopped: true, scanned, candidates: [] }
    throw error
  }
  if (stopped(stopView)) return { stopped: true, scanned, candidates: [] }
  return { stopped: false, scanned, candidates }
}

interface WorkerInput {
  input: AssetSimilarSearchScanInput
  stopBuffer: SharedArrayBuffer
}

if (parentPort && workerData) {
  const port = parentPort
  const { input, stopBuffer } = workerData as WorkerInput
  const stopView = new Int32Array(stopBuffer)
  const onProgress = (progress: AssetSimilarSearchWorkerProgress) =>
    port.postMessage({ type: 'progress', progress })
  runAssetSimilarSearchScan(input, stopView, onProgress)
    .then((result) => {
      port.postMessage(
        result.stopped
          ? { type: 'stopped' }
          : {
              type: 'result',
              result: { scanned: result.scanned, candidates: result.candidates },
            },
      )
    })
    .catch((error: unknown) => {
      port.postMessage({ type: 'error', error: String(error) })
    })
}
