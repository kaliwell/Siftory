import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettingsData,
  ProductFirstRunGuideSettings,
  ProductFirstRunGuideStepId,
} from '../../shared/ipc-contract'
import { flushSettingsWrites, scheduleSettingsWrite } from '../hooks/settingsWriter'
import { useTranslation } from '../i18n/useTranslation'
import {
  deriveFirstRunGuideView,
  initializeFirstRunGuide,
  normalizeFirstRunGuideSettings,
  reconcileFirstRunGuide,
  updateFirstRunGuide,
} from '../services/firstRunGuide'
import { loadProductReadiness, type ProductReadinessSnapshot } from '../services/productReadiness'

interface FirstRunGuideProps {
  onNavigate: (step: ProductFirstRunGuideStepId) => void
}

const STEP_LABELS: Record<ProductFirstRunGuideStepId, string> = {
  source: 'Add a source',
  models: 'Prepare image models',
  catalog: 'Build the first library',
  search: 'Run the first search',
}

const STEP_DESCRIPTIONS: Record<ProductFirstRunGuideStepId, string> = {
  source: 'Choose sources from one center before opening model-specific tools.',
  models: 'Verify the managed DINO and CLIP models used by image search.',
  catalog: 'Scan the source and create its searchable catalog and embeddings.',
  search: 'Use the main search for a filename, description, image, or dialogue query.',
}

const STEP_ACTIONS: Record<ProductFirstRunGuideStepId, string> = {
  source: 'Open source center',
  models: 'Open model setup',
  catalog: 'Open library preparation',
  search: 'Open main search',
}

function samePersistedState(left: unknown, right: ProductFirstRunGuideSettings): boolean {
  if (!left || typeof left !== 'object') return false
  const value = left as Partial<ProductFirstRunGuideSettings>
  return (
    value.schema === right.schema &&
    value.status === right.status &&
    value.lastStep === right.lastStep &&
    value.firstSearchCompleted === right.firstSearchCompleted &&
    value.updatedAt === right.updatedAt &&
    Array.isArray(value.completedSteps) &&
    value.completedSteps.length === right.completedSteps.length &&
    value.completedSteps.every((step, index) => step === right.completedSteps[index])
  )
}

const FirstRunGuide: React.FC<FirstRunGuideProps> = ({ onNavigate }) => {
  const { t } = useTranslation()
  const [guideState, setGuideState] = useState<ProductFirstRunGuideSettings | null>(null)
  const [snapshot, setSnapshot] = useState<ProductReadinessSnapshot | null>(null)
  const [loadError, setLoadError] = useState(false)
  const stateRef = useRef<ProductFirstRunGuideSettings | null>(null)

  const commit = useCallback((next: ProductFirstRunGuideSettings) => {
    stateRef.current = next
    setGuideState(next)
    scheduleSettingsWrite({ firstRunGuide: next })
    return flushSettingsWrites()
  }, [])

  const refresh = useCallback(async () => {
    const nextSnapshot = await loadProductReadiness(window.electronAPI)
    setSnapshot(nextSnapshot)
    const current = stateRef.current
    if (current) {
      const reconciled = reconcileFirstRunGuide(current, nextSnapshot)
      if (reconciled !== current) void commit(reconciled)
    }
    return nextSnapshot
  }, [commit])

  useEffect(() => {
    let cancelled = false
    void window.electronAPI
      .loadSettings()
      .then(async (settings) => {
        if (cancelled) return
        const persisted = normalizeFirstRunGuideSettings(
          (settings as AppSettingsData | null)?.firstRunGuide,
        )
        // A dismissed/completed guide is invisible. Do not make it perform the
        // complete readiness probe (including large library inventories) merely
        // to decide that it should render nothing.
        if (persisted && persisted.status !== 'active') {
          stateRef.current = persisted
          setGuideState(persisted)
          setSnapshot(null)
          setLoadError(false)
          return
        }
        const initialSnapshot = await loadProductReadiness(window.electronAPI)
        if (cancelled) return
        const initial = initializeFirstRunGuide(initialSnapshot, persisted)
        stateRef.current = initial
        setGuideState(initial)
        setSnapshot(initialSnapshot)
        setLoadError(false)
        if (!samePersistedState(persisted, initial)) void commit(initial)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [commit])

  useEffect(() => {
    if (guideState?.status !== 'active') return
    const timer = window.setInterval(() => void refresh().catch(() => setLoadError(true)), 2500)
    return () => window.clearInterval(timer)
  }, [guideState?.status, refresh])

  useEffect(() => {
    const reopen = () => {
      const current = stateRef.current
      if (!current) return
      void commit(updateFirstRunGuide(current, 'reopen'))
      void refresh().catch(() => setLoadError(true))
    }
    const completeSearch = () => {
      const current = stateRef.current
      if (!current) return
      void commit(updateFirstRunGuide(current, 'search-completed'))
    }
    window.addEventListener('workspace-open-first-run-guide', reopen)
    window.addEventListener('product-first-search-completed', completeSearch)
    return () => {
      window.removeEventListener('workspace-open-first-run-guide', reopen)
      window.removeEventListener('product-first-search-completed', completeSearch)
    }
  }, [commit, refresh])

  const view = useMemo(
    () => (guideState && snapshot ? deriveFirstRunGuideView(guideState, snapshot) : null),
    [guideState, snapshot],
  )

  if (!view?.visible) return null

  const currentStep = view.currentStep === 'complete' ? null : view.currentStep
  return (
    <section
      className="first-run-guide"
      data-testid="product-first-run-guide"
      data-current-step={view.currentStep}
      aria-labelledby="first-run-guide-title"
    >
      <div className="first-run-guide__header">
        <div>
          <strong id="first-run-guide-title">{t('Getting started')}</strong>
          <small>{t('Four steps to your first searchable library.')}</small>
        </div>
        <span>
          {t('{completed} of {total}', {
            completed: view.completedCount,
            total: view.steps.length,
          })}
        </span>
      </div>
      <progress
        data-testid="first-run-progress"
        aria-label={t('Getting started progress')}
        max={100}
        value={view.progress}
      />
      <ol className="first-run-guide__steps">
        {view.steps.map((step, index) => (
          <li
            key={step.id}
            className={step.complete ? 'is-complete' : step.id === currentStep ? 'is-current' : ''}
            data-testid={`first-run-step-${step.id}`}
            data-complete={step.complete ? 'true' : 'false'}
            aria-current={step.id === currentStep ? 'step' : undefined}
          >
            <span aria-hidden="true">{step.complete ? '✓' : index + 1}</span>
            <div>
              <strong>{t(STEP_LABELS[step.id])}</strong>
              <small>{t(STEP_DESCRIPTIONS[step.id])}</small>
            </div>
          </li>
        ))}
      </ol>
      {loadError ? (
        <p className="first-run-guide__error" role="status">
          {t('Preparation status is temporarily unavailable. Your progress is saved.')}
        </p>
      ) : null}
      <div className="first-run-guide__actions">
        <button
          data-testid="first-run-skip"
          onClick={() => {
            if (guideState) void commit(updateFirstRunGuide(guideState, 'dismiss'))
          }}
        >
          {t('Skip for now')}
        </button>
        {currentStep ? (
          <button
            className="is-primary"
            data-testid="first-run-current-action"
            onClick={() => onNavigate(currentStep)}
          >
            {t(STEP_ACTIONS[currentStep])}
          </button>
        ) : (
          <button
            className="is-primary"
            data-testid="first-run-finish"
            onClick={() => {
              if (guideState) void commit(updateFirstRunGuide(guideState, 'finish'))
            }}
          >
            {t('Finish setup')}
          </button>
        )}
      </div>
    </section>
  )
}

export default FirstRunGuide
