import type { RuntimeErrorCode, RuntimeErrorPayload } from '../../shared/runtimeErrors'
import type { TranslationValues } from './core'

type Translate = (key: string, values?: TranslationValues) => string

const MESSAGE_KEYS: Record<RuntimeErrorCode, string> = {
  UNKNOWN: 'The operation failed.',
  INVALID_REQUEST: 'The request is invalid.',
  INVALID_MODEL: 'The selected model is invalid.',
  MODEL_NOT_READY: 'The selected model is not ready.',
  VECTOR_GC_RUNNING: 'Vector cleanup is currently running.',
  VECTOR_MIGRATION_RUNNING: 'Vector migration is currently running.',
  VECTOR_CLEANUP_RUNNING: 'Vector storage cleanup is currently running.',
  EMBEDDING_BUILD_RUNNING: 'An embedding build is already running.',
  EMBEDDING_BUILD_STOPPED: 'The embedding build was stopped.',
  EMBEDDING_PREPARATION_FAILED: 'Image preparation failed in the data process.',
  EMBEDDING_INPUTS_UNUSABLE: 'No usable image inputs were found.',
  EMBEDDING_WORKER_FAILED: 'The embedding worker stopped unexpectedly.',
  FRAME_MODEL_INVALID: 'The selected frame model is invalid.',
  FRAME_IMAGES_MISSING: 'Build video frames before creating frame embeddings.',
  FRAME_IMAGES_MISSING_IN_SCOPE: 'No ready video frames were found in the selected paths.',
}

export function translateRuntimeError(error: RuntimeErrorPayload, t: Translate): string {
  const message = t(MESSAGE_KEYS[error.code] || MESSAGE_KEYS.UNKNOWN, error.params)
  return error.detail
    ? `${message} ${t('Diagnostic details: {detail}', { detail: error.detail })}`
    : message
}

export function translateRuntimeFailure(
  result: { error?: string; runtimeError?: RuntimeErrorPayload } | null | undefined,
  t: Translate,
  fallbackCode: RuntimeErrorCode = 'UNKNOWN',
): string {
  if (result?.runtimeError) return translateRuntimeError(result.runtimeError, t)
  return translateRuntimeError(
    { code: fallbackCode, ...(result?.error ? { detail: result.error } : {}) },
    t,
  )
}
