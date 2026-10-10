import type { DirListSort, FileEntry } from '../shared/ipc/file-manager'

function compareEntryIdentity(a: FileEntry, b: FileEntry): number {
  const byName = a.name.localeCompare(b.name)
  if (byName !== 0) return byName
  return a.path.localeCompare(b.path)
}

function compareNumbers(a: number, b: number): number {
  const safeA = Number.isFinite(a) ? a : 0
  const safeB = Number.isFinite(b) ? b : 0
  return safeA < safeB ? -1 : safeA > safeB ? 1 : 0
}

/**
 * Provides a deterministic order for paged directory listings.
 *
 * Recursive folder sizes arrive asynchronously after the listing. They must
 * not participate in live sorting because each progress update would move a
 * row and invalidate the current page boundary. For size sorting, folders
 * therefore stay in a stable name-sorted cohort before regular files.
 */
export function compareFileManagerEntries(a: FileEntry, b: FileEntry, sort: DirListSort): number {
  const direction = sort.direction === 'desc' ? -1 : 1

  switch (sort.field) {
    case 'size': {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      if (a.isDirectory) return compareEntryIdentity(a, b)
      const bySize = compareNumbers(a.size, b.size)
      return bySize !== 0 ? bySize * direction : compareEntryIdentity(a, b)
    }
    case 'mtime': {
      const byModifiedTime = compareNumbers(a.mtime, b.mtime)
      return byModifiedTime !== 0 ? byModifiedTime * direction : compareEntryIdentity(a, b)
    }
    case 'type':
    case 'ext': {
      const byType = a.type.localeCompare(b.type)
      return byType !== 0 ? byType * direction : compareEntryIdentity(a, b)
    }
    case 'name':
    default:
      return compareEntryIdentity(a, b) * direction
  }
}
