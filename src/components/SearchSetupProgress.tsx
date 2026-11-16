import React from 'react'
import type { EmbeddingProgress } from '../../shared/vectorTypes'
import {
  setupSnapshotFromEmbeddingProgress,
  type SetupWorkflowSnapshot,
} from '../services/searchSetupWorkflow'
import { useTranslation } from '../i18n/useTranslation'
import { translateRuntimeError } from '../i18n/runtimeError'

interface SearchSetupProgressProps {
  workflow: SetupWorkflowSnapshot
  embeddingProgress?: EmbeddingProgress
  detailed?: boolean
}

const SearchSetupProgress: React.FC<SearchSetupProgressProps> = ({
  workflow,
  embeddingProgress,
  detailed = false,
}) => {
  const { t } = useTranslation()
  const displayedWorkflow =
    workflow.state === 'idle' && embeddingProgress
      ? setupSnapshotFromEmbeddingProgress(embeddingProgress) || workflow
      : workflow
  if (displayedWorkflow.state === 'idle') return null
  const displayMessage = displayedWorkflow.runtimeError
    ? translateRuntimeError(displayedWorkflow.runtimeError, t)
    : displayedWorkflow.error || t(displayedWorkflow.message || displayedWorkflow.stepLabel || '')
  const modelStep = displayedWorkflow.stepId
  const expectedModel =
    modelStep === 'dino-embeddings'
      ? 'dinov2_vitb14'
      : modelStep === 'clip-embeddings'
        ? 'clip_vit_base_patch32'
        : undefined
  // A previous model's final event can arrive while the next phase starts.
  // Keep its counters out of the new phase until that model reports progress.
  const modelProgress =
    detailed &&
    embeddingProgress?.state !== 'idle' &&
    (expectedModel
      ? embeddingProgress?.modelName === expectedModel
      : modelStep === 'background-embeddings')
      ? embeddingProgress
      : undefined
  const currentPath = modelProgress?.currentPath
  const processed = modelProgress
    ? modelProgress.completed + modelProgress.failed + modelProgress.skipped
    : 0
  const modelPercent =
    modelProgress && modelProgress.total > 0
      ? Math.max(0, Math.min(100, Math.round((processed / modelProgress.total) * 100)))
      : undefined
  const tone =
    displayedWorkflow.state === 'error'
      ? 'rgb(255,95,95)'
      : displayedWorkflow.state === 'cancelled'
        ? 'rgb(255,190,90)'
        : 'rgb(70,235,155)'
  return (
    <div
      data-testid="search-setup-progress"
      data-detailed={detailed}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        gap: '3px 8px',
        padding: '4px 6px',
        borderBottom: '1px solid rgba(var(--date),0.12)',
        fontSize: detailed ? 11 : 9,
        flexShrink: 0,
      }}
      title={displayMessage}
    >
      {detailed && (
        <strong style={{ gridColumn: '1 / -1' }}>
          {t(displayedWorkflow.stepLabel || 'Preparing...')}
        </strong>
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {displayMessage}
      </span>
      <span style={{ color: tone }}>
        {displayedWorkflow.stepIndex > 0 && displayedWorkflow.totalSteps > 0
          ? `${displayedWorkflow.stepIndex}/${displayedWorkflow.totalSteps} `
          : ''}
        {displayedWorkflow.indeterminate
          ? t(displayedWorkflow.stepLabel || 'Preparing...')
          : `${displayedWorkflow.percent}%`}
      </span>
      {modelProgress && (
        <div
          data-testid="preparation-model-progress"
          style={{
            gridColumn: '1 / -1',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '4px 12px',
            opacity: 0.85,
          }}
        >
          <span>
            {modelProgress.modelName?.startsWith('dino')
              ? 'DINO'
              : modelProgress.modelName?.startsWith('clip')
                ? 'CLIP'
                : t('Build embeddings')}
            {': '}
            {processed.toLocaleString()}/{modelProgress.total.toLocaleString()}
            {modelPercent != null ? ` (${modelPercent}%)` : ''}
          </span>
          <span>{t('Succeeded {count}', { count: modelProgress.completed.toLocaleString() })}</span>
          <span>
            {t('Failed')}: {modelProgress.failed.toLocaleString()}
          </span>
          <span>{t('Skipped {count}', { count: modelProgress.skipped.toLocaleString() })}</span>
          <span>
            {t('Running')}: {modelProgress.running.toLocaleString()}
          </span>
          <span>
            {t('Queued')}: {modelProgress.pending.toLocaleString()}
          </span>
          {Number.isFinite(modelProgress.itemsPerSecond) && modelProgress.itemsPerSecond! > 0 && (
            <span>{modelProgress.itemsPerSecond!.toFixed(2)}/s</span>
          )}
          {Number.isFinite(modelProgress.elapsedMs) && modelProgress.elapsedMs! >= 0 && (
            <span>
              {t('Duration')}: {(modelProgress.elapsedMs! / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      )}
      {currentPath && currentPath !== displayMessage && (
        <div
          data-testid="preparation-current-path"
          title={currentPath}
          style={{
            gridColumn: '1 / -1',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            opacity: 0.7,
          }}
        >
          {currentPath}
        </div>
      )}
      <div
        style={{
          gridColumn: '1 / -1',
          height: 5,
          border: '1px solid rgba(var(--date),0.25)',
          background: 'rgba(var(--bg),0.48)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: displayedWorkflow.indeterminate ? '35%' : `${displayedWorkflow.percent}%`,
            animation: displayedWorkflow.indeterminate
              ? 'search-progress-pulse 1.4s ease-in-out infinite alternate'
              : undefined,
            height: '100%',
            background: tone,
            transition: 'width 120ms linear',
          }}
        />
      </div>
    </div>
  )
}

export default SearchSetupProgress
