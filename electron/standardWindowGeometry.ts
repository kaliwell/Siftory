import type { WorkspaceRect } from '../shared/ipc-contract'

/** Keep a conventional window inside one display without filling the desktop. */
export function standardWindowBounds(area: WorkspaceRect, current?: WorkspaceRect): WorkspaceRect {
  const width = Math.max(1, Math.min(current?.width ?? 1320, Math.max(1, area.width - 48)))
  const height = Math.max(1, Math.min(current?.height ?? 860, Math.max(1, area.height - 48)))
  return {
    x: Math.round(
      Math.max(
        area.x,
        Math.min(current?.x ?? area.x + (area.width - width) / 2, area.x + area.width - width),
      ),
    ),
    y: Math.round(
      Math.max(
        area.y,
        Math.min(current?.y ?? area.y + (area.height - height) / 2, area.y + area.height - height),
      ),
    ),
    width,
    height,
  }
}
