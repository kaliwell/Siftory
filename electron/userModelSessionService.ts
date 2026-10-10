// ── User Model Session Facade ──────────────────────────────
// Main-process facade in front of the isolated user-model runtime child
// (electron/userModelRuntimeHost.ts). The subject/face/person services hold
// cached SESSION METADATA here instead of live onnxruntime sessions, so the
// unvetted model binary is only ever loaded inside the disposable child.
// Cache semantics mirror the previous per-service behavior: entries are keyed
// by getUserModelFileSignature and dropped on onBeforeUserModelMutation.
//
// Explicit negative states: embedding pipelines distinguish 'model-missing'
// (slot empty), 'model-invalid' (load failure), 'output-invalid' (the model
// ran but its output failed strict validation), 'no-subject' (a successful
// run that found nothing) and 'input-unreadable' (image decode failure)
// instead of collapsing them into a silent empty result.

import {
  getUserModelSlotDefinition,
  USER_MODEL_SLOTS,
  type UserModelRuntimeStatus,
  type UserModelSlotId,
} from '../shared/userModelPlatform'
import {
  MAX_EMBEDDING_VECTOR_DIM,
  requireNormalizedEmbeddingVector,
} from './embeddingVectorValidation'
import {
  getUserModelFileSignature,
  getUserModelPath,
  onBeforeUserModelMutation,
} from './userModelPlatformService'
import {
  loadUserModelSessionInIsolation,
  runSamDecoderInIsolation,
  runUserModelInIsolation,
  type UserModelChildSessionInfo,
  type UserModelRunFeed,
  type UserModelRunOutput,
  type UserModelSamMaskOutput,
  type UserModelSessionTensorMetadata,
} from './userModelRuntimeHost'

export type UserModelNegativeReason =
  | 'model-missing'
  | 'model-invalid'
  | 'output-invalid'
  | 'no-subject'
  | 'input-unreadable'

export interface UserModelSession {
  slotId: UserModelSlotId
  signature: string
  inputNames: string[]
  outputNames: string[]
  inputMetadata: UserModelSessionTensorMetadata[]
  outputMetadata: UserModelSessionTensorMetadata[]
}

export interface UserModelSessionAcquisition {
  session: UserModelSession | null
  error?: string
  reason?: UserModelNegativeReason
}

interface SlotState {
  signature: string
  session: UserModelSession | null
  error?: string
}

const slotStates = new Map<UserModelSlotId, SlotState>()

onBeforeUserModelMutation(async (slotId) => {
  slotStates.delete(slotId)
})

/** Test hook: drop cached session metadata without a model mutation. */
export function resetUserModelSessionsForTests(): void {
  slotStates.clear()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function slotMaxBytes(slotId: UserModelSlotId): number {
  const slot = getUserModelSlotDefinition(slotId)
  if (!slot) throw new Error(`Unknown user model slot: ${slotId}`)
  return slot.maxSizeBytes
}

/**
 * Resolve the slot's current model session metadata, loading the model inside
 * the isolated child on first use per file signature. Load failures are
 * cached per signature, exactly like the previous in-main session cache.
 */
export async function acquireUserModelSession(
  slotId: UserModelSlotId,
): Promise<UserModelSessionAcquisition> {
  const signature = getUserModelFileSignature(slotId)
  if (!signature) {
    slotStates.delete(slotId)
    return {
      session: null,
      error: `No compatible ${slotId} model is installed in Model Platform`,
      reason: 'model-missing',
    }
  }
  const cached = slotStates.get(slotId)
  if (cached && cached.signature === signature) {
    return {
      session: cached.session,
      error: cached.error,
      reason: cached.session ? undefined : 'model-invalid',
    }
  }
  try {
    const info: UserModelChildSessionInfo = await loadUserModelSessionInIsolation(
      getUserModelPath(slotId),
      slotMaxBytes(slotId),
    )
    const session: UserModelSession = { slotId, signature, ...info }
    slotStates.set(slotId, { signature, session })
    return { session }
  } catch (error) {
    const message = errorMessage(error)
    slotStates.set(slotId, { signature, session: null, error: message })
    return { session: null, error: message, reason: 'model-invalid' }
  }
}

/**
 * Deep readiness check used only from the explicit model-status surface.
 * Installed, user-supplied ONNX files are loaded one at a time in the isolated
 * runtime child so checking all slots cannot create a startup memory spike.
 */
export async function checkUserModelRuntimeSlots(): Promise<UserModelRuntimeStatus[]> {
  const checkedAt = Date.now()
  const statuses: UserModelRuntimeStatus[] = []
  for (const slot of USER_MODEL_SLOTS) {
    const result = await acquireUserModelSession(slot.id)
    if (result.session) {
      statuses.push({ slotId: slot.id, state: 'ready', checkedAt })
      continue
    }
    statuses.push({
      slotId: slot.id,
      state: result.reason === 'model-missing' ? 'not-installed' : 'error',
      checkedAt,
      ...(result.error ? { error: result.error } : {}),
    })
  }
  return statuses
}

/** Execute one inference for an acquired session inside the isolated child. */
export async function runUserModelSession(
  session: UserModelSession,
  feeds: readonly UserModelRunFeed[],
): Promise<Map<string, UserModelRunOutput>> {
  const outputs = await runUserModelInIsolation(
    getUserModelPath(session.slotId),
    slotMaxBytes(session.slotId),
    feeds,
  )
  return new Map(outputs.map((output) => [output.name, output]))
}

/** Execute the original-size SAM decoder through its compact mask transport. */
export async function runSamDecoderSession(
  session: UserModelSession,
  feeds: readonly UserModelRunFeed[],
  masksOutputName: string,
  iouOutputName: string,
): Promise<UserModelSamMaskOutput> {
  if (session.slotId !== 'segment-decoder') {
    throw new Error('Compact SAM decoder execution requires the segment-decoder slot')
  }
  return runSamDecoderInIsolation(
    getUserModelPath(session.slotId),
    slotMaxBytes(session.slotId),
    feeds,
    masksOutputName,
    iouOutputName,
  )
}

/**
 * Strictly validate an unvetted model's embedding output (VAL-021 rules:
 * finite components, non-zero norm, sane dimension) and return it
 * L2-normalized. Throws with a detailed reason when the output is hostile or
 * corrupt — callers map that to the 'output-invalid' negative state.
 */
export function requireStrictUserModelEmbedding(data: ArrayLike<number>, label: string): number[] {
  const length = data.length
  if (!Number.isInteger(length) || length < 2 || length > MAX_EMBEDDING_VECTOR_DIM) {
    throw new Error(`${label} embedding length ${length} is outside the platform safety limit`)
  }
  try {
    return requireNormalizedEmbeddingVector(data as number[] | Float32Array, length)
  } catch (error) {
    throw new Error(`${label} output failed validation: ${errorMessage(error)}`, {
      cause: error,
    })
  }
}
