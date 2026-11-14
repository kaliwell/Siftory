import React, { useEffect, useState } from 'react'
import { useTranslation } from '../i18n/useTranslation'
import { setManualPerformanceSampling } from '../hooks/useScanResponsiveness'

export default function PerformanceDiagnosticsControls() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let alive = true
    void window.electronAPI?.imageSearch
      .performanceDiagnostics?.('status')
      .then((status) => {
        if (!alive || !status?.ok) return
        setEnabled(!!status.enabled)
        setManualPerformanceSampling(!!status.enabled)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const run = async (action: 'start' | 'mark' | 'stop-export' | 'export') => {
    const api = window.electronAPI?.imageSearch.performanceDiagnostics
    if (!api || busy) return
    setBusy(true)
    try {
      document.dispatchEvent(new Event('siftory:flush-performance'))
      const result = await api(action === 'stop-export' ? 'stop' : action)
      if (!result?.ok) throw new Error('diagnostic operation failed')
      setEnabled(!!result.enabled)
      setManualPerformanceSampling(!!result.enabled)
      const incomplete = !!result.error || (result.dropped ?? 0) > 0
      if (action === 'stop-export') {
        const saved = await api('export')
        if (saved?.cancelled) {
          setMessage(t('Recording stopped; logs remain saved locally'))
          return
        }
        if (!saved?.ok) throw new Error('diagnostic export failed')
      }
      if (result.cancelled) return
      setMessage(
        t(
          incomplete
            ? 'Some diagnostic records could not be saved'
            : action === 'start'
              ? 'Recording started; reproduce the stutter now'
              : action === 'mark'
                ? 'Stutter marked'
                : 'Diagnostic operation complete',
        ),
      )
    } catch {
      setMessage(t('Diagnostic operation failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="search-diagnostics-controls" data-testid="performance-diagnostics">
      <summary>
        {t('Stutter diagnostics')}
        {enabled ? ` · ${t('Recording')}` : ''}
      </summary>
      <p>
        {t(
          'Start recording, reproduce the stutter, then stop and export. Logs stay local and contain no images or source paths. Recording continues when switching pages.',
        )}
      </p>
      <button disabled={busy || enabled} onClick={() => void run('start')}>
        {t('Start recording')}
      </button>
      <button disabled={busy || !enabled} onClick={() => void run('mark')}>
        {t('Mark stutter')}
      </button>
      <button disabled={busy || !enabled} onClick={() => void run('stop-export')}>
        {t('Stop and export')}
      </button>
      <button disabled={busy} onClick={() => void run('export')}>
        {t('Export recorded logs')}
      </button>
      <p>
        {t(
          'Logs rotate at 20 MiB and expire after 14 days. If the app stops responding, logs already written remain on disk; the stall duration is recorded after it recovers.',
        )}
      </p>
      <span role="status">{message}</span>
    </details>
  )
}
