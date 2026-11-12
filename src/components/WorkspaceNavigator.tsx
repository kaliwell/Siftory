import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PANEL_IDENTITIES } from '../../shared/ipc/app-core'
import { useTranslation } from '../i18n/useTranslation'
import { useStore } from '../stores/useStore'
import { nextRovingIndex } from '../services/productInformationArchitecture'
import { WORKSPACE_PANELS, type WorkspacePanel } from '../services/focusedWorkspace'
import WorkspaceIcon from './WorkspaceIcon'
import { openWorkspacePanel } from '../services/openWorkspace'
import { resolveWorkspaceRoute } from '../services/workspaceRoutes'
import '../styles/workspace-status.css'
import { version as appVersion } from '../../package.json'
import {
  flushSettingsWrites,
  getSettingsWriteStatus,
  subscribeSettingsWriteStatus,
} from '../hooks/settingsWriter'

export const WORKSPACE_DOMAINS = ['Search', 'Library', 'Sources', 'Settings'] as const
const WorkspaceNavigator: React.FC = () => {
  const { t } = useTranslation()
  const activePanel = useStore((state) =>
    WORKSPACE_PANELS.find((panel) => state[PANEL_IDENTITIES[panel].visibilityKey]),
  )
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
  const [alphaExpanded, setAlphaExpanded] = useState(false)
  useEffect(() => {
    const openModels = () => openWorkspacePanel('settings', 'workspace-open-model-settings')
    window.addEventListener('workspace-open-search-models', openModels)
    return () => window.removeEventListener('workspace-open-search-models', openModels)
  }, [])
  const navigate = (
    panel: WorkspacePanel,
    eventName?: string,
    imageView: 'sources' | 'search' = 'sources',
  ) => {
    if (panel === 'imageSearch')
      useStore.getState().setImageSearchUiPreferences({ workspaceView: imageView })
    if (panel === 'mediaSearch')
      useStore.getState().setMediaSearchUiPreferences({ workspaceView: 'sources' })
    openWorkspacePanel(panel, eventName)
  }
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
                (
                  entry.label === 'Search'
                    ? activeRoute?.endsWith('search')
                    : entry.label === 'Sources'
                      ? activeRoute?.endsWith('sources')
                      : activePanel === entry.panel
                )
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
            aria-current={activePanel === 'appStorage' ? 'page' : undefined}
            onClick={() => navigate('appStorage')}
          >
            <WorkspaceIcon name="database" />
            <span>{t('Index and maintenance')}</span>
          </button>
          <button
            data-testid="workspace-domain-settings"
            title={t('Settings')}
            aria-label={t('Settings')}
            aria-current={activePanel === 'settings' ? 'page' : undefined}
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
      </nav>
    </>
  )
}
export default WorkspaceNavigator
