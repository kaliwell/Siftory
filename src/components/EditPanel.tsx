import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../stores/useStore'
import DraggablePanel from './DraggablePanel'
import { FONT_SCALE_STEPS, DEFAULT_EDIT_W, DEFAULT_EDIT_H } from '../types'
import { useTranslation } from '../i18n/useTranslation'

const EditPanel: React.FC = () => {
  const editEntries = useStore((s) => s.editPrompts)
  const promptTabs = useStore((s) => s.promptTabs)
  const saveEditWindow = useStore((s) => s.saveEditWindow)
  const fontScaleIdx = useStore((s) => s.fontScaleIdx)

  return (
    <>
      {editEntries.map((entry) => {
        const prompt = promptTabs[entry.tabIdx]?.prompts?.[entry.promptIdx]
        if (!prompt) return null
        return (
          <EditWindow
            key={`${entry.tabIdx}-${entry.promptIdx}`}
            prompt={prompt}
            globalScaleIdx={fontScaleIdx}
            onSave={(text: string) => saveEditWindow(entry.tabIdx, entry.promptIdx, text)}
          />
        )
      })}
    </>
  )
}

// ── Individual edit window ────────────────────────────────

interface EditWindowProps {
  prompt: { name: string; text: string }
  globalScaleIdx: number
  onSave: (text: string) => void
}

const EditWindow: React.FC<EditWindowProps> = ({ prompt, globalScaleIdx, onSave }) => {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(true)
  const [text, setText] = useState(prompt.text)
  const [zoomIdx, setZoomIdx] = useState(globalScaleIdx)
  const [title, setTitle] = useState(`Edit: ${prompt.name}`)
  const contentRef = useRef<HTMLDivElement | null>(null)

  // Sync prompt name changes while window is open
  useEffect(() => {
    setTitle(`Edit: ${prompt.name}`)
  }, [prompt.name])

  // Ctrl+Scroll zoom — native listener to guarantee non-passive
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault()
        const delta = e.deltaY > 0 ? -1 : 1
        setZoomIdx((prev) => {
          const n = prev + delta
          if (n < 0) return 0
          if (n >= FONT_SCALE_STEPS.length) return FONT_SCALE_STEPS.length - 1
          return n
        })
      }
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  const handleCopy = async () => {
    await window.electronAPI.copyToClipboard(text)
  }

  const handleSave = () => {
    onSave(text)
    setIsOpen(false)
  }

  const handleClose = () => {
    onSave(text) // auto-save on close too
    setIsOpen(false)
  }

  if (!isOpen) return null

  const scale = FONT_SCALE_STEPS[zoomIdx]

  return (
    <DraggablePanel
      onClose={handleClose}
      title={title}
      displayTitle={`${t('Edit')}: ${prompt.name}`}
      defaultX={200}
      defaultY={200}
      defaultW={DEFAULT_EDIT_W}
      defaultH={DEFAULT_EDIT_H}
      dataPanel="prompt-edit"
      compositorDrag
    >
      <div ref={contentRef} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            marginBottom: 6,
            fontSize: 11,
            opacity: 0.7,
          }}
        >
          <span style={{ flex: 1 }}>
            {t('Content')}: {Math.round(scale * 100)}% ({t('Ctrl+Scroll')})
          </span>
          <button onClick={handleCopy} style={{ padding: '2px 10px' }}>
            {t('Copy')}
          </button>
          <button onClick={handleSave} style={{ padding: '2px 10px' }}>
            {t('Save')}
          </button>
          <button onClick={handleClose} style={{ padding: '2px 10px' }}>
            {t('Close')}
          </button>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{
            flex: 1,
            resize: 'none',
            contain: 'layout paint style',
            fontSize: Math.round(12 * scale),
            lineHeight: 1.5,
            fontFamily: 'Consolas, "Microsoft YaHei", monospace',
          }}
        />
      </div>
    </DraggablePanel>
  )
}

export default EditPanel
