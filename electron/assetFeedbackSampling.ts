import type { AssetAssignmentSource } from '../shared/ipc/asset-library'
import type { AssetFeedbackSourceSample } from './assetFeedbackModelService'

export interface BoundedFeedbackSample extends AssetFeedbackSourceSample {
  priority: number
}

export function feedbackPathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export function feedbackPathHash(filePath: string): number {
  let hash = 2166136261
  for (let index = 0; index < filePath.length; index++) {
    hash ^= filePath.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function addBoundedFeedbackSample(
  samples: Map<string, BoundedFeedbackSample>,
  sample: AssetFeedbackSourceSample,
  maximum: number,
): void {
  const key = feedbackPathKey(sample.path)
  const priority = sample.weight * 2 ** 32 + feedbackPathHash(key)
  const existing = samples.get(key)
  if (existing) {
    if (sample.weight > existing.weight) samples.set(key, { ...sample, priority })
    return
  }
  if (samples.size < maximum) {
    samples.set(key, { ...sample, priority })
    return
  }
  let lowestKey = ''
  let lowestPriority = Number.POSITIVE_INFINITY
  for (const [candidateKey, candidate] of samples) {
    if (candidate.priority < lowestPriority) {
      lowestKey = candidateKey
      lowestPriority = candidate.priority
    }
  }
  if (priority <= lowestPriority) return
  samples.delete(lowestKey)
  samples.set(key, { ...sample, priority })
}

export function assignmentFeedbackWeight(source: AssetAssignmentSource): number {
  if (source === 'manual') return 1
  if (source === 'cluster') return 0.75
  return 0.85
}
