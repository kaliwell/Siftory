import React from 'react'
import { useTranslation } from '../i18n/useTranslation'

interface RecentManifestBarProps {
  manifests: string[]
  onLoad: (manifestPath: string) => void
}

const RecentManifestBar: React.FC<RecentManifestBarProps> = ({ manifests, onLoad }) => {
  const { t } = useTranslation()
  if (manifests.length === 0) return null

  return (
    <div
      style={{
        padding: '3px 6px',
        borderTop: '1px solid rgba(var(--date),0.12)',
        flexShrink: 0,
        fontSize: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <div style={{ opacity: 0.5, flexShrink: 0 }}>{t('Recent')}:</div>
      <div style={{ display: 'flex', gap: 3, overflowX: 'auto', minWidth: 0 }}>
        {manifests.map((p) => (
          <button
            key={p}
            onClick={() => onLoad(p)}
            style={{ fontSize: 9, padding: '2px 6px', opacity: 0.7 }}
            title={p}
          >
            {p.split('\\').pop() || p.split('/').pop() || p}
          </button>
        ))}
      </div>
    </div>
  )
}

export default RecentManifestBar
