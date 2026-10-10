import type {
  AssetCategory,
  AssetCategoryAssignment,
  AssetCategoryReference,
  AssetClassificationSuggestion,
  AssetRecord,
  AssetTag,
  AssetTagAssignment,
} from '../shared/ipc/asset-library'
import type {
  AssetFeedbackSourceSample,
  AssetFeedbackSourceSnapshot,
} from './assetFeedbackModelService'
import {
  addBoundedFeedbackSample,
  assignmentFeedbackWeight,
  type BoundedFeedbackSample,
} from './assetFeedbackSampling'

interface FeedbackTargetAccumulator {
  key: string
  kind: 'category' | 'tag'
  id: number
  name: string
  positive: Map<string, BoundedFeedbackSample>
  negative: Map<string, BoundedFeedbackSample>
}

export interface AssetFeedbackSnapshotInput {
  categories: AssetCategory[]
  tags: AssetTag[]
  categoryAssignments: AssetCategoryAssignment[]
  tagAssignments: AssetTagAssignment[]
  references: Array<Pick<AssetCategoryReference, 'assetId' | 'categoryId' | 'weight'>>
  rejectedSuggestions: AssetClassificationSuggestion[]
  getAssetById: (assetId: number) => AssetRecord | undefined
  maximumPositiveSamples?: number
  maximumNegativeSamples?: number
}

function formalStatus(status: AssetCategoryAssignment['status']): boolean {
  return status === 'confirmed' || status === 'manual_override'
}

function activeAsset(asset: AssetRecord | undefined): asset is AssetRecord {
  return !!asset && !asset.missing && !asset.archived
}

function sourceSamples(samples: Map<string, BoundedFeedbackSample>): AssetFeedbackSourceSample[] {
  return [...samples.values()].map(({ path, weight }) => ({ path, weight }))
}

export function buildAssetFeedbackSourceSnapshot(
  input: AssetFeedbackSnapshotInput,
): AssetFeedbackSourceSnapshot {
  const maximumPositiveSamples = input.maximumPositiveSamples ?? 128
  const maximumNegativeSamples = input.maximumNegativeSamples ?? 128
  const targets = new Map<string, FeedbackTargetAccumulator>()
  for (const category of input.categories) {
    const key = `category:${category.id}`
    targets.set(key, {
      key,
      kind: 'category',
      id: category.id,
      name: category.name,
      positive: new Map(),
      negative: new Map(),
    })
  }
  for (const tag of input.tags) {
    const key = `tag:${tag.id}`
    targets.set(key, {
      key,
      kind: 'tag',
      id: tag.id,
      name: tag.name,
      positive: new Map(),
      negative: new Map(),
    })
  }

  for (const assignment of input.categoryAssignments) {
    if (!formalStatus(assignment.status) || !assignment.confirmedByUser) continue
    const asset = input.getAssetById(assignment.assetId)
    const target = targets.get(`category:${assignment.categoryId}`)
    if (!activeAsset(asset) || !target) continue
    addBoundedFeedbackSample(
      target.positive,
      { path: asset.path, weight: assignmentFeedbackWeight(assignment.source) },
      maximumPositiveSamples,
    )
  }
  for (const assignment of input.tagAssignments) {
    if (!formalStatus(assignment.status) || !assignment.confirmedByUser) continue
    const asset = input.getAssetById(assignment.assetId)
    const target = targets.get(`tag:${assignment.tagId}`)
    if (!activeAsset(asset) || !target) continue
    addBoundedFeedbackSample(
      target.positive,
      { path: asset.path, weight: assignmentFeedbackWeight(assignment.source) },
      maximumPositiveSamples,
    )
  }
  for (const reference of input.references) {
    const asset = input.getAssetById(reference.assetId)
    const target = targets.get(`category:${reference.categoryId}`)
    if (!activeAsset(asset) || !target) continue
    addBoundedFeedbackSample(
      target.positive,
      { path: asset.path, weight: Math.max(0.1, Math.min(10, reference.weight)) },
      maximumPositiveSamples,
    )
  }
  for (const suggestion of input.rejectedSuggestions) {
    if (suggestion.status !== 'rejected') continue
    const asset = input.getAssetById(suggestion.assetId)
    if (!activeAsset(asset)) continue
    const target = suggestion.categoryId
      ? targets.get(`category:${suggestion.categoryId}`)
      : suggestion.tagId
        ? targets.get(`tag:${suggestion.tagId}`)
        : undefined
    if (!target) continue
    addBoundedFeedbackSample(
      target.negative,
      { path: asset.path, weight: 1 },
      maximumNegativeSamples,
    )
  }

  return {
    targets: [...targets.values()]
      .filter((target) => target.positive.size > 0)
      .map((target) => ({
        key: target.key,
        kind: target.kind,
        id: target.id,
        name: target.name,
        positiveSampleCount: target.positive.size,
        negativeSampleCount: target.negative.size,
        positiveSamples: sourceSamples(target.positive),
        negativeSamples: sourceSamples(target.negative),
      })),
  }
}
