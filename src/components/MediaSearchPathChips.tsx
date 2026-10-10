import React from 'react'
import { useTranslation } from '../i18n/useTranslation'

interface MediaSearchPathChipsProps {
  disabled: boolean
  paths: string[]
  onRemovePath: (path: string) => void
}

const MediaSearchPathChips: React.FC<MediaSearchPathChipsProps> = ({
  disabled,
  paths,
  onRemovePath,
}) => {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontSize: 10, opacity: 0.65 }}>
        {t('Scan Paths')} ({paths.length}/64)
      </span>
      {paths.map((pathValue) => (
        <span
          key={pathValue}
          title={pathValue}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            maxWidth: 210,
            padding: '2px 5px',
            background: 'rgba(var(--date),0.12)',
            border: '1px solid rgba(var(--date),0.12)',
            fontSize: 9,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pathValue}
          </span>
          <button
            onClick={() => onRemovePath(pathValue)}
            disabled={disabled}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              opacity: disabled ? 0.35 : 0.8,
              padding: 0,
            }}
          >
            x
          </button>
        </span>
      ))}
    </div>
  )
}

export default MediaSearchPathChips
