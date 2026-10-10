import React, { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../stores/useStore'
import DraggablePanel from './DraggablePanel'
import TabBar from './TabBar'
import { DEFAULT_PROMPTS_W, DEFAULT_PROMPTS_H } from '../types'
import { useLinkedMove } from '../hooks/useLinkedMove'
import { useTranslation } from '../i18n/useTranslation'

const PromptsPanel: React.FC = () => {
  const { t } = useTranslation()
  const promptTabs = useStore((s) => s.promptTabs)
  const activePromptTab = useStore((s) => s.activePromptTab)
  const setActivePromptTab = useStore((s) => s.setActivePromptTab)
  const addPromptTab = useStore((s) => s.addPromptTab)
  const renamePromptTab = useStore((s) => s.renamePromptTab)
  const deletePromptTab = useStore((s) => s.deletePromptTab)
  const addPrompt = useStore((s) => s.addPrompt)
  const deletePrompt = useStore((s) => s.deletePrompt)
  const openEditWindow = useStore((s) => s.openEditWindow)
  const promptsPos = useStore((s) => s.promptsPos)
  const setPromptsPos = useStore((s) => s.setPromptsPos)
  const setPromptsSize = useStore((s) => s.setPromptsSize)
  const promptsSize = useStore((s) => s.promptsSize)
  const linkedMove = useStore((s) => s.linkedMove)
  const locked = useStore((s) => s.lockedPanels['prompts'] ?? false)
  const visibilityLocked = useStore((s) => s.lockedVisibility['prompts'] ?? false)
  const togglePanelLocked = useStore((s) => s.togglePanelLocked)
  const toggleVisibilityLock = useStore((s) => s.toggleVisibilityLock)
  const handleMove = useLinkedMove('prompts', promptsPos, setPromptsPos, linkedMove)

  const activePrompts = promptTabs[activePromptTab]?.prompts || []

  // ── Context menu ─────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; idx: number } | null>(null)
  const [renameIdx, setRenameIdx] = useState(-1)
  const [renameBuf, setRenameBuf] = useState('')

  // ── Add prompt ───────────────────────────────────
  const [showAdd, setShowAdd] = useState(false)
  const [addName, setAddName] = useState('')
  const [addText, setAddText] = useState('')

  const handleContextMenu = (e: React.MouseEvent, idx: number) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, idx })
  }

  const handleEdit = (idx: number) => {
    openEditWindow(activePromptTab, idx)
  }

  const handleCopy = async (idx: number) => {
    await window.electronAPI.copyToClipboard(activePrompts[idx].text)
  }

  // ── Long-press vs click ──────────────────────────
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const LONG_PRESS_MS = 500

  const handlePointerDown = (idx: number) => {
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null
      handleEdit(idx)
    }, LONG_PRESS_MS)
  }

  const handlePointerUp = (idx: number) => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
      handleCopy(idx)
    }
  }

  const handlePointerLeave = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  const handleRenameStart = (idx: number) => {
    setRenameIdx(idx)
    setRenameBuf(activePrompts[idx]?.name || '')
    setCtxMenu(null)
  }

  const handleRenameOk = () => {
    if (renameBuf.trim() && renameIdx >= 0) {
      const store = useStore.getState()
      store.renamePrompt(renameIdx, renameBuf.trim())
    }
    setRenameIdx(-1)
    setRenameBuf('')
  }

  const handleDelete = (idx: number) => {
    deletePrompt(idx)
    setCtxMenu(null)
  }

  const handleAdd = () => {
    if (addName.trim()) {
      addPrompt(addName.trim(), addText)
      setAddName('')
      setAddText('')
      setShowAdd(false)
    }
  }

  return (
    <DraggablePanel
      panelId="prompts"
      title="Prompts"
      x={promptsPos.x}
      y={promptsPos.y}
      defaultX={50}
      defaultY={180}
      w={promptsSize.w}
      h={promptsSize.h}
      defaultW={DEFAULT_PROMPTS_W}
      defaultH={DEFAULT_PROMPTS_H}
      onMove={handleMove}
      onResize={(w, h) => setPromptsSize(w, h)}
      locked={locked}
      onToggleLock={() => togglePanelLocked('prompts')}
      visibilityLocked={visibilityLocked}
      onToggleVisibilityLock={() => toggleVisibilityLock('prompts')}
    >
      <TabBar
        tabs={promptTabs}
        activeIdx={activePromptTab}
        onSelectTab={setActivePromptTab}
        onRenameTab={renamePromptTab}
        onDeleteTab={deletePromptTab}
        onAddTab={addPromptTab}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
        {activePrompts.map((p, i) => (
          <div key={i} onContextMenu={(e) => handleContextMenu(e, i)}>
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
            ) : (
              <button
                style={{ width: '100%', textAlign: 'left', padding: '4px 10px' }}
                onMouseDown={() => handlePointerDown(i)}
                onMouseUp={() => handlePointerUp(i)}
                onMouseLeave={handlePointerLeave}
                title={t('Click: copy · Long-press: edit')}
              >
                {p.name}
              </button>
            )}
          </div>
        ))}

        {/* Add prompt */}
        {promptTabs.length === 0 ? (
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
            <textarea
              placeholder={t('Text')}
              value={addText}
              onChange={(e) => setAddText(e.target.value)}
              rows={4}
              style={{ resize: 'vertical' }}
              onKeyDown={(e) => e.key === 'Escape' && setShowAdd(false)}
            />
            <div style={{ display: 'flex', gap: 2 }}>
              <button onClick={handleAdd} style={{ flex: 1 }}>
                {t('Add')}
              </button>
              <button
                onClick={() => {
                  setShowAdd(false)
                  setAddName('')
                  setAddText('')
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
            + {t('Add Prompt')}
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
                  handleEdit(ctxMenu.idx)
                  setCtxMenu(null)
                }}
              >
                {t('Edit')}
              </div>
              <div className="context-menu-item" onClick={() => handleRenameStart(ctxMenu.idx)}>
                {t('Rename')}
              </div>
              <div
                className="context-menu-item"
                onClick={() => {
                  handleCopy(ctxMenu.idx)
                  setCtxMenu(null)
                }}
              >
                {t('Copy')}
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

export default PromptsPanel
