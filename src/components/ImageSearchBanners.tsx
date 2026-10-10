import React from 'react'
import { useTranslation } from '../i18n/useTranslation'

export interface ImageSearchToastState {
  msg: string
  type: 'ok' | 'err'
}

interface ImageSearchToastBannerProps {
  toast: ImageSearchToastState | null
}

export const ImageSearchToastBanner: React.FC<ImageSearchToastBannerProps> = ({ toast }) => {
  if (!toast) return null
  return (
    <div
      data-testid="image-search-toast"
      style={{
        padding: '4px 8px',
        background: toast.type === 'err' ? 'rgba(180,40,40,0.55)' : 'rgba(20,130,70,0.45)',
        color: 'rgb(var(--fg))',
        fontSize: 10,
        textAlign: 'center',
        flexShrink: 0,
      }}
    >
      {toast.msg}
    </div>
  )
}

interface ConfirmWholeDriveBannerProps {
  paths: string[] | null
  onConfirm: () => void
  onCancel: () => void
}

export const ConfirmWholeDriveBanner: React.FC<ConfirmWholeDriveBannerProps> = ({
  paths,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation()
  if (!paths) return null
  return (
    <div
      style={{
        padding: '6px 8px',
        borderBottom: '1px solid rgba(255,200,100,0.35)',
        background: 'rgba(120,80,0,0.3)',
        fontSize: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        flexShrink: 0,
      }}
    >
      <span>
        {t('Whole drive scan')}: {paths.join(', ')}
      </span>
      <button onClick={onConfirm} style={{ fontSize: 9, padding: '2px 8px' }}>
        {t('Confirm')}
      </button>
      <button onClick={onCancel} style={{ fontSize: 9, padding: '2px 8px' }}>
        {t('Cancel')}
      </button>
    </div>
  )
}
