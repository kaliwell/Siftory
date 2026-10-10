import { shiftedCosine as strictShiftedCosine } from './assetEmbeddingStream'

export interface AssetReferencePrototype {
  assetId: number
  vector: Float32Array
  weight: number
}

export interface ScoredAssetCandidate {
  assetId: number
  confidence: number
  evidenceAssetIds?: number[]
}

export const DEFAULT_REFERENCE_THRESHOLD = 0.82
export const DEFAULT_REFERENCE_LOW_THRESHOLD = 0.7

export function resolveReferenceThresholds(
  categoryThreshold?: number,
  requestThreshold?: number,
  requestLowThreshold?: number,
): { suggested: number; lowConfidence: number } {
  const suggested = Math.max(
    0.5,
    Math.min(1, requestThreshold ?? categoryThreshold ?? DEFAULT_REFERENCE_THRESHOLD),
  )
  const lowConfidence = Math.max(
    0,
    Math.min(suggested, requestLowThreshold ?? DEFAULT_REFERENCE_LOW_THRESHOLD),
  )
  return { suggested, lowConfidence }
}

export function shiftedCosine(left: Float32Array, right: Float32Array): number {
  return strictShiftedCosine(left, right)
}

/**
 * One-pass scoring for worker hot loops after both vectors crossed a strict
 * normalization boundary. Keep this separate from the public strict helper
 * so candidate x prototype scans do not validate the same vector repeatedly.
 */
export function shiftedCosineNormalized(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || left.length !== right.length) {
    throw new RangeError(
      `Asset cosine dimension mismatch: ${left.length} does not match ${right.length}`,
    )
  }
  let dot = 0
  for (let index = 0; index < left.length; index++) dot += left[index] * right[index]
  if (!Number.isFinite(dot)) throw new Error('Asset normalized cosine score is not finite')
  return Math.max(0, Math.min(1, (dot + 1) / 2))
}

function scorePrototypes(
  vector: Float32Array,
  prototypes: AssetReferencePrototype[],
  cosine: (left: Float32Array, right: Float32Array) => number,
): { confidence: number; evidenceAssetId?: number } {
  if (prototypes.length === 0) return { confidence: 0 }
  const maxWeight = Math.max(0.1, ...prototypes.map((prototype) => prototype.weight))
  let bestConfidence = 0
  let bestEvidenceAssetId: number | undefined

  for (const prototype of prototypes) {
    const similarity = cosine(vector, prototype.vector)
    const relativeWeight = Math.max(0.1, prototype.weight) / maxWeight
    const confidence = similarity * (0.98 + Math.min(1, relativeWeight) * 0.02)
    if (
      confidence > bestConfidence ||
      (confidence === bestConfidence &&
        (bestEvidenceAssetId === undefined || prototype.assetId < bestEvidenceAssetId))
    ) {
      bestConfidence = confidence
      bestEvidenceAssetId = prototype.assetId
    }
  }

  return { confidence: bestConfidence, evidenceAssetId: bestEvidenceAssetId }
}

export function scoreReferencePrototypes(
  vector: Float32Array,
  prototypes: AssetReferencePrototype[],
): { confidence: number; evidenceAssetId?: number } {
  return scorePrototypes(vector, prototypes, shiftedCosine)
}

export function scoreNormalizedReferencePrototypes(
  vector: Float32Array,
  prototypes: AssetReferencePrototype[],
): { confidence: number; evidenceAssetId?: number } {
  return scorePrototypes(vector, prototypes, shiftedCosineNormalized)
}

function compareCandidateQuality(left: ScoredAssetCandidate, right: ScoredAssetCandidate): number {
  return left.confidence - right.confidence || right.assetId - left.assetId
}

export function pushBoundedScoredCandidate(
  heap: ScoredAssetCandidate[],
  candidate: ScoredAssetCandidate,
  maximum: number,
): void {
  if (maximum <= 0) return
  if (heap.length < maximum) {
    heap.push(candidate)
    let index = heap.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (compareCandidateQuality(heap[index], heap[parent]) >= 0) break
      ;[heap[index], heap[parent]] = [heap[parent], heap[index]]
      index = parent
    }
    return
  }
  if (compareCandidateQuality(candidate, heap[0]) <= 0) return

  heap[0] = candidate
  let index = 0
  for (;;) {
    const left = index * 2 + 1
    if (left >= heap.length) break
    const right = left + 1
    const worseChild =
      right < heap.length && compareCandidateQuality(heap[right], heap[left]) < 0 ? right : left
    if (compareCandidateQuality(heap[worseChild], heap[index]) >= 0) break
    ;[heap[index], heap[worseChild]] = [heap[worseChild], heap[index]]
    index = worseChild
  }
}
