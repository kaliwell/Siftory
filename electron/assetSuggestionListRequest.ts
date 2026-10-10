import type { AssetLibrarySuggestionListRequest } from '../shared/ipc/asset-library'

export interface NormalizedAssetSuggestionListRequest {
  offset: number
  limit: number
  status?: Exclude<AssetLibrarySuggestionListRequest['status'], 'all' | undefined>
  source?: Exclude<AssetLibrarySuggestionListRequest['source'], 'all' | undefined>
}

export function normalizeAssetSuggestionListRequest(
  request: AssetLibrarySuggestionListRequest = {},
): NormalizedAssetSuggestionListRequest {
  const offset = Number.isFinite(request.offset) ? Math.max(0, Math.floor(request.offset || 0)) : 0
  const limit = Number.isFinite(request.limit)
    ? Math.max(1, Math.min(200, Math.floor(request.limit || 80)))
    : 80
  return {
    offset,
    limit,
    ...(request.status !== undefined && request.status !== 'all' ? { status: request.status } : {}),
    ...(request.source !== undefined && request.source !== 'all' ? { source: request.source } : {}),
  }
}
