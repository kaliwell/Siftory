import React, { useRef, useCallback, useState, useEffect, useMemo } from 'react'
import { useStore } from '../stores/useStore'
import { PANEL_IDENTITIES, type PanelId } from '../../shared/ipc/app-core'
import { clampPanelToWorkspace, findPanelWorkArea } from '../services/workspaceGeometry'
import {
  bringPanelLayerToFront,
  type PanelLayerEntry,
  sendPanelLayerToBack,
  updatePanelLayerZIndices,
} from './panelLayerOrder'
import { useTranslation } from '../i18n/useTranslation'
import { useWindowAlwaysOnTop } from '../hooks/useWindowAlwaysOnTop'

const panelLayers: PanelLayerEntry[] = []
let activePanelInteractions = 0

function setPanelInteractionActive(active: boolean) {
  activePanelInteractions = Math.max(0, activePanelInteractions + (active ? 1 : -1))
  window.dispatchEvent(
    new CustomEvent('panel-interaction', {
      detail: { active: activePanelInteractions > 0 },
    }),
  )
}

function bringPanelToFront(id: symbol) {
  bringPanelLayerToFront(panelLayers, id)
}

function sendPanelToBack(id: symbol) {
  sendPanelLayerToBack(panelLayers, id)
}

function panelDomKey(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function workspacePoint(clientX: number, clientY: number) {
  const originX = Number(document.documentElement.dataset.overlayOriginX) || 0
  const originY = Number(document.documentElement.dataset.overlayOriginY) || 0
  return { x: clientX + originX, y: clientY + originY }
}

interface DraggablePanelProps {
  title: string
  displayTitle?: string
  x?: number
  y?: number
  w?: number
  h?: number
  defaultX: number
  defaultY: number
  defaultW: number
  defaultH: number
  minW?: number
  minH?: number
  onMove?: (x: number, y: number) => void
  onResize?: (w: number, h: number) => void
  locked?: boolean
  onToggleLock?: () => void
  visibilityLocked?: boolean
  onToggleVisibilityLock?: () => void
  panelId?: PanelId
  onClose?: () => void
  dataPanel?: string
  compositorDrag?: boolean
  children: React.ReactNode
}

const DraggablePanel: React.FC<DraggablePanelProps> = ({
  title,
  displayTitle,
  x: extX,
  y: extY,
  w: extW,
  h: extH,
  defaultX,
  defaultY,
  defaultW,
  defaultH,
  minW = 120,
  minH = 60,
  onMove,
  onResize,
  locked,
  onToggleLock,
  panelId,
  onClose,
  dataPanel,
  compositorDrag = false,
  children,
}) => {
  const { t } = useTranslation()
  const { alwaysOnTop: pinned, toggleAlwaysOnTop: togglePinned } = useWindowAlwaysOnTop()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const workArea = useStore((s) => s.workArea)
  const closePanel = useStore((s) => s.closePanel)
  const [maximized, setMaximized] = useState(false)
  const [localPos, setLocalPos] = useState({ x: defaultX, y: defaultY })
  const pos = extX !== undefined && extY !== undefined ? { x: extX, y: extY } : localPos
  const [localSize, setLocalSize] = useState({ w: defaultW, h: defaultH })
  const size = useMemo(
    () => (extW !== undefined && extH !== undefined ? { w: extW, h: extH } : localSize),
    [extH, extW, localSize],
  )
  const maximizedArea = useMemo(
    () => findPanelWorkArea(workArea, pos.x, pos.y, size.w, size.h),
    [pos.x, pos.y, size.h, size.w, workArea],
  )
  const renderedPos = maximized ? { x: maximizedArea.x, y: maximizedArea.y } : pos
  const renderedSize = maximized ? { w: maximizedArea.width, h: maximizedArea.height } : size
  const dragging = useRef(false)
  const resizing = useRef(false)
  const dragRaf = useRef(0)
  const resizeRaf = useRef(0)
  const offset = useRef({ x: 0, y: 0 })
  const pendingDragPos = useRef<{
    x: number
    y: number
    pointerX: number
    pointerY: number
  } | null>(null)
  const visualDragPos = useRef<{
    x: number
    y: number
    pointerX: number
    pointerY: number
  } | null>(null)
  const posRef = useRef(pos)
  posRef.current = pos // always reflect latest position, even mid-drag
  const layerId = useRef(Symbol(title))
  const [zIndex, setZIndex] = useState(10)
  const domId = dataPanel ?? (panelId ? PANEL_IDENTITIES[panelId].domId : panelDomKey(title))

  useEffect(() => {
    const entry = { id: layerId.current, setZ: setZIndex, pinned: false }
    panelLayers.push(entry)
    updatePanelLayerZIndices(panelLayers)
    const onFocusPanel = (event: Event) => {
      const detail = (event as CustomEvent<{ panel?: string }>).detail
      if (detail?.panel === domId) bringPanelToFront(layerId.current)
    }
    window.addEventListener('panel-focus-request', onFocusPanel)
    return () => {
      window.removeEventListener('panel-focus-request', onFocusPanel)
      const index = panelLayers.findIndex((item) => item.id === entry.id)
      if (index >= 0) panelLayers.splice(index, 1)
      updatePanelLayerZIndices(panelLayers)
    }
  }, [domId])

  const bringToFront = useCallback(() => {
    bringPanelToFront(layerId.current)
  }, [])
  const sendToBack = useCallback(() => {
    sendPanelToBack(layerId.current)
  }, [])
  const updatePos = useCallback(
    (x: number, y: number, anchor?: { x: number; y: number }) => {
      let px = x,
        py = y
      const s = useStore.getState()
      if (s.snapToGrid) {
        const g = s.gridSize
        px = Math.round(x / g) * g
        py = Math.round(y / g) * g
      }
      const clamped = clampPanelToWorkspace(s.workArea, px, py, size.w, size.h, anchor)
      px = clamped.x
      py = clamped.y
      if (onMove) {
        onMove(px, py)
      } else {
        setLocalPos({ x: px, y: py })
      }
    },
    [onMove, size.w, size.h],
  )

  // ── Cleanup listeners on unmount (prevent leaks during drag) ──
  const dragListeners = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null)
  const resizeListeners = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null)
  useEffect(
    () => () => {
      if (dragListeners.current) {
        window.removeEventListener('mousemove', dragListeners.current.move)
        window.removeEventListener('mouseup', dragListeners.current.up)
        window.removeEventListener('blur', dragListeners.current.up)
        window.removeEventListener(
          'window-visibility-cancel-interactions',
          dragListeners.current.up,
        )
        dragListeners.current = null
      }
      if (dragging.current) {
        dragging.current = false
        setPanelInteractionActive(false)
      }
      if (panelRef.current) {
        panelRef.current.style.transform = ''
        panelRef.current.style.willChange = ''
      }
      cancelAnimationFrame(dragRaf.current)
      if (resizeListeners.current) {
        window.removeEventListener('mousemove', resizeListeners.current.move)
        window.removeEventListener('mouseup', resizeListeners.current.up)
        window.removeEventListener('blur', resizeListeners.current.up)
        window.removeEventListener(
          'window-visibility-cancel-interactions',
          resizeListeners.current.up,
        )
        resizeListeners.current = null
      }
      if (resizing.current) {
        resizing.current = false
        setPanelInteractionActive(false)
      }
      cancelAnimationFrame(resizeRaf.current)
    },
    [],
  )

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      bringToFront()
      if (locked || maximized) return
      dragging.current = true
      setPanelInteractionActive(true)
      const pointer = workspacePoint(e.clientX, e.clientY)
      const dragOrigin = { ...posRef.current }
      offset.current = { x: pointer.x - posRef.current.x, y: pointer.y - posRef.current.y }
      const flushDragPos = () => {
        dragRaf.current = 0
        const next = pendingDragPos.current
        if (!next) return
        pendingDragPos.current = null
        if (!compositorDrag) {
          updatePos(next.x, next.y, { x: next.pointerX, y: next.pointerY })
          return
        }
        const s = useStore.getState()
        let x = next.x
        let y = next.y
        if (s.snapToGrid) {
          const grid = s.gridSize
          x = Math.round(x / grid) * grid
          y = Math.round(y / grid) * grid
        }
        const clamped = clampPanelToWorkspace(s.workArea, x, y, size.w, size.h, {
          x: next.pointerX,
          y: next.pointerY,
        })
        x = clamped.x
        y = clamped.y
        visualDragPos.current = {
          x,
          y,
          pointerX: next.pointerX,
          pointerY: next.pointerY,
        }
        const panel = panelRef.current
        if (panel) {
          panel.style.willChange = 'transform'
          panel.style.transform = `translate3d(${x - dragOrigin.x}px, ${y - dragOrigin.y}px, 0)`
        }
      }
      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return
        const nextPointer = workspacePoint(ev.clientX, ev.clientY)
        pendingDragPos.current = {
          x: nextPointer.x - offset.current.x,
          y: nextPointer.y - offset.current.y,
          pointerX: nextPointer.x,
          pointerY: nextPointer.y,
        }
        if (!dragRaf.current) {
          dragRaf.current = requestAnimationFrame(flushDragPos)
        }
      }
      const onUp = () => {
        if (dragRaf.current) {
          cancelAnimationFrame(dragRaf.current)
          dragRaf.current = 0
        }
        flushDragPos()
        if (compositorDrag && visualDragPos.current) {
          const finalPos = visualDragPos.current
          visualDragPos.current = null
          updatePos(finalPos.x, finalPos.y, {
            x: finalPos.pointerX,
            y: finalPos.pointerY,
          })
          const panel = panelRef.current
          if (panel) {
            panel.style.left = `${finalPos.x}px`
            panel.style.top = `${finalPos.y}px`
            panel.style.transform = ''
            panel.style.willChange = ''
          }
        }
        dragging.current = false
        setPanelInteractionActive(false)
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onUp)
        window.removeEventListener('blur', onUp)
        window.removeEventListener('window-visibility-cancel-interactions', onUp)
        dragListeners.current = null
      }
      dragListeners.current = { move: onMouseMove, up: onUp }
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onUp)
      window.addEventListener('blur', onUp)
      window.addEventListener('window-visibility-cancel-interactions', onUp)
    },
    [compositorDrag, locked, maximized, bringToFront, size.h, size.w, updatePos],
  )

  // Resize from bottom-right corner
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 })

  const pendingResize = useRef<{ w: number; h: number } | null>(null)

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      bringToFront()
      if (maximized) return
      resizing.current = true
      setPanelInteractionActive(true)
      const pointer = workspacePoint(e.clientX, e.clientY)
      resizeStart.current = { x: pointer.x, y: pointer.y, w: size.w, h: size.h }
      const onMouseMove = (ev: MouseEvent) => {
        if (!resizing.current) return
        const nextPointer = workspacePoint(ev.clientX, ev.clientY)
        let dw = Math.max(minW, resizeStart.current.w + (nextPointer.x - resizeStart.current.x))
        let dh = Math.max(minH, resizeStart.current.h + (nextPointer.y - resizeStart.current.y))
        const currentWorkArea = useStore.getState().workArea
        const displayArea = findPanelWorkArea(currentWorkArea, pos.x, pos.y, size.w, size.h)
        const maxW = displayArea.x + displayArea.width - pos.x
        const maxH = displayArea.y + displayArea.height - pos.y
        dw = Math.min(dw, maxW)
        dh = Math.min(dh, maxH)
        pendingResize.current = { w: dw, h: dh }
        if (resizeRaf.current) return
        resizeRaf.current = requestAnimationFrame(() => {
          resizeRaf.current = 0
          const sz = pendingResize.current
          if (!sz) return
          pendingResize.current = null
          const s = useStore.getState()
          let w = sz.w,
            h = sz.h
          if (s.snapToGrid) {
            const g = s.gridSize
            w = Math.round(w / g) * g
            h = Math.round(h / g) * g
          }
          setLocalSize({ w, h })
          onResize?.(w, h)
        })
      }
      const onUp = () => {
        resizing.current = false
        setPanelInteractionActive(false)
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onUp)
        window.removeEventListener('blur', onUp)
        window.removeEventListener('window-visibility-cancel-interactions', onUp)
        resizeListeners.current = null
      }
      resizeListeners.current = { move: onMouseMove, up: onUp }
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onUp)
      window.addEventListener('blur', onUp)
      window.addEventListener('window-visibility-cancel-interactions', onUp)
    },
    [size, minW, minH, onResize, pos.x, pos.y, bringToFront, maximized],
  )

  const toggleMaximized = useCallback(() => {
    bringToFront()
    setMaximized((value) => !value)
  }, [bringToFront])

  const closeCurrentPanel = useCallback(() => {
    setMaximized(false)
    if (onClose) {
      onClose()
      return
    }
    if (panelId) closePanel(panelId)
  }, [closePanel, onClose, panelId])

  return (
    <div
      ref={panelRef}
      className={`panel ${maximized ? 'is-maximized' : ''}`}
      data-panel={domId}
      onMouseDownCapture={bringToFront}
      style={{
        left: renderedPos.x,
        top: renderedPos.y,
        width: renderedSize.w,
        height: renderedSize.h,
        zIndex,
      }}
    >
      <div className="panel-header" onMouseDown={onMouseDown}>
        <span className="panel-title">{displayTitle ?? t(title)}</span>
        <span className="panel-header-line" />
        <button
          className="panel-control panel-control-back"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            sendToBack()
          }}
          style={{
            fontSize: 10,
            padding: '0 4px',
            lineHeight: 1,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'inherit',
            borderRadius: 2,
            marginRight: 2,
            opacity: 0.65,
          }}
          title={t('Send panel behind other panels')}
          aria-label={t('Send panel behind other panels')}
        >
          ▽
        </button>
        <button
          className={`panel-control panel-control-pin ${pinned ? 'is-active' : ''}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            togglePinned()
          }}
          style={{
            fontSize: 10,
            padding: '0 4px',
            lineHeight: 1,
            background: pinned ? 'rgba(100,200,255,0.25)' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'inherit',
            borderRadius: 2,
            marginRight: 2,
          }}
          title={t(pinned ? 'Stop keeping window on top' : 'Keep window on top')}
          aria-label={t(pinned ? 'Stop keeping window on top' : 'Keep window on top')}
          aria-pressed={pinned}
        >
          {pinned ? '📌' : '📍'}
        </button>
        {onToggleLock && (
          <button
            className={`panel-control panel-control-position ${locked ? 'is-active' : ''}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onToggleLock()
            }}
            style={{
              fontSize: 10,
              padding: '0 4px',
              lineHeight: 1,
              background: locked ? 'rgba(255,200,50,0.25)' : 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'inherit',
              borderRadius: 2,
            }}
            title={t(
              locked
                ? 'Unlock position (allow drag/arrange)'
                : 'Lock position (prevent drag/arrange)',
            )}
            aria-label={t(
              locked
                ? 'Unlock position (allow drag/arrange)'
                : 'Lock position (prevent drag/arrange)',
            )}
          >
            {locked ? '🔒' : '🔓'}
          </button>
        )}
        <button
          className="panel-control panel-control-move"
          onMouseDown={(e) => {
            e.stopPropagation()
            onMouseDown(e)
          }}
          disabled={locked || maximized}
          title={t('Drag to move panel')}
          aria-label={t('Drag to move panel')}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M7 1v12M1 7h12M7 1 5 3M7 1l2 2M7 13l-2-2M7 13l2-2M1 7l2-2M1 7l2 2M13 7l-2-2M13 7l-2 2" />
          </svg>
        </button>
        <button
          className={`panel-control panel-control-maximize ${maximized ? 'is-active' : ''}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            toggleMaximized()
          }}
          title={t(maximized ? 'Restore panel' : 'Maximize panel')}
          aria-label={t(maximized ? 'Restore panel' : 'Maximize panel')}
          aria-pressed={maximized}
        >
          <span
            className={`panel-control-icon ${
              maximized ? 'panel-control-icon-restore' : 'panel-control-icon-maximize'
            }`}
            aria-hidden="true"
          />
        </button>
        {(onClose || panelId) && (
          <button
            className="panel-control panel-control-close"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              closeCurrentPanel()
            }}
            title={t('Close panel')}
            aria-label={t('Close panel')}
          >
            <span className="panel-control-icon panel-control-icon-close" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="panel-body">{children}</div>
      {/* Resize handle */}
      {!maximized && (
        <div
          className="panel-resize-handle"
          onMouseDown={onResizeStart}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 14,
            height: 14,
            cursor: 'nwse-resize',
            background: 'transparent',
          }}
        />
      )}
    </div>
  )
}

export default DraggablePanel
