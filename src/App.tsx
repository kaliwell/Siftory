import './styles/focused-workspace.css'
import { focusedWorkspaceVisibility } from './services/focusedWorkspace'
import React, { Suspense, useEffect, useRef, useState } from 'react'
import { normalizeImageSearchScanPaths, useStore } from './stores/useStore'
import { useFMStore } from './stores/useFMStore'
import SettingsPanel from './components/SettingsPanel'
import WorkspaceNavigator from './components/WorkspaceNavigator'
import { ErrorBoundary } from './components/ErrorBoundary'
import { createDefaultTabs, createDefaultPromptTabs } from './config/default'
import { lazyPanelRegistry } from './config/panelRegistry'
import { useAutoSaveSettings } from './hooks/useAutoSaveSettings'
import { scheduleSettingsWrite } from './hooks/settingsWriter'
import { useMouseTransparency } from './hooks/useMouseTransparency'
import { resolvePanelVisibility } from './services/settingsVisibility'
import {
  PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY,
  PRODUCT_PRIMARY_WORKSPACE_SAVED_VISIBILITY,
  PRODUCT_PRIMARY_WORKSPACE_VISIBILITY,
  resolveProductWorkspaceVisibilityMigration,
} from './services/productInformationArchitecture'
import { resolveWindowMaterial } from './services/windowMaterial'
import { normalizeLanguage } from './i18n/core'
import {
  DEFAULT_LARGE_PANEL_H,
  DEFAULT_LARGE_PANEL_W,
  PANEL_SIZE_DEFAULTS_VERSION,
  PANEL_VISIBILITY_DEFAULTS_VERSION,
} from './types'
import type { WindowVisibilityEvent, WorkspaceWorkArea } from '../shared/ipc-contract'
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

type OverlayRect = { x: number; y: number; width: number; height: number }
type WorkArea = WorkspaceWorkArea
type PanelPoint = { x: number; y: number }
type PanelSize = { w: number; h: number }
type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
  cancelIdleCallback?: (id: number) => void
}

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
  const transparency = useStore((s) => s.transparency)
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
  const workArea = useStore((s) => s.workArea)
  const [ready, setReady] = useState(false)
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true,
  )
  const [overlayOrigin, setOverlayOrigin] = useState({ x: 0, y: 0 })
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
      visibilityGenerationRef.current = event.generation
      document.documentElement.dataset.windowVisibilityGeneration = String(event.generation)
      window.dispatchEvent(new Event('window-visibility-cancel-interactions'))
      window.dispatchEvent(new CustomEvent('window-visibility-state', { detail: event }))
    })
    const c7 = window.electronAPI.onShowGlobalVisibility((event) => {
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

  // ── Mouse transparency (single source of truth) ──────────
  useMouseTransparency()

  // Shape the native window to visible panels so transparent desktop-sized
  // areas do not interfere with browser video overlay planes.
  useEffect(() => {
    let lastShape = ''
    let interactionActive = false
    let shapeUpdatesEnabled = true
    let shapeRaf = 0
    let shapeSettleTimer = 0
    let cancelVisibilityTurn1: (() => void) | null = null
    let cancelVisibilityTurn2: (() => void) | null = null
    let cancelVisibilityPaintTurn1: (() => void) | null = null
    let cancelVisibilityPaintTurn2: (() => void) | null = null
    let forceShapeSync = false
    let shapeRequest = 0
    let shapeDisposed = false
    let visibilityRetryTimer = 0
    let successfulShapeRevision = 0
    let stalledVisibilityRetry: {
      generation: number
      phase: 'layout' | 'paint'
      retry: () => void
    } | null = null
    let committedVisibilityGeneration: number | null = null
    let periodicPaintRetryEligible = false
    let currentOrigin = { x: 0, y: 0 }
    const updateOrigin = (viewport: { x: number; y: number }) => {
      if (viewport.x === currentOrigin.x && viewport.y === currentOrigin.y) return
      currentOrigin = { x: viewport.x, y: viewport.y }
      document.documentElement.dataset.overlayOriginX = String(viewport.x)
      document.documentElement.dataset.overlayOriginY = String(viewport.y)
      setOverlayOrigin(currentOrigin)
    }
    const applyWorkspaceShape = async (rects: OverlayRect[]) => {
      if (shapeDisposed) return false
      const generation = visibilityGenerationRef.current
      const request = ++shapeRequest
      const viewport = await window.electronAPI.setOverlayShape(rects, generation)
      if (
        !shapeDisposed &&
        request === shapeRequest &&
        generation === visibilityGenerationRef.current
      ) {
        updateOrigin(viewport)
        successfulShapeRevision++
        return true
      }
      return false
    }
    const measureWorkspaceShape = () => {
      const elements = document.querySelectorAll<HTMLElement>('.panel, [data-portal]')
      const padding = interactionActive ? 24 : 14
      return Array.from(elements)
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            x: Math.max(0, Math.floor(rect.left) - padding),
            y: Math.max(0, Math.floor(rect.top) - padding),
            width: Math.ceil(rect.width) + padding * 2,
            height: Math.ceil(rect.height) + padding * 2,
          }
        })
        .filter((rect) => rect.width > 4 && rect.height > 4)
        .map((rect) => ({
          ...rect,
          x: rect.x + currentOrigin.x,
          y: rect.y + currentOrigin.y,
        }))
    }
    const syncShape = async (force = false) => {
      if (shapeDisposed || (!shapeUpdatesEnabled && !force)) return false
      if (interactionActive && !force) return false
      const generation = visibilityGenerationRef.current
      const workspaceRects = measureWorkspaceShape()
      try {
        if (workspaceRects.length === 0) {
          if (lastShape !== '[]') {
            lastShape = '[]'
            await applyWorkspaceShape([])
          }
          return false
        }
        const nextShape = JSON.stringify(workspaceRects)
        if (nextShape === lastShape) return true
        lastShape = nextShape
        return await applyWorkspaceShape(workspaceRects)
      } catch {
        if (generation === visibilityGenerationRef.current) lastShape = ''
        return false
      }
    }
    const scheduleShapeSync = (force = false) => {
      forceShapeSync ||= force
      if (shapeRaf) return
      shapeRaf = requestAnimationFrame(() => {
        shapeRaf = 0
        const shouldForce = forceShapeSync
        forceShapeSync = false
        if (shouldForce) lastShape = ''
        const beforeShape = successfulShapeRevision
        const mayRetryPaint = periodicPaintRetryEligible
        periodicPaintRetryEligible = false
        void syncShape(shouldForce).then((ready) => {
          if (
            ready &&
            !shapeDisposed &&
            (successfulShapeRevision > beforeShape ||
              (mayRetryPaint && stalledVisibilityRetry?.phase === 'paint')) &&
            stalledVisibilityRetry?.generation === visibilityGenerationRef.current
          ) {
            // Layout recovery requires a newly successful native Shape. A
            // stalled paint ACK can retry once on this existing observer tick,
            // even when the already validated geometry has not changed.
            const retry = stalledVisibilityRetry.retry
            stalledVisibilityRetry = null
            retry()
          }
        })
      })
    }
    const scheduleSettledShapeSync = (force = false) => {
      forceShapeSync ||= force
      window.clearTimeout(shapeSettleTimer)
      shapeSettleTimer = window.setTimeout(
        () => {
          shapeSettleTimer = 0
          scheduleShapeSync()
        },
        lastShape ? 80 : 300,
      )
    }
    const observedPanels = new WeakSet<Element>()
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => scheduleSettledShapeSync())
    const observePanels = () => {
      if (!resizeObserver) return
      document.querySelectorAll<HTMLElement>('.panel, [data-portal]').forEach((element) => {
        if (observedPanels.has(element)) return
        observedPanels.add(element)
        resizeObserver.observe(element)
      })
    }
    const mutationContainsShapeElement = (mutation: MutationRecord) => {
      if (mutation.type === 'attributes') {
        return (mutation.target as Element).matches?.('.panel, [data-portal]') ?? false
      }
      return [...mutation.addedNodes, ...mutation.removedNodes].some(
        (node) =>
          node instanceof Element &&
          (node.matches('.panel, [data-portal]') ||
            Boolean(node.querySelector('.panel, [data-portal]'))),
      )
    }
    const mutationObserver = new MutationObserver((mutations) => {
      // Dragging changes the inline transform every animation frame. The native
      // shape already covers the full work area during an interaction, so DOM
      // measurement and shape IPC here only create a needless compositor queue.
      if (interactionActive || !mutations.some(mutationContainsShapeElement)) return
      observePanels()
      scheduleSettledShapeSync()
    })
    const onPanelInteraction = (event: Event) => {
      interactionActive = !!(event as CustomEvent<{ active: boolean }>).detail?.active
      if (interactionActive) {
        window.clearTimeout(shapeSettleTimer)
        shapeSettleTimer = 0
        window.cancelAnimationFrame(shapeRaf)
        shapeRaf = 0
        forceShapeSync = false
        document.documentElement.dataset.panelInteraction = 'active'
        lastShape = ''
        const workArea = useStore.getState().workArea
        void applyWorkspaceShape([{ x: 0, y: 0, width: workArea.width, height: workArea.height }])
      } else {
        delete document.documentElement.dataset.panelInteraction
        observePanels()
        scheduleSettledShapeSync(true)
      }
    }
    const onPanelVisibilityChanged = () => {
      observePanels()
      scheduleSettledShapeSync(true)
    }
    const scheduleVisibilityLayoutTurn = (callback: () => void): (() => void) => {
      const channel = new MessageChannel()
      let active = true
      let raf = 0
      const finish = () => {
        if (!active) return
        active = false
        window.cancelAnimationFrame(raf)
        channel.port1.onmessage = null
        channel.port1.close()
        channel.port2.close()
        document.body.getBoundingClientRect()
        callback()
      }
      channel.port1.onmessage = finish
      channel.port2.postMessage(undefined)
      raf = window.requestAnimationFrame(finish)
      return () => {
        active = false
        window.cancelAnimationFrame(raf)
        channel.port1.onmessage = null
        channel.port1.close()
        channel.port2.close()
      }
    }
    const scheduleVisibilityPaintTurn = (callback: () => void): (() => void) => {
      let active = true
      let raf = 0
      let timeout = 0
      const finish = () => {
        if (!active) return
        active = false
        window.clearTimeout(timeout)
        window.cancelAnimationFrame(raf)
        document.body.getBoundingClientRect()
        callback()
      }
      raf = window.requestAnimationFrame(finish)
      timeout = window.setTimeout(finish, 120)
      return () => {
        active = false
        window.clearTimeout(timeout)
        window.cancelAnimationFrame(raf)
      }
    }
    const retryVisibility = (
      generation: number,
      attempt: number,
      retry: (attempt: number) => void,
      phase: 'layout' | 'paint' = 'layout',
    ) => {
      if (
        shapeDisposed ||
        visibilityGenerationRef.current !== generation ||
        committedVisibilityGeneration === generation
      )
        return
      if (attempt >= 3) {
        stalledVisibilityRetry = {
          generation,
          phase,
          retry: () => retry(phase === 'paint' ? 3 : 0),
        }
        return
      }
      window.clearTimeout(visibilityRetryTimer)
      visibilityRetryTimer = window.setTimeout(
        () => {
          visibilityRetryTimer = 0
          if (
            !shapeDisposed &&
            visibilityGenerationRef.current === generation &&
            committedVisibilityGeneration !== generation
          )
            retry(attempt + 1)
        },
        80 * (attempt + 1),
      )
    }
    const onWindowVisibilityPrepareShow = (event: Event) => {
      const detail = (
        event as CustomEvent<{ generation?: number; reason?: WindowVisibilityEvent['reason'] }>
      ).detail
      const generation = Number(detail?.generation)
      if (!Number.isSafeInteger(generation) || generation < 0) return
      cancelVisibilityTurn1?.()
      cancelVisibilityTurn2?.()
      shapeUpdatesEnabled = true
      const prepare = (attempt = 0) => {
        cancelVisibilityTurn1 = scheduleVisibilityLayoutTurn(() => {
          cancelVisibilityTurn1 = null
          if (shapeDisposed || visibilityGenerationRef.current !== generation) return
          cancelVisibilityTurn2 = scheduleVisibilityLayoutTurn(() => {
            cancelVisibilityTurn2 = null
            if (shapeDisposed || visibilityGenerationRef.current !== generation) return
            lastShape = ''
            void syncShape(true)
              .then(async (ready) => {
                if (!ready || shapeDisposed || visibilityGenerationRef.current !== generation)
                  return false
                return window.electronAPI.showWindow(generation)
              })
              .then((shown) => {
                if (!shown) retryVisibility(generation, attempt, prepare)
              })
              .catch(() => retryVisibility(generation, attempt, prepare))
          })
        })
      }
      prepare()
    }
    const onWindowVisibilityNativePrewarmed = (event: Event) => {
      const detail = (event as CustomEvent<WindowVisibilityEvent>).detail
      const generation = Number(detail?.generation)
      if (
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        shapeDisposed ||
        visibilityGenerationRef.current !== generation
      )
        return
      if (committedVisibilityGeneration === generation) return
      if (detail.state === 'visible') {
        window.dispatchEvent(new CustomEvent('window-visibility-state', { detail }))
        return
      }
      cancelVisibilityPaintTurn1?.()
      cancelVisibilityPaintTurn2?.()
      const paint = (attempt = 0) => {
        cancelVisibilityPaintTurn1 = scheduleVisibilityPaintTurn(() => {
          cancelVisibilityPaintTurn1 = null
          if (shapeDisposed || visibilityGenerationRef.current !== generation) return
          cancelVisibilityPaintTurn2 = scheduleVisibilityPaintTurn(() => {
            cancelVisibilityPaintTurn2 = null
            if (shapeDisposed || visibilityGenerationRef.current !== generation) return
            void window.electronAPI
              .revealWindow(generation)
              .then((revealed) => {
                if (
                  shapeDisposed ||
                  visibilityGenerationRef.current !== generation ||
                  committedVisibilityGeneration === generation
                )
                  return
                if (!revealed) {
                  retryVisibility(generation, attempt, paint, 'paint')
                  return
                }
                window.dispatchEvent(
                  new CustomEvent('window-visibility-state', {
                    detail: { generation, state: 'visible', reason: detail.reason },
                  }),
                )
              })
              .catch(() => retryVisibility(generation, attempt, paint, 'paint'))
          })
        })
      }
      paint()
    }
    const onWindowVisibilityState = (event: Event) => {
      const detail = (event as CustomEvent<WindowVisibilityEvent>).detail
      const state = detail?.state
      shapeUpdatesEnabled = state === 'visible' || state === 'preparing-show'
      committedVisibilityGeneration = state === 'visible' ? detail.generation : null
      periodicPaintRetryEligible = false
      stalledVisibilityRetry = null
      window.clearTimeout(visibilityRetryTimer)
      visibilityRetryTimer = 0
      cancelVisibilityTurn1?.()
      cancelVisibilityTurn1 = null
      cancelVisibilityTurn2?.()
      cancelVisibilityTurn2 = null
      cancelVisibilityPaintTurn1?.()
      cancelVisibilityPaintTurn1 = null
      cancelVisibilityPaintTurn2?.()
      cancelVisibilityPaintTurn2 = null
      if (state !== 'visible') {
        shapeRequest++
        window.cancelAnimationFrame(shapeRaf)
        shapeRaf = 0
        window.clearTimeout(shapeSettleTimer)
        shapeSettleTimer = 0
        forceShapeSync = false
        lastShape = ''
      }
    }
    const onViewportChanged = () => scheduleSettledShapeSync(true)
    window.addEventListener('panel-interaction', onPanelInteraction)
    window.addEventListener('panel-visibility-changed', onPanelVisibilityChanged)
    window.addEventListener('window-visibility-prepare-show', onWindowVisibilityPrepareShow)
    window.addEventListener('window-visibility-native-prewarmed', onWindowVisibilityNativePrewarmed)
    window.addEventListener('window-visibility-state', onWindowVisibilityState)
    window.addEventListener('resize', onViewportChanged)
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    })
    observePanels()
    scheduleSettledShapeSync(true)
    const timer = window.setInterval(() => {
      periodicPaintRetryEligible = true
      scheduleSettledShapeSync()
    }, 1500)
    return () => {
      shapeDisposed = true
      stalledVisibilityRetry = null
      window.clearTimeout(visibilityRetryTimer)
      window.clearInterval(timer)
      window.clearTimeout(shapeSettleTimer)
      window.cancelAnimationFrame(shapeRaf)
      cancelVisibilityTurn1?.()
      cancelVisibilityTurn2?.()
      cancelVisibilityPaintTurn1?.()
      cancelVisibilityPaintTurn2?.()
      resizeObserver?.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('panel-interaction', onPanelInteraction)
      window.removeEventListener('panel-visibility-changed', onPanelVisibilityChanged)
      window.removeEventListener('window-visibility-prepare-show', onWindowVisibilityPrepareShow)
      window.removeEventListener(
        'window-visibility-native-prewarmed',
        onWindowVisibilityNativePrewarmed,
      )
      window.removeEventListener('window-visibility-state', onWindowVisibilityState)
      window.removeEventListener('resize', onViewportChanged)
      delete document.documentElement.dataset.overlayOriginX
      delete document.documentElement.dataset.overlayOriginY
      delete document.documentElement.dataset.panelInteraction
      delete document.documentElement.dataset.windowVisibilityGeneration
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
            displayScope: settings.displayScope ?? { mode: 'all' },
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
          void window.electronAPI
            .setDisplayScope(settings.displayScope ?? { mode: 'all' })
            .then((topology) => {
              useStore.setState({
                displayScope: topology.scope,
                workArea: topology.workArea,
              })
            })
          if (
            migratePanelSizes ||
            migratePanelVisibility ||
            migrateTheme ||
            migrateSearchUiPreferences
          ) {
            scheduleSettingsWrite({
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

  // Keep text and controls fully opaque. The appearance slider changes only
  // the panel material instead of fading the entire native window.
  useEffect(() => {
    const material = resolveWindowMaterial(transparency)
    const rootStyle = document.documentElement.style
    document.documentElement.dataset.surface = material.mode
    rootStyle.setProperty('--panel-surface-alpha', String(material.surfaceAlpha))
    rootStyle.setProperty('--panel-glass-blur', `${material.blurPx}px`)
    rootStyle.setProperty('--panel-glass-saturation', String(material.saturation))
  }, [transparency])

  return (
    <div
      className="focused-workspace"
      data-testid="app-root"
      data-ready={ready ? 'true' : 'false'}
      style={{
        width: workArea.width,
        height: workArea.height,
        position: 'absolute',
        left: -overlayOrigin.x,
        top: -overlayOrigin.y,
        background: 'transparent',
        // `hidden` still creates a programmatically scrollable container. Focus
        // changes inside a tall navigator could therefore shift the complete
        // workspace after a drag even though no scrollbar was visible.
        overflow: 'clip',
      }}
    >
      {ready && globalVisible && (
        <ErrorBoundary name="Workspace">
          <WorkspaceNavigator />
        </ErrorBoundary>
      )}
      {ready && showSettings && (
        <ErrorBoundary name="Settings">
          <SettingsPanel />
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
