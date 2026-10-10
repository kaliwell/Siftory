// Window settings and persisted application configuration IPC contracts.

import type {
  DirListSort,
  FileManagerFavoriteEntry,
  FileManagerGroupMode,
  FileManagerPaneLayout,
  FileManagerViewMode,
} from './file-manager'

export type SearchExperiencePreference = 'simple' | 'advanced'
export type OpenThirdPartyLicensesResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'open-failed' | 'invalid-request' }

export type ThumbnailRebuildBackendPreference = 'auto' | 'cpu' | 'gpu' | 'native' | 'cuda'

/**
 * Stable identities shared by panel focus, persistence, linked movement, and UI smoke tests.
 * Keep product-facing titles out of this mapping: titles are localized and are not identifiers.
 */
export const PANEL_IDENTITIES = {
  clock: {
    domId: 'clock',
    visibilityKey: 'showClock',
    positionKey: 'clockPos',
    sizeKey: 'clockSize',
  },
  folders: {
    domId: 'folders',
    visibilityKey: 'showFolders',
    positionKey: 'foldersPos',
    sizeKey: 'foldersSize',
  },
  prompts: {
    domId: 'prompts',
    visibilityKey: 'showPrompts',
    positionKey: 'promptsPos',
    sizeKey: 'promptsSize',
  },
  settings: {
    domId: 'settings',
    visibilityKey: 'showSettings',
    positionKey: 'settingsPos',
    sizeKey: 'settingsSize',
  },
  calc: {
    domId: 'calculator',
    visibilityKey: 'showCalc',
    positionKey: 'calcPos',
    sizeKey: 'calcSize',
  },
  fm: {
    domId: 'file-manager',
    visibilityKey: 'showFM',
    positionKey: 'fmPos',
    sizeKey: 'fmSize',
  },
  imageSearch: {
    domId: 'image-search',
    visibilityKey: 'showImageSearch',
    positionKey: 'imageSearchPos',
    sizeKey: 'imageSearchSize',
  },
  unifiedSearch: {
    domId: 'unified-search',
    visibilityKey: 'showUnifiedSearch',
    positionKey: 'unifiedSearchPos',
    sizeKey: 'unifiedSearchSize',
  },
  appStorage: {
    domId: 'app-storage',
    visibilityKey: 'showAppStorage',
    positionKey: 'appStoragePos',
    sizeKey: 'appStorageSize',
  },
  remoteTerminal: {
    domId: 'remote-terminal',
    visibilityKey: 'showRemoteTerminal',
    positionKey: 'remoteTerminalPos',
    sizeKey: 'remoteTerminalSize',
  },
  duplicateFinder: {
    domId: 'duplicate-finder',
    visibilityKey: 'showDuplicateFinder',
    positionKey: 'dupFinderPos',
    sizeKey: 'dupFinderSize',
  },
  mediaSearch: {
    domId: 'media-search',
    visibilityKey: 'showMediaSearch',
    positionKey: 'mediaSearchPos',
    sizeKey: 'mediaSearchSize',
  },
  assetLibrary: {
    domId: 'neko-search',
    visibilityKey: 'showAssetLibrary',
    positionKey: 'assetLibraryPos',
    sizeKey: 'assetLibrarySize',
  },
  batchRename: {
    domId: 'batch-rename',
    visibilityKey: 'showBatchRename',
    positionKey: 'batchRenamePos',
    sizeKey: 'batchRenameSize',
  },
} as const

export type PanelId = keyof typeof PANEL_IDENTITIES
export type PanelVisibilityKey = (typeof PANEL_IDENTITIES)[PanelId]['visibilityKey']
export const PANEL_IDS = Object.freeze(Object.keys(PANEL_IDENTITIES) as PanelId[])
export const PANEL_DOM_IDS = Object.freeze(
  PANEL_IDS.map((panelId) => PANEL_IDENTITIES[panelId].domId),
)
export const PANEL_ID_BY_VISIBILITY = Object.freeze(
  Object.fromEntries(
    PANEL_IDS.map((panelId) => [PANEL_IDENTITIES[panelId].visibilityKey, panelId]),
  ),
) as Record<PanelVisibilityKey, PanelId>

export interface ImageSearchUiPreferences {
  embeddingGpuJobs: number
  embeddingBatchSize: number
  buildScanThumbnails: boolean
  experienceMode: SearchExperiencePreference
  thumbnailRebuildBackend: ThumbnailRebuildBackendPreference
  thumbnailGpuJobs: number
  thumbnailBatchSize: number
}

export interface MediaSearchUiPreferences {
  experienceMode: SearchExperiencePreference
}

export interface WorkspaceRect {
  x: number
  y: number
  width: number
  height: number
}

export type DisplayScope =
  | { mode: 'all' }
  | { mode: 'primary' }
  | { mode: 'display'; displayId: string }

export interface WorkspaceDisplay {
  id: string
  bounds: WorkspaceRect
  workArea: WorkspaceRect
  scaleFactor: number
  rotation: number
  internal: boolean
  primary: boolean
}

export interface WorkspaceWorkArea extends WorkspaceRect {
  displays: Array<WorkspaceDisplay & { localWorkArea: WorkspaceRect }>
}

export interface WorkspaceTopology {
  scope: DisplayScope
  primaryDisplayId: string
  bounds: WorkspaceRect
  workArea: WorkspaceWorkArea
  displays: WorkspaceDisplay[]
}

export type WindowVisibilityState = 'visible' | 'preparing-hide' | 'hidden' | 'preparing-show'

export type WindowVisibilityReason =
  | 'hotkey'
  | 'settings'
  | 'second-instance'
  | 'ai-control'
  | 'recovery'

export interface WindowVisibilityEvent {
  generation: number
  state: WindowVisibilityState
  reason: WindowVisibilityReason
}

export type GlobalHotkeyId =
  | 'toggle-primary'
  | 'toggle-legacy'
  | 'snap-panels'
  | 'show-all'
  | 'arrange-row'
  | 'arrange-grid'
  | 'arrange-column'
  | 'quit'

export interface GlobalHotkeyEntry {
  id: GlobalHotkeyId
  accelerator: string
  status: 'registered' | 'conflicted' | 'disabled'
}

export interface GlobalHotkeyStatus {
  active: boolean
  entries: GlobalHotkeyEntry[]
}

export type AiControlScope = 'read' | 'window' | 'search' | 'control'

export interface AiControlSettings {
  enabled: boolean
  running: boolean
  port: number
  address: string
  tokenAvailable: boolean
  tokenScopes: AiControlScope[]
  tokenCreatedAt?: string
  lastError?: string
  auditEntries: number
  pendingConfirmations: number
}

export interface AiControlSettingsResult {
  ok: boolean
  settings: AiControlSettings
  token?: string
  error?: string
}

export interface AiControlAuditEntry {
  timestamp: string
  capabilityId: string
  outcome: string
  durationMs: number
  requestId: string
  inputKeys: string[]
}

export interface AiControlConfirmation {
  id: string
  capabilityId: string
  createdAt: string
  expiresAt: string
  requestId: string
  inputKeys: string[]
  inputPreview: unknown
}

export interface AiControlConfirmationResult {
  ok: boolean
  confirmations: AiControlConfirmation[]
  error?: string
}

export type ProductFirstRunGuideStepId = 'source' | 'models' | 'catalog' | 'search'

export interface ProductFirstRunGuideSettings {
  schema: 1
  status: 'active' | 'dismissed' | 'completed'
  lastStep: ProductFirstRunGuideStepId | 'complete'
  completedSteps: ProductFirstRunGuideStepId[]
  firstSearchCompleted: boolean
  updatedAt: number
}

export interface AppSettingsData {
  panelSizeDefaultsVersion?: number
  panelVisibilityDefaultsVersion?: number
  language?: 'en' | 'zh-CN'
  theme?: number
  themeId?: string
  themeMode?: 'system' | 'light' | 'dark'
  showDate?: boolean
  transparency?: number
  fontScaleIdx?: number
  linkedMove?: boolean
  displayScope?: DisplayScope
  workspaceNavigatorPos?: { x: number; y: number } | null
  clockPos?: { x: number; y: number }
  foldersPos?: { x: number; y: number }
  promptsPos?: { x: number; y: number }
  settingsPos?: { x: number; y: number }
  calcPos?: { x: number; y: number }
  fmPos?: { x: number; y: number }
  imageSearchPos?: { x: number; y: number }
  unifiedSearchPos?: { x: number; y: number }
  appStoragePos?: { x: number; y: number }
  remoteTerminalPos?: { x: number; y: number }
  dupFinderPos?: { x: number; y: number }
  mediaSearchPos?: { x: number; y: number }
  assetLibraryPos?: { x: number; y: number }
  batchRenamePos?: { x: number; y: number }
  clockSize?: { w: number; h: number }
  foldersSize?: { w: number; h: number }
  promptsSize?: { w: number; h: number }
  settingsSize?: { w: number; h: number }
  calcSize?: { w: number; h: number }
  fmSize?: { w: number; h: number }
  imageSearchSize?: { w: number; h: number }
  unifiedSearchSize?: { w: number; h: number }
  appStorageSize?: { w: number; h: number }
  remoteTerminalSize?: { w: number; h: number }
  dupFinderSize?: { w: number; h: number }
  mediaSearchSize?: { w: number; h: number }
  assetLibrarySize?: { w: number; h: number }
  batchRenameSize?: { w: number; h: number }
  showClock?: boolean
  showFolders?: boolean
  showPrompts?: boolean
  showSettings?: boolean
  showCalc?: boolean
  showFM?: boolean
  showImageSearch?: boolean
  showUnifiedSearch?: boolean
  showAppStorage?: boolean
  showRemoteTerminal?: boolean
  showDuplicateFinder?: boolean
  showMediaSearch?: boolean
  showAssetLibrary?: boolean
  showBatchRename?: boolean
  manifestPath?: string
  recentManifests?: string[]
  imageSearchScanPaths?: string[]
  imageSearchUiPreferences?: ImageSearchUiPreferences
  mediaSearchUiPreferences?: MediaSearchUiPreferences
  firstRunGuide?: ProductFirstRunGuideSettings
  globalVisible?: boolean
  savedVisibility?: Record<string, boolean>
  // File Manager persisted state.
  fmLayout?: FileManagerPaneLayout
  fmPaneTabs?: string[][]
  fmActiveTab?: number[]
  fmPaneSorts?: DirListSort[]
  fmShowHidden?: boolean
  fmFavorites?: FileManagerFavoriteEntry[]
  fmViewModes?: FileManagerViewMode[]
  fmGroupModes?: FileManagerGroupMode[]
  fmGroupExpanded?: Record<string, boolean>
}

export interface AppConfigData {
  tabs?: { name: string; shortcuts: { name: string; path: string }[] }[]
  promptTabs?: { name: string; prompts: { name: string; text: string }[] }[]
  activeTab?: number
  activePromptTab?: number
}

// ── RemoteTerminal Types ─────────────────────────────────
