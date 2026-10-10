export function resolveSelectionRange(
  orderedIds: readonly number[],
  anchorId: number | null,
  targetId: number,
): number[] | null {
  if (anchorId === null) return null
  const anchorIndex = orderedIds.indexOf(anchorId)
  const targetIndex = orderedIds.indexOf(targetId)
  if (anchorIndex < 0 || targetIndex < 0) return null
  const from = Math.min(anchorIndex, targetIndex)
  const to = Math.max(anchorIndex, targetIndex)
  return orderedIds.slice(from, to + 1)
}
