// Orchestrates isolated embedding workers and persists results through vectorDatabaseService.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import type {
  EmbeddingProgress,
  EmbeddingJob,
  VectorBuildRequest,
  EmbeddingType,
  EmbeddingEntry,
} from '../shared/vectorTypes'
import {
  jobStore,
  appendEmbeddingNoUpsertAsync,
  enforceEmbeddingJobRetention,
  getEmbeddingStorePaths,
} from './vectorDatabaseService'
import { getModelInfo, getModelStatus } from './modelService'
import { getVisionModelCapability, isVisionModelName, type VisionModelName } from './modelRegistry'
import {
  appendEmbeddingDiagnostic,
  appendEmbeddingFailure,
  enforceEmbeddingFailureRetention,
  getEmbeddingLogHealth,
} from './embeddingLogRetention'
import { resolveProjectSearchInputPath } from './projectSearchIndexService'
import {
  filterSupportedEmbeddingInputs,
  prepareEmbeddingScanInputsInChild,
  type PreparedEmbeddingScanResult,
} from './embeddingInputValidation'
import { collectExistingEmbeddingIds as collectExistingEmbeddingIdsFromStores } from './embeddingExistingIndex'
import { runtimeError, runtimeFailure, type RuntimeOperationResult } from '../shared/runtimeErrors'
import {
  resolveEmbeddingInferenceProvider,
  type EmbeddingProviderResolution,
} from './embeddingCudaRuntime'
import { type EmbeddingJobLeaseToken } from './embeddingJobEpochLedger'
import { EmbeddingJobLedgerSession } from './embeddingJobLedgerSession'
import { seedEmbeddingJobsIntoStore } from './embeddingJobSeeder'
import { readNvidiaVideoMemory, selectEmbeddingBatchSize } from './embeddingBatchPolicy'
import {
  batchMetricsFromChildMessage,
  createEmbeddingStageMetrics,
  embeddingStageMetricsEnabled,
  providerTelemetryFromChildMessage,
  type EmbeddingWorkerBatchMetrics,
  type EmbeddingWorkerChildMessage,
  withEmbeddingProviderTelemetry,
  workerResultFromChildMessage,
} from './embeddingChildLineFraming'
import {
  decodeEmbeddingChildVector,
  EmbeddingChildBinaryFrameDecoder,
  type EmbeddingChildBinaryFrame,
} from './embeddingChildBinaryProtocol'
import { embeddingCachePathKey } from './embeddingF16Cache'
import {
  createEmbeddingStreamController,
  MAX_DIRECTML_STREAM_CONCURRENCY as MAX_DIRECTML_GPU_CONCURRENCY,
  MAX_OTHER_GPU_STREAM_CONCURRENCY as MAX_OTHER_GPU_CONCURRENCY,
  parseEmbeddingStreamRequest,
} from './embeddingStreamController'
import {
  decideEmbeddingTensorPrefetch,
  embeddingTensorPrefetchRequested,
} from './embeddingTensorPrefetchPolicy'
import {
  embeddingProcessMemorySnapshot,
  nextEmbeddingProgress,
  recordEmbeddingBatchRuntime,
  recordEmbeddingPersistenceEnqueuedRuntime,
  recordEmbeddingPersistenceFinishedRuntime,
} from './embeddingProgressRuntime'
import {
  decideEmbeddingRuntimeResources,
  type EmbeddingRuntimeResourceDecision,
} from './embeddingRuntimeResourcePolicy'
import type { UnifiedResourcePressureSnapshot } from './resourceGovernor'

export type EmbeddingProgressCallback = (progress: EmbeddingProgress) => void

interface WorkerTask {
  imageId: string
  imagePath: string
  modelName: string
  modelPath: string
  inputSize: number
  dim: number
  backend: 'cpu' | 'gpu' | 'cuda'
  cuda?: NonNullable<EmbeddingProviderResolution['cuda']>
  batchSize: number
  jobId?: number
  jobLease?: EmbeddingJobLeaseToken
}

interface WorkerResult {
  imageId: string
  ok: boolean
  vector?: number[]
  error?: string
  modelName: string
  modelVersion: string
  dim: number
  jobId?: number
  jobLease?: EmbeddingJobLeaseToken
}

let progress: EmbeddingProgress = {
  total: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
  running: 0,
  pending: 0,
  state: 'idle',
}
let progressListeners: EmbeddingProgressCallback[] = []
let taskQueue: WorkerTask[] = []
let paused = false
let stopping = false
let maxConcurrency = 2
let providerConcurrencyLimit = 2
let failureLogPath = ''
let diagnosticLogPath = ''
let buildRunId = ''
let buildTraceProvider = ''
let buildTraceModel = ''
let dispatchedTaskCount = 0
const clipChildren = new Set<ChildProcessWithoutNullStreams>()
const clipChildTasks = new WeakMap<ChildProcessWithoutNullStreams, Map<number, WorkerTask>>()
const dinoChildren = new Set<ChildProcessWithoutNullStreams>()
const dinoChildTasks = new WeakMap<ChildProcessWithoutNullStreams, Map<number, WorkerTask>>()
const failedClipChildren = new WeakSet<ChildProcessWithoutNullStreams>()
const failedDinoChildren = new WeakSet<ChildProcessWithoutNullStreams>()
let clipTaskSeq = 1
let clipCrashCount = 0
let dinoTaskSeq = 1
let dinoCrashCount = 0
let preparationChild: ChildProcessWithoutNullStreams | null = null
let preparationProducerOpen = false
let inferenceStartedAt: number | undefined
let inferencePausedAt: number | undefined
let inferencePausedTotalMs = 0
let pendingPersistence = 0
let stageMetrics = createEmbeddingStageMetrics()
const DEFAULT_GPU_CONCURRENCY = 2

function recordEmbeddingBatchMetrics(metrics: EmbeddingWorkerBatchMetrics): void {
  stageMetrics = recordEmbeddingBatchRuntime({
    metrics,
    runId: buildRunId,
    provider: buildTraceProvider,
    stageMetrics,
  })!
  // The immediately following result frame will emit normal progress. Keeping
  // telemetry aggregation silent avoids an extra UI/listener broadcast per batch.
  progress = { ...progress, stageMetrics }
}

function recordPersistenceEnqueued(): Partial<EmbeddingProgress> {
  stageMetrics = recordEmbeddingPersistenceEnqueuedRuntime(stageMetrics, pendingPersistence)!
  return { stageMetrics }
}

function recordPersistenceFinished(startedAt: number): Partial<EmbeddingProgress> {
  stageMetrics = recordEmbeddingPersistenceFinishedRuntime({
    startedAt,
    runId: buildRunId,
    model: buildTraceModel,
    provider: buildTraceProvider,
    pendingPersistence,
    stageMetrics,
  })!
  return { stageMetrics }
}

const embeddingStreamController = createEmbeddingStreamController<WorkerTask>({
  getState: () => ({
    stopping,
    paused,
    progress,
    currentConcurrency: maxConcurrency,
    queueLength: taskQueue.length,
    pendingPersistence,
  }),
  resolveInputPath: resolveProjectSearchInputPath,
  inputPathKey: embeddingCachePathKey,
  addPending: (inputs) => jobLedgerSession.current?.addPending(inputs) ?? null,
  skipJob: (jobId, reason) => jobLedgerSession.current?.skip(jobId, reason),
  validate: (tasks) =>
    filterSupportedEmbeddingInputs(tasks, {
      cachePath: path.join(getVectorDbDir(), 'embedding-input-rejections.json'),
      isCancelled: () => stopping,
    }),
  enqueue: (tasks, requested, rejected) => {
    taskQueue.push(...tasks)
    updateProgress({
      total: progress.total + requested,
      skipped: progress.skipped + rejected,
      pending: taskQueue.length,
      currentPath:
        tasks.length > 0
          ? `Queued ${tasks.length} committed embedding input(s)`
          : progress.currentPath,
    })
  },
  persist: () => jobLedgerSession.persist('stream-append'),
  dispatch: (modelName) => {
    if (modelName === 'clip_vit_base_patch32') {
      if (clipChildren.size === 0) startClipChildBuild()
      else dispatchNextClipTask()
    } else if (dinoChildren.size === 0) {
      startDinoChildBuild()
    } else {
      dispatchNextDinoTask()
    }
  },
  scaleWorkers: (modelName, targetConcurrency) => {
    maxConcurrency = targetConcurrency
    const children = modelName === 'clip_vit_base_patch32' ? clipChildren : dinoChildren
    const spawnChild = modelName === 'clip_vit_base_patch32' ? spawnClipChild : spawnDinoChild
    const toStart = Math.min(Math.max(0, maxConcurrency - children.size), taskQueue.length)
    for (let index = 0; index < toStart; index += 1) children.add(spawnChild())
    return toStart
  },
  writeDiagnostic,
  checkCompletion,
})

function nowIso(): string {
  return new Date().toISOString()
}

function getVectorDbDir(): string {
  return process.env.APPDATA && fs.existsSync(process.env.APPDATA)
    ? path.join(process.env.APPDATA, 'floating-clock-electron', 'vector-db')
    : path.join(process.cwd(), 'vector-db')
}

function getDiagnosticLogPath(): string {
  if (!diagnosticLogPath) {
    diagnosticLogPath = path.join(getVectorDbDir(), 'embedding_diagnostics.jsonl')
  }
  return diagnosticLogPath
}

function writeDiagnostic(event: string, data: Record<string, unknown> = {}): void {
  appendEmbeddingDiagnostic(getDiagnosticLogPath(), {
    time: nowIso(),
    runId: buildRunId || undefined,
    event,
    ...data,
  })
}

const jobLedgerSession = new EmbeddingJobLedgerSession(jobStore, writeDiagnostic)

function claimTaskJob(task: WorkerTask): boolean {
  if (task.jobId === undefined) return true
  const lease = jobLedgerSession.claim(task.jobId)
  if (!lease) return false
  task.jobLease = lease
  return true
}

function completeTaskJob(result: WorkerResult): void {
  if (result.jobId === undefined || !result.jobLease) return
  jobLedgerSession.complete(result.jobId, result.jobLease)
}

function failTaskJob(
  result: WorkerResult,
  error = result.error || 'Unknown embedding error',
): void {
  if (result.jobId === undefined || !result.jobLease) return
  jobLedgerSession.fail(result.jobId, result.jobLease, error)
}

function getMemorySnapshot(): Record<string, number> {
  return embeddingProcessMemorySnapshot()
}

function emitProgress(): void {
  const p = { ...progress }
  for (const cb of progressListeners) {
    try {
      cb(p)
    } catch {
      /* ignore */
    }
  }
}

function updateProgress(patch: Partial<EmbeddingProgress>): void {
  progress = nextEmbeddingProgress(progress, patch, {
    inferenceStartedAt,
    inferencePausedAt,
    inferencePausedTotalMs,
  })
  emitProgress()
}

function getFailureLogPath(): string {
  if (!failureLogPath) {
    const userData =
      process.env.APPDATA && fs.existsSync(process.env.APPDATA)
        ? path.join(process.env.APPDATA, 'floating-clock-electron')
        : process.cwd()
    failureLogPath = path.join(userData, 'vector-db', 'embedding_failures.jsonl')
  }
  return failureLogPath
}

function logEmbeddingFailure(result: WorkerResult): void {
  appendEmbeddingFailure(getFailureLogPath(), {
    time: new Date().toISOString(),
    imageId: result.imageId,
    modelName: result.modelName,
    modelVersion: result.modelVersion,
    dim: result.dim,
    error: result.error || 'Unknown embedding error',
  })
}

export { getEmbeddingLogHealth }

async function collectExistingEmbeddingIds(
  modelName: string,
  embeddingType: EmbeddingType,
  dim: number,
): Promise<Set<string>> {
  const filePaths = getEmbeddingStorePaths(modelName, embeddingType)
  return collectExistingEmbeddingIdsFromStores({
    vectorDbDir: getVectorDbDir(),
    modelName,
    embeddingType,
    dim,
    sourcePaths: filePaths,
    isCancelled: () => stopping,
    onDiagnostic: writeDiagnostic,
    onStatus: (currentPath) => updateProgress({ currentPath }),
  })
}

function handleResult(result: WorkerResult): void {
  if (result.ok && result.vector) {
    const completedAfter = progress.completed + 1
    if (completedAfter <= 5 || completedAfter % 1000 === 0) {
      writeDiagnostic('task:result-ok-sample', {
        imageId: result.imageId,
        modelName: result.modelName,
        dim: result.dim,
        completedAfter,
      })
    }
    const entry: Omit<EmbeddingEntry, 'id'> = {
      imageId: result.imageId,
      modelName: result.modelName,
      modelVersion: result.modelVersion,
      embeddingType: 'global',
      dim: result.dim,
      vector: result.vector,
      norm: 0, // calculated in upsertEmbedding
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const persistenceBuildRunId = buildRunId
    const persistenceStartedAt = embeddingStageMetricsEnabled() ? performance.now() : 0
    pendingPersistence++
    updateProgress({
      running: progress.running - 1,
      ...recordPersistenceEnqueued(),
    })
    void appendEmbeddingNoUpsertAsync(entry)
      .then(() => {
        if (persistenceBuildRunId !== buildRunId) return
        pendingPersistence--
        completeTaskJob(result)
        updateProgress({
          completed: progress.completed + 1,
          ...recordPersistenceFinished(persistenceStartedAt),
        })
        checkCompletion()
      })
      .catch((error) => {
        if (persistenceBuildRunId !== buildRunId) return
        pendingPersistence--
        const failedResult = {
          ...result,
          ok: false,
          error: `Vector persistence failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
        logEmbeddingFailure(failedResult)
        failTaskJob(failedResult, failedResult.error)
        updateProgress({
          failed: progress.failed + 1,
          ...recordPersistenceFinished(persistenceStartedAt),
        })
        checkCompletion()
      })
  } else {
    const failedAfter = progress.failed + 1
    if (failedAfter <= 20 || failedAfter % 250 === 0) {
      writeDiagnostic('task:result-fail-sample', {
        imageId: result.imageId,
        modelName: result.modelName,
        error: result.error || 'Unknown embedding error',
        failedAfter,
      })
    }
    logEmbeddingFailure(result)
    failTaskJob(result)
    updateProgress({ failed: failedAfter, running: progress.running - 1 })
  }

  if (!result.ok || !result.vector) checkCompletion()
}

function checkCompletion(): void {
  if (
    progress.state === 'running' &&
    taskQueue.length === 0 &&
    progress.running === 0 &&
    pendingPersistence === 0 &&
    !embeddingStreamController.isOpen() &&
    !preparationProducerOpen &&
    !stopping
  ) {
    const state = 'done'
    writeDiagnostic('build:complete', {
      state,
      completed: progress.completed,
      failed: progress.failed,
      skipped: progress.skipped,
      elapsedMs: progress.elapsedMs,
    })
    updateProgress({ state, currentImageId: undefined, currentPath: undefined })
    jobLedgerSession.finish('build-complete', false)
    stopAllWorkers()
  }
}

function stopAllWorkers(): void {
  embeddingStreamController.clear()
  preparationProducerOpen = false
  taskQueue = []
  if (preparationChild) {
    terminateOwnedEmbeddingChild(preparationChild, 'stop-preparation-worker')
    preparationChild = null
  }
  stopClipChild()
  stopDinoChild()
  jobLedgerSession.finish(
    progress.state === 'error' ? 'build-error-release' : 'build-stop-release',
    true,
  )
  updateProgress({
    state: progress.state === 'error' ? 'error' : 'done',
    running: 0,
    pending: 0,
  })
}

function getEmbeddingChildPath(modelName: VisionModelName): string {
  const childEntry = getVisionModelCapability(modelName).childEntry
  const candidates = [
    path.join(__dirname, childEntry),
    path.join(process.resourcesPath || '', childEntry),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* ok */
    }
  }
  return candidates[0]
}

function getClipChildPath(): string {
  return getEmbeddingChildPath('clip_vit_base_patch32')
}

function getDinoChildPath(): string {
  return getEmbeddingChildPath('dinov2_vitb14')
}

function prepareScanInputsInChild(
  req: VectorBuildRequest,
  dim: number,
  onChunk?: (items: PreparedEmbeddingScanResult['inputs']) => Promise<void>,
  chunkSize?: number,
): Promise<PreparedEmbeddingScanResult> {
  const vectorDbDir = getVectorDbDir()
  return prepareEmbeddingScanInputsInChild({
    request: req,
    dim,
    vectorDbDir,
    sourcePaths: getEmbeddingStorePaths(req.modelName, req.embeddingType),
    isStopping: () => stopping,
    onChildState: (child) => {
      preparationChild = child
    },
    onProgress: (message) => updateProgress({ currentPath: message }),
    onDiagnostic: (message) => writeDiagnostic('preparation-child:stderr', { message }),
    onChunk,
    chunkSize,
  })
}

function terminateOwnedEmbeddingChild(child: ChildProcessWithoutNullStreams, reason: string): void {
  try {
    child.stdin.end()
  } catch {
    /* The pipe may already be closed. */
  }
  try {
    if (!child.killed && child.exitCode === null) child.kill()
  } catch {
    /* The child may have exited between the ownership checks. */
  }
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
  writeDiagnostic('embedding-child:terminate', { pid: child.pid, reason })
}

function stopClipChild(): void {
  for (const child of clipChildren) {
    clipChildTasks.delete(child)
    terminateOwnedEmbeddingChild(child, 'stop-clip-workers')
  }
  clipChildren.clear()
}

function stopDinoChild(): void {
  for (const child of dinoChildren) {
    dinoChildTasks.delete(child)
    terminateOwnedEmbeddingChild(child, 'stop-dino-workers')
  }
  dinoChildren.clear()
}

function handleDinoChildFailure(child: ChildProcessWithoutNullStreams, error: string): void {
  // A completed build deliberately kills and removes its children. Their asynchronous
  // exit events can arrive after the next model build has started; ignore those stale
  // events so they cannot complete or stop the new build's shared progress state.
  if (!dinoChildren.has(child)) return
  if (failedDinoChildren.has(child)) return
  failedDinoChildren.add(child)
  dinoChildren.delete(child)
  const tasks = dinoChildTasks.get(child)
  dinoChildTasks.delete(child)
  if (stopping || progress.state === 'done' || progress.state === 'error') return
  writeDiagnostic('dino-child:failure', {
    pid: child.pid,
    error,
    crashCountBefore: dinoCrashCount,
    queueLength: taskQueue.length,
  })
  if (tasks && tasks.size > 0) {
    dinoCrashCount++
    for (const task of tasks.values()) {
      handleResult({
        imageId: task.imageId,
        ok: false,
        error,
        modelName: task.modelName,
        modelVersion: '1.0.0',
        dim: task.dim,
        jobId: task.jobId,
        jobLease: task.jobLease,
      })
    }
    if (dinoCrashCount >= 3) {
      taskQueue = []
      writeDiagnostic('dino-child:stop-repeated-failure', { dinoCrashCount, error })
      updateProgress({
        state: 'error',
        error: 'DINO GPU child process failed repeatedly. Build DINO GPU stopped.',
        runtimeError: runtimeError('EMBEDDING_WORKER_FAILED', error, { model: 'DINO' }),
      })
      stopAllWorkers()
      return
    }
  }
  if (!stopping && !paused && taskQueue.length > 0 && dinoCrashCount < 3) {
    const replacement = spawnDinoChild()
    dinoChildren.add(replacement)
    writeDiagnostic('dino-child:replacement', {
      pid: replacement.pid,
      queueLength: taskQueue.length,
    })
  }
  dispatchNextDinoTask()
}

function handleClipChildFailure(child: ChildProcessWithoutNullStreams, error: string): void {
  if (!clipChildren.has(child)) return
  if (failedClipChildren.has(child)) return
  failedClipChildren.add(child)
  clipChildren.delete(child)
  const tasks = clipChildTasks.get(child)
  clipChildTasks.delete(child)
  if (stopping || progress.state === 'done' || progress.state === 'error') return
  writeDiagnostic('clip-child:failure', {
    pid: child.pid,
    error,
    crashCountBefore: clipCrashCount,
    queueLength: taskQueue.length,
  })
  if (tasks && tasks.size > 0) {
    clipCrashCount++
    for (const task of tasks.values()) {
      handleResult({
        imageId: task.imageId,
        ok: false,
        error,
        modelName: task.modelName,
        modelVersion: '1.0.0',
        dim: task.dim,
        jobId: task.jobId,
        jobLease: task.jobLease,
      })
    }
    if (clipCrashCount >= 3) {
      taskQueue = []
      updateProgress({
        state: 'error',
        error: 'CLIP child process failed repeatedly. Build CLIP stopped.',
        runtimeError: runtimeError('EMBEDDING_WORKER_FAILED', error, { model: 'CLIP' }),
      })
      stopAllWorkers()
      return
    }
  }
  if (!stopping && !paused && taskQueue.length > 0 && clipCrashCount < 3) {
    const replacement = spawnClipChild()
    clipChildren.add(replacement)
  }
  dispatchNextClipTask()
}

function spawnClipChild(): ChildProcessWithoutNullStreams {
  const nodePath = [
    process.env.NODE_PATH,
    path.join(process.resourcesPath || '', 'app.asar', 'node_modules'),
    path.join(process.resourcesPath || '', 'app', 'node_modules'),
    path.join(__dirname, '..', 'node_modules'),
  ]
    .filter(Boolean)
    .join(path.delimiter)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: nodePath }
  const child = spawn(process.execPath, [getClipChildPath()], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stderr.setEncoding('utf8')
  const stdoutDecoder = new EmbeddingChildBinaryFrameDecoder()
  child.stdout.on('data', (chunk: Buffer) => {
    const decoded = stdoutDecoder.push(chunk)
    if (decoded.overflow) {
      handleClipChildFailure(child, 'CLIP child emitted an invalid or oversized binary frame')
      terminateOwnedEmbeddingChild(child, 'invalid-clip-frame')
      return
    }
    for (const frame of decoded.frames) handleClipChildFrame(child, frame)
  })
  child.stderr.on('data', (chunk: string) => {
    console.warn('[clipEmbeddingChild]', chunk.trim())
  })
  child.stdin.on('error', (err) => {
    handleClipChildFailure(child, `CLIP child stdin error: ${err.message}`)
  })
  child.on('error', (err) => {
    handleClipChildFailure(child, `CLIP child process error: ${err.message}`)
  })
  child.on('exit', (code, signal) => {
    handleClipChildFailure(
      child,
      `CLIP child crashed: code=${code ?? 'null'} signal=${signal ?? 'null'}`,
    )
  })
  return child
}

function spawnDinoChild(): ChildProcessWithoutNullStreams {
  const nodePath = [
    process.env.NODE_PATH,
    path.join(process.resourcesPath || '', 'app.asar', 'node_modules'),
    path.join(process.resourcesPath || '', 'app', 'node_modules'),
    path.join(__dirname, '..', 'node_modules'),
  ]
    .filter(Boolean)
    .join(path.delimiter)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: nodePath }
  const child = spawn(process.execPath, [getDinoChildPath()], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  writeDiagnostic('dino-child:spawn', {
    pid: child.pid,
    childPath: getDinoChildPath(),
    maxConcurrency,
    queueLength: taskQueue.length,
  })
  child.stderr.setEncoding('utf8')
  const stdoutDecoder = new EmbeddingChildBinaryFrameDecoder()
  child.stdout.on('data', (chunk: Buffer) => {
    const decoded = stdoutDecoder.push(chunk)
    if (decoded.overflow) {
      handleDinoChildFailure(child, 'DINO child emitted an invalid or oversized binary frame')
      terminateOwnedEmbeddingChild(child, 'invalid-dino-frame')
      return
    }
    for (const frame of decoded.frames) handleDinoChildFrame(child, frame)
  })
  child.stderr.on('data', (chunk: string) => {
    console.warn('[dinoEmbeddingChild]', chunk.trim())
    writeDiagnostic('dino-child:stderr', { pid: child.pid, message: chunk.trim().slice(0, 1000) })
  })
  child.stdin.on('error', (err) => {
    console.warn('[dinoEmbeddingChild] stdin error:', err.message)
    handleDinoChildFailure(child, `DINO child stdin error: ${err.message}`)
  })
  child.on('error', (err) => {
    console.warn('[dinoEmbeddingChild] process error:', err.message)
    handleDinoChildFailure(child, `DINO child process error: ${err.message}`)
  })
  child.on('exit', (code, signal) => {
    writeDiagnostic('dino-child:exit', { pid: child.pid, code, signal })
    handleDinoChildFailure(
      child,
      `DINO child crashed: code=${code ?? 'null'} signal=${signal ?? 'null'}`,
    )
  })
  return child
}

function materializeEmbeddingChildMessage(
  frame: EmbeddingChildBinaryFrame,
  task: WorkerTask | undefined,
): EmbeddingWorkerChildMessage {
  const msg = frame.header as EmbeddingWorkerChildMessage
  if (frame.body.length === 0) return msg
  if (!task) throw new Error('Embedding child vector has no active task owner')
  msg.vector = decodeEmbeddingChildVector(frame, task.dim)
  return msg
}

function handleClipChildFrame(
  child: ChildProcessWithoutNullStreams,
  frame: EmbeddingChildBinaryFrame,
): void {
  const assigned = Number.isInteger(frame.header.id)
    ? clipChildTasks.get(child)?.get(frame.header.id as number)
    : undefined
  let msg: EmbeddingWorkerChildMessage
  try {
    msg = materializeEmbeddingChildMessage(frame, assigned)
  } catch (error) {
    handleClipChildFailure(
      child,
      `CLIP child binary frame failed validation: ${error instanceof Error ? error.message : String(error)}`,
    )
    terminateOwnedEmbeddingChild(child, 'invalid-clip-vector-frame')
    return
  }
  const providerTelemetry = providerTelemetryFromChildMessage(msg)
  if (providerTelemetry?.model === 'clip') {
    progress = withEmbeddingProviderTelemetry(progress, providerTelemetry)
    return
  }
  if (msg.type === 'provider-selected') return
  if (msg.type === 'prefetch-request') {
    dispatchNextClipTask(child, true)
    return
  }
  const metrics = batchMetricsFromChildMessage(msg)
  if (metrics?.model === 'clip') recordEmbeddingBatchMetrics(metrics)
  if (msg.type === 'batch-metrics') return
  if (msg.type === 'ready') {
    dispatchNextClipTask(child)
    if (embeddingTensorPrefetchRequested()) dispatchNextClipTask(child, true)
    return
  }
  if (!Number.isInteger(msg.id)) return
  const tasks = clipChildTasks.get(child)
  const task = tasks?.get(msg.id!)
  if (!tasks || !task) return
  tasks.delete(msg.id!)
  clipCrashCount = 0
  handleResult(workerResultFromChildMessage(task, msg, 'CLIP'))
  if (tasks.size === 0 && clipChildren.has(child)) {
    dispatchNextClipTask(child)
    if (embeddingTensorPrefetchRequested()) dispatchNextClipTask(child, true)
  } else if (
    embeddingTensorPrefetchRequested() &&
    tasks.size === Math.max(1, Math.min(16, task.batchSize || 1))
  ) {
    dispatchNextClipTask(child, true)
  }
}

function handleDinoChildFrame(
  child: ChildProcessWithoutNullStreams,
  frame: EmbeddingChildBinaryFrame,
): void {
  const assigned = Number.isInteger(frame.header.id)
    ? dinoChildTasks.get(child)?.get(frame.header.id as number)
    : undefined
  let msg: EmbeddingWorkerChildMessage
  try {
    msg = materializeEmbeddingChildMessage(frame, assigned)
  } catch (error) {
    handleDinoChildFailure(
      child,
      `DINO child binary frame failed validation: ${error instanceof Error ? error.message : String(error)}`,
    )
    terminateOwnedEmbeddingChild(child, 'invalid-dino-vector-frame')
    return
  }
  const providerTelemetry = providerTelemetryFromChildMessage(msg)
  if (providerTelemetry?.model === 'dino') {
    progress = withEmbeddingProviderTelemetry(progress, providerTelemetry)
    return
  }
  if (msg.type === 'provider-selected') return
  const metrics = batchMetricsFromChildMessage(msg)
  if (metrics?.model === 'dino') recordEmbeddingBatchMetrics(metrics)
  if (msg.type === 'batch-metrics') return
  if (msg.type === 'ready') {
    writeDiagnostic('dino-child:ready', { pid: child.pid, queueLength: taskQueue.length })
    dispatchNextDinoTask(child)
    return
  }
  if (!Number.isInteger(msg.id)) return
  const tasks = dinoChildTasks.get(child)
  const task = tasks?.get(msg.id!)
  if (!tasks || !task) return
  tasks.delete(msg.id!)
  dinoCrashCount = 0
  handleResult(workerResultFromChildMessage(task, msg, 'DINO'))
  if (tasks.size === 0 && dinoChildren.has(child)) dispatchNextDinoTask(child)
}

function activeTaskCount(
  children: Set<ChildProcessWithoutNullStreams>,
  assignments: WeakMap<ChildProcessWithoutNullStreams, Map<number, WorkerTask>>,
): number {
  let count = 0
  for (const child of children) count += assignments.get(child)?.size || 0
  return count
}

function retireIdleEmbeddingChildren(
  children: Set<ChildProcessWithoutNullStreams>,
  assignments: WeakMap<ChildProcessWithoutNullStreams, Map<number, WorkerTask>>,
  targetConcurrency: number,
  reason: string,
): number {
  let retired = 0
  for (const child of [...children]) {
    if (children.size <= targetConcurrency) break
    if ((assignments.get(child)?.size || 0) > 0) continue
    children.delete(child)
    assignments.delete(child)
    terminateOwnedEmbeddingChild(child, `resource-pressure:${reason}`)
    retired++
    writeDiagnostic('embedding-child:retire-idle', { pid: child.pid, reason, targetConcurrency })
  }
  return retired
}

function retireEmbeddingChildIfAboveLimit(
  child: ChildProcessWithoutNullStreams,
  children: Set<ChildProcessWithoutNullStreams>,
  assignments: WeakMap<ChildProcessWithoutNullStreams, Map<number, WorkerTask>>,
): boolean {
  if (children.size <= maxConcurrency || (assignments.get(child)?.size || 0) > 0) return false
  children.delete(child)
  assignments.delete(child)
  terminateOwnedEmbeddingChild(child, 'above-runtime-concurrency-limit')
  writeDiagnostic('embedding-child:retire-after-batch', {
    pid: child.pid,
    maxConcurrency,
  })
  return true
}

function takeClaimedTaskBatch(requestedBatchSize: number): WorkerTask[] {
  const batch: WorkerTask[] = []
  let fenced = 0
  const candidates = taskQueue.splice(0, requestedBatchSize)
  for (const task of candidates) {
    if (claimTaskJob(task)) batch.push(task)
    else fenced++
  }
  if (fenced > 0) {
    writeDiagnostic('jobs:claim-fenced', { fenced, epoch: jobLedgerSession.current?.epoch })
    updateProgress({ skipped: progress.skipped + fenced, pending: taskQueue.length })
  }
  return batch
}

function dispatchNextClipTask(
  child?: ChildProcessWithoutNullStreams,
  prefetchRequest = false,
): void {
  if (paused || stopping || taskQueue.length === 0) {
    checkCompletion()
    return
  }
  if (!child) {
    for (const candidate of clipChildren) {
      if ((clipChildTasks.get(candidate)?.size || 0) === 0) {
        dispatchNextClipTask(candidate)
      }
    }
    return
  }
  if (retireEmbeddingChildIfAboveLimit(child, clipChildren, clipChildTasks)) return
  const assignments = clipChildTasks.get(child) || new Map<number, WorkerTask>()
  const requestedBatchSize = Math.max(1, Math.min(16, taskQueue[0]?.batchSize || 1))
  if (assignments.size > 0) {
    if (!prefetchRequest) return
    const decision = decideEmbeddingTensorPrefetch({
      requested: embeddingTensorPrefetchRequested(),
      backend: taskQueue[0]?.backend || 'cpu',
      paused,
      stopping,
      queueLength: taskQueue.length,
      assignedTasks: assignments.size,
      batchSize: requestedBatchSize,
      freeSystemMemoryBytes: os.freemem(),
    })
    if (!decision.allowed) {
      writeDiagnostic('clip-prefetch:skip', {
        pid: child.pid,
        reason: decision.reason,
        assignedTasks: assignments.size,
        queueLength: taskQueue.length,
      })
      return
    }
  }
  const batch = takeClaimedTaskBatch(requestedBatchSize)
  if (batch.length === 0) {
    checkCompletion()
    return
  }
  let payload = ''
  for (const task of batch) {
    const id = clipTaskSeq++
    assignments.set(id, task)
    payload += `${JSON.stringify({
      id,
      imageId: task.imageId,
      imagePath: task.imagePath,
      modelPath: task.modelPath,
      inputSize: task.inputSize,
      dim: task.dim,
      backend: task.backend,
      cuda: task.cuda,
      batchSize: task.batchSize,
      batchLength: batch.length,
    })}\n`
  }
  clipChildTasks.set(child, assignments)
  if (prefetchRequest) {
    writeDiagnostic('clip-prefetch:dispatch', {
      pid: child.pid,
      batchSize: batch.length,
      assignedTasks: assignments.size,
      queueLengthAfterShift: taskQueue.length,
    })
  }
  updateProgress({
    running: activeTaskCount(clipChildren, clipChildTasks),
    pending: taskQueue.length,
    currentImageId: batch[batch.length - 1].imageId,
    currentPath: batch[batch.length - 1].imagePath,
  })
  if (child.killed || child.exitCode !== null || !child.stdin.writable) {
    handleClipChildFailure(child, 'CLIP child stdin is not writable')
    return
  }
  try {
    child.stdin.write(payload, (err) => {
      if (err) handleClipChildFailure(child, `CLIP child stdin write failed: ${err.message}`)
    })
  } catch (err: unknown) {
    handleClipChildFailure(
      child,
      `CLIP child stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function dispatchNextDinoTask(child?: ChildProcessWithoutNullStreams): void {
  if (paused || stopping || taskQueue.length === 0) {
    checkCompletion()
    return
  }
  if (!child) {
    for (const candidate of dinoChildren) {
      if ((dinoChildTasks.get(candidate)?.size || 0) === 0) {
        dispatchNextDinoTask(candidate)
      }
    }
    return
  }
  if (retireEmbeddingChildIfAboveLimit(child, dinoChildren, dinoChildTasks)) return
  if ((dinoChildTasks.get(child)?.size || 0) > 0) return
  const requestedBatchSize = Math.max(1, Math.min(16, taskQueue[0]?.batchSize || 1))
  const batch = takeClaimedTaskBatch(requestedBatchSize)
  if (batch.length === 0) {
    checkCompletion()
    return
  }
  const assignments = new Map<number, WorkerTask>()
  let payload = ''
  for (const task of batch) {
    const id = dinoTaskSeq++
    assignments.set(id, task)
    payload += `${JSON.stringify({
      id,
      imageId: task.imageId,
      imagePath: task.imagePath,
      modelPath: task.modelPath,
      inputSize: task.inputSize,
      dim: task.dim,
      backend: task.backend,
      cuda: task.cuda,
      batchSize: task.batchSize,
    })}\n`
  }
  dinoChildTasks.set(child, assignments)
  dispatchedTaskCount += batch.length
  writeDiagnostic('task:dispatch-dino-batch', {
    pid: child.pid,
    batchSize: batch.length,
    dispatchedTaskCount,
    modelName: batch[0].modelName,
    backend: batch[0].backend,
    queueLengthAfterShift: taskQueue.length,
  })
  updateProgress({
    running: activeTaskCount(dinoChildren, dinoChildTasks),
    pending: taskQueue.length,
    currentImageId: batch[batch.length - 1].imageId,
    currentPath: batch[batch.length - 1].imagePath,
  })
  if (child.killed || child.exitCode !== null || !child.stdin.writable) {
    handleDinoChildFailure(child, 'DINO child stdin is not writable')
    return
  }
  try {
    child.stdin.write(payload, (err) => {
      if (err) handleDinoChildFailure(child, `DINO child stdin write failed: ${err.message}`)
    })
  } catch (err: unknown) {
    handleDinoChildFailure(
      child,
      `DINO child stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function startClipChildBuild(): void {
  clipCrashCount = 0
  stopClipChild()
  const toStart = Math.min(maxConcurrency, taskQueue.length)
  for (let i = 0; i < toStart; i++) {
    const child = spawnClipChild()
    clipChildren.add(child)
  }
}

function startDinoChildBuild(): void {
  dinoCrashCount = 0
  stopDinoChild()
  const toStart = Math.min(maxConcurrency, taskQueue.length)
  writeDiagnostic('dino-build:start-children', {
    toStart,
    maxConcurrency,
    taskQueueLength: taskQueue.length,
  })
  for (let i = 0; i < toStart; i++) {
    const child = spawnDinoChild()
    dinoChildren.add(child)
  }
}

export function onEmbeddingProgress(cb: EmbeddingProgressCallback): () => void {
  progressListeners.push(cb)
  return () => {
    progressListeners = progressListeners.filter((l) => l !== cb)
  }
}

export function getEmbeddingProgress(): EmbeddingProgress {
  return { ...progress }
}

export function reserveEmbeddingBuild(req: VectorBuildRequest): RuntimeOperationResult {
  if (['queued', 'running', 'paused', 'stopping'].includes(progress.state)) {
    return runtimeFailure('EMBEDDING_BUILD_RUNNING')
  }
  const modelInfo = getModelInfo(req.modelName)
  if (!modelInfo) return runtimeFailure('INVALID_MODEL', `Unknown model: ${req.modelName}`)
  const modelStatus = getModelStatus(req.modelName)
  if (modelStatus.state !== 'downloaded') {
    return runtimeFailure('MODEL_NOT_READY', `Model state: ${modelStatus.state}`, {
      modelName: req.modelName,
      state: modelStatus.state,
    })
  }
  stopping = false
  updateProgress({
    total: req.imageIds?.length ?? 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    running: 0,
    pending: req.imageIds?.length ?? 0,
    state: 'queued',
    startedAt: Date.now(),
    currentPath: 'Waiting for the unified embedding lane...',
    error: undefined,
    runtimeError: undefined,
  })
  return { ok: true }
}

export function finishQueuedEmbeddingBuild(error?: unknown): boolean {
  if (progress.state !== 'queued') return false
  stopping = Boolean(error)
  updateProgress({
    state: error ? 'error' : 'done',
    running: 0,
    pending: 0,
    currentPath: undefined,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  })
  return true
}

export function failActiveEmbeddingBuild(error: unknown): boolean {
  if (!['queued', 'running', 'paused', 'stopping'].includes(progress.state)) return false
  const message = error instanceof Error ? error.message : String(error)
  stopping = true
  taskQueue = []
  updateProgress({ state: 'error', error: message, running: 0, pending: 0 })
  stopAllWorkers()
  return true
}

export async function startEmbeddingBuild(
  req: VectorBuildRequest,
  options: { acceptQueuedReservation?: boolean } = {},
): Promise<RuntimeOperationResult> {
  // Fence a second request before it can replace the active run identity used
  // by asynchronous vector persistence callbacks.
  const activeStates = options.acceptQueuedReservation
    ? ['running', 'paused', 'stopping']
    : ['queued', 'running', 'paused', 'stopping']
  if (activeStates.includes(progress.state)) {
    writeDiagnostic('build:reject', { reason: 'already-running', progress })
    return runtimeFailure('EMBEDDING_BUILD_RUNNING')
  }
  const streamRequest = parseEmbeddingStreamRequest(req)
  if (streamRequest.error) return streamRequest.error
  const streamSessionId = streamRequest.sessionId
  buildRunId = `emb-${Date.now()}-${Math.random().toString(36).slice(2)}`
  buildTraceModel = req.modelName
  dispatchedTaskCount = 0
  writeDiagnostic('build:start-request', {
    req,
    diagnosticLogPath: getDiagnosticLogPath(),
  })
  enforceEmbeddingFailureRetention(getFailureLogPath())
  try {
    const retention = enforceEmbeddingJobRetention()
    if (retention.removed > 0) writeDiagnostic('jobs:retention', retention)
  } catch (error: unknown) {
    writeDiagnostic('jobs:retention-error', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  const modelInfo = getModelInfo(req.modelName)
  if (!modelInfo) {
    writeDiagnostic('build:reject', { reason: 'unknown-model', modelName: req.modelName })
    return runtimeFailure('INVALID_MODEL', `Unknown model: ${req.modelName}`, {
      modelName: req.modelName,
    })
  }

  const modelStatus = getModelStatus(req.modelName)
  if (modelStatus.state !== 'downloaded') {
    writeDiagnostic('build:reject', { reason: 'model-not-ready', modelStatus })
    return runtimeFailure('MODEL_NOT_READY', `Model state: ${modelStatus.state}`, {
      modelName: req.modelName,
      state: modelStatus.state,
    })
  }
  const visionModelName = isVisionModelName(req.modelName) ? req.modelName : null
  const modelCapability = visionModelName ? getVisionModelCapability(visionModelName) : null

  // Reset state
  stopping = false
  paused = false
  taskQueue = []
  embeddingStreamController.clear()
  const requestedRuntimeBackend =
    modelCapability?.defaultBackend === 'gpu' && req.backend === 'gpu' ? 'gpu' : 'cpu'
  const modelPath = modelStatus.installedPath || ''
  const providerResolution = resolveEmbeddingInferenceProvider({
    backend: requestedRuntimeBackend,
    modelName: req.modelName,
    modelPath,
    cudaRuntimeDir: path.join(path.dirname(getVectorDbDir()), 'cuda-runtime'),
    cudaRuntimeManifestPath: path.join(process.resourcesPath || '', 'runtime-manifest.json'),
  })
  buildTraceProvider = providerResolution.provider
  const effectiveBackend = providerResolution.provider === 'cuda' ? 'cuda' : requestedRuntimeBackend
  writeDiagnostic('build:effective-config', {
    modelInfo,
    modelStatus,
    modelCapability,
    requestedBackend: req.backend || 'cpu',
    effectiveBackend,
    inferenceProvider: providerResolution.provider,
    providerReason: providerResolution.reason,
  })
  providerConcurrencyLimit =
    effectiveBackend === 'cuda'
      ? 1
      : effectiveBackend === 'gpu'
        ? Math.max(
            1,
            Math.min(
              process.platform === 'win32'
                ? MAX_DIRECTML_GPU_CONCURRENCY
                : MAX_OTHER_GPU_CONCURRENCY,
              Number(req.maxConcurrentEmbeddings) || DEFAULT_GPU_CONCURRENCY,
            ),
          )
        : 1
  maxConcurrency = providerConcurrencyLimit
  const videoMemory =
    req.batchSize === 0 && effectiveBackend === 'gpu' ? readNvidiaVideoMemory() : null
  const batchSelection = selectEmbeddingBatchSize({
    requestedBatchSize: req.batchSize,
    backend: effectiveBackend,
    modelName: req.modelName,
    maxConcurrency,
    freeSystemMemoryBytes: os.freemem(),
    totalSystemMemoryBytes: os.totalmem(),
    ...(videoMemory || {}),
  })
  progress = {
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    running: 0,
    pending: 0,
    startedAt: Date.now(),
    state: 'running',
    effectiveBatchSize: batchSelection.batchSize,
    batchMode: batchSelection.mode,
    batchReason: batchSelection.reason,
    availableMemoryMb: Math.round(batchSelection.memory.freeSystemMemoryBytes / 1024 / 1024),
    availableVideoMemoryMb: batchSelection.memory.freeVideoMemoryBytes
      ? Math.round(batchSelection.memory.freeVideoMemoryBytes / 1024 / 1024)
      : undefined,
    ...(embeddingStageMetricsEnabled() ? { stageMetrics: createEmbeddingStageMetrics() } : {}),
  }
  stageMetrics = progress.stageMetrics || createEmbeddingStageMetrics()
  inferenceStartedAt = undefined
  inferencePausedAt = undefined
  inferencePausedTotalMs = 0
  pendingPersistence = 0

  const usesIsolatedScanPreparation = Boolean(req.scanPaths?.length && !req.imageIds?.length)
  if (usesIsolatedScanPreparation) {
    const producerChunkSize = Math.max(1, Math.min(256, batchSelection.batchSize * maxConcurrency))
    const queueHighWater = producerChunkSize * 2
    let acceptedTotal = 0
    preparationProducerOpen = true
    const startOrDispatchWorkers = (): void => {
      if (req.modelName === 'clip_vit_base_patch32') {
        if (clipChildren.size === 0) startClipChildBuild()
        else dispatchNextClipTask()
      } else if (dinoChildren.size === 0) {
        startDinoChildBuild()
      } else {
        dispatchNextDinoTask()
      }
    }
    try {
      const prepared = await prepareScanInputsInChild(
        req,
        modelInfo.dim,
        async (inputs) => {
          while (
            taskQueue.length + progress.running + pendingPersistence + inputs.length >
            queueHighWater
          ) {
            if (stopping || progress.state === 'error') {
              throw new Error(progress.error || 'Embedding build stopped')
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 25))
          }
          if (stopping || progress.state === 'error') {
            throw new Error(progress.error || 'Embedding build stopped')
          }
          const tasks = inputs.map<WorkerTask>((input) => ({
            imageId: input.imageId,
            imagePath: input.imagePath,
            modelName: req.modelName,
            modelPath,
            inputSize: modelInfo.inputSize,
            dim: modelInfo.dim,
            backend: effectiveBackend,
            cuda: providerResolution.cuda,
            batchSize: batchSelection.batchSize,
          }))
          taskQueue.push(...tasks)
          acceptedTotal += tasks.length
          if (!inferenceStartedAt) inferenceStartedAt = Date.now()
          updateProgress({
            total: acceptedTotal,
            pending: taskQueue.length,
            state: 'running',
            currentPath: `Queued ${acceptedTotal.toLocaleString()} prepared image(s)`,
          })
          startOrDispatchWorkers()
          writeDiagnostic('preparation-child:chunk-ack', {
            accepted: tasks.length,
            acceptedTotal,
            queueLength: taskQueue.length,
            running: progress.running,
            pendingPersistence,
            queueHighWater,
          })
        },
        producerChunkSize,
      )
      preparationProducerOpen = false
      if (stopping) {
        stopAllWorkers()
        return runtimeFailure('EMBEDDING_BUILD_STOPPED')
      }
      const skipped = Math.max(0, prepared.discovered - acceptedTotal)
      updateProgress({
        total: prepared.discovered,
        pending: taskQueue.length,
        skipped,
        currentPath: undefined,
      })
      writeDiagnostic('build:isolated-stream-ready', {
        discovered: prepared.discovered,
        accepted: acceptedTotal,
        skippedExisting: prepared.skippedExisting,
        rejected: prepared.rejected,
        producerChunkSize,
        queueHighWater,
        memory: getMemorySnapshot(),
      })
      if (acceptedTotal === 0) {
        updateProgress({ state: 'done', pending: 0, running: 0 })
        stopAllWorkers()
        return { ok: true }
      }
      checkCompletion()
      return { ok: true }
    } catch (error) {
      preparationProducerOpen = false
      if (stopping) return runtimeFailure('EMBEDDING_BUILD_STOPPED')
      const message = error instanceof Error ? error.message : String(error)
      writeDiagnostic('preparation-child:error', { error: message })
      const preparationError = runtimeError('EMBEDDING_PREPARATION_FAILED', message)
      updateProgress({ state: 'error', error: message, runtimeError: preparationError })
      stopAllWorkers()
      return { ok: false, runtimeError: preparationError }
    }
  }
  // Scan-only builds return from the bounded producer branch above. From this
  // point onward every request is job-backed, so a second scan/materialization
  // pass would be both unreachable and an avoidable peak-memory risk.
  updateProgress({ currentPath: 'Checking existing embeddings...' })
  const existingEmbeddingIds = await collectExistingEmbeddingIds(
    req.modelName,
    req.embeddingType,
    modelInfo.dim,
  )
  writeDiagnostic('build:existing-ready', { existingCount: existingEmbeddingIds.size })
  if (stopping) {
    stopAllWorkers()
    return runtimeFailure('EMBEDDING_BUILD_STOPPED')
  }

  const jobs = jobStore.getAll()
  const activeJobLedger = jobLedgerSession.start(jobs, buildRunId)
  const reconciled = activeJobLedger.reconcileExisting(
    existingEmbeddingIds,
    req.modelName,
    req.embeddingType,
  )
  writeDiagnostic('jobs:epoch-start', {
    epoch: activeJobLedger.epoch,
    owner: activeJobLedger.owner,
    jobs: jobs.length,
    reconciled,
  })
  jobLedgerSession.persist('epoch-start', true)

  let selectedJobs: EmbeddingJob[]
  let selectedTotal = 0
  let prevalidatedSkipped = 0

  if (req.imageIds?.length) {
    const requestedIds = new Set(req.imageIds.map(embeddingCachePathKey))
    const ledger = jobLedgerSession.current!
    const currentJobs = ledger.listMatching(req.modelName, req.embeddingType, requestedIds)
    writeDiagnostic('build:imageIds-jobs-loaded', {
      imageIds: req.imageIds.length,
      jobs: currentJobs.length,
    })
    const activeImageIds = new Set(
      currentJobs
        .filter(
          (job) => job.status === 'pending' || job.status === 'running' || job.status === 'failed',
        )
        .map((job) => embeddingCachePathKey(job.imageId)),
    )
    const now = Date.now()
    const missingJobs = req.imageIds
      .filter(
        (imageId) =>
          !existingEmbeddingIds.has(embeddingCachePathKey(imageId)) &&
          !activeImageIds.has(embeddingCachePathKey(imageId)),
      )
      .map((imageId) => ({
        imageId,
        path: resolveProjectSearchInputPath(imageId),
        modelName: req.modelName,
        embeddingType: req.embeddingType,
        retries: 0,
        createdAt: now,
        updatedAt: now,
      }))
    if (missingJobs.length > 0) ledger.addPending(missingJobs)
    selectedJobs = ledger.listRunnable(req.modelName, req.embeddingType, requestedIds)
  } else {
    const ledger = jobLedgerSession.current!
    writeDiagnostic('build:jobstore-loaded', { jobs: ledger.size(), epoch: ledger.epoch })
    selectedJobs = ledger.listRunnable(req.modelName, req.embeddingType)
  }

  if (streamSessionId) {
    const requestedTotal = req.imageIds?.length ?? 0
    selectedTotal = requestedTotal
    prevalidatedSkipped += Math.max(0, requestedTotal - selectedJobs.length)
  }

  if (selectedJobs.length === 0 && !streamSessionId) {
    writeDiagnostic('build:no-selected-jobs', { existingCount: existingEmbeddingIds.size })
    jobLedgerSession.finish('no-selected-jobs', false)
    updateProgress({ state: 'done', total: 0 })
    return { ok: true }
  }

  // Build task queue
  writeDiagnostic('build:task-queue-start', {
    selectedJobs: selectedJobs.length,
    memory: getMemorySnapshot(),
  })
  const tasks: WorkerTask[] = []
  let invalidPathJobs = 0
  for (const job of selectedJobs) {
    if (typeof job.path !== 'string' || job.path.length === 0) {
      invalidPathJobs++
      if (job.id !== undefined) {
        jobLedgerSession.current?.skip(job.id, 'Embedding job path is empty')
      }
      continue
    }
    tasks.push({
      imageId: job.imageId,
      imagePath: job.path,
      modelName: job.modelName || req.modelName,
      modelPath,
      inputSize: modelInfo.inputSize,
      dim: modelInfo.dim,
      backend: effectiveBackend,
      cuda: providerResolution.cuda,
      batchSize: batchSelection.batchSize,
      jobId: job.id,
    })
  }

  if (selectedTotal === 0) selectedTotal = selectedJobs.length
  let skipped = invalidPathJobs + prevalidatedSkipped
  writeDiagnostic('build:task-queue-built', {
    selectedJobs: selectedJobs.length,
    tasks: tasks.length,
    skipped,
    modelPath,
    maxConcurrency,
    effectiveBackend,
    inferenceProvider: providerResolution.provider,
    providerReason: providerResolution.reason,
    batchSelection,
    memory: getMemorySnapshot(),
  })
  if (tasks.length === 0 && !streamSessionId) {
    jobLedgerSession.finish('no-usable-job-paths', false)
    updateProgress({ state: 'done', total: selectedJobs.length, skipped })
    return runtimeFailure(
      'EMBEDDING_INPUTS_UNUSABLE',
      'No embedding jobs contain usable image paths.',
    )
  }

  updateProgress({
    currentPath: `Validating image contents: 0 / ${tasks.length.toLocaleString()}`,
  })
  const validation = await filterSupportedEmbeddingInputs(tasks, {
    cachePath: path.join(getVectorDbDir(), 'embedding-input-rejections.json'),
    isCancelled: () => stopping,
    onProgress: ({ checked, total, rejected }) => {
      updateProgress({
        currentPath: `Validating image contents: ${checked.toLocaleString()} / ${total.toLocaleString()} (${rejected.toLocaleString()} rejected)`,
      })
    },
  })
  skipped += validation.rejected
  if (validation.rejected > 0 && jobLedgerSession.current) {
    const acceptedJobIds = new Set(
      validation.accepted.flatMap((task) => (task.jobId === undefined ? [] : [task.jobId])),
    )
    for (const task of tasks) {
      if (task.jobId !== undefined && !acceptedJobIds.has(task.jobId)) {
        jobLedgerSession.current.skip(task.jobId, 'Embedding input validation rejected the file')
      }
    }
  }
  writeDiagnostic('build:input-validation-done', {
    checked: tasks.length,
    accepted: validation.accepted.length,
    rejected: validation.rejected,
    cachedRejected: validation.cachedRejected,
    elapsedMs: Date.now() - (progress.startedAt || Date.now()),
  })
  if (stopping) {
    stopAllWorkers()
    return runtimeFailure('EMBEDDING_BUILD_STOPPED')
  }
  const openEmbeddingStream = (): void => {
    if (!streamSessionId) return
    const taskTemplate: Pick<
      WorkerTask,
      'modelName' | 'modelPath' | 'inputSize' | 'dim' | 'backend' | 'cuda' | 'batchSize'
    > = {
      modelName: req.modelName,
      modelPath,
      inputSize: modelInfo.inputSize,
      dim: modelInfo.dim,
      backend: effectiveBackend,
      cuda: providerResolution.cuda,
      batchSize: batchSelection.batchSize,
    }
    embeddingStreamController.open({
      sessionId: streamSessionId,
      modelName: req.modelName,
      embeddingType: req.embeddingType,
      backend: effectiveBackend,
      knownImageKeys: [...existingEmbeddingIds, ...(req.imageIds ?? [])].map(embeddingCachePathKey),
      initialRequested: req.imageIds?.length ?? 0,
      initialAccepted: validation.accepted.length,
      createTask: (job) => ({
        imageId: job.imageId,
        imagePath: job.path,
        ...taskTemplate,
        jobId: job.id,
      }),
    })
  }
  if (validation.accepted.length === 0) {
    if (streamSessionId) {
      openEmbeddingStream()
      updateProgress({
        state: 'running',
        total: selectedTotal,
        pending: 0,
        skipped,
        currentPath: 'Waiting for committed embedding inputs...',
      })
      inferenceStartedAt = Date.now()
      return { ok: true }
    }
    jobLedgerSession.finish('all-inputs-rejected', false)
    updateProgress({
      state: 'done',
      total: selectedTotal,
      pending: 0,
      skipped,
      currentPath: undefined,
    })
    return { ok: true }
  }

  taskQueue = validation.accepted
  openEmbeddingStream()
  if (stopping) {
    taskQueue = []
    stopAllWorkers()
    return runtimeFailure('EMBEDDING_BUILD_STOPPED')
  }
  updateProgress({
    total: selectedTotal,
    pending: taskQueue.length,
    skipped,
    state: 'running',
  })
  inferenceStartedAt = Date.now()
  inferencePausedAt = undefined
  inferencePausedTotalMs = 0

  if (req.modelName === 'clip_vit_base_patch32') {
    writeDiagnostic('build:start-clip', { tasks: taskQueue.length, maxConcurrency })
    startClipChildBuild()
  } else {
    writeDiagnostic('build:start-dino', { tasks: taskQueue.length, maxConcurrency })
    startDinoChildBuild()
  }

  writeDiagnostic('build:started', {
    tasks: taskQueue.length,
    maxConcurrency,
    batchSize: batchSelection.batchSize,
    batchMode: batchSelection.mode,
    batchReason: batchSelection.reason,
  })
  return { ok: true }
}

export function isStreamingEmbeddingBuildReady(sessionId: string): boolean {
  return embeddingStreamController.isReady(sessionId)
}

export function scaleStreamingEmbeddingBuild(
  sessionId: string,
  requestedConcurrency: number,
): RuntimeOperationResult {
  return embeddingStreamController.scale(sessionId, requestedConcurrency)
}

export function applyEmbeddingRuntimeResourcePressure(
  snapshot: UnifiedResourcePressureSnapshot,
  pressureReasons: readonly string[] = [],
): EmbeddingRuntimeResourceDecision | null {
  if (!['running', 'paused'].includes(progress.state) || taskQueue.length === 0) return null
  const template = taskQueue[0]
  if (!template) return null
  const decision = decideEmbeddingRuntimeResources({
    backend: template.backend,
    modelName: template.modelName,
    batchMode: progress.batchMode || 'default',
    currentBatchSize: template.batchSize,
    currentConcurrency: maxConcurrency,
    providerConcurrencyLimit,
    pressureReasons,
    freeSystemMemoryBytes: snapshot.freeSystemMemoryBytes ?? os.freemem(),
    totalSystemMemoryBytes: snapshot.totalSystemMemoryBytes ?? os.totalmem(),
    freeVideoMemoryBytes: snapshot.freeVideoMemoryBytes,
    totalVideoMemoryBytes: snapshot.totalVideoMemoryBytes,
  })
  const previousConcurrency = maxConcurrency
  const previousBatchSize = template.batchSize
  maxConcurrency = decision.concurrency
  if (progress.batchMode === 'auto' && decision.batchSize !== previousBatchSize) {
    for (const task of taskQueue) task.batchSize = decision.batchSize
  }
  const children = template.modelName === 'clip_vit_base_patch32' ? clipChildren : dinoChildren
  const assignments =
    template.modelName === 'clip_vit_base_patch32' ? clipChildTasks : dinoChildTasks
  const retired = retireIdleEmbeddingChildren(
    children,
    assignments,
    decision.concurrency,
    decision.reason,
  )
  let started = 0
  if (!paused && decision.concurrency > children.size) {
    const spawnChild =
      template.modelName === 'clip_vit_base_patch32' ? spawnClipChild : spawnDinoChild
    const toStart = Math.min(decision.concurrency - children.size, taskQueue.length)
    for (let index = 0; index < toStart; index += 1) children.add(spawnChild())
    started = toStart
  }
  if (
    previousConcurrency !== decision.concurrency ||
    previousBatchSize !== decision.batchSize ||
    retired > 0 ||
    started > 0
  ) {
    updateProgress({
      effectiveBatchSize: decision.batchSize,
      availableMemoryMb: Math.round((snapshot.freeSystemMemoryBytes ?? os.freemem()) / 1024 / 1024),
      availableVideoMemoryMb:
        snapshot.freeVideoMemoryBytes === undefined
          ? undefined
          : Math.round(snapshot.freeVideoMemoryBytes / 1024 / 1024),
    })
    writeDiagnostic('build:live-resource-decision', {
      previousConcurrency,
      previousBatchSize,
      concurrency: decision.concurrency,
      batchSize: decision.batchSize,
      reason: decision.reason,
      retired,
      started,
      queueLength: taskQueue.length,
    })
  }
  if (!paused) {
    if (template.modelName === 'clip_vit_base_patch32') dispatchNextClipTask()
    else dispatchNextDinoTask()
  }
  return decision
}

export async function appendStreamingEmbeddingInputs(
  sessionId: string,
  imageIds: readonly string[],
  options?: { replaceKnown?: boolean },
): Promise<RuntimeOperationResult> {
  return embeddingStreamController.append(sessionId, imageIds, options)
}

export function closeStreamingEmbeddingBuild(sessionId: string): RuntimeOperationResult {
  return embeddingStreamController.close(sessionId)
}

export function stopEmbeddingBuild(): { ok: boolean } {
  writeDiagnostic('build:stop-request', { progress, queueLength: taskQueue.length })
  stopping = true
  updateProgress({ state: 'stopping' })
  stopAllWorkers()
  return { ok: true }
}

export function pauseEmbeddingBuild(): { ok: boolean } {
  if (progress.state !== 'running') return { ok: false }
  paused = true
  if (embeddingTensorPrefetchRequested()) {
    for (const child of clipChildren) {
      if (!child.stdin.writable) continue
      child.stdin.write(`${JSON.stringify({ type: 'control', action: 'pause' })}\n`)
    }
  }
  if (inferenceStartedAt && !inferencePausedAt) inferencePausedAt = Date.now()
  updateProgress({ state: 'paused' })
  return { ok: true }
}

export function resumeEmbeddingBuild(): { ok: boolean } {
  if (progress.state !== 'paused') return { ok: false }
  paused = false
  if (embeddingTensorPrefetchRequested()) {
    for (const child of clipChildren) {
      if (!child.stdin.writable) continue
      child.stdin.write(`${JSON.stringify({ type: 'control', action: 'resume' })}\n`)
    }
  }
  if (inferencePausedAt) {
    inferencePausedTotalMs += Math.max(0, Date.now() - inferencePausedAt)
    inferencePausedAt = undefined
  }
  updateProgress({ state: 'running' })
  if (clipChildren.size > 0 || taskQueue[0]?.modelName === 'clip_vit_base_patch32') {
    dispatchNextClipTask()
  }
  if (dinoChildren.size > 0) {
    dispatchNextDinoTask()
  }
  return { ok: true }
}

// Seed embedding jobs whenever the hash index is built or updated.

export function seedEmbeddingJobs(
  images: { imageId: string; path: string }[],
  modelName: string,
  embeddingType: EmbeddingType = 'global',
): number {
  try {
    enforceEmbeddingJobRetention()
  } catch (error: unknown) {
    writeDiagnostic('jobs:retention-error', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return seedEmbeddingJobsIntoStore(images, modelName, embeddingType, writeDiagnostic)
}
