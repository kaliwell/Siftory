import type {
  AssetCategoryAssignment,
  AssetLibraryAssetItem,
  AssetLibraryListResponse,
  AssetTagAssignment,
} from '../shared/ipc/asset-library'
import { AssetLibraryDatabase } from './assetLibraryDatabase'
import type { NormalizedAssetLibraryListRequest } from './assetLibraryListRequest'
import { AssetMetadataStore } from './assetMetadataStore'

function formalAssignment<T extends AssetCategoryAssignment | AssetTagAssignment>(
  assignment: T,
): boolean {
  return assignment.status === 'confirmed' || assignment.status === 'manual_override'
}

function appendAssignment<T extends AssetCategoryAssignment | AssetTagAssignment>(
  assignmentsByAsset: Map<number, T[]>,
  assignment: T,
): void {
  const list = assignmentsByAsset.get(assignment.assetId) || []
  list.push(assignment)
  assignmentsByAsset.set(assignment.assetId, list)
}

function listResponse(
  listed: Awaited<ReturnType<AssetMetadataStore['list']>>,
  normalized: NormalizedAssetLibraryListRequest,
  categoriesByAsset: Map<number, AssetCategoryAssignment[]>,
  tagsByAsset: Map<number, AssetTagAssignment[]>,
): AssetLibraryListResponse {
  const items: AssetLibraryAssetItem[] = listed.records.map((asset) => ({
    asset,
    categories: categoriesByAsset.get(asset.id) || [],
    tags: tagsByAsset.get(asset.id) || [],
  }))
  return { items, total: listed.total, offset: normalized.offset, limit: normalized.limit }
}

export async function listAssetLibraryAssetsFromJsonl(
  assets: AssetMetadataStore,
  categoryAssignments: AssetCategoryAssignment[],
  tagAssignments: AssetTagAssignment[],
  normalized: NormalizedAssetLibraryListRequest,
): Promise<AssetLibraryListResponse> {
  const formalCategoryAssignments = categoryAssignments.filter(formalAssignment)
  const formalTagAssignments = tagAssignments.filter(formalAssignment)
  const categoriesByAsset = new Map<number, AssetCategoryAssignment[]>()
  const tagsByAsset = new Map<number, AssetTagAssignment[]>()
  const relationFiltered =
    normalized.unclassified || normalized.categoryId !== undefined || normalized.tagId !== undefined
  if (relationFiltered) {
    for (const assignment of formalCategoryAssignments) {
      appendAssignment(categoriesByAsset, assignment)
    }
    for (const assignment of formalTagAssignments) {
      appendAssignment(tagsByAsset, assignment)
    }
  }
  const listed = await assets.list(
    normalized,
    relationFiltered
      ? (assetId) => {
          const assetCategories = categoriesByAsset.get(assetId) || []
          const assetTags = tagsByAsset.get(assetId) || []
          if (normalized.unclassified && assetCategories.length > 0) return false
          if (
            normalized.categoryId !== undefined &&
            !assetCategories.some((assignment) => assignment.categoryId === normalized.categoryId)
          ) {
            return false
          }
          if (
            normalized.tagId !== undefined &&
            !assetTags.some((assignment) => assignment.tagId === normalized.tagId)
          ) {
            return false
          }
          return true
        }
      : undefined,
  )
  if (!relationFiltered) {
    const pageIds = new Set(listed.records.map((asset) => asset.id))
    for (const assignment of formalCategoryAssignments) {
      if (pageIds.has(assignment.assetId)) appendAssignment(categoriesByAsset, assignment)
    }
    for (const assignment of formalTagAssignments) {
      if (pageIds.has(assignment.assetId)) appendAssignment(tagsByAsset, assignment)
    }
  }
  return listResponse(listed, normalized, categoriesByAsset, tagsByAsset)
}

export async function listAssetLibraryAssetsFromSql(
  assets: AssetMetadataStore,
  normalized: NormalizedAssetLibraryListRequest,
  db: AssetLibraryDatabase,
): Promise<AssetLibraryListResponse> {
  const relationFiltered =
    normalized.unclassified || normalized.categoryId !== undefined || normalized.tagId !== undefined
  let relationPredicate: ((assetId: number) => boolean) | undefined
  if (relationFiltered) {
    const anyCategoryIds = normalized.unclassified
      ? new Set(db.listCategoryAssignments({ formalOnly: true }).map((item) => item.assetId))
      : null
    const categoryIds =
      normalized.categoryId !== undefined
        ? new Set(
            db
              .listCategoryAssignments({ formalOnly: true, categoryId: normalized.categoryId })
              .map((item) => item.assetId),
          )
        : null
    const tagIds =
      normalized.tagId !== undefined
        ? new Set(
            db
              .listTagAssignments({ formalOnly: true, tagId: normalized.tagId })
              .map((item) => item.assetId),
          )
        : null
    relationPredicate = (assetId) => {
      if (anyCategoryIds?.has(assetId)) return false
      if (categoryIds && !categoryIds.has(assetId)) return false
      if (tagIds && !tagIds.has(assetId)) return false
      return true
    }
  }
  const listed = await assets.list(normalized, relationPredicate)
  const categoriesByAsset = new Map<number, AssetCategoryAssignment[]>()
  const tagsByAsset = new Map<number, AssetTagAssignment[]>()
  const pageIds = listed.records.map((asset) => asset.id)
  for (const assignment of db.listCategoryAssignments({ formalOnly: true, assetIds: pageIds })) {
    appendAssignment(categoriesByAsset, assignment)
  }
  for (const assignment of db.listTagAssignments({ formalOnly: true, assetIds: pageIds })) {
    appendAssignment(tagsByAsset, assignment)
  }
  return listResponse(listed, normalized, categoriesByAsset, tagsByAsset)
}
