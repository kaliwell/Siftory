import fs from 'fs'
import { performance } from 'perf_hooks'
import readline from 'readline'
import { CudaEmbeddingWorkerClient, type CudaTensorInput } from './cudaEmbeddingWorkerClient'
import {
  readClipImage,
  readClipTensorPrefetchImage,
  type ClipRawImageFactory,
} from './clipImageDecode'
import { requireNormalizedEmbeddingVector } from './embeddingVectorValidation'
import { encodeEmbeddingChildFrame } from './embeddingChildBinaryProtocol'
import {
  captureEmbeddingChildMemory,
  estimateDecodedImageBytes,
  peakEmbeddingChildMemory,
  type EmbeddingChildMemorySample,
} from './embeddingChildMemoryTelemetry'
import {
  EMBEDDING_TENSOR_PREFETCH_MAX_BYTES,
  embeddingTensorPayloadBytes,
  embeddingTensorPrefetchRequested,
} from './embeddingTensorPrefetchPolicy'
import { configureLocalTransformersEnvironment } from './transformersCacheDirectory'
import {
  decodeEmbeddingImagesInWaves,
  embeddingBatchRequiresSerialProcessing,
  peakEmbeddingDecodedRgbBytes,
  probeEmbeddingImageHeaders,
  totalEmbeddingDecodedRgbBytes,
} from './embeddingDecodeBudget'

const stageMetricsEnabled = process.env.REASONIX_EMBEDDING_STAGE_METRICS === '1'
const tensorPrefetchEnabled = embeddingTensorPrefetchRequested()

function writeChildMessage(header: Record<string, unknown>, vector?: readonly number[]): void {
  process.stdout.write(encodeEmbeddingChildFrame(header, vector))
}

interface ClipTask {
  type?: undefined
  id: number
  imageId: string
  imagePath: string
  modelPath: string
  inputSize: number
  dim: number
  backend?: 'cpu' | 'gpu' | 'cuda'
  cuda?: {
    workerPath: string
    runtimeDir: string
    modelId: 'clip-image'
    outputName: string
  }
  batchSize?: number
  batchLength?: number
  receivedAt?: number
}

interface ClipControlMessage {
  type: 'control'
  action: 'pause' | 'resume'
}

interface ClipBatchTimings {
  runtimeLoadMs: number
  decodeNormalizeMs: number
  preprocessMs: number
  inferenceMs: number
  postprocessMs: number
  fallbackMs: number
  fallbackUsed: boolean
  decodedPixelBytes: number
  temporaryTensorBytes: number
}

interface PreparedClipBatch {
  tasks: ClipTask[]
  validTasks: ClipTask[]
  runtime: ClipRuntime
  imageInputs: Record<string, unknown> | null
  textInputs: Record<string, unknown> | null
  outcomes: Map<number, { vector?: number[]; error?: string }>
  timings: ClipBatchTimings
  tensorBytes: number
  prepareStartedAt: number
  prepareCompletedAt: number
}

type ClipDevice = 'cpu' | 'dml' | 'gpu'
type ClipTokenizer = (
  prompts: string[],
  options: { padding: boolean; truncation: boolean },
) => Record<string, unknown>
type ClipProcessor = (image: unknown) => Promise<Record<string, unknown>>
interface ClipTensor {
  type?: string
  dims?: number[]
  data?: Float32Array | BigInt64Array
}
type ClipModel = (inputs: Record<string, unknown>) => Promise<{
  image_embeds?: {
    data?: ArrayLike<number>
  }
}>
interface ClipTransformersModule {
  env: {
    localModelPath: string
    cacheDir: string
    allowLocalModels: boolean
    allowRemoteModels: boolean
  }
  AutoTokenizer: {
    from_pretrained(model: string): Promise<ClipTokenizer>
  }
  AutoProcessor: {
    from_pretrained(model: string): Promise<ClipProcessor>
  }
  CLIPModel: {
    from_pretrained(
      model: string,
      options: { dtype: string; device: ClipDevice },
    ): Promise<ClipModel>
  }
  RawImage: ClipRawImageFactory
}
interface ClipRuntime {
  tokenizer: ClipTokenizer
  processor: ClipProcessor
  model: ClipModel
  RawImage: ClipRawImageFactory
  selectedProvider: ClipDevice
  initializationFallback: boolean
  fallbackReason?: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function normalizeVector(vec: unknown, expectedDim: number): number[] {
  return requireNormalizedEmbeddingVector(vec, expectedDim)
}

async function configureTransformers(modelPath: string): Promise<ClipTransformersModule> {
  const transformers =
    (await import('@huggingface/transformers')) as unknown as ClipTransformersModule
  configureLocalTransformersEnvironment(transformers.env, modelPath)
  return transformers
}

const runtimePromises = new Map<string, Promise<ClipRuntime>>()
const reportedProviderSelections = new Set<string>()
let cudaRuntimePromise: Promise<{
  tokenizer: ClipTokenizer
  processor: ClipProcessor
  RawImage: ClipRawImageFactory
  client: CudaEmbeddingWorkerClient
}> | null = null
let cudaDisabled = false

function getDeviceForBackend(backend: 'cpu' | 'gpu' | undefined): ClipDevice {
  if (backend !== 'gpu') return 'cpu'
  return process.platform === 'win32' ? 'dml' : 'gpu'
}

function reportProviderSelection(
  requestedBackend: 'cpu' | 'gpu' | 'cuda' | undefined,
  runtime:
    | Pick<ClipRuntime, 'selectedProvider' | 'initializationFallback' | 'fallbackReason'>
    | {
        selectedProvider: 'cuda'
        initializationFallback: false
      },
): void {
  const requested = requestedBackend || 'cpu'
  const cudaFallback = requested === 'cuda' && runtime.selectedProvider !== 'cuda'
  const fallback = runtime.initializationFallback || cudaFallback
  const reason =
    'fallbackReason' in runtime && runtime.fallbackReason
      ? runtime.fallbackReason
      : cudaFallback
        ? `cuda-fallback-to-${runtime.selectedProvider}`
        : 'session-created'
  const key = `${requested}:${runtime.selectedProvider}:${fallback}:${reason}`
  if (reportedProviderSelections.has(key)) return
  reportedProviderSelections.add(key)
  writeChildMessage({
    type: 'provider-selected',
    model: 'clip',
    requestedBackend: requested,
    selectedProvider: runtime.selectedProvider,
    fallback,
    reason,
  })
}

async function getRuntime(
  modelPath: string,
  backend: 'cpu' | 'gpu' | undefined,
): Promise<ClipRuntime> {
  const device = getDeviceForBackend(backend)
  if (!runtimePromises.has(device)) {
    const promise = (async () => {
      const { AutoTokenizer, AutoProcessor, CLIPModel, RawImage } =
        await configureTransformers(modelPath)
      const tokenizer = await AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch32')
      const processor = await AutoProcessor.from_pretrained('Xenova/clip-vit-base-patch32')
      const model = await CLIPModel.from_pretrained('Xenova/clip-vit-base-patch32', {
        dtype: 'q4',
        device,
      })
      return {
        tokenizer,
        processor,
        model,
        RawImage,
        selectedProvider: device,
        initializationFallback: false,
      }
    })().catch(async (error: unknown) => {
      runtimePromises.delete(device)
      if (backend === 'gpu') {
        process.stderr.write(`CLIP GPU backend unavailable (${errorMessage(error)}); using CPU\n`)
        const cpuRuntime = await getRuntime(modelPath, 'cpu')
        return {
          ...cpuRuntime,
          initializationFallback: true,
          fallbackReason:
            device === 'dml'
              ? 'dml-session-initialization-failed'
              : 'gpu-session-initialization-failed',
        }
      }
      throw error
    })
    runtimePromises.set(device, promise)
  }
  return runtimePromises.get(device)!
}

async function getCudaRuntime(task: ClipTask): Promise<{
  tokenizer: ClipTokenizer
  processor: ClipProcessor
  RawImage: ClipRawImageFactory
  client: CudaEmbeddingWorkerClient
}> {
  if (cudaDisabled || !task.cuda) throw new Error('CLIP CUDA runtime is disabled')
  const cuda = task.cuda
  if (!cudaRuntimePromise) {
    cudaRuntimePromise = (async () => {
      const { AutoTokenizer, AutoProcessor, RawImage } = await configureTransformers(task.modelPath)
      const tokenizer = await AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch32')
      const processor = await AutoProcessor.from_pretrained('Xenova/clip-vit-base-patch32')
      const client = new CudaEmbeddingWorkerClient({
        ...cuda,
        modelPath: task.modelPath,
        onStderr: (message) => process.stderr.write(`[CLIP CUDA] ${message}\n`),
      })
      try {
        await client.hello
        return { tokenizer, processor, RawImage, client }
      } catch (error) {
        client.close()
        throw error
      }
    })()
  }
  try {
    return await cudaRuntimePromise
  } catch (error) {
    cudaRuntimePromise = null
    cudaDisabled = true
    process.stderr.write(
      `CLIP CUDA startup unavailable (${errorMessage(error)}); using DirectML/CPU\n`,
    )
    throw error
  }
}

function asCudaTensor(name: string, value: unknown, dtype: 'float32' | 'int64'): CudaTensorInput {
  const tensor = value as ClipTensor | undefined
  const validData =
    dtype === 'float32'
      ? tensor?.data instanceof Float32Array
      : tensor?.data instanceof BigInt64Array
  if (!tensor || tensor.type !== dtype || !Array.isArray(tensor.dims) || !validData) {
    throw new Error(`CLIP processor returned an invalid CUDA tensor: ${name}`)
  }
  if (dtype === 'float32') {
    return { name, dtype, dimensions: tensor.dims, data: tensor.data as Float32Array }
  }
  return { name, dtype, dimensions: tensor.dims, data: tensor.data as BigInt64Array }
}

async function inferCuda(
  task: ClipTask,
  images: unknown | unknown[],
  preparedImageInputs?: Record<string, unknown>,
): Promise<Float32Array> {
  const runtime = await getCudaRuntime(task)
  reportProviderSelection(task.backend, {
    selectedProvider: 'cuda',
    initializationFallback: false,
  })
  try {
    const imageInputs = preparedImageInputs || (await runtime.processor(images))
    const count = Array.isArray(images) ? images.length : 1
    const textInputs = runtime.tokenizer(Array(count).fill('a photo'), {
      padding: true,
      truncation: true,
    })
    const output = await runtime.client.infer([
      asCudaTensor('pixel_values', imageInputs.pixel_values, 'float32'),
      asCudaTensor('input_ids', textInputs.input_ids, 'int64'),
      asCudaTensor('attention_mask', textInputs.attention_mask, 'int64'),
    ])
    return output.data
  } catch (error) {
    runtime.client.close()
    cudaRuntimePromise = null
    cudaDisabled = true
    process.stderr.write(
      `CLIP CUDA inference unavailable (${errorMessage(error)}); using DirectML/CPU\n`,
    )
    throw error
  }
}

function createBatchTimings(): ClipBatchTimings {
  return {
    runtimeLoadMs: 0,
    decodeNormalizeMs: 0,
    preprocessMs: 0,
    inferenceMs: 0,
    postprocessMs: 0,
    fallbackMs: 0,
    fallbackUsed: false,
    decodedPixelBytes: 0,
    temporaryTensorBytes: 0,
  }
}

const textInputCache = new WeakMap<object, Map<number, Record<string, unknown>>>()

function getCachedTextInputs(tokenizer: ClipTokenizer, count: number): Record<string, unknown> {
  const key = tokenizer as unknown as object
  let byCount = textInputCache.get(key)
  if (!byCount) {
    byCount = new Map()
    textInputCache.set(key, byCount)
  }
  let inputs = byCount.get(count)
  if (!inputs) {
    inputs = tokenizer(Array(count).fill('a photo'), { padding: true, truncation: true })
    byCount.set(count, inputs)
  }
  return inputs
}

async function prepareClipTensorBatch(
  tasks: ClipTask[],
  runtimeOverride?: ClipRuntime,
): Promise<PreparedClipBatch> {
  const prepareStartedAt = performance.now()
  const timings = createBatchTimings()
  const outcomes = new Map<number, { vector?: number[]; error?: string }>()
  const modelPath = tasks[0].modelPath
  if (!fs.existsSync(modelPath)) throw new Error('CLIP model file not found')

  let startedAt = performance.now()
  let runtime = runtimeOverride
  if (!runtime) {
    try {
      runtime = await getRuntime(modelPath, 'gpu')
    } finally {
      timings.runtimeLoadMs += performance.now() - startedAt
    }
  }
  reportProviderSelection(tasks[0].backend, runtime)

  const images: unknown[] = []
  const validTasks: ClipTask[] = []
  startedAt = performance.now()
  const decodedBatch = await decodeEmbeddingImagesInWaves(
    tasks.map((task) => task.imagePath),
    async (imagePath) => {
      if (!fs.existsSync(imagePath)) throw new Error('Image file not found')
      return readClipTensorPrefetchImage(imagePath, runtime.RawImage)
    },
  )
  const readResults = decodedBatch.results
  timings.decodeNormalizeMs += performance.now() - startedAt
  timings.decodedPixelBytes = Math.max(
    timings.decodedPixelBytes,
    totalEmbeddingDecodedRgbBytes(decodedBatch.headers),
  )
  for (let index = 0; index < readResults.length; index += 1) {
    const result = readResults[index]
    if (result.status === 'fulfilled') {
      validTasks.push(tasks[index])
      images.push(result.value)
    } else {
      outcomes.set(tasks[index].id, { error: errorMessage(result.reason) })
    }
  }
  timings.decodedPixelBytes = Math.max(timings.decodedPixelBytes, estimateDecodedImageBytes(images))

  let imageInputs: Record<string, unknown> | null = null
  let textInputs: Record<string, unknown> | null = null
  let tensorBytes = 0
  if (validTasks.length > 0) {
    let preprocessRecorded = false
    try {
      startedAt = performance.now()
      imageInputs = await runtime.processor(images.length === 1 ? images[0] : images)
      textInputs = getCachedTextInputs(runtime.tokenizer, validTasks.length)
      timings.preprocessMs += performance.now() - startedAt
      preprocessRecorded = true
      tensorBytes =
        embeddingTensorPayloadBytes(imageInputs) + embeddingTensorPayloadBytes(textInputs)
      timings.temporaryTensorBytes = Math.max(timings.temporaryTensorBytes, tensorBytes)
      if (tensorBytes <= 0 || tensorBytes > EMBEDDING_TENSOR_PREFETCH_MAX_BYTES) {
        throw new Error(
          `CLIP prepared tensor payload ${tensorBytes} exceeds the bounded prefetch budget`,
        )
      }
    } catch {
      if (!preprocessRecorded) {
        timings.preprocessMs += Math.max(0, performance.now() - startedAt)
      }
      timings.fallbackUsed = true
      imageInputs = null
      textInputs = null
      tensorBytes = 0
    }
  }

  return {
    tasks,
    validTasks,
    runtime,
    imageInputs,
    textInputs,
    outcomes,
    timings,
    tensorBytes,
    prepareStartedAt,
    prepareCompletedAt: performance.now(),
  }
}

async function processOne(
  task: ClipTask,
  timings = createBatchTimings(),
  providerRequestedBackend = task.backend,
): Promise<number[]> {
  if (!fs.existsSync(task.imagePath)) throw new Error('Image file not found')
  if (!fs.existsSync(task.modelPath)) throw new Error('CLIP model file not found')
  let startedAt = performance.now()
  if (task.backend === 'cuda' && !cudaDisabled) {
    try {
      let runtime: Awaited<ReturnType<typeof getCudaRuntime>>
      try {
        runtime = await getCudaRuntime(task)
      } finally {
        timings.runtimeLoadMs += performance.now() - startedAt
      }
      startedAt = performance.now()
      let image: Awaited<ReturnType<typeof readClipImage>>
      try {
        image = await readClipImage(task.imagePath, runtime.RawImage)
      } finally {
        timings.decodeNormalizeMs += performance.now() - startedAt
      }
      startedAt = performance.now()
      let data: Float32Array
      try {
        data = await inferCuda(task, image)
      } finally {
        timings.inferenceMs += performance.now() - startedAt
      }
      if (data.length !== task.dim) {
        throw new Error(`CLIP CUDA returned ${data.length} values for dim ${task.dim}`)
      }
      startedAt = performance.now()
      const vector = normalizeVector(Array.from(data), task.dim)
      timings.postprocessMs += performance.now() - startedAt
      return vector
    } catch {
      timings.fallbackUsed = true
      startedAt = performance.now()
      try {
        return await processOne(
          { ...task, backend: 'gpu', cuda: undefined },
          timings,
          providerRequestedBackend,
        )
      } finally {
        timings.fallbackMs += performance.now() - startedAt
      }
    }
  }
  startedAt = performance.now()
  let runtime: Awaited<ReturnType<typeof getRuntime>>
  try {
    runtime = await getRuntime(task.modelPath, task.backend === 'cuda' ? 'gpu' : task.backend)
  } finally {
    timings.runtimeLoadMs += performance.now() - startedAt
  }
  reportProviderSelection(providerRequestedBackend, runtime)
  const { tokenizer, processor, model, RawImage } = runtime
  startedAt = performance.now()
  const textInputs = tokenizer(['a photo'], { padding: true, truncation: true })
  timings.preprocessMs += performance.now() - startedAt
  startedAt = performance.now()
  let image: Awaited<ReturnType<typeof readClipImage>>
  try {
    image = await readClipImage(task.imagePath, RawImage)
  } finally {
    timings.decodeNormalizeMs += performance.now() - startedAt
  }
  timings.decodedPixelBytes = Math.max(timings.decodedPixelBytes, estimateDecodedImageBytes(image))
  startedAt = performance.now()
  let imageInputs: Awaited<ReturnType<ClipProcessor>>
  try {
    imageInputs = await processor(image)
  } finally {
    timings.preprocessMs += performance.now() - startedAt
  }
  timings.temporaryTensorBytes = Math.max(
    timings.temporaryTensorBytes,
    embeddingTensorPayloadBytes(imageInputs) + embeddingTensorPayloadBytes(textInputs),
  )
  startedAt = performance.now()
  let output: Awaited<ReturnType<ClipModel>>
  try {
    output = await model({ ...textInputs, ...imageInputs })
  } finally {
    timings.inferenceMs += performance.now() - startedAt
  }
  const data = output?.image_embeds?.data
  if (!data || typeof data.length !== 'number') {
    throw new Error('CLIP returned no image embedding data')
  }
  timings.temporaryTensorBytes = Math.max(timings.temporaryTensorBytes, data.length * 4)
  if (!Number.isSafeInteger(data.length) || data.length !== task.dim) {
    throw new Error(`CLIP returned ${data.length} values for dim ${task.dim}`)
  }
  startedAt = performance.now()
  const vector = normalizeVector(Array.from(data as ArrayLike<number>), task.dim)
  timings.postprocessMs += performance.now() - startedAt
  return vector
}

// ── Batch processing ─────────────────────────────────────

let batchSize = 4
let pendingBatch: ClipTask[] = []
let batchTimer: ReturnType<typeof setTimeout> | null = null
let batchProcessing = false
let prefetchPaused = false
let prefetchStarter: ((tasks: ClipTask[]) => void) | null = null
let prefetchedBatch: { tasks: ClipTask[]; prepared: Promise<PreparedClipBatch> } | null = null

function pendingBatchLength(): number {
  const requested = pendingBatch[0]?.batchLength
  return Number.isInteger(requested) && requested! >= 1 && requested! <= 16 ? requested! : batchSize
}

function tryStartPendingPrefetch(): void {
  if (!tensorPrefetchEnabled || prefetchPaused || !batchProcessing || !prefetchStarter) return
  const expected = pendingBatchLength()
  if (pendingBatch.length < expected) return
  const tasks = pendingBatch.splice(0, expected)
  const starter = prefetchStarter
  prefetchStarter = null
  starter(tasks)
}

function armClipTensorPrefetch(runtime: ClipRuntime): void {
  if (!tensorPrefetchEnabled || prefetchPaused || prefetchStarter || prefetchedBatch) {
    return
  }
  prefetchStarter = (tasks) => {
    prefetchedBatch = { tasks, prepared: prepareClipTensorBatch(tasks, runtime) }
  }
  writeChildMessage({ type: 'prefetch-request', depth: 1 })
  tryStartPendingPrefetch()
}

function scheduleNextClipBatch(): void {
  if (batchProcessing || prefetchPaused) return
  if (prefetchedBatch) {
    const next = prefetchedBatch
    prefetchedBatch = null
    void processBatch(next.tasks, next.prepared)
    return
  }
  if (pendingBatch.length === 0) return
  if (pendingBatch.length >= pendingBatchLength()) flushBatch()
  else if (!batchTimer) batchTimer = setTimeout(flushBatch, 80)
}

function writeSuccess(
  task: Pick<ClipTask, 'id' | 'dim'>,
  vector: unknown,
  metrics?: Record<string, unknown>,
): void {
  const normalized = requireNormalizedEmbeddingVector(vector, task.dim)
  writeChildMessage(
    {
      id: task.id,
      ok: true,
      vectorEncoding: 'float64le',
      ...(metrics ? { metrics } : {}),
    },
    normalized,
  )
}

function writeFailure(
  task: Pick<ClipTask, 'id'>,
  error: string,
  metrics?: Record<string, unknown>,
): void {
  writeChildMessage({ id: task.id, ok: false, error, ...(metrics ? { metrics } : {}) })
}

function createBatchMetrics(
  tasks: ClipTask[],
  succeeded: number,
  failed: number,
  batchStartedAt: number,
  timings: ClipBatchTimings,
  memory: EmbeddingChildMemorySample,
  extra: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  if (!stageMetricsEnabled) return undefined
  const queueWaits = tasks.map((task) =>
    Math.max(0, batchStartedAt - (task.receivedAt ?? batchStartedAt)),
  )
  return {
    model: 'clip',
    batchSize: tasks.length,
    succeeded,
    failed,
    fallback: timings.fallbackUsed,
    queueWaitMsTotal: queueWaits.reduce((total, value) => total + value, 0),
    queueWaitMsMax: Math.max(0, ...queueWaits),
    batchWallMs: Math.max(0, performance.now() - batchStartedAt),
    runtimeLoadMs: timings.runtimeLoadMs,
    decodeNormalizeMs: timings.decodeNormalizeMs,
    preprocessMs: timings.preprocessMs,
    inferenceMs: timings.inferenceMs,
    postprocessMs: timings.postprocessMs,
    fallbackMs: timings.fallbackMs,
    decodedPixelBytes: timings.decodedPixelBytes,
    temporaryTensorBytes: timings.temporaryTensorBytes,
    rssBytes: memory.rssBytes,
    privateBytes: memory.privateBytes,
    externalBytes: memory.externalBytes,
    arrayBuffersBytes: memory.arrayBuffersBytes,
    ...extra,
  }
}

function writeBatchOutcomes(
  tasks: ClipTask[],
  outcomes: Map<number, { vector?: number[]; error?: string }>,
  batchStartedAt: number,
  timings: ClipBatchTimings,
  memory: EmbeddingChildMemorySample,
  extraMetrics: Record<string, unknown> = {},
): void {
  for (const task of tasks) {
    if (!outcomes.has(task.id)) {
      outcomes.set(task.id, { error: 'CLIP batch did not produce a result' })
    }
  }
  const succeeded = tasks.filter((task) => outcomes.get(task.id)?.vector).length
  const metrics = createBatchMetrics(
    tasks,
    succeeded,
    tasks.length - succeeded,
    batchStartedAt,
    timings,
    memory,
    extraMetrics,
  )
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]
    const outcome = outcomes.get(task.id)!
    const resultMetrics = index === 0 ? metrics : undefined
    if (outcome.vector) writeSuccess(task, outcome.vector, resultMetrics)
    else writeFailure(task, outcome.error || 'CLIP batch failed', resultMetrics)
  }
}

function flushBatch(): void {
  if (batchTimer) {
    clearTimeout(batchTimer)
    batchTimer = null
  }
  if (pendingBatch.length === 0 || prefetchPaused) return
  const batch = pendingBatch.splice(0, pendingBatchLength())
  void processBatch(batch)
}

async function processTensorPrefetchBatch(
  tasks: ClipTask[],
  prefetchedPrepared?: Promise<PreparedClipBatch>,
): Promise<void> {
  if (batchProcessing) return
  batchProcessing = true
  const batchStartedAt = performance.now()
  const memoryBefore = stageMetricsEnabled ? await captureEmbeddingChildMemory() : null
  let timings = createBatchTimings()
  const outcomes = new Map<number, { vector?: number[]; error?: string }>()
  let extraMetrics: Record<string, unknown> = {
    tensorPrefetch: Boolean(prefetchedPrepared),
    tensorBytes: 0,
    prefetchPrepareMs: 0,
    prefetchWaitMs: 0,
    prefetchOverlapMs: 0,
  }
  try {
    const waitStartedAt = performance.now()
    const prepared = await (prefetchedPrepared || prepareClipTensorBatch(tasks))
    const prefetchWaitMs = prefetchedPrepared ? performance.now() - waitStartedAt : 0
    timings = prepared.timings
    for (const [id, outcome] of prepared.outcomes) outcomes.set(id, outcome)
    const prefetchPrepareMs = Math.max(0, prepared.prepareCompletedAt - prepared.prepareStartedAt)
    extraMetrics = {
      tensorPrefetch: Boolean(prefetchedPrepared),
      tensorBytes: prepared.tensorBytes,
      prefetchPrepareMs,
      prefetchWaitMs,
      prefetchOverlapMs: prefetchedPrepared ? Math.max(0, prefetchPrepareMs - prefetchWaitMs) : 0,
    }

    let batchCompleted = false
    if (prepared.validTasks.length > 0) {
      armClipTensorPrefetch(prepared.runtime)
    }
    if (prepared.imageInputs && prepared.textInputs && prepared.validTasks.length > 0) {
      try {
        let startedAt = performance.now()
        let output: Awaited<ReturnType<ClipModel>>
        try {
          output = await prepared.runtime.model({
            ...prepared.textInputs,
            ...prepared.imageInputs,
          })
        } finally {
          timings.inferenceMs += performance.now() - startedAt
        }
        const data = output?.image_embeds?.data
        if (!data || typeof data.length !== 'number') {
          throw new Error('CLIP returned no image embedding data')
        }
        const dim = prepared.validTasks[0].dim
        if (
          !Number.isSafeInteger(data.length) ||
          data.length !== prepared.validTasks.length * dim
        ) {
          throw new Error(
            `CLIP batch returned ${data.length} values for ${prepared.validTasks.length}x${dim} embeddings`,
          )
        }
        startedAt = performance.now()
        const vectorData = Array.from(data as ArrayLike<number>)
        for (let index = 0; index < prepared.validTasks.length; index += 1) {
          const start = index * dim
          outcomes.set(prepared.validTasks[index].id, {
            vector: normalizeVector(vectorData.slice(start, start + dim), dim),
          })
        }
        timings.postprocessMs += performance.now() - startedAt
        batchCompleted = true
      } catch {
        timings.fallbackUsed = true
      }
    }

    if (!batchCompleted) {
      const fallbackStartedAt = performance.now()
      for (const task of prepared.validTasks) {
        try {
          const vector = await processOne(task, timings)
          outcomes.set(task.id, { vector: normalizeVector(vector, task.dim) })
        } catch (error: unknown) {
          outcomes.set(task.id, { error: errorMessage(error) })
        }
      }
      timings.fallbackMs += performance.now() - fallbackStartedAt
    }
  } catch (error: unknown) {
    for (const task of tasks) {
      if (!outcomes.has(task.id)) outcomes.set(task.id, { error: errorMessage(error) })
    }
  } finally {
    prefetchStarter = null
    const memoryAfter = stageMetricsEnabled ? await captureEmbeddingChildMemory() : null
    const memory =
      memoryBefore && memoryAfter
        ? peakEmbeddingChildMemory(memoryBefore, memoryAfter)
        : { rssBytes: 0, privateBytes: null, externalBytes: 0, arrayBuffersBytes: 0 }
    writeBatchOutcomes(tasks, outcomes, batchStartedAt, timings, memory, extraMetrics)
    batchProcessing = false
    scheduleNextClipBatch()
  }
}

async function processBatch(
  tasks: ClipTask[],
  prefetchedPrepared?: Promise<PreparedClipBatch>,
): Promise<void> {
  if (tensorPrefetchEnabled && tasks.length > 1 && tasks[0].backend === 'gpu') {
    await processTensorPrefetchBatch(tasks, prefetchedPrepared)
    return
  }
  if (batchProcessing) return
  batchProcessing = true
  const batchStartedAt = performance.now()
  const memoryBefore = stageMetricsEnabled ? await captureEmbeddingChildMemory() : null
  const timings = createBatchTimings()
  const outcomes = new Map<number, { vector?: number[]; error?: string }>()
  try {
    // Single image → use the fast single path
    if (tasks.length === 1) {
      const task = tasks[0]
      try {
        const vector = await processOne(task, timings)
        outcomes.set(task.id, { vector: normalizeVector(vector, task.dim) })
      } catch (err: unknown) {
        outcomes.set(task.id, { error: errorMessage(err) })
      }
    } else {
      const imagePaths = tasks.map((task) => task.imagePath)
      const preparedHeaders = await probeEmbeddingImageHeaders(imagePaths)
      if (embeddingBatchRequiresSerialProcessing(preparedHeaders)) {
        timings.decodedPixelBytes = Math.max(
          timings.decodedPixelBytes,
          peakEmbeddingDecodedRgbBytes(preparedHeaders),
        )
        for (const task of tasks) {
          try {
            const vector = await processOne(task, timings)
            outcomes.set(task.id, { vector: normalizeVector(vector, task.dim) })
          } catch (error: unknown) {
            outcomes.set(task.id, { error: errorMessage(error) })
          }
        }
      } else {
        // Validate tasks
        const modelPath = tasks[0].modelPath
        const backend = tasks[0].backend
        if (!fs.existsSync(modelPath)) throw new Error('CLIP model file not found')

        let startedAt = performance.now()
        let runtime:
          | Awaited<ReturnType<typeof getRuntime>>
          | Awaited<ReturnType<typeof getCudaRuntime>>
        try {
          if (backend === 'cuda' && !cudaDisabled) {
            try {
              runtime = await getCudaRuntime(tasks[0])
            } catch {
              timings.fallbackUsed = true
              runtime = await getRuntime(modelPath, 'gpu')
            }
          } else {
            runtime = await getRuntime(modelPath, backend === 'cuda' ? 'gpu' : backend)
          }
        } finally {
          timings.runtimeLoadMs += performance.now() - startedAt
        }
        if ('selectedProvider' in runtime) {
          reportProviderSelection(backend, runtime)
        } else {
          reportProviderSelection(backend, {
            selectedProvider: 'cuda',
            initializationFallback: false,
          })
        }
        const { tokenizer, processor, RawImage } = runtime

        // Step 1: Read all images in parallel (I/O bound → overlap)
        const images: unknown[] = []
        const validTasks: ClipTask[] = []
        startedAt = performance.now()
        const decodedBatch = await decodeEmbeddingImagesInWaves(
          imagePaths,
          async (imagePath) => {
            if (!fs.existsSync(imagePath)) throw new Error('Image file not found')
            return readClipImage(imagePath, RawImage)
          },
          preparedHeaders,
        )
        const readResults = decodedBatch.results
        timings.decodeNormalizeMs += performance.now() - startedAt
        timings.decodedPixelBytes = Math.max(
          timings.decodedPixelBytes,
          totalEmbeddingDecodedRgbBytes(decodedBatch.headers),
        )
        for (let i = 0; i < readResults.length; i++) {
          const result = readResults[i]
          if (result.status === 'fulfilled') {
            validTasks.push(tasks[i])
            images.push(result.value)
          } else {
            outcomes.set(tasks[i].id, { error: errorMessage(result.reason) })
          }
        }
        timings.decodedPixelBytes = Math.max(
          timings.decodedPixelBytes,
          estimateDecodedImageBytes(images),
        )

        if (validTasks.length > 0) {
          // Step 2: Preprocess all valid images.
          let imageInputs: Record<string, unknown> | null = null
          try {
            startedAt = performance.now()
            imageInputs = await processor(images.length === 1 ? images[0] : images)
            timings.preprocessMs += performance.now() - startedAt
            timings.temporaryTensorBytes = Math.max(
              timings.temporaryTensorBytes,
              embeddingTensorPayloadBytes(imageInputs),
            )
          } catch {
            timings.preprocessMs += performance.now() - startedAt
            timings.fallbackUsed = true
          }

          let batchCompleted = false
          if (imageInputs && backend === 'cuda' && !cudaDisabled) {
            try {
              startedAt = performance.now()
              let data: Float32Array
              try {
                data = await inferCuda(
                  validTasks[0],
                  images.length === 1 ? images[0] : images,
                  imageInputs,
                )
              } finally {
                timings.inferenceMs += performance.now() - startedAt
              }
              const dim = validTasks[0].dim
              if (data.length !== images.length * dim) {
                throw new Error(
                  `CLIP CUDA batch returned ${data.length} values for ${images.length}x${dim} embeddings`,
                )
              }
              startedAt = performance.now()
              for (let i = 0; i < validTasks.length; i++) {
                const start = i * dim
                outcomes.set(validTasks[i].id, {
                  vector: normalizeVector(Array.from(data.slice(start, start + dim)), dim),
                })
              }
              timings.postprocessMs += performance.now() - startedAt
              batchCompleted = true
            } catch {
              timings.fallbackUsed = true
              // Continue below with DirectML, whose runtime falls back to CPU on initialization failure.
            }
          }

          if (imageInputs && !batchCompleted) {
            try {
              startedAt = performance.now()
              let directRuntime: Awaited<ReturnType<typeof getRuntime>>
              try {
                directRuntime = await getRuntime(modelPath, backend === 'cuda' ? 'gpu' : backend)
              } finally {
                timings.runtimeLoadMs += performance.now() - startedAt
              }
              reportProviderSelection(backend, directRuntime)
              const { model } = directRuntime

              // Step 3: Build batched text inputs.
              startedAt = performance.now()
              const textInputs = tokenizer(Array(images.length).fill('a photo'), {
                padding: true,
                truncation: true,
              })
              timings.preprocessMs += performance.now() - startedAt
              timings.temporaryTensorBytes = Math.max(
                timings.temporaryTensorBytes,
                embeddingTensorPayloadBytes(imageInputs) + embeddingTensorPayloadBytes(textInputs),
              )

              // Step 4: Run model once with batched inputs.
              startedAt = performance.now()
              let output: Awaited<ReturnType<ClipModel>>
              try {
                output = await model({ ...textInputs, ...imageInputs })
              } finally {
                timings.inferenceMs += performance.now() - startedAt
              }
              const data = output?.image_embeds?.data
              if (!data || typeof data.length !== 'number') {
                throw new Error('CLIP returned no image embedding data')
              }
              timings.temporaryTensorBytes = Math.max(timings.temporaryTensorBytes, data.length * 4)
              const dim = validTasks[0].dim
              if (!Number.isSafeInteger(data.length) || data.length !== images.length * dim) {
                throw new Error(
                  `CLIP batch returned ${data.length} values for ${images.length}x${dim} embeddings`,
                )
              }
              // Step 5: Extract individual embeddings from batched output.
              startedAt = performance.now()
              const vectorData = Array.from(data as ArrayLike<number>)
              for (let i = 0; i < validTasks.length; i++) {
                const start = i * dim
                outcomes.set(validTasks[i].id, {
                  vector: normalizeVector(vectorData.slice(start, start + dim), dim),
                })
              }
              timings.postprocessMs += performance.now() - startedAt
              batchCompleted = true
            } catch {
              timings.fallbackUsed = true
            }
          }

          if (!batchCompleted) {
            // Batch preprocessing or inference failed → fall back one-by-one.
            const fallbackStartedAt = performance.now()
            for (const task of validTasks) {
              try {
                const vector = await processOne(task, timings)
                outcomes.set(task.id, { vector: normalizeVector(vector, task.dim) })
              } catch (error: unknown) {
                outcomes.set(task.id, { error: errorMessage(error) })
              }
            }
            timings.fallbackMs += performance.now() - fallbackStartedAt
          }
        }
      }
    }
  } catch (err: unknown) {
    // Catastrophic batch failure → report all unfinished tasks as failed.
    for (const task of tasks) {
      if (!outcomes.has(task.id)) outcomes.set(task.id, { error: errorMessage(err) })
    }
  } finally {
    const memoryAfter = stageMetricsEnabled ? await captureEmbeddingChildMemory() : null
    const memory =
      memoryBefore && memoryAfter
        ? peakEmbeddingChildMemory(memoryBefore, memoryAfter)
        : { rssBytes: 0, privateBytes: null, externalBytes: 0, arrayBuffersBytes: 0 }
    writeBatchOutcomes(tasks, outcomes, batchStartedAt, timings, memory)
    batchProcessing = false
    scheduleNextClipBatch()
  }
}

// ── Stdin loop ────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  let message: ClipTask | ClipControlMessage
  try {
    message = JSON.parse(line) as ClipTask | ClipControlMessage
  } catch {
    return // skip malformed input
  }
  if (message.type === 'control') {
    prefetchPaused = message.action === 'pause'
    if (prefetchPaused) {
      prefetchStarter = null
    } else {
      tryStartPendingPrefetch()
      scheduleNextClipBatch()
    }
    return
  }
  const task = message
  if (stageMetricsEnabled) task.receivedAt = performance.now()
  pendingBatch.push(task)
  if (task.batchSize && task.batchSize >= 1 && task.batchSize <= 16) {
    batchSize = task.batchSize
  }
  if (batchProcessing) {
    tryStartPendingPrefetch()
    return
  }
  if (pendingBatch.length >= pendingBatchLength()) {
    flushBatch()
  } else {
    // Start a short timer to flush partial batches (avoid waiting forever)
    if (!batchTimer) {
      batchTimer = setTimeout(flushBatch, 80)
    }
  }
})

writeChildMessage({ type: 'ready' })
