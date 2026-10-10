export const RUNTIME_ERROR_CODES = [
  'UNKNOWN',
  'INVALID_REQUEST',
  'INVALID_MODEL',
  'MODEL_NOT_READY',
  'VECTOR_GC_RUNNING',
  'VECTOR_MIGRATION_RUNNING',
  'VECTOR_CLEANUP_RUNNING',
  'EMBEDDING_BUILD_RUNNING',
  'EMBEDDING_BUILD_STOPPED',
  'EMBEDDING_PREPARATION_FAILED',
  'EMBEDDING_INPUTS_UNUSABLE',
  'EMBEDDING_WORKER_FAILED',
  'FRAME_MODEL_INVALID',
  'FRAME_IMAGES_MISSING',
  'FRAME_IMAGES_MISSING_IN_SCOPE',
] as const

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number]

export interface RuntimeErrorPayload {
  code: RuntimeErrorCode
  params?: Record<string, string | number>
  /** Technical detail for diagnostics; never use this as the primary user-facing message. */
  detail?: string
}

export interface RuntimeOperationResult {
  ok: boolean
  error?: string
  runtimeError?: RuntimeErrorPayload
}

export function runtimeError(
  code: RuntimeErrorCode,
  detail?: string,
  params?: Record<string, string | number>,
): RuntimeErrorPayload {
  return {
    code,
    ...(params && Object.keys(params).length > 0 ? { params } : {}),
    ...(detail ? { detail } : {}),
  }
}

export function runtimeFailure(
  code: RuntimeErrorCode,
  detail?: string,
  params?: Record<string, string | number>,
): RuntimeOperationResult {
  return { ok: false, runtimeError: runtimeError(code, detail, params) }
}
