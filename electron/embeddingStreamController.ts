import type { EmbeddingProgress, EmbeddingType } from '../shared/vectorTypes'
import { runtimeFailure, type RuntimeOperationResult } from '../shared/runtimeErrors'

const MAX_STREAM_APPEND_INPUTS = 256
const MAX_STREAM_INPUT_PATH_LENGTH = 32_768
export const MAX_DIRECTML_STREAM_CONCURRENCY = 2
export const MAX_OTHER_GPU_STREAM_CONCURRENCY = 4

export interface StreamingEmbeddingJob {
  id?: number
  imageId: string
  path: string
}

export interface StreamingPendingInput {
  imageId: string
  path: string
  modelName: string
  embeddingType: EmbeddingType
  retries: number
  createdAt: number
  updatedAt: number
}

export interface StreamingEmbeddingTask {
  jobId?: number
}

export interface EmbeddingStreamOpenOptions<TTask extends StreamingEmbeddingTask> {
  sessionId: string
  modelName: string
  embeddingType: EmbeddingType
  backend: 'cpu' | 'gpu' | 'cuda'
  knownImageKeys: Iterable<string>
  initialRequested: number
  initialAccepted: number
  createTask: (job: StreamingEmbeddingJob) => TTask
}

interface ActiveEmbeddingStream<TTask extends StreamingEmbeddingTask> {
  sessionId: string
  modelName: string
  embeddingType: EmbeddingType
  backend: 'cpu' | 'gpu' | 'cuda'
  open: boolean
  knownImageKeys: Set<string>
  createTask: (job: StreamingEmbeddingJob) => TTask
}

export interface EmbeddingStreamRuntimeState {
  stopping: boolean
  paused: boolean
  progress: Pick<EmbeddingProgress, 'state' | 'total' | 'skipped' | 'running' | 'currentPath'>
  currentConcurrency: number
  queueLength: number
  pendingPersistence: number
}

export interface EmbeddingStreamControllerDependencies<TTask extends StreamingEmbeddingTask> {
  getState: () => EmbeddingStreamRuntimeState
  resolveInputPath: (inputPath: string) => string
  inputPathKey: (inputPath: string) => string
  addPending: (inputs: StreamingPendingInput[]) => StreamingEmbeddingJob[] | null
  skipJob: (jobId: number, reason: string) => void
  validate: (tasks: TTask[]) => Promise<{ accepted: TTask[]; rejected: number }>
  enqueue: (tasks: TTask[], requested: number, rejected: number) => void
  persist: () => void
  dispatch: (modelName: string) => void
  scaleWorkers: (modelName: string, targetConcurrency: number) => number
  writeDiagnostic: (event: string, data: Record<string, unknown>) => void
  checkCompletion: () => void
}

export interface ParsedEmbeddingStreamRequest {
  sessionId: string | null
  error?: RuntimeOperationResult
}

export function parseEmbeddingStreamRequest(input: {
  streamSessionId?: string
  imageIds?: readonly string[]
  scanPaths?: readonly string[]
}): ParsedEmbeddingStreamRequest {
  if (input.streamSessionId === undefined) return { sessionId: null }
  if (
    typeof input.streamSessionId !== 'string' ||
    !/^[a-f0-9-]{16,80}$/i.test(input.streamSessionId)
  ) {
    return {
      sessionId: null,
      error: runtimeFailure('INVALID_REQUEST', 'Invalid embedding stream session id'),
    }
  }
  if (!input.imageIds?.length || input.scanPaths?.length) {
    return {
      sessionId: null,
      error: runtimeFailure(
        'INVALID_REQUEST',
        'Streaming embedding builds require an explicit initial image set',
      ),
    }
  }
  return { sessionId: input.streamSessionId }
}

function isRunningState(state: EmbeddingProgress['state']): boolean {
  return state === 'running' || state === 'paused'
}

export function createEmbeddingStreamController<TTask extends StreamingEmbeddingTask>(
  dependencies: EmbeddingStreamControllerDependencies<TTask>,
): {
  open: (options: EmbeddingStreamOpenOptions<TTask>) => void
  clear: () => void
  isOpen: () => boolean
  isReady: (sessionId: string) => boolean
  append: (
    sessionId: string,
    imageIds: readonly string[],
    options?: { replaceKnown?: boolean },
  ) => Promise<RuntimeOperationResult>
  scale: (sessionId: string, requestedConcurrency: number) => RuntimeOperationResult
  close: (sessionId: string) => RuntimeOperationResult
} {
  let active: ActiveEmbeddingStream<TTask> | null = null

  const getActive = (sessionId: string): ActiveEmbeddingStream<TTask> | null =>
    active?.open && active.sessionId === sessionId ? active : null

  const operationalFailure = (): RuntimeOperationResult | null => {
    const state = dependencies.getState()
    return state.stopping || !isRunningState(state.progress.state)
      ? runtimeFailure('EMBEDDING_BUILD_STOPPED')
      : null
  }

  const open = (options: EmbeddingStreamOpenOptions<TTask>): void => {
    active = {
      sessionId: options.sessionId,
      modelName: options.modelName,
      embeddingType: options.embeddingType,
      backend: options.backend,
      open: true,
      knownImageKeys: new Set(options.knownImageKeys),
      createTask: options.createTask,
    }
    dependencies.writeDiagnostic('stream:open', {
      sessionId: options.sessionId,
      initialRequested: options.initialRequested,
      initialAccepted: options.initialAccepted,
    })
  }

  const append = async (
    sessionId: string,
    imageIds: readonly string[],
    options: { replaceKnown?: boolean } = {},
  ): Promise<RuntimeOperationResult> => {
    const stream = getActive(sessionId)
    if (!stream) return runtimeFailure('INVALID_REQUEST', 'Embedding stream is not ready')
    const runtimeFailureResult = operationalFailure()
    if (runtimeFailureResult) return runtimeFailureResult

    const acceptedInputs: string[] = []
    const seen = new Set<string>()
    for (const rawImageId of imageIds) {
      if (
        typeof rawImageId !== 'string' ||
        rawImageId.length === 0 ||
        rawImageId.length > MAX_STREAM_INPUT_PATH_LENGTH
      ) {
        continue
      }
      try {
        const imageId = dependencies.resolveInputPath(rawImageId)
        const key = dependencies.inputPathKey(imageId)
        if (!key || seen.has(key)) continue
        if (stream.knownImageKeys.has(key) && !options.replaceKnown) continue
        if (options.replaceKnown) stream.knownImageKeys.delete(key)
        seen.add(key)
        stream.knownImageKeys.add(key)
        acceptedInputs.push(imageId)
      } catch {
        continue
      }
      if (acceptedInputs.length >= MAX_STREAM_APPEND_INPUTS) break
    }
    if (acceptedInputs.length === 0) return { ok: true }

    const now = Date.now()
    const jobs = dependencies.addPending(
      acceptedInputs.map((imageId) => ({
        imageId,
        path: imageId,
        modelName: stream.modelName,
        embeddingType: stream.embeddingType,
        retries: 0,
        createdAt: now,
        updatedAt: now,
      })),
    )
    if (!jobs) {
      return runtimeFailure('EMBEDDING_PREPARATION_FAILED', 'Embedding ledger missing')
    }
    const candidates = jobs.map(stream.createTask)
    const validation = await dependencies.validate(candidates)
    if (active !== stream || operationalFailure()) {
      return runtimeFailure('EMBEDDING_BUILD_STOPPED')
    }
    const acceptedJobIds = new Set(
      validation.accepted.flatMap((task) => (task.jobId === undefined ? [] : [task.jobId])),
    )
    for (const candidate of candidates) {
      if (candidate.jobId !== undefined && !acceptedJobIds.has(candidate.jobId)) {
        dependencies.skipJob(candidate.jobId, 'Embedding stream input validation rejected the file')
      }
    }
    dependencies.enqueue(validation.accepted, acceptedInputs.length, validation.rejected)
    dependencies.persist()
    if (!dependencies.getState().paused && validation.accepted.length > 0) {
      dependencies.dispatch(stream.modelName)
    }
    dependencies.writeDiagnostic('stream:append', {
      sessionId,
      requested: imageIds.length,
      accepted: validation.accepted.length,
      rejected: validation.rejected,
      pending: dependencies.getState().queueLength,
    })
    return { ok: true }
  }

  const scale = (sessionId: string, requestedConcurrency: number): RuntimeOperationResult => {
    const stream = getActive(sessionId)
    if (!stream) return runtimeFailure('INVALID_REQUEST', 'Embedding stream is not ready')
    const runtimeFailureResult = operationalFailure()
    if (runtimeFailureResult) return runtimeFailureResult
    const state = dependencies.getState()
    const providerLimit =
      stream.backend === 'gpu'
        ? process.platform === 'win32'
          ? MAX_DIRECTML_STREAM_CONCURRENCY
          : MAX_OTHER_GPU_STREAM_CONCURRENCY
        : 1
    const target = Math.max(
      state.currentConcurrency,
      Math.min(providerLimit, Math.max(1, Math.floor(Number(requestedConcurrency) || 1))),
    )
    if (target === state.currentConcurrency) return { ok: true }
    const startedChildren = dependencies.scaleWorkers(stream.modelName, target)
    if (!state.paused) dependencies.dispatch(stream.modelName)
    dependencies.writeDiagnostic('stream:scale', {
      sessionId,
      requestedConcurrency,
      effectiveConcurrency: target,
      startedChildren,
      pending: dependencies.getState().queueLength,
    })
    return { ok: true }
  }

  const close = (sessionId: string): RuntimeOperationResult => {
    const stream = getActive(sessionId)
    if (!stream) return runtimeFailure('INVALID_REQUEST', 'Embedding stream is not ready')
    stream.open = false
    const state = dependencies.getState()
    dependencies.writeDiagnostic('stream:close', {
      sessionId,
      pending: state.queueLength,
      running: state.progress.running,
      pendingPersistence: state.pendingPersistence,
    })
    dependencies.checkCompletion()
    return { ok: true }
  }

  return {
    open,
    clear: () => {
      active = null
    },
    isOpen: () => Boolean(active?.open),
    isReady: (sessionId) =>
      Boolean(getActive(sessionId) && isRunningState(dependencies.getState().progress.state)),
    append,
    scale,
    close,
  }
}
