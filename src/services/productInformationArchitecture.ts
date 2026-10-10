import type { SearchExperienceMode } from './searchSetupWorkflow'

export type ProductSearchSurface = 'image' | 'video'
export type ProductPanelSurface = ProductSearchSurface | 'unified' | 'duplicate'
export type ProductPanelLayout = 'compact' | 'stacked' | 'split'

export type ProductWorkspaceVisibilityKey =
  | 'showClock'
  | 'showFolders'
  | 'showPrompts'
  | 'showSettings'
  | 'showCalc'
  | 'showFM'
  | 'showImageSearch'
  | 'showUnifiedSearch'
  | 'showAppStorage'
  | 'showRemoteTerminal'
  | 'showDuplicateFinder'
  | 'showMediaSearch'
  | 'showAssetLibrary'
  | 'showBatchRename'

export type ProductWorkspaceVisibility = Readonly<Record<ProductWorkspaceVisibilityKey, boolean>>

export const PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY: ProductWorkspaceVisibility = {
  showClock: false,
  showFolders: false,
  showPrompts: false,
  showSettings: true,
  showCalc: false,
  showFM: false,
  showImageSearch: true,
  showUnifiedSearch: false,
  showAppStorage: false,
  showRemoteTerminal: false,
  showDuplicateFinder: false,
  showMediaSearch: false,
  showAssetLibrary: false,
  showBatchRename: false,
}

/**
 * The default workspace has one search surface. Sources stay reachable from
 * the navigator, while the model-specific search and library panels open only
 * after an explicit user action.
 */
export const PRODUCT_PRIMARY_WORKSPACE_VISIBILITY: ProductWorkspaceVisibility = {
  ...PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY,
  showImageSearch: false,
  showUnifiedSearch: true,
}

export const PRODUCT_PRIMARY_WORKSPACE_SAVED_VISIBILITY = {
  clock: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showClock,
  folders: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showFolders,
  prompts: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showPrompts,
  settings: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showSettings,
  calc: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showCalc,
  fm: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showFM,
  imageSearch: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showImageSearch,
  unifiedSearch: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showUnifiedSearch,
  appStorage: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showAppStorage,
  remoteTerminal: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showRemoteTerminal,
  duplicateFinder: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showDuplicateFinder,
  mediaSearch: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showMediaSearch,
  assetLibrary: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showAssetLibrary,
  batchRename: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showBatchRename,
} as const

const PRODUCT_WORKSPACE_VISIBILITY_KEYS = Object.keys(
  PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY,
) as ProductWorkspaceVisibilityKey[]

export interface ProductWorkspaceVisibilityMigration {
  migrated: boolean
  visibility: ProductWorkspaceVisibility
}

export function resolveProductWorkspaceVisibilityMigration(
  current: Partial<ProductWorkspaceVisibility>,
  storedVersion: number,
  targetVersion: number,
): ProductWorkspaceVisibilityMigration {
  const normalized = Object.fromEntries(
    PRODUCT_WORKSPACE_VISIBILITY_KEYS.map((key) => [
      key,
      current[key] ?? PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY[key],
    ]),
  ) as unknown as ProductWorkspaceVisibility
  const usesLegacyDefaults = PRODUCT_WORKSPACE_VISIBILITY_KEYS.every(
    (key) => normalized[key] === PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY[key],
  )
  if (!Number.isFinite(storedVersion) || storedVersion < targetVersion) {
    if (usesLegacyDefaults) {
      return { migrated: true, visibility: PRODUCT_PRIMARY_WORKSPACE_VISIBILITY }
    }
  }
  return { migrated: false, visibility: normalized }
}

export type RovingNavigationKey =
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | 'End'

const IMAGE_CORE_ACTIONS = [
  'image-search-select-folders',
  'search-prepare-library',
  'image-search-query-image',
  'image-search-semantic-query',
] as const

const VIDEO_CORE_ACTIONS = [
  'media-search-select-videos',
  'search-prepare-library',
  'media-search-query-image',
  'media-search-text-query',
  'media-search-run-query',
] as const

/**
 * The advanced mode adds diagnostics and tuning, but it must never remove a
 * primary user journey that exists in simple mode. Keeping both lists here
 * makes that product rule executable instead of relying on visual inspection.
 */
export const PRODUCT_SEARCH_MODE_ACTIONS: Readonly<
  Record<ProductSearchSurface, Record<SearchExperienceMode, readonly string[]>>
> = {
  image: {
    simple: IMAGE_CORE_ACTIONS,
    advanced: IMAGE_CORE_ACTIONS,
  },
  video: {
    simple: VIDEO_CORE_ACTIONS,
    advanced: VIDEO_CORE_ACTIONS,
  },
}

export const PRODUCT_PANEL_SPLIT_BREAKPOINTS: Readonly<Record<ProductPanelSurface, number>> = {
  image: 1050,
  video: 980,
  unified: 980,
  duplicate: 980,
}

export const PRODUCT_PANEL_VIEWPORT_MATRIX = [320, 480, 560, 720, 979, 980, 1050, 1440] as const

export function productSearchCoreActionIds(
  surface: ProductSearchSurface,
  mode: SearchExperienceMode,
): readonly string[] {
  return PRODUCT_SEARCH_MODE_ACTIONS[surface][mode]
}

export function productSearchModesHaveParity(surface: ProductSearchSurface): boolean {
  const normalize = (values: readonly string[]) => [...new Set(values)].sort().join('\n')
  return (
    normalize(PRODUCT_SEARCH_MODE_ACTIONS[surface].simple) ===
    normalize(PRODUCT_SEARCH_MODE_ACTIONS[surface].advanced)
  )
}

export function resolveProductPanelLayout(
  surface: ProductPanelSurface,
  width: number,
): ProductPanelLayout {
  const boundedWidth = Number.isFinite(width) ? Math.max(0, width) : 0
  if (boundedWidth <= 560) return 'compact'
  return boundedWidth >= PRODUCT_PANEL_SPLIT_BREAKPOINTS[surface] ? 'split' : 'stacked'
}

export function nextRovingIndex(
  currentIndex: number,
  itemCount: number,
  key: string,
): number | null {
  if (!Number.isInteger(itemCount) || itemCount <= 0) return null
  const current = Math.max(0, Math.min(itemCount - 1, Math.floor(currentIndex)))
  if (key === 'Home') return 0
  if (key === 'End') return itemCount - 1
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % itemCount
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + itemCount) % itemCount
  return null
}
