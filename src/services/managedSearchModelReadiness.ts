import type { ModelStatus } from '../../shared/vectorTypes'

export const MANAGED_SEARCH_MODEL_NAMES = ['dinov2_vitb14', 'clip_vit_base_patch32'] as const

export type ManagedSearchModelName = (typeof MANAGED_SEARCH_MODEL_NAMES)[number]

export type ManagedSearchModelStatuses = Record<ManagedSearchModelName, ModelStatus>

export type ManagedSearchModelReadinessState = 'checking' | 'ready' | 'busy' | 'blocked' | 'error'

export interface ManagedSearchModelReadiness {
  state: ManagedSearchModelReadinessState
  canExecuteAiTasks: boolean
  readyCount: number
  totalCount: number
  unavailableModels: ManagedSearchModelName[]
}

const READY_STATES = new Set<ModelStatus['state']>(['downloaded', 'verified', 'loaded'])
const BUSY_STATES = new Set<ModelStatus['state']>(['downloading', 'loading', 'unloading'])

export function createInitialManagedSearchModelStatuses(): ManagedSearchModelStatuses {
  return {
    dinov2_vitb14: { name: 'dinov2_vitb14', state: 'not-installed' },
    clip_vit_base_patch32: { name: 'clip_vit_base_patch32', state: 'not-installed' },
  }
}

export function isManagedSearchModelName(value: string): value is ManagedSearchModelName {
  return MANAGED_SEARCH_MODEL_NAMES.some((name) => name === value)
}

export function isManagedSearchModelReady(status: ModelStatus | null | undefined): boolean {
  return Boolean(status && READY_STATES.has(status.state) && status.installedPath)
}

export function resolveManagedSearchModelReadiness(
  statuses: ManagedSearchModelStatuses,
  checking: boolean,
  checkError?: string | null,
): ManagedSearchModelReadiness {
  const unavailableModels = MANAGED_SEARCH_MODEL_NAMES.filter(
    (name) => !isManagedSearchModelReady(statuses[name]),
  )
  const readyCount = MANAGED_SEARCH_MODEL_NAMES.length - unavailableModels.length
  const base = {
    readyCount,
    totalCount: MANAGED_SEARCH_MODEL_NAMES.length,
    unavailableModels,
  }

  if (checking) return { ...base, state: 'checking', canExecuteAiTasks: false }
  if (checkError || MANAGED_SEARCH_MODEL_NAMES.some((name) => statuses[name].state === 'error')) {
    return { ...base, state: 'error', canExecuteAiTasks: false }
  }
  if (unavailableModels.length === 0) {
    return { ...base, state: 'ready', canExecuteAiTasks: true }
  }
  if (MANAGED_SEARCH_MODEL_NAMES.some((name) => BUSY_STATES.has(statuses[name].state))) {
    return { ...base, state: 'busy', canExecuteAiTasks: false }
  }
  return { ...base, state: 'blocked', canExecuteAiTasks: false }
}
