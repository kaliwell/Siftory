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
}

const SearchSetupProgress: React.FC<SearchSetupProgressProps> = ({
  workflow,
  embeddingProgress,
}) => {
  const { t } = useTranslation()
  const displayedWorkflow =
    workflow.state === 'idle' && embeddingProgress
      ? setupSnapshotFromEmbeddingProgress(embeddingProgress) || workflow
      : workflow
  if (displayedWorkflow.state === 'idle') return null
  const displayMessage = displayedWorkflow.runtimeError
    ? translateRuntimeError(displayedWorkflow.runtimeError, t)
    : displayedWorkflow.error || displayedWorkflow.message || displayedWorkflow.stepLabel
  const tone =
    displayedWorkflow.state === 'error'
      ? 'rgb(255,95,95)'
      : displayedWorkflow.state === 'cancelled'
        ? 'rgb(255,190,90)'
        : 'rgb(70,235,155)'
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        gap: '3px 8px',
        padding: '4px 6px',
        borderBottom: '1px solid rgba(var(--date),0.12)',
        fontSize: 9,
        flexShrink: 0,
      }}
      title={displayMessage}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {displayMessage}
      </span>
      <span style={{ color: tone }}>
        {displayedWorkflow.stepIndex > 0 && displayedWorkflow.totalSteps > 0
          ? `${displayedWorkflow.stepIndex}/${displayedWorkflow.totalSteps} `
          : ''}
        {displayedWorkflow.percent}%
      </span>
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
            width: `${displayedWorkflow.percent}%`,
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
