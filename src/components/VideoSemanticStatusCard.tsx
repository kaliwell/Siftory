import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MediaSearchVideoRecord,
  VideoSemanticControlResult,
  VideoSemanticUiStatus,
} from '../../shared/ipc-contract'
import type { VideoSemanticProfileId } from '../../shared/videoSemantic'
import { useTranslation } from '../i18n/useTranslation'
import { mediaSearchBridge } from '../services/mediaSearchBridge'

const runtimeLabels: Record<string, string> = {
  'not-installed': 'Not installed',
  ready: 'Ready',
  busy: 'Busy',
  unavailable: 'Unavailable',
  error: 'Error',
}

export interface VideoSemanticStatusCardProps {
  videos?: MediaSearchVideoRecord[]
  compact?: boolean
}

const VideoSemanticStatusCard: React.FC<VideoSemanticStatusCardProps> = ({
  videos = [],
  compact = false,
}) => {
  const { t } = useTranslation()
  const [selectedVideoId, setSelectedVideoId] = useState('')
  const [status, setStatus] = useState<VideoSemanticUiStatus | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const refreshInFlightRef = useRef(false)

  useEffect(() => {
    if (compact || selectedVideoId || videos.length === 0) return
    setSelectedVideoId(videos[0].videoId)
  }, [compact, selectedVideoId, videos])

  const refresh = useCallback(
    async (forceRefresh = false) => {
      if (refreshInFlightRef.current) return
      refreshInFlightRef.current = true
      try {
        const next = await mediaSearchBridge.getVideoSemanticStatus(
          compact || !selectedVideoId ? undefined : selectedVideoId,
          forceRefresh,
        )
        if (next) setStatus(next)
      } finally {
        refreshInFlightRef.current = false
      }
    },
    [compact, selectedVideoId],
  )

  const activelyBuilding = status?.jobs.some(
    (job) => job.state === 'running' || job.state === 'queued',
  )
  useEffect(() => {
    const initialTimer = window.setTimeout(() => void refresh(false), 250)
    const interval = window.setInterval(
      () => {
        void refresh(false)
      },
      activelyBuilding ? 3_000 : 15_000,
    )
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(interval)
    }
  }, [activelyBuilding, refresh])

  const latestJob = useMemo(
    () => [...(status?.jobs ?? [])].sort((left, right) => right.updatedAt - left.updatedAt)[0],
    [status?.jobs],
  )
  const percent = latestJob
    ? Math.round(
        ((latestJob.completedSegments + latestJob.failedSegments) /
          Math.max(1, latestJob.totalSegments)) *
          100,
      )
    : 0

  const applyResult = useCallback(
    (result: VideoSemanticControlResult) => {
      if (result.status) setStatus(result.status)
      setMessage(result.ok ? '' : result.error || t('The operation failed.'))
    },
    [t],
  )

  const run = useCallback(
    async (operation: () => Promise<VideoSemanticControlResult>) => {
      setLoading(true)
      try {
        applyResult(await operation())
      } finally {
        setLoading(false)
      }
    },
    [applyResult],
  )

  const runtimeLabel = status
    ? runtimeLabels[status.runtime.state] || status.runtime.state
    : 'Loading...'
  const modelLabel = status?.runtime.model
    ? `${status.runtime.model.modelId} ${status.runtime.model.quantization}`
    : status?.runtime.reason && status.runtime.reason !== 'model-missing'
      ? status.runtime.reason
      : t('Model not installed')

  return (
    <section
      data-testid="video-semantic-status"
      style={{
        border: '1px solid rgba(var(--fg), 0.16)',
        borderRadius: 6,
        padding: compact ? 6 : 8,
        display: 'grid',
        gap: 6,
        background: 'rgba(var(--fg), 0.035)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>{t('Deep video semantics')}</strong>
        <span data-testid="video-semantic-runtime-state">{t(runtimeLabel)}</span>
        <span style={{ opacity: 0.68 }}>{modelLabel}</span>
        <span style={{ marginLeft: 'auto', opacity: 0.72 }}>
          {t('Indexed videos')}: {status?.activeVideos ?? 0} · {t('Segments')}:{' '}
          {status?.activeSegments ?? 0}
        </span>
        <button type="button" onClick={() => void refresh(true)} disabled={loading}>
          {t('Refresh')}
        </button>
      </div>

      {!compact && (
        <>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              aria-label={t('Video')}
              value={selectedVideoId}
              onChange={(event) => {
                setSelectedVideoId(event.target.value)
                setMessage('')
              }}
              style={{ minWidth: 220, flex: 1 }}
            >
              {videos.length === 0 && <option value="">{t('No videos')}</option>}
              {videos.map((video) => (
                <option key={video.videoId} value={video.videoId}>
                  {video.name}
                </option>
              ))}
            </select>
            <select
              aria-label={t('Video profile')}
              value={status?.profileOverride ?? 'auto'}
              disabled={!selectedVideoId || loading}
              onChange={(event) => {
                const profileId = event.target.value as VideoSemanticProfileId | 'auto'
                void run(() =>
                  mediaSearchBridge.setVideoSemanticProfile(selectedVideoId, profileId),
                )
              }}
            >
              <option value="auto">{t('Auto profile')}</option>
              {(status?.profiles ?? []).map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.displayName}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="video-semantic-build"
              disabled={!status?.canBuild || loading}
              onClick={() =>
                void run(() => mediaSearchBridge.startVideoSemanticBuild(selectedVideoId))
              }
            >
              {status?.activeGenerationId ? t('Rebuild video') : t('Build video')}
            </button>
            <button
              type="button"
              disabled={!status?.canStop || !latestJob || loading}
              onClick={() =>
                latestJob && void run(() => mediaSearchBridge.stopVideoSemanticJob(latestJob.jobId))
              }
            >
              {t('Stop')}
            </button>
            <button
              type="button"
              disabled={!status?.canResume || !latestJob || loading}
              onClick={() =>
                latestJob &&
                void run(() => mediaSearchBridge.resumeVideoSemanticJob(latestJob.jobId))
              }
            >
              {t('Resume')}
            </button>
          </div>

          {latestJob && (
            <div data-testid="video-semantic-progress" style={{ display: 'grid', gap: 3 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.78 }}>
                <span>
                  {latestJob.state} · {latestJob.completedSegments}/{latestJob.totalSegments}
                  {latestJob.failedSegments > 0
                    ? ` · ${t('failed')} ${latestJob.failedSegments}`
                    : ''}
                </span>
                <span>{percent}%</span>
              </div>
              <div style={{ height: 5, background: 'rgba(var(--fg), 0.12)' }}>
                <div
                  style={{
                    width: `${percent}%`,
                    height: '100%',
                    background: latestJob.failedSegments
                      ? 'rgba(255, 160, 80, 0.9)'
                      : 'rgba(0, 220, 140, 0.85)',
                  }}
                />
              </div>
            </div>
          )}
        </>
      )}

      {(message || latestJob?.lastError) && (
        <div style={{ color: 'rgb(255, 180, 110)', opacity: 0.9 }}>
          {message || latestJob?.lastError}
        </div>
      )}
    </section>
  )
}

export default VideoSemanticStatusCard
