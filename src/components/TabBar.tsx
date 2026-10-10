import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../i18n/useTranslation'

// Generic tab bar used by both Folders and Prompts panels.
// TabType must have: { name: string }

interface TabBarProps<T> {
  tabs: T[]
  activeIdx: number
  onSelectTab: (idx: number) => void
  onRenameTab: (idx: number, name: string) => void
  onDeleteTab: (idx: number) => void
  onAddTab: (name: string) => void
}

function TabBar<T extends { name: string }>({
  tabs,
  activeIdx,
  onSelectTab,
  onRenameTab,
  onDeleteTab,
  onAddTab,
}: TabBarProps<T>) {
  const { t } = useTranslation()
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; idx: number } | null>(null)
  const [renameIdx, setRenameIdx] = useState(-1)
  const [renameBuf, setRenameBuf] = useState('')
  const [showNewTab, setShowNewTab] = useState(false)
  const [newTabName, setNewTabName] = useState('')

  const handleContextMenu = (e: React.MouseEvent, idx: number) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, idx })
  }

  const handleRename = (idx: number) => {
    setRenameIdx(idx)
    setRenameBuf(tabs[idx]?.name || '')
    setCtxMenu(null)
  }

  const handleDelete = (idx: number) => {
    if (tabs.length > 1) onDeleteTab(idx)
    setCtxMenu(null)
  }

  const handleRenameOk = () => {
    if (renameBuf.trim() && renameIdx >= 0) {
      onRenameTab(renameIdx, renameBuf.trim())
    }
    setRenameIdx(-1)
    setRenameBuf('')
  }

  const handleAddTab = () => {
    if (newTabName.trim()) {
      onAddTab(newTabName.trim())
      setNewTabName('')
      setShowNewTab(false)
    }
  }

  return (
    <div className="tab-bar" style={{ position: 'relative' }}>
      {tabs.map((tab, i) => (
        <button
          key={i}
          className={`tab ${i === activeIdx ? 'active' : ''}`}
          onClick={() => onSelectTab(i)}
          onContextMenu={(e) => handleContextMenu(e, i)}
          style={{
            ...(renameIdx === i ? { display: 'none' } : {}),
          }}
        >
          {tab.name}
        </button>
      ))}

      {/* Rename inline editor */}
      {renameIdx >= 0 && (
        <div style={{ display: 'flex', gap: 2 }}>
          <input
            autoFocus
            value={renameBuf}
            onChange={(e) => setRenameBuf(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameOk()
              if (e.key === 'Escape') setRenameIdx(-1)
            }}
            style={{ width: 80, height: 22, padding: '2px 4px' }}
          />
          <button onClick={handleRenameOk} style={{ padding: '2px 6px', fontSize: 10 }}>
            {t('OK')}
          </button>
        </div>
      )}

      {/* + button */}
      <button
        className="tab"
        onClick={() => setShowNewTab(true)}
        style={{ fontWeight: 'bold', fontSize: 14, padding: '2px 8px' }}
      >
        +
      </button>

      {/* New tab popup */}
      {showNewTab && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 49 }}
            onClick={() => {
              setShowNewTab(false)
              setNewTabName('')
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              zIndex: 50,
              background: 'rgba(var(--bg), 0.95)',
              border: '1px solid rgba(var(--date), 0.45)',
              borderRadius: 4,
              padding: 8,
              display: 'flex',
              gap: 4,
            }}
          >
            <input
              autoFocus
              placeholder={t('Tab name')}
              value={newTabName}
              onChange={(e) => setNewTabName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddTab()
                if (e.key === 'Escape') {
                  setShowNewTab(false)
                  setNewTabName('')
                }
              }}
              style={{ width: 100 }}
            />
            <button onClick={handleAddTab}>{t('Create')}</button>
            <button
              onClick={() => {
                setShowNewTab(false)
                setNewTabName('')
              }}
              style={{ opacity: 0.5, fontSize: 10 }}
            >
              ✕
            </button>
          </div>
        </>
      )}

      {/* Context menu (portal to body to avoid panel overflow clip) */}
      {ctxMenu &&
        createPortal(
          <div style={{ pointerEvents: 'auto' }} data-portal="">
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 99 }}
              onClick={() => setCtxMenu(null)}
            />
            <div className="context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
              <div className="context-menu-item" onClick={() => handleRename(ctxMenu.idx)}>
                {t('Rename')}
              </div>
              {tabs.length > 1 && (
                <div className="context-menu-item" onClick={() => handleDelete(ctxMenu.idx)}>
                  {t('Delete')}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}

export default TabBar
