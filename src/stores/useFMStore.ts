import { create } from 'zustand'
import type {
  PaneLayout,
  SortState,
  ClipboardItem,
  ProgressInfo,
  FavoriteEntry,
  ViewMode,
  GroupMode,
} from '../components/filemanager/types'
import { DEFAULT_QUICK_ACCESS } from '../components/filemanager/types'

// ── File Manager Store (independent from main app store) ──

export interface FMStore {
  fmLayout: PaneLayout
  fmPaneTabs: string[][]
  fmActiveTab: number[]
  fmPaneSorts: SortState[]
  fmShowHidden: boolean
  fmFavorites: FavoriteEntry[]
  fmClipboard: ClipboardItem | null
  fmProgress: ProgressInfo | null
  activePaneIndex: number
  fmViewModes: ViewMode[]
  fmGroupModes: GroupMode[]
  fmGroupExpanded: Record<string, boolean>
  fmFontScale: number

  // Setters
  setFMLayout: (layout: PaneLayout) => void
  setFMPanePath: (paneIdx: number, tabIdx: number, p: string) => void
  setFMPaneSort: (idx: number, sort: SortState) => void
  setFMShowHidden: (v: boolean) => void
  setFMFavorites: (favs: FavoriteEntry[]) => void
  setFMClipboard: (item: ClipboardItem | null) => void
  setFMProgress: (info: ProgressInfo | null) => void
  setActivePaneIndex: (idx: number) => void
  addFMTab: (paneIdx: number, path: string) => void
  removeFMTab: (paneIdx: number, tabIdx: number) => void
  setFMActiveTab: (paneIdx: number, tabIdx: number) => void
  setFMViewMode: (paneIdx: number, mode: ViewMode) => void
  setFMGroupMode: (paneIdx: number, mode: GroupMode) => void
  setFMGroupExpanded: (key: string, expanded: boolean) => void
  setFMFontScale: (v: number) => void
}

export const useFMStore = create<FMStore>((set) => ({
  fmLayout: 'single' as PaneLayout,
  fmPaneTabs: [['C:\\'], [], [], []],
  fmActiveTab: [0, 0, 0, 0],
  fmPaneSorts: [
    { field: 'name' as const, direction: 'asc' as const },
    { field: 'name' as const, direction: 'asc' as const },
    { field: 'name' as const, direction: 'asc' as const },
    { field: 'name' as const, direction: 'asc' as const },
  ],
  fmShowHidden: false,
  fmFavorites: DEFAULT_QUICK_ACCESS,
  fmClipboard: null,
  fmProgress: null,
  activePaneIndex: 0,

  fmViewModes: ['list' as ViewMode, 'list' as ViewMode, 'list' as ViewMode, 'list' as ViewMode],
  fmGroupModes: [
    'none' as GroupMode,
    'none' as GroupMode,
    'none' as GroupMode,
    'none' as GroupMode,
  ],
  fmGroupExpanded: {} as Record<string, boolean>,
  fmFontScale: 1.0,

  setFMLayout: (layout) => set({ fmLayout: layout }),
  setFMPanePath: (paneIdx, tabIdx, p) =>
    set((s) => {
      const tabs = s.fmPaneTabs.map((arr) => [...arr])
      while (tabs.length <= paneIdx) tabs.push([])
      while (tabs[paneIdx].length <= tabIdx) tabs[paneIdx].push('')
      tabs[paneIdx][tabIdx] = p
      return { fmPaneTabs: tabs }
    }),
  setFMPaneSort: (idx, sort) =>
    set((s) => {
      const sorts = [...s.fmPaneSorts]
      sorts[idx] = sort
      return { fmPaneSorts: sorts }
    }),
  setFMShowHidden: (v) => set({ fmShowHidden: v }),
  setFMFavorites: (favs) => set({ fmFavorites: favs }),
  setFMClipboard: (item) => set({ fmClipboard: item }),
  setFMProgress: (info) => set({ fmProgress: info }),
  setActivePaneIndex: (idx) => set({ activePaneIndex: idx }),
  addFMTab: (paneIdx, p) =>
    set((s) => {
      const tabs = s.fmPaneTabs.map((arr) => [...arr])
      while (tabs.length <= paneIdx) tabs.push([])
      tabs[paneIdx] = [...tabs[paneIdx], p]
      const activeTab = [...s.fmActiveTab]
      activeTab[paneIdx] = tabs[paneIdx].length - 1
      return { fmPaneTabs: tabs, fmActiveTab: activeTab }
    }),
  removeFMTab: (paneIdx, tabIdx) =>
    set((s) => {
      const tabs = s.fmPaneTabs.map((arr) => [...arr])
      if (paneIdx >= tabs.length) return s
      const pane = tabs[paneIdx]
      if (pane.length <= 1) return s
      tabs[paneIdx] = pane.filter((_, i) => i !== tabIdx)
      const activeTab = [...s.fmActiveTab]
      activeTab[paneIdx] = Math.min(activeTab[paneIdx], tabs[paneIdx].length - 1)
      return { fmPaneTabs: tabs, fmActiveTab: activeTab }
    }),
  setFMActiveTab: (paneIdx, tabIdx) =>
    set((s) => {
      const activeTab = [...s.fmActiveTab]
      activeTab[paneIdx] = tabIdx
      return { fmActiveTab: activeTab }
    }),
  setFMViewMode: (paneIdx, mode) =>
    set((s) => {
      const modes = [...s.fmViewModes]
      modes[paneIdx] = mode
      return { fmViewModes: modes }
    }),
  setFMGroupMode: (paneIdx, mode) =>
    set((s) => {
      const modes = [...s.fmGroupModes]
      modes[paneIdx] = mode
      return { fmGroupModes: modes }
    }),
  setFMGroupExpanded: (key, expanded) =>
    set((s) => ({
      fmGroupExpanded: { ...s.fmGroupExpanded, [key]: expanded },
    })),
  setFMFontScale: (v) => set({ fmFontScale: v }),
}))
