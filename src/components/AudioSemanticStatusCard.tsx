import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AudioSemanticControlResult,
  AudioSemanticUiStatus,
  MediaSearchVideoRecord,
} from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'
import { mediaSearchBridge } from '../services/mediaSearchBridge'

const runtimeLabels: Record<string, string> = {
  'not-installed': 'Not installed',
  ready: 'Ready',
  busy: 'Busy',
  unavailable: 'Unavailable',
  error: 'Error',
}

function formatTimestamp(value?: number): string {
  if (value === undefined) return '--:--'
  const totalSeconds = Math.max(0, Math.floor(value / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

const AudioSemanticStatusCard: React.FC<{
  compact?: boolean
  videos?: MediaSearchVideoRecord[]
}> = ({ compact = false, videos = [] }) => {
  const { t } = useTranslation()
  const [status, setStatus] = useState<AudioSemanticUiStatus | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedVideoId, setSelectedVideoId] = useState('')
  const refreshInFlightRef = useRef(false)

  const refresh = useCallback(async (forceRefresh = false) => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    try {
      const next = await mediaSearchBridge.getAudioSemanticStatus(forceRefresh)
      if (next) setStatus(next)
    } finally {
      refreshInFlightRef.current = false
    }
  }, [])

  const activelyBuilding = status?.job?.state === 'running' || status?.job?.state === 'queued'
  useEffect(() => {
    const initialTimer = window.setTimeout(() => void refresh(false), 250)
    const interval = window.setInterval(
      () => void refresh(false),
      activelyBuilding ? 3_000 : status?.statsPending ? 1_000 : 15_000,
    )
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(interval)
    }
  }, [activelyBuilding, refresh, status?.statsPending])

  const progress = useMemo(() => {
    const job = status?.job
    if (!job) return 0
    return Math.min(
      100,
      Math.round(
        ((job.completedSegments + job.failedSegments) / Math.max(1, job.totalSegments)) * 100,
      ),
    )
  }, [status?.job])

  const applyResult = useCallback(
    (result: AudioSemanticControlResult) => {
      if (result.status) setStatus(result.status)
      setMessage(result.ok ? '' : result.error || t('The operation failed.'))
    },
    [t],
  )

  const run = useCallback(
    async (operation: () => Promise<AudioSemanticControlResult>) => {
      setLoading(true)
      try {
        applyResult(await operation())
        window.setTimeout(() => void refresh(), 250)
      } finally {
        setLoading(false)
      }
    },
    [applyResult, refresh],
  )

  const capabilities = status?.capabilities
  const job = status?.job
  return (
    <section
      data-testid="audio-semantic-status"
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
        <strong>{t('Audio semantics')}</strong>
        <span data-testid="audio-semantic-runtime-state">
          {t(runtimeLabels[status?.runtime.state ?? ''] || 'Loading…')}
        </span>
        {status?.runtime.reason ? (
          <span style={{ opacity: 0.68 }}>{t(status.runtime.reason)}</span>
        ) : status?.runtime.model ? (
          <span style={{ opacity: 0.68 }}>
            {status.runtime.model.modelId} · {status.runtime.model.runtime.toUpperCase()} · CPU
          </span>
        ) : null}
        <span style={{ marginLeft: 'auto', opacity: 0.72 }}>
          {t('Indexed videos')}: {status?.indexedVideos ?? 0} · {t('Segments')}:{' '}
          {status?.indexedSegments ?? 0}
          {status?.statsPending ? ` · ${t('Updating statistics...')}` : ''}
        </span>
        <button type="button" onClick={() => void refresh(true)} disabled={loading}>
          {t('Refresh')}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ opacity: 0.72 }}>
          {t('Eligible videos')}: {status?.eligibleVideos ?? 0}
        </span>
        {!compact && (
          <select
            aria-label={t('Video')}
            value={selectedVideoId}
            onChange={(event) => setSelectedVideoId(event.target.value)}
            style={{ minWidth: 220, flex: 1 }}
          >
            <option value="">{t('All eligible videos')}</option>
            {videos
              .filter((video) => !video.missing && video.audioCodec && video.durationMs)
              .map((video) => (
                <option key={video.videoId} value={video.videoId}>
                  {video.name}
                </option>
              ))}
          </select>
        )}
        <button
          type="button"
          data-testid="audio-semantic-build"
          disabled={!status?.canBuild || !status.eligibleVideos || loading}
          onClick={() => {
            const confirmation = selectedVideoId
              ? 'Build audio semantics for selected video?'
              : 'Build audio semantics for all eligible videos?'
            if (!window.confirm(t(confirmation))) return
            void run(() => mediaSearchBridge.startAudioSemanticBuild(selectedVideoId || undefined))
          }}
        >
          {t(selectedVideoId ? 'Build selected audio' : 'Build audio library')}
        </button>
        <button
          type="button"
          data-testid="audio-semantic-stop"
          disabled={!status?.canStop || !job || loading}
          onClick={() => job && void run(() => mediaSearchBridge.stopAudioSemanticBuild(job.jobId))}
        >
          {t('Stop')}
        </button>
        <button
          type="button"
          data-testid="audio-semantic-resume"
          disabled={!status?.canResume || !job || loading}
          onClick={() =>
            job && void run(() => mediaSearchBridge.resumeAudioSemanticBuild(job.jobId))
          }
        >
          {t('Resume')}
        </button>
      </div>

      {job && (
        <div data-testid="audio-semantic-progress" style={{ display: 'grid', gap: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.78 }}>
            <span>
              {t(job.state)} · {job.completedVideos}/{job.totalVideos} {t('videos')} ·{' '}
              {job.completedSegments + job.failedSegments}/{job.totalSegments} {t('segments')}
            </span>
            <span>{progress}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            style={{ height: 5, borderRadius: 4, background: 'rgba(var(--fg), 0.12)' }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: '100%',
                borderRadius: 4,
                background: 'var(--accent, #3ddc97)',
              }}
            />
          </div>
          {job.currentVideoId && (
            <span style={{ opacity: 0.68 }}>
              {job.currentVideoId.slice(0, 12)} · {formatTimestamp(job.currentStartMs)}–
              {formatTimestamp(job.currentEndMs)}
            </span>
          )}
          {job.failedSegments > 0 && (
            <span style={{ color: '#e3a44a' }}>
              {t('Failed segments')}: {job.failedSegments}
            </span>
          )}
          {job.lastError && <span style={{ color: '#d97979' }}>{t(job.lastError)}</span>}
        </div>
      )}

      {!compact && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', opacity: 0.76 }}>
          <span>
            {t('ASR')} {capabilities?.asr ? '✓' : '—'}
          </span>
          <span>
            {t('Language')} {capabilities?.language ? '✓' : '—'}
          </span>
          <span>
            {t('Emotion')} {capabilities?.emotion ? '✓' : '—'}
          </span>
          <span>
            {t('Audio events')} {capabilities?.audioEvents ? '✓' : '—'}
          </span>
          <span>
            {t('Speaker diarization')} {capabilities?.speakerDiarization ? '✓' : '—'}
          </span>
          {status?.diarization.state === 'ready' && status.diarization.speakerModel && (
            <span>
              {status.diarization.vadModel?.modelId} {status.diarization.vadModel?.modelRevision} ·{' '}
              {status.diarization.speakerModel.modelId}{' '}
              {status.diarization.speakerModel.modelRevision}
            </span>
          )}
          {status?.diarization.reason && <span>{t(status.diarization.reason)}</span>}
        </div>
      )}
      {message && <div style={{ color: '#d97979' }}>{message}</div>}
    </section>
  )
}

export default AudioSemanticStatusCard
