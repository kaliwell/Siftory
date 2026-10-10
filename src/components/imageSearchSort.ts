export type ImageSearchSortMode = 'score' | 'projectFirst' | 'distance' | 'fileSize' | 'resolution'

interface SortableImageSearchResult {
  score: number
  distance?: number
  width?: number
  height?: number
  fileSize?: number
  sourceKind?: 'project'
}

export function sortImageSearchResults<T extends SortableImageSearchResult>(
  results: readonly T[],
  sortBy: ImageSearchSortMode,
): T[] {
  const sorted = [...results]
  switch (sortBy) {
    case 'projectFirst':
      sorted.sort((a, b) => Number(b.sourceKind === 'project') - Number(a.sourceKind === 'project'))
      break
    case 'distance':
      sorted.sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))
      break
    case 'fileSize':
      sorted.sort((a, b) => (a.fileSize ?? 0) - (b.fileSize ?? 0))
      break
    case 'resolution':
      sorted.sort((a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0))
      break
    default:
      sorted.sort((a, b) => b.score - a.score)
      break
  }
  return sorted
}
