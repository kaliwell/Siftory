import React from 'react'
import type { MediaSearchTaskProgress } from '../../shared/ipc-contract'
import type { EmbeddingProgress } from '../../shared/vectorTypes'
import { useTranslation } from '../i18n/useTranslation'

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

function formatRate(value?: number): string {
  if (!value || !Number.isFinite(value) || value <= 0) return '-'
  return `${value.toFixed(2)}/s`
}

interface MediaSearchProgressBarsProps {
  embeddingProgress: EmbeddingProgress
  progress: MediaSearchTaskProgress | null
  searchProgress: MediaSearchTaskProgress | null
  statusState: string
}

const MediaSearchProgressBars: React.FC<MediaSearchProgressBarsProps> = ({
  embeddingProgress,
  progress,
  searchProgress,
  statusState,
}) => {
  const { t } = useTranslation()
  const taskProgressPercent = progress?.percentage ?? (statusState === 'done' ? 100 : 0)
  const searchProgressPercent = searchProgress?.percentage ?? 0
  const displayProgress = progress ?? searchProgress
  const displayProgressPercent = progress ? taskProgressPercent : searchProgressPercent
  const displayElapsedMs = displayProgress?.elapsedMs
  const displayRate = displayProgress?.itemsPerSecond
  const displayEtaMs = displayProgress?.etaMs
  const taskFinished = (progress?.completed ?? 0) + (progress?.failed ?? 0)
  const searchFinished = (searchProgress?.completed ?? 0) + (searchProgress?.failed ?? 0)
  const embeddingFinished =
    embeddingProgress.completed + embeddingProgress.failed + embeddingProgress.skipped
  const embeddingPercent =
    embeddingProgress.total > 0
      ? Math.min(100, Math.round((embeddingFinished / embeddingProgress.total) * 100))
      : embeddingProgress.state === 'done'
        ? 100
        : 0

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, height: 6, background: 'rgba(var(--fg), 0.12)' }}>
          <div
            style={{
              width: `${Math.max(0, Math.min(100, displayProgressPercent))}%`,
              height: '100%',
              background:
                searchProgress && !progress
                  ? 'rgba(100, 180, 255, 0.85)'
                  : 'rgba(0, 220, 140, 0.85)',
            }}
          />
        </div>
        <span style={{ width: 42, textAlign: 'right' }}>{Math.round(displayProgressPercent)}%</span>
        {displayRate && displayRate > 0 && (
          <span style={{ width: 58, textAlign: 'right', opacity: 0.78 }}>
            {formatRate(displayRate)}
          </span>
        )}
        {displayEtaMs != null && (
          <span style={{ width: 82, textAlign: 'right', color: 'rgb(120,200,255)' }}>
            {t('ETA')} {formatDuration(displayEtaMs)}
          </span>
        )}
      </div>

      {embeddingProgress.state !== 'idle' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 5, background: 'rgba(var(--fg), 0.12)' }}>
            <div
              style={{
                width: `${embeddingPercent}%`,
                height: '100%',
                background:
                  embeddingProgress.state === 'error'
                    ? 'rgba(255,90,90,0.9)'
                    : 'rgba(120,200,255,0.9)',
              }}
            />
          </div>
          <span style={{ width: 42, textAlign: 'right' }}>{embeddingPercent}%</span>
          {embeddingProgress.itemsPerSecond != null && embeddingProgress.itemsPerSecond > 0 && (
            <span style={{ width: 58, textAlign: 'right', opacity: 0.78 }}>
              {formatRate(embeddingProgress.itemsPerSecond)}
            </span>
          )}
          {embeddingProgress.etaMs != null && embeddingProgress.state === 'running' && (
            <span style={{ width: 82, textAlign: 'right', color: 'rgb(120,200,255)' }}>
              {t('ETA')} {formatDuration(embeddingProgress.etaMs)}
            </span>
          )}
        </div>
      )}

      {(searchProgress || displayProgress?.message) && (
        <div style={{ opacity: 0.75, display: 'flex', gap: 8 }}>
          <span>
            {searchProgress ? t('Search') : t('Task')}
            {displayProgress?.total
              ? ` ${searchProgress ? searchFinished : taskFinished}/${displayProgress.total}`
              : ''}
          </span>
          <span>{displayProgress?.message || t('Searching...')}</span>
          {displayElapsedMs != null && (
            <span style={{ opacity: 0.7 }}>T+ {formatDuration(displayElapsedMs)}</span>
          )}
        </div>
      )}
    </>
  )
}

export default MediaSearchProgressBars
