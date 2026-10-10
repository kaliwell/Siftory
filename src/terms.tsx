import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import EndUserTermsDialog from './components/EndUserTermsDialog'
import { detectSystemLanguage, translate } from './i18n/core'
import type { TermsWindowAPI, TermsWindowPayload } from '../shared/ipc/end-user-terms'

declare global {
  interface Window {
    termsAPI: TermsWindowAPI
  }
}

function TermsApplication() {
  const [payload, setPayload] = useState<TermsWindowPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const t = (key: string) => translate(payload?.language ?? detectSystemLanguage(), key)
  useEffect(() => {
    void window.termsAPI
      .get()
      .then(setPayload)
      .catch(() => setError('Could not load the terms. Close this window and restart Siftory.'))
  }, [])
  const close = () => {
    setBusy(true)
    void window.termsAPI.close().catch(() => {
      setBusy(false)
      setError('Could not close the terms window. Please use the window close button.')
    })
  }
  const accept = async () => {
    if (!payload || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await window.termsAPI.accept({
        version: payload.terms.version,
        sha256: payload.terms.sha256,
      })
      if (!result.ok) {
        setError(
          result.reason === 'stale-terms'
            ? 'The terms have changed. Close this window and restart Siftory to review them.'
            : 'Could not save your agreement. Please try again or decline and exit.',
        )
        setBusy(false)
      }
    } catch {
      setError('Could not save your agreement. Please try again or decline and exit.')
      setBusy(false)
    }
  }
  if (!payload)
    return <main role={error ? 'alert' : 'status'}>{t(error || 'Loading terms...')}</main>
  return payload.mode === 'accept' ? (
    <EndUserTermsDialog
      terms={payload.terms}
      language={payload.language}
      mode="accept"
      busy={busy}
      error={error ? t(error) : undefined}
      onAccept={() => void accept()}
      onReject={close}
    />
  ) : (
    <EndUserTermsDialog
      terms={payload.terms}
      language={payload.language}
      mode="view"
      busy={busy}
      error={error ? t(error) : undefined}
      onClose={close}
    />
  )
}

createRoot(document.getElementById('root')!).render(<TermsApplication />)
