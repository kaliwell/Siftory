import { parentPort, workerData } from 'worker_threads'
import { streamAssetEmbeddingsFromPaths } from './assetEmbeddingStream'
import { requireNormalizedEmbeddingVectorFloat32 } from './embeddingVectorValidation'
import {
  pushBoundedScoredCandidate,
  scoreNormalizedReferencePrototypes,
  shiftedCosineNormalized,
  type AssetReferencePrototype,
  type ScoredAssetCandidate,
} from './assetLibraryScoring'

/**
 * Suggestion scan worker: streams the DINO or CLIP embedding JSONL and scores
 * every active asset against per-target prototype vectors, keeping a bounded
 * top-K heap per target. Pure compute — the main process owns prototype
 * preparation, suggestion row assembly and all database writes.
 */

export interface AssetSuggestionScanTarget {
  targetId: number
  /** Per-target low-confidence floor; candidates below it are dropped. */
  minConfidence: number
  /** reference mode: weighted prototypes; text_label mode: exactly one entry. */
  prototypes: Array<{ assetId: number; vector: number[]; weight: number }>
}

export interface AssetSuggestionScanInput {
  mode: 'reference' | 'text_label'
  modelName: string
  dim: number
  sourcePaths: string[]
  targets: AssetSuggestionScanTarget[]
  maxPerTarget: number
  /** Active assets only; lookup miss means missing/archived/unknown. */
  assets: Array<{ id: number; pathKey: string }>
  /** "assetId:targetId" pairs to skip (assigned ∪ reviewed ∪ reference). */
  excludedPairs: string[]
}

export interface AssetSuggestionScanWorkerProgress {
  scanned: number
  totalBytes: number
  processedBytes: number
}

export interface AssetSuggestionScanTargetResult {
  targetId: number
  candidates: ScoredAssetCandidate[]
}

export interface AssetSuggestionScanResult {
  stopped: boolean
  scanned: number
  results: AssetSuggestionScanTargetResult[]
}

// Must stay in sync with pathKey() in electron/assetMetadataStore.ts.
function assetPathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function stopped(stopView: Int32Array): boolean {
  return Atomics.load(stopView, 0) === 1
}

export async function runAssetSuggestionScan(
  input: AssetSuggestionScanInput,
  stopView: Int32Array,
  onProgress: (progress: AssetSuggestionScanWorkerProgress) => void,
): Promise<AssetSuggestionScanResult> {
  const assetIdByPathKey = new Map<string, number>()
  for (const entry of input.assets) assetIdByPathKey.set(entry.pathKey, entry.id)
  const excluded = new Set(input.excludedPairs)
  const targets = input.targets.map((target) => ({
    ...target,
    prototypes: target.prototypes.map((prototype) => ({
      assetId: prototype.assetId,
      vector: requireNormalizedEmbeddingVectorFloat32(prototype.vector, input.dim),
      weight: prototype.weight,
    })),
    candidates: [] as ScoredAssetCandidate[],
  }))

  let scanned = 0
  try {
    const streamed = await streamAssetEmbeddingsFromPaths({
      modelName: input.modelName,
      expectedDim: input.dim,
      sourcePaths: input.sourcePaths,
      isCancelled: () => stopped(stopView),
      onProgress: (scannedCount, totalBytes, processedBytes) =>
        onProgress({ scanned: scannedCount, totalBytes, processedBytes }),
      onEntry: (entry) => {
        const assetId = assetIdByPathKey.get(assetPathKey(entry.imageId))
        if (assetId === undefined) return
        const vector = entry.vector
        for (const target of targets) {
          const pair = `${assetId}:${target.targetId}`
          if (excluded.has(pair)) continue
          if (input.mode === 'reference') {
            const { confidence, evidenceAssetId } = scoreNormalizedReferencePrototypes(
              vector,
              target.prototypes as AssetReferencePrototype[],
            )
            if (confidence >= target.minConfidence) {
              pushBoundedScoredCandidate(
                target.candidates,
                {
                  assetId,
                  confidence,
                  ...(evidenceAssetId !== undefined ? { evidenceAssetIds: [evidenceAssetId] } : {}),
                },
                input.maxPerTarget,
              )
            }
          } else {
            const confidence = shiftedCosineNormalized(vector, target.prototypes[0].vector)
            if (confidence >= target.minConfidence) {
              pushBoundedScoredCandidate(
                target.candidates,
                { assetId, confidence },
                input.maxPerTarget,
              )
            }
          }
        }
      },
    })
    scanned = streamed.scanned
  } catch (error) {
    if (stopped(stopView)) return { stopped: true, scanned, results: [] }
    throw error
  }
  if (stopped(stopView)) return { stopped: true, scanned, results: [] }
  return {
    stopped: false,
    scanned,
    results: targets.map((target) => ({
      targetId: target.targetId,
      candidates: target.candidates,
    })),
  }
}

interface WorkerInput {
  input: AssetSuggestionScanInput
  stopBuffer: SharedArrayBuffer
}

if (parentPort && workerData) {
  const port = parentPort
  const { input, stopBuffer } = workerData as WorkerInput
  const stopView = new Int32Array(stopBuffer)
  const onProgress = (progress: AssetSuggestionScanWorkerProgress) =>
    port.postMessage({ type: 'progress', progress })
  runAssetSuggestionScan(input, stopView, onProgress)
    .then((result) => {
      port.postMessage(
        result.stopped
          ? { type: 'stopped' }
          : { type: 'result', result: { scanned: result.scanned, results: result.results } },
      )
    })
    .catch((error: unknown) => {
      port.postMessage({ type: 'error', error: String(error) })
    })
}
