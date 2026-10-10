import React from 'react'
import type { ImageSearchStatus } from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'

type AutoloadState = 'idle' | 'loading' | 'ok' | 'err'

interface ImageSearchIndexFooterProps {
  status: ImageSearchStatus
  manifestPath: string
  autoloadState: AutoloadState
  onReload: () => void
  onClear: () => void
  onOpenIndexDir: () => void
}

const ImageSearchIndexFooter: React.FC<ImageSearchIndexFooterProps> = ({
  status,
  manifestPath,
  autoloadState,
  onReload,
  onClear,
  onOpenIndexDir,
}) => {
  const { t } = useTranslation()
  const autoloadColor =
    autoloadState === 'ok'
      ? 'rgb(100,255,150)'
      : autoloadState === 'loading'
        ? 'rgb(255,200,100)'
        : 'rgb(255,100,100)'

  return (
    <div
      style={{
        padding: '4px 6px',
        borderTop: '1px solid rgba(var(--date),0.15)',
        flexShrink: 0,
        fontSize: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          opacity: 0.68,
          marginBottom: 3,
          fontSize: 9,
          alignItems: 'center',
        }}
      >
        <span>
          {t('Mode')}: {status.indexMode || t('memory')}
        </span>
        <span>
          {t('Segments')}: {status.segmentCount ?? '-'}
        </span>
        <span>
          {t('Records')}: {status.indexedCount}
        </span>
        {status.pathIndexMapSize != null && <span>pmap: {status.pathIndexMapSize}</span>}
        {status.overlayCount != null && status.overlayCount > 0 && (
          <span style={{ color: 'rgb(100,255,150)' }}>ovl: {status.overlayCount}</span>
        )}
        {status.replacedCount != null && status.replacedCount > 0 && (
          <span style={{ color: 'rgb(255,200,100)' }}>rep: {status.replacedCount}</span>
        )}
        {status.deletedCount != null && status.deletedCount > 0 && (
          <span style={{ color: 'rgb(255,100,100)' }}>del: {status.deletedCount}</span>
        )}
        {autoloadState !== 'idle' && (
          <span style={{ color: autoloadColor }}>AL:{autoloadState}</span>
        )}
        {status.autoloadSource && status.autoloadSource !== 'none' && (
          <span style={{ opacity: 0.5 }}>src:{status.autoloadSource}</span>
        )}
        {manifestPath && (
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 100,
              opacity: 0.5,
            }}
            title={manifestPath}
          >
            {manifestPath.split('\\').pop()}
          </span>
        )}
      </div>

      {status.indexedCount > 0 && status.pathIndexMapSize === 0 && (
        <div style={{ color: 'rgb(255,100,100)', fontSize: 9, marginBottom: 2 }}>
          {t('Path map missing - Add New will be slow (reload manifest to rebuild)')}
        </div>
      )}
      {status.pathMapHealthy === false &&
        status.pathIndexMapSize != null &&
        status.pathIndexMapSize > 0 && (
          <div style={{ color: 'rgb(255,200,100)', fontSize: 9, marginBottom: 2 }}>
            {t('Path map incomplete ({mapped}/{total}) - some files may not skip', {
              mapped: status.pathIndexMapSize,
              total: status.indexedCount,
            })}
          </div>
        )}
      {status.backend &&
        status.backend !== 'USN' &&
        status.fallbackReason?.includes('access denied') && (
          <div style={{ color: 'rgb(255,200,100)', fontSize: 9, marginBottom: 2 }}>
            {t('USN unavailable: run as administrator to enable fast NTFS scan')}
          </div>
        )}
      {status.usnRequiresAdmin && (
        <div style={{ color: 'rgb(255,200,100)', fontSize: 9, marginBottom: 2 }}>
          {t('USN requires admin - run as administrator for 10-100x faster scanning')}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4 }}>
        <button onClick={onReload} style={{ fontSize: 9, padding: '2px 6px' }}>
          {t('Reload')}
        </button>
        <button onClick={onClear} style={{ fontSize: 9, padding: '2px 6px' }}>
          {t('Clear')}
        </button>
        <button
          onClick={onOpenIndexDir}
          style={{ fontSize: 9, padding: '2px 6px', opacity: 0.7 }}
          title={t('Open index folder in Explorer')}
        >
          {t('Index folder')}
        </button>
      </div>
    </div>
  )
}

export default ImageSearchIndexFooter
