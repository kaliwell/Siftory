import { useId, useRef } from 'react'
import type {
  AssetFeedbackModelStatus,
  AssetLibraryStats,
  AssetLibraryTaskProgress,
} from '../../../shared/ipc-contract'
import {
  formatAssetLibraryDuration as formatDuration,
  formatAssetLibraryNumber as formatNumber,
} from './assetLibraryViewUtils'
import { useTranslation } from '../../i18n/useTranslation'

interface Props {
  activeTask: boolean
  backupOpen: boolean
  backupCount: number
  stats: AssetLibraryStats
  feedbackStatus: AssetFeedbackModelStatus
  task: AssetLibraryTaskProgress | null
  error: string
  collectionsOpen: boolean
  onSync: () => void
  onRefresh: () => void
  onToggleBackups: () => void
  onExportReport: () => void
  onRebuildLearning: () => void
  onLearningEnabledChange: (enabled: boolean) => void
  onStop: () => void
}

export default function AssetLibraryHeader({
  activeTask,
  backupOpen,
  backupCount,
  stats,
  feedbackStatus,
  task,
  error,
  collectionsOpen,
  onSync,
  onRefresh,
  onToggleBackups,
  onExportReport,
  onRebuildLearning,
  onLearningEnabledChange,
  onStop,
}: Props) {
  const { t } = useTranslation()
  const toolsRef = useRef<HTMLDialogElement>(null)
  const toolsId = useId()
  const navigate = (action: () => void) => {
    toolsRef.current?.close()
    action()
  }
  return (
    <>
      <div className="asset-library-header-actions">
        <div className="asset-library-topbar">
          <div className="asset-library-topbar-actions" hidden={collectionsOpen}>
            <button
              data-testid="asset-library-sync"
              className="workspace-button-primary"
              disabled={activeTask}
              onClick={onSync}
            >
              {t('Collect from image index')}
            </button>
            <button onClick={onRefresh}>{t('Refresh')}</button>
          </div>
        </div>
        <button
          className="asset-library-tools-trigger"
          data-testid="asset-library-tools-toggle"
          aria-haspopup="dialog"
          aria-controls={toolsId}
          onClick={() => toolsRef.current?.showModal()}
        >
          {t('Organize and maintain')}
        </button>
        <dialog
          ref={toolsRef}
          id={toolsId}
          className="asset-library-filter-drawer asset-library-tools-drawer"
          data-testid="asset-library-tools"
          aria-label={t('Organize and maintain')}
        >
          <header className="asset-library-drawer-header">
            <strong>{t('Organize and maintain')}</strong>
            <button aria-label={t('Close')} onClick={() => toolsRef.current?.close()}>
              ×
            </button>
          </header>
          <div className="asset-library-drawer-body">
            <dl className="asset-library-maintenance-stats">
              {(
                [
                  ['Assets', stats.totalAssets],
                  ['Classified', stats.classifiedAssets],
                  ['Unclassified', stats.unclassifiedAssets],
                  ['Suggestions', stats.suggestedCount],
                  ['Removed', stats.archivedAssets],
                ] as Array<[string, number]>
              ).map(([label, count]) => (
                <div key={label}>
                  <dt>{t(label)}</dt>
                  <dd>{formatNumber(count)}</dd>
                </div>
              ))}
            </dl>

            <section className="asset-library-tool-section">
              <h3>
                {t('Backups')} · {t('Report')}
              </h3>
              <div className="asset-library-tool-grid">
                <button
                  data-testid="asset-backups-toggle"
                  aria-pressed={backupOpen}
                  onClick={() => navigate(onToggleBackups)}
                >
                  {t('Backups')} ({formatNumber(backupCount)})
                </button>
                <button
                  onClick={onExportReport}
                  title={t(
                    'Export a library report (stats, categories, tags, deletion history) as JSON',
                  )}
                >
                  {t('Report')}
                </button>
              </div>
              {stats.storageState !== 'ready' && (
                <p
                  role="alert"
                  className="asset-library-error"
                  title={stats.storageError || t('Asset metadata storage requires repair')}
                >
                  {t('Asset metadata storage requires repair')}
                  {stats.storageCorruptRows > 0
                    ? ` (${t('{count} damaged rows', {
                        count: formatNumber(stats.storageCorruptRows),
                      })})`
                    : ''}
                </p>
              )}
            </section>
            <section className="asset-library-tool-section">
              <div className="asset-library-tool-heading">
                <h3>{t('Search learning')}</h3>
                <label
                  className="asset-library-check"
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
              </div>
              <div
                className="asset-library-learning-status"
                role="status"
                data-state={feedbackStatus.enabled ? feedbackStatus.state : 'off'}
              >
                <strong>{t(feedbackStatus.enabled ? feedbackStatus.state : 'off')}</strong>
                <span>
                  {t('Revision {built}/{current}', {
                    built: feedbackStatus.builtRevision,
                    current: feedbackStatus.revision,
                  })}{' '}
                  · {t('{count} targets', { count: feedbackStatus.targetCount })}
                </span>
                {(feedbackStatus.error || feedbackStatus.dirtyReason) && (
                  <span>{feedbackStatus.error || feedbackStatus.dirtyReason}</span>
                )}
                <small>
                  {t('{positive} positive and {negative} negative prototypes', {
                    positive: feedbackStatus.positivePrototypeCount,
                    negative: feedbackStatus.negativePrototypeCount,
                  })}
                </small>
              </div>
              <button
                className="asset-library-rebuild-learning"
                disabled={activeTask || feedbackStatus.state === 'building'}
                onClick={onRebuildLearning}
                title={t(
                  'Rebuild the local search model from accepted, rejected, and manual classifications',
                )}
              >
                {t('Build Search Learning')}
              </button>
              {activeTask && <button onClick={onStop}>{t('Stop')}</button>}
            </section>
          </div>
          <footer className="asset-library-drawer-footer">
            <button onClick={() => toolsRef.current?.close()}>{t('Close')}</button>
          </footer>
        </dialog>
      </div>

      {activeTask && (
        <div className="asset-library-task-notice" role="status">
          <span>{t('Library task is running')}</span>
          <button onClick={onStop}>{t('Stop')}</button>
        </div>
      )}
      {stats.storageState !== 'ready' && (
        <div role="alert" className="asset-library-storage-warning">
          {t('Asset metadata storage requires repair')}
        </div>
      )}
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
