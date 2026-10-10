import type { AssetClusterGroup } from '../shared/ipc/asset-library'

export interface ClusterInheritance {
  fromGroupId: number
  lineageKey: string
  status: AssetClusterGroup['status']
  name?: string
}

/**
 * Maps old automatic cluster identities onto recalculated clusters.
 * Each old group can be inherited once, by the first new cluster with the
 * highest Jaccard overlap at or above the configured threshold.
 */
export function computeClusterInheritance(
  oldAutoGroups: AssetClusterGroup[],
  oldMemberSets: Map<number, Set<number>>,
  newClusterMemberIds: number[][],
  threshold = 0.5,
): Map<number, ClusterInheritance> {
  const usedOldGroups = new Set<number>()
  const inheritance = new Map<number, ClusterInheritance>()

  newClusterMemberIds.forEach((memberIds, index) => {
    const newSet = new Set(memberIds)
    let bestJaccard = 0
    let bestOld: AssetClusterGroup | null = null

    for (const old of oldAutoGroups) {
      if (usedOldGroups.has(old.id)) continue
      const oldSet = oldMemberSets.get(old.id) || new Set()
      if (oldSet.size === 0 || newSet.size === 0) continue

      let intersection = 0
      for (const id of newSet) {
        if (oldSet.has(id)) intersection++
      }
      const jaccard = intersection / (newSet.size + oldSet.size - intersection)
      if (jaccard > bestJaccard) {
        bestJaccard = jaccard
        bestOld = old
      }
    }

    if (bestOld && bestJaccard >= threshold) {
      usedOldGroups.add(bestOld.id)
      inheritance.set(index, {
        fromGroupId: bestOld.id,
        lineageKey: bestOld.lineageKey ?? `lg-${bestOld.id}`,
        status: bestOld.status,
        ...(bestOld.status !== 'suggested' ? { name: bestOld.name } : {}),
      })
    }
  })

  return inheritance
}
