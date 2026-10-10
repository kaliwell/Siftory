import type {
  AssetLibraryCategoryInput,
  AssetLibraryCategorySampleSearchRequest,
  AssetLibraryCategoryClusterRequest,
  AssetLibrarySimilarSearchRequest,
  AssetLibrarySearchResultQuery,
  AssetLibraryClusterRequest,
  AssetMetadataDeletionListRequest,
  AssetLibraryListRequest,
  AssetLibraryReferenceSuggestionRequest,
  AssetLibrarySuggestionListRequest,
  AssetLibraryTagInput,
  AssetLibraryTagSuggestionRequest,
  AssetSmartAlbumInput,
  AssetCollectionItemInput,
  AssetUserMetadataPatch,
} from '../shared/ipc/asset-library'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function referenceThreshold(value: unknown): number | undefined {
  const threshold = finiteNumber(value)
  return threshold === undefined ? undefined : Math.max(0.5, Math.min(1, threshold))
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim().slice(0, maxLength)
}

export function positiveId(value: unknown, label = 'id'): number {
  const id = finiteNumber(value)
  if (!id || id <= 0 || !Number.isInteger(id)) throw new Error(`Invalid ${label}`)
  return id
}

export function positiveIds(value: unknown, maxCount = 2000): number[] {
  if (!Array.isArray(value)) throw new Error('Asset ids must be an array')
  const ids = new Set<number>()
  for (const item of value) {
    const id = finiteNumber(item)
    if (id && id > 0 && Number.isInteger(id)) ids.add(id)
    if (ids.size >= maxCount) break
  }
  if (ids.size === 0) throw new Error('No valid asset ids')
  return [...ids]
}

export function normalizeAssetListRequest(value: unknown): AssetLibraryListRequest {
  const input = record(value)
  const offset = finiteNumber(input.offset)
  const limit = finiteNumber(input.limit)
  const sort = ['updated_desc', 'name_asc', 'size_desc'].includes(String(input.sort))
    ? (input.sort as AssetLibraryListRequest['sort'])
    : undefined
  return {
    ...(offset !== undefined ? { offset: Math.max(0, Math.floor(offset)) } : {}),
    ...(limit !== undefined ? { limit: Math.max(1, Math.min(200, Math.floor(limit))) } : {}),
    ...(optionalText(input.query, 500) ? { query: optionalText(input.query, 500) } : {}),
    ...(finiteNumber(input.categoryId) !== undefined
      ? { categoryId: positiveId(input.categoryId, 'category id') }
      : {}),
    ...(finiteNumber(input.tagId) !== undefined
      ? { tagId: positiveId(input.tagId, 'tag id') }
      : {}),
    ...(input.unclassified === true ? { unclassified: true } : {}),
    ...(input.archivedOnly === true ? { archivedOnly: true } : {}),
    ...(['image_search', 'manual'].includes(String(input.source))
      ? { source: input.source as AssetLibraryListRequest['source'] }
      : {}),
    ...(['image', 'video_frame'].includes(String(input.kind))
      ? { kind: input.kind as AssetLibraryListRequest['kind'] }
      : {}),
    ...(finiteNumber(input.modifiedAfter) !== undefined
      ? { modifiedAfter: Math.max(0, Math.floor(finiteNumber(input.modifiedAfter)!)) }
      : {}),
    ...(finiteNumber(input.modifiedBefore) !== undefined
      ? { modifiedBefore: Math.max(0, Math.floor(finiteNumber(input.modifiedBefore)!)) }
      : {}),
    ...(finiteNumber(input.minRating) !== undefined
      ? { minRating: Math.max(0, Math.min(5, Math.floor(finiteNumber(input.minRating)!))) }
      : {}),
    ...(input.favoriteOnly === true ? { favoriteOnly: true } : {}),
    ...(sort ? { sort } : {}),
  }
}

export function normalizeAssetUserMetadataPatch(value: unknown): AssetUserMetadataPatch {
  const input = record(value)
  const patch: AssetUserMetadataPatch = {}
  if (finiteNumber(input.rating) !== undefined) {
    patch.rating = Math.max(0, Math.min(5, Math.floor(finiteNumber(input.rating)!)))
  }
  if (typeof input.favorite === 'boolean') patch.favorite = input.favorite
  if (patch.rating === undefined && patch.favorite === undefined) {
    throw new Error('Rating or favorite value is required')
  }
  return patch
}

function normalizeSmartAlbumValue(
  value: unknown,
  partial: boolean,
): AssetSmartAlbumInput | Partial<AssetSmartAlbumInput> {
  const input = record(value)
  const name = optionalText(input.name, 120) || ''
  if (!partial && !name) throw new Error('Smart album name is required')
  const normalizedRules = normalizeAssetListRequest(input.rules)
  const result = {
    ...(!partial || typeof input.name === 'string' ? { name } : {}),
    ...(input.rules && typeof input.rules === 'object' && !Array.isArray(input.rules)
      ? { rules: { ...normalizedRules, sort: normalizedRules.sort || 'updated_desc' } }
      : {}),
  }
  if (!partial && !result.rules) throw new Error('Smart album rules are required')
  return result as AssetSmartAlbumInput
}

export function normalizeSmartAlbumInput(value: unknown): AssetSmartAlbumInput {
  return normalizeSmartAlbumValue(value, false) as AssetSmartAlbumInput
}

export function normalizeSmartAlbumPatch(value: unknown): Partial<AssetSmartAlbumInput> {
  return normalizeSmartAlbumValue(value, true)
}

export function normalizeCollectionItemInput(value: unknown): AssetCollectionItemInput {
  const input = record(value)
  const source = record(input.source)
  const sourceTypes = [
    'local-ntfs',
    'local-generic',
    'removable',
    'mounted-network',
    'sftp',
    'nas-agent',
  ]
  const availability = ['online', 'offline', 'degraded', 'unknown']
  const fileEntryId = optionalText(input.fileEntryId, 180)
  const displayName = optionalText(input.displayName, 500)
  const displayPath = optionalText(input.displayPath, 4096)
  const sourceId = optionalText(source.id, 180)
  const sourceName = optionalText(source.name, 500)
  const sourceType = String(source.type)
  const sourceAvailability = String(source.availability)
  const assetId = optionalText(input.assetId, 180)
  if ((!fileEntryId && !assetId) || !displayName || !displayPath || !sourceId || !sourceName) {
    throw new Error('Invalid collection item')
  }
  if (!sourceTypes.includes(sourceType) || !availability.includes(sourceAvailability)) {
    throw new Error('Invalid collection item source')
  }
  if (assetId && !/^asset_[0-9a-f]{24}$/.test(assetId)) throw new Error('Invalid AssetId')
  if (fileEntryId && !/^[1-9]\d{0,15}$/.test(fileEntryId)) {
    throw new Error('Invalid catalog entry id')
  }
  return {
    ...(assetId ? { assetId } : {}),
    ...(fileEntryId ? { fileEntryId } : {}),
    mediaType: optionalText(input.mediaType, 40) || 'other',
    displayName,
    displayPath,
    sizeBytes: Math.max(0, Math.floor(finiteNumber(input.sizeBytes) || 0)),
    modifiedAt: Math.max(0, Math.floor(finiteNumber(input.modifiedAt) || 0)),
    ...(optionalText(input.videoId, 180) ? { videoId: optionalText(input.videoId, 180) } : {}),
    ...(finiteNumber(input.videoHitMs) !== undefined
      ? { videoHitMs: Math.max(0, Math.floor(finiteNumber(input.videoHitMs)!)) }
      : {}),
    source: {
      id: sourceId,
      name: sourceName,
      type: sourceType as AssetCollectionItemInput['source']['type'],
      availability: sourceAvailability as AssetCollectionItemInput['source']['availability'],
    },
  }
}

export function normalizeCollectionItemInputs(value: unknown): AssetCollectionItemInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new Error('Collection item batch must contain 1 to 500 items')
  }
  return value.map(normalizeCollectionItemInput)
}

export function normalizeMetadataDeletionListRequest(
  value: unknown,
): AssetMetadataDeletionListRequest {
  const input = record(value)
  const offset = finiteNumber(input.offset)
  const limit = finiteNumber(input.limit)
  const status = ['all', 'pending', 'restored'].includes(String(input.status))
    ? (input.status as AssetMetadataDeletionListRequest['status'])
    : undefined
  return {
    ...(offset !== undefined ? { offset: Math.max(0, Math.floor(offset)) } : {}),
    ...(limit !== undefined ? { limit: Math.max(1, Math.min(50, Math.floor(limit))) } : {}),
    ...(status ? { status } : {}),
  }
}

export function normalizeCategoryInput(
  value: unknown,
  partial = false,
): Partial<AssetLibraryCategoryInput> & Pick<AssetLibraryCategoryInput, 'name'> {
  const input = record(value)
  const name = optionalText(input.name, 120) || ''
  if (!partial && !name) throw new Error('Category name is required')
  const parentId = input.parentId === null ? null : finiteNumber(input.parentId)
  return {
    name,
    ...(typeof input.description === 'string'
      ? { description: optionalText(input.description, 1000) || '' }
      : {}),
    ...(parentId === null ? { parentId: null } : {}),
    ...(typeof parentId === 'number' && parentId > 0
      ? { parentId: positiveId(parentId, 'parent category id') }
      : {}),
    ...(optionalText(input.color, 32) ? { color: optionalText(input.color, 32) } : {}),
    ...(optionalText(input.icon, 40) ? { icon: optionalText(input.icon, 40) } : {}),
    ...(finiteNumber(input.sortOrder) !== undefined
      ? { sortOrder: finiteNumber(input.sortOrder) }
      : {}),
    ...(referenceThreshold(input.referenceThreshold) !== undefined
      ? { referenceThreshold: referenceThreshold(input.referenceThreshold) }
      : {}),
  }
}

export function normalizeTagInput(
  value: unknown,
  partial = false,
): Partial<AssetLibraryTagInput> & Pick<AssetLibraryTagInput, 'name'> {
  const input = record(value)
  const name = optionalText(input.name, 120) || ''
  if (!partial && !name) throw new Error('Tag name is required')
  return {
    name,
    ...(optionalText(input.color, 32) ? { color: optionalText(input.color, 32) } : {}),
  }
}

export function normalizeReferenceSuggestionRequest(
  value: unknown,
): AssetLibraryReferenceSuggestionRequest {
  const input = record(value)
  return {
    ...(finiteNumber(input.categoryId) !== undefined
      ? { categoryId: positiveId(input.categoryId, 'category id') }
      : {}),
    ...(finiteNumber(input.threshold) !== undefined
      ? { threshold: finiteNumber(input.threshold) }
      : {}),
    ...(finiteNumber(input.lowConfidenceThreshold) !== undefined
      ? { lowConfidenceThreshold: finiteNumber(input.lowConfidenceThreshold) }
      : {}),
    ...(finiteNumber(input.maxPerCategory) !== undefined
      ? { maxPerCategory: finiteNumber(input.maxPerCategory) }
      : {}),
  }
}

export function normalizeTagSuggestionRequest(value: unknown): AssetLibraryTagSuggestionRequest {
  const input = record(value)
  return {
    ...(Array.isArray(input.tagIds) ? { tagIds: positiveIds(input.tagIds, 100) } : {}),
    ...(finiteNumber(input.threshold) !== undefined
      ? { threshold: finiteNumber(input.threshold) }
      : {}),
    ...(finiteNumber(input.lowConfidenceThreshold) !== undefined
      ? { lowConfidenceThreshold: finiteNumber(input.lowConfidenceThreshold) }
      : {}),
    ...(finiteNumber(input.maxPerTag) !== undefined
      ? { maxPerTag: finiteNumber(input.maxPerTag) }
      : {}),
  }
}

export function normalizeSuggestionListRequest(value: unknown): AssetLibrarySuggestionListRequest {
  const input = record(value)
  const statuses = [
    'all',
    'suggested',
    'confirmed',
    'rejected',
    'low_confidence',
    'manual_override',
    'ignored',
  ]
  const sources = ['all', 'reference_image', 'text_label', 'cluster']
  return {
    ...(statuses.includes(String(input.status))
      ? { status: input.status as AssetLibrarySuggestionListRequest['status'] }
      : {}),
    ...(sources.includes(String(input.source))
      ? { source: input.source as AssetLibrarySuggestionListRequest['source'] }
      : {}),
    ...(finiteNumber(input.offset) !== undefined ? { offset: finiteNumber(input.offset) } : {}),
    ...(finiteNumber(input.limit) !== undefined ? { limit: finiteNumber(input.limit) } : {}),
  }
}

export function normalizeClusterRequest(value: unknown): AssetLibraryClusterRequest {
  const input = record(value)
  const scopePaths = Array.isArray(input.scopePaths)
    ? [...new Set(input.scopePaths.map((item) => optionalText(item, 4096)).filter(Boolean))].slice(
        0,
        64,
      )
    : []
  return {
    ...(finiteNumber(input.maxClusters) !== undefined
      ? { maxClusters: finiteNumber(input.maxClusters) }
      : {}),
    ...(typeof input.autoClusters === 'boolean' ? { autoClusters: input.autoClusters } : {}),
    ...(finiteNumber(input.minSimilarity) !== undefined
      ? { minSimilarity: finiteNumber(input.minSimilarity) }
      : {}),
    ...(finiteNumber(input.maxAssets) !== undefined
      ? { maxAssets: finiteNumber(input.maxAssets) }
      : {}),
    ...(finiteNumber(input.minClusterSize) !== undefined
      ? { minClusterSize: finiteNumber(input.minClusterSize) }
      : {}),
    ...(scopePaths.length > 0 ? { scopePaths: scopePaths as string[] } : {}),
    ...(typeof input.semanticRefine === 'boolean' ? { semanticRefine: input.semanticRefine } : {}),
    ...(finiteNumber(input.semanticSimilarity) !== undefined
      ? { semanticSimilarity: finiteNumber(input.semanticSimilarity) }
      : {}),
    ...(finiteNumber(input.semanticMaxSplits) !== undefined
      ? { semanticMaxSplits: finiteNumber(input.semanticMaxSplits) }
      : {}),
  }
}

export function normalizeCategoryClusterRequest(
  value: unknown,
): AssetLibraryCategoryClusterRequest {
  const input = record(value)
  const topK = finiteNumber(input.topK)
  const minScore = finiteNumber(input.minScore)
  const scopePaths = Array.isArray(input.scopePaths)
    ? [...new Set(input.scopePaths.map((item) => optionalText(item, 4096)).filter(Boolean))].slice(
        0,
        64,
      )
    : []
  return {
    categoryId: positiveId(input.categoryId, 'category id'),
    ...(topK !== undefined ? { topK: Math.max(10, Math.min(5000, Math.floor(topK))) } : {}),
    ...(minScore !== undefined ? { minScore: Math.max(0, Math.min(1, minScore)) } : {}),
    ...(input.includeReviewed === true ? { includeReviewed: true } : {}),
    ...(scopePaths.length > 0 ? { scopePaths: scopePaths as string[] } : {}),
  }
}

export function normalizeCategorySampleSearchRequest(
  value: unknown,
): AssetLibraryCategorySampleSearchRequest {
  const input = record(value)
  const topK = finiteNumber(input.topK)
  return {
    categoryId: positiveId(input.categoryId, 'category id'),
    ...(topK !== undefined ? { topK: Math.max(10, Math.min(500, Math.floor(topK))) } : {}),
    ...(input.includeReviewed === true ? { includeReviewed: true } : {}),
  }
}

export function normalizeSimilarSearchRequest(value: unknown): AssetLibrarySimilarSearchRequest {
  const input = record(value)
  const topK = finiteNumber(input.topK)
  const categoryId = finiteNumber(input.categoryId)
  return {
    assetId: positiveId(input.assetId, 'asset id'),
    ...(topK !== undefined ? { topK: Math.max(10, Math.min(500, Math.floor(topK))) } : {}),
    ...(categoryId !== undefined ? { categoryId: positiveId(categoryId, 'category id') } : {}),
    ...(input.includeReviewed === true ? { includeReviewed: true } : {}),
  }
}

export function normalizeSearchResultQuery(
  value: unknown,
  allowLegacyCategory = false,
): AssetLibrarySearchResultQuery {
  if (allowLegacyCategory && finiteNumber(value) !== undefined) {
    return { categoryId: positiveId(value, 'category id') }
  }
  const input = record(value)
  const taskId = optionalText(input.taskId, 160)
  const resultId = optionalText(input.resultId, 160)
  const categoryId = finiteNumber(input.categoryId)
  return {
    ...(taskId ? { taskId } : {}),
    ...(resultId ? { resultId } : {}),
    ...(categoryId !== undefined ? { categoryId: positiveId(categoryId, 'category id') } : {}),
  }
}

export function optionalSafeText(value: unknown, maxLength = 32_768): string | undefined {
  return optionalText(value, maxLength)
}

export function inputRecord(value: unknown): Record<string, unknown> {
  return record(value)
}
