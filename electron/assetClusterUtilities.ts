import path from 'path'
import type { AssetClusterGroup } from '../shared/ipc/asset-library'

export function normalizeClusterScopePaths(scopePaths: string[] | undefined): string[] {
  return [
    ...new Set(
      (scopePaths || [])
        .map((scopePath) => scopePath.trim())
        .filter(Boolean)
        .map((scopePath) => path.resolve(scopePath)),
    ),
  ]
}

export function pathMatchesClusterScope(filePath: string, scopePaths: string[]): boolean {
  if (scopePaths.length === 0) return true
  const candidate = path.resolve(filePath)
  return scopePaths.some((scopePath) => {
    const relative = path.relative(scopePath, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
}

export function clusterStats(members: Array<{ similarity: number }>): {
  assetCount: number
  avgSimilarity: number
} {
  if (members.length === 0) return { assetCount: 0, avgSimilarity: 0 }
  return {
    assetCount: members.length,
    avgSimilarity: members.reduce((sum, member) => sum + member.similarity, 0) / members.length,
  }
}

export function ensureLineageKey(group: AssetClusterGroup): string {
  return group.lineageKey ?? `lg-${group.id}`
}
