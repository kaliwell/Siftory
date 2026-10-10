import type {
  AssetCategoryAssignment,
  AssetClassificationSuggestion,
  AssetClusterGroup,
  AssetClusterMember,
  AssetLibraryStats,
  AssetRecord,
} from '../shared/ipc/asset-library'
import type { AssetMetadataStore } from './assetMetadataStore'

export interface AssetLibrarySqlStats {
  classifiedAssets: number
  suggestedCount: number
  lowConfidenceCount: number
  categoryCount: number
  tagCount: number
  clusterCount: number
  referenceCount: number
}

export interface AssetLibraryRelationStatsInput {
  categoryAssignments: AssetCategoryAssignment[]
  suggestions: AssetClassificationSuggestion[]
  clusterMembers: AssetClusterMember[]
  clusters: AssetClusterGroup[]
  referenceAssetIds: number[]
  categoryCount: number
  tagCount: number
  isActiveAssetId: (assetId: number) => boolean
}

export interface AssetLibraryStatsQueryInput extends AssetLibraryRelationStatsInput {
  assets: AssetMetadataStore
  referenceCount: number
  readSqlStats: (inactiveAssetIds: readonly number[]) => AssetLibrarySqlStats | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formalStatus(status: AssetCategoryAssignment['status']): boolean {
  return status === 'confirmed' || status === 'manual_override'
}

export function computeAssetLibraryRelationStats(
  input: AssetLibraryRelationStatsInput,
): AssetLibrarySqlStats {
  const classifiedAssetIds = new Set(
    input.categoryAssignments
      .filter(
        (assignment) =>
          formalStatus(assignment.status) && input.isActiveAssetId(assignment.assetId),
      )
      .map((assignment) => assignment.assetId),
  )
  const activeSuggestions = input.suggestions.filter((suggestion) =>
    input.isActiveAssetId(suggestion.assetId),
  )
  const activeClusterIds = new Set(
    input.clusterMembers
      .filter((member) => input.isActiveAssetId(member.assetId))
      .map((member) => member.clusterGroupId),
  )
  return {
    classifiedAssets: classifiedAssetIds.size,
    suggestedCount: activeSuggestions.filter((item) => item.status === 'suggested').length,
    lowConfidenceCount: activeSuggestions.filter((item) => item.status === 'low_confidence').length,
    categoryCount: input.categoryCount,
    tagCount: input.tagCount,
    clusterCount: input.clusters.filter(
      (cluster) => cluster.status !== 'ignored' && activeClusterIds.has(cluster.id),
    ).length,
    referenceCount: input.referenceAssetIds.filter(input.isActiveAssetId).length,
  }
}

function availableStats(
  input: AssetLibraryStatsQueryInput,
  relation: AssetLibrarySqlStats,
): AssetLibraryStats {
  const activity = input.assets.activitySummary()
  const state = input.assets.getState()
  const persistence = input.assets.getPersistenceStatus()
  return {
    totalAssets: activity.activeCount,
    classifiedAssets: relation.classifiedAssets,
    unclassifiedAssets: Math.max(0, activity.activeCount - relation.classifiedAssets),
    suggestedCount: relation.suggestedCount,
    lowConfidenceCount: relation.lowConfidenceCount,
    categoryCount: relation.categoryCount,
    tagCount: relation.tagCount,
    clusterCount: relation.clusterCount,
    referenceCount: relation.referenceCount,
    archivedAssets: activity.archivedCount,
    storageState: persistence.state,
    storageCorruptRows: persistence.corruptRows,
    ...(persistence.error ? { storageError: persistence.error } : {}),
    ...(state.lastSyncAt ? { lastSyncAt: state.lastSyncAt } : {}),
    ...(state.sourceManifest ? { sourceManifest: state.sourceManifest } : {}),
  }
}

export async function readAssetLibraryStats(
  input: AssetLibraryStatsQueryInput,
): Promise<AssetLibraryStats> {
  try {
    await input.assets.ensureLoaded()
  } catch (error) {
    const persistence = input.assets.getPersistenceStatus()
    return {
      totalAssets: 0,
      classifiedAssets: 0,
      unclassifiedAssets: 0,
      suggestedCount: 0,
      lowConfidenceCount: 0,
      categoryCount: input.categoryCount,
      tagCount: input.tagCount,
      clusterCount: input.clusters.filter((cluster) => cluster.status !== 'ignored').length,
      referenceCount: input.referenceCount,
      archivedAssets: 0,
      storageState: 'unavailable',
      storageCorruptRows: persistence.corruptRows,
      storageError: persistence.error || errorMessage(error),
    }
  }

  const activity = input.assets.activitySummary()
  const sqlStats = input.readSqlStats(activity.inactiveIds)
  if (sqlStats) return availableStats(input, sqlStats)
  return availableStats(input, computeAssetLibraryRelationStats(input))
}

export function activeAssetById(
  getAssetById: (assetId: number) => AssetRecord | undefined,
): (assetId: number) => boolean {
  return (assetId) => {
    const asset = getAssetById(assetId)
    return !!asset && !asset.missing && !asset.archived
  }
}
