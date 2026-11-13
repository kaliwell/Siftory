import React from 'react'
import type { ImageSearchStatus } from '../../shared/ipc/image-search'
import type { EmbeddingProgress } from '../../shared/vectorTypes'
import type { SetupWorkflowSnapshot } from '../services/searchSetupWorkflow'
import { searchReadinessProgress } from '../services/searchReadinessProgress'
import { useTranslation } from '../i18n/useTranslation'

export default function SearchReadinessProgress({
  workflow,
  embedding,
  scanState,
}: {
  workflow: SetupWorkflowSnapshot
  embedding?: EmbeddingProgress
  scanState: ImageSearchStatus['state']
}) {
  const { t } = useTranslation()
  const progress = searchReadinessProgress(workflow, embedding, scanState)
  return (
    <span
      className="search-readiness-progress"
      data-state={progress.state}
      data-indeterminate={progress.indeterminate}
    >
      <span
        className="search-readiness-progress__track"
        role="progressbar"
        aria-label={t('Search readiness')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.indeterminate ? undefined : progress.percent}
        aria-valuetext={progress.indeterminate ? t(progress.state) : undefined}
      >
        <span style={{ width: progress.indeterminate ? '35%' : `${progress.percent}%` }} />
      </span>
      {progress.state !== 'idle' && !progress.indeterminate && <span>{progress.percent}%</span>}
    </span>
  )
}
