import type {
  AssetCategoryAssignment,
  AssetClassificationSuggestion,
  AssetTagAssignment,
} from '../shared/ipc/asset-library'

export interface UndoSuggestionReviewResult {
  found: number
  suggestions: AssetClassificationSuggestion[]
  categoryAssignments: AssetCategoryAssignment[]
  tagAssignments: AssetTagAssignment[]
}

export function undoSuggestionReviewState(
  ids: number[],
  suggestions: AssetClassificationSuggestion[],
  categoryAssignments: AssetCategoryAssignment[],
  tagAssignments: AssetTagAssignment[],
  now = Date.now(),
): UndoSuggestionReviewResult {
  const targetIds = new Set(ids)
  const affected = suggestions.filter((suggestion) => targetIds.has(suggestion.id))
  const categoryPairs = new Set(
    affected
      .filter((suggestion) => suggestion.categoryId !== undefined)
      .map((suggestion) => `${suggestion.assetId}:${suggestion.categoryId}:${suggestion.source}`),
  )
  const tagPairs = new Set(
    affected
      .filter((suggestion) => suggestion.tagId !== undefined)
      .map((suggestion) => `${suggestion.assetId}:${suggestion.tagId}:${suggestion.source}`),
  )

  return {
    found: affected.length,
    suggestions: suggestions.map((suggestion) =>
      targetIds.has(suggestion.id)
        ? { ...suggestion, status: 'suggested', updatedAt: now }
        : suggestion,
    ),
    categoryAssignments: categoryAssignments.filter((assignment) => {
      if (assignment.suggestionId !== undefined) {
        return !targetIds.has(assignment.suggestionId)
      }
      return !categoryPairs.has(
        `${assignment.assetId}:${assignment.categoryId}:${assignment.source}`,
      )
    }),
    tagAssignments: tagAssignments.filter((assignment) => {
      if (assignment.suggestionId !== undefined) {
        return !targetIds.has(assignment.suggestionId)
      }
      return !tagPairs.has(`${assignment.assetId}:${assignment.tagId}:${assignment.source}`)
    }),
  }
}
