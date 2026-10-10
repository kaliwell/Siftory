import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useStore } from '../../stores/useStore'
import { useFMStore } from '../../stores/useFMStore'
import DraggablePanel from '../DraggablePanel'
import QuickAccess from './QuickAccess'
import FilePane from './FilePane'
import ProgressDialog from './ProgressDialog'
import ConfirmDialog from './ConfirmDialog'
import { useFileOperations } from '../../hooks/useFileOperations'
import { useLinkedMove } from '../../hooks/useLinkedMove'
import type { GroupMode, PaneLayout, SortState, ViewMode } from './types'
import { LAYOUT_LABELS, LAYOUT_PANE_COUNT } from './types'
import { DEFAULT_FM_W, DEFAULT_FM_H } from '../../types'
import { useTranslation } from '../../i18n/useTranslation'

const FONT_SCALES = [0.75, 0.9, 1.0, 1.15, 1.35]

const FileManagerPanel: React.FC = () => {
  const { t } = useTranslation()
  // ── Store (minimal subscriptions) ──────────────
  const fmPos = useStore((s) => s.fmPos)
  const setFMPos = useStore((s) => s.setFMPos)
  const fmSize = useStore((s) => s.fmSize)
  const setFMSize = useStore((s) => s.setFMSize)
  const linkedMove = useStore((s) => s.linkedMove)
  const locked = useStore((s) => s.lockedPanels['fm'] ?? false)
  const visibilityLocked = useStore((s) => s.lockedVisibility['fm'] ?? false)
  const togglePanelLocked = useStore((s) => s.togglePanelLocked)
  const toggleVisibilityLock = useStore((s) => s.toggleVisibilityLock)
  const handleMove = useLinkedMove('fm', fmPos, setFMPos, linkedMove)

  const fmLayout = useFMStore((s) => s.fmLayout)
  const setFMLayout = useFMStore((s) => s.setFMLayout)
  const fmPaneTabs = useFMStore((s) => s.fmPaneTabs)
  const fmActiveTab = useFMStore((s) => s.fmActiveTab)
  const setFMPanePath = useFMStore((s) => s.setFMPanePath)
  const addFMTab = useFMStore((s) => s.addFMTab)
  const removeFMTab = useFMStore((s) => s.removeFMTab)
  const setFMActiveTab = useFMStore((s) => s.setFMActiveTab)
  const fmPaneSorts = useFMStore((s) => s.fmPaneSorts)
  const setFMPaneSort = useFMStore((s) => s.setFMPaneSort)
  const fmShowHidden = useFMStore((s) => s.fmShowHidden)
  const setFMShowHidden = useFMStore((s) => s.setFMShowHidden)
  const fmClipboard = useFMStore((s) => s.fmClipboard)
  const setFMClipboard = useFMStore((s) => s.setFMClipboard)
  const activePaneIndex = useFMStore((s) => s.activePaneIndex)
  const setActivePaneIndex = useFMStore((s) => s.setActivePaneIndex)
  const fmViewModes = useFMStore((s) => s.fmViewModes)
  const setFMViewMode = useFMStore((s) => s.setFMViewMode)
  const fmGroupModes = useFMStore((s) => s.fmGroupModes)
  const setFMGroupMode = useFMStore((s) => s.setFMGroupMode)
  const fmFontScale = useFMStore((s) => s.fmFontScale)
  const setFMFontScale = useFMStore((s) => s.setFMFontScale)

  const paneCount = LAYOUT_PANE_COUNT[fmLayout]

  const cycleFontScale = useCallback(
    (dir: 1 | -1) => {
      const idx = FONT_SCALES.indexOf(fmFontScale)
      const next = idx < 0 ? 2 : Math.max(0, Math.min(FONT_SCALES.length - 1, idx + dir))
      setFMFontScale(FONT_SCALES[next])
    },
    [fmFontScale, setFMFontScale],
  )

  // ── Selections (in ref for stable callbacks) ───
  const [refreshCounter, setRefreshCounter] = useState(0)

  const [selections, setSelections] = useState<Map<number, Set<string>>>(
    () =>
      new Map([
        [0, new Set()],
        [1, new Set()],
        [2, new Set()],
        [3, new Set()],
      ]),
  )
  const [confirmDeletePaths, setConfirmDeletePaths] = useState<string[] | null>(null)
  const selectionsRef = useRef(selections)
  selectionsRef.current = selections

  // Activate pane & clear selections in others (sync — no effect timing issues)
  const activatePane = useCallback(
    (idx: number) => {
      setSelections((prev) => {
        const next = new Map(prev)
        for (const [i] of next) {
          if (i !== idx) next.set(i, new Set())
        }
        return next
      })
      setActivePaneIndex(idx)
    },
    [setActivePaneIndex],
  )

  const { copyFiles, moveFiles, confirmReq } = useFileOperations()

  // ── Stable callbacks ───────────────────────────
  const resizeRafRef = useRef(0)
  const pendingSize = useRef<{ w: number; h: number } | null>(null)

  useEffect(
    () => () => {
      cancelAnimationFrame(resizeRafRef.current)
      pendingSize.current = null
    },
    [],
  )

  const handleResize = useCallback(
    (w: number, h: number) => {
      pendingSize.current = { w, h }
      if (resizeRafRef.current) return
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = 0
        const s = pendingSize.current
        if (!s) return
        pendingSize.current = null
        setFMSize(s.w, s.h)
      })
    },
    [setFMSize],
  )

  // Read store at call-time so it always targets the currently-active pane
  const handleQuickAccess = useCallback(
    (p: string) => {
      const s = useFMStore.getState()
      const idx = s.activePaneIndex
      const tabs = s.fmPaneTabs[idx] || []
      const tabIdx = Math.max(0, s.fmActiveTab[idx] || 0)
      if (tabs.length > 0) {
        setFMPanePath(idx, tabIdx, p)
      } else {
        addFMTab(idx, p)
      }
    },
    [setFMPanePath, addFMTab],
  )

  // Per-pane navigate — updates the current active tab's path
  const navCallbacks = useMemo(() => {
    const cbs: Array<(p: string) => void> = []
    for (let i = 0; i < 4; i++) {
      cbs.push((p: string) => {
        const tabIdx = useFMStore.getState().fmActiveTab[i] || 0
        setFMPanePath(i, tabIdx, p)
      })
    }
    return cbs
  }, [setFMPanePath])

  // Per-pane add tab
  const addTabCallbacks = useMemo(() => {
    const cbs: Array<(path: string) => void> = []
    for (let i = 0; i < 4; i++) {
      cbs.push((path: string) => {
        addFMTab(i, path)
      })
    }
    return cbs
  }, [addFMTab])

  // Per-pane remove tab
  const removeTabCallbacks = useMemo(() => {
    const cbs: Array<(tabIdx: number) => void> = []
    for (let i = 0; i < 4; i++) {
      cbs.push((tabIdx: number) => {
        removeFMTab(i, tabIdx)
      })
    }
    return cbs
  }, [removeFMTab])

  // Per-pane set active tab
  const setActiveTabCallbacks = useMemo(() => {
    const cbs: Array<(tabIdx: number) => void> = []
    for (let i = 0; i < 4; i++) {
      cbs.push((tabIdx: number) => {
        setFMActiveTab(i, tabIdx)
      })
    }
    return cbs
  }, [setFMActiveTab])

  const sortCallbacks = useMemo(() => {
    const cbs: Array<(s: SortState) => void> = []
    for (let i = 0; i < 4; i++) {
      cbs.push((s: SortState) => {
        setFMPaneSort(i, s)
      })
    }
    return cbs
  }, [setFMPaneSort])

  const viewModeCallbacks = useMemo(() => {
    const cbs: Array<(m: ViewMode) => void> = []
    for (let i = 0; i < 4; i++) {
      cbs.push((m: ViewMode) => {
        setFMViewMode(i, m)
      })
    }
    return cbs
  }, [setFMViewMode])

  const groupModeCallbacks = useMemo(() => {
    const cbs: Array<(m: GroupMode) => void> = []
    for (let i = 0; i < 4; i++) {
      cbs.push((m: GroupMode) => {
        setFMGroupMode(i, m)
      })
    }
    return cbs
  }, [setFMGroupMode])

  // Per-pane selection change callbacks (memoized for React.memo stability)
  const selectionCallbacks = useMemo(() => {
    const cbs: Array<(sel: Set<string>) => void> = []
    for (let i = 0; i < 4; i++) {
      cbs.push((sel: Set<string>) => {
        const next = new Map(selectionsRef.current)
        next.set(i, sel)
        setSelections(next)
      })
    }
    return cbs
  }, [setSelections])

  // Per-pane activate callbacks (memoized for React.memo stability)
  const activateCallbacks = useMemo(() => {
    const cbs: Array<() => void> = []
    for (let i = 0; i < 4; i++) {
      cbs.push(() => activatePane(i))
    }
    return cbs
  }, [activatePane])

  const handleOpenFile = useCallback(async (p: string) => {
    await window.electronAPI.fmOpenFile(p)
  }, [])

  // ── Drop target on each pane ───────────────────
  const [dropHighlight, setDropHighlight] = useState<number | null>(null)

  // Use a ref for the current paths to keep drop callbacks stable
  const tabsRef = useRef({ tabs: fmPaneTabs, active: fmActiveTab })
  tabsRef.current = { tabs: fmPaneTabs, active: fmActiveTab }

  const getCurrentPath = (paneIdx: number): string => {
    const t = tabsRef.current.tabs[paneIdx]
    const a = tabsRef.current.active[paneIdx] || 0
    return (t && t[a]) || ''
  }

  const handlePaneDrop = useCallback(
    async (e: React.DragEvent, paneIdx: number) => {
      e.preventDefault()
      activatePane(paneIdx)
      setDropHighlight(null)
      const raw = e.dataTransfer.getData('text/plain')
      if (!raw) return
      const paths = raw.split('\n').filter(Boolean)
      if (paths.length === 0) return

      const destDir = getCurrentPath(paneIdx)
      if (!destDir) return

      // Panes are independent windows → default is copy.
      // Hold Shift to move instead.
      const move = e.shiftKey

      if (move) {
        await moveFiles(paths, destDir)
      } else {
        await copyFiles(paths, destDir)
      }
      setFMClipboard(null)
      setRefreshCounter((c) => c + 1)
    },
    [copyFiles, moveFiles, setFMClipboard, activatePane],
  )

  const handlePaneDragOver = useCallback(
    (e: React.DragEvent, paneIdx: number) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy'
      activatePane(paneIdx)
      setDropHighlight(paneIdx)
    },
    [activatePane],
  )

  const handlePaneDragLeave = useCallback(() => {
    setDropHighlight(null)
  }, [])

  // ── Mouse tracking (for Ctrl+V paste destination) ─
  const mouseRef = useRef({ x: 0, y: 0 })
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  // ── Keyboard shortcuts (stable, reads from refs) ─
  const clipboardRef = useRef(fmClipboard)
  clipboardRef.current = fmClipboard

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      const sel = selectionsRef.current
      const clip = clipboardRef.current

      const activeIdx = useFMStore.getState().activePaneIndex
      const activeSel = sel.get(activeIdx) || new Set()

      if (e.ctrlKey && e.key === 'c') {
        const paths = [...activeSel]
        if (paths.length > 0) setFMClipboard({ paths, operation: 'copy' })
      }
      if (e.ctrlKey && e.key === 'x') {
        const paths = [...activeSel]
        if (paths.length > 0) setFMClipboard({ paths, operation: 'cut' })
      }
      if (e.ctrlKey && e.key === 'v') {
        if (clip) {
          // Use pane under mouse cursor; fall back to activePaneIndex
          const pos = mouseRef.current
          const el = document.elementFromPoint(pos.x, pos.y)
          const paneEl = el?.closest('[data-pane-index]') as HTMLElement | null
          const destIdx = paneEl ? Number(paneEl.getAttribute('data-pane-index')) : activeIdx
          const dest = getCurrentPath(destIdx)
          if (dest) {
            if (clip.operation === 'cut') {
              moveFiles(clip.paths, dest)
              setFMClipboard(null)
            } else {
              copyFiles(clip.paths, dest)
            }
          }
        }
      }
      if (e.key === 'Delete') {
        const paths = [...activeSel]
        if (paths.length > 0) {
          setConfirmDeletePaths(paths)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setFMClipboard, moveFiles, copyFiles]) // stable deps only

  // ── Layout styles ──────────────────────────────
  const paneStyles = useMemo(() => {
    const panelH = fmSize.h
    const h = Math.max(100, panelH - 80)
    // Account for 2px gap between panes
    const G = 2
    switch (fmLayout) {
      case 'single':
        return [{ width: '100%', height: h }]
      case 'horizontal':
        return [
          { width: `calc(50% - ${G / 2}px)`, height: h },
          { width: `calc(50% - ${G / 2}px)`, height: h },
        ]
      case 'vertical':
        return [
          { width: '100%', height: h / 2 - G / 2 },
          { width: '100%', height: h / 2 - G / 2 },
        ]
      case 'triple':
        return [
          { width: `calc(33.333% - ${(2 * G) / 3}px)`, height: h },
          { width: `calc(33.333% - ${(2 * G) / 3}px)`, height: h },
          { width: `calc(33.333% - ${(2 * G) / 3}px)`, height: h },
        ]
      case 'quad':
        const halfH = h / 2 - G / 2
        return [
          { width: `calc(50% - ${G / 2}px)`, height: halfH },
          { width: `calc(50% - ${G / 2}px)`, height: halfH },
          { width: `calc(50% - ${G / 2}px)`, height: halfH },
          { width: `calc(50% - ${G / 2}px)`, height: halfH },
        ]
    }
  }, [fmLayout, fmSize.h])

  // ── Render ─────────────────────────────────────
  return (
    <DraggablePanel
      panelId="fm"
      title="File Manager"
      x={fmPos.x}
      y={fmPos.y}
      w={fmSize.w}
      h={fmSize.h}
      defaultX={200}
      defaultY={200}
      defaultW={DEFAULT_FM_W}
      defaultH={DEFAULT_FM_H}
      onMove={handleMove}
      onResize={handleResize}
      locked={locked}
      onToggleLock={() => togglePanelLocked('fm')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('fm')}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflow: 'hidden',
          contain: 'layout style paint',
          willChange: 'transform',
        }}
      >
        {/* Toolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 6px',
            borderBottom: '1px solid rgba(var(--date), 0.18)',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 10, opacity: 0.5, marginRight: 4 }}>{t('Layout')}:</span>
          {(Object.keys(LAYOUT_LABELS) as PaneLayout[]).map((k) => (
            <button
              key={k}
              onClick={() => setFMLayout(k)}
              style={{
                fontSize: 10,
                padding: '2px 8px',
                background: fmLayout === k ? 'rgba(var(--fg), 0.2)' : undefined,
              }}
            >
              {t(LAYOUT_LABELS[k])}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          {/* Font scale */}
          <button
            onClick={() => cycleFontScale(-1)}
            disabled={fmFontScale <= FONT_SCALES[0]}
            style={{
              fontSize: 10,
              padding: '2px 4px',
              opacity: fmFontScale <= FONT_SCALES[0] ? 0.3 : 1,
            }}
            title={t('Zoom out')}
          >
            🔍−
          </button>
          <span style={{ fontSize: 9, opacity: 0.6, minWidth: 30, textAlign: 'center' }}>
            {Math.round(fmFontScale * 100)}%
          </span>
          <button
            onClick={() => cycleFontScale(1)}
            disabled={fmFontScale >= FONT_SCALES[4]}
            style={{
              fontSize: 10,
              padding: '2px 4px',
              opacity: fmFontScale >= FONT_SCALES[4] ? 0.3 : 1,
            }}
            title={t('Zoom in')}
          >
            🔍+
          </button>
          <button
            onClick={() => setFMShowHidden(!fmShowHidden)}
            style={{
              fontSize: 10,
              padding: '2px 6px',
              background: fmShowHidden ? 'rgba(var(--fg), 0.2)' : undefined,
            }}
          >
            {fmShowHidden ? `·${t('Hidden')}` : t('Hidden')}
          </button>
          {fmClipboard && (
            <span style={{ fontSize: 9, opacity: 0.5, color: 'rgb(255,200,100)' }}>
              {fmClipboard.operation === 'cut' ? '✂' : '📋'} {fmClipboard.paths.length} {t('items')}
            </span>
          )}
        </div>

        {/* Quick Access */}
        <QuickAccess onSelect={handleQuickAccess} />

        {/* Panes */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexWrap: 'wrap',
            overflow: 'hidden',
            gap: 2,
            padding: 2,
          }}
        >
          {Array.from({ length: paneCount }, (_, i) => (
            <div
              key={i}
              style={{
                ...paneStyles[i],
                boxSizing: 'border-box',
                contain: 'layout style paint',
                contentVisibility: 'auto',
                containIntrinsicSize: 'auto 200px',
                outline: dropHighlight === i ? '2px solid rgba(255,200,50,0.6)' : 'none',
                transition: 'outline 0.15s',
              }}
              data-pane-index={i}
              onDrop={(e) => handlePaneDrop(e, i)}
              onDragOver={(e) => handlePaneDragOver(e, i)}
              onDragLeave={handlePaneDragLeave}
            >
              <FilePane
                paneIndex={i}
                path={(fmPaneTabs[i] && fmPaneTabs[i][fmActiveTab[i] || 0]) || 'C:\\'}
                tabs={fmPaneTabs[i] || []}
                activeTabIdx={fmActiveTab[i] || 0}
                isActive={activePaneIndex === i}
                sort={fmPaneSorts[i] || { field: 'name', direction: 'asc' }}
                viewMode={fmViewModes[i] || 'list'}
                groupMode={fmGroupModes[i] || 'none'}
                onNavigate={navCallbacks[i]}
                onSortChange={sortCallbacks[i]}
                onViewModeChange={viewModeCallbacks[i]}
                onGroupModeChange={groupModeCallbacks[i]}
                selectedPaths={selections.get(i) || new Set()}
                onSelectionChange={selectionCallbacks[i]}
                onOpenFile={handleOpenFile}
                showHidden={fmShowHidden}
                onActivate={activateCallbacks[i]}
                onAddTab={addTabCallbacks[i]}
                onRemoveTab={removeTabCallbacks[i]}
                onSetActiveTab={setActiveTabCallbacks[i]}
                refreshKey={refreshCounter}
                fontScale={fmFontScale}
              />
            </div>
          ))}
        </div>
      </div>

      <ProgressDialog />
      {confirmReq && <ConfirmDialog request={confirmReq} />}
      {confirmDeletePaths && (
        <ConfirmDialog
          request={{
            message: t('Delete {count} items?', { count: confirmDeletePaths.length }),
            detail:
              confirmDeletePaths
                .slice(0, 5)
                .map((p) => p.replace(/\\/g, '/').split('/').pop())
                .join(', ') +
              (confirmDeletePaths.length > 5
                ? ` ${t('and {count} more', { count: confirmDeletePaths.length - 5 })}`
                : ''),
            options: [
              { label: 'Delete', value: 'delete', primary: true },
              { label: 'Cancel', value: 'cancel' },
            ],
            onResolve: async (v) => {
              if (v === 'delete') {
                await window.electronAPI.fmDeleteFiles(confirmDeletePaths)
                const next = new Map<number, Set<string>>()
                for (let i = 0; i < 4; i++) next.set(i, new Set())
                setSelections(next)
              }
              setConfirmDeletePaths(null)
            },
          }}
        />
      )}
    </DraggablePanel>
  )
}

export default FileManagerPanel
