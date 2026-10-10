import type {
  ProductFirstRunGuideSettings,
  ProductFirstRunGuideStepId,
} from '../../shared/ipc-contract'
import type { ProductReadinessSnapshot } from './productReadiness'

export const PRODUCT_FIRST_RUN_GUIDE_SCHEMA = 1 as const
export const PRODUCT_FIRST_RUN_GUIDE_STEPS: readonly ProductFirstRunGuideStepId[] = [
  'source',
  'models',
  'catalog',
  'search',
]

const GUIDE_STATUSES = new Set<ProductFirstRunGuideSettings['status']>([
  'active',
  'dismissed',
  'completed',
])
const GUIDE_STEPS = new Set<ProductFirstRunGuideStepId>(PRODUCT_FIRST_RUN_GUIDE_STEPS)
const MANAGED_MODEL_READY_STATES = new Set(['downloaded', 'verified', 'loaded', 'ready'])

export type ProductFirstRunGuideAction = 'dismiss' | 'reopen' | 'search-completed' | 'finish'

export type ProductFirstSearchSurface = 'unified' | 'image' | 'video'

export interface ProductFirstRunGuideStep {
  id: ProductFirstRunGuideStepId
  complete: boolean
  liveComplete: boolean
  retainedFromPreviousRun: boolean
}

export interface ProductFirstRunGuideView {
  visible: boolean
  status: ProductFirstRunGuideSettings['status']
  currentStep: ProductFirstRunGuideStepId | 'complete'
  completedCount: number
  progress: number
  allComplete: boolean
  steps: ProductFirstRunGuideStep[]
}

function finiteTimestamp(value: unknown, now: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return now
  return Math.min(now, Math.floor(value))
}

function completedBefore(
  lastStep: ProductFirstRunGuideSettings['lastStep'],
): ProductFirstRunGuideStepId[] {
  if (lastStep === 'complete') return [...PRODUCT_FIRST_RUN_GUIDE_STEPS]
  const index = PRODUCT_FIRST_RUN_GUIDE_STEPS.indexOf(lastStep)
  return index <= 0 ? [] : PRODUCT_FIRST_RUN_GUIDE_STEPS.slice(0, index)
}

function firstIncomplete(completed: ReadonlySet<ProductFirstRunGuideStepId>) {
  return PRODUCT_FIRST_RUN_GUIDE_STEPS.find((step) => !completed.has(step)) ?? 'complete'
}

function sameGuideState(
  left: ProductFirstRunGuideSettings,
  right: Omit<ProductFirstRunGuideSettings, 'updatedAt'>,
): boolean {
  return (
    left.schema === right.schema &&
    left.status === right.status &&
    left.lastStep === right.lastStep &&
    left.firstSearchCompleted === right.firstSearchCompleted &&
    left.completedSteps.length === right.completedSteps.length &&
    left.completedSteps.every((step, index) => step === right.completedSteps[index])
  )
}

function canonicalState(
  state: Omit<ProductFirstRunGuideSettings, 'updatedAt' | 'lastStep' | 'completedSteps'> & {
    completedSteps: Iterable<ProductFirstRunGuideStepId>
  },
  updatedAt: number,
): ProductFirstRunGuideSettings {
  const completedSet = new Set(state.completedSteps)
  if (state.firstSearchCompleted) completedSet.add('search')
  if (state.status === 'completed') {
    for (const step of PRODUCT_FIRST_RUN_GUIDE_STEPS) completedSet.add(step)
  }
  const completedSteps = PRODUCT_FIRST_RUN_GUIDE_STEPS.filter((step) => completedSet.has(step))
  return {
    schema: PRODUCT_FIRST_RUN_GUIDE_SCHEMA,
    status: state.status,
    lastStep: firstIncomplete(completedSet),
    completedSteps,
    firstSearchCompleted: completedSet.has('search'),
    updatedAt,
  }
}

/**
 * Validate persisted onboarding state at the renderer boundary. The record is
 * deliberately limited to enum values, booleans, and a timestamp: paths,
 * filenames, search terms, and model output never enter settings.
 */
export function normalizeFirstRunGuideSettings(
  value: unknown,
  now = Date.now(),
): ProductFirstRunGuideSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<ProductFirstRunGuideSettings>
  const status = input.status
  const lastStep = input.lastStep
  if (input.schema !== PRODUCT_FIRST_RUN_GUIDE_SCHEMA || !status || !GUIDE_STATUSES.has(status)) {
    return null
  }
  if (!lastStep || (lastStep !== 'complete' && !GUIDE_STEPS.has(lastStep))) {
    return null
  }

  const explicit = Array.isArray(input.completedSteps)
    ? input.completedSteps.filter(
        (step): step is ProductFirstRunGuideStepId =>
          typeof step === 'string' && GUIDE_STEPS.has(step as ProductFirstRunGuideStepId),
      )
    : []
  const completed = new Set<ProductFirstRunGuideStepId>([...completedBefore(lastStep), ...explicit])
  return canonicalState(
    {
      schema: PRODUCT_FIRST_RUN_GUIDE_SCHEMA,
      status,
      completedSteps: completed,
      firstSearchCompleted: input.firstSearchCompleted === true,
    },
    finiteTimestamp(input.updatedAt, now),
  )
}

export function liveFirstRunGuideSteps(
  snapshot: ProductReadinessSnapshot,
): Set<ProductFirstRunGuideStepId> {
  const completed = new Set<ProductFirstRunGuideStepId>()
  const sourceStage = snapshot.stages.find((stage) => stage.id === 'sources')
  const catalogStage = snapshot.stages.find((stage) => stage.id === 'catalog')
  if ((sourceStage?.counts.sources ?? 0) > 0) completed.add('source')
  if ((catalogStage?.counts.files ?? 0) > 0) completed.add('catalog')

  const managedModels = snapshot.models.filter((model) => model.management === 'managed-download')
  if (
    managedModels.length >= 2 &&
    managedModels.every((model) => MANAGED_MODEL_READY_STATES.has(model.state))
  ) {
    completed.add('models')
  }
  return completed
}

/** Create state for a new profile, or silently migrate an already-searchable profile. */
export function initializeFirstRunGuide(
  snapshot: ProductReadinessSnapshot,
  persisted: unknown,
  now = Date.now(),
): ProductFirstRunGuideSettings {
  const normalized = normalizeFirstRunGuideSettings(persisted, now)
  if (normalized) return reconcileFirstRunGuide(normalized, snapshot, now)

  const existingSearchableProfile = snapshot.searchable
  return canonicalState(
    {
      schema: PRODUCT_FIRST_RUN_GUIDE_SCHEMA,
      status: existingSearchableProfile ? 'completed' : 'active',
      completedSteps: existingSearchableProfile
        ? PRODUCT_FIRST_RUN_GUIDE_STEPS
        : liveFirstRunGuideSteps(snapshot),
      firstSearchCompleted: existingSearchableProfile,
    },
    now,
  )
}

/** Merge live readiness into durable, monotonic first-run progress. */
export function reconcileFirstRunGuide(
  state: ProductFirstRunGuideSettings,
  snapshot: ProductReadinessSnapshot,
  now = Date.now(),
): ProductFirstRunGuideSettings {
  const normalized = normalizeFirstRunGuideSettings(state, now)
  if (!normalized) return initializeFirstRunGuide(snapshot, null, now)
  const completed = new Set<ProductFirstRunGuideStepId>([
    ...normalized.completedSteps,
    ...liveFirstRunGuideSteps(snapshot),
  ])
  const next = canonicalState(
    {
      schema: PRODUCT_FIRST_RUN_GUIDE_SCHEMA,
      status: normalized.status,
      completedSteps: completed,
      firstSearchCompleted: normalized.firstSearchCompleted,
    },
    normalized.updatedAt,
  )
  return sameGuideState(normalized, next) ? normalized : { ...next, updatedAt: now }
}

export function updateFirstRunGuide(
  state: ProductFirstRunGuideSettings,
  action: ProductFirstRunGuideAction,
  now = Date.now(),
): ProductFirstRunGuideSettings {
  const normalized = normalizeFirstRunGuideSettings(state, now)
  if (!normalized) throw new TypeError('Invalid first-run guide state')
  const completed = new Set(normalized.completedSteps)
  if (action === 'search-completed') completed.add('search')
  const allComplete = PRODUCT_FIRST_RUN_GUIDE_STEPS.every((step) => completed.has(step))
  const status =
    action === 'dismiss'
      ? 'dismissed'
      : action === 'reopen'
        ? 'active'
        : action === 'finish' && allComplete
          ? 'completed'
          : normalized.status
  const next = canonicalState(
    {
      schema: PRODUCT_FIRST_RUN_GUIDE_SCHEMA,
      status,
      completedSteps: completed,
      firstSearchCompleted: normalized.firstSearchCompleted || action === 'search-completed',
    },
    normalized.updatedAt,
  )
  return sameGuideState(normalized, next) ? normalized : { ...next, updatedAt: now }
}

export function deriveFirstRunGuideView(
  state: ProductFirstRunGuideSettings,
  snapshot: ProductReadinessSnapshot,
): ProductFirstRunGuideView {
  const reconciled = reconcileFirstRunGuide(state, snapshot, state.updatedAt)
  const completed = new Set(reconciled.completedSteps)
  const live = liveFirstRunGuideSteps(snapshot)
  const steps = PRODUCT_FIRST_RUN_GUIDE_STEPS.map((id) => ({
    id,
    complete: completed.has(id),
    liveComplete: live.has(id) || (id === 'search' && reconciled.firstSearchCompleted),
    retainedFromPreviousRun:
      completed.has(id) && !live.has(id) && !(id === 'search' && reconciled.firstSearchCompleted),
  }))
  const completedCount = steps.filter((step) => step.complete).length
  return {
    visible: reconciled.status === 'active',
    status: reconciled.status,
    currentStep: reconciled.lastStep,
    completedCount,
    progress: Math.round((completedCount / PRODUCT_FIRST_RUN_GUIDE_STEPS.length) * 100),
    allComplete: completedCount === PRODUCT_FIRST_RUN_GUIDE_STEPS.length,
    steps,
  }
}

/** Announce only the successful surface; query text and result data stay private. */
export function announceFirstSearchCompleted(surface: ProductFirstSearchSurface): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('product-first-search-completed', {
      detail: { surface },
    }),
  )
}
