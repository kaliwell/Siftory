import React from 'react'
import type { LayeredSearchProgress, SemanticSearchProgress } from '../../shared/vectorTypes'
import { useTranslation } from '../i18n/useTranslation'

type QueryKind = 'image' | 'semantic' | null

interface SearchProgressBarProps {
  searching: boolean
  lastQueryKind: QueryKind
  semanticProgress: SemanticSearchProgress | null
  layeredProgress: LayeredSearchProgress | null
  /** Stop the in-flight search (layered image/subject searches only). */
  onStop?: () => void
}

function clampPercent(value: number | undefined): number {
  return Math.max(0, Math.min(100, value ?? 0))
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

interface ProgressLineProps {
  label: string
  percent: number
  message?: string
  elapsedMs?: number
  itemsPerSecond?: number
  etaMs?: number
  onStop?: () => void
}

const ProgressLine: React.FC<ProgressLineProps> = ({
  label,
  percent,
  message,
  elapsedMs,
  itemsPerSecond,
  etaMs,
  onStop,
}) => {
  const { t } = useTranslation()
  return (
    <div
      title={message}
      style={{
        padding: '4px 6px',
        borderBottom: '1px solid rgba(var(--date),0.12)',
        flexShrink: 0,
        fontSize: 9,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        opacity: 0.9,
      }}
    >
      <span style={{ flexShrink: 0 }}>{label}</span>
      <div
        style={{
          width: 140,
          height: 5,
          border: '0.5px solid rgba(var(--date),0.35)',
          background: 'rgba(var(--bg),0.55)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            background: 'rgb(80,180,255)',
            transition: 'width 120ms linear',
          }}
        />
      </div>
      <span style={{ flexShrink: 0 }}>{percent}%</span>
      {itemsPerSecond != null && itemsPerSecond > 0 && (
        <span style={{ flexShrink: 0 }}>{itemsPerSecond.toFixed(2)}/s</span>
      )}
      {elapsedMs != null && (
        <span style={{ flexShrink: 0, opacity: 0.8 }}>T+ {formatDuration(elapsedMs)}</span>
      )}
      {etaMs != null && etaMs >= 0 && (
        <span style={{ flexShrink: 0, color: 'rgb(120,200,255)' }}>
          {t('ETA')} {formatDuration(etaMs)}
        </span>
      )}
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          opacity: 0.75,
          flex: 1,
        }}
      >
        {message}
      </span>
      {onStop && (
        <button
          type="button"
          onClick={onStop}
          title={t('Stop the current search')}
          style={{
            flexShrink: 0,
            fontSize: 9,
            padding: '1px 8px',
            color: 'rgb(255,130,130)',
            border: '1px solid rgba(255,110,110,0.45)',
            background: 'rgba(255,80,80,0.12)',
            cursor: 'pointer',
            borderRadius: 3,
          }}
        >
          {t('Stop')}
        </button>
      )}
    </div>
  )
}

const SearchProgressBar: React.FC<SearchProgressBarProps> = ({
  searching,
  lastQueryKind,
  semanticProgress,
  layeredProgress,
  onStop,
}) => {
  const { t } = useTranslation()
  if (!searching) return null

  if (lastQueryKind === 'semantic' && semanticProgress) {
    const percent = clampPercent(semanticProgress.percent)
    const message =
      semanticProgress.message ||
      `${semanticProgress.phase} ${semanticProgress.scanned.toLocaleString()}`
    return (
      <ProgressLine
        label={t('Search')}
        percent={percent}
        message={message}
        elapsedMs={semanticProgress.elapsedMs}
        itemsPerSecond={semanticProgress.itemsPerSecond}
        etaMs={semanticProgress.etaMs}
      />
    )
  }

  if (lastQueryKind === 'image' && layeredProgress) {
    const percent = clampPercent(layeredProgress.percent)
    const message =
      layeredProgress.message ||
      `${layeredProgress.phase} ${layeredProgress.scanned.toLocaleString()}`
    return (
      <ProgressLine
        label={layeredProgress.mode}
        percent={percent}
        message={message}
        elapsedMs={layeredProgress.elapsedMs}
        itemsPerSecond={layeredProgress.itemsPerSecond}
        etaMs={layeredProgress.etaMs}
        onStop={onStop}
      />
    )
  }

  return null
}

export default SearchProgressBar
