import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ProductHealthCheckId,
  ProductHealthRepairAction,
  ProductHealthRepairActionId,
  ProductHealthReport,
  ProductHealthState,
  ProductHealthSummaryCode,
} from '../../shared/ipc-contract'
import { useTranslation } from '../i18n/useTranslation'
import type {
  ProductModelLifecycleItem,
  ProductReadinessAction,
  ProductReadinessReason,
  ProductReadinessSnapshot,
  ProductReadinessStageId,
  ProductReadinessStageState,
  ProductReadinessState,
  ProductTaskControlAction,
  ProductTaskInventoryItem,
  ProductTaskKind,
  ProductTaskState,
} from '../services/productReadiness'
import { loadProductReadiness, runProductTaskControl } from '../services/productReadiness'

interface ProductReadinessCenterProps {
  onAction: (action: ProductReadinessAction) => void
  refreshIntervalMs?: number
}

const STATE_LABELS: Record<ProductReadinessState, string> = {
  'not-started': 'Not started',
  preparing: 'Preparing',
  searchable: 'Searchable now',
  degraded: 'Searchable with issues',
  ready: 'Fully ready',
}

const STAGE_STATE_LABELS: Record<ProductReadinessStageState, string> = {
  ready: 'Ready',
  working: 'Working',
  'action-required': 'Action required',
  degraded: 'Degraded',
  unavailable: 'Status unavailable',
}

const STAGE_LABELS: Record<ProductReadinessStageId, string> = {
  sources: 'Sources',
  catalog: 'File catalog',
  'image-semantic': 'Image semantics',
  'video-visual': 'Video frames',
  'video-semantic': 'Deep video semantics',
  'audio-semantic': 'Dialogue and audio',
}

const REASON_LABELS: Record<ProductReadinessReason, string> = {
  'status-loading': 'Loading status',
  'status-unavailable': 'Could not read status',
  'no-source': 'Add a source to begin',
  'source-ready': 'Sources are online',
  'source-offline': 'All sources are offline',
  'source-degraded': 'Some sources need attention',
  'scan-running': 'Catalog scan is running',
  'catalog-empty': 'Catalog has no files yet',
  'catalog-ready': 'File names are searchable',
  'model-missing': 'Image models need preparation',
  'model-preparing': 'Image models are preparing',
  'model-error': 'An image model needs repair',
  'image-index-empty': 'Image semantic index is empty',
  'image-index-running': 'Image index is building',
  'image-index-ready': 'Image semantics are searchable',
  'image-index-error': 'Image indexing needs attention',
  'video-tools-missing': 'Video tools need configuration',
  'video-scan-running': 'Video indexing is running',
  'video-scan-error': 'Video indexing needs attention',
  'video-frames-missing': 'Build video frames first',
  'video-frames-ready': 'Video frames are searchable',
  'no-video': 'Ready when videos are added',
  'runtime-missing': 'Model runtime is not installed',
  'runtime-busy': 'Semantic indexing is running',
  'runtime-error': 'Model runtime needs attention',
  'index-stale': 'Index needs updating',
  'index-incomplete': 'More files can be indexed',
  'index-ready': 'Semantic index is ready',
}

const ACTION_LABELS: Record<ProductReadinessAction, string> = {
  'add-source': 'Add a source',
  'scan-sources': 'Scan sources',
  'reconnect-source': 'Check source connections',
  'prepare-image-search': 'Prepare image search',
  'retry-image-index': 'Repair image indexing',
  'configure-video-tools': 'Configure video tools',
  'scan-videos': 'Scan videos',
  'build-video-frames': 'Build video frames',
  'install-video-model': 'Prepare video model',
  'resume-video-semantic': 'Resume video semantics',
  'retry-video-semantic': 'Repair video semantics',
  'install-audio-model': 'Prepare audio model',
  'resume-audio-semantic': 'Resume audio semantics',
  'retry-audio-semantic': 'Repair audio semantics',
  'review-derived-reset': 'Review derived data reset',
}

const HEALTH_STATE_LABELS: Record<ProductHealthState, string> = {
  healthy: 'Healthy',
  degraded: 'Needs attention',
  error: 'Repair required',
  'not-ready': 'Not prepared',
}

const HEALTH_CHECK_LABELS: Record<ProductHealthCheckId, string> = {
  'source-connectivity': 'Source connectivity',
  'catalog-integrity': 'Catalog integrity',
  'vector-integrity': 'Vector integrity',
  'model-integrity': 'Model integrity',
  'task-runtime': 'Task runtime',
  'data-protection': 'Local data protection',
  storage: 'Storage space',
}

const HEALTH_SUMMARY_LABELS: Record<ProductHealthSummaryCode, string> = {
  'sources-ready': 'All sources are reachable',
  'sources-offline': 'Some sources are unavailable',
  'sources-empty': 'No source is configured',
  'catalog-consistent': 'Catalog structure is consistent',
  'catalog-inconsistent': 'Catalog consistency check failed',
  'catalog-unavailable': 'Catalog could not be checked',
  'vector-ready': 'Vector generation passed integrity checks',
  'vector-stale': 'Vector index is not ready',
  'vector-corrupt': 'Vector integrity check failed',
  'models-ready': 'Managed models are verified',
  'models-missing': 'Some managed models are not installed',
  'models-corrupt': 'A managed model failed verification',
  'tasks-ready': 'Task runtime is responsive',
  'tasks-pressure': 'Background work is paused by resource pressure',
  'tasks-failed': 'Task failures were recorded this session',
  'data-protection-ready': 'Application data permissions are protected',
  'data-protection-failed': 'Application data permission protection failed',
  'data-protection-not-applied': 'Application data permission protection is not active',
  'storage-ready': 'Storage reserve is available',
  'storage-low': 'Free storage is below the selected reserve',
  'storage-unavailable': 'Storage space could not be checked',
}

const HEALTH_ACTION_LABELS: Record<ProductHealthRepairActionId, string> = {
  recheck: 'Run health check',
  'reconnect-sources': 'Reconnect sources',
  'open-source-rescan': 'Open source scan',
  'open-image-rebuild': 'Open index rebuild',
  'open-model-repair': 'Open model repair',
  'cancel-background': 'Cancel queued background work',
  'review-derived-reset': 'Review derived data reset',
  'repair-data-protection': 'Repair data protection',
}

const HEALTH_COUNT_LABELS: Record<string, string> = {
  total: 'Total',
  online: 'Online',
  offline: 'Offline',
  unavailable: 'Unavailable',
  sources: 'Sources',
  files: 'Files',
  indexStates: 'Index states',
  missingFiles: 'Missing files',
  staleIndexes: 'Stale indexes',
  failedIndexes: 'Failed indexes',
  structuralIssues: 'Structural issues',
  stale: 'Stale',
  corrupt: 'Corrupt',
  ready: 'Ready',
  missing: 'Missing',
  running: 'Running',
  queued: 'Queued',
  failed: 'Failed',
  pressureReasons: 'Pressure reasons',
  freeBytes: 'Free space',
  minimumFreeBytes: 'Required reserve',
}

const CAPABILITY_LABELS: Array<[keyof ProductReadinessSnapshot['capabilities'], string]> = [
  ['metadata', 'File names'],
  ['imageSimilarity', 'Similar images'],
  ['naturalLanguageImage', 'Natural language'],
  ['videoFrame', 'Video frames'],
  ['videoSemantic', 'Video events'],
  ['dialogue', 'Dialogue'],
]

const MODEL_LABELS: Record<ProductModelLifecycleItem['id'], string> = {
  dinov2_vitb14: 'DINOv2',
  clip_vit_base_patch32: 'CLIP',
  'qwen3-vl': 'Qwen3-VL',
  sensevoice: 'SenseVoice',
}

const MODEL_STATE_LABELS: Record<ProductModelLifecycleItem['state'], string> = {
  'not-installed': 'Model not installed',
  downloading: 'Model downloading',
  downloaded: 'Model downloaded',
  verified: 'Model verified',
  loading: 'Model status loading',
  loaded: 'Model loaded',
  unloading: 'Model unloading',
  error: 'Model error',
  ready: 'Model ready',
  busy: 'Model busy',
  unavailable: 'Model unavailable',
}

const TASK_KIND_LABELS: Record<ProductTaskKind, string> = {
  'source-scan': 'Source scan',
  'image-index': 'Image indexing',
  'thumbnail-index': 'Thumbnail rebuild',
  'image-embedding': 'Image embeddings',
  'video-index': 'Video indexing',
  'video-semantic': 'Deep video semantics',
  'audio-semantic': 'Dialogue and audio',
}

const TASK_STATE_LABELS: Record<ProductTaskState, string> = {
  queued: 'Queued',
  running: 'Working',
  paused: 'Paused',
  stopping: 'Stopping',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
}

const TASK_ACTION_LABELS: Record<ProductTaskControlAction, string> = {
  pause: 'Pause',
  resume: 'Resume',
  stop: 'Stop',
  retry: 'Retry',
}

const ACTIVE_TASK_STATES = new Set<ProductTaskState>(['queued', 'running', 'paused', 'stopping'])

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`
}

function formatEta(etaMs: number): string {
  const seconds = Math.max(0, Math.ceil(etaMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.ceil(minutes / 60)}h`
}

const ProductReadinessCenter: React.FC<ProductReadinessCenterProps> = ({
  onAction,
  refreshIntervalMs = 5000,
}) => {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ProductReadinessSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [modelBusy, setModelBusy] = useState<ProductModelLifecycleItem['id'] | null>(null)
  const [modelMessage, setModelMessage] = useState('')
  const [taskBusy, setTaskBusy] = useState<string | null>(null)
  const [taskMessage, setTaskMessage] = useState('')
  const [healthReport, setHealthReport] = useState<ProductHealthReport | null>(null)
  const [healthBusy, setHealthBusy] = useState(false)
  const [healthMessage, setHealthMessage] = useState('')
  const modelManagerRef = useRef<HTMLDetailsElement | null>(null)
  const refreshInFlightRef = useRef(false)
  const [storageRefreshing, setStorageRefreshing] = useState(false)

  const refresh = useCallback(async (includeStorage = false) => {
    const api = window.electronAPI
    if (!api || refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    setRefreshing(true)
    if (includeStorage) setStorageRefreshing(true)
    try {
      const next = await loadProductReadiness(api, { includeStorage })
      setSnapshot((current) => ({
        ...next,
        taskStorage:
          !includeStorage && current?.taskStorage.totalBytes !== undefined
            ? current.taskStorage
            : next.taskStorage,
      }))
    } finally {
      refreshInFlightRef.current = false
      setRefreshing(false)
      if (includeStorage) setStorageRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), refreshIntervalMs)
    return () => window.clearInterval(timer)
  }, [refresh, refreshIntervalMs])

  useEffect(() => {
    const openModelManager = () => {
      const details = modelManagerRef.current
      if (!details) return
      details.open = true
      details.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      details.querySelector('summary')?.focus()
    }
    window.addEventListener('workspace-open-model-manager', openModelManager)
    return () => window.removeEventListener('workspace-open-model-manager', openModelManager)
  }, [])

  if (!snapshot) {
    return (
      <section
        className="product-readiness product-readiness--loading"
        data-testid="product-readiness-center"
        aria-live="polite"
      >
        {t('Loading preparation status')}
      </section>
    )
  }

  const nextAction = snapshot.nextAction
  const runManagedModelAction = async (
    model: ProductModelLifecycleItem,
    action: 'download' | 'repair' | 'cancel' | 'verify' | 'remove',
  ) => {
    const vector = window.electronAPI?.vector
    if (!vector || model.management !== 'managed-download') return
    if (
      action === 'download' &&
      !window.confirm(t('Download and verify {model} now?', { model: MODEL_LABELS[model.id] }))
    ) {
      return
    }
    if (
      action === 'repair' &&
      !window.confirm(
        t('Delete the damaged copy and download {model} again?', {
          model: MODEL_LABELS[model.id],
        }),
      )
    ) {
      return
    }
    if (
      action === 'remove' &&
      !window.confirm(t('Remove {model} from this device?', { model: MODEL_LABELS[model.id] }))
    ) {
      return
    }

    setModelBusy(model.id)
    setModelMessage('')
    try {
      let result: { ok: boolean; error?: string } = { ok: true }
      if (action === 'cancel') result = await vector.cancelDownload()
      else if (action === 'remove') result = await vector.deleteModel(model.id)
      else if (action === 'repair') {
        result = await vector.deleteModel(model.id)
        if (result.ok) result = await vector.downloadModel(model.id)
      } else if (action === 'download') result = await vector.downloadModel(model.id)
      if (!result.ok) setModelMessage(result.error || t('The operation failed.'))
      await refresh()
    } finally {
      setModelBusy(null)
    }
  }

  const runTaskAction = async (
    task: ProductTaskInventoryItem,
    action: ProductTaskControlAction,
  ) => {
    const api = window.electronAPI
    if (!api) return
    setTaskBusy(task.id)
    setTaskMessage('')
    try {
      const result = await runProductTaskControl(api, task, action)
      if (result.route) onAction(result.route)
      setTaskMessage(
        result.ok
          ? t('Task action completed.')
          : t('Task action failed: {error}', { error: result.error || t('unknown') }),
      )
      await refresh()
    } catch (error) {
      setTaskMessage(
        t('Task action failed: {error}', {
          error: error instanceof Error ? error.message : t('unknown'),
        }),
      )
    } finally {
      setTaskBusy(null)
    }
  }

  const refreshHealth = async () => {
    setHealthBusy(true)
    setHealthMessage('')
    try {
      setHealthReport(await window.electronAPI.productHealth.getReport())
    } catch {
      setHealthMessage(t('Health check could not be completed.'))
    } finally {
      setHealthBusy(false)
    }
  }

  const runHealthAction = async (action: ProductHealthRepairAction) => {
    if (
      action.requiresConfirmation &&
      !window.confirm(
        t(
          action.id === 'review-derived-reset'
            ? 'Open the deletion preview? Nothing is removed until you confirm it there.'
            : 'Cancel all queued background tasks?',
        ),
      )
    ) {
      return
    }
    setHealthBusy(true)
    setHealthMessage('')
    try {
      const result = await window.electronAPI.productHealth.runRepair({
        actionId: action.id,
        ...(action.requiresConfirmation ? { confirmed: true as const } : {}),
      })
      if (result.report) setHealthReport(result.report)
      if (!result.ok) {
        setHealthMessage(t('Repair action could not be completed.'))
        return
      }
      if (result.route === 'sources') onAction('reconnect-source')
      else if (result.route === 'image-search') onAction('prepare-image-search')
      else if (result.route === 'settings-data-reset') onAction('review-derived-reset')
      else {
        setHealthMessage(
          t('Repair action completed for {count} item(s).', { count: result.affected ?? 0 }),
        )
      }
    } catch {
      setHealthMessage(t('Repair action could not be completed.'))
    } finally {
      setHealthBusy(false)
    }
  }

  const saveHealthReport = async () => {
    setHealthBusy(true)
    setHealthMessage('')
    try {
      const result = await window.electronAPI.productHealth.saveReport()
      setHealthMessage(
        result.ok
          ? t('Privacy-redacted health report saved.')
          : result.errorCode === 'cancelled'
            ? ''
            : t('Health report could not be saved.'),
      )
    } catch {
      setHealthMessage(t('Health report could not be saved.'))
    } finally {
      setHealthBusy(false)
    }
  }

  const activeTaskCount = snapshot.tasks.filter((task) => ACTIVE_TASK_STATES.has(task.state)).length

  return (
    <section
      className="product-readiness"
      data-testid="product-readiness-center"
      aria-label={t('Preparation center')}
      aria-busy={refreshing}
    >
      <div className="product-readiness__header">
        <strong>{t('Preparation center')}</strong>
        <span className={`product-readiness__overall is-${snapshot.state}`}>
          {t(STATE_LABELS[snapshot.state])} · {snapshot.progress}%
        </span>
        <button
          className="product-readiness__refresh"
          data-testid="product-readiness-refresh"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          {t('Refresh status')}
        </button>
      </div>

      <progress
        className="product-readiness__progress"
        aria-label={t('Overall preparation progress')}
        max={100}
        value={snapshot.progress}
      />

      <div className="product-readiness__capabilities" aria-label={t('Available searches')}>
        {CAPABILITY_LABELS.map(([capability, label]) => (
          <span
            key={capability}
            className={snapshot.capabilities[capability] ? 'is-ready' : 'is-pending'}
            data-testid={`product-capability-${capability}`}
          >
            {snapshot.capabilities[capability] ? '✓' : '○'} {t(label)}
          </span>
        ))}
      </div>

      <div className="product-readiness__stages">
        {snapshot.stages.map((stage) => (
          <article
            key={stage.id}
            className={`product-readiness__stage is-${stage.state}`}
            data-testid={`product-readiness-stage-${stage.id}`}
          >
            <div>
              <strong>{t(STAGE_LABELS[stage.id])}</strong>
              <span>{stage.progress}%</span>
            </div>
            <small>{t(STAGE_STATE_LABELS[stage.state])}</small>
            <small>{t(REASON_LABELS[stage.reason])}</small>
          </article>
        ))}
      </div>

      <section className="product-readiness__tasks" data-testid="product-task-center">
        <div className="product-readiness__task-header">
          <strong>{t('Task center')}</strong>
          <span>
            {t('{active} active · {total} recorded', {
              active: activeTaskCount,
              total: snapshot.tasks.length,
            })}
          </span>
        </div>

        <div className="product-readiness__storage" data-testid="product-task-storage">
          <span>{t('Task storage')}</span>
          {snapshot.taskStorage.totalBytes === undefined ? (
            <small>
              {t('Storage is calculated only when requested')}
              <button type="button" disabled={storageRefreshing} onClick={() => void refresh(true)}>
                {t(storageRefreshing ? 'Calculating storage...' : 'Calculate storage')}
              </button>
            </small>
          ) : (
            <small>
              {t('Total {size}', { size: formatBytes(snapshot.taskStorage.totalBytes) })}
              {snapshot.taskStorage.imageBytes === undefined
                ? ''
                : ` · ${t('Images {size}', {
                    size: formatBytes(snapshot.taskStorage.imageBytes),
                  })}`}
              {snapshot.taskStorage.mediaBytes === undefined
                ? ''
                : ` · ${t('Video {size}', {
                    size: formatBytes(snapshot.taskStorage.mediaBytes),
                  })}`}
            </small>
          )}
        </div>

        {snapshot.tasks.length === 0 ? (
          <p className="product-readiness__task-empty">{t('No recorded tasks')}</p>
        ) : (
          <div className="product-readiness__task-list">
            {snapshot.tasks.map((task) => {
              const busy = taskBusy === task.id
              const taskLabel = t(TASK_KIND_LABELS[task.kind])
              const controls: ProductTaskControlAction[] = []
              if (task.canPause) controls.push('pause')
              if (task.canResume && !task.canRetry) controls.push('resume')
              if (task.canRetry) controls.push('retry')
              if (task.canStop) controls.push('stop')
              return (
                <article
                  key={task.id}
                  className={`product-readiness__task is-${task.state}`}
                  data-testid={`product-task-${task.kind}`}
                >
                  <div className="product-readiness__task-title">
                    <strong>{taskLabel}</strong>
                    <span>{t(TASK_STATE_LABELS[task.state])}</span>
                    <span>{task.progress}%</span>
                  </div>
                  <progress
                    aria-label={t('Task progress for {task}', { task: taskLabel })}
                    max={100}
                    value={task.progress}
                  />
                  <div className="product-readiness__task-meta">
                    <small>
                      {t('Items {completed}/{total}', {
                        completed: task.completed,
                        total: task.total,
                      })}
                      {task.failed > 0 ? ` · ${t('{count} failed', { count: task.failed })}` : ''}
                    </small>
                    {task.itemsPerSecond === undefined ? null : (
                      <small>
                        {t('Speed {speed}', { speed: `${task.itemsPerSecond.toFixed(1)}/s` })}
                      </small>
                    )}
                    {task.etaMs === undefined ? null : (
                      <small>{t('ETA {eta}', { eta: formatEta(task.etaMs) })}</small>
                    )}
                    <small>
                      {t(task.persisted ? 'Restores after restart' : 'This-session task')}
                    </small>
                  </div>
                  {task.currentItem && (
                    <small className="product-readiness__task-current" title={task.currentItem}>
                      {t('Current item: {item}', { item: task.currentItem })}
                    </small>
                  )}
                  {task.error && (
                    <small className="product-readiness__task-error">{task.error}</small>
                  )}
                  {controls.length > 0 && (
                    <div className="product-readiness__task-actions">
                      {controls.map((action) => (
                        <button
                          key={action}
                          disabled={busy}
                          onClick={() => void runTaskAction(task, action)}
                        >
                          {t(TASK_ACTION_LABELS[action])}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        )}
        {taskMessage && <p className="product-readiness__task-message">{taskMessage}</p>}
      </section>

      <details
        className="product-readiness__health"
        data-testid="product-health-center"
        onToggle={(event) => {
          if (event.currentTarget.open && !healthReport && !healthBusy) void refreshHealth()
        }}
      >
        <summary>
          {t('Health and repair')}
          {healthReport ? ` · ${t(HEALTH_STATE_LABELS[healthReport.overall])}` : ''}
        </summary>
        <div className="product-readiness__health-toolbar">
          <button disabled={healthBusy} onClick={() => void refreshHealth()}>
            {t('Run health check')}
          </button>
          <button disabled={healthBusy || !healthReport} onClick={() => void saveHealthReport()}>
            {t('Save redacted report')}
          </button>
        </div>
        {healthReport && (
          <div className="product-readiness__health-list" aria-live="polite">
            {healthReport.checks.map((check) => (
              <article
                key={check.id}
                className={`is-${check.state}`}
                data-testid={`product-health-check-${check.id}`}
              >
                <div className="product-readiness__health-title">
                  <strong>{t(HEALTH_CHECK_LABELS[check.id])}</strong>
                  <span>{t(HEALTH_STATE_LABELS[check.state])}</span>
                </div>
                <small>{t(HEALTH_SUMMARY_LABELS[check.summaryCode])}</small>
                {Object.keys(check.counts).length > 0 && (
                  <div className="product-readiness__health-counts">
                    {Object.entries(check.counts).map(([key, value]) => (
                      <span key={key}>
                        {t(HEALTH_COUNT_LABELS[key] ?? key)}:{' '}
                        {key.endsWith('Bytes') ? formatBytes(value) : value.toLocaleString()}
                      </span>
                    ))}
                  </div>
                )}
                {check.actions.length > 0 && (
                  <div className="product-readiness__health-actions">
                    {check.actions.map((action) => (
                      <button
                        key={action.id}
                        className={`is-${action.tier}`}
                        disabled={healthBusy}
                        onClick={() => void runHealthAction(action)}
                      >
                        {t(HEALTH_ACTION_LABELS[action.id])}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
        <small className="product-readiness__health-privacy">
          {t(
            'Reports exclude absolute paths, filenames, queries, server addresses and credentials.',
          )}
        </small>
        {healthMessage && <p className="product-readiness__health-message">{healthMessage}</p>}
      </details>

      <details
        ref={modelManagerRef}
        className="product-readiness__models"
        data-testid="product-model-manager"
      >
        <summary tabIndex={-1}>{t('Manage models')}</summary>
        <div className="product-readiness__model-grid">
          {snapshot.models.map((model) => {
            const busy = modelBusy === model.id
            const ready = ['downloaded', 'verified', 'loaded', 'ready'].includes(model.state)
            return (
              <article key={model.id} data-testid={`product-model-${model.id}`}>
                <div>
                  <strong>{MODEL_LABELS[model.id]}</strong>
                  <span>
                    {t(MODEL_STATE_LABELS[model.state])}
                    {model.progress === undefined ? '' : ` · ${model.progress}%`}
                  </span>
                </div>
                {model.management === 'external-runtime' ? (
                  <button
                    disabled={busy}
                    onClick={() =>
                      onAction(
                        model.id === 'qwen3-vl' ? 'install-video-model' : 'install-audio-model',
                      )
                    }
                  >
                    {t(ready ? 'Open model status' : 'Open model setup')}
                  </button>
                ) : model.state === 'downloading' ? (
                  <button
                    disabled={busy}
                    onClick={() => void runManagedModelAction(model, 'cancel')}
                  >
                    {t('Cancel download')}
                  </button>
                ) : ready ? (
                  <div className="product-readiness__model-actions">
                    <button
                      disabled={busy}
                      onClick={() => void runManagedModelAction(model, 'verify')}
                    >
                      {t('Verify')}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => void runManagedModelAction(model, 'remove')}
                    >
                      {t('Remove')}
                    </button>
                  </div>
                ) : (
                  <button
                    disabled={busy || ['loading', 'unloading'].includes(model.state)}
                    onClick={() =>
                      void runManagedModelAction(
                        model,
                        model.state === 'error' ? 'repair' : 'download',
                      )
                    }
                  >
                    {t(model.state === 'error' ? 'Repair and download' : 'Download model')}
                  </button>
                )}
              </article>
            )
          })}
        </div>
        {modelMessage && <p className="product-readiness__model-message">{modelMessage}</p>}
        <small>{t('External video and audio models are never downloaded automatically.')}</small>
      </details>

      {nextAction && (
        <button
          className="product-readiness__next"
          data-testid="product-readiness-next-action"
          onClick={() => onAction(nextAction)}
        >
          {t('Next step')}: {t(ACTION_LABELS[nextAction])}
        </button>
      )}
    </section>
  )
}

export default ProductReadinessCenter
