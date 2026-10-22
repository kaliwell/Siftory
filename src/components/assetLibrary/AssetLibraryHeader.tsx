import type {
  AssetFeedbackModelStatus,
  AssetLibraryStats,
  AssetLibraryTaskProgress,
} from '../../../shared/ipc-contract'
import {
  assetLibraryButtonStyle as buttonStyle,
  formatAssetLibraryDuration as formatDuration,
  formatAssetLibraryNumber as formatNumber,
  type AssetLibraryViewMode,
} from './assetLibraryViewUtils'
import { useTranslation } from '../../i18n/useTranslation'

interface Props {
  activeTask: boolean
  backupOpen: boolean
  backupCount: number
  view: AssetLibraryViewMode
  stats: AssetLibraryStats
  feedbackStatus: AssetFeedbackModelStatus
  task: AssetLibraryTaskProgress | null
  error: string
  onSync: () => void
  onRefresh: () => void
  onToggleBackups: () => void
  onExportReport: () => void
  onRebuildLearning: () => void
  onLearningEnabledChange: (enabled: boolean) => void
  onStop: () => void
  onViewChange: (view: AssetLibraryViewMode) => void
}

export default function AssetLibraryHeader({
  activeTask,
  backupOpen,
  backupCount,
  view,
  stats,
  feedbackStatus,
  task,
  error,
  onSync,
  onRefresh,
  onToggleBackups,
  onExportReport,
  onRebuildLearning,
  onLearningEnabledChange,
  onStop,
  onViewChange,
}: Props) {
  const { t } = useTranslation()
  return (
    <>
      <details className="workspace-disclosure" data-testid="asset-library-tools">
        <summary>{t('Library tools')}</summary>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            disabled={activeTask}
            onClick={onSync}
            style={buttonStyle}
            title={t('Import assets from the current Image Search manifest')}
          >
            {t('Sync Image Index')}
          </button>
          <button onClick={onRefresh} style={buttonStyle}>
            {t('Refresh')}
          </button>
          <button
            data-testid="asset-backups-toggle"
            onClick={onToggleBackups}
            style={{
              ...buttonStyle,
              color: backupOpen ? 'rgb(85,220,160)' : undefined,
              borderColor: backupOpen ? 'rgb(85,220,160)' : undefined,
            }}
          >
            {t('Backups')} ({formatNumber(backupCount)})
          </button>
          <button
            onClick={onExportReport}
            title={t('Export a library report (stats, categories, tags, deletion history) as JSON')}
            style={buttonStyle}
          >
            {t('Report')}
          </button>
          <button
            disabled={activeTask || feedbackStatus.state === 'building'}
            onClick={onRebuildLearning}
            style={buttonStyle}
            title={t(
              'Rebuild the local search model from accepted, rejected, and manual classifications',
            )}
          >
            {t('Build Search Learning')}
          </button>
          <label
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9 }}
            title={t(
              'Apply accepted and rejected NekoSearch samples to Image Search semantic ranking',
            )}
          >
            <input
              type="checkbox"
              checked={feedbackStatus.enabled}
              disabled={activeTask}
              onChange={(event) => onLearningEnabledChange(event.target.checked)}
            />
            {t('Learning')}
          </label>
          <button disabled={!activeTask} onClick={onStop} style={buttonStyle}>
            {t('Stop')}
          </button>
          <span style={{ fontSize: 9, opacity: 0.65 }}>
            {t('Assets')} {formatNumber(stats.totalAssets)} / {t('Classified')}{' '}
            {formatNumber(stats.classifiedAssets)} / {t('Unclassified')}{' '}
            {formatNumber(stats.unclassifiedAssets)} / {t('Suggestions')}{' '}
            {formatNumber(stats.suggestedCount)} / {t('Removed')}{' '}
            {formatNumber(stats.archivedAssets)}
          </span>
          {stats.storageState !== 'ready' && (
            <span
              style={{ fontSize: 9, color: 'rgb(255,105,105)' }}
              title={stats.storageError || t('Asset metadata storage requires repair')}
            >
              {t('Data')} {t(stats.storageState === 'read_only' ? 'read-only' : 'unavailable')}
              {stats.storageCorruptRows > 0
                ? ` (${t('{count} damaged rows', {
                    count: formatNumber(stats.storageCorruptRows),
                  })})`
                : ''}
            </span>
          )}
          <span
            style={{
              fontSize: 9,
              color:
                feedbackStatus.state === 'ready'
                  ? 'rgb(75,220,155)'
                  : feedbackStatus.state === 'error'
                    ? 'rgb(255,105,105)'
                    : 'rgb(235,185,90)',
            }}
            title={
              feedbackStatus.error ||
              feedbackStatus.dirtyReason ||
              t('{positive} positive and {negative} negative prototypes', {
                positive: feedbackStatus.positivePrototypeCount,
                negative: feedbackStatus.negativePrototypeCount,
              })
            }
          >
            {t('Search learning')}: {t(feedbackStatus.enabled ? feedbackStatus.state : 'off')}{' '}
            {t('Revision {built}/{current}', {
              built: feedbackStatus.builtRevision,
              current: feedbackStatus.revision,
            })}{' '}
            ({t('{count} targets', { count: feedbackStatus.targetCount })})
          </span>
        </div>
      </details>

      <div
        style={{
          display: 'flex',
          gap: 3,
          borderBottom: '1px solid rgba(var(--date),0.18)',
          paddingBottom: 4,
        }}
      >
        {(
          [
            ['library', 'Library'],
            ['review', 'Review'],
            ['clusters', `${t('Clusters')} (${formatNumber(stats.clusterCount)})`],
          ] as Array<[AssetLibraryViewMode, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            data-testid={`asset-view-${id}`}
            onClick={() => onViewChange(id)}
            style={{
              ...buttonStyle,
              background: view === id ? 'rgba(70,210,155,0.16)' : undefined,
            }}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {task && task.state !== 'idle' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: 6,
            alignItems: 'center',
          }}
        >
          <div style={{ height: 5, background: 'rgba(var(--date),0.14)', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${task.percent}%`,
                background: task.state === 'error' ? 'rgb(255,95,95)' : 'rgb(55,215,145)',
                transition: 'width 120ms linear',
              }}
            />
          </div>
          <span style={{ fontSize: 9, whiteSpace: 'nowrap' }}>
            {task.percent}%
            {task.state === 'running' && task.etaMs !== undefined
              ? ` · ${t('ETA')} ${formatDuration(task.etaMs)}`
              : ''}
          </span>
          <span
            style={{
              gridColumn: '1 / -1',
              fontSize: 9,
              opacity: 0.65,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {task.message}
          </span>
        </div>
      )}

      {error && (
        <div
          style={{
            color: 'rgb(255,115,115)',
            background: 'rgba(190,45,45,0.16)',
            border: '1px solid rgba(255,95,95,0.35)',
            padding: '4px 7px',
            fontSize: 9,
          }}
        >
          {error}
        </div>
      )}
    </>
  )
}
