import { useEffect } from 'react'
import type { WindowVisibilityEvent } from '../../shared/ipc-contract'

function visibilityGeneration(): number {
  const generation = Number(document.documentElement.dataset.windowVisibilityGeneration)
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0
}

function isInteractiveElementAt(x: number, y: number): boolean {
  const element = document.elementFromPoint(x, y)
  return Boolean(
    element && (element.closest('.panel') !== null || element.closest('[data-portal]') !== null),
  )
}

/** Keeps desktop click-through synchronized with the current native visibility generation. */
export function useMouseTransparency(): void {
  useEffect(() => {
    let raf = 0
    let retryTimer = 0
    let retryDelayMs = 40
    let appliedInteractive = false
    let desiredInteractive = false
    let inflight = false
    let disposed = false
    let interactionActive = false
    let windowInteractive = true
    let pointer = { x: 0, y: 0 }

    const flush = async (): Promise<void> => {
      if (disposed || inflight || desiredInteractive === appliedInteractive) return
      const next = desiredInteractive
      const generation = visibilityGeneration()
      inflight = true
      try {
        await window.electronAPI.setIgnoreMouseEvents(!next, generation)
        // A retired request may resolve after recovery released native hit
        // testing. Do not let that ACK suppress the new generation's request.
        if (disposed) return
        appliedInteractive = generation === visibilityGeneration() ? next : false
        retryDelayMs = 40
      } catch {
        if (!disposed && !retryTimer) {
          retryTimer = window.setTimeout(() => {
            retryTimer = 0
            void flush()
          }, retryDelayMs)
          retryDelayMs = Math.min(400, retryDelayMs * 2)
        }
      } finally {
        inflight = false
      }
      if (!disposed && desiredInteractive !== appliedInteractive && !retryTimer) void flush()
    }

    const requestInteractive = (interactive: boolean) => {
      desiredInteractive = windowInteractive && interactive
      if (desiredInteractive !== appliedInteractive) void flush()
    }

    const evaluatePointer = () => {
      requestInteractive(interactionActive || isInteractiveElementAt(pointer.x, pointer.y))
    }

    const check = (event: MouseEvent) => {
      pointer = { x: event.clientX, y: event.clientY }
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        evaluatePointer()
      })
    }

    const onPanelInteraction = (event: Event) => {
      interactionActive = Boolean((event as CustomEvent<{ active?: boolean }>).detail?.active)
      evaluatePointer()
    }

    const onWindowVisibility = (event: Event) => {
      const detail = (event as CustomEvent<WindowVisibilityEvent>).detail
      if (!detail) return
      windowInteractive = detail.state === 'visible'
      if (!windowInteractive) interactionActive = false
      evaluatePointer()
    }

    const onWindowBlur = () => {
      interactionActive = false
      requestInteractive(false)
    }

    document.addEventListener('mousemove', check, { passive: true })
    window.addEventListener('panel-interaction', onPanelInteraction)
    window.addEventListener('window-visibility-state', onWindowVisibility)
    window.addEventListener('blur', onWindowBlur)

    return () => {
      disposed = true
      document.removeEventListener('mousemove', check)
      window.removeEventListener('panel-interaction', onPanelInteraction)
      window.removeEventListener('window-visibility-state', onWindowVisibility)
      window.removeEventListener('blur', onWindowBlur)
      window.clearTimeout(retryTimer)
      cancelAnimationFrame(raf)
      void window.electronAPI
        .setIgnoreMouseEvents(true, visibilityGeneration())
        .catch(() => undefined)
    }
  }, [])
}
