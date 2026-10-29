import { useEffect, useRef, useState } from 'react'
import type { GlobalHotkeyStatus } from '../../shared/ipc-contract'
import { normalizeGlobalHotkey } from '../../shared/globalHotkey'
import { useTranslation } from '../i18n/useTranslation'

const DEFAULT = 'CommandOrControl+Shift+Alt+Q'
export default function GlobalHotkeyEditor({
  status,
  onStatusChange,
}: {
  status: GlobalHotkeyStatus
  onStatusChange: (status: GlobalHotkeyStatus) => void
}) {
  const { t } = useTranslation()
  const current =
    status.entries.find((entry) => entry.id === 'toggle-primary')?.accelerator ?? DEFAULT
  const [draft, setDraft] = useState(current)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const focused = useRef(false)
  const [recordingReady, setRecordingReady] = useState(false)
  useEffect(() => {
    setDraft(current)
  }, [current])
  useEffect(() => {
    const stop = () => {
      focused.current = false
      setRecordingReady(false)
      void window.electronAPI.setHotkeyRecording?.(false).catch(() => {})
    }
    const unsubscribe = window.electronAPI.onHotkeyRecorded?.((accelerator) => {
      if (!focused.current) return
      const normalized = normalizeGlobalHotkey(accelerator)
      if (normalized) {
        setDraft(normalized)
        setMessage('')
      }
    })
    const timer = setInterval(() => {
      if (focused.current) void window.electronAPI.setHotkeyRecording?.(true).catch(stop)
    }, 10000)
    const resume = () => {
      if (document.activeElement !== inputRef.current) return
      focused.current = true
      void window.electronAPI
        .setHotkeyRecording?.(true)
        .then((ready) => {
          if (focused.current) setRecordingReady(ready)
        })
        .catch(stop)
    }
    window.addEventListener('focus', resume)
    window.addEventListener('blur', stop)
    return () => {
      stop()
      unsubscribe?.()
      clearInterval(timer)
      window.removeEventListener('blur', stop)
      window.removeEventListener('focus', resume)
    }
  }, [])
  const save = async () => {
    if (busy || !normalizeGlobalHotkey(draft)) return
    setBusy(true)
    setMessage('')
    try {
      const result = await window.electronAPI.registerHotkey(draft)
      onStatusChange(result)
      setMessage(result.error ? t(result.error) : t('Shortcut saved'))
    } catch {
      setMessage(t('Could not save shortcut'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="settings-hotkey-editor">
      <label htmlFor="visibility-hotkey">{t('Toggle visibility')}</label>
      <input
        ref={inputRef}
        id="visibility-hotkey"
        onFocus={() => {
          focused.current = true
          void window.electronAPI
            .setHotkeyRecording?.(true)
            .then((ready) => {
              if (focused.current) setRecordingReady(ready)
            })
            .catch(() => setMessage(t('Could not start shortcut recording')))
        }}
        onBlur={() => {
          focused.current = false
          setRecordingReady(false)
          void window.electronAPI.setHotkeyRecording?.(false).catch(() => {})
        }}
        data-testid="visibility-hotkey"
        data-recording-ready={recordingReady}
        readOnly
        disabled={busy}
        value={draft.replace('CommandOrControl', 'Ctrl').replace('Super', 'Win')}
        onKeyDown={(event) => {
          if (
            event.key === 'Tab' &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey &&
            !event.metaKey
          )
            return
          event.preventDefault()
          event.stopPropagation()
          if (!recordingReady) return
          if (
            event.repeat ||
            event.nativeEvent.isComposing ||
            ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)
          )
            return
          const key = event.code.startsWith('Key')
            ? event.code.slice(3)
            : event.code.startsWith('Digit')
              ? event.code.slice(5)
              : event.code === 'Space'
                ? 'Space'
                : event.key.replace('Arrow', '')
          const chord = [
            event.ctrlKey && 'Ctrl',
            event.shiftKey && 'Shift',
            event.altKey && 'Alt',
            event.metaKey && 'Super',
            key,
          ]
            .filter(Boolean)
            .join('+')
          const normalized = normalizeGlobalHotkey(chord)
          if (normalized) {
            setDraft(normalized)
            setMessage('')
          } else setMessage(t('Invalid shortcut'))
        }}
      />
      <small>{t('Focus this field and press a key combination. Save checks for conflicts.')}</small>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button data-testid="save-visibility-hotkey" disabled={busy} onClick={() => void save()}>
          {t('Save shortcut')}
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setDraft(DEFAULT)
            setMessage('')
          }}
        >
          {t('Reset shortcut')}
        </button>
      </div>
      <span role="status">{message ? t(message) : status.error ? t(status.error) : ''}</span>
    </div>
  )
}
