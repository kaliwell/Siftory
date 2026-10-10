import React, { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../stores/useStore'
import DraggablePanel from './DraggablePanel'
import TabBar from './TabBar'
import { DEFAULT_FOLDERS_W, DEFAULT_FOLDERS_H } from '../types'
import { useLinkedMove } from '../hooks/useLinkedMove'
import { useTranslation } from '../i18n/useTranslation'

const FoldersPanel: React.FC = () => {
  const { t } = useTranslation()
  const tabs = useStore((s) => s.tabs)
  const activeTab = useStore((s) => s.activeTab)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const addTab = useStore((s) => s.addTab)
  const renameTab = useStore((s) => s.renameTab)
  const deleteTab = useStore((s) => s.deleteTab)
  const addShortcut = useStore((s) => s.addShortcut)
  const renameShortcut = useStore((s) => s.renameShortcut)
  const changeShortcutPath = useStore((s) => s.changeShortcutPath)
  const deleteShortcut = useStore((s) => s.deleteShortcut)
  const foldersPos = useStore((s) => s.foldersPos)
  const setFoldersPos = useStore((s) => s.setFoldersPos)
  const setFoldersSize = useStore((s) => s.setFoldersSize)
  const foldersSize = useStore((s) => s.foldersSize)
  const linkedMove = useStore((s) => s.linkedMove)
  const locked = useStore((s) => s.lockedPanels['folders'] ?? false)
  const visibilityLocked = useStore((s) => s.lockedVisibility['folders'] ?? false)
  const togglePanelLocked = useStore((s) => s.togglePanelLocked)
  const toggleVisibilityLock = useStore((s) => s.toggleVisibilityLock)
  const handleMove = useLinkedMove('folders', foldersPos, setFoldersPos, linkedMove)

  const activeShortcuts = tabs[activeTab]?.shortcuts || []

  // ── Context menu ─────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; idx: number } | null>(null)
  const [renameIdx, setRenameIdx] = useState(-1)
  const [renameBuf, setRenameBuf] = useState('')
  const [pathIdx, setPathIdx] = useState(-1)
  const [pathBuf, setPathBuf] = useState('')

  // ── Add shortcut ─────────────────────────────────
  const [showAdd, setShowAdd] = useState(false)
  const [addName, setAddName] = useState('')
  const [addPath, setAddPath] = useState('')

  const handleContextMenu = (e: React.MouseEvent, idx: number) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, idx })
  }

  const handleOpen = useCallback(async (path: string) => {
    await window.electronAPI.openFolder(path)
  }, [])

  const handleRenameStart = (idx: number) => {
    setRenameIdx(idx)
    setRenameBuf(activeShortcuts[idx]?.name || '')
    setCtxMenu(null)
  }

  const handleRenameOk = () => {
    if (renameBuf.trim() && renameIdx >= 0) {
      renameShortcut(renameIdx, renameBuf.trim())
    }
    setRenameIdx(-1)
    setRenameBuf('')
  }

  const handlePathStart = (idx: number) => {
    setPathIdx(idx)
    setPathBuf(activeShortcuts[idx]?.path || '')
    setCtxMenu(null)
  }

  const handlePathOk = () => {
    if (pathBuf.trim() && pathIdx >= 0) {
      changeShortcutPath(pathIdx, pathBuf.trim())
    }
    setPathIdx(-1)
    setPathBuf('')
  }

  const handleBrowsePath = async (isNew: boolean) => {
    const folder = await window.electronAPI.browseFolder()
    if (folder) {
      if (isNew) setAddPath(folder)
      else setPathBuf(folder)
    }
  }

  const handleDelete = (idx: number) => {
    deleteShortcut(idx)
    setCtxMenu(null)
  }

  const handleAdd = () => {
    if (addName.trim() && addPath.trim()) {
      addShortcut(addName.trim(), addPath.trim())
      setAddName('')
      setAddPath('')
      setShowAdd(false)
    }
  }

  return (
    <DraggablePanel
      panelId="folders"
      title="Folders"
      x={foldersPos.x}
      y={foldersPos.y}
      defaultX={340}
      defaultY={50}
      w={foldersSize.w}
      h={foldersSize.h}
      defaultW={DEFAULT_FOLDERS_W}
      defaultH={DEFAULT_FOLDERS_H}
      onMove={handleMove}
      onResize={(w, h) => setFoldersSize(w, h)}
      locked={locked}
      onToggleLock={() => togglePanelLocked('folders')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('folders')}
    >
      <TabBar
        tabs={tabs}
        activeIdx={activeTab}
        onSelectTab={setActiveTab}
        onRenameTab={renameTab}
        onDeleteTab={deleteTab}
        onAddTab={addTab}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
        {activeShortcuts.map((sc, i) => (
          <div key={i} onContextMenu={(e) => handleContextMenu(e, i)}>
            {/* Rename inline */}
            {renameIdx === i ? (
              <div style={{ display: 'flex', gap: 2 }}>
                <input
                  autoFocus
                  value={renameBuf}
                  onChange={(e) => setRenameBuf(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameOk()
                    if (e.key === 'Escape') setRenameIdx(-1)
                  }}
                  style={{ flex: 1, height: 24 }}
                />
                <button onClick={handleRenameOk} style={{ padding: '2px 8px' }}>
                  {t('OK')}
                </button>
              </div>
            ) : pathIdx === i ? (
              /* Path edit inline */
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <input
                  autoFocus
                  value={pathBuf}
                  onChange={(e) => setPathBuf(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handlePathOk()
                    if (e.key === 'Escape') setPathIdx(-1)
                  }}
                  style={{ height: 24 }}
                />
                <div style={{ display: 'flex', gap: 2 }}>
                  <button onClick={() => handleBrowsePath(false)} style={{ flex: 1 }}>
                    {t('Browse')}
                  </button>
                  <button onClick={handlePathOk} style={{ padding: '2px 12px' }}>
                    {t('OK')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                style={{ width: '100%', textAlign: 'left', padding: '4px 10px' }}
                onClick={() => handleOpen(sc.path)}
              >
                {sc.name}
              </button>
            )}
          </div>
        ))}

        {/* Add shortcut */}
        {tabs.length === 0 ? (
          <div style={{ textAlign: 'center', marginTop: 12, opacity: 0.4, fontSize: 12 }}>
            {t('Click + to create a tab first')}
          </div>
        ) : showAdd ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
            <input
              placeholder={t('Name')}
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setShowAdd(false)}
            />
            <input
              placeholder={t('Path')}
              value={addPath}
              onChange={(e) => setAddPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setShowAdd(false)}
            />
            <div style={{ display: 'flex', gap: 2 }}>
              <button onClick={() => handleBrowsePath(true)} style={{ flex: 1 }}>
                {t('Browse')}
              </button>
              <button onClick={handleAdd}>{t('Add')}</button>
              <button
                onClick={() => {
                  setShowAdd(false)
                  setAddName('')
                  setAddPath('')
                }}
                style={{ opacity: 0.5 }}
              >
                {t('Cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            style={{ width: '100%', marginTop: 4, opacity: 0.6 }}
            onClick={() => setShowAdd(true)}
          >
            + {t('Add Shortcut')}
          </button>
        )}
      </div>

      {/* Context menu (portal to body to avoid panel overflow clip) */}
      {ctxMenu &&
        createPortal(
          <div style={{ pointerEvents: 'auto' }} data-portal="">
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 99 }}
              onClick={() => setCtxMenu(null)}
            />
            <div className="context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
              <div
                className="context-menu-item"
                onClick={() => {
                  handleOpen(activeShortcuts[ctxMenu.idx].path)
                  setCtxMenu(null)
                }}
              >
                {t('Open')}
              </div>
              <div className="context-menu-item" onClick={() => handleRenameStart(ctxMenu.idx)}>
                {t('Rename')}
              </div>
              <div className="context-menu-item" onClick={() => handlePathStart(ctxMenu.idx)}>
                {t('Change Path...')}
              </div>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => handleDelete(ctxMenu.idx)}>
                {t('Delete')}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </DraggablePanel>
  )
}

export default FoldersPanel
