import type { AssetLibraryListRequest } from '../shared/ipc/asset-library'

export interface NormalizedAssetLibraryListRequest {
  offset: number
  limit: number
  sort: 'updated_desc' | 'name_asc' | 'size_desc'
  query?: string
  categoryId?: number
  tagId?: number
  unclassified?: true
  archivedOnly?: true
  source?: 'image_search' | 'manual'
  kind?: 'image' | 'video_frame'
  modifiedAfter?: number
  modifiedBefore?: number
  minRating?: number
  favoriteOnly?: true
}

export function normalizeAssetLibraryListRequest(
  request: AssetLibraryListRequest = {},
): NormalizedAssetLibraryListRequest {
  return {
    offset: Number.isFinite(request.offset) ? Math.max(0, Math.floor(request.offset || 0)) : 0,
    limit: Number.isFinite(request.limit)
      ? Math.max(1, Math.min(200, Math.floor(request.limit || 80)))
      : 80,
    sort:
      request.sort === 'name_asc' || request.sort === 'size_desc' ? request.sort : 'updated_desc',
    ...(request.query ? { query: request.query } : {}),
    ...(Number.isInteger(request.categoryId) ? { categoryId: request.categoryId } : {}),
    ...(Number.isInteger(request.tagId) ? { tagId: request.tagId } : {}),
    ...(request.unclassified ? { unclassified: true as const } : {}),
    ...(request.archivedOnly ? { archivedOnly: true as const } : {}),
    ...(request.source === 'image_search' || request.source === 'manual'
      ? { source: request.source }
      : {}),
    ...(request.kind === 'image' || request.kind === 'video_frame' ? { kind: request.kind } : {}),
    ...(Number.isFinite(request.modifiedAfter)
      ? { modifiedAfter: Math.max(0, Math.floor(request.modifiedAfter!)) }
      : {}),
    ...(Number.isFinite(request.modifiedBefore)
      ? { modifiedBefore: Math.max(0, Math.floor(request.modifiedBefore!)) }
      : {}),
    ...(Number.isFinite(request.minRating)
      ? { minRating: Math.max(0, Math.min(5, Math.floor(request.minRating!))) }
      : {}),
    ...(request.favoriteOnly ? { favoriteOnly: true as const } : {}),
  }
}
