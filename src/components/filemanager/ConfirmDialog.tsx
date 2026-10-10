import React from 'react'
import { useTranslation } from '../../i18n/useTranslation'

export interface ConfirmRequest {
  message: string
  detail?: string
  options: { label: string; value: string; primary?: boolean }[]
  onResolve: (value: string) => void
}

interface ConfirmDialogProps {
  request: ConfirmRequest
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({ request }) => {
  const { t } = useTranslation()
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.35)' }} />
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 2001,
          background: 'rgba(var(--bg), 0.97)',
          border: '1px solid rgba(var(--date), 0.5)',
          borderRadius: 6,
          padding: 16,
          minWidth: 320,
          maxWidth: 450,
        }}
      >
        <div style={{ marginBottom: 8, fontSize: 13 }}>{t(request.message)}</div>
        {request.detail && (
          <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 8, wordBreak: 'break-all' }}>
            {request.detail}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {request.options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => request.onResolve(opt.value)}
              style={{
                fontSize: 11,
                padding: '4px 12px',
                background: opt.primary ? 'rgba(0, 200, 100, 0.3)' : undefined,
              }}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

export default ConfirmDialog
