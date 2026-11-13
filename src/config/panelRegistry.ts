export type LazyPanelVisibilityKey = 'showImageSearch' | 'showAppStorage' | 'showMediaSearch'

export interface LazyPanelDefinition {
  id: 'imageSearch' | 'appStorage' | 'mediaSearch'
  boundaryName: string
  visibilityKey: LazyPanelVisibilityKey
  load: () => Promise<{ default: ComponentType }>
  preloadOrder: number
  /** Keep task-owning panels mounted after their first display. */
  preserveWhenHidden?: boolean
}

export const lazyPanelRegistry = [
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
    id: 'appStorage',
    boundaryName: 'AppStorage',
    visibilityKey: 'showAppStorage',
    load: () => import('../components/AppStoragePanel'),
    preloadOrder: 30,
    preserveWhenHidden: true,
  },
] as const satisfies readonly LazyPanelDefinition[]
import type { ComponentType } from 'react'
