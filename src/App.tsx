import './styles/focused-workspace.css'
import { focusedWorkspaceVisibility } from './services/focusedWorkspace'
import React, { Suspense, useEffect, useRef, useState } from 'react'
import { normalizeImageSearchScanPaths, useStore } from './stores/useStore'
import { useFMStore } from './stores/useFMStore'
import WorkspaceNavigator from './components/WorkspaceNavigator'
import { ErrorBoundary } from './components/ErrorBoundary'
import { createDefaultTabs, createDefaultPromptTabs } from './config/default'
import { lazyPanelRegistry } from './config/panelRegistry'
import { useAutoSaveSettings } from './hooks/useAutoSaveSettings'
import { scheduleSettingsWrite } from './hooks/settingsWriter'
import { resolvePanelVisibility } from './services/settingsVisibility'
import {
  PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY,
  PRODUCT_PRIMARY_WORKSPACE_SAVED_VISIBILITY,
  PRODUCT_PRIMARY_WORKSPACE_VISIBILITY,
  resolveProductWorkspaceVisibilityMigration,
} from './services/productInformationArchitecture'
import { normalizeLanguage } from './i18n/core'
import {
  DEFAULT_LARGE_PANEL_H,
  DEFAULT_LARGE_PANEL_W,
  PANEL_SIZE_DEFAULTS_VERSION,
  PANEL_VISIBILITY_DEFAULTS_VERSION,
} from './types'
import type { WindowVisibilityEvent, WorkspaceWorkArea } from '../shared/ipc-contract'
import {
  FOCUSED_DISPLAY_SCOPE_VERSION,
  restoreFocusedDisplayScope,
} from '../shared/workspaceDisplayPolicy'
import { clampPanelToWorkspace } from './services/workspaceGeometry'
import {
  getThemePreset,
  legacyThemeIndex,
  normalizeThemeId,
  normalizeThemeMode,
  resolveThemeMode,
  themeCssVariables,
} from './services/themeCatalog'
import {
  normalizeImageSearchUiPreferences,
  normalizeMediaSearchUiPreferences,
} from '../shared/searchUiPreferences'

type WorkArea = WorkspaceWorkArea
type PanelPoint = { x: number; y: number }
type PanelSize = { w: number; h: number }
type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
  cancelIdleCallback?: (id: number) => void
}

const legacyOverlay = new URLSearchParams(location.search).get('legacyOverlay') === '1'
const LegacyOverlayDiagnostics = React.lazy(() => import('./components/LegacyOverlayDiagnostics'))
const SettingsPanel = React.lazy(() => import('./components/SettingsPanel'))

const lazyPanels = lazyPanelRegistry
  .map((panel) => ({
    ...panel,
    preserveWhenHidden: 'preserveWhenHidden' in panel && panel.preserveWhenHidden === true,
    Component: React.lazy(panel.load),
  }))
  .sort((a, b) => a.preloadOrder - b.preloadOrder)

function scheduleIdleTask(task: () => void, timeoutMs = 1200): () => void {
  const win = window as IdleWindow
  if (typeof win.requestIdleCallback === 'function') {
    const id = win.requestIdleCallback(task, { timeout: timeoutMs })
    return () => win.cancelIdleCallback?.(id)
  }
  const timer = window.setTimeout(task, timeoutMs)
  return () => window.clearTimeout(timer)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function safePoint(value: unknown): PanelPoint | undefined {
  if (!value || typeof value !== 'object') return undefined
  const point = value as Partial<PanelPoint>
  return isFiniteNumber(point.x) && isFiniteNumber(point.y) ? { x: point.x, y: point.y } : undefined
}

function safeSize(value: unknown): PanelSize | undefined {
  if (!value || typeof value !== 'object') return undefined
  const size = value as Partial<PanelSize>
  return isFiniteNumber(size.w) && isFiniteNumber(size.h) && size.w > 0 && size.h > 0
    ? { w: size.w, h: size.h }
    : undefined
}

const App: React.FC = () => {
  const themeIdx = useStore((s) => s.themeIdx)
  const themeId = useStore((s) => s.themeId)
  const themeMode = useStore((s) => s.themeMode)
  const configDirty = useStore((s) => s.configDirty)
  const showSettings = useStore((s) => s.showSettings)
  const showImageSearch = useStore((s) => s.showImageSearch)
  const showUnifiedSearch = useStore((s) => s.showUnifiedSearch)
  const showAppStorage = useStore((s) => s.showAppStorage)
  const showDuplicateFinder = useStore((s) => s.showDuplicateFinder)
  const showMediaSearch = useStore((s) => s.showMediaSearch)
  const showAssetLibrary = useStore((s) => s.showAssetLibrary)
  const globalVisible = useStore((s) => s.globalVisible)
  const savedVisibility = useStore((s) => s.savedVisibility)
  const [ready, setReady] = useState(false)
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true,
  )
  const loaded = useRef(false)
  const mountedLazyPanelIds = useRef(new Set<(typeof lazyPanels)[number]['id']>())
  const visibilityGenerationRef = useRef(0)

  useEffect(() => {
    if (!ready) return
    const reconcile = (
      state: ReturnType<typeof useStore.getState>,
      previous?: ReturnType<typeof useStore.getState>,
    ) => {
      const visibility = focusedWorkspaceVisibility(state, previous)
      if (
        Object.entries(visibility).some(
          ([key, value]) => state[key as keyof typeof visibility] !== value,
        )
      ) {
        useStore.setState(visibility)
      }
    }
    reconcile(useStore.getState())
    return useStore.subscribe(reconcile)
  }, [ready])

  // ── Snap helper (shared) ─────────────────────────────────
  const snapAllToScreen = (wa: WorkArea, previous?: WorkArea) => {
    const s = useStore.getState()
    const offsetX = previous ? previous.x - wa.x : 0
    const offsetY = previous ? previous.y - wa.y : 0
    const clamp = (x: number, y: number, w: number, h: number) =>
      clampPanelToWorkspace(wa, x + offsetX, y + offsetY, w, h)
    useStore.setState({
      clockPos: clamp(s.clockPos.x, s.clockPos.y, s.clockSize.w, s.clockSize.h),
      foldersPos: clamp(s.foldersPos.x, s.foldersPos.y, s.foldersSize.w, s.foldersSize.h),
      promptsPos: clamp(s.promptsPos.x, s.promptsPos.y, s.promptsSize.w, s.promptsSize.h),
      settingsPos: clamp(s.settingsPos.x, s.settingsPos.y, s.settingsSize.w, s.settingsSize.h),
      calcPos: clamp(s.calcPos.x, s.calcPos.y, s.calcSize.w, s.calcSize.h),
      fmPos: clamp(s.fmPos.x, s.fmPos.y, s.fmSize.w, s.fmSize.h),
      imageSearchPos: clamp(
        s.imageSearchPos.x,
        s.imageSearchPos.y,
        s.imageSearchSize.w,
        s.imageSearchSize.h,
      ),
      unifiedSearchPos: clamp(
        s.unifiedSearchPos.x,
        s.unifiedSearchPos.y,
        s.unifiedSearchSize.w,
        s.unifiedSearchSize.h,
      ),
      appStoragePos: clamp(
        s.appStoragePos.x,
        s.appStoragePos.y,
        s.appStorageSize.w,
        s.appStorageSize.h,
      ),
      remoteTerminalPos: clamp(
        s.remoteTerminalPos.x,
        s.remoteTerminalPos.y,
        s.remoteTerminalSize.w,
        s.remoteTerminalSize.h,
      ),
      dupFinderPos: clamp(s.dupFinderPos.x, s.dupFinderPos.y, s.dupFinderSize.w, s.dupFinderSize.h),
      mediaSearchPos: clamp(
        s.mediaSearchPos.x,
        s.mediaSearchPos.y,
        s.mediaSearchSize.w,
        s.mediaSearchSize.h,
      ),
      assetLibraryPos: clamp(
        s.assetLibraryPos.x,
        s.assetLibraryPos.y,
        s.assetLibrarySize.w,
        s.assetLibrarySize.h,
      ),
      batchRenamePos: clamp(
        s.batchRenamePos.x,
        s.batchRenamePos.y,
        s.batchRenameSize.w,
        s.batchRenameSize.h,
      ),
    })
  }

  // ── Shortcut listeners (Ctrl+Shift+Alt+R / S / arrange) ──
  useEffect(() => {
    const applyNativeVisibility = (event: WindowVisibilityEvent) => {
      const visible =
        event.state === 'visible' || (legacyOverlay && event.state === 'preparing-show')
      if (useStore.getState().globalVisible !== visible)
        useStore.getState().toggleGlobalVisibility()
    }
    const c1 = window.electronAPI.onSnapPanels((wa) => {
      snapAllToScreen(wa)
    })
    const c2 = window.electronAPI.onShowAllPanels((wa) => {
      useStore.setState({
        showClock: true,
        showFolders: true,
        showPrompts: true,
        showSettings: true,
        showCalc: true,
        showFM: true,
        showImageSearch: true,
        showUnifiedSearch: true,
        showAppStorage: true,
        showRemoteTerminal: true,
        showDuplicateFinder: true,
        showMediaSearch: true,
        showAssetLibrary: true,
        showBatchRename: true,
        globalVisible: true,
      })
      snapAllToScreen(wa)
    })
    const c3 = window.electronAPI.onArrangeHorizontal(() => {
      useStore.getState().arrangeHorizontal()
    })
    const c4 = window.electronAPI.onArrangeGrid(() => {
      useStore.getState().autoArrange()
    })
    const c5 = window.electronAPI.onArrangeVertical(() => {
      useStore.getState().arrangeVertical()
    })
    const c6 = window.electronAPI.onToggleGlobalVisibility((event) => {
      applyNativeVisibility(event)
      visibilityGenerationRef.current = event.generation
      document.documentElement.dataset.windowVisibilityGeneration = String(event.generation)
      window.dispatchEvent(new Event('window-visibility-cancel-interactions'))
      window.dispatchEvent(new CustomEvent('window-visibility-state', { detail: event }))
    })
    const c7 = window.electronAPI.onShowGlobalVisibility((event) => {
      applyNativeVisibility(event)
      visibilityGenerationRef.current = event.generation
      document.documentElement.dataset.windowVisibilityGeneration = String(event.generation)
      window.dispatchEvent(new CustomEvent('window-visibility-state', { detail: event }))
      window.dispatchEvent(
        new CustomEvent('window-visibility-prepare-show', {
          detail: { generation: event.generation, reason: event.reason },
        }),
      )
    })
    const c8 = window.electronAPI.onWorkAreaChanged((wa) => {
      const previous = useStore.getState().workArea
      useStore.setState({ workArea: wa })
      snapAllToScreen(wa, previous)
    })
    const c9 = window.electronAPI.onHotkeyWarnings((failures) => {
      window.dispatchEvent(new CustomEvent('hotkey-warnings', { detail: failures }))
    })
    const c10 = window.electronAPI.onGlobalWindowShownForPaint((event) => {
      window.dispatchEvent(new CustomEvent('window-visibility-native-prewarmed', { detail: event }))
    })
    return () => {
      c1()
      c2()
      c3()
      c4()
      c5()
      c6()
      c7()
      c8()
      c9()
      c10()
    }
  }, [])

  // ── Load work area (needed before any linked move) ───────
  useEffect(() => {
    window.electronAPI.getWorkArea().then((wa) => {
      useStore.setState({ workArea: wa })
    })
  }, [])

  // The native window owns geometry and hit testing; content follows its viewport.
  useEffect(() => {
    document.documentElement.dataset.shell = 'desktop'
    const resize = () =>
      useStore.setState({
        workArea: { x: 0, y: 0, width: innerWidth, height: innerHeight, displays: [] },
      })
    resize()
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      delete document.documentElement.dataset.shell
    }
  }, [])

  // ── Auto-save settings (blocked until after load) ────────
  useEffect(() => {
    let cancelled = false
    let cancelIdle: (() => void) | undefined
    const loaders = lazyPanels.map((panel) => panel.load)
    const preloadNext = (index: number) => {
      if (cancelled || index >= loaders.length) return
      cancelIdle = scheduleIdleTask(() => {
        void loaders[index]()
          .catch(() => {
            /* best effort preload */
          })
          .finally(() => preloadNext(index + 1))
      })
    }
    const timer = window.setTimeout(() => {
      preloadNext(0)
    }, 2400)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      cancelIdle?.()
    }
  }, [])

  useAutoSaveSettings(ready)

  // ── Load on startup ─────────────────────────────────────
  useEffect(() => {
    if (loaded.current) return
    loaded.current = true

    // Load settings & config in parallel, then enable auto-save
    let pending = 2
    const done = () => {
      if (--pending === 0) {
        useStore.setState(focusedWorkspaceVisibility(useStore.getState()))
        setReady(true)
      }
    }

    window.electronAPI
      .loadSettings()
      .then((settings) => {
        if (settings) {
          // Validate & sanitize stored values
          const restoredDisplayScope = restoreFocusedDisplayScope(settings)
          const migrateDisplayScope =
            settings.focusedDisplayScopeVersion !== FOCUSED_DISPLAY_SCOPE_VERSION ||
            JSON.stringify(settings.displayScope) !== JSON.stringify(restoredDisplayScope)
          const t = Number(settings.transparency)
          const fsi = Number(settings.fontScaleIdx)
          const migratePanelSizes =
            Number(settings.panelSizeDefaultsVersion) < PANEL_SIZE_DEFAULTS_VERSION
          const storedPanelVisibilityVersion = Number(settings.panelVisibilityDefaultsVersion)
          const migratePanelVisibility =
            !Number.isFinite(storedPanelVisibilityVersion) ||
            storedPanelVisibilityVersion < PANEL_VISIBILITY_DEFAULTS_VERSION
          const migratedLargePanelSize = {
            w: DEFAULT_LARGE_PANEL_W,
            h: DEFAULT_LARGE_PANEL_H,
          }
          const migratedThemeId = normalizeThemeId(settings.themeId, settings.theme)
          const migratedThemeMode = normalizeThemeMode(settings.themeMode, migratedThemeId)
          const migrateTheme = !settings.themeId || !settings.themeMode
          const imageSearchUiPreferences = normalizeImageSearchUiPreferences(
            settings.imageSearchUiPreferences,
          )
          const mediaSearchUiPreferences = normalizeMediaSearchUiPreferences(
            settings.mediaSearchUiPreferences,
          )
          const migrateSearchUiPreferences =
            JSON.stringify(settings.imageSearchUiPreferences) !==
              JSON.stringify(imageSearchUiPreferences) ||
            JSON.stringify(settings.mediaSearchUiPreferences) !==
              JSON.stringify(mediaSearchUiPreferences)
          const visibilityFallback =
            Number.isFinite(storedPanelVisibilityVersion) &&
            storedPanelVisibilityVersion >= PANEL_VISIBILITY_DEFAULTS_VERSION
              ? PRODUCT_PRIMARY_WORKSPACE_VISIBILITY
              : PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY
          const restoredWorkspaceVisibility = {
            showClock: resolvePanelVisibility(
              settings,
              'clock',
              'showClock',
              visibilityFallback.showClock,
            ),
            showFolders: resolvePanelVisibility(
              settings,
              'folders',
              'showFolders',
              visibilityFallback.showFolders,
            ),
            showPrompts: resolvePanelVisibility(
              settings,
              'prompts',
              'showPrompts',
              visibilityFallback.showPrompts,
            ),
            showSettings: true,
            showCalc: resolvePanelVisibility(
              settings,
              'calc',
              'showCalc',
              visibilityFallback.showCalc,
            ),
            showFM: resolvePanelVisibility(settings, 'fm', 'showFM', visibilityFallback.showFM),
            showImageSearch: resolvePanelVisibility(
              settings,
              'imageSearch',
              'showImageSearch',
              visibilityFallback.showImageSearch,
            ),
            showUnifiedSearch: resolvePanelVisibility(
              settings,
              'unifiedSearch',
              'showUnifiedSearch',
              visibilityFallback.showUnifiedSearch,
            ),
            showAppStorage: resolvePanelVisibility(
              settings,
              'appStorage',
              'showAppStorage',
              visibilityFallback.showAppStorage,
            ),
            showRemoteTerminal: resolvePanelVisibility(
              settings,
              'remoteTerminal',
              'showRemoteTerminal',
              visibilityFallback.showRemoteTerminal,
            ),
            showDuplicateFinder: resolvePanelVisibility(
              settings,
              'duplicateFinder',
              'showDuplicateFinder',
              visibilityFallback.showDuplicateFinder,
            ),
            showMediaSearch: resolvePanelVisibility(
              settings,
              'mediaSearch',
              'showMediaSearch',
              visibilityFallback.showMediaSearch,
            ),
            showAssetLibrary: resolvePanelVisibility(
              settings,
              'assetLibrary',
              'showAssetLibrary',
              visibilityFallback.showAssetLibrary,
            ),
            showBatchRename: resolvePanelVisibility(
              settings,
              'batchRename',
              'showBatchRename',
              visibilityFallback.showBatchRename,
            ),
          }
          const workspaceVisibilityMigration = resolveProductWorkspaceVisibilityMigration(
            restoredWorkspaceVisibility,
            storedPanelVisibilityVersion,
            PANEL_VISIBILITY_DEFAULTS_VERSION,
          )

          useStore.setState({
            panelSizeDefaultsVersion: PANEL_SIZE_DEFAULTS_VERSION,
            panelVisibilityDefaultsVersion: PANEL_VISIBILITY_DEFAULTS_VERSION,
            ...(normalizeLanguage(settings.language) && {
              language: normalizeLanguage(settings.language)!,
            }),
            themeIdx: legacyThemeIndex(migratedThemeId),
            themeId: migratedThemeId,
            themeMode: migratedThemeMode,
            showDate: settings.showDate ?? true,
            transparency: isFinite(t) ? Math.max(0, Math.min(60, t)) : 0,
            fontScaleIdx: isFinite(fsi) ? Math.max(0, Math.min(3, fsi)) : 0,
            linkedMove: settings.linkedMove === true,
            displayScope: restoredDisplayScope,
            ...(safePoint(settings.workspaceNavigatorPos) && {
              workspaceNavigatorPos: safePoint(settings.workspaceNavigatorPos),
            }),
            ...(safePoint(settings.clockPos) && { clockPos: safePoint(settings.clockPos) }),
            ...(safePoint(settings.foldersPos) && { foldersPos: safePoint(settings.foldersPos) }),
            ...(safePoint(settings.promptsPos) && { promptsPos: safePoint(settings.promptsPos) }),
            ...(safePoint(settings.settingsPos) && {
              settingsPos: safePoint(settings.settingsPos),
            }),
            ...(safePoint(settings.calcPos) && { calcPos: safePoint(settings.calcPos) }),
            ...(safeSize(settings.clockSize) && { clockSize: safeSize(settings.clockSize) }),
            ...(safeSize(settings.foldersSize) && { foldersSize: safeSize(settings.foldersSize) }),
            ...(safeSize(settings.promptsSize) && { promptsSize: safeSize(settings.promptsSize) }),
            ...(safeSize(settings.settingsSize) && {
              settingsSize: safeSize(settings.settingsSize),
            }),
            ...(safeSize(settings.calcSize) && { calcSize: safeSize(settings.calcSize) }),
            ...(safePoint(settings.fmPos) && { fmPos: safePoint(settings.fmPos) }),
            ...(safeSize(settings.fmSize) && { fmSize: safeSize(settings.fmSize) }),
            ...(safePoint(settings.imageSearchPos) && {
              imageSearchPos: safePoint(settings.imageSearchPos),
            }),
            ...(safeSize(settings.imageSearchSize) && {
              imageSearchSize: safeSize(settings.imageSearchSize),
            }),
            ...(safePoint(settings.unifiedSearchPos) && {
              unifiedSearchPos: safePoint(settings.unifiedSearchPos),
            }),
            ...(safeSize(settings.unifiedSearchSize) && {
              unifiedSearchSize: safeSize(settings.unifiedSearchSize),
            }),
            ...(safePoint(settings.appStoragePos) && {
              appStoragePos: safePoint(settings.appStoragePos),
            }),
            ...(safeSize(settings.appStorageSize) && {
              appStorageSize: safeSize(settings.appStorageSize),
            }),
            ...(safePoint(settings.remoteTerminalPos) && {
              remoteTerminalPos: safePoint(settings.remoteTerminalPos),
            }),
            ...(safeSize(settings.remoteTerminalSize) && {
              remoteTerminalSize: safeSize(settings.remoteTerminalSize),
            }),
            ...(safePoint(settings.dupFinderPos) && {
              dupFinderPos: safePoint(settings.dupFinderPos),
            }),
            ...(safeSize(settings.dupFinderSize) && {
              dupFinderSize: safeSize(settings.dupFinderSize),
            }),
            ...(safePoint(settings.mediaSearchPos) && {
              mediaSearchPos: safePoint(settings.mediaSearchPos),
            }),
            ...(safeSize(settings.mediaSearchSize) && {
              mediaSearchSize: safeSize(settings.mediaSearchSize),
            }),
            ...(safePoint(settings.assetLibraryPos) && {
              assetLibraryPos: safePoint(settings.assetLibraryPos),
            }),
            ...(safeSize(settings.assetLibrarySize) && {
              assetLibrarySize: safeSize(settings.assetLibrarySize),
            }),
            ...(safePoint(settings.batchRenamePos) && {
              batchRenamePos: safePoint(settings.batchRenamePos),
            }),
            ...(safeSize(settings.batchRenameSize) && {
              batchRenameSize: safeSize(settings.batchRenameSize),
            }),
            ...(migratePanelSizes && {
              foldersSize: migratedLargePanelSize,
              calcSize: migratedLargePanelSize,
              fmSize: migratedLargePanelSize,
              imageSearchSize: migratedLargePanelSize,
              unifiedSearchSize: migratedLargePanelSize,
              appStorageSize: migratedLargePanelSize,
              remoteTerminalSize: migratedLargePanelSize,
              dupFinderSize: migratedLargePanelSize,
              mediaSearchSize: migratedLargePanelSize,
              assetLibrarySize: migratedLargePanelSize,
            }),
            // Global hide is a transient desktop action. On startup, restore the saved
            // panel snapshot together with the workspace navigator instead of keeping
            // visible panels in a contradictory globally-hidden state.
            globalVisible: true,
            savedVisibility: settings.savedVisibility || {},
            ...workspaceVisibilityMigration.visibility,
            ...(workspaceVisibilityMigration.migrated && {
              globalVisible: true,
              savedVisibility: { ...PRODUCT_PRIMARY_WORKSPACE_SAVED_VISIBILITY },
            }),
            // Restore ImageSearch scan paths
            imageSearchScanPaths: normalizeImageSearchScanPaths(settings.imageSearchScanPaths),
            imageSearchUiPreferences,
            mediaSearchUiPreferences,
          })
          void window.electronAPI.setDisplayScope(restoredDisplayScope).then((topology) => {
            useStore.setState({
              displayScope: topology.scope,
              workArea: { x: 0, y: 0, width: innerWidth, height: innerHeight, displays: [] },
            })
          })
          if (
            migratePanelSizes ||
            migratePanelVisibility ||
            migrateTheme ||
            migrateSearchUiPreferences ||
            migrateDisplayScope
          ) {
            scheduleSettingsWrite({
              displayScope: restoredDisplayScope,
              focusedDisplayScopeVersion: FOCUSED_DISPLAY_SCOPE_VERSION,
              theme: legacyThemeIndex(migratedThemeId),
              themeId: migratedThemeId,
              themeMode: migratedThemeMode,
              panelSizeDefaultsVersion: PANEL_SIZE_DEFAULTS_VERSION,
              panelVisibilityDefaultsVersion: PANEL_VISIBILITY_DEFAULTS_VERSION,
              imageSearchUiPreferences,
              mediaSearchUiPreferences,
              ...(migratePanelSizes && {
                foldersSize: migratedLargePanelSize,
                calcSize: migratedLargePanelSize,
                fmSize: migratedLargePanelSize,
                imageSearchSize: migratedLargePanelSize,
                unifiedSearchSize: migratedLargePanelSize,
                appStorageSize: migratedLargePanelSize,
                remoteTerminalSize: migratedLargePanelSize,
                dupFinderSize: migratedLargePanelSize,
                mediaSearchSize: migratedLargePanelSize,
                assetLibrarySize: migratedLargePanelSize,
              }),
              ...(workspaceVisibilityMigration.migrated && {
                globalVisible: true,
                savedVisibility: { ...PRODUCT_PRIMARY_WORKSPACE_SAVED_VISIBILITY },
                ...workspaceVisibilityMigration.visibility,
              }),
            })
          }

          // Restore FM-specific state to the FM store
          if (settings.fmLayout || settings.fmPaneTabs || settings.fmPaneSorts) {
            useFMStore.setState({
              ...(settings.fmLayout ? { fmLayout: settings.fmLayout } : {}),
              ...(settings.fmPaneTabs ? { fmPaneTabs: settings.fmPaneTabs } : {}),
              ...(settings.fmActiveTab ? { fmActiveTab: settings.fmActiveTab } : {}),
              ...(settings.fmPaneSorts ? { fmPaneSorts: settings.fmPaneSorts } : {}),
              ...(settings.fmShowHidden !== undefined
                ? { fmShowHidden: settings.fmShowHidden }
                : {}),
              ...(settings.fmFavorites ? { fmFavorites: settings.fmFavorites } : {}),
              ...(settings.fmViewModes ? { fmViewModes: settings.fmViewModes } : {}),
              ...(settings.fmGroupModes ? { fmGroupModes: settings.fmGroupModes } : {}),
              ...(settings.fmGroupExpanded ? { fmGroupExpanded: settings.fmGroupExpanded } : {}),
            })
          }
        }
        done()
      })
      .catch((e) => {
        console.error('[App] loadSettings failed:', e)
        done()
      })

    // Load config (tabs, prompts)
    window.electronAPI
      .loadConfig()
      .then((config) => {
        if (config) {
          useStore.setState({
            tabs: config.tabs || createDefaultTabs(),
            promptTabs: config.promptTabs || createDefaultPromptTabs(),
            activeTab: config.activeTab ?? 0,
            activePromptTab: config.activePromptTab ?? 0,
          })
        }
        done()
      })
      .catch((e) => {
        console.error('[App] loadConfig failed:', e)
        done()
      })
  }, [])

  // ── Auto-save config on dirty ───────────────────────────
  useEffect(() => {
    if (!configDirty) return
    const state = useStore.getState()
    window.electronAPI.saveConfig({
      tabs: state.tabs,
      promptTabs: state.promptTabs,
      activeTab: state.activeTab,
      activePromptTab: state.activePromptTab,
    })
    useStore.setState({ configDirty: false })
  }, [configDirty])

  // ── Apply theme ─────────────────────────────────────────
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const update = () => setSystemPrefersDark(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const preset = getThemePreset(themeId)
    const effectiveMode = resolveThemeMode(themeMode, systemPrefersDark)
    const root = document.documentElement
    root.setAttribute('data-theme', String(themeIdx))
    root.dataset.themeId = themeId
    root.dataset.themeMode = themeMode
    root.dataset.effectiveMode = effectiveMode
    root.dataset.material = preset.material
    root.dataset.density = preset.density
    for (const [name, value] of Object.entries(themeCssVariables(themeId, effectiveMode))) {
      root.style.setProperty(name, value)
    }
  }, [systemPrefersDark, themeId, themeIdx, themeMode])

  return (
    <div
      className="focused-workspace"
      data-testid="app-root"
      data-ready={ready ? 'true' : 'false'}
      data-presentation="desktop"
    >
      {legacyOverlay && (
        <Suspense fallback={null}>
          <LegacyOverlayDiagnostics visibilityGenerationRef={visibilityGenerationRef} />
        </Suspense>
      )}
      {ready && globalVisible && (
        <ErrorBoundary name="Workspace">
          <WorkspaceNavigator />
        </ErrorBoundary>
      )}
      {ready && showSettings && (
        <ErrorBoundary name="Settings">
          <Suspense fallback={null}>
            <SettingsPanel />
          </Suspense>
        </ErrorBoundary>
      )}
      {ready &&
        lazyPanels.map(
          ({ id, boundaryName, visibilityKey, Component, preserveWhenHidden = false }) => {
            const panelVisible = {
              showImageSearch,
              showUnifiedSearch,
              showAppStorage,
              showDuplicateFinder,
              showMediaSearch,
              showAssetLibrary,
            }[visibilityKey]
            const requestedMount = panelVisible || (!globalVisible && savedVisibility[id])
            if (requestedMount && preserveWhenHidden) mountedLazyPanelIds.current.add(id)
            if (!requestedMount && !(preserveWhenHidden && mountedLazyPanelIds.current.has(id))) {
              return null
            }
            return (
              <div key={id} style={{ display: panelVisible ? 'contents' : 'none' }}>
                <ErrorBoundary name={boundaryName}>
                  <Suspense fallback={null}>
                    <Component />
                  </Suspense>
                </ErrorBoundary>
              </div>
            )
          },
        )}
    </div>
  )
}

export default App
