export type LazyPanelVisibilityKey =
  | 'showImageSearch'
  | 'showUnifiedSearch'
  | 'showAppStorage'
  | 'showDuplicateFinder'
  | 'showMediaSearch'
  | 'showAssetLibrary'

export interface LazyPanelDefinition {
  id:
    | 'imageSearch'
    | 'unifiedSearch'
    | 'appStorage'
    | 'duplicateFinder'
    | 'mediaSearch'
    | 'assetLibrary'
  boundaryName: string
  visibilityKey: LazyPanelVisibilityKey
  load: () => Promise<{ default: ComponentType }>
  preloadOrder: number
  /** Keep task-owning panels mounted after their first display. */
  preserveWhenHidden?: boolean
}

export const lazyPanelRegistry = [
  {
    id: 'unifiedSearch',
    boundaryName: 'UnifiedSearch',
    visibilityKey: 'showUnifiedSearch',
    load: () => import('../components/UnifiedSearchPanel'),
    preloadOrder: 5,
    preserveWhenHidden: true,
  },
  {
    id: 'mediaSearch',
    boundaryName: 'MediaSearch',
    visibilityKey: 'showMediaSearch',
    load: () => import('../components/MediaSearchPanel'),
    preloadOrder: 10,
    preserveWhenHidden: true,
  },
  {
    id: 'imageSearch',
    boundaryName: 'ImageSearch',
    visibilityKey: 'showImageSearch',
    load: () => import('../components/ImageSearchPanel'),
    preloadOrder: 20,
    preserveWhenHidden: true,
  },
  {
    id: 'assetLibrary',
    boundaryName: 'NekoSearch',
    visibilityKey: 'showAssetLibrary',
    load: () => import('../components/AssetLibraryPanel'),
    preloadOrder: 25,
    preserveWhenHidden: true,
  },
  {
    id: 'appStorage',
    boundaryName: 'AppStorage',
    visibilityKey: 'showAppStorage',
    load: () => import('../components/AppStoragePanel'),
    preloadOrder: 30,
    preserveWhenHidden: true,
  },
  {
    id: 'duplicateFinder',
    boundaryName: 'DuplicateFinder',
    visibilityKey: 'showDuplicateFinder',
    load: () => import('../components/DuplicateFinderPanel'),
    preloadOrder: 40,
    preserveWhenHidden: true,
  },
] as const satisfies readonly LazyPanelDefinition[]
import type { ComponentType } from 'react'
