import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { UnifiedResourceProfile, UnifiedSchedulerStats } from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'
import { useStore } from '../stores/useStore'
import { clampPanelToWorkspace } from '../services/workspaceGeometry'
import { nextRovingIndex } from '../services/productInformationArchitecture'
import type { ProductFirstRunGuideStepId } from '../../shared/ipc-contract'
import type { ProductReadinessAction } from '../services/productReadiness'
import FirstRunGuide from './FirstRunGuide'
import GlobalModelReadinessPanel from './GlobalModelReadinessPanel'
import ProductReadinessCenter from './ProductReadinessCenter'
import { useGlobalModelReadiness } from '../hooks/useGlobalModelReadiness'
import {
  PANEL_IDENTITIES,
  PANEL_ID_BY_VISIBILITY,
  type PanelVisibilityKey,
} from '../../shared/ipc/app-core'
import '../styles/workspace-navigator.css'
import { version as appVersion } from '../../package.json'

export const WORKSPACE_DOMAINS = [
  'Search',
  'Sources',
  'Library',
  'Organize',
  'Tasks',
  'Settings',
] as const

type WorkspaceDomain = (typeof WORKSPACE_DOMAINS)[number]
type VisibilityKey = Extract<
  PanelVisibilityKey,
  | 'showImageSearch'
  | 'showUnifiedSearch'
  | 'showMediaSearch'
  | 'showAssetLibrary'
  | 'showBatchRename'
  | 'showDuplicateFinder'
  | 'showFM'
  | 'showRemoteTerminal'
  | 'showSettings'
>

function focusPanel(visibilityKey: VisibilityKey, afterFocus?: () => void): void {
  useStore.setState({ [visibilityKey]: true })
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent('panel-focus-request', {
          detail: {
            panel: PANEL_IDENTITIES[PANEL_ID_BY_VISIBILITY[visibilityKey]].domId,
          },
        }),
      )
      afterFocus?.()
    })
  })
}

const WorkspaceNavigator: React.FC = () => {
  const { t } = useTranslation()
  const navigatorRef = useRef<HTMLElement | null>(null)
  const domainButtonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const navigatorPos = useStore((state) => state.workspaceNavigatorPos)
  const setNavigatorPos = useStore((state) => state.setWorkspaceNavigatorPos)
  const workArea = useStore((state) => state.workArea)
  const linkedMove = useStore((state) => state.linkedMove)
  const setLinkedMove = useStore((state) => state.setLinkedMove)
  const snapToGrid = useStore((state) => state.snapToGrid)
  const setSnapToGrid = useStore((state) => state.setSnapToGrid)
  const [activeDomain, setActiveDomain] = useState<WorkspaceDomain | null>(null)
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false)
  const [layoutOpen, setLayoutOpen] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)
  const [schedulerStats, setSchedulerStats] = useState<UnifiedSchedulerStats | null>(null)
  const globalModels = useGlobalModelReadiness()

  const refreshSchedulerStats = useCallback(async () => {
    try {
      setSchedulerStats(await window.electronAPI.unifiedSearch.getSchedulerStats())
    } catch {
      setSchedulerStats(null)
    }
  }, [])

  useEffect(() => {
    if (activeDomain !== 'Tasks') return
    void refreshSchedulerStats()
    const timer = window.setInterval(() => void refreshSchedulerStats(), 1500)
    return () => window.clearInterval(timer)
  }, [activeDomain, refreshSchedulerStats])

  useEffect(
    () => () => {
      dragCleanupRef.current?.()
    },
    [],
  )

  useEffect(() => {
    if (!navigatorPos) return
    const navigator = navigatorRef.current
    if (!navigator) return
    const rect = navigator.getBoundingClientRect()
    const next = clampPanelToWorkspace(
      workArea,
      navigatorPos.x,
      navigatorPos.y,
      rect.width,
      rect.height,
    )
    if (next.x !== navigatorPos.x || next.y !== navigatorPos.y) setNavigatorPos(next)
  }, [navigatorPos, setNavigatorPos, workArea])

  const startMove = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const navigator = navigatorRef.current
      if (!navigator) return

      const originX = Number(document.documentElement.dataset.overlayOriginX) || 0
      const originY = Number(document.documentElement.dataset.overlayOriginY) || 0
      const rect = navigator.getBoundingClientRect()
      const offsetX = event.clientX - rect.left
      const offsetY = event.clientY - rect.top
      const dragOrigin = { x: rect.left + originX, y: rect.top + originY }
      let frame = 0
      let pending: { x: number; y: number } | null = null
      let visualPosition: { x: number; y: number } | null = null

      // Keep the complete navigator subtree out of React's render loop while it
      // moves. The Tasks menu can contain live readiness data, so committing its
      // position on every mousemove used to repaint the whole transparent window.
      navigator.dataset.moving = 'true'
      navigator.style.left = `${dragOrigin.x}px`
      navigator.style.right = 'auto'
      navigator.style.top = `${dragOrigin.y}px`
      navigator.style.transform = 'translate3d(0, 0, 0)'
      navigator.style.willChange = 'transform'

      const flush = () => {
        frame = 0
        if (!pending) return
        const next = pending
        pending = null
        visualPosition = next
        navigator.style.transform = `translate3d(${next.x - dragOrigin.x}px, ${
          next.y - dragOrigin.y
        }px, 0)`
      }
      const onMove = (moveEvent: MouseEvent) => {
        const pointerX = moveEvent.clientX + originX
        const pointerY = moveEvent.clientY + originY
        pending = clampPanelToWorkspace(
          useStore.getState().workArea,
          pointerX - offsetX,
          pointerY - offsetY,
          rect.width,
          rect.height,
          { x: pointerX, y: pointerY },
        )
        if (!frame) frame = requestAnimationFrame(flush)
      }
      const finish = () => {
        if (frame) cancelAnimationFrame(frame)
        flush()
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', finish)
        window.removeEventListener('blur', finish)
        window.removeEventListener('window-visibility-cancel-interactions', finish)
        dragCleanupRef.current = null
        delete navigator.dataset.moving
        navigator.style.willChange = ''
        if (visualPosition) {
          navigator.style.left = `${visualPosition.x}px`
          navigator.style.right = 'auto'
          navigator.style.top = `${visualPosition.y}px`
          navigator.style.transform = 'none'
          setNavigatorPos(visualPosition)
        } else if (navigatorPos) {
          navigator.style.left = `${navigatorPos.x}px`
          navigator.style.right = 'auto'
          navigator.style.top = `${navigatorPos.y}px`
          navigator.style.transform = 'none'
        } else {
          navigator.style.left = ''
          navigator.style.right = ''
          navigator.style.top = ''
          navigator.style.transform = ''
        }
        window.dispatchEvent(new CustomEvent('panel-interaction', { detail: { active: false } }))
      }
      dragCleanupRef.current?.()
      dragCleanupRef.current = finish
      window.dispatchEvent(new CustomEvent('panel-interaction', { detail: { active: true } }))
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', finish)
      window.addEventListener('blur', finish)
      window.addEventListener('window-visibility-cancel-interactions', finish)
    },
    [navigatorPos, setNavigatorPos],
  )

  const openDomain = (domain: WorkspaceDomain) => {
    setAdvancedSearchOpen(false)
    setLayoutOpen(false)
    setModelsOpen(false)
    setActiveDomain(domain)
    switch (domain) {
      case 'Search':
        focusPanel('showUnifiedSearch')
        break
      case 'Sources':
        focusPanel('showImageSearch', () =>
          window.dispatchEvent(new Event('workspace-sources-focus')),
        )
        break
      case 'Library':
        focusPanel('showAssetLibrary')
        break
      case 'Settings':
        focusPanel('showSettings')
        break
    }
  }

  const moveDomainFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = nextRovingIndex(index, WORKSPACE_DOMAINS.length, event.key)
    if (nextIndex === null) return
    event.preventDefault()
    domainButtonRefs.current[nextIndex]?.focus()
  }

  const moveNavigatorWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Home') {
      event.preventDefault()
      setNavigatorPos(null)
      return
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const navigator = navigatorRef.current
    if (!navigator) return
    const originX = Number(document.documentElement.dataset.overlayOriginX) || 0
    const originY = Number(document.documentElement.dataset.overlayOriginY) || 0
    const rect = navigator.getBoundingClientRect()
    const current = navigatorPos ?? { x: rect.left + originX, y: rect.top + originY }
    const step = event.shiftKey ? 24 : 8
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    setNavigatorPos(
      clampPanelToWorkspace(workArea, current.x + dx, current.y + dy, rect.width, rect.height),
    )
  }

  const openReadinessAction = (action: ProductReadinessAction) => {
    if (action === 'review-derived-reset') {
      focusPanel('showSettings', () =>
        window.dispatchEvent(new Event('workspace-review-derived-reset')),
      )
      return
    }
    if (['add-source', 'scan-sources', 'reconnect-source'].includes(action)) {
      focusPanel('showImageSearch', () =>
        window.dispatchEvent(new Event('workspace-sources-focus')),
      )
      return
    }
    if (['prepare-image-search', 'retry-image-index'].includes(action)) {
      focusPanel('showImageSearch')
      return
    }
    focusPanel('showMediaSearch')
  }

  const openFirstRunStep = (step: ProductFirstRunGuideStepId) => {
    setAdvancedSearchOpen(false)
    setLayoutOpen(false)
    setModelsOpen(false)
    if (step === 'source') {
      focusPanel('showImageSearch', () =>
        window.dispatchEvent(new Event('workspace-sources-focus')),
      )
      return
    }
    if (step === 'models') {
      setActiveDomain('Tasks')
      requestAnimationFrame(() => {
        requestAnimationFrame(() => window.dispatchEvent(new Event('workspace-open-model-manager')))
      })
      return
    }
    if (step === 'catalog') {
      focusPanel('showImageSearch', () =>
        window.dispatchEvent(new Event('workspace-prepare-library-focus')),
      )
      return
    }
    focusPanel('showUnifiedSearch', () =>
      window.dispatchEvent(new Event('workspace-first-search-focus')),
    )
  }

  const taskCount = schedulerStats
    ? schedulerStats.lanes.local.running +
      schedulerStats.lanes.local.queued +
      schedulerStats.lanes.gpu.running +
      schedulerStats.lanes.gpu.queued
    : 0

  return (
    <nav
      ref={navigatorRef}
      className="workspace-navigator"
      data-portal=""
      aria-label={t('Workspace')}
      data-active-domain={activeDomain?.toLowerCase() ?? 'none'}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        setActiveDomain(null)
        setAdvancedSearchOpen(false)
        setLayoutOpen(false)
        setModelsOpen(false)
      }}
      style={
        navigatorPos
          ? { left: navigatorPos.x, right: 'auto', top: navigatorPos.y, transform: 'none' }
          : undefined
      }
    >
      {appVersion.includes('-alpha.') && (
        <div className="workspace-navigator__release" data-testid="workspace-alpha-version">
          <strong>{t('Siftory · 寻藏')}</strong>
          <span>{t('Alpha test · v{version}', { version: appVersion })}</span>
        </div>
      )}
      <div className="workspace-navigator__domains">
        {WORKSPACE_DOMAINS.map((domain, index) => (
          <button
            key={domain}
            ref={(element) => {
              domainButtonRefs.current[index] = element
            }}
            data-testid={`workspace-domain-${domain.toLowerCase()}`}
            aria-pressed={activeDomain === domain}
            aria-expanded={
              ['Search', 'Sources', 'Organize', 'Tasks'].includes(domain)
                ? activeDomain === domain
                : undefined
            }
            aria-controls={
              ['Search', 'Sources', 'Organize', 'Tasks'].includes(domain)
                ? `workspace-menu-${domain.toLowerCase()}`
                : undefined
            }
            onKeyDown={(event) => moveDomainFocus(event, index)}
            onClick={() => openDomain(domain)}
          >
            {t(domain)}
            {domain === 'Tasks' && taskCount > 0 ? ` · ${taskCount}` : ''}
          </button>
        ))}
        <button
          className={`workspace-navigator__models-toggle is-${globalModels.snapshot.state}`}
          data-testid="workspace-model-readiness-toggle"
          data-model-state={globalModels.snapshot.state}
          aria-pressed={modelsOpen}
          aria-expanded={modelsOpen}
          aria-controls="workspace-model-readiness-menu"
          onClick={() => {
            const nextOpen = !modelsOpen
            setActiveDomain(null)
            setAdvancedSearchOpen(false)
            setLayoutOpen(false)
            setModelsOpen(nextOpen)
            if (nextOpen) void globalModels.refresh({ deep: true })
          }}
        >
          {t('Models')} · {globalModels.snapshot.readyCount}/{globalModels.snapshot.totalCount}
        </button>
        <button
          data-testid="workspace-layout-toggle"
          aria-pressed={layoutOpen}
          aria-expanded={layoutOpen}
          aria-controls="workspace-layout-menu"
          onClick={() => {
            setActiveDomain(null)
            setAdvancedSearchOpen(false)
            setModelsOpen(false)
            setLayoutOpen((open) => !open)
          }}
        >
          {t('Layout')}
        </button>
        <button
          className="workspace-navigator__move"
          data-testid="workspace-navigator-move"
          onMouseDown={startMove}
          onDoubleClick={() => setNavigatorPos(null)}
          onKeyDown={moveNavigatorWithKeyboard}
          title={t('Drag to move navigation; double-click to reset')}
          aria-label={t('Drag to move navigation; double-click to reset')}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M7 1v12M1 7h12M7 1 5 3M7 1l2 2M7 13l-2-2M7 13l2-2M1 7l2-2M1 7l2 2M13 7l-2-2M13 7l-2 2" />
          </svg>
        </button>
      </div>

      {modelsOpen && (
        <div
          className="workspace-navigator__menu workspace-navigator__models"
          id="workspace-model-readiness-menu"
        >
          <GlobalModelReadinessPanel
            snapshot={globalModels.snapshot}
            checking={globalModels.checking}
            deepChecking={globalModels.deepChecking}
            onRefresh={() => void globalModels.refresh({ deep: true })}
            onManage={() => {
              setModelsOpen(false)
              focusPanel('showSettings', () =>
                window.dispatchEvent(new Event('workspace-open-model-settings')),
              )
            }}
          />
        </div>
      )}

      {layoutOpen && (
        <div
          className="workspace-navigator__menu workspace-navigator__layout"
          data-testid="workspace-layout-menu"
          id="workspace-layout-menu"
          role="group"
          aria-label={t('Layout')}
        >
          <button
            data-testid="workspace-layout-row"
            onClick={() => useStore.getState().arrangeHorizontal()}
          >
            ─ {t('Row')}
          </button>
          <button
            data-testid="workspace-layout-grid"
            onClick={() => useStore.getState().autoArrange()}
          >
            ⊞ {t('Grid')}
          </button>
          <button
            data-testid="workspace-layout-column"
            onClick={() => useStore.getState().arrangeVertical()}
          >
            ║ {t('Column')}
          </button>
          <button
            className={linkedMove ? 'is-enabled' : undefined}
            data-testid="workspace-layout-linked-move"
            aria-pressed={linkedMove}
            onClick={() => setLinkedMove(!linkedMove)}
          >
            {linkedMove ? `✓ ${t('Linked Move')}` : t('Linked Move')}
          </button>
          <button
            className={snapToGrid ? 'is-enabled' : undefined}
            data-testid="workspace-layout-snap-grid"
            aria-pressed={snapToGrid}
            onClick={() => setSnapToGrid(!snapToGrid)}
          >
            {snapToGrid ? `✓ ${t('Snap to Grid')}` : t('Snap to Grid')}
          </button>
        </div>
      )}

      {activeDomain !== 'Tasks' && !modelsOpen && <FirstRunGuide onNavigate={openFirstRunStep} />}

      {activeDomain === 'Search' && (
        <div className="workspace-navigator__menu" id="workspace-menu-search">
          <button
            className="workspace-navigator__primary-entry"
            data-testid="workspace-search-unified"
            onClick={() => focusPanel('showUnifiedSearch')}
          >
            {t('Unified search')}
          </button>
          <button
            className="workspace-navigator__advanced-toggle"
            data-testid="workspace-search-advanced-toggle"
            aria-expanded={advancedSearchOpen}
            aria-controls="workspace-search-advanced-tools"
            onClick={() => setAdvancedSearchOpen((open) => !open)}
          >
            {t('Advanced search tools')}
          </button>
          {advancedSearchOpen && (
            <div
              id="workspace-search-advanced-tools"
              className="workspace-navigator__advanced-tools"
            >
              <button
                data-testid="workspace-search-images"
                onClick={() => focusPanel('showImageSearch')}
              >
                {t('Photos and files')}
              </button>
              <button
                data-testid="workspace-search-videos"
                onClick={() => focusPanel('showMediaSearch')}
              >
                {t('Video search')}
              </button>
              <button
                data-testid="workspace-search-library"
                onClick={() => focusPanel('showAssetLibrary')}
              >
                {t('Asset Library')}
              </button>
            </div>
          )}
        </div>
      )}
      {activeDomain === 'Sources' && (
        <div className="workspace-navigator__menu" id="workspace-menu-sources">
          <button
            className="workspace-navigator__primary-entry"
            data-testid="workspace-manage-sources"
            onClick={() =>
              focusPanel('showImageSearch', () =>
                window.dispatchEvent(new Event('workspace-sources-focus')),
              )
            }
          >
            {t('Manage sources')}
          </button>
          <button
            data-testid="workspace-remote-advanced"
            onClick={() => focusPanel('showRemoteTerminal')}
          >
            {t('Remote source advanced tools')}
          </button>
        </div>
      )}
      {activeDomain === 'Organize' && (
        <div className="workspace-navigator__menu" id="workspace-menu-organize">
          <button onClick={() => focusPanel('showBatchRename')}>{t('Batch Rename')}</button>
          <button onClick={() => focusPanel('showDuplicateFinder')}>{t('Duplicate Finder')}</button>
          <button onClick={() => focusPanel('showFM')}>{t('File Manager')}</button>
        </div>
      )}
      {activeDomain === 'Tasks' && (
        <div
          className="workspace-navigator__menu workspace-navigator__tasks"
          data-testid="workspace-task-summary"
          id="workspace-menu-tasks"
        >
          <button
            className="workspace-navigator__getting-started"
            data-testid="workspace-first-run-guide"
            onClick={() => {
              setActiveDomain(null)
              requestAnimationFrame(() =>
                window.dispatchEvent(new Event('workspace-open-first-run-guide')),
              )
            }}
          >
            {t('Getting started')}
          </button>
          <div className="workspace-navigator__resource-policy" data-testid="resource-governor">
            <label>
              <span>{t('Resource mode')}</span>
              <select
                data-testid="resource-governor-profile"
                value={schedulerStats?.resource.profile ?? 'balanced'}
                onChange={(event) => {
                  const profile = event.target.value as UnifiedResourceProfile
                  void window.electronAPI.unifiedSearch
                    .setResourceProfile(profile)
                    .then(() => refreshSchedulerStats())
                }}
              >
                <option value="power-saver">{t('Power saver')}</option>
                <option value="balanced">{t('Balanced')}</option>
                <option value="quality">{t('High quality')}</option>
              </select>
            </label>
            <span data-testid="resource-governor-limits">
              {t('Local concurrency')}: {schedulerStats?.resource.effectiveLocalConcurrency ?? 0} ·{' '}
              {t('GPU concurrency')}: {schedulerStats?.resource.effectiveGpuConcurrency ?? 0}
            </span>
            {schedulerStats?.resource.backgroundPaused ? (
              <span data-testid="resource-governor-pressure">
                {t('Background work paused')}: {schedulerStats.resource.pressureReasons.join(', ')}
              </span>
            ) : null}
            <button
              data-testid="resource-governor-cancel-background"
              onClick={() => {
                void window.electronAPI.unifiedSearch
                  .cancelBackgroundTasks()
                  .then(() => refreshSchedulerStats())
              }}
            >
              {t('Cancel queued background tasks')}
            </button>
          </div>
          <div className="workspace-navigator__task-counts">
            <span>
              {t('Local tasks')}: {schedulerStats?.lanes.local.running ?? 0} /{' '}
              {schedulerStats?.lanes.local.queued ?? 0}
            </span>
            <span>
              {t('AI tasks')}: {schedulerStats?.lanes.gpu.running ?? 0} /{' '}
              {schedulerStats?.lanes.gpu.queued ?? 0}
            </span>
            <button onClick={() => focusPanel('showImageSearch')}>{t('Image indexing')}</button>
            <button onClick={() => focusPanel('showMediaSearch')}>{t('Video indexing')}</button>
          </div>
          <ProductReadinessCenter onAction={openReadinessAction} />
        </div>
      )}
    </nav>
  )
}

export default WorkspaceNavigator
