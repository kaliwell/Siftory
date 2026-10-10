import React from 'react'
import { useFMStore } from '../../stores/useFMStore'
import { useTranslation } from '../../i18n/useTranslation'

const ProgressDialog: React.FC = () => {
  const { t } = useTranslation()
  const progress = useFMStore((s) => s.fmProgress)
  const setFMProgress = useFMStore((s) => s.setFMProgress)

  if (!progress) return null

  const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0

  const statusLabel =
    progress.status === 'done'
      ? `✓ ${t('Done')}`
      : progress.status === 'partial'
        ? `⚠ ${t('Partial — some files failed')}`
        : progress.status === 'error'
          ? `✗ ${t('Error')}`
          : t('Copying...')

  const barColor =
    progress.status === 'error'
      ? 'rgb(255,100,100)'
      : progress.status === 'partial'
        ? 'rgb(255,200,50)'
        : 'rgb(var(--fg))'

  const isDone =
    progress.status === 'done' ||
    progress.status === 'partial' ||
    progress.status === 'error' ||
    progress.status === 'cancelled'

  const handleCancel = () => {
    window.electronAPI.fmAbortOperation()
    setFMProgress({ ...progress, status: 'cancelled' })
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 2000,
        background: 'rgba(var(--bg), 0.97)',
        border: '1px solid rgba(var(--date), 0.5)',
        borderRadius: 6,
        padding: 16,
        minWidth: 320,
        maxWidth: 420,
      }}
    >
      <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 500 }}>{statusLabel}</div>

      {progress.currentFile && (
        <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 8, wordBreak: 'break-all' }}>
          {progress.currentFile}
        </div>
      )}

      {/* Progress bar */}
      <div
        style={{
          height: 6,
          background: 'rgba(var(--date), 0.25)',
          borderRadius: 3,
          marginBottom: 8,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: barColor,
            borderRadius: 3,
            transition: 'width 0.2s',
          }}
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, opacity: 0.6 }}>
        <span>
          {progress.completed} / {progress.total} {t('files')}
        </span>
        <span>{pct}%</span>
      </div>

      {progress.error && (
        <div style={{ fontSize: 10, color: 'rgb(255,100,100)', marginTop: 6 }}>
          {progress.error}
        </div>
      )}

      {progress.failedFiles && progress.failedFiles.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 2 }}>{t('Failed')}:</div>
          <div style={{ maxHeight: 80, overflowY: 'auto', fontSize: 9 }}>
            {progress.failedFiles.map((name, i) => (
              <div key={i} style={{ color: 'rgb(255,150,100)', paddingLeft: 8, lineHeight: 1.6 }}>
                • {name}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
        {!isDone && (
          <button onClick={handleCancel} style={{ background: 'rgba(255,120,80,0.25)' }}>
            {t('Cancel')}
          </button>
        )}
        {isDone && <button onClick={() => setFMProgress(null)}>{t('Close')}</button>}
      </div>
    </div>
  )
}

export default ProgressDialog
