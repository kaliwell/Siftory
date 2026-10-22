import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type {
  ProductFirstRunGuideStepId,
  UnifiedResourceProfile,
  UnifiedSchedulerStats,
} from '../../shared/ipc-contract'
import { PANEL_IDENTITIES } from '../../shared/ipc/app-core'
import { useTranslation } from '../i18n/useTranslation'
import { useStore } from '../stores/useStore'
import { nextRovingIndex } from '../services/productInformationArchitecture'
import {
  focusedWorkspaceVisibility,
  WORKSPACE_PANELS,
  type WorkspacePanel,
} from '../services/focusedWorkspace'
import { requestWorkspaceNavigation } from '../services/workspaceNavigation'
import WorkspaceIcon from './WorkspaceIcon'
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
// Product marks retain the same spelling in every locale.
const BRAND = { mark: 'S', name: 'Siftory', localName: '寻藏' } as const

export function openWorkspacePanel(panel: WorkspacePanel, eventName?: string): void {
  const current = useStore.getState()
  const visibility = focusedWorkspaceVisibility(
    { ...current, [PANEL_IDENTITIES[panel].visibilityKey]: true },
    {
      ...current,
      [PANEL_IDENTITIES[panel].visibilityKey]: false,
    },
  )
  useStore.setState(visibility)
  requestWorkspaceNavigation(
    panel,
    eventName,
    () => useStore.getState()[PANEL_IDENTITIES[panel].visibilityKey],
  )
}

const WorkspaceNavigator: React.FC = () => {
  const { t } = useTranslation()
  const activePanel = useStore((state) =>
    WORKSPACE_PANELS.find((panel) => state[PANEL_IDENTITIES[panel].visibilityKey]),
  )
  const globalVisible = useStore((state) => state.globalVisible)
  const saveStatus = useSyncExternalStore(subscribeSettingsWriteStatus, getSettingsWriteStatus)
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const [tasksOpen, setTasksOpen] = useState(false)
  const [guideMounted, setGuideMounted] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
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

  const navigate = (panel: WorkspacePanel, eventName?: string) => {
    setTasksOpen(false)
    setGuideOpen(false)
    openWorkspacePanel(panel, eventName)
  }
  const onReadinessAction = (action: ProductReadinessAction) => {
    if (action === 'review-derived-reset') navigate('settings', 'workspace-review-derived-reset')
    else if (['add-source', 'scan-sources', 'reconnect-source'].includes(action))
      navigate('imageSearch', 'workspace-sources-focus')
    else if (['prepare-image-search', 'retry-image-index'].includes(action)) navigate('imageSearch')
    else navigate('mediaSearch')
  }
  const openFirstRunStep = (step: ProductFirstRunGuideStepId) => {
    if (step === 'source') navigate('imageSearch', 'workspace-sources-focus')
    else if (step === 'models') navigate('settings', 'workspace-open-model-settings')
    else if (step === 'catalog') navigate('imageSearch', 'workspace-prepare-library-focus')
    else navigate('unifiedSearch', 'workspace-first-search-focus')
  }
  const count = stats
    ? stats.lanes.local.running +
      stats.lanes.local.queued +
      stats.lanes.gpu.running +
      stats.lanes.gpu.queued
    : 0
  const entries = [
    { label: 'Search', panel: 'unifiedSearch', icon: 'search' },
    { label: 'Library', panel: 'assetLibrary', icon: 'library' },
    { label: 'Sources', panel: 'imageSearch', icon: 'folder' },
    { label: 'Video indexing', panel: 'mediaSearch', icon: 'video' },
    { label: 'Duplicate Finder', panel: 'duplicateFinder', icon: 'duplicate' },
  ] as const

  return (
    <nav
      className="workspace-sidebar"
      data-portal=""
      aria-label={t('Workspace')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setTasksOpen(false)
          setGuideOpen(false)
        }
      }}
    >
      <div className="workspace-sidebar__brand">
        <span className="workspace-brand-mark" aria-hidden="true">
          {BRAND.mark}
        </span>
        <div>
          <strong>
            {BRAND.name} <span>{BRAND.localName}</span>
          </strong>
          <small>{t('Your local media workspace')}</small>
        </div>
      </div>
      <span className="workspace-nav-label">{t('Workspace')}</span>
      <div className="workspace-sidebar__links" role="group" aria-label={t('Workspace')}>
        {entries.map((entry, index) => (
          <button
            key={entry.panel}
            ref={(element) => {
              refs.current[index] = element
            }}
            data-testid={`workspace-domain-${entry.label.toLowerCase().replaceAll(' ', '-')}`}
            aria-current={activePanel === entry.panel ? 'page' : undefined}
            onKeyDown={(event) => {
              const next = nextRovingIndex(index, entries.length, event.key)
              if (next !== null) {
                event.preventDefault()
                refs.current[next]?.focus()
              }
            }}
            onClick={() =>
              navigate(
                entry.panel,
                entry.panel === 'imageSearch' ? 'workspace-sources-focus' : undefined,
              )
            }
          >
            <WorkspaceIcon name={entry.icon} />
            {t(entry.label)}
          </button>
        ))}
      </div>
      <div className="workspace-sidebar__maintenance">
        <span className="workspace-nav-label">{t('Manage')}</span>
        <button
          aria-current={activePanel === 'appStorage' ? 'page' : undefined}
          onClick={() => navigate('appStorage')}
        >
          <WorkspaceIcon name="database" />
          {t('Index and maintenance')}
        </button>
        <button
          data-testid="workspace-domain-settings"
          aria-current={activePanel === 'settings' ? 'page' : undefined}
          onClick={() => navigate('settings')}
        >
          <WorkspaceIcon name="settings" />
          {t('Settings')}
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
        aria-expanded={tasksOpen}
        aria-controls="workspace-task-summary"
        onClick={() => {
          setGuideOpen(false)
          setTasksOpen(!tasksOpen)
        }}
      >
        <WorkspaceIcon name="tasks" />
        <span>{t('Tasks')}</span>
        <span className="workspace-task-count">{count}</span>
      </button>
      <div className="workspace-sidebar__footer">
        <span>
          <i />
          {t('Local workspace')}
        </span>
        <small>v{appVersion}</small>
      </div>
      {tasksOpen && (
        <section
          data-portal=""
          id="workspace-task-summary"
          data-testid="workspace-task-summary"
          className="workspace-task-drawer"
          aria-label={t('Tasks')}
        >
          <header>
            <strong>{t('Tasks')}</strong>
            <button onClick={() => setTasksOpen(false)}>{t('Close')}</button>
          </header>
          <button
            data-testid="workspace-first-run-guide"
            onClick={() => {
              setTasksOpen(false)
              setGuideMounted(true)
              setGuideOpen(true)
              if (guideMounted)
                requestAnimationFrame(() =>
                  window.dispatchEvent(new Event('workspace-open-first-run-guide')),
                )
            }}
          >
            {t('Getting started')}
          </button>
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
                      if (!result.ok || !result.stats) throw new Error('resource-profile-failed')
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
            {t('Local tasks')}: {stats?.lanes.local.running ?? 0} / {stats?.lanes.local.queued ?? 0}
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
          <ProductReadinessCenter onAction={onReadinessAction} />
        </section>
      )}
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
  )
}

export default WorkspaceNavigator
