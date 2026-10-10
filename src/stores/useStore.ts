import { create } from 'zustand'
import type { Tab, PromptTab } from '../types'
import { createDefaultTabs, createDefaultPromptTabs } from '../config/default'
import {
  PANEL_SIZE_DEFAULTS_VERSION,
  PANEL_VISIBILITY_DEFAULTS_VERSION,
  DEFAULT_CLOCK_W,
  DEFAULT_CLOCK_H,
  DEFAULT_FOLDERS_W,
  DEFAULT_FOLDERS_H,
  DEFAULT_PROMPTS_W,
  DEFAULT_PROMPTS_H,
  DEFAULT_SETTINGS_W,
  DEFAULT_SETTINGS_H,
  DEFAULT_CALC_W,
  DEFAULT_CALC_H,
  DEFAULT_FM_W,
  DEFAULT_FM_H,
  DEFAULT_IMAGESEARCH_W,
  DEFAULT_IMAGESEARCH_H,
  DEFAULT_UNIFIED_SEARCH_W,
  DEFAULT_UNIFIED_SEARCH_H,
  DEFAULT_APPSTORAGE_W,
  DEFAULT_APPSTORAGE_H,
  DEFAULT_REMOTE_TERMINAL_W,
  DEFAULT_REMOTE_TERMINAL_H,
  DEFAULT_DUPLICATE_FINDER_W,
  DEFAULT_DUPLICATE_FINDER_H,
  DEFAULT_MEDIA_SEARCH_W,
  DEFAULT_MEDIA_SEARCH_H,
  DEFAULT_ASSET_LIBRARY_W,
  DEFAULT_ASSET_LIBRARY_H,
  DEFAULT_BATCH_RENAME_W,
  DEFAULT_BATCH_RENAME_H,
} from '../types'
import { GAP } from './arrangeEngine'
import { detectSystemLanguage, type AppLanguage } from '../i18n/core'
import type { DisplayScope, WorkspaceWorkArea } from '../../shared/ipc-contract'
import {
  getThemePreset,
  legacyThemeIndex,
  normalizeThemeId,
  type ThemeId,
  type ThemeMode,
} from '../services/themeCatalog'
import {
  DEFAULT_IMAGE_SEARCH_UI_PREFERENCES,
  DEFAULT_MEDIA_SEARCH_UI_PREFERENCES,
  type ImageSearchUiPreferences,
  type MediaSearchUiPreferences,
} from '../../shared/searchUiPreferences'
import type { PanelId } from '../../shared/ipc/app-core'
import { PRODUCT_PRIMARY_WORKSPACE_VISIBILITY } from '../services/productInformationArchitecture'

export type { PanelId } from '../../shared/ipc/app-core'

// ── Store shape (mirrors AppState from app.h) ──────────────

export interface AppStore {
  panelSizeDefaultsVersion: number
  panelVisibilityDefaultsVersion: number
  // Theme
  language: AppLanguage
  themeIdx: number
  themeId: ThemeId
  themeMode: ThemeMode
  showDate: boolean
  transparency: number // 0 = solid; 1..60 = frosted surface strength

  // Folder tabs
  tabs: Tab[]
  activeTab: number

  // Prompt tabs
  promptTabs: PromptTab[]
  activePromptTab: number

  // Font scale
  fontScaleIdx: number

  // Edit windows
  editPrompts: { tabIdx: number; promptIdx: number }[]

  // Panel visibility
  showClock: boolean
  showFolders: boolean
  showPrompts: boolean
  showSettings: boolean
  showCalc: boolean
  showFM: boolean
  showImageSearch: boolean
  showUnifiedSearch: boolean
  showAppStorage: boolean
  showRemoteTerminal: boolean
  showDuplicateFinder: boolean
  showMediaSearch: boolean
  showAssetLibrary: boolean
  showBatchRename: boolean

  // Global visibility toggle state (for Ctrl+Shift+Alt+Q)
  globalVisible: boolean
  savedVisibility: Record<string, boolean> // panels visible before global hide

  // Panel lock (excluded from arrange / linked move / dragging)
  lockedPanels: Record<string, boolean>

  // Visibility lock (prevent hiding via toggle)
  lockedVisibility: Record<string, boolean>

  // Window positions (lifted to store for Auto Arrange)
  clockPos: { x: number; y: number }
  foldersPos: { x: number; y: number }
  promptsPos: { x: number; y: number }
  settingsPos: { x: number; y: number }
  calcPos: { x: number; y: number }

  // Window sizes (tracked for Auto Arrange)
  clockSize: { w: number; h: number }
  foldersSize: { w: number; h: number }
  promptsSize: { w: number; h: number }
  settingsSize: { w: number; h: number }
  calcSize: { w: number; h: number }
  fmPos: { x: number; y: number }
  fmSize: { w: number; h: number }
  imageSearchPos: { x: number; y: number }
  imageSearchSize: { w: number; h: number }
  unifiedSearchPos: { x: number; y: number }
  unifiedSearchSize: { w: number; h: number }
  appStoragePos: { x: number; y: number }
  appStorageSize: { w: number; h: number }
  remoteTerminalPos: { x: number; y: number }
  remoteTerminalSize: { w: number; h: number }
  dupFinderPos: { x: number; y: number }
  dupFinderSize: { w: number; h: number }
  mediaSearchPos: { x: number; y: number }
  mediaSearchSize: { w: number; h: number }
  assetLibraryPos: { x: number; y: number }
  assetLibrarySize: { w: number; h: number }
  batchRenamePos: { x: number; y: number }
  batchRenameSize: { w: number; h: number }

  // Dirty flag
  configDirty: boolean

  // Linked move (drag one panel moves all)
  linkedMove: boolean

  // Snap to grid
  snapToGrid: boolean
  gridSize: number

  // Screen work area (for boundary clamping)
  workArea: WorkspaceWorkArea
  displayScope: DisplayScope
  workspaceNavigatorPos: { x: number; y: number } | null

  // Helpers
  setLanguage: (language: AppLanguage) => void
  setThemeIdx: (n: number) => void
  setThemeId: (themeId: ThemeId) => void
  setThemeMode: (mode: ThemeMode) => void
  setShowDate: (v: boolean) => void
  setTransparency: (v: number) => void
  setActiveTab: (n: number) => void
  setActivePromptTab: (n: number) => void
  setFontScaleIdx: (n: number) => void
  setLinkedMove: (v: boolean) => void
  setSnapToGrid: (v: boolean) => void
  setDisplayScope: (scope: DisplayScope) => void
  setWorkspaceNavigatorPos: (position: { x: number; y: number } | null) => void

  // Tab mutations
  addTab: (name: string) => void
  renameTab: (idx: number, name: string) => void
  deleteTab: (idx: number) => void

  // Shortcut mutations
  addShortcut: (name: string, path: string) => void
  renameShortcut: (idx: number, name: string) => void
  changeShortcutPath: (idx: number, path: string) => void
  deleteShortcut: (idx: number) => void

  // Prompt tab mutations
  addPromptTab: (name: string) => void
  renamePromptTab: (idx: number, name: string) => void
  deletePromptTab: (idx: number) => void

  // Prompt mutations
  addPrompt: (name: string, text: string) => void
  renamePrompt: (idx: number, name: string) => void
  deletePrompt: (idx: number) => void
  openEditWindow: (tabIdx: number, promptIdx: number) => void
  closeEditWindow: (tabIdx: number, promptIdx: number) => void
  saveEditWindow: (tabIdx: number, promptIdx: number, text: string) => void

  // Positions
  setClockPos: (x: number, y: number) => void
  setFoldersPos: (x: number, y: number) => void
  setPromptsPos: (x: number, y: number) => void
  setSettingsPos: (x: number, y: number) => void
  setCalcPos: (x: number, y: number) => void

  // Sizes
  setClockSize: (w: number, h: number) => void
  setFoldersSize: (w: number, h: number) => void
  setPromptsSize: (w: number, h: number) => void
  setSettingsSize: (w: number, h: number) => void
  setCalcSize: (w: number, h: number) => void
  setFMPos: (x: number, y: number) => void
  setFMSize: (w: number, h: number) => void

  setShowFM: (v: boolean) => void
  setImageSearchPos: (x: number, y: number) => void
  setImageSearchSize: (w: number, h: number) => void
  toggleShowImageSearch: () => void
  setShowImageSearch: (v: boolean) => void
  setUnifiedSearchPos: (x: number, y: number) => void
  setUnifiedSearchSize: (w: number, h: number) => void
  toggleShowUnifiedSearch: () => void
  setShowUnifiedSearch: (v: boolean) => void
  setAppStoragePos: (x: number, y: number) => void
  setAppStorageSize: (w: number, h: number) => void
  toggleShowAppStorage: () => void
  setShowAppStorage: (v: boolean) => void
  setRemoteTerminalPos: (x: number, y: number) => void
  setRemoteTerminalSize: (w: number, h: number) => void
  toggleShowRemoteTerminal: () => void
  setShowRemoteTerminal: (v: boolean) => void
  setShowDuplicateFinder: (v: boolean) => void
  setDupFinderPos: (x: number, y: number) => void
  setDupFinderSize: (w: number, h: number) => void
  toggleShowDuplicateFinder: () => void
  setShowMediaSearch: (v: boolean) => void
  setMediaSearchPos: (x: number, y: number) => void
  setMediaSearchSize: (w: number, h: number) => void
  toggleShowMediaSearch: () => void
  setShowAssetLibrary: (v: boolean) => void
  setAssetLibraryPos: (x: number, y: number) => void
  setAssetLibrarySize: (w: number, h: number) => void
  toggleShowAssetLibrary: () => void
  setShowBatchRename: (v: boolean) => void
  setBatchRenamePos: (x: number, y: number) => void
  setBatchRenameSize: (w: number, h: number) => void
  toggleShowBatchRename: () => void
  // ImageSearch persistence
  manifestPath: string
  recentManifests: string[]
  setManifestPath: (p: string) => void
  addRecentManifest: (p: string) => void
  // ImageSearch scan paths
  imageSearchScanPaths: string[]
  setImageSearchScanPaths: (paths: string[]) => void
  addImageSearchScanPaths: (paths: string[]) => void
  removeImageSearchScanPath: (path: string) => void
  clearImageSearchScanPaths: () => void
  imageSearchUiPreferences: ImageSearchUiPreferences
  mediaSearchUiPreferences: MediaSearchUiPreferences
  setImageSearchUiPreferences: (preferences: Partial<ImageSearchUiPreferences>) => void
  setMediaSearchUiPreferences: (preferences: Partial<MediaSearchUiPreferences>) => void

  // Visibility toggles
  toggleShowClock: () => void
  toggleShowFolders: () => void
  toggleShowPrompts: () => void
  toggleShowSettings: () => void
  toggleShowCalc: () => void
  toggleShowFM: () => void
  togglePanelLocked: (name: string) => void
  toggleVisibilityLock: (name: string) => void
  closePanel: (name: PanelId) => void
  setGlobalVisible: (v: boolean) => void
  toggleGlobalVisibility: () => boolean

  // Auto Arrange
  autoArrange: () => void
  arrangeVertical: () => void
  arrangeHorizontal: () => void
}

// ── Arrange helpers (generic — works with any panel count) ─

type PanelRef = { name: string; x: number; y: number; w: number; h: number }
type PanelPoint = { x: number; y: number }
type PanelSize = { w: number; h: number }

function panelPositionPatch(name: string, point: PanelPoint): Partial<AppStore> {
  switch (name) {
    case 'clock':
      return { clockPos: point }
    case 'folders':
      return { foldersPos: point }
    case 'prompts':
      return { promptsPos: point }
    case 'settings':
      return { settingsPos: point }
    case 'calc':
      return { calcPos: point }
    case 'fm':
      return { fmPos: point }
    case 'imageSearch':
      return { imageSearchPos: point }
    case 'unifiedSearch':
      return { unifiedSearchPos: point }
    case 'appStorage':
      return { appStoragePos: point }
    case 'remoteTerminal':
      return { remoteTerminalPos: point }
    case 'duplicateFinder':
      return { dupFinderPos: point }
    case 'mediaSearch':
      return { mediaSearchPos: point }
    case 'assetLibrary':
      return { assetLibraryPos: point }
    case 'batchRename':
      return { batchRenamePos: point }
    default:
      return {}
  }
}

function panelSizeForName(s: AppStore, name: string): PanelSize {
  switch (name) {
    case 'clock':
      return s.clockSize
    case 'folders':
      return s.foldersSize
    case 'prompts':
      return s.promptsSize
    case 'settings':
      return s.settingsSize
    case 'calc':
      return s.calcSize
    case 'fm':
      return s.fmSize
    case 'imageSearch':
      return s.imageSearchSize
    case 'unifiedSearch':
      return s.unifiedSearchSize
    case 'appStorage':
      return s.appStorageSize
    case 'remoteTerminal':
      return s.remoteTerminalSize
    case 'duplicateFinder':
      return s.dupFinderSize
    case 'mediaSearch':
      return s.mediaSearchSize
    case 'assetLibrary':
      return s.assetLibrarySize
    case 'batchRename':
      return s.batchRenameSize
    default:
      return { w: 240, h: 200 }
  }
}

function hiddenVisibilityPatch(showKey: keyof AppStore): Partial<AppStore> {
  switch (showKey) {
    case 'showClock':
      return { showClock: false }
    case 'showFolders':
      return { showFolders: false }
    case 'showPrompts':
      return { showPrompts: false }
    case 'showSettings':
      return { showSettings: false }
    case 'showCalc':
      return { showCalc: false }
    case 'showFM':
      return { showFM: false }
    case 'showImageSearch':
      return { showImageSearch: false }
    case 'showUnifiedSearch':
      return { showUnifiedSearch: false }
    case 'showAppStorage':
      return { showAppStorage: false }
    case 'showRemoteTerminal':
      return { showRemoteTerminal: false }
    case 'showDuplicateFinder':
      return { showDuplicateFinder: false }
    case 'showMediaSearch':
      return { showMediaSearch: false }
    case 'showAssetLibrary':
      return { showAssetLibrary: false }
    case 'showBatchRename':
      return { showBatchRename: false }
    default:
      return {}
  }
}

function closedPanelPatch(name: PanelId): Partial<AppStore> {
  switch (name) {
    case 'clock':
      return { showClock: false }
    case 'folders':
      return { showFolders: false }
    case 'prompts':
      return { showPrompts: false }
    case 'settings':
      return { showSettings: false }
    case 'calc':
      return { showCalc: false }
    case 'fm':
      return { showFM: false }
    case 'imageSearch':
      return { showImageSearch: false }
    case 'unifiedSearch':
      return { showUnifiedSearch: false }
    case 'appStorage':
      return { showAppStorage: false }
    case 'remoteTerminal':
      return { showRemoteTerminal: false }
    case 'duplicateFinder':
      return { showDuplicateFinder: false }
    case 'mediaSearch':
      return { showMediaSearch: false }
    case 'assetLibrary':
      return { showAssetLibrary: false }
    case 'batchRename':
      return { showBatchRename: false }
  }
}

export function normalizeImageSearchScanPaths(paths: unknown, maxCount = 64): string[] {
  if (!Array.isArray(paths)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of paths) {
    if (typeof value !== 'string') continue
    const path = value.trim()
    if (!path) continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(path)
    if (result.length >= maxCount) break
  }
  return result
}

function collectPanels(s: AppStore): PanelRef[] {
  const all: {
    name: string
    pos: { x: number; y: number }
    size: { w: number; h: number }
    show: boolean
  }[] = [
    { name: 'clock', pos: s.clockPos, size: s.clockSize, show: s.showClock },
    { name: 'folders', pos: s.foldersPos, size: s.foldersSize, show: s.showFolders },
    { name: 'prompts', pos: s.promptsPos, size: s.promptsSize, show: s.showPrompts },
    { name: 'settings', pos: s.settingsPos, size: s.settingsSize, show: s.showSettings },
    { name: 'calc', pos: s.calcPos, size: s.calcSize, show: s.showCalc },
    { name: 'fm', pos: s.fmPos, size: s.fmSize, show: s.showFM },
    {
      name: 'imageSearch',
      pos: s.imageSearchPos,
      size: s.imageSearchSize,
      show: s.showImageSearch,
    },
    {
      name: 'unifiedSearch',
      pos: s.unifiedSearchPos,
      size: s.unifiedSearchSize,
      show: s.showUnifiedSearch,
    },
    {
      name: 'appStorage',
      pos: s.appStoragePos,
      size: s.appStorageSize,
      show: s.showAppStorage,
    },
    {
      name: 'remoteTerminal',
      pos: s.remoteTerminalPos,
      size: s.remoteTerminalSize,
      show: s.showRemoteTerminal,
    },
    {
      name: 'duplicateFinder',
      pos: s.dupFinderPos,
      size: s.dupFinderSize,
      show: s.showDuplicateFinder,
    },
    {
      name: 'mediaSearch',
      pos: s.mediaSearchPos,
      size: s.mediaSearchSize,
      show: s.showMediaSearch,
    },
    {
      name: 'assetLibrary',
      pos: s.assetLibraryPos,
      size: s.assetLibrarySize,
      show: s.showAssetLibrary,
    },
    {
      name: 'batchRename',
      pos: s.batchRenamePos,
      size: s.batchRenameSize,
      show: s.showBatchRename,
    },
  ]
  return all
    .filter((p) => p.show && !s.lockedPanels[p.name])
    .map((p) => ({ name: p.name, x: p.pos.x, y: p.pos.y, w: p.size.w, h: p.size.h }))
}

/** Collect visible locked panels as fixed obstacles for arrange. */
function collectLockedPanels(s: AppStore): PanelRef[] {
  const all: {
    name: string
    pos: { x: number; y: number }
    size: { w: number; h: number }
    show: boolean
  }[] = [
    { name: 'clock', pos: s.clockPos, size: s.clockSize, show: s.showClock },
    { name: 'folders', pos: s.foldersPos, size: s.foldersSize, show: s.showFolders },
    { name: 'prompts', pos: s.promptsPos, size: s.promptsSize, show: s.showPrompts },
    { name: 'settings', pos: s.settingsPos, size: s.settingsSize, show: s.showSettings },
    { name: 'calc', pos: s.calcPos, size: s.calcSize, show: s.showCalc },
    { name: 'fm', pos: s.fmPos, size: s.fmSize, show: s.showFM },
    {
      name: 'imageSearch',
      pos: s.imageSearchPos,
      size: s.imageSearchSize,
      show: s.showImageSearch,
    },
    {
      name: 'unifiedSearch',
      pos: s.unifiedSearchPos,
      size: s.unifiedSearchSize,
      show: s.showUnifiedSearch,
    },
    {
      name: 'appStorage',
      pos: s.appStoragePos,
      size: s.appStorageSize,
      show: s.showAppStorage,
    },
    {
      name: 'remoteTerminal',
      pos: s.remoteTerminalPos,
      size: s.remoteTerminalSize,
      show: s.showRemoteTerminal,
    },
    {
      name: 'duplicateFinder',
      pos: s.dupFinderPos,
      size: s.dupFinderSize,
      show: s.showDuplicateFinder,
    },
    {
      name: 'mediaSearch',
      pos: s.mediaSearchPos,
      size: s.mediaSearchSize,
      show: s.showMediaSearch,
    },
    {
      name: 'assetLibrary',
      pos: s.assetLibraryPos,
      size: s.assetLibrarySize,
      show: s.showAssetLibrary,
    },
    {
      name: 'batchRename',
      pos: s.batchRenamePos,
      size: s.batchRenameSize,
      show: s.showBatchRename,
    },
  ]
  return all
    .filter((p) => p.show && !!s.lockedPanels[p.name])
    .map((p) => ({ name: p.name, x: p.pos.x, y: p.pos.y, w: p.size.w, h: p.size.h }))
}

function placeNewPanel(s: AppStore, name: string, setFn: (partial: Partial<AppStore>) => void) {
  const panels = collectPanels(s)
  let rightmost = 50
  for (const p of panels) {
    if (p.name === name) continue
    rightmost = Math.max(rightmost, p.x + p.w)
  }
  const newX = rightmost + GAP
  const newY = panels.length <= 1 ? 50 : s.clockPos.y

  const sz = panelSizeForName(s, name)
  const clamped = clampPanelToViewport(
    {
      name,
      x: newX,
      y: newY,
      w: sz?.w ?? 240,
      h: sz?.h ?? 200,
    },
    s,
  )
  setFn(panelPositionPatch(name, { x: clamped.x, y: clamped.y }))
}

function getViewportSize(s: AppStore): { width: number; height: number } {
  const width =
    s.workArea.width > 0
      ? s.workArea.width
      : typeof window !== 'undefined'
        ? window.innerWidth
        : 1920
  const height =
    s.workArea.height > 0
      ? s.workArea.height
      : typeof window !== 'undefined'
        ? window.innerHeight
        : 1080
  return { width, height }
}

function clampPanelToViewport(panel: PanelRef, s: AppStore): PanelRef {
  const { width, height } = getViewportSize(s)
  return {
    ...panel,
    x: Math.max(0, Math.min(panel.x, Math.max(0, width - panel.w))),
    y: Math.max(0, Math.min(panel.y, Math.max(0, height - panel.h))),
  }
}

function panelsOverlap(a: PanelRef, b: PanelRef): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function clampAnchor(x: number, y: number, s: AppStore): { x: number; y: number } {
  const { width, height } = getViewportSize(s)
  return {
    x: Math.max(0, Math.min(x, Math.max(0, width - 1))),
    y: Math.max(0, Math.min(y, Math.max(0, height - 1))),
  }
}

function packPanels(
  panels: PanelRef[],
  s: AppStore,
  direction: 'row' | 'column' = 'row',
  startX?: number,
  startY?: number,
): PanelRef[] {
  if (panels.length === 0) return []
  const { width, height } = getViewportSize(s)
  const anchor = clampAnchor(
    startX ?? Math.min(...panels.map((p) => p.x)),
    startY ?? Math.min(...panels.map((p) => p.y)),
    s,
  )
  const obstacles = collectLockedPanels(s).map((p) => clampPanelToViewport(p, s))
  const placed: PanelRef[] = []

  const collides = (candidate: PanelRef) =>
    [...obstacles, ...placed].some((other) => panelsOverlap(candidate, other))

  const maxAttempts = Math.max(40, panels.length * 24)
  let cursorX = anchor.x
  let cursorY = anchor.y
  let laneSize = 0

  const nextCandidate = (p: PanelRef): PanelRef => {
    if (direction === 'row') {
      if (cursorX > anchor.x && cursorX + p.w > width) {
        cursorX = anchor.x
        cursorY += laneSize + GAP
        laneSize = 0
      }
      return { ...p, x: cursorX, y: cursorY }
    }
    if (cursorY > anchor.y && cursorY + p.h > height) {
      cursorY = anchor.y
      cursorX += laneSize + GAP
      laneSize = 0
    }
    return { ...p, x: cursorX, y: cursorY }
  }

  for (const p of panels) {
    let candidate = clampPanelToViewport(nextCandidate(p), s)
    let attempts = 0
    while (collides(candidate) && attempts < maxAttempts) {
      attempts++
      if (direction === 'row') {
        cursorX += Math.max(1, p.w + GAP)
        if (cursorX + p.w > width) {
          cursorX = anchor.x
          cursorY += Math.max(laneSize, p.h) + GAP
          laneSize = 0
        }
      } else {
        cursorY += Math.max(1, p.h + GAP)
        if (cursorY + p.h > height) {
          cursorY = anchor.y
          cursorX += Math.max(laneSize, p.w) + GAP
          laneSize = 0
        }
      }
      candidate = clampPanelToViewport(nextCandidate(p), s)
    }

    if (collides(candidate)) {
      const maxX = Math.max(0, width - p.w)
      const maxY = Math.max(0, height - p.h)
      const step = Math.max(GAP, Math.min(40, Math.floor(Math.min(p.w, p.h) / 2)))
      const yStarts = [anchor.y, 0]
      const xStarts = [anchor.x, 0]
      let found: PanelRef | null = null
      for (const yStart of yStarts) {
        for (let y = Math.min(yStart, maxY); y <= maxY && !found; y += step) {
          for (const xStart of xStarts) {
            for (let x = Math.min(xStart, maxX); x <= maxX; x += step) {
              const probe = { ...p, x, y }
              if (!collides(probe)) {
                found = probe
                break
              }
            }
            if (found) break
          }
        }
      }
      if (found) candidate = found
    }

    placed.push(candidate)
    if (direction === 'row') {
      cursorX = candidate.x + p.w + GAP
      laneSize = Math.max(laneSize, p.h)
    } else {
      cursorY = candidate.y + p.h + GAP
      laneSize = Math.max(laneSize, p.w)
    }
  }

  return placed
}

function applyPositions(
  set: (partial: Partial<AppStore>) => void,
  s: AppStore,
  result: Record<string, { x: number; y: number }>,
  direction: 'row' | 'column' = 'row',
) {
  // Build refs for clamping
  const refs: PanelRef[] = []
  for (const name of Object.keys(result)) {
    const pos = result[name]
    const sz = panelSizeForName(s, name)
    refs.push({ name, x: pos.x, y: pos.y, w: sz?.w ?? 240, h: sz?.h ?? 200 })
  }
  const bounded = packPanels(refs, s, direction)
  const final: Record<string, { x: number; y: number }> = {}
  for (const p of bounded) final[p.name] = { x: p.x, y: p.y }

  set({
    clockPos: final['clock'] ?? s.clockPos,
    foldersPos: final['folders'] ?? s.foldersPos,
    promptsPos: final['prompts'] ?? s.promptsPos,
    settingsPos: final['settings'] ?? s.settingsPos,
    calcPos: final['calc'] ?? s.calcPos,
    fmPos: final['fm'] ?? s.fmPos,
    imageSearchPos: final['imageSearch'] ?? s.imageSearchPos,
    unifiedSearchPos: final['unifiedSearch'] ?? s.unifiedSearchPos,
    appStoragePos: final['appStorage'] ?? s.appStoragePos,
    remoteTerminalPos: final['remoteTerminal'] ?? s.remoteTerminalPos,
    dupFinderPos: final['duplicateFinder'] ?? s.dupFinderPos,
    mediaSearchPos: final['mediaSearch'] ?? s.mediaSearchPos,
    assetLibraryPos: final['assetLibrary'] ?? s.assetLibraryPos,
    batchRenamePos: final['batchRename'] ?? s.batchRenamePos,
  })
}

// ── Store ──────────────────────────────────────────────────

export const useStore = create<AppStore>((set, get) => ({
  language: detectSystemLanguage(),
  themeIdx: 0,
  themeId: 'matrix-dark',
  themeMode: 'dark',
  showDate: true,
  transparency: 0,

  tabs: createDefaultTabs(),
  activeTab: 0,

  promptTabs: createDefaultPromptTabs(),
  activePromptTab: 0,

  fontScaleIdx: 0,

  editPrompts: [],

  globalVisible: true,
  savedVisibility: {},

  ...PRODUCT_PRIMARY_WORKSPACE_VISIBILITY,

  lockedPanels: {},
  lockedVisibility: {},

  clockPos: { x: 50, y: 50 },
  foldersPos: { x: 340, y: 50 },
  promptsPos: { x: 50, y: 180 },
  settingsPos: { x: 42, y: 42 },
  calcPos: { x: 340, y: 480 },

  panelSizeDefaultsVersion: PANEL_SIZE_DEFAULTS_VERSION,
  panelVisibilityDefaultsVersion: PANEL_VISIBILITY_DEFAULTS_VERSION,
  clockSize: { w: DEFAULT_CLOCK_W, h: DEFAULT_CLOCK_H },
  foldersSize: { w: DEFAULT_FOLDERS_W, h: DEFAULT_FOLDERS_H },
  promptsSize: { w: DEFAULT_PROMPTS_W, h: DEFAULT_PROMPTS_H },
  settingsSize: { w: DEFAULT_SETTINGS_W, h: DEFAULT_SETTINGS_H },
  calcSize: { w: DEFAULT_CALC_W, h: DEFAULT_CALC_H },
  fmPos: { x: 200, y: 200 },
  fmSize: { w: DEFAULT_FM_W, h: DEFAULT_FM_H },
  imageSearchPos: { x: 319, y: 42 },
  imageSearchSize: { w: DEFAULT_IMAGESEARCH_W, h: DEFAULT_IMAGESEARCH_H },
  unifiedSearchPos: { x: 319, y: 42 },
  unifiedSearchSize: { w: DEFAULT_UNIFIED_SEARCH_W, h: DEFAULT_UNIFIED_SEARCH_H },
  appStoragePos: { x: 150, y: 150 },
  appStorageSize: { w: DEFAULT_APPSTORAGE_W, h: DEFAULT_APPSTORAGE_H },
  remoteTerminalPos: { x: 180, y: 180 },
  remoteTerminalSize: { w: DEFAULT_REMOTE_TERMINAL_W, h: DEFAULT_REMOTE_TERMINAL_H },
  dupFinderPos: { x: 120, y: 120 },
  dupFinderSize: { w: DEFAULT_DUPLICATE_FINDER_W, h: DEFAULT_DUPLICATE_FINDER_H },
  mediaSearchPos: { x: 160, y: 140 },
  mediaSearchSize: { w: DEFAULT_MEDIA_SEARCH_W, h: DEFAULT_MEDIA_SEARCH_H },
  assetLibraryPos: { x: 190, y: 160 },
  assetLibrarySize: { w: DEFAULT_ASSET_LIBRARY_W, h: DEFAULT_ASSET_LIBRARY_H },
  batchRenamePos: { x: 210, y: 180 },
  batchRenameSize: { w: DEFAULT_BATCH_RENAME_W, h: DEFAULT_BATCH_RENAME_H },
  manifestPath: '',
  recentManifests: [],
  imageSearchScanPaths: [] as string[],
  imageSearchUiPreferences: { ...DEFAULT_IMAGE_SEARCH_UI_PREFERENCES },
  mediaSearchUiPreferences: { ...DEFAULT_MEDIA_SEARCH_UI_PREFERENCES },

  configDirty: false,
  linkedMove: false,
  snapToGrid: false,
  gridSize: 20,
  workArea: { x: 0, y: 0, width: 1920, height: 1080, displays: [] },
  displayScope: { mode: 'all' },
  workspaceNavigatorPos: null,

  // ── Simple setters ────────────────────────────
  setLanguage: (language) => set({ language, configDirty: true }),
  setThemeIdx: (n) => {
    const themeId = normalizeThemeId(undefined, n)
    set({
      themeIdx: legacyThemeIndex(themeId),
      themeId,
      themeMode: getThemePreset(themeId).defaultMode,
      configDirty: true,
    })
  },
  setThemeId: (themeId) =>
    set({
      themeIdx: legacyThemeIndex(themeId),
      themeId,
      themeMode: getThemePreset(themeId).defaultMode,
      configDirty: true,
    }),
  setThemeMode: (themeMode) => set({ themeMode, configDirty: true }),
  setWorkspaceNavigatorPos: (workspaceNavigatorPos) => set({ workspaceNavigatorPos }),
  setShowDate: (v) => set({ showDate: v, configDirty: true }),
  setTransparency: (v) => set({ transparency: Math.max(0, Math.min(60, v)) }),
  setActiveTab: (n) => set({ activeTab: n }),
  setActivePromptTab: (n) => set({ activePromptTab: n }),
  setFontScaleIdx: (n) => set({ fontScaleIdx: n, configDirty: true }),
  setLinkedMove: (v) => set({ linkedMove: v }),
  setSnapToGrid: (v) => set({ snapToGrid: v }),
  setDisplayScope: (scope) => set({ displayScope: scope }),

  // ── Tab mutations ─────────────────────────────
  addTab: (name) =>
    set((s) => {
      const tabs = [...s.tabs, { name, shortcuts: [] }]
      return { tabs, activeTab: tabs.length - 1, configDirty: true }
    }),

  renameTab: (idx, name) =>
    set((s) => {
      const tabs = s.tabs.map((t, i) => (i === idx ? { ...t, name } : t))
      return { tabs, configDirty: true }
    }),

  deleteTab: (idx) =>
    set((s) => {
      if (s.tabs.length <= 1) return s
      const tabs = s.tabs.filter((_, i) => i !== idx)
      const activeTab = Math.min(s.activeTab, tabs.length - 1)
      return { tabs, activeTab, configDirty: true }
    }),

  // ── Shortcut mutations ────────────────────────
  addShortcut: (name, path) =>
    set((s) => {
      const tabs = s.tabs.map((t, i) =>
        i === s.activeTab ? { ...t, shortcuts: [...t.shortcuts, { name, path }] } : t,
      )
      return { tabs, configDirty: true }
    }),

  renameShortcut: (idx, name) =>
    set((s) => {
      const tabs = s.tabs.map((t, i) => {
        if (i !== s.activeTab) return t
        const scs = t.shortcuts.map((sc, j) => (j === idx ? { ...sc, name } : sc))
        return { ...t, shortcuts: scs }
      })
      return { tabs, configDirty: true }
    }),

  changeShortcutPath: (idx, path) =>
    set((s) => {
      const tabs = s.tabs.map((t, i) => {
        if (i !== s.activeTab) return t
        const scs = t.shortcuts.map((sc, j) => (j === idx ? { ...sc, path } : sc))
        return { ...t, shortcuts: scs }
      })
      return { tabs, configDirty: true }
    }),

  deleteShortcut: (idx) =>
    set((s) => {
      const tabs = s.tabs.map((t, i) => {
        if (i !== s.activeTab) return t
        return { ...t, shortcuts: t.shortcuts.filter((_, j) => j !== idx) }
      })
      return { tabs, configDirty: true }
    }),

  // ── Prompt tab mutations ──────────────────────
  addPromptTab: (name) =>
    set((s) => {
      const promptTabs = [...s.promptTabs, { name, prompts: [] }]
      return { promptTabs, activePromptTab: promptTabs.length - 1, configDirty: true }
    }),

  renamePromptTab: (idx, name) =>
    set((s) => {
      const promptTabs = s.promptTabs.map((t, i) => (i === idx ? { ...t, name } : t))
      return { promptTabs, configDirty: true }
    }),

  deletePromptTab: (idx) =>
    set((s) => {
      if (s.promptTabs.length <= 1) return s
      const promptTabs = s.promptTabs.filter((_, i) => i !== idx)
      const activePromptTab = Math.min(s.activePromptTab, promptTabs.length - 1)
      // Close edit windows for the deleted tab
      const editPrompts = s.editPrompts.filter((e) => e.tabIdx !== idx)
      return { promptTabs, activePromptTab, editPrompts, configDirty: true }
    }),

  // ── Prompt mutations ──────────────────────────
  addPrompt: (name, text) =>
    set((s) => {
      const promptTabs = s.promptTabs.map((t, i) =>
        i === s.activePromptTab ? { ...t, prompts: [...t.prompts, { name, text }] } : t,
      )
      return { promptTabs, configDirty: true }
    }),

  renamePrompt: (idx, name) =>
    set((s) => {
      const promptTabs = s.promptTabs.map((t, i) => {
        if (i !== s.activePromptTab) return t
        const prompts = t.prompts.map((p, j) => (j === idx ? { ...p, name } : p))
        return { ...t, prompts }
      })
      return { promptTabs, configDirty: true }
    }),

  deletePrompt: (idx) =>
    set((s) => {
      const tabIdx = s.activePromptTab
      const promptTabs = s.promptTabs.map((t, i) => {
        if (i !== tabIdx) return t
        return { ...t, prompts: t.prompts.filter((_, j) => j !== idx) }
      })
      // Also close edit window if this prompt was being edited
      const editPrompts = s.editPrompts.filter((e) => e.tabIdx !== tabIdx || e.promptIdx !== idx)
      return { promptTabs, editPrompts, configDirty: true }
    }),

  openEditWindow: (tabIdx, promptIdx) =>
    set((s) => {
      const exists = s.editPrompts.some((e) => e.tabIdx === tabIdx && e.promptIdx === promptIdx)
      if (exists) return s
      return { editPrompts: [...s.editPrompts, { tabIdx, promptIdx }] }
    }),

  closeEditWindow: (tabIdx, promptIdx) =>
    set((s) => ({
      editPrompts: s.editPrompts.filter((e) => !(e.tabIdx === tabIdx && e.promptIdx === promptIdx)),
    })),

  saveEditWindow: (tabIdx, promptIdx, text) =>
    set((s) => {
      const promptTabs = s.promptTabs.map((t, i) => {
        if (i !== tabIdx) return t
        const prompts = t.prompts.map((p, j) => (j === promptIdx ? { ...p, text } : p))
        return { ...t, prompts }
      })
      const editPrompts = s.editPrompts.filter(
        (e) => !(e.tabIdx === tabIdx && e.promptIdx === promptIdx),
      )
      return { promptTabs, editPrompts, configDirty: true }
    }),

  setClockPos: (x, y) => set({ clockPos: { x, y } }),
  setFoldersPos: (x, y) => set({ foldersPos: { x, y } }),
  setPromptsPos: (x, y) => set({ promptsPos: { x, y } }),
  setSettingsPos: (x, y) => set({ settingsPos: { x, y } }),
  setCalcPos: (x, y) => set({ calcPos: { x, y } }),

  setClockSize: (w, h) => set({ clockSize: { w, h } }),
  setFoldersSize: (w, h) => set({ foldersSize: { w, h } }),
  setPromptsSize: (w, h) => set({ promptsSize: { w, h } }),
  setSettingsSize: (w, h) => set({ settingsSize: { w, h } }),
  setCalcSize: (w, h) => set({ calcSize: { w, h } }),
  setFMPos: (x, y) => set({ fmPos: { x, y } }),
  setFMSize: (w, h) => set({ fmSize: { w, h } }),
  setImageSearchPos: (x, y) => set({ imageSearchPos: { x, y } }),
  setImageSearchSize: (w, h) => set({ imageSearchSize: { w, h } }),
  setUnifiedSearchPos: (x, y) => set({ unifiedSearchPos: { x, y } }),
  setUnifiedSearchSize: (w, h) => set({ unifiedSearchSize: { w, h } }),
  setAppStoragePos: (x, y) => set({ appStoragePos: { x, y } }),
  setAppStorageSize: (w, h) => set({ appStorageSize: { w, h } }),
  setRemoteTerminalPos: (x, y) => set({ remoteTerminalPos: { x, y } }),
  setRemoteTerminalSize: (w, h) => set({ remoteTerminalSize: { w, h } }),

  setShowFM: (v) => set({ showFM: v }),
  setShowImageSearch: (v) => set({ showImageSearch: v }),
  setShowUnifiedSearch: (v) => set({ showUnifiedSearch: v }),
  setShowAppStorage: (v) => set({ showAppStorage: v }),
  setShowRemoteTerminal: (v) => set({ showRemoteTerminal: v }),
  setShowDuplicateFinder: (v) => set({ showDuplicateFinder: v }),
  setDupFinderPos: (x, y) => set({ dupFinderPos: { x, y } }),
  setDupFinderSize: (w, h) => set({ dupFinderSize: { w, h } }),
  setShowMediaSearch: (v) => set({ showMediaSearch: v }),
  setMediaSearchPos: (x, y) => set({ mediaSearchPos: { x, y } }),
  setMediaSearchSize: (w, h) => set({ mediaSearchSize: { w, h } }),
  setShowAssetLibrary: (v) => set({ showAssetLibrary: v }),
  setAssetLibraryPos: (x, y) => set({ assetLibraryPos: { x, y } }),
  setAssetLibrarySize: (w, h) => set({ assetLibrarySize: { w, h } }),
  setShowBatchRename: (v) => set({ showBatchRename: v }),
  setBatchRenamePos: (x, y) => set({ batchRenamePos: { x, y } }),
  setBatchRenameSize: (w, h) => set({ batchRenameSize: { w, h } }),
  setManifestPath: (p) => set({ manifestPath: p }),
  addRecentManifest: (p) =>
    set((s) => {
      const list = [p, ...s.recentManifests.filter((x) => x !== p)].slice(0, 5)
      return { recentManifests: list, manifestPath: p }
    }),
  // ImageSearch scan paths
  setImageSearchScanPaths: (paths) =>
    set({ imageSearchScanPaths: normalizeImageSearchScanPaths(paths) }),
  addImageSearchScanPaths: (paths) =>
    set((s) => {
      return {
        imageSearchScanPaths: normalizeImageSearchScanPaths([...s.imageSearchScanPaths, ...paths]),
      }
    }),
  removeImageSearchScanPath: (path) =>
    set((s) => ({
      imageSearchScanPaths: s.imageSearchScanPaths.filter((p) => p !== path),
    })),
  clearImageSearchScanPaths: () => set({ imageSearchScanPaths: [] }),
  setImageSearchUiPreferences: (preferences) =>
    set((state) => ({
      imageSearchUiPreferences: { ...state.imageSearchUiPreferences, ...preferences },
    })),
  setMediaSearchUiPreferences: (preferences) =>
    set((state) => ({
      mediaSearchUiPreferences: { ...state.mediaSearchUiPreferences, ...preferences },
    })),
  togglePanelLocked: (name) =>
    set((s) => ({
      lockedPanels: { ...s.lockedPanels, [name]: !s.lockedPanels[name] },
    })),
  toggleVisibilityLock: (name) =>
    set((s) => ({
      lockedVisibility: { ...s.lockedVisibility, [name]: !s.lockedVisibility[name] },
    })),
  closePanel: (name) => set(closedPanelPatch(name)),
  setGlobalVisible: (v) => set({ globalVisible: v }),
  toggleGlobalVisibility: () => {
    const s = get()
    const panelKeys = [
      ['clock', 'showClock'],
      ['folders', 'showFolders'],
      ['prompts', 'showPrompts'],
      ['settings', 'showSettings'],
      ['calc', 'showCalc'],
      ['fm', 'showFM'],
      ['imageSearch', 'showImageSearch'],
      ['unifiedSearch', 'showUnifiedSearch'],
      ['appStorage', 'showAppStorage'],
      ['remoteTerminal', 'showRemoteTerminal'],
      ['duplicateFinder', 'showDuplicateFinder'],
      ['mediaSearch', 'showMediaSearch'],
      ['assetLibrary', 'showAssetLibrary'],
      ['batchRename', 'showBatchRename'],
    ] as const

    if (s.globalVisible) {
      const savedVisibility = {
        clock: s.showClock,
        folders: s.showFolders,
        prompts: s.showPrompts,
        settings: s.showSettings,
        calc: s.showCalc,
        fm: s.showFM,
        imageSearch: s.showImageSearch,
        unifiedSearch: s.showUnifiedSearch,
        appStorage: s.showAppStorage,
        remoteTerminal: s.showRemoteTerminal,
        duplicateFinder: s.showDuplicateFinder,
        mediaSearch: s.showMediaSearch,
        assetLibrary: s.showAssetLibrary,
        batchRename: s.showBatchRename,
      }
      const next: Partial<AppStore> = {
        globalVisible: false,
        savedVisibility,
      }
      let hasVisibleLockedPanel = false
      for (const [panelName, showKey] of panelKeys) {
        const visible = Boolean(s[showKey])
        const locked = Boolean(s.lockedVisibility[panelName])
        if (visible && locked) {
          hasVisibleLockedPanel = true
        } else if (visible) {
          Object.assign(next, hiddenVisibilityPatch(showKey))
        }
      }
      set(next)
      return hasVisibleLockedPanel
    }

    set({
      globalVisible: true,
      showClock: s.savedVisibility.clock ?? s.showClock,
      showFolders: s.savedVisibility.folders ?? s.showFolders,
      showPrompts: s.savedVisibility.prompts ?? s.showPrompts,
      showSettings: s.savedVisibility.settings ?? s.showSettings,
      showCalc: s.savedVisibility.calc ?? s.showCalc,
      showFM: s.savedVisibility.fm ?? s.showFM,
      showImageSearch: s.savedVisibility.imageSearch ?? s.showImageSearch,
      showUnifiedSearch: s.savedVisibility.unifiedSearch ?? s.showUnifiedSearch,
      showAppStorage: s.savedVisibility.appStorage ?? s.showAppStorage,
      showRemoteTerminal: s.savedVisibility.remoteTerminal ?? s.showRemoteTerminal,
      showDuplicateFinder: s.savedVisibility.duplicateFinder ?? s.showDuplicateFinder,
      showMediaSearch: s.savedVisibility.mediaSearch ?? s.showMediaSearch,
      showAssetLibrary: s.savedVisibility.assetLibrary ?? s.showAssetLibrary,
      showBatchRename: s.savedVisibility.batchRename ?? s.showBatchRename,
    })
    return true
  },

  toggleShowClock: () => {
    if (get().showClock && !get().lockedVisibility['clock']) set({ showClock: false })
    else if (!get().showClock) {
      set({ showClock: true })
      placeNewPanel(get(), 'clock', set)
    }
  },
  toggleShowFolders: () => {
    if (get().showFolders && !get().lockedVisibility['folders']) set({ showFolders: false })
    else if (!get().showFolders) {
      set({ showFolders: true })
      placeNewPanel(get(), 'folders', set)
    }
  },
  toggleShowPrompts: () => {
    if (get().showPrompts && !get().lockedVisibility['prompts']) set({ showPrompts: false })
    else if (!get().showPrompts) {
      set({ showPrompts: true })
      placeNewPanel(get(), 'prompts', set)
    }
  },
  toggleShowSettings: () => {
    if (!get().showSettings) {
      set({ showSettings: true })
      placeNewPanel(get(), 'settings', set)
    }
  },
  toggleShowCalc: () => {
    if (get().showCalc && !get().lockedVisibility['calc']) set({ showCalc: false })
    else if (!get().showCalc) {
      set({ showCalc: true })
      placeNewPanel(get(), 'calc', set)
    }
  },
  toggleShowFM: () => {
    if (get().showFM && !get().lockedVisibility['fm']) set({ showFM: false })
    else if (!get().showFM) {
      set({ showFM: true })
      placeNewPanel(get(), 'fm', set)
    }
  },
  toggleShowImageSearch: () => {
    if (get().showImageSearch && !get().lockedVisibility['imageSearch'])
      set({ showImageSearch: false })
    else if (!get().showImageSearch) {
      set({ showImageSearch: true })
      placeNewPanel(get(), 'imageSearch', set)
    }
  },
  toggleShowUnifiedSearch: () => {
    if (get().showUnifiedSearch && !get().lockedVisibility['unifiedSearch'])
      set({ showUnifiedSearch: false })
    else if (!get().showUnifiedSearch) {
      set({ showUnifiedSearch: true })
      placeNewPanel(get(), 'unifiedSearch', set)
    }
  },
  toggleShowAppStorage: () => {
    if (get().showAppStorage && !get().lockedVisibility['appStorage'])
      set({ showAppStorage: false })
    else if (!get().showAppStorage) {
      set({ showAppStorage: true })
      placeNewPanel(get(), 'appStorage', set)
    }
  },
  toggleShowRemoteTerminal: () => {
    if (get().showRemoteTerminal && !get().lockedVisibility['remoteTerminal'])
      set({ showRemoteTerminal: false })
    else if (!get().showRemoteTerminal) {
      set({ showRemoteTerminal: true })
      placeNewPanel(get(), 'remoteTerminal', set)
    }
  },
  toggleShowDuplicateFinder: () => {
    if (get().showDuplicateFinder && !get().lockedVisibility['duplicateFinder'])
      set({ showDuplicateFinder: false })
    else if (!get().showDuplicateFinder) {
      set({ showDuplicateFinder: true })
      placeNewPanel(get(), 'duplicateFinder', set)
    }
  },
  toggleShowMediaSearch: () => {
    if (get().showMediaSearch && !get().lockedVisibility['mediaSearch'])
      set({ showMediaSearch: false })
    else if (!get().showMediaSearch) {
      set({ showMediaSearch: true })
      placeNewPanel(get(), 'mediaSearch', set)
    }
  },
  toggleShowAssetLibrary: () => {
    if (get().showAssetLibrary && !get().lockedVisibility['assetLibrary'])
      set({ showAssetLibrary: false })
    else if (!get().showAssetLibrary) {
      set({ showAssetLibrary: true })
      placeNewPanel(get(), 'assetLibrary', set)
    }
  },
  toggleShowBatchRename: () => {
    if (get().showBatchRename && !get().lockedVisibility['batchRename'])
      set({ showBatchRename: false })
    else if (!get().showBatchRename) {
      set({ showBatchRename: true })
      placeNewPanel(get(), 'batchRename', set)
    }
  },

  autoArrange: () => {
    const s = get()
    const allPanels = collectPanels(s)
    if (allPanels.length === 0) return

    // Separate large panels (FM, width > 400) from small panels
    const large = allPanels.filter((p) => p.w > 400)
    const small = allPanels.filter((p) => p.w <= 400)

    const anchorX = Math.min(...allPanels.map((p) => p.x))
    const anchorY = Math.min(...allPanels.map((p) => p.y))

    const result: Record<string, { x: number; y: number }> = {}

    // Arrange small panels in two columns
    if (small.length > 0) {
      const byX = [...small].sort((a, b) => a.x - b.x)
      const mid = Math.ceil(byX.length / 2)
      const leftCol = byX.slice(0, mid).sort((a, b) => a.y - b.y)
      const rightCol = byX.slice(mid).sort((a, b) => a.y - b.y)

      const leftW = leftCol.length > 0 ? Math.max(...leftCol.map((p) => p.w)) : 0
      let ly = anchorY
      for (const p of leftCol) {
        result[p.name] = { x: anchorX, y: ly }
        ly += p.h + GAP
      }

      const leftH = ly - GAP - anchorY
      const rightH = rightCol.reduce((h, p) => h + p.h + GAP, -GAP)
      const rightY0 = anchorY + Math.max(0, (leftH - rightH) / 2)

      const rightX = anchorX + leftW + GAP
      let ry = rightY0
      for (const p of rightCol) {
        result[p.name] = { x: rightX, y: ry }
        ry += p.h + GAP
      }

      // Place large panels below
      const smallMaxY = Math.max(ly - GAP, rightCol.length > 0 ? ry - GAP : 0)
      let largeY = smallMaxY + GAP
      for (const p of large) {
        result[p.name] = { x: anchorX, y: largeY }
        largeY += p.h + GAP
      }
    } else {
      // Only large panels — stack vertically
      let y = anchorY
      for (const p of large) {
        result[p.name] = { x: anchorX, y }
        y += p.h + GAP
      }
    }

    applyPositions(set, s, result, 'row')
  },

  arrangeVertical: () => {
    const s = get()
    const { height: maxH } = getViewportSize(s)
    const panels = collectPanels(s).sort((a, b) => a.y - b.y)
    if (panels.length === 0) return
    const anchorX = Math.min(...panels.map((p) => p.x))
    const anchorY = Math.min(...panels.map((p) => p.y))

    const result: Record<string, { x: number; y: number }> = {}
    let colX = anchorX
    let colW = 0
    let cy = anchorY
    for (const p of panels) {
      // Wrap to next column if this panel would overflow bottom
      if (cy > anchorY && cy + p.h > maxH) {
        colX += colW + GAP
        colW = 0
        cy = anchorY
      }
      result[p.name] = { x: colX, y: cy }
      cy += p.h + GAP
      colW = Math.max(colW, p.w)
    }
    applyPositions(set, s, result, 'column')
  },

  arrangeHorizontal: () => {
    const s = get()
    const { width: maxW } = getViewportSize(s)
    const panels = collectPanels(s).sort((a, b) => a.x - b.x)
    if (panels.length === 0) return
    const anchorX = Math.min(...panels.map((p) => p.x))
    const anchorY = Math.min(...panels.map((p) => p.y))

    const result: Record<string, { x: number; y: number }> = {}
    let rowY = anchorY
    let rowH = 0
    let cx = anchorX
    for (const p of panels) {
      // Wrap to next row if this panel would overflow right
      if (cx > anchorX && cx + p.w > maxW) {
        rowY += rowH + GAP
        rowH = 0
        cx = anchorX
      }
      result[p.name] = { x: cx, y: rowY }
      cx += p.w + GAP
      rowH = Math.max(rowH, p.h)
    }
    applyPositions(set, s, result, 'row')
  },
}))
