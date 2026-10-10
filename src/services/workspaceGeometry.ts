import type { WorkspaceRect, WorkspaceWorkArea } from '../../shared/ipc-contract'

function distanceToRectSquared(x: number, y: number, rect: WorkspaceRect): number {
  const dx = x < rect.x ? rect.x - x : x > rect.x + rect.width ? x - rect.x - rect.width : 0
  const dy = y < rect.y ? rect.y - y : y > rect.y + rect.height ? y - rect.y - rect.height : 0
  return dx * dx + dy * dy
}

export function findPanelWorkArea(
  workArea: WorkspaceWorkArea,
  x: number,
  y: number,
  width: number,
  height: number,
): WorkspaceRect {
  const fallback = { x: 0, y: 0, width: workArea.width, height: workArea.height }
  const areas = workArea.displays?.map((display) => display.localWorkArea) ?? []
  if (areas.length === 0) return fallback
  const centerX = x + width / 2
  const centerY = y + height / 2
  return areas.reduce((best, area) =>
    distanceToRectSquared(centerX, centerY, area) < distanceToRectSquared(centerX, centerY, best)
      ? area
      : best,
  )
}

export function findWorkspaceAreaAtPoint(
  workArea: WorkspaceWorkArea,
  x: number,
  y: number,
): WorkspaceRect {
  const fallback = { x: 0, y: 0, width: workArea.width, height: workArea.height }
  const areas = workArea.displays?.map((display) => display.localWorkArea) ?? []
  if (areas.length === 0) return fallback
  return areas.reduce((best, area) =>
    distanceToRectSquared(x, y, area) < distanceToRectSquared(x, y, best) ? area : best,
  )
}

export function clampPanelToWorkspace(
  workArea: WorkspaceWorkArea,
  x: number,
  y: number,
  width: number,
  height: number,
  anchor?: { x: number; y: number },
): { x: number; y: number } {
  const area = anchor
    ? findWorkspaceAreaAtPoint(workArea, anchor.x, anchor.y)
    : findPanelWorkArea(workArea, x, y, width, height)
  return {
    x: Math.max(area.x, Math.min(x, area.x + Math.max(0, area.width - width))),
    y: Math.max(area.y, Math.min(y, area.y + Math.max(0, area.height - height))),
  }
}
