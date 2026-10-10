import React, { useState } from 'react'
import { useTranslation } from '../i18n/useTranslation'

export default function EndUserTermsButton() {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const view = async () => {
    if (busy) return
    setBusy(true)
    setStatus('')
    try {
      const result = await window.electronAPI?.viewEndUserTerms()
      if (!result?.ok)
        setStatus(
          result?.reason === 'not-published'
            ? 'This review version has no published user agreement.'
            : 'Could not open the user agreement. Restore the application files and try again.',
        )
    } catch {
      setStatus('Could not open the user agreement. Restore the application files and try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        data-testid="settings-end-user-terms"
        disabled={busy}
        onClick={() => void view()}
        style={{ width: '100%', fontSize: 11, padding: '4px 8px' }}
      >
        {t('User agreement')}
      </button>
      <div role="status" aria-live="polite" style={{ fontSize: 10, marginTop: 4 }}>
        {status ? t(status) : ''}
      </div>
    </div>
  )
}
