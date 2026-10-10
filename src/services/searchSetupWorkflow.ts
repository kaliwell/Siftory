import type { EmbeddingProgress, ModelStatus, VectorBuildRequest } from '../../shared/vectorTypes'
import type { ImageSearchPreparationProgress } from '../../shared/ipc/image-search'
import type {
  RuntimeErrorCode,
  RuntimeErrorPayload,
  RuntimeOperationResult,
} from '../../shared/runtimeErrors'

export type SearchExperienceMode = 'simple' | 'advanced'

export type SetupWorkflowState = 'idle' | 'running' | 'done' | 'error' | 'cancelled'

export interface SetupWorkflowSnapshot {
  state: SetupWorkflowState
  stepId?: string
  stepLabel?: string
  stepIndex: number
  totalSteps: number
  stepPercent: number
  percent: number
  message?: string
  error?: string
  runtimeError?: RuntimeErrorPayload
}

export interface SetupStepContext {
  signal: AbortSignal
  report: (percent?: number, message?: string) => void
}

export interface SetupWorkflowStep {
  id: string
  label: string
  run: (context: SetupStepContext) => Promise<void>
}

interface RunSetupWorkflowOptions {
  signal: AbortSignal
  onChange: (snapshot: SetupWorkflowSnapshot) => void
}

interface VectorWorkflowApi {
  getModelStatus: (modelName?: string) => Promise<ModelStatus>
  downloadModel: (modelName: string) => Promise<{ ok: boolean; error?: string }>
  startEmbeddingBuild: (request: VectorBuildRequest) => Promise<RuntimeOperationResult>
  getEmbeddingProgress: () => Promise<EmbeddingProgress>
}

interface DeferredThumbnailApi {
  startThumbnailRebuild: (
    paths: string[],
    backend: 'native',
    gpuJobs: number,
    batchSize: number,
  ) => Promise<{ ok: boolean; error?: string }>
}

export async function startDeferredSimpleThumbnails(
  api: DeferredThumbnailApi,
  paths: string[],
  enabled: boolean,
  gpuJobs: number,
  batchSize: number,
): Promise<{ started: boolean; error?: string }> {
  if (!enabled || paths.length === 0) return { started: false }
  try {
    // Embedding batch 0 means Auto; the thumbnail pipeline still expects a
    // positive batch, and its established default is 4.
    const thumbnailBatchSize = batchSize > 0 ? batchSize : 4
    const result = await api.startThumbnailRebuild(paths, 'native', gpuJobs, thumbnailBatchSize)
    return result.ok
      ? { started: true }
      : { started: false, error: result.error || 'Background thumbnail rebuild failed to start' }
  } catch (error) {
    return {
      started: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export const IDLE_SETUP_WORKFLOW: SetupWorkflowSnapshot = {
  state: 'idle',
  stepIndex: 0,
  totalSteps: 0,
  stepPercent: 0,
  percent: 0,
}

export function setupSnapshotFromImagePreparationProgress(
  progress: ImageSearchPreparationProgress,
): SetupWorkflowSnapshot {
  const phase = progress.phase ?? 'scanning'
  const step =
    phase === 'scanning' || phase === 'finalizing-scan'
      ? { id: 'scan', label: 'Scan images', index: 1 }
      : phase === 'embedding-dino' || phase === 'finalizing-dino'
        ? { id: 'dino-embeddings', label: 'Build DINO embeddings', index: 2 }
        : phase === 'embedding-clip'
          ? { id: 'clip-embeddings', label: 'Build CLIP embeddings', index: 3 }
          : { id: 'vector-index', label: 'Build vector index', index: 4 }
  const state: SetupWorkflowState =
    progress.state === 'done'
      ? 'done'
      : progress.state === 'error'
        ? 'error'
        : progress.state === 'stopped'
          ? 'cancelled'
          : progress.state === 'idle'
            ? 'idle'
            : 'running'
  return {
    state,
    stepId: step.id,
    stepLabel: step.label,
    stepIndex: state === 'done' ? 4 : step.index,
    totalSteps: 4,
    stepPercent: state === 'done' ? 100 : Math.min(99, progress.percentage),
    percent: progress.percentage,
    message: progress.message,
    error: progress.error,
  }
}

export function setupSnapshotFromEmbeddingProgress(
  progress: EmbeddingProgress,
): SetupWorkflowSnapshot | null {
  if (progress.state === 'idle') return null
  const percent = embeddingPercent(progress)
  const running = ['queued', 'running', 'paused', 'stopping'].includes(progress.state)
  const message =
    progress.currentPath ||
    (progress.state === 'done'
      ? 'Embeddings complete'
      : progress.state === 'error'
        ? 'Embedding build stopped'
        : progress.state === 'paused'
          ? 'Embedding build paused'
          : progress.state === 'stopping'
            ? 'Stopping embedding build...'
            : 'Building embeddings...')
  return {
    state: running ? 'running' : progress.state === 'done' ? 'done' : 'error',
    stepId: 'background-embeddings',
    stepLabel: 'Build embeddings',
    stepIndex: 1,
    totalSteps: 1,
    stepPercent: percent,
    percent,
    message,
    error: progress.state === 'error' ? progress.error : undefined,
    runtimeError: progress.state === 'error' ? progress.runtimeError : undefined,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Setup failed')
}

export class SetupRuntimeError extends Error {
  readonly runtimeError: RuntimeErrorPayload

  constructor(runtimeError: RuntimeErrorPayload) {
    super(runtimeError.detail || runtimeError.code)
    this.name = 'SetupRuntimeError'
    this.runtimeError = runtimeError
  }
}

export function throwRuntimeOperationFailure(
  result: Pick<RuntimeOperationResult, 'error' | 'runtimeError'>,
  fallbackCode: RuntimeErrorCode = 'UNKNOWN',
): never {
  throw new SetupRuntimeError(
    result.runtimeError ?? {
      code: fallbackCode,
      ...(result.error ? { detail: result.error } : {}),
    },
  )
}

export function throwIfSetupCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Setup cancelled', 'AbortError')
}

export function isSetupCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export async function setupDelay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfSetupCancelled(signal)
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Setup cancelled', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function runSetupWorkflow(
  steps: SetupWorkflowStep[],
  options: RunSetupWorkflowOptions,
): Promise<SetupWorkflowSnapshot> {
  const totalSteps = steps.length
  let latest: SetupWorkflowSnapshot = {
    state: 'running',
    stepIndex: 0,
    totalSteps,
    stepPercent: 0,
    percent: 0,
    message: totalSteps > 0 ? 'Preparing...' : 'Ready',
  }
  options.onChange(latest)

  try {
    for (let index = 0; index < steps.length; index++) {
      throwIfSetupCancelled(options.signal)
      const step = steps[index]
      const report = (stepPercent = 0, message = step.label) => {
        const boundedStepPercent = Math.max(0, Math.min(100, Math.round(stepPercent)))
        latest = {
          state: 'running',
          stepId: step.id,
          stepLabel: step.label,
          stepIndex: index + 1,
          totalSteps,
          stepPercent: boundedStepPercent,
          percent: Math.round(((index + boundedStepPercent / 100) / totalSteps) * 100),
          message,
        }
        options.onChange(latest)
      }
      report(0)
      await step.run({ signal: options.signal, report })
      report(100, `${step.label} complete`)
    }

    latest = {
      state: 'done',
      stepIndex: totalSteps,
      totalSteps,
      stepPercent: 100,
      percent: 100,
      message: 'Library ready',
    }
  } catch (error) {
    latest = {
      ...latest,
      state: isSetupCancellation(error) ? 'cancelled' : 'error',
      message: isSetupCancellation(error) ? 'Setup cancelled' : 'Setup stopped',
      error: isSetupCancellation(error) ? undefined : errorMessage(error),
      runtimeError: error instanceof SetupRuntimeError ? error.runtimeError : undefined,
    }
  }

  options.onChange(latest)
  return latest
}

function embeddingPercent(progress: EmbeddingProgress): number {
  if (progress.state === 'done') return 100
  if (progress.total <= 0) return 0
  const finished = progress.completed + progress.failed + progress.skipped
  return Math.min(100, Math.round((finished / progress.total) * 100))
}

export async function ensureSetupModel(
  api: VectorWorkflowApi,
  modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32',
  context: SetupStepContext,
): Promise<void> {
  throwIfSetupCancelled(context.signal)
  const current = await api.getModelStatus(modelName)
  if (
    current.state === 'downloaded' ||
    current.state === 'loaded' ||
    current.state === 'verified'
  ) {
    context.report(100, `${modelName.startsWith('clip') ? 'CLIP' : 'DINO'} model ready`)
    return
  }
  if (current.state === 'error') throw new Error(current.error || `${modelName} model is invalid`)

  context.report(
    current.progress ?? 0,
    `Downloading ${modelName.startsWith('clip') ? 'CLIP' : 'DINO'}...`,
  )
  const result = await api.downloadModel(modelName)
  throwIfSetupCancelled(context.signal)
  if (!result.ok) throw new Error(result.error || `Failed to download ${modelName}`)
  const completed = await api.getModelStatus(modelName)
  if (!['downloaded', 'loaded', 'verified'].includes(completed.state)) {
    throw new Error(completed.error || `${modelName} model is not ready`)
  }
  context.report(100, `${modelName.startsWith('clip') ? 'CLIP' : 'DINO'} model ready`)
}

export async function runSetupEmbeddingBuild(
  api: VectorWorkflowApi,
  request: VectorBuildRequest,
  context: SetupStepContext,
): Promise<void> {
  throwIfSetupCancelled(context.signal)
  context.report(0, 'Preparing missing embeddings...')
  const started = await api.startEmbeddingBuild(request)
  if (!started.ok) throwRuntimeOperationFailure(started)

  await waitForSetupEmbeddingBuild(api, context)
}

export async function waitForSetupEmbeddingBuild(
  api: Pick<VectorWorkflowApi, 'getEmbeddingProgress'>,
  context: SetupStepContext,
): Promise<void> {
  for (;;) {
    throwIfSetupCancelled(context.signal)
    const progress = await api.getEmbeddingProgress()
    const percent = embeddingPercent(progress)
    context.report(percent, progress.currentPath || `Building embeddings: ${percent}%`)
    if (progress.state === 'done') return
    if (progress.state === 'error') {
      throw new SetupRuntimeError(
        progress.runtimeError ?? {
          code: 'EMBEDDING_WORKER_FAILED',
          ...(progress.error ? { detail: progress.error } : {}),
        },
      )
    }
    if (progress.state === 'stopping' || progress.state === 'idle') {
      throw new SetupRuntimeError({
        code: 'EMBEDDING_BUILD_STOPPED',
        detail: `Unexpected embedding state: ${progress.state}`,
      })
    }
    await setupDelay(500, context.signal)
  }
}
