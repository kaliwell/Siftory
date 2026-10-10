// Read-only duplicate recall for Phase 3 unified search. The authoritative
// duplicate membership is the persisted asset-library exact/near cluster
// state; this module does not rebuild groups or write derived metadata.

import type {
  AssetClusterGroup,
  AssetClusterMember,
  AssetRecord,
} from '../shared/ipc/asset-library'
import type { UnifiedRecallHit } from './unifiedSearchService'

export interface DuplicateRecallSnapshot {
  referenceAssetId: number
  groups: readonly AssetClusterGroup[]
  members: readonly AssetClusterMember[]
  getAssetById: (assetId: number) => AssetRecord | undefined
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function recallDuplicateGroupHits(snapshot: DuplicateRecallSnapshot): UnifiedRecallHit[] {
  const memberGroupIds = new Set(
    snapshot.members
      .filter((member) => member.assetId === snapshot.referenceAssetId)
      .map((member) => member.clusterGroupId),
  )
  const groups = new Map(
    snapshot.groups
      .filter(
        (group) =>
          memberGroupIds.has(group.id) &&
          group.status !== 'ignored' &&
          (group.algorithm === 'duplicate_exact' || group.algorithm === 'duplicate_near'),
      )
      .map((group) => [group.id, group]),
  )
  const hits = new Map<string, UnifiedRecallHit>()
  for (const member of snapshot.members) {
    if (member.assetId === snapshot.referenceAssetId) continue
    const group = groups.get(member.clusterGroupId)
    if (!group) continue
    const asset = snapshot.getAssetById(member.assetId)
    if (!asset || asset.missing || asset.archived) continue
    const score =
      group.algorithm === 'duplicate_exact'
        ? 1
        : clampScore(member.similarity || group.avgSimilarity)
    const key = asset.path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    const previous = hits.get(key)
    if (!previous || score > previous.score) {
      hits.set(key, { displayPath: asset.path, score })
    }
  }
  return [...hits.values()].sort(
    (left, right) => right.score - left.score || left.displayPath.localeCompare(right.displayPath),
  )
}
