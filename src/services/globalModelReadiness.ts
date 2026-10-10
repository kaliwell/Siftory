import type { AudioSemanticUiStatus, VideoSemanticUiStatus } from '../../shared/ipc-contract'
import {
  USER_MODEL_SLOTS,
  type UserModelRuntimeStatus,
  type UserModelSlotId,
  type UserModelSlotStatus,
} from '../../shared/userModelPlatform'
import type { ModelStatus } from '../../shared/vectorTypes'

export const GLOBAL_MANAGED_MODEL_NAMES = [
  'dinov2_vitb14',
  'clip_vit_base_patch32',
  'clip_vit_b32_multilingual_v1_text',
] as const

export type GlobalManagedModelName = (typeof GLOBAL_MANAGED_MODEL_NAMES)[number]
export type GlobalExternalModelId = 'qwen3-vl' | 'sensevoice' | 'fsmn-vad' | 'campplus-speaker'
export type GlobalModelId = GlobalManagedModelName | GlobalExternalModelId | UserModelSlotId
export type GlobalModelGroup = 'image' | 'video' | 'audio' | 'subject'
export type GlobalModelSource = 'managed' | 'external-runtime' | 'user-model'
export type GlobalModelReadinessState =
  | 'checking'
  | 'ready'
  | 'busy'
  | 'not-installed'
  | 'unavailable'
  | 'error'

export interface GlobalModelReadinessItem {
  id: GlobalModelId
  group: GlobalModelGroup
  source: GlobalModelSource
  state: GlobalModelReadinessState
  detail?: string
  runtimeChecked: boolean
}

export interface GlobalModelReadinessInput {
  managedStatuses: Partial<Record<GlobalManagedModelName, ModelStatus | null>>
  userSlots: readonly UserModelSlotStatus[] | null
  userRuntimeStatuses?: readonly UserModelRuntimeStatus[] | null
  videoSemantic: VideoSemanticUiStatus | null
  audioSemantic: AudioSemanticUiStatus | null
  checking: boolean
  checkedAt: number | null
  issues?: readonly string[]
}

export interface GlobalModelReadinessSnapshot {
  items: GlobalModelReadinessItem[]
  totalCount: number
  readyCount: number
  busyCount: number
  unavailableCount: number
  state: 'checking' | 'ready' | 'partial' | 'unavailable'
  checkedAt: number | null
  issues: string[]
}

const READY_MANAGED_STATES = new Set<ModelStatus['state']>(['downloaded', 'verified', 'loaded'])
const BUSY_MANAGED_STATES = new Set<ModelStatus['state']>(['downloading', 'loading', 'unloading'])

function managedState(
  status: ModelStatus | null | undefined,
  fallback: 'checking' | 'unavailable',
): GlobalModelReadinessState {
  if (!status) return fallback
  if (READY_MANAGED_STATES.has(status.state) && status.installedPath) return 'ready'
  if (BUSY_MANAGED_STATES.has(status.state)) return 'busy'
  if (status.state === 'not-installed') return 'not-installed'
  if (status.state === 'error') return 'error'
  return 'unavailable'
}

function externalState(
  state: 'not-installed' | 'ready' | 'busy' | 'unavailable' | 'error' | undefined,
  fallback: 'checking' | 'unavailable',
): GlobalModelReadinessState {
  if (!state) return fallback
  return state
}

function userModelState(
  slot: UserModelSlotStatus | undefined,
  runtime: UserModelRuntimeStatus | undefined,
  fallback: 'checking' | 'unavailable',
): Pick<GlobalModelReadinessItem, 'state' | 'detail' | 'runtimeChecked'> {
  if (runtime) {
    return {
      state: runtime.state,
      ...(runtime.error ? { detail: runtime.error } : {}),
      runtimeChecked: true,
    }
  }
  if (!slot) return { state: fallback, runtimeChecked: false }
  if (!slot.installed) return { state: 'not-installed', runtimeChecked: false }
  if (slot.inspection?.compatible === true) return { state: 'ready', runtimeChecked: false }
  if (slot.inspection?.compatible === false) {
    return {
      state: 'error',
      detail: slot.inspection.warnings.join('; ') || undefined,
      runtimeChecked: false,
    }
  }
  return { state: 'unavailable', runtimeChecked: false }
}

function runtimeItem(
  id: GlobalExternalModelId,
  group: 'video' | 'audio',
  state: GlobalModelReadinessState,
  detail?: string,
): GlobalModelReadinessItem {
  return {
    id,
    group,
    source: 'external-runtime',
    state,
    ...(detail ? { detail } : {}),
    runtimeChecked: state !== 'checking',
  }
}

export function buildGlobalModelReadiness(
  input: GlobalModelReadinessInput,
): GlobalModelReadinessSnapshot {
  const initialChecking = input.checking && input.checkedAt === null
  const fallbackState = initialChecking ? 'checking' : 'unavailable'
  const items: GlobalModelReadinessItem[] = GLOBAL_MANAGED_MODEL_NAMES.map((id) => {
    const status = input.managedStatuses[id]
    return {
      id,
      group: 'image',
      source: 'managed' as const,
      state: managedState(status, fallbackState),
      ...(status?.error ? { detail: status.error } : {}),
      runtimeChecked: false,
    }
  })

  items.push(
    runtimeItem(
      'qwen3-vl',
      'video',
      externalState(input.videoSemantic?.runtime.state, fallbackState),
      input.videoSemantic?.runtime.reason,
    ),
    runtimeItem(
      'sensevoice',
      'audio',
      externalState(input.audioSemantic?.runtime.state, fallbackState),
      input.audioSemantic?.runtime.reason,
    ),
  )

  const diarization = input.audioSemantic?.diarization
  const diarizationState = externalState(diarization?.state, fallbackState)
  items.push(
    runtimeItem(
      'fsmn-vad',
      'audio',
      diarizationState === 'ready' && !diarization?.vadModel ? 'unavailable' : diarizationState,
      diarization?.reason,
    ),
    runtimeItem(
      'campplus-speaker',
      'audio',
      diarizationState === 'ready' && !diarization?.speakerModel ? 'unavailable' : diarizationState,
      diarization?.reason,
    ),
  )

  const runtimeBySlot = new Map(
    (input.userRuntimeStatuses ?? []).map((status) => [status.slotId, status]),
  )
  const slotById = new Map((input.userSlots ?? []).map((slot) => [slot.id, slot]))
  for (const definition of USER_MODEL_SLOTS) {
    const slot = slotById.get(definition.id)
    items.push({
      id: definition.id,
      group: 'subject',
      source: 'user-model',
      ...userModelState(slot, runtimeBySlot.get(definition.id), fallbackState),
    })
  }

  const readyCount = items.filter((item) => item.state === 'ready').length
  const busyCount = items.filter((item) => item.state === 'busy').length
  const unavailableCount = items.length - readyCount - busyCount
  const state = initialChecking
    ? 'checking'
    : readyCount === items.length
      ? 'ready'
      : readyCount > 0 || busyCount > 0
        ? 'partial'
        : 'unavailable'

  return {
    items,
    totalCount: items.length,
    readyCount,
    busyCount,
    unavailableCount,
    state,
    checkedAt: input.checkedAt,
    issues: [...(input.issues ?? [])],
  }
}

export function canExecuteGlobalModelTask(
  snapshot: GlobalModelReadinessSnapshot,
  modelIds: readonly GlobalModelId[],
): boolean {
  const states = new Map(snapshot.items.map((item) => [item.id, item.state]))
  return modelIds.length > 0 && modelIds.every((id) => states.get(id) === 'ready')
}
