import React from 'react'
import type { ImageSearchStatus } from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'

interface ImageSearchStatusBarProps {
  status: ImageSearchStatus
  isScanning: boolean
  vectorIndexStatus?: {
    built: boolean
    count: number
    modelName?: string
    dim?: number
  }
}

const ImageSearchStatusBar: React.FC<ImageSearchStatusBarProps> = ({
  status,
  isScanning,
  vectorIndexStatus,
}) => {
  const { t } = useTranslation()
  return (
    <div
      style={{
        padding: '4px 6px',
        borderBottom: '1px solid rgba(var(--date),0.12)',
        flexShrink: 0,
        fontSize: 10,
        opacity: 0.78,
      }}
    >
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span>
          {t('State')}: {t(status.state)}
        </span>
        <span>
          {t('Mode')}: {t(status.indexMode || 'memory')}
          {status.indexMode === 'segment_mmap' && status.segmentVersion
            ? ` ${t('Version {version}', { version: status.segmentVersion })}`
            : ''}
        </span>
        <span title={t('Hash Retrieval')}>
          {t('Index')}: {status.indexedCount.toLocaleString()}
        </span>
        {vectorIndexStatus?.built && (
          <span
            title={t('{model} / {dimension}D', {
              model: vectorIndexStatus.modelName || 'DINO',
              dimension: vectorIndexStatus.dim || 0,
            })}
          >
            {t('Vector index built')}: {vectorIndexStatus.count.toLocaleString()}
          </span>
        )}
        {status.newCount != null && status.newCount > 0 && (
          <span style={{ color: 'rgb(100,255,150)' }}>
            {t('New')}: {status.newCount}
          </span>
        )}
        {status.skippedIndexed != null && status.skippedIndexed > 0 && (
          <span style={{ opacity: 0.6 }} title={t('Already present in the index')}>
            {t('Existing')}: {status.skippedIndexed.toLocaleString()}
          </span>
        )}
        {status.skippedUnchanged != null && status.skippedUnchanged > 0 && (
          <span style={{ opacity: 0.6 }}>
            {t('Unchanged')}: {status.skippedUnchanged}
          </span>
        )}
        {status.updatedCount != null && status.updatedCount > 0 && (
          <span style={{ color: 'rgb(255,200,100)' }}>
            {t('Updated')}: {status.updatedCount}
          </span>
        )}
        {status.skippedCount != null && status.skippedCount > 0 && (
          <span
            style={{ color: 'rgb(255,200,100)', opacity: 0.75 }}
            title={t('Files that could not be read or decoded')}
          >
            {t('Unreadable')}: {status.skippedCount.toLocaleString()}
          </span>
        )}
        {status.signatureRejectedCount != null && status.signatureRejectedCount > 0 && (
          <span
            style={{ opacity: 0.6 }}
            title={t('Extension matched but image signature was invalid')}
          >
            {t('Rejected')}: {status.signatureRejectedCount.toLocaleString()}
          </span>
        )}
        {status.durationMs != null && !isScanning && (
          <span style={{ opacity: 0.5 }}>{(status.durationMs / 1000).toFixed(1)}s</span>
        )}
        {status.lastError && (
          <span style={{ color: 'rgb(255,100,100)' }}>
            {t('Error')}: {status.lastError}
          </span>
        )}
        {status.lastWarning && !status.lastError && (
          <span
            style={{
              color: 'rgb(255,200,100)',
              opacity: 0.7,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 200,
            }}
          >
            {t('Warning')}: {status.lastWarning}
          </span>
        )}
      </div>
      {isScanning && (status.currentPath || status.message) && (
        <div
          title={status.currentPath}
          style={{
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            opacity: 0.75,
          }}
        >
          {status.message ? t(status.message) : t('Scanning...')}
          {status.currentPath ? ` | ${status.currentPath}` : ''}
        </div>
      )}
      {isScanning && status.scanWorkerCount != null && status.scanWorkerCount > 0 && (
        <div style={{ marginTop: 2, opacity: 0.62 }}>
          {t('Workers {active}/{total} · queue {pending}/{capacity}', {
            active: status.scanActiveWorkers || 0,
            total: status.scanWorkerCount,
            pending: status.scanQueuePending || 0,
            capacity: status.scanQueueCapacity || 0,
          })}
        </div>
      )}
      {status.thumbnailEnabled && (
        <div style={{ marginTop: 2, opacity: 0.62 }}>
          {t('Native thumbs')}: {status.thumbnailCompleted || 0}/{status.thumbnailQueued || 0}
          {status.thumbnailPending ? ` · ${t('pending')} ${status.thumbnailPending}` : ''}
          {status.thumbnailWorkerCount
            ? ` · ${t('workers')} ${status.thumbnailWorkerCount} (${t(status.thumbnailPhase || 'scan')})`
            : ''}
          {status.thumbnailDeferred ? ` · ${t('deferred')} ${status.thumbnailDeferred}` : ''}
          {status.thumbnailFillCompleted
            ? ` · ${t('filled')} ${status.thumbnailFillCompleted}`
            : ''}
          {status.thumbnailDropped ? ` · ${t('dropped')} ${status.thumbnailDropped}` : ''}
          {status.thumbnailFailed ? ` · ${t('failed')} ${status.thumbnailFailed}` : ''}
          {status.thumbnailInputReused
            ? ` · ${t('input reused')} ${status.thumbnailInputReused}`
            : ''}
          {status.thumbnailSourceReads
            ? ` · ${t('source reads')} ${status.thumbnailSourceReads}`
            : ''}
        </div>
      )}
      {!isScanning && status.backend && (
        <div
          title={status.fallbackReason}
          style={{
            marginTop: 2,
            opacity: 0.55,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {t('Scanner')}: {t(status.backend === 'enum' ? 'directory enumeration' : status.backend)}
          {status.enumMs != null && status.enumMs > 0
            ? ` | ${t('Enumerate {seconds}s', { seconds: (status.enumMs / 1000).toFixed(1) })}`
            : ''}
          {status.decodeMsTotal != null && status.decodeMsTotal > 0
            ? ` | ${t('Decode {seconds}s', { seconds: (status.decodeMsTotal / 1000).toFixed(1) })}`
            : ''}
          {status.enumDirCount != null
            ? ` | ${t('{count} dirs', { count: status.enumDirCount.toLocaleString() })}`
            : ''}
          {status.enumFileCount != null
            ? ` | ${t('{count} files', { count: status.enumFileCount.toLocaleString() })}`
            : ''}
          {status.enumSkippedDirCount != null && status.enumSkippedDirCount > 0
            ? ` | ${t('{count} dirs skipped', {
                count: status.enumSkippedDirCount.toLocaleString(),
              })}`
            : ''}
        </div>
      )}
      {status.backend === 'enum' && status.fallbackReason && (
        <div
          style={{
            marginTop: 2,
            color: status.usnRequiresAdmin ? 'rgb(255,200,100)' : undefined,
            opacity: 0.68,
          }}
        >
          {t('USN unavailable')}: {status.fallbackReason}
          {status.fallbackAction ? ` · ${t(status.fallbackAction)}` : ''}
        </div>
      )}
    </div>
  )
}

export default ImageSearchStatusBar
