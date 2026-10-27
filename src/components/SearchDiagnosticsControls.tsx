import React, { useState } from 'react'
import { useTranslation } from '../i18n/useTranslation'

export default function SearchDiagnosticsControls({ traceId }: { traceId?: string }) {
  const { t } = useTranslation()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (operation: 'export' | 'clear' | 'report' | 'copy') => {
    const api = window.electronAPI?.imageSearch
    if (!api || busy) return
    setBusy(true)
    try {
      const result =
        operation === 'copy' && traceId
          ? await api.saveSearchQueryCopy(traceId)
          : operation === 'export'
            ? await api.exportSearchDiagnostics()
            : operation === 'clear'
              ? await api.clearSearchDiagnostics()
              : traceId
                ? await api.reportSearchDiagnostic(traceId, 'incorrect')
                : { ok: false }
      if ('cancelled' in result && result.cancelled) return
      setMessage(t(result.ok ? 'Diagnostic operation complete' : 'Diagnostic operation failed'))
    } catch {
      setMessage(t('Diagnostic operation failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details
      className="search-diagnostics-controls"
      onToggle={(event) => {
        if (!event.currentTarget.open) return
        void window.electronAPI?.imageSearch
          .getSearchDiagnosticStatus?.()
          .then((status) => {
            if (status?.error || status?.dropped > 0)
              setMessage(t('Some diagnostic records could not be saved'))
          })
          .catch(() => setMessage(t('Diagnostic operation failed')))
      }}
    >
      <summary>{t('Search diagnostics')}</summary>
      <p>
        {t(
          'Basic diagnostics do not copy images. Logs stay local, rotate at 20 MiB and expire after 14 days.',
        )}
      </p>
      <button disabled={busy || !traceId} onClick={() => void run('report')}>
        {t('These results are incorrect')}
      </button>
      <button disabled={busy} onClick={() => void run('export')}>
        {t('Export search diagnostics')}
      </button>
      <button disabled={busy} onClick={() => void run('clear')}>
        {t('Clear search diagnostics')}
      </button>
      {traceId && (
        <small>
          {t('Query ID')}: {traceId}
        </small>
      )}
      <button disabled={busy || !traceId} onClick={() => void run('copy')}>
        {t('Save query copy for reproduction')}
      </button>
      <small>
        {t(
          'Optional query copies are included in exports. Up to four copies, 2 MiB each, 8 MiB total. Changed or unavailable inputs cannot be saved.',
        )}
      </small>
      <span role="status">{message}</span>
    </details>
  )
}
