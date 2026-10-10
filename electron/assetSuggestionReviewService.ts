import type {
  AssetClassificationSuggestion,
  AssetLibraryMutationResult,
  AssetLibrarySuggestionListRequest,
  AssetLibrarySuggestionListResponse,
  AssetRecord,
} from '../shared/ipc/asset-library'
import { upsertCategoryAssignments } from './assetLibraryAssignmentService'
import {
  getAssetLibraryBaseDir,
  requireAssetLibraryStores,
  sqliteWriteDb,
  withShadowRead,
  withSqliteWrite,
} from './assetLibraryStorageContext'
import { undoSuggestionReviewState } from './assetSuggestionReview'
import { runJsonLinesTransaction } from './jsonLinesTransaction'
import { normalizeAssetSuggestionListRequest } from './assetSuggestionListRequest'

export interface AssetSuggestionReviewHost {
  markFeedbackDirty(reason: string): Promise<void>
}

function isActiveAsset(asset: AssetRecord | undefined): asset is AssetRecord {
  return !!asset && !asset.missing && !asset.archived
}

export async function listAssetSuggestionItems(
  request: AssetLibrarySuggestionListRequest = {},
): Promise<AssetLibrarySuggestionListResponse> {
  const stores = requireAssetLibraryStores()
  await stores.assets.ensureLoaded()
  const {
    offset,
    limit,
    status: statusFilter,
    source: sourceFilter,
  } = normalizeAssetSuggestionListRequest(request)
  const categories = new Map(stores.categories.getAll().map((item) => [item.id, item]))
  const tags = new Map(stores.tags.getAll().map((item) => [item.id, item]))
  const page = withShadowRead(
    (db) => {
      // Exact legacy semantics, decomposed for speed: dead targets are
      // resolved against the in-memory category/tag maps, the active filter
      // uses the asset store, and `total` is derived from COUNT queries
      // (see suggestionCountExact) instead of materializing all rows.
      const targetIds = db.suggestionTargetIds()
      const deadCategoryIds = targetIds.categoryIds.filter((id) => !categories.has(id))
      const deadTagIds = targetIds.tagIds.filter((id) => !tags.has(id))
      const inactiveAssetIds = stores.assets.inactiveIds()
      const total = db.suggestionCountExact({
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(sourceFilter ? { source: sourceFilter } : {}),
        inactiveAssetIds,
        deadCategoryIds,
        deadTagIds,
      })
      const suggestions: AssetClassificationSuggestion[] = []
      let skipped = 0
      for (const suggestion of db.iterateSuggestions({
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(sourceFilter ? { source: sourceFilter } : {}),
        deadCategoryIds,
        deadTagIds,
      })) {
        if (!isActiveAsset(stores.assets.getById(suggestion.assetId))) continue
        if (skipped < offset) {
          skipped += 1
          continue
        }
        suggestions.push(suggestion)
        if (suggestions.length >= limit) break
      }
      return { suggestions, total }
    },
    () => null,
  )
  if (page) {
    return {
      items: page.suggestions.map((suggestion) => ({
        suggestion,
        asset: stores.assets.getById(suggestion.assetId)!,
        ...(suggestion.categoryId ? { category: categories.get(suggestion.categoryId) } : {}),
        ...(suggestion.tagId ? { tag: tags.get(suggestion.tagId) } : {}),
      })),
      total: page.total,
      offset,
      limit,
    }
  }
  const candidates = stores.suggestions
    .getAll()
    .filter(
      (item) =>
        (statusFilter === undefined || item.status === statusFilter) &&
        (sourceFilter === undefined || item.source === sourceFilter),
    )
  // Legacy JSONL path: the active/target-exists filter stays in memory, so
  // `total` keeps its pre-pagination meaning.
  const filtered = candidates
    .filter(
      (item) =>
        isActiveAsset(stores.assets.getById(item.assetId)) &&
        (item.categoryId !== undefined
          ? categories.has(item.categoryId)
          : item.tagId !== undefined
            ? tags.has(item.tagId)
            : false),
    )
    .sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt)
  return {
    items: filtered.slice(offset, offset + limit).map((suggestion) => ({
      suggestion,
      asset: stores.assets.getById(suggestion.assetId)!,
      ...(suggestion.categoryId ? { category: categories.get(suggestion.categoryId) } : {}),
      ...(suggestion.tagId ? { tag: tags.get(suggestion.tagId) } : {}),
    })),
    total: filtered.length,
    offset,
    limit,
  }
}

export async function reviewAssetSuggestionItems(
  ids: number[],
  status: 'confirmed' | 'rejected' | 'ignored',
  host: AssetSuggestionReviewHost,
): Promise<AssetLibraryMutationResult> {
  const stores = requireAssetLibraryStores()
  await stores.assets.ensureLoaded()
  const targetIds = new Set(ids)
  if (targetIds.size === 0) return { ok: false, error: 'No suggestions selected' }
  const suggestions = stores.suggestions.getAll()
  const selected = suggestions.filter((suggestion) => targetIds.has(suggestion.id))
  if (selected.length !== targetIds.size) {
    return { ok: false, error: 'One or more suggestions no longer exist; refresh and try again' }
  }
  if (selected.every((suggestion) => suggestion.status === status)) {
    return { ok: true, affected: 0 }
  }
  if (status !== 'confirmed' && selected.some((suggestion) => suggestion.status === 'confirmed')) {
    return {
      ok: false,
      error: 'Undo accepted suggestions before changing them to another review state',
    }
  }
  for (const suggestion of selected) {
    if (!isActiveAsset(stores.assets.getById(suggestion.assetId))) {
      return { ok: false, error: 'A selected suggestion references an unavailable asset' }
    }
    const hasCategory = suggestion.categoryId !== undefined
    const hasTag = suggestion.tagId !== undefined
    if (hasCategory === hasTag) {
      return { ok: false, error: 'A selected suggestion has an invalid target' }
    }
    if (hasCategory && !stores.categories.getById(suggestion.categoryId!)) {
      return { ok: false, error: 'A selected suggestion references a deleted category' }
    }
    if (hasTag && !stores.tags.getById(suggestion.tagId!)) {
      return { ok: false, error: 'A selected suggestion references a deleted tag' }
    }
  }
  const now = Date.now()
  const writesCategoryAssignments =
    status === 'confirmed' && selected.some((suggestion) => suggestion.categoryId !== undefined)
  const writesTagAssignments =
    status === 'confirmed' && selected.some((suggestion) => suggestion.tagId !== undefined)
  const categoryAssignments = writesCategoryAssignments ? stores.categoryAssignments.getAll() : []
  const tagAssignments = writesTagAssignments ? stores.tagAssignments.getAll() : []
  const feedbackChanged = selected.some((suggestion) => {
    const previous =
      suggestion.status === 'confirmed'
        ? 'positive'
        : suggestion.status === 'rejected'
          ? 'negative'
          : 'neutral'
    const next =
      status === 'confirmed' ? 'positive' : status === 'rejected' ? 'negative' : 'neutral'
    return previous !== next
  })
  for (let index = 0; index < suggestions.length; index++) {
    const suggestion = suggestions[index]
    if (!targetIds.has(suggestion.id)) continue
    suggestions[index] = { ...suggestion, status, updatedAt: now }
    if (status !== 'confirmed') continue
    if (suggestion.categoryId) {
      upsertCategoryAssignments(
        categoryAssignments,
        [suggestion.assetId],
        suggestion.categoryId,
        suggestion.source,
        new Map([[suggestion.assetId, suggestion.confidence]]),
        suggestion.id,
      )
    }
    if (suggestion.tagId) {
      const existing = tagAssignments.find(
        (item) => item.assetId === suggestion.assetId && item.tagId === suggestion.tagId,
      )
      if (!existing) {
        tagAssignments.push({
          id: 0,
          assetId: suggestion.assetId,
          tagId: suggestion.tagId,
          suggestionId: suggestion.id,
          confidence: suggestion.confidence,
          source: suggestion.source,
          status: 'confirmed',
          confirmedByUser: true,
          createdAt: now,
          updatedAt: now,
        })
      } else if (existing.source !== 'manual') {
        Object.assign(existing, {
          confidence: suggestion.confidence,
          source: suggestion.source,
          suggestionId: suggestion.id,
          status: 'confirmed',
          confirmedByUser: true,
          updatedAt: now,
        })
      }
    }
  }
  if (sqliteWriteDb()) {
    withSqliteWrite((db) => {
      db.updateSuggestionStatus([...targetIds], status, now)
      if (writesCategoryAssignments) {
        const changed = categoryAssignments.filter(
          (item) => item.id === 0 || item.updatedAt === now,
        )
        for (const item of changed) {
          if (item.id === 0) item.id = db.allocateId('asset_categories')
        }
        db.upsertCategoryAssignments(changed)
      }
      if (writesTagAssignments) {
        const changed = tagAssignments.filter((item) => item.id === 0 || item.updatedAt === now)
        for (const item of changed) {
          if (item.id === 0) item.id = db.allocateId('asset_tags')
        }
        db.upsertTagAssignments(changed)
      }
    })
    stores.suggestions.replaceAll(suggestions)
    if (writesCategoryAssignments) stores.categoryAssignments.replaceAll(categoryAssignments)
    if (writesTagAssignments) stores.tagAssignments.replaceAll(tagAssignments)
    if (feedbackChanged) await host.markFeedbackDirty(`AI suggestions reviewed as ${status}`)
    return { ok: true, affected: selected.length }
  }
  await runJsonLinesTransaction(
    getAssetLibraryBaseDir(),
    [
      stores.suggestions,
      ...(writesCategoryAssignments ? [stores.categoryAssignments] : []),
      ...(writesTagAssignments ? [stores.tagAssignments] : []),
    ],
    () => {
      stores.suggestions.replaceAll(suggestions)
      if (writesCategoryAssignments) {
        stores.categoryAssignments.replaceAll(
          categoryAssignments.map((item) => (item.id > 0 ? item : { ...item, id: undefined })),
        )
      }
      if (writesTagAssignments) {
        stores.tagAssignments.replaceAll(
          tagAssignments.map((item) => (item.id > 0 ? item : { ...item, id: undefined })),
        )
      }
    },
  )
  if (feedbackChanged) await host.markFeedbackDirty(`AI suggestions reviewed as ${status}`)
  return { ok: true, affected: selected.length }
}

export async function undoAssetSuggestionReviews(
  ids: number[],
  host: AssetSuggestionReviewHost,
): Promise<AssetLibraryMutationResult> {
  const stores = requireAssetLibraryStores()
  const targetIds = new Set(ids)
  if (targetIds.size === 0) return { ok: false, error: 'No suggestions selected' }
  const existingIds = new Set(stores.suggestions.getAll().map((suggestion) => suggestion.id))
  if ([...targetIds].some((id) => !existingIds.has(id))) {
    return { ok: false, error: 'One or more suggestions no longer exist; refresh and try again' }
  }
  const result = undoSuggestionReviewState(
    ids,
    stores.suggestions.getAll(),
    stores.categoryAssignments.getAll(),
    stores.tagAssignments.getAll(),
  )
  if (result.found === 0) return { ok: false, error: 'Suggestion not found' }

  if (sqliteWriteDb()) {
    const now = Date.now()
    const sqliteResult = undoSuggestionReviewState(
      ids,
      stores.suggestions.getAll(),
      stores.categoryAssignments.getAll(),
      stores.tagAssignments.getAll(),
      now,
    )
    const removedCategoryAssignmentIds = stores.categoryAssignments
      .getAll()
      .map((item) => item.id!)
      .filter((id) => !sqliteResult.categoryAssignments.some((item) => item.id === id))
    const removedTagAssignmentIds = stores.tagAssignments
      .getAll()
      .map((item) => item.id!)
      .filter((id) => !sqliteResult.tagAssignments.some((item) => item.id === id))
    withSqliteWrite((db) => {
      db.updateSuggestionStatus(ids, 'suggested', now)
      db.deleteAssignmentsByIds('asset_categories', removedCategoryAssignmentIds)
      db.deleteAssignmentsByIds('asset_tags', removedTagAssignmentIds)
    })
    stores.suggestions.replaceAll(sqliteResult.suggestions)
    stores.categoryAssignments.replaceAll(sqliteResult.categoryAssignments)
    stores.tagAssignments.replaceAll(sqliteResult.tagAssignments)
    await host.markFeedbackDirty('AI suggestion review undone')
    return { ok: true, affected: sqliteResult.found }
  }

  await runJsonLinesTransaction(
    getAssetLibraryBaseDir(),
    [stores.suggestions, stores.categoryAssignments, stores.tagAssignments],
    () => {
      stores.suggestions.replaceAll(result.suggestions)
      stores.categoryAssignments.replaceAll(result.categoryAssignments)
      stores.tagAssignments.replaceAll(result.tagAssignments)
    },
  )
  await host.markFeedbackDirty('AI suggestion review undone')
  return { ok: true, affected: result.found }
}
