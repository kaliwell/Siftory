import React from 'react'
import { useStore } from '../stores/useStore'
import { useTranslation } from '../i18n/useTranslation'
import { resolveWorkspaceRoute, type WorkspaceRoute } from '../services/workspaceRoutes'
import { openWorkspaceRoute } from '../services/openWorkspace'
import type { WorkspacePanel } from '../services/focusedWorkspace'
import WorkspaceIcon from './WorkspaceIcon'

const SEARCH_TABS: Array<{ route: WorkspaceRoute; label: string; icon: string }> = [
  { route: 'all-search', label: 'Combined search', icon: 'search' },
  { route: 'image-search', label: 'Images', icon: 'image' },
  { route: 'video-search', label: 'Video', icon: 'video' },
]
const SOURCE_TABS: typeof SEARCH_TABS = [
  { route: 'image-sources', label: 'Image sources', icon: 'image' },
  { route: 'video-sources', label: 'Video library', icon: 'video' },
]

export default function WorkspaceSectionTabs({ panel }: { panel: WorkspacePanel }) {
  const { t } = useTranslation()
  const imageView = useStore((s) => s.imageSearchUiPreferences.workspaceView)
  const videoView = useStore((s) => s.mediaSearchUiPreferences.workspaceView)
  const route = resolveWorkspaceRoute(panel, imageView, videoView)
  if (!route) return null
  const tabs = route.endsWith('sources') ? SOURCE_TABS : SEARCH_TABS
  return (
    <nav
      className="workspace-section-tabs"
      aria-label={t(route.endsWith('sources') ? 'Source type' : 'Search type')}
    >
      {tabs.map((tab) => (
        <button
          key={tab.route}
          data-testid={`workspace-tab-${tab.route}`}
          aria-current={route === tab.route ? 'page' : undefined}
          onClick={() => openWorkspaceRoute(tab.route)}
        >
          <WorkspaceIcon name={tab.icon} />
          {t(tab.label)}
        </button>
      ))}
    </nav>
  )
}
