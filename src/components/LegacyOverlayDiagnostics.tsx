// Loaded only by the explicit legacy overlay diagnostic launch flag.
// Normal desktop windows never mount this compatibility component.
import { useEffect, useState, type MutableRefObject } from 'react'
import { useStore } from '../stores/useStore'
import { useMouseTransparency } from '../hooks/useMouseTransparency'
import type { WindowVisibilityEvent } from '../../shared/ipc-contract'
type OverlayRect = { x: number; y: number; width: number; height: number }
export default function LegacyOverlayDiagnostics({
  visibilityGenerationRef,
}: {
  visibilityGenerationRef: MutableRefObject<number>
}) {
  const [overlayOrigin, setOverlayOrigin] = useState({ x: 0, y: 0 })
  const workArea = useStore((s) => s.workArea)
  useMouseTransparency()
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="app-root"]')
    if (!root) return
    Object.assign(root.style, {
      position: 'absolute',
      left: -overlayOrigin.x + 'px',
      top: -overlayOrigin.y + 'px',
      width: workArea.width + 'px',
      height: workArea.height + 'px',
      overflow: 'clip',
    })
    return () => {
      for (const key of ['position', 'left', 'top', 'width', 'height', 'overflow'])
        root.style.removeProperty(key)
    }
  }, [overlayOrigin, workArea])
  useEffect(() => {
    let lastShape = ''
    let interactionActive = false
    let shapeUpdatesEnabled = true
    let shapeRaf = 0
    let shapeSettleTimer = 0
    let cancelVisibilityTurn1: (() => void) | null = null
    let cancelVisibilityTurn2: (() => void) | null = null
    let cancelVisibilityPaintTurn1: (() => void) | null = null
    let cancelVisibilityPaintTurn2: (() => void) | null = null
    let forceShapeSync = false
    let shapeRequest = 0
    let shapeDisposed = false
    let visibilityRetryTimer = 0
    let successfulShapeRevision = 0
    let stalledVisibilityRetry: {
      generation: number
      phase: 'layout' | 'paint'
      retry: () => void
    } | null = null
    let committedVisibilityGeneration: number | null = null
    let periodicPaintRetryEligible = false
    let currentOrigin = { x: 0, y: 0 }
    const updateOrigin = (viewport: { x: number; y: number }) => {
      if (viewport.x === currentOrigin.x && viewport.y === currentOrigin.y) return
      currentOrigin = { x: viewport.x, y: viewport.y }
      document.documentElement.dataset.overlayOriginX = String(viewport.x)
      document.documentElement.dataset.overlayOriginY = String(viewport.y)
      setOverlayOrigin(currentOrigin)
    }
    const applyWorkspaceShape = async (rects: OverlayRect[]) => {
      if (shapeDisposed) return false
      const generation = visibilityGenerationRef.current
      const request = ++shapeRequest
      const viewport = await window.electronAPI.setOverlayShape(rects, generation)
      if (
        !shapeDisposed &&
        request === shapeRequest &&
        generation === visibilityGenerationRef.current
      ) {
        updateOrigin(viewport)
        successfulShapeRevision++
        return true
      }
      return false
    }
    const measureWorkspaceShape = () => {
      const elements = document.querySelectorAll<HTMLElement>('.panel, [data-portal]')
      const padding = interactionActive ? 24 : 14
      return Array.from(elements)
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            x: Math.max(0, Math.floor(rect.left) - padding),
            y: Math.max(0, Math.floor(rect.top) - padding),
            width: Math.ceil(rect.width) + padding * 2,
            height: Math.ceil(rect.height) + padding * 2,
          }
        })
        .filter((rect) => rect.width > 4 && rect.height > 4)
        .map((rect) => ({
          ...rect,
          x: rect.x + currentOrigin.x,
          y: rect.y + currentOrigin.y,
        }))
    }
    const syncShape = async (force = false) => {
      if (shapeDisposed || (!shapeUpdatesEnabled && !force)) return false
      if (interactionActive && !force) return false
      const generation = visibilityGenerationRef.current
      const workspaceRects = measureWorkspaceShape()
      try {
        if (workspaceRects.length === 0) {
          if (lastShape !== '[]') {
            lastShape = '[]'
            await applyWorkspaceShape([])
          }
          return false
        }
        const nextShape = JSON.stringify(workspaceRects)
        if (nextShape === lastShape) return true
        lastShape = nextShape
        return await applyWorkspaceShape(workspaceRects)
      } catch {
        if (generation === visibilityGenerationRef.current) lastShape = ''
        return false
      }
    }
    const scheduleShapeSync = (force = false) => {
      forceShapeSync ||= force
      if (shapeRaf) return
      shapeRaf = requestAnimationFrame(() => {
        shapeRaf = 0
        const shouldForce = forceShapeSync
        forceShapeSync = false
        if (shouldForce) lastShape = ''
        const beforeShape = successfulShapeRevision
        const mayRetryPaint = periodicPaintRetryEligible
        periodicPaintRetryEligible = false
        void syncShape(shouldForce).then((ready) => {
          if (
            ready &&
            !shapeDisposed &&
            (successfulShapeRevision > beforeShape ||
              (mayRetryPaint && stalledVisibilityRetry?.phase === 'paint')) &&
            stalledVisibilityRetry?.generation === visibilityGenerationRef.current
          ) {
            // Layout recovery requires a newly successful native Shape. A
            // stalled paint ACK can retry once on this existing observer tick,
            // even when the already validated geometry has not changed.
            const retry = stalledVisibilityRetry.retry
            stalledVisibilityRetry = null
            retry()
          }
        })
      })
    }
    const scheduleSettledShapeSync = (force = false) => {
      forceShapeSync ||= force
      window.clearTimeout(shapeSettleTimer)
      shapeSettleTimer = window.setTimeout(
        () => {
          shapeSettleTimer = 0
          scheduleShapeSync()
        },
        lastShape ? 80 : 300,
      )
    }
    const observedPanels = new WeakSet<Element>()
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => scheduleSettledShapeSync())
    const observePanels = () => {
      if (!resizeObserver) return
      document.querySelectorAll<HTMLElement>('.panel, [data-portal]').forEach((element) => {
        if (observedPanels.has(element)) return
        observedPanels.add(element)
        resizeObserver.observe(element)
      })
    }
    const mutationContainsShapeElement = (mutation: MutationRecord) => {
      if (mutation.type === 'attributes') {
        return (mutation.target as Element).matches?.('.panel, [data-portal]') ?? false
      }
      return [...mutation.addedNodes, ...mutation.removedNodes].some(
        (node) =>
          node instanceof Element &&
          (node.matches('.panel, [data-portal]') ||
            Boolean(node.querySelector('.panel, [data-portal]'))),
      )
    }
    const mutationObserver = new MutationObserver((mutations) => {
      // Dragging changes the inline transform every animation frame. The native
      // shape already covers the full work area during an interaction, so DOM
      // measurement and shape IPC here only create a needless compositor queue.
      if (interactionActive || !mutations.some(mutationContainsShapeElement)) return
      observePanels()
      scheduleSettledShapeSync()
    })
    const onPanelInteraction = (event: Event) => {
      interactionActive = !!(event as CustomEvent<{ active: boolean }>).detail?.active
      if (interactionActive) {
        window.clearTimeout(shapeSettleTimer)
        shapeSettleTimer = 0
        window.cancelAnimationFrame(shapeRaf)
        shapeRaf = 0
        forceShapeSync = false
        document.documentElement.dataset.panelInteraction = 'active'
        lastShape = ''
        const workArea = useStore.getState().workArea
        void applyWorkspaceShape([{ x: 0, y: 0, width: workArea.width, height: workArea.height }])
      } else {
        delete document.documentElement.dataset.panelInteraction
        observePanels()
        scheduleSettledShapeSync(true)
      }
    }
    const onPanelVisibilityChanged = () => {
      observePanels()
      scheduleSettledShapeSync(true)
    }
    const scheduleVisibilityLayoutTurn = (callback: () => void): (() => void) => {
      const channel = new MessageChannel()
      let active = true
      let raf = 0
      const finish = () => {
        if (!active) return
        active = false
        window.cancelAnimationFrame(raf)
        channel.port1.onmessage = null
        channel.port1.close()
        channel.port2.close()
        document.body.getBoundingClientRect()
        callback()
      }
      channel.port1.onmessage = finish
      channel.port2.postMessage(undefined)
      raf = window.requestAnimationFrame(finish)
      return () => {
        active = false
        window.cancelAnimationFrame(raf)
        channel.port1.onmessage = null
        channel.port1.close()
        channel.port2.close()
      }
    }
    const scheduleVisibilityPaintTurn = (callback: () => void): (() => void) => {
      let active = true
      let raf = 0
      let timeout = 0
      const finish = () => {
        if (!active) return
        active = false
        window.clearTimeout(timeout)
        window.cancelAnimationFrame(raf)
        document.body.getBoundingClientRect()
        callback()
      }
      raf = window.requestAnimationFrame(finish)
      timeout = window.setTimeout(finish, 120)
      return () => {
        active = false
        window.clearTimeout(timeout)
        window.cancelAnimationFrame(raf)
      }
    }
    const retryVisibility = (
      generation: number,
      attempt: number,
      retry: (attempt: number) => void,
      phase: 'layout' | 'paint' = 'layout',
    ) => {
      if (
        shapeDisposed ||
        visibilityGenerationRef.current !== generation ||
        committedVisibilityGeneration === generation
      )
        return
      if (attempt >= 3) {
        stalledVisibilityRetry = {
          generation,
          phase,
          retry: () => retry(phase === 'paint' ? 3 : 0),
        }
        return
      }
      window.clearTimeout(visibilityRetryTimer)
      visibilityRetryTimer = window.setTimeout(
        () => {
          visibilityRetryTimer = 0
          if (
            !shapeDisposed &&
            visibilityGenerationRef.current === generation &&
            committedVisibilityGeneration !== generation
          )
            retry(attempt + 1)
        },
        80 * (attempt + 1),
      )
    }
    const onWindowVisibilityPrepareShow = (event: Event) => {
      const detail = (
        event as CustomEvent<{ generation?: number; reason?: WindowVisibilityEvent['reason'] }>
      ).detail
      const generation = Number(detail?.generation)
      if (!Number.isSafeInteger(generation) || generation < 0) return
      cancelVisibilityTurn1?.()
      cancelVisibilityTurn2?.()
      shapeUpdatesEnabled = true
      const prepare = (attempt = 0) => {
        cancelVisibilityTurn1 = scheduleVisibilityLayoutTurn(() => {
          cancelVisibilityTurn1 = null
          if (shapeDisposed || visibilityGenerationRef.current !== generation) return
          cancelVisibilityTurn2 = scheduleVisibilityLayoutTurn(() => {
            cancelVisibilityTurn2 = null
            if (shapeDisposed || visibilityGenerationRef.current !== generation) return
            lastShape = ''
            void syncShape(true)
              .then(async (ready) => {
                if (!ready || shapeDisposed || visibilityGenerationRef.current !== generation)
                  return false
                return window.electronAPI.showWindow(generation)
              })
              .then((shown) => {
                if (!shown) retryVisibility(generation, attempt, prepare)
              })
              .catch(() => retryVisibility(generation, attempt, prepare))
          })
        })
      }
      prepare()
    }
    const onWindowVisibilityNativePrewarmed = (event: Event) => {
      const detail = (event as CustomEvent<WindowVisibilityEvent>).detail
      const generation = Number(detail?.generation)
      if (
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        shapeDisposed ||
        visibilityGenerationRef.current !== generation
      )
        return
      if (committedVisibilityGeneration === generation) return
      if (detail.state === 'visible') {
        window.dispatchEvent(new CustomEvent('window-visibility-state', { detail }))
        return
      }
      cancelVisibilityPaintTurn1?.()
      cancelVisibilityPaintTurn2?.()
      const paint = (attempt = 0) => {
        cancelVisibilityPaintTurn1 = scheduleVisibilityPaintTurn(() => {
          cancelVisibilityPaintTurn1 = null
          if (shapeDisposed || visibilityGenerationRef.current !== generation) return
          cancelVisibilityPaintTurn2 = scheduleVisibilityPaintTurn(() => {
            cancelVisibilityPaintTurn2 = null
            if (shapeDisposed || visibilityGenerationRef.current !== generation) return
            void window.electronAPI
              .revealWindow(generation)
              .then((revealed) => {
                if (
                  shapeDisposed ||
                  visibilityGenerationRef.current !== generation ||
                  committedVisibilityGeneration === generation
                )
                  return
                if (!revealed) {
                  retryVisibility(generation, attempt, paint, 'paint')
                  return
                }
                window.dispatchEvent(
                  new CustomEvent('window-visibility-state', {
                    detail: { generation, state: 'visible', reason: detail.reason },
                  }),
                )
              })
              .catch(() => retryVisibility(generation, attempt, paint, 'paint'))
          })
        })
      }
      paint()
    }
    const onWindowVisibilityState = (event: Event) => {
      const detail = (event as CustomEvent<WindowVisibilityEvent>).detail
      const state = detail?.state
      shapeUpdatesEnabled = state === 'visible' || state === 'preparing-show'
      committedVisibilityGeneration = state === 'visible' ? detail.generation : null
      periodicPaintRetryEligible = false
      stalledVisibilityRetry = null
      window.clearTimeout(visibilityRetryTimer)
      visibilityRetryTimer = 0
      cancelVisibilityTurn1?.()
      cancelVisibilityTurn1 = null
      cancelVisibilityTurn2?.()
      cancelVisibilityTurn2 = null
      cancelVisibilityPaintTurn1?.()
      cancelVisibilityPaintTurn1 = null
      cancelVisibilityPaintTurn2?.()
      cancelVisibilityPaintTurn2 = null
      if (state !== 'visible') {
        shapeRequest++
        window.cancelAnimationFrame(shapeRaf)
        shapeRaf = 0
        window.clearTimeout(shapeSettleTimer)
        shapeSettleTimer = 0
        forceShapeSync = false
        lastShape = ''
      }
    }
    const onViewportChanged = () => scheduleSettledShapeSync(true)
    window.addEventListener('panel-interaction', onPanelInteraction)
    window.addEventListener('panel-visibility-changed', onPanelVisibilityChanged)
    window.addEventListener('window-visibility-prepare-show', onWindowVisibilityPrepareShow)
    window.addEventListener('window-visibility-native-prewarmed', onWindowVisibilityNativePrewarmed)
    window.addEventListener('window-visibility-state', onWindowVisibilityState)
    window.addEventListener('resize', onViewportChanged)
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    })
    observePanels()
    scheduleSettledShapeSync(true)
    const timer = window.setInterval(() => {
      periodicPaintRetryEligible = true
      scheduleSettledShapeSync()
    }, 1500)
    return () => {
      shapeDisposed = true
      stalledVisibilityRetry = null
      window.clearTimeout(visibilityRetryTimer)
      window.clearInterval(timer)
      window.clearTimeout(shapeSettleTimer)
      window.cancelAnimationFrame(shapeRaf)
      cancelVisibilityTurn1?.()
      cancelVisibilityTurn2?.()
      cancelVisibilityPaintTurn1?.()
      cancelVisibilityPaintTurn2?.()
      resizeObserver?.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('panel-interaction', onPanelInteraction)
      window.removeEventListener('panel-visibility-changed', onPanelVisibilityChanged)
      window.removeEventListener('window-visibility-prepare-show', onWindowVisibilityPrepareShow)
      window.removeEventListener(
        'window-visibility-native-prewarmed',
        onWindowVisibilityNativePrewarmed,
      )
      window.removeEventListener('window-visibility-state', onWindowVisibilityState)
      window.removeEventListener('resize', onViewportChanged)
      delete document.documentElement.dataset.overlayOriginX
      delete document.documentElement.dataset.overlayOriginY
      delete document.documentElement.dataset.panelInteraction
      delete document.documentElement.dataset.windowVisibilityGeneration
    }
  }, [visibilityGenerationRef])
  return null
}
