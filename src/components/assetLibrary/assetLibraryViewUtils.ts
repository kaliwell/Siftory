import type { CSSProperties } from 'react'
import type {
  AssetCategory,
  AssetFeedbackModelStatus,
  AssetLibraryStats,
} from '../../../shared/ipc-contract'

export type AssetLibraryViewMode = 'library' | 'review' | 'clusters'
export type AssetLibraryMode = 'assets' | 'categories'
export type AssetLibraryReviewMode = 'suggestions' | 'sampleSearch' | 'similar'

export const EMPTY_ASSET_LIBRARY_STATS: AssetLibraryStats = {
  totalAssets: 0,
  classifiedAssets: 0,
  unclassifiedAssets: 0,
  suggestedCount: 0,
  lowConfidenceCount: 0,
  categoryCount: 0,
  tagCount: 0,
  clusterCount: 0,
  referenceCount: 0,
  archivedAssets: 0,
  storageState: 'ready',
  storageCorruptRows: 0,
}

export const EMPTY_ASSET_FEEDBACK_STATUS: AssetFeedbackModelStatus = {
  enabled: false,
  state: 'missing',
  modelName: 'clip_vit_base_patch32',
  revision: 1,
  builtRevision: 0,
  targetCount: 0,
  positiveSampleCount: 0,
  negativeSampleCount: 0,
  positivePrototypeCount: 0,
  negativePrototypeCount: 0,
  embeddedSampleCount: 0,
  skippedSampleCount: 0,
  updatedAt: 0,
}

export const assetLibraryButtonStyle: CSSProperties = {
  fontSize: 13,
  padding: '4px 8px',
  whiteSpace: 'nowrap',
}

export const assetLibraryInputStyle: CSSProperties = {
  minWidth: 0,
  background: 'rgba(var(--bg),0.72)',
  border: '1px solid rgba(var(--date),0.28)',
  color: 'rgb(var(--date))',
  padding: '4px 6px',
  fontSize: 13,
}

// Stable across member-selection re-renders so memoized thumbnails can skip work.
export const clusterMemberThumbnailStyle: CSSProperties = {
  width: '100%',
  height: 76,
}

export function assetLibraryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function formatAssetLibraryNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : '0'
}

export function formatAssetLibraryDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '-'
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function formatAssetLibraryBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** index
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

export function assetFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

export function assetFileExtension(filePath: string): string {
  const suffix = filePath.split('.').pop()?.toLowerCase()
  return suffix ? `.${suffix}` : ''
}

export function buildAssetCategoryRows(
  categories: AssetCategory[],
): Array<{ category: AssetCategory; depth: number }> {
  const children = new Map<number | null, AssetCategory[]>()
  for (const category of categories) {
    const list = children.get(category.parentId) || []
    list.push(category)
    children.set(category.parentId, list)
  }
  for (const list of children.values())
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))

  const rows: Array<{ category: AssetCategory; depth: number }> = []
  const visited = new Set<number>()
  const walk = (parentId: number | null, depth: number) => {
    for (const category of children.get(parentId) || []) {
      if (visited.has(category.id)) continue
      visited.add(category.id)
      rows.push({ category, depth })
      walk(category.id, depth + 1)
    }
  }
  walk(null, 0)
  for (const category of categories)
    if (!visited.has(category.id)) rows.push({ category, depth: 0 })
  return rows
}
