import { useRef, useEffect, useCallback } from 'react'
import { useStore } from '../stores/useStore'
import { PANEL_IDENTITIES, PANEL_IDS, type PanelId } from '../../shared/ipc/app-core'

type StoreState = ReturnType<typeof useStore.getState>
type PanelPoint = { x: number; y: number }
type PanelSize = { w: number; h: number }

export function useLinkedMove(
  panel: PanelId,
  pos: { x: number; y: number },
  setPos: (x: number, y: number) => void,
  linkedMove: boolean,
): (x: number, y: number) => void {
  const rafRef = useRef(0)
  const pendingRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  // All state is read from useStore.getState() inside the rAF callback,
  // so no closure deps are needed — the callback is stable for the component lifetime.
  const linkedMoveFn = useCallback(
    (targetX: number, targetY: number) => {
      pendingRef.current = { x: targetX, y: targetY }
      if (rafRef.current) return

      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        const target = pendingRef.current
        pendingRef.current = null
        if (!target) return

        const s = useStore.getState()
        const state = s as unknown as Record<string, unknown>
        const winW = s.workArea.width > 0 ? s.workArea.width : window.innerWidth
        const winH = s.workArea.height > 0 ? s.workArea.height : window.innerHeight

        // Direct delta from dragged panel's current position to target
        const curDragged = state[PANEL_IDENTITIES[panel].positionKey] as PanelPoint
        let dx = target.x - curDragged.x
        let dy = target.y - curDragged.y
        if (dx === 0 && dy === 0) return

        // Compute current group bounds (only visible panels)
        let curMinX = Infinity,
          curMaxX = -Infinity
        let curMinY = Infinity,
          curMaxY = -Infinity
        let anyVisible = false
        for (const pn of PANEL_IDS) {
          const identity = PANEL_IDENTITIES[pn]
          if (!state[identity.visibilityKey] || s.lockedPanels[pn]) continue
          anyVisible = true
          const c = state[identity.positionKey] as PanelPoint
          const sz = state[identity.sizeKey] as PanelSize
          curMinX = Math.min(curMinX, c.x)
          curMaxX = Math.max(curMaxX, c.x + sz.w)
          curMinY = Math.min(curMinY, c.y)
          curMaxY = Math.max(curMaxY, c.y + sz.h)
        }
        if (!anyVisible) return

        // Clamp dx/dy to keep entire group within window
        const maxDx = winW - curMaxX // how far right we can go
        const minDx = -curMinX // how far left we can go (negative)
        const maxDy = winH - curMaxY
        const minDy = -curMinY

        dx = Math.max(minDx, Math.min(dx, maxDx))
        dy = Math.max(minDy, Math.min(dy, maxDy))

        if (dx === 0 && dy === 0) return

        // Apply to visible panels only (skip locked)
        const updates: Partial<StoreState> = {}
        for (const pn of PANEL_IDS) {
          const identity = PANEL_IDENTITIES[pn]
          if (!state[identity.visibilityKey] || s.lockedPanels[pn]) continue
          const cur = state[identity.positionKey] as PanelPoint
          ;(updates as Record<string, PanelPoint>)[identity.positionKey] = {
            x: cur.x + dx,
            y: cur.y + dy,
          }
        }
        useStore.setState(updates)
      })
    },
    [panel],
  )

  const singleMoveFn = useCallback(
    (x: number, y: number) => {
      pendingRef.current = { x, y }
      if (rafRef.current) return

      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        const p = pendingRef.current
        if (!p) return
        pendingRef.current = null
        setPos(p.x, p.y)
      })
    },
    [setPos],
  )

  return linkedMove ? linkedMoveFn : singleMoveFn
}
