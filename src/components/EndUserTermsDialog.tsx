import React, { useEffect, useId, useRef, useState } from 'react'
import { detectSystemLanguage, translate, type AppLanguage } from '../i18n/core'
import './EndUserTermsDialog.css'

export interface EndUserTermsDocument {
  title: string
  version: string
  publisher: string
  text: string
  sha256: string
  effectiveDate?: string
}

type EndUserTermsDialogProps = {
  terms: EndUserTermsDocument
  language?: AppLanguage
  busy?: boolean
  error?: string
} & (
  | { mode: 'accept'; onAccept: () => void; onReject: () => void; onClose?: never }
  | { mode: 'view'; onClose: () => void; onAccept?: never; onReject?: never }
)

export default function EndUserTermsDialog(props: EndUserTermsDialogProps) {
  // A different document must always start with a fresh, unchecked decision.
  return <TermsContent key={`${props.terms.version}:${props.terms.sha256}`} {...props} />
}

function TermsContent(props: EndUserTermsDialogProps) {
  const { terms, busy = false, error, language = detectSystemLanguage() } = props
  const t = (key: string, values?: Record<string, string | number>) =>
    translate(language, key, values)
  const [agreed, setAgreed] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const errorId = useId()

  useEffect(() => {
    const previousFocus = document.activeElement
    bodyRef.current?.focus()
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (props.mode === 'view' && !busy) props.onClose()
      return
    }
    if (event.key !== 'Tab') return
    const root = rootRef.current
    if (!root) return
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
      ),
    )
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return
    const active = document.activeElement
    if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !root.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <section
      ref={rootRef}
      className="end-user-terms-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy}
      lang={language}
      onKeyDown={handleKeyDown}
      data-testid="end-user-terms-dialog"
    >
      <header className="end-user-terms-header">
        <h1 id={titleId}>{terms.title}</h1>
        <div className="end-user-terms-metadata">
          <span>{t('Terms version: {version}', { version: terms.version })}</span>
          <span>{t('Publisher: {publisher}', { publisher: terms.publisher })}</span>
          {terms.effectiveDate && (
            <span>{t('Effective date: {date}', { date: terms.effectiveDate })}</span>
          )}
        </div>
        <p id={descriptionId}>
          {props.mode === 'accept'
            ? t('Please read the terms before using Siftory. You can decline and exit.')
            : t('You are viewing the terms supplied with this version of Siftory.')}
        </p>
      </header>
      <div
        ref={bodyRef}
        className="end-user-terms-body"
        role="region"
        aria-label={t('Full terms')}
        tabIndex={0}
        data-testid="end-user-terms-text"
      >
        {terms.text}
      </div>
      <footer className="end-user-terms-footer">
        {props.mode === 'accept' && (
          <label className="end-user-terms-agreement">
            <input
              type="checkbox"
              checked={agreed}
              disabled={busy}
              onChange={(event) => setAgreed(event.currentTarget.checked)}
              data-testid="end-user-terms-checkbox"
            />
            <span>{t('I have read and agree to these terms.')}</span>
          </label>
        )}
        {error && (
          <p id={errorId} className="end-user-terms-error" role="alert">
            {error}
          </p>
        )}
        <div className="end-user-terms-actions">
          {props.mode === 'accept' ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!busy) props.onReject()
                }}
                data-testid="end-user-terms-reject"
              >
                {t('Decline and exit')}
              </button>
              <button
                type="button"
                className="end-user-terms-primary"
                disabled={!agreed || busy}
                aria-describedby={error ? errorId : undefined}
                onClick={() => {
                  if (agreed && !busy) props.onAccept()
                }}
                data-testid="end-user-terms-accept"
              >
                {busy ? t('Saving your agreement...') : t('Agree and continue')}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!busy) props.onClose()
              }}
              data-testid="end-user-terms-close"
            >
              {t('Close')}
            </button>
          )}
        </div>
      </footer>
    </section>
  )
}
