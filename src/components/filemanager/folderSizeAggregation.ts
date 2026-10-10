export type FolderSizeDisplayState =
  | { status: 'queued' }
  | { status: 'loading'; entriesScanned: number; bytes: number }
  | {
      status: 'ready'
      bytes: number
      complete: boolean
      partialReason?: 'entry-limit' | 'inaccessible' | 'entry-limit-and-inaccessible'
    }
  | { status: 'error'; error: string }

export interface FolderSizeAggregateEntry {
  path: string
  isDirectory: boolean
  size: number
}

export interface FolderSizeSortableEntry extends FolderSizeAggregateEntry {
  name: string
}

export interface CurrentFolderSizeSummary {
  bytes: number
  complete: boolean
  folderCount: number
  processedFolderCount: number
  completeFolderCount: number
}

function safeBytes(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function compareFolderSizeSortIdentity(
  first: FolderSizeSortableEntry,
  second: FolderSizeSortableEntry,
): number {
  const byName = first.name.localeCompare(second.name)
  return byName !== 0 ? byName : first.path.localeCompare(second.path)
}

/** Captures only the bytes visible at the instant the user requests a size sort. */
export function createFolderSizeSortSnapshot(
  folderStates: ReadonlyMap<string, FolderSizeDisplayState>,
): Map<string, number> {
  const snapshot = new Map<string, number>()
  for (const [folderPath, state] of folderStates) {
    if (state.status === 'loading' || state.status === 'ready') {
      snapshot.set(folderPath, safeBytes(state.bytes))
    }
  }
  return snapshot
}

/**
 * Sorts against a frozen folder-size snapshot. Later scan progress cannot move
 * rows underneath pointer/keyboard selection; another size-header click takes
 * a fresh snapshot explicitly.
 */
export function sortEntriesBySizeSnapshot<T extends FolderSizeSortableEntry>(
  entries: readonly T[],
  direction: 'asc' | 'desc',
  folderSizes: ReadonlyMap<string, number>,
): T[] {
  const directionFactor = direction === 'desc' ? -1 : 1
  return [...entries].sort((first, second) => {
    if (first.isDirectory !== second.isDirectory) return first.isDirectory ? -1 : 1

    if (first.isDirectory) {
      const firstSize = folderSizes.get(first.path)
      const secondSize = folderSizes.get(second.path)
      const firstKnown = firstSize !== undefined
      const secondKnown = secondSize !== undefined
      if (firstKnown !== secondKnown) return firstKnown ? -1 : 1
      if (firstKnown && secondKnown && firstSize !== secondSize) {
        return (firstSize! < secondSize! ? -1 : 1) * directionFactor
      }
      return compareFolderSizeSortIdentity(first, second)
    }

    const firstSize = safeBytes(first.size)
    const secondSize = safeBytes(second.size)
    if (firstSize !== secondSize) return (firstSize < secondSize ? -1 : 1) * directionFactor
    return compareFolderSizeSortIdentity(first, second)
  })
}

/**
 * Adds direct file sizes and the best currently known recursive size for each
 * child folder. A loading or partial folder contributes its lower bound while
 * keeping the combined result explicitly incomplete.
 */
export function summarizeCurrentFolderSize(
  entries: readonly FolderSizeAggregateEntry[],
  folderStates: ReadonlyMap<string, FolderSizeDisplayState>,
  hasMoreEntries: boolean,
): CurrentFolderSizeSummary {
  let bytes = 0
  let folderCount = 0
  let processedFolderCount = 0
  let completeFolderCount = 0
  let complete = !hasMoreEntries

  for (const entry of entries) {
    if (!entry.isDirectory) {
      bytes += safeBytes(entry.size)
      continue
    }

    folderCount += 1
    const state = folderStates.get(entry.path)
    if (state?.status === 'loading') {
      bytes += safeBytes(state.bytes)
      complete = false
    } else if (state?.status === 'ready') {
      bytes += safeBytes(state.bytes)
      processedFolderCount += 1
      if (state.complete) completeFolderCount += 1
      else complete = false
    } else if (state?.status === 'error') {
      processedFolderCount += 1
      complete = false
    } else {
      complete = false
    }
  }

  return { bytes, complete, folderCount, processedFolderCount, completeFolderCount }
}
