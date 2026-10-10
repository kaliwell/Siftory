import React from 'react'
import type {
  MediaSearchCacheStats,
  MediaSearchFrameEmbeddingStats,
  MediaSearchStatus,
  MediaSearchTaskProgress,
} from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

interface MediaSearchStatusGridProps {
  cacheStats: MediaSearchCacheStats | null
  frameEmbeddingStats: MediaSearchFrameEmbeddingStats | null
  frameReadyCount: number
  frameTotal: number
  framesListed: number
  progress: MediaSearchTaskProgress | null
  queryImagePath: string
  status: MediaSearchStatus
  videoTotal: number
  videosListed: number
}

const MediaSearchStatusGrid: React.FC<MediaSearchStatusGridProps> = ({
  cacheStats,
  frameEmbeddingStats,
  frameReadyCount,
  frameTotal,
  framesListed,
  progress,
  queryImagePath,
  status,
  videoTotal,
  videosListed,
}) => {
  const { t } = useTranslation()
  const cacheLabel = cacheStats ? formatBytes(cacheStats.totalBytes) : t('unknown')
  const cacheDir = status.cacheDir || cacheStats?.cacheDir || '-'
  const totalReadyFrameCount = frameEmbeddingStats?.readyFrames ?? frameReadyCount
  const scanFoundVideos = progress?.scanFoundVideos
  const scanScannedEntries = progress?.scanScannedEntries

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: 6,
        borderTop: '1px solid rgba(var(--date), 0.16)',
        borderBottom: '1px solid rgba(var(--date), 0.16)',
        padding: '6px 0',
      }}
    >
      <span>
        {t('State')}: {t(status.state)}
      </span>
      <span>
        {t('Videos')}: {status.videoCount}
      </span>
      <span>
        {t('Frames')}: {status.indexedFrameCount}
      </span>
      <span>
        {t('Cache')}: {cacheLabel}
      </span>
      <span title={status.ffmpegCommand || status.ffmpegVersion}>
        ffmpeg: {status.ffmpegConfigured ? t('ok') : t('missing')}
      </span>
      <span title={status.ffprobeCommand || status.ffprobeVersion}>
        ffprobe: {status.ffprobeConfigured ? t('ok') : t('missing')}
      </span>
      <span>
        {t('Task')}: {status.activeTaskType ? t(status.activeTaskType) : '-'}
      </span>
      <span>
        {t('Updated')}: {new Date(status.updatedAt).toLocaleTimeString()}
      </span>
      <span>
        {t('Listed')}: {videosListed}
      </span>
      <span>
        {t('Total')}: {videoTotal}
      </span>
      <span
        title={
          progress?.scanCapped
            ? t('Scan entry cap reached; selected drive may be partial')
            : undefined
        }
      >
        {t('Scan found')}: {scanFoundVideos ?? '-'}
      </span>
      <span>
        {t('Frame list')}: {framesListed}
      </span>
      <span>
        {t('Frame total')}: {frameTotal}
      </span>
      <span>
        {t('Scanned')}: {scanScannedEntries ?? '-'}
      </span>
      <span title={`${t('Listed ok')}: ${frameReadyCount}`}>
        {t('Frame ok')}: {totalReadyFrameCount}
      </span>
      <span>
        DINO {t('emb')}: {frameEmbeddingStats?.dinoEmbeddedFrames ?? 0}
      </span>
      <span>
        CLIP {t('emb')}: {frameEmbeddingStats?.clipEmbeddedFrames ?? 0}
      </span>
      <span
        title={cacheDir}
        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {t('Data')}: {cacheDir.split(/[\\/]/).slice(-2).join('\\')}
      </span>
      <span
        title={queryImagePath}
        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {t('Query')}: {queryImagePath ? queryImagePath.split(/[\\/]/).pop() : '-'}
      </span>
    </div>
  )
}

export default MediaSearchStatusGrid
