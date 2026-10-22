import type {
  DisplayScope,
  WorkspaceDisplay,
  WorkspaceRect,
  WorkspaceTopology,
} from '../shared/ipc-contract'
import { normalizeDisplayScope } from '../shared/workspaceDisplayPolicy'
export { normalizeDisplayScope } from '../shared/workspaceDisplayPolicy'

export interface DisplayLike {
  id: number | string
  bounds: WorkspaceRect
  workArea: WorkspaceRect
  scaleFactor: number
  rotation: number
  internal?: boolean
}

function unionRects(rects: WorkspaceRect[]): WorkspaceRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 1, height: 1 }
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

export function buildWorkspaceTopology(
  rawDisplays: DisplayLike[],
  primaryDisplayId: number | string,
  rawScope: unknown,
): WorkspaceTopology {
  const scope = normalizeDisplayScope(rawScope)
  const primaryId = String(primaryDisplayId)
  const displays: WorkspaceDisplay[] = rawDisplays.map((display) => ({
    id: String(display.id),
    bounds: { ...display.bounds },
    workArea: { ...display.workArea },
    scaleFactor: Number.isFinite(display.scaleFactor) ? display.scaleFactor : 1,
    rotation: Number.isFinite(display.rotation) ? display.rotation : 0,
    internal: display.internal === true,
    primary: String(display.id) === primaryId,
  }))
  const fallback = displays.find((display) => display.primary) ?? displays[0]
  const requested =
    scope.mode === 'display'
      ? displays.find((display) => display.id === scope.displayId)
      : scope.mode === 'primary'
        ? fallback
        : undefined
  const activeDisplays =
    scope.mode === 'all' ? displays : requested ? [requested] : fallback ? [fallback] : []
  let effectiveScope: DisplayScope = { mode: 'all' }
  if (scope.mode === 'primary' && requested) effectiveScope = { mode: 'primary' }
  if (scope.mode === 'display') {
    effectiveScope = requested ? { mode: 'display', displayId: requested.id } : { mode: 'primary' }
  }
  const bounds = unionRects(activeDisplays.map((display) => display.workArea))
  const localDisplays = activeDisplays.map((display) => ({
    ...display,
    localWorkArea: {
      x: display.workArea.x - bounds.x,
      y: display.workArea.y - bounds.y,
      width: display.workArea.width,
      height: display.workArea.height,
    },
  }))
  return {
    scope: effectiveScope,
    primaryDisplayId: fallback?.id ?? '',
    bounds,
    workArea: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      displays: localDisplays,
    },
    displays,
  }
}
