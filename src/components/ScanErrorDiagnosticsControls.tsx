import React, { useState } from 'react'
import { useTranslation } from '../i18n/useTranslation'

export default function ScanErrorDiagnosticsControls() {
  const { t } = useTranslation()
  const [includePaths, setIncludePaths] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const run = async (action: 'status' | 'export') => {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      const result = await window.electronAPI?.imageSearch.scanErrorDiagnostics?.(
        action,
        includePaths,
      )
      if (result?.cancelled) return
      if (!result?.ok) {
        setMessage(t('Diagnostic operation failed'))
        return
      }
      setMessage(
        result.error || (result.dropped ?? 0) > 0
          ? t('Some diagnostic records could not be saved')
          : action === 'export'
            ? t('Diagnostic operation complete')
            : t('Captured {count} error and skip records', {
                count: result.capturedThisSession ?? 0,
              }),
      )
    } catch {
      setMessage(t('Diagnostic operation failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details
      className="search-diagnostics-controls"
      data-testid="scan-error-diagnostics"
      onToggle={(event) => {
        if (event.currentTarget.open) void run('status')
      }}
    >
      <summary>{t('Scan and preview error logs')}</summary>
      <p>
        {t(
          'Errors and skipped files are collected automatically. Export after library preparation finishes or fails; no separate recording step is needed.',
        )}
      </p>
      <label>
        <input
          type="checkbox"
          checked={includePaths}
          onChange={(event) => setIncludePaths(event.target.checked)}
        />
        {t('Include file paths from this app session')}
      </label>
      <p>
        {t(
          'Default export hides paths and includes the latest scan only. Path mapping is available until the app exits. No images are included.',
        )}
      </p>
      <button disabled={busy} onClick={() => void run('export')}>
        {t('Export error logs')}
      </button>
      <span role="status">{message}</span>
    </details>
  )
}
