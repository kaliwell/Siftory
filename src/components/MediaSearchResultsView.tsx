import React, { useEffect, useRef, useState } from 'react'
import type {
  MediaSearchVideoFrameRecord,
  MediaSearchVideoRecord,
  RevealMediaPathInput,
} from '../../shared/ipc-contract'
import { mediaSearchBridge } from '../services/mediaSearchBridge'
import { useVirtualGrid } from '../hooks/useVirtualGrid'
import { useTranslation } from '../i18n/useTranslation'
import { useAssetCollections } from '../hooks/useAssetCollections'
import SearchEmptyState from './SearchEmptyState'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDuration(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '-'
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

interface MediaSearchResultsViewProps {
  frames: MediaSearchVideoFrameRecord[]
  onExtractSubtitles: (videoId: string) => void
  onOpenMedia: (videoId: string, timestampMs?: number) => void
  onRevealPath: (input: RevealMediaPathInput) => void
  onSearchSimilarFrame: (frame: MediaSearchVideoFrameRecord) => void
  selectedPaths: string[]
  videos: MediaSearchVideoRecord[]
  viewMode: 'videos' | 'frames'
}

const FramePreview: React.FC<{ deferLoading: boolean; frame: MediaSearchVideoFrameRecord }> = ({
  deferLoading,
  frame,
}) => {
  const ref = useRef<HTMLDivElement | null>(null)
  const [dataUrl, setDataUrl] = useState(frame.imageDataUrl)

  useEffect(() => {
    setDataUrl(frame.imageDataUrl)
  }, [frame.imageDataUrl, frame.imagePath])

  useEffect(() => {
    if (dataUrl || deferLoading || !frame.imagePath) return
    const node = ref.current
    if (!node) return
    let cancelled = false
    let observer: IntersectionObserver | null = null
    const load = () => {
      void mediaSearchBridge.getFrameImageDataUrl(frame.imagePath as string).then((result) => {
        if (!cancelled && result.ok && result.dataUrl) setDataUrl(result.dataUrl)
      })
    }
    if (typeof IntersectionObserver === 'undefined') {
      load()
    } else {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect()
            load()
          }
        },
        { rootMargin: '180px' },
      )
      observer.observe(node)
    }
    return () => {
      cancelled = true
      observer?.disconnect()
    }
  }, [dataUrl, deferLoading, frame.imagePath])

  return (
    <div
      ref={ref}
      style={{
        height: 82,
        background: 'rgba(var(--fg), 0.08)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        color: 'rgba(var(--date), 0.52)',
      }}
    >
      {dataUrl ? (
        <img src={dataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <span>{frame.status}</span>
      )}
    </div>
  )
}

const MediaSearchResultsView: React.FC<MediaSearchResultsViewProps> = ({
  frames,
  onExtractSubtitles,
  onOpenMedia,
  onRevealPath,
  onSearchSimilarFrame,
  selectedPaths,
  videos,
  viewMode,
}) => {
  const { t } = useTranslation()
  const { collectionId, collections, setCollectionId } = useAssetCollections()
  const [collectionError, setCollectionError] = useState('')
  const collectVideo = async (video: MediaSearchVideoRecord, timestampMs?: number) => {
    if (!collectionId) return
    setCollectionError('')
    try {
      const resolved = await window.electronAPI.assetIdentity.resolve(video.path)
      if (!resolved.ok || !resolved.identity) throw new Error(resolved.error || 'AssetId required')
      await window.electronAPI.assetLibrary.addCollectionItem(collectionId, {
        assetId: resolved.identity.assetId,
        mediaType: timestampMs === undefined ? 'video' : 'video-frame',
        displayName: video.name,
        displayPath: video.path,
        sizeBytes: video.sizeBytes,
        modifiedAt: video.mtimeMs,
        videoId: video.videoId,
        ...(timestampMs !== undefined ? { videoHitMs: timestampMs } : {}),
        source: {
          id: video.sourceId || `media-search:${video.sourceType || 'local'}`,
          name: t(video.sourceType === 'mounted-network' ? 'Mounted network' : 'Local files'),
          type: video.sourceType === 'mounted-network' ? 'mounted-network' : 'local-generic',
          availability: video.missing ? 'offline' : 'online',
        },
      })
    } catch {
      setCollectionError(t('The operation failed.'))
    }
  }
  const collectFrame = async (frame: MediaSearchVideoFrameRecord) => {
    const video = videos.find((item) => item.videoId === frame.videoId)
    if (video) {
      await collectVideo(video, frame.timestampMs)
      return
    }
    if (!collectionId) return
    setCollectionError('')
    try {
      const resolved = await window.electronAPI.assetIdentity.resolve(frame.videoPath)
      if (!resolved.ok || !resolved.identity) throw new Error(resolved.error || 'AssetId required')
      await window.electronAPI.assetLibrary.addCollectionItem(collectionId, {
        assetId: resolved.identity.assetId,
        mediaType: 'video-frame',
        displayName: frame.videoPath.split(/[\\/]/).pop() || frame.videoPath,
        displayPath: frame.videoPath,
        sizeBytes: 0,
        modifiedAt: frame.updatedAt,
        videoId: frame.videoId,
        videoHitMs: frame.timestampMs,
        source: {
          id: 'media-search:local',
          name: t('Local files'),
          type: 'local-generic',
          availability: frame.status === 'unavailable' ? 'offline' : 'online',
        },
      })
    } catch {
      setCollectionError(t('The operation failed.'))
    }
  }
  const activeResults = viewMode === 'frames' ? frames : videos
  const rowHeight = viewMode === 'frames' ? 190 : 96
  const gap = viewMode === 'frames' ? 8 : 0
  const {
    columns,
    contentRef,
    endIndex,
    isScrolling,
    offsetTop,
    rootRef,
    startIndex,
    totalHeight,
  } = useVirtualGrid({
    itemCount: activeResults.length,
    minColumnWidth: viewMode === 'frames' ? 150 : 10000,
    rowHeight,
    gap,
    resetToken: activeResults,
  })
  const visibleFrames = frames.slice(startIndex, endIndex)
  const visibleVideos = videos.slice(startIndex, endIndex)

  return (
    <div
      className="media-search-results-view"
      data-testid="media-search-results"
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div className="media-search-results-toolbar">
        <select
          data-testid="media-search-collection-select"
          value={collectionId}
          onChange={(event) => setCollectionId(Number(event.target.value))}
        >
          <option value={0}>{t('Select collection')}</option>
          {collections.map((collection) => (
            <option key={collection.id} value={collection.id}>
              {collection.name}
            </option>
          ))}
        </select>
        {collectionError ? (
          <span data-testid="media-search-collection-error" style={{ color: '#ff8a8a' }}>
            {collectionError}
          </span>
        ) : null}
      </div>
      <div
        ref={rootRef}
        style={{ flex: 1, overflow: 'auto', borderTop: '1px solid rgba(var(--date), 0.12)' }}
      >
        {viewMode === 'frames' && frames.length > 0 ? (
          <div
            ref={contentRef}
            style={{ contain: 'layout paint', height: totalHeight, position: 'relative' }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                transform: `translate3d(0, ${offsetTop}px, 0)`,
                left: 0,
                right: 0,
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap,
              }}
            >
              {visibleFrames.map((frame) => (
                <div
                  key={frame.frameId}
                  style={{
                    border: '1px solid rgba(var(--date), 0.12)',
                    padding: 6,
                    height: rowHeight,
                    boxSizing: 'border-box',
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                  title={frame.error || frame.videoPath}
                >
                  <FramePreview deferLoading={isScrolling} frame={frame} />
                  <span
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {formatDuration(frame.timestampMs)}
                  </span>
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      opacity: 0.72,
                    }}
                  >
                    {typeof frame.vectorScore === 'number'
                      ? `${Math.round(frame.vectorScore * 1000) / 10}%`
                      : frame.status}
                  </span>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                      gap: 3,
                      flexShrink: 0,
                    }}
                  >
                    <button
                      onClick={() => onOpenMedia(frame.videoId, frame.timestampMs)}
                      style={{ fontSize: 8, padding: '1px 5px' }}
                      title={t('Open media')}
                    >
                      {t('Open')}
                    </button>
                    <button
                      onClick={() => onRevealPath({ videoId: frame.videoId })}
                      style={{ fontSize: 8, padding: '1px 5px' }}
                      title={t('Show in folder')}
                    >
                      {t('Folder')}
                    </button>
                    <button
                      onClick={() => onSearchSimilarFrame(frame)}
                      style={{ fontSize: 8, padding: '1px 5px' }}
                      title={t('Search similar frames')}
                    >
                      {t('Similar')}
                    </button>
                    <button
                      data-testid="media-search-collect-frame"
                      disabled={!collectionId}
                      onClick={() => void collectFrame(frame)}
                    >
                      {t('Collect')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : viewMode === 'videos' && videos.length > 0 ? (
          <div
            ref={contentRef}
            style={{ contain: 'layout paint', height: totalHeight, position: 'relative' }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                transform: `translate3d(0, ${offsetTop}px, 0)`,
                left: 0,
                right: 0,
              }}
            >
              {visibleVideos.map((video) => (
                <article
                  key={video.videoId}
                  className="media-search-video-row"
                  style={{ height: rowHeight }}
                >
                  <div
                    className="media-search-video-row__thumbnail"
                    title={video.thumbnailError || video.thumbnailStatus || t('Thumbnail')}
                  >
                    {video.thumbnailDataUrl ? (
                      <img
                        src={video.thumbnailDataUrl}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    ) : (
                      <span>{t('video')}</span>
                    )}
                  </div>
                  <div className="media-search-video-row__info">
                    <strong title={video.path}>{video.name}</strong>
                    <div className="media-search-video-row__meta">
                      <span>{formatDuration(video.durationMs)}</span>
                      <span>
                        {video.width && video.height ? `${video.width}x${video.height}` : '-'}
                      </span>
                      <span>{video.videoCodec || '-'}</span>
                      <span>{formatBytes(video.sizeBytes)}</span>
                    </div>
                  </div>
                  <div className="media-search-video-row__actions">
                    <button onClick={() => onOpenMedia(video.videoId)}>{t('Open')}</button>
                    <button onClick={() => onRevealPath({ videoId: video.videoId })}>
                      {t('Folder')}
                    </button>
                    <button
                      onClick={() => onExtractSubtitles(video.videoId)}
                      title={t('Extract embedded subtitles')}
                    >
                      {t('Subs')}
                    </button>
                    <button
                      data-testid="media-search-collect-video"
                      disabled={!collectionId}
                      onClick={() => void collectVideo(video)}
                    >
                      {t('Collect')}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : selectedPaths.length === 0 ? (
          <SearchEmptyState
            testId="media-search-empty-state"
            title={t('Add videos to begin')}
            description={t(
              'Choose video files or folders, then prepare the library before searching.',
            )}
          />
        ) : viewMode === 'frames' ? (
          <SearchEmptyState
            testId="media-search-empty-state"
            title={t('No matching video moments')}
            description={t('Try another image or text query, or prepare missing frame indexes.')}
          />
        ) : (
          <>
            <SearchEmptyState
              testId="media-search-empty-state"
              title={t('Video library is not prepared yet')}
              description={t('Use Prepare Library to scan videos and build searchable indexes.')}
            />
            <div className="media-search-selected-paths">
              {selectedPaths.map((pathValue) => (
                <div key={pathValue}>
                  <span title={pathValue}>{pathValue}</span>
                  <button onClick={() => onRevealPath({ scanPath: pathValue })}>
                    {t('Folder')}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default MediaSearchResultsView
