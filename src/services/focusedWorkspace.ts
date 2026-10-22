import { PANEL_IDENTITIES, type PanelId, type PanelVisibilityKey } from '../../shared/ipc/app-core'

export const WORKSPACE_PANELS = [
  'unifiedSearch',
  'assetLibrary',
  'imageSearch',
  'mediaSearch',
  'appStorage',
  'settings',
  'duplicateFinder',
] as const satisfies readonly PanelId[]
export type WorkspacePanel = (typeof WORKSPACE_PANELS)[number]
export const RETIRED_PANELS = [
  'clock',
  'folders',
  'prompts',
  'calc',
  'remoteTerminal',
  'batchRename',
  'fm',
] as const satisfies readonly PanelId[]

type VisibilityState = Partial<Record<PanelVisibilityKey, boolean>> & {
  globalVisible?: boolean
  lockedVisibility?: Record<string, boolean>
}

/** Normalize old layouts and enforce one foreground view, including IPC-originated changes. */
export function focusedWorkspaceVisibility(
  current: VisibilityState,
  previous?: VisibilityState,
): Record<PanelVisibilityKey, boolean> {
  const visible = WORKSPACE_PANELS.filter((id) => current[PANEL_IDENTITIES[id].visibilityKey])
  const newlyOpened =
    previous && visible.find((id) => !previous[PANEL_IDENTITIES[id].visibilityKey])
  const active = newlyOpened || visible[0] || 'unifiedSearch'
  return Object.fromEntries(
    Object.values(PANEL_IDENTITIES).map(({ visibilityKey }) => [
      visibilityKey,
      (current.globalVisible !== false ||
        Boolean(
          current[PANEL_IDENTITIES[active].visibilityKey] && current.lockedVisibility?.[active],
        )) &&
        visibilityKey === PANEL_IDENTITIES[active].visibilityKey,
    ]),
  ) as Record<PanelVisibilityKey, boolean>
}
