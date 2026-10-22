import type { PanelId } from '../../shared/ipc/app-core'

type Navigation = { panel: PanelId; event: string; isActive: () => boolean }
const mounted = new Set<PanelId>()
let pending: Navigation | undefined
let frame = 0

function dispatchWhenReady(): void {
  if (frame) cancelAnimationFrame(frame)
  const request = pending
  if (!request || !mounted.has(request.panel)) return
  // Child/parent passive effects must both finish registering their listeners.
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      frame = 0
      if (pending !== request) return
      pending = undefined
      if (!mounted.has(request.panel) || !request.isActive()) return
      window.dispatchEvent(new Event(request.event))
    })
  })
}

/** Queue an intent until its lazy content actually mounts; a newer route supersedes it. */
export function requestWorkspaceNavigation(
  panel: PanelId,
  event: string | undefined,
  isActive: () => boolean,
): void {
  pending = event ? { panel, event, isActive } : undefined
  dispatchWhenReady()
}

export function registerWorkspacePanel(panel: PanelId): () => void {
  mounted.add(panel)
  dispatchWhenReady()
  return () => {
    mounted.delete(panel)
    if (pending?.panel === panel && frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
  }
}
