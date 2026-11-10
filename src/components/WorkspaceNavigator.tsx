import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type {
  ProductFirstRunGuideStepId,
  UnifiedResourceProfile,
  UnifiedSchedulerStats,
} from '../../shared/ipc-contract'
import { PANEL_IDENTITIES } from '../../shared/ipc/app-core'
import { useTranslation } from '../i18n/useTranslation'
import { useStore } from '../stores/useStore'
import { nextRovingIndex } from '../services/productInformationArchitecture'
import { WORKSPACE_PANELS, type WorkspacePanel } from '../services/focusedWorkspace'
import WorkspaceIcon from './WorkspaceIcon'
import { openWorkspacePanel } from '../services/openWorkspace'
import { resolveWorkspaceRoute } from '../services/workspaceRoutes'
import FirstRunGuide from './FirstRunGuide'
import '../styles/workspace-status.css'
import ProductReadinessCenter from './ProductReadinessCenter'
import type { ProductReadinessAction } from '../services/productReadiness'
import { version as appVersion } from '../../package.json'
import {
  flushSettingsWrites,
  getSettingsWriteStatus,
  subscribeSettingsWriteStatus,
} from '../hooks/settingsWriter'

export const WORKSPACE_DOMAINS = ['Search', 'Library', 'Sources', 'Tasks', 'Settings'] as const
const WorkspaceTasksPage = React.lazy(() => import('./WorkspaceTasksPage'))

interface WorkspaceNavigatorProps {
  tasksOpen: boolean
  setTasksOpen: React.Dispatch<React.SetStateAction<boolean>>
}
const WorkspaceNavigator: React.FC<WorkspaceNavigatorProps> = ({ tasksOpen, setTasksOpen }) => {
  const { t } = useTranslation()
  const activePanel = useStore((state) =>
    WORKSPACE_PANELS.find((panel) => state[PANEL_IDENTITIES[panel].visibilityKey]),
  )
  const globalVisible = useStore((state) => state.globalVisible)
  const imageSearchWorkspaceView = useStore(
    (state) => state.imageSearchUiPreferences.workspaceView ?? 'sources',
  )
  const videoWorkspaceView = useStore((state) => state.mediaSearchUiPreferences.workspaceView)
  const activeRoute = resolveWorkspaceRoute(
    activePanel,
    imageSearchWorkspaceView,
    videoWorkspaceView,
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.matchMedia('(max-width: 1100px)').matches,
  )
  const saveStatus = useSyncExternalStore(subscribeSettingsWriteStatus, getSettingsWriteStatus)
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const pendingModelManager = useRef(false)
  useEffect(() => {
    const openModels = () => {
      pendingModelManager.current = true
      setTasksOpen(true)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (document.querySelector('.workspace-task-page')) {
            pendingModelManager.current = false
            window.dispatchEvent(new Event('workspace-open-model-manager'))
          }
        }),
      )
    }
    window.addEventListener('workspace-open-search-models', openModels)
    return () => window.removeEventListener('workspace-open-search-models', openModels)
  }, [setTasksOpen])
  const taskPageReady = useCallback(() => {
    if (pendingModelManager.current) {
      pendingModelManager.current = false
      window.dispatchEvent(new Event('workspace-open-model-manager'))
    }
  }, [])
  const [alphaExpanded, setAlphaExpanded] = useState(false)
  const [guideMounted, setGuideMounted] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [activeTaskCount, setActiveTaskCount] = useState<number | null>(null)
  const [stats, setStats] = useState<UnifiedSchedulerStats | null>(null)
  const [taskError, setTaskError] = useState('')
  const [resourceBusy, setResourceBusy] = useState(false)
  const resourceBusyRef = useRef(false)
  const statsVersion = useRef(0)
  useEffect(() => {
    if (!globalVisible) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      const version = ++statsVersion.current
      try {
        if (resourceBusyRef.current) return
        const value = await window.electronAPI.unifiedSearch.getSchedulerStats()
        if (alive && version === statsVersion.current) setStats(value)
      } catch {
        if (alive && version === statsVersion.current) setStats(null)
      } finally {
        if (alive) timer = setTimeout(() => void refresh(), 5000)
      }
    }
    void refresh()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [globalVisible])

  const navigate = (
    panel: WorkspacePanel,
    eventName?: string,
    imageView: 'sources' | 'search' = 'sources',
  ) => {
    if (panel === 'imageSearch')
      useStore.getState().setImageSearchUiPreferences({ workspaceView: imageView })
    if (panel === 'mediaSearch')
      useStore.getState().setMediaSearchUiPreferences({ workspaceView: 'sources' })
    setTasksOpen(false)
    setGuideOpen(false)
    openWorkspacePanel(panel, eventName)
  }
  const onReadinessAction = (action: ProductReadinessAction) => {
    if (action === 'review-derived-reset') navigate('settings', 'workspace-review-derived-reset')
    else if (['add-source', 'reconnect-source'].includes(action))
      navigate('appStorage', 'workspace-maintenance-sources-focus')
    else if (action === 'scan-sources') navigate('imageSearch', 'workspace-prepare-library-focus')
    else if (['prepare-image-search', 'retry-image-index'].includes(action)) navigate('imageSearch')
    else navigate('mediaSearch')
  }
  const openFirstRunStep = (step: ProductFirstRunGuideStepId) => {
    if (step === 'source') navigate('appStorage', 'workspace-maintenance-sources-focus')
    else if (step === 'models') navigate('settings', 'workspace-open-model-settings')
    else if (step === 'catalog') navigate('imageSearch', 'workspace-prepare-library-focus')
    else navigate('imageSearch', 'workspace-first-search-focus', 'search')
  }
  const count = stats
    ? stats.lanes.local.running +
      stats.lanes.local.queued +
      stats.lanes.gpu.running +
      stats.lanes.gpu.queued
    : 0
  const entries = [
    { label: 'Search', display: 'Search', panel: 'imageSearch', icon: 'search', view: 'search' },
    { label: 'Library', display: 'Library', panel: 'assetLibrary', icon: 'library' },
    {
      label: 'Sources',
      display: 'Scan folders',
      panel: 'imageSearch',
      icon: 'folder',
      view: 'sources',
    },
  ] as const

  return (
    <>
      <nav
        className="workspace-sidebar"
        data-portal=""
        data-collapsed={sidebarCollapsed}
        aria-label={t('Workspace')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setGuideOpen(false)
          }
        }}
      >
        <button
          className="workspace-sidebar-toggle"
          data-testid="workspace-sidebar-toggle"
          aria-label={t(sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation')}
          title={t(sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation')}
          aria-expanded={!sidebarCollapsed}
          onClick={() => setSidebarCollapsed((value) => !value)}
        >
          <WorkspaceIcon name="filter" />
          <span>{t('Collapse navigation')}</span>
        </button>
        <div className="workspace-sidebar__links" role="group" aria-label={t('Workspace')}>
          {entries.map((entry, index) => (
            <button
              key={entry.label}
              ref={(element) => {
                refs.current[index] = element
              }}
              data-testid={`workspace-domain-${entry.label.toLowerCase().replaceAll(' ', '-')}`}
              title={t(entry.display)}
              aria-label={t(entry.display)}
              aria-current={
                !tasksOpen &&
                (entry.label === 'Search'
                  ? activeRoute?.endsWith('search')
                  : entry.label === 'Sources'
                    ? activeRoute?.endsWith('sources')
                    : activePanel === entry.panel)
                  ? 'page'
                  : undefined
              }
              onKeyDown={(event) => {
                const next = nextRovingIndex(index, entries.length, event.key)
                if (next !== null) {
                  event.preventDefault()
                  refs.current[next]?.focus()
                }
              }}
              onClick={() => {
                if (
                  (entry.label === 'Search' && activeRoute?.endsWith('search')) ||
                  (entry.label === 'Sources' && activeRoute?.endsWith('sources'))
                ) {
                  setTasksOpen(false)
                  setGuideOpen(false)
                  return
                }
                navigate(
                  entry.panel,
                  entry.label === 'Sources' ? 'workspace-sources-focus' : undefined,
                  'view' in entry ? entry.view : undefined,
                )
              }}
            >
              <WorkspaceIcon name={entry.icon} />
              <span>{t(entry.display)}</span>
            </button>
          ))}
        </div>
        <div className="workspace-sidebar__maintenance">
          <span className="workspace-nav-label">{t('Manage')}</span>
          <button
            data-testid="workspace-domain-maintenance"
            title={t('Index and maintenance')}
            aria-label={t('Index and maintenance')}
            aria-current={!tasksOpen && activePanel === 'appStorage' ? 'page' : undefined}
            onClick={() => navigate('appStorage')}
          >
            <WorkspaceIcon name="database" />
            <span>{t('Index and maintenance')}</span>
          </button>
          <button
            data-testid="workspace-domain-settings"
            title={t('Settings')}
            aria-label={t('Settings')}
            aria-current={!tasksOpen && activePanel === 'settings' ? 'page' : undefined}
            onClick={() => navigate('settings')}
          >
            <WorkspaceIcon name="settings" />
            <span>{t('Settings')}</span>
          </button>
        </div>
        {saveStatus === 'error' && (
          <div className="workspace-save-error" data-testid="workspace-save-error" role="alert">
            <span>{t('Settings could not be saved. Retry before closing the app.')}</span>
            <button onClick={() => void flushSettingsWrites().catch(() => {})}>{t('Retry')}</button>
          </div>
        )}
        <button
          className="workspace-sidebar__tasks"
          data-testid="workspace-domain-tasks"
          title={t('Tasks')}
          aria-label={t('Tasks')}
          aria-current={tasksOpen ? 'page' : undefined}
          aria-controls="workspace-task-summary"
          onClick={() => {
            setGuideOpen(false)
            setTasksOpen(true)
          }}
        >
          <WorkspaceIcon name="tasks" />
          <span>{t('Tasks')}</span>
          <span className="workspace-task-count">
            {tasksOpen ? (activeTaskCount ?? count) : count}
          </span>
        </button>
        <div className="workspace-sidebar__footer">
          <span>
            <i />
            {t('Local workspace')}
          </span>
          <details
            className="workspace-alpha-disclosure"
            open={alphaExpanded}
            onToggle={(event) => setAlphaExpanded(event.currentTarget.open)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setAlphaExpanded(false)
                event.currentTarget.querySelector('summary')?.focus()
              }
            }}
          >
            <summary aria-label={t('Alpha test notice')} title={t('Alpha test notice')}>
              v{appVersion} <span aria-hidden="true" />
            </summary>
            <div className="workspace-alpha-disclosure__content">
              <strong>{t('Alpha test notice')}</strong>
              <p>
                {t(
                  'Alpha testing only. Back up application data and original files. You are responsible for assessing use and file operations; results may be inaccurate.',
                )}
              </p>
              <button onClick={() => setAlphaExpanded(false)}>{t('Close')}</button>
            </div>
          </details>
        </div>
        {guideMounted && (
          <section
            className="workspace-task-drawer workspace-guide-drawer"
            data-portal=""
            hidden={!guideOpen}
            aria-label={t('Getting started')}
          >
            <header>
              <strong>{t('Getting started')}</strong>
              <button onClick={() => setGuideOpen(false)}>{t('Close')}</button>
            </header>
            <FirstRunGuide
              onNavigate={openFirstRunStep}
              reopenOnMount
              active={guideOpen && globalVisible}
            />
          </section>
        )}
      </nav>
      {tasksOpen && (
        <React.Suspense fallback={null}>
          <WorkspaceTasksPage
            onReady={taskPageReady}
            onGettingStarted={() => {
              setTasksOpen(false)
              setGuideMounted(true)
              setGuideOpen(true)
              if (guideMounted)
                requestAnimationFrame(() =>
                  window.dispatchEvent(new Event('workspace-open-first-run-guide')),
                )
            }}
          >
            <ProductReadinessCenter
              onAction={onReadinessAction}
              pageLayout
              onActiveTaskCountChange={setActiveTaskCount}
            />
            <details className="workspace-task-advanced">
              <summary>{t('Resource scheduling')}</summary>
              <div data-testid="resource-governor" className="workspace-resource-policy">
                <label>
                  {t('Resource mode')}
                  <select
                    data-testid="resource-governor-profile"
                    value={stats?.resource.profile ?? 'balanced'}
                    disabled={resourceBusy}
                    onChange={(event) => {
                      if (resourceBusyRef.current) return
                      const profile = event.target.value as UnifiedResourceProfile
                      resourceBusyRef.current = true
                      setResourceBusy(true)
                      ++statsVersion.current
                      void window.electronAPI.unifiedSearch
                        .setResourceProfile(profile)
                        .then((result) => {
                          if (!result.ok || !result.stats)
                            throw new Error('resource-profile-failed')
                          setStats(result.stats)
                          setTaskError('')
                        })
                        .catch(() => setTaskError(t('The operation failed.')))
                        .finally(() => {
                          resourceBusyRef.current = false
                          setResourceBusy(false)
                        })
                    }}
                  >
                    <option value="power-saver">{t('Power saver')}</option>
                    <option value="balanced">{t('Balanced')}</option>
                    <option value="quality">{t('High quality')}</option>
                  </select>
                </label>
                <p data-testid="resource-governor-limits">
                  {t('Local concurrency')}: {stats?.resource.effectiveLocalConcurrency ?? 0} ·{' '}
                  {t('GPU concurrency')}: {stats?.resource.effectiveGpuConcurrency ?? 0}
                </p>
                {stats?.resource.backgroundPaused && (
                  <p data-testid="resource-governor-pressure">
                    {t('Background work paused')}: {stats.resource.pressureReasons.join(', ')}
                  </p>
                )}
              </div>
              <p>
                {t('Local tasks')}: {stats?.lanes.local.running ?? 0} /{' '}
                {stats?.lanes.local.queued ?? 0}
              </p>
              <p>
                {t('AI tasks')}: {stats?.lanes.gpu.running ?? 0} / {stats?.lanes.gpu.queued ?? 0}
              </p>
              <button
                data-testid="resource-governor-cancel-background"
                onClick={() =>
                  void window.electronAPI.unifiedSearch
                    .cancelBackgroundTasks()
                    .then(() => setTaskError(''))
                    .catch(() => setTaskError(t('The operation failed.')))
                }
              >
                {t('Cancel queued background tasks')}
              </button>
              {taskError && <p role="alert">{taskError}</p>}
            </details>
          </WorkspaceTasksPage>
        </React.Suspense>
      )}
    </>
  )
}

export default WorkspaceNavigator
