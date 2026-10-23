import { PANEL_IDENTITIES } from '../../shared/ipc/app-core'
import { useStore } from '../stores/useStore'
import { focusedWorkspaceVisibility, type WorkspacePanel } from './focusedWorkspace'
import { requestWorkspaceNavigation } from './workspaceNavigation'
import { WORKSPACE_ROUTES, type WorkspaceRoute } from './workspaceRoutes'

export function openWorkspacePanel(panel: WorkspacePanel, eventName?: string): void {
  const current = useStore.getState()
  useStore.setState(
    focusedWorkspaceVisibility(
      { ...current, [PANEL_IDENTITIES[panel].visibilityKey]: true },
      { ...current, [PANEL_IDENTITIES[panel].visibilityKey]: false },
    ),
  )
  requestWorkspaceNavigation(
    panel,
    eventName,
    () => useStore.getState()[PANEL_IDENTITIES[panel].visibilityKey],
  )
}

export function openWorkspaceRoute(route: WorkspaceRoute, eventName?: string): void {
  const { panel, view } = WORKSPACE_ROUTES[route]
  if (panel === 'imageSearch')
    useStore.getState().setImageSearchUiPreferences({ workspaceView: view })
  if (panel === 'mediaSearch')
    useStore.getState().setMediaSearchUiPreferences({ workspaceView: view })
  openWorkspacePanel(panel, eventName)
}
