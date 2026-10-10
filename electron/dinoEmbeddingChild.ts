import fs from 'fs'
import { performance } from 'perf_hooks'
import readline from 'readline'
import { poolDinoEmbedding } from './dinoEmbeddingMath'
import { CudaEmbeddingWorkerClient, type CudaTensorInput } from './cudaEmbeddingWorkerClient'
import { requireNormalizedEmbeddingVector } from './embeddingVectorValidation'
import { encodeEmbeddingChildFrame } from './embeddingChildBinaryProtocol'
import {
  captureEmbeddingChildMemory,
  estimateDecodedImageBytes,
  peakEmbeddingChildMemory,
  type EmbeddingChildMemorySample,
} from './embeddingChildMemoryTelemetry'
import {
  readDinoImage as readDinoImageBounded,
  readDinoTensorPrefetchImage,
} from './dinoImageDecode'
import { configureLocalTransformersEnvironment } from './transformersCacheDirectory'
import {
  decodeEmbeddingImagesInWaves,
  embeddingBatchRequiresSerialProcessing,
  peakEmbeddingDecodedRgbBytes,
  probeEmbeddingImageHeaders,
  totalEmbeddingDecodedRgbBytes,
} from './embeddingDecodeBudget'

const stageMetricsEnabled = process.env.REASONIX_EMBEDDING_STAGE_METRICS === '1'
// Diagnostic-only shadow. Production and ordinary benchmarks stay on the
// full-size baseline unless the explicit one-shot environment flag is set.
const dinoFusedShadowEnabled = process.env.REASONIX_DINO_FUSED_SHADOW === '1'

function writeChildMessage(header: Record<string, unknown>, vector?: readonly number[]): void {
  process.stdout.write(encodeEmbeddingChildFrame(header, vector))
}

interface DinoTask {
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
    modelId: 'dino'
    outputName: string
  }
  batchSize?: number
  receivedAt?: number
}

interface DinoBatchTimings {
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

type DinoDevice = 'cpu' | 'dml' | 'gpu'
interface DinoFeatureOutput {
  data?: ArrayLike<number>
  dims?: number[]
}
interface DinoTensor {
  type?: string
  dims?: number[]
  data?: Float32Array
}
type DinoProcessor = (input: DinoRawImage | DinoRawImage[]) => Promise<{
  pixel_values?: DinoTensor
}>
interface DinoRawImage {
  data?: Uint8Array | Uint8ClampedArray
  width?: number
  height?: number
  channels?: number
  rgb(): DinoRawImage
}
type ImageFeatureExtractor = (
  input: DinoRawImage | DinoRawImage[],
  options?: Record<string, unknown>,
) => Promise<DinoFeatureOutput>
interface DinoRuntime {
  extractor: ImageFeatureExtractor
  selectedProvider: DinoDevice
  initializationFallback: boolean
  fallbackReason?: string
}
interface DinoTransformersModule {
  env: {
    localModelPath: string
    cacheDir: string
    allowLocalModels: boolean
    allowRemoteModels: boolean
  }
  pipeline(
    task: 'image-feature-extraction',
    model: string,
    options: { dtype: string; device: DinoDevice },
  ): Promise<ImageFeatureExtractor>
  AutoProcessor: {
    from_pretrained(model: string): Promise<DinoProcessor>
  }
  RawImage: {
    new (data: Uint8Array, width: number, height: number, channels: 3): DinoRawImage
  }
}

const extractorPromises = new Map<string, Promise<DinoRuntime>>()
const reportedProviderSelections = new Set<string>()
let cudaRuntimePromise: Promise<{
  processor: DinoProcessor
  client: CudaEmbeddingWorkerClient
}> | null = null
let cudaDisabled = false

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function getDeviceForBackend(backend: 'cpu' | 'gpu' | undefined): DinoDevice {
  if (backend !== 'gpu') return 'cpu'
  return process.platform === 'win32' ? 'dml' : 'gpu'
}

function reportProviderSelection(
  requestedBackend: 'cpu' | 'gpu' | 'cuda' | undefined,
  runtime: DinoRuntime | { selectedProvider: 'cuda'; initializationFallback: false },
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
    model: 'dino',
    requestedBackend: requested,
    selectedProvider: runtime.selectedProvider,
    fallback,
    reason,
  })
}

function configureTransformersEnvironment(
  transformers: DinoTransformersModule,
  modelPath: string,
): void {
  configureLocalTransformersEnvironment(transformers.env, modelPath)
}

async function createExtractor(
  modelPath: string,
  device: DinoDevice,
): Promise<ImageFeatureExtractor> {
  const transformers =
    (await import('@huggingface/transformers')) as unknown as DinoTransformersModule
  configureTransformersEnvironment(transformers, modelPath)

  return transformers.pipeline('image-feature-extraction', 'Xenova/dinov2-base', {
    dtype: 'q4',
    device,
  }) as Promise<ImageFeatureExtractor>
}

async function getCudaRuntime(
  task: DinoTask,
): Promise<{ processor: DinoProcessor; client: CudaEmbeddingWorkerClient }> {
  if (cudaDisabled || !task.cuda) throw new Error('DINO CUDA runtime is disabled')
  const cuda = task.cuda
  if (!cudaRuntimePromise) {
    cudaRuntimePromise = (async () => {
      const transformers =
        (await import('@huggingface/transformers')) as unknown as DinoTransformersModule
      configureTransformersEnvironment(transformers, task.modelPath)
      const processor = await transformers.AutoProcessor.from_pretrained('Xenova/dinov2-base')
      const client = new CudaEmbeddingWorkerClient({
        ...cuda,
        modelPath: task.modelPath,
        onStderr: (message) => process.stderr.write(`[DINO CUDA] ${message}\n`),
      })
      try {
        await client.hello
        return { processor, client }
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
      `DINO CUDA startup unavailable (${errorMessage(error)}); using DirectML/CPU\n`,
    )
    throw error
  }
}

function asCudaPixelValues(value: DinoTensor | undefined): CudaTensorInput {
  if (
    !value ||
    value.type !== 'float32' ||
    !Array.isArray(value.dims) ||
    !(value.data instanceof Float32Array)
  ) {
    throw new Error('DINO processor returned invalid CUDA pixel values')
  }
  return { name: 'pixel_values', dtype: 'float32', dimensions: value.dims, data: value.data }
}

async function inferCuda(
  task: DinoTask,
  images: DinoRawImage | DinoRawImage[],
): Promise<{ data: Float32Array; dims: number[] }> {
  const runtime = await getCudaRuntime(task)
  reportProviderSelection(task.backend, {
    selectedProvider: 'cuda',
    initializationFallback: false,
  })
  try {
    const inputs = await runtime.processor(images)
    const output = await runtime.client.infer([asCudaPixelValues(inputs.pixel_values)])
    return { data: output.data, dims: output.dimensions }
  } catch (error) {
    runtime.client.close()
    cudaRuntimePromise = null
    cudaDisabled = true
    process.stderr.write(
      `DINO CUDA inference unavailable (${errorMessage(error)}); using DirectML/CPU\n`,
    )
    throw error
  }
}

async function getExtractor(
  modelPath: string,
  backend: 'cpu' | 'gpu' | undefined,
): Promise<DinoRuntime> {
  const device = getDeviceForBackend(backend)
  if (!extractorPromises.has(device)) {
    if (!modelPath || !fs.existsSync(modelPath)) {
      throw new Error('DINOv2 ONNX model file is not installed')
    }
    const promise = createExtractor(modelPath, device)
      .then((extractor) => ({
        extractor,
        selectedProvider: device,
        initializationFallback: false,
      }))
      .catch(async (err: unknown) => {
        extractorPromises.delete(device)
        if (backend === 'gpu') {
          process.stderr.write(`DINO GPU backend unavailable (${errorMessage(err)}); using CPU\n`)
          const cpuRuntime = await getExtractor(modelPath, 'cpu')
          return {
            ...cpuRuntime,
            initializationFallback: true,
            fallbackReason:
              device === 'dml'
                ? 'dml-session-initialization-failed'
                : 'gpu-session-initialization-failed',
          }
        }
        throw err
      })
    extractorPromises.set(device, promise)
  }
  return extractorPromises.get(device)!
}

async function readDinoImage(imagePath: string): Promise<DinoRawImage> {
  const { RawImage } =
    (await import('@huggingface/transformers')) as unknown as DinoTransformersModule
  return (
    dinoFusedShadowEnabled
      ? readDinoTensorPrefetchImage(imagePath, RawImage)
      : readDinoImageBounded(imagePath, RawImage)
  ) as Promise<DinoRawImage>
}

function createBatchTimings(): DinoBatchTimings {
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

async function processTask(
  task: DinoTask,
  timings = createBatchTimings(),
  providerRequestedBackend = task.backend,
): Promise<number[]> {
  if (!fs.existsSync(task.imagePath)) throw new Error('Image file not found')
  let startedAt = performance.now()
  let image: Awaited<ReturnType<typeof readDinoImage>>
  try {
    image = await readDinoImage(task.imagePath)
  } finally {
    timings.decodeNormalizeMs += performance.now() - startedAt
  }
  timings.decodedPixelBytes = Math.max(timings.decodedPixelBytes, estimateDecodedImageBytes(image))
  if (task.backend === 'cuda' && !cudaDisabled) {
    try {
      startedAt = performance.now()
      let output: Awaited<ReturnType<typeof inferCuda>>
      try {
        output = await inferCuda(task, image)
      } finally {
        timings.inferenceMs += performance.now() - startedAt
      }
      timings.temporaryTensorBytes = Math.max(timings.temporaryTensorBytes, output.data.byteLength)
      startedAt = performance.now()
      const vector = poolDinoEmbedding(output.data, output.dims, task.dim)
      timings.postprocessMs += performance.now() - startedAt
      return vector
    } catch {
      timings.fallbackUsed = true
      startedAt = performance.now()
      try {
        return await processTask(
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
  let runtime: Awaited<ReturnType<typeof getExtractor>>
  try {
    runtime = await getExtractor(task.modelPath, task.backend === 'cuda' ? 'gpu' : task.backend)
  } finally {
    timings.runtimeLoadMs += performance.now() - startedAt
  }
  reportProviderSelection(providerRequestedBackend, runtime)
  startedAt = performance.now()
  let output: Awaited<ReturnType<ImageFeatureExtractor>>
  try {
    output = await runtime.extractor(image)
  } finally {
    timings.inferenceMs += performance.now() - startedAt
  }
  const data = output?.data
  if (!data || typeof data.length !== 'number') {
    throw new Error('DINOv2 returned no embedding data')
  }
  timings.temporaryTensorBytes = Math.max(
    timings.temporaryTensorBytes,
    ArrayBuffer.isView(data) ? data.byteLength : data.length * 4,
  )
  startedAt = performance.now()
  const vector = poolDinoEmbedding(data, output.dims, task.dim)
  timings.postprocessMs += performance.now() - startedAt
  return vector
}

// ── Batch processing ─────────────────────────────────────

let batchSize = 4
let pendingBatch: DinoTask[] = []
let batchTimer: ReturnType<typeof setTimeout> | null = null
let batchProcessing = false

function writeSuccess(
  task: Pick<DinoTask, 'id' | 'dim'>,
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
  task: Pick<DinoTask, 'id'>,
  error: string,
  metrics?: Record<string, unknown>,
): void {
  writeChildMessage({ id: task.id, ok: false, error, ...(metrics ? { metrics } : {}) })
}

function createBatchMetrics(
  tasks: DinoTask[],
  succeeded: number,
  failed: number,
  batchStartedAt: number,
  timings: DinoBatchTimings,
  memory: EmbeddingChildMemorySample,
): Record<string, unknown> | undefined {
  if (!stageMetricsEnabled) return undefined
  const queueWaits = tasks.map((task) =>
    Math.max(0, batchStartedAt - (task.receivedAt ?? batchStartedAt)),
  )
  return {
    model: 'dino',
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
    dinoFusedShadow: dinoFusedShadowEnabled,
    rssBytes: memory.rssBytes,
    privateBytes: memory.privateBytes,
    externalBytes: memory.externalBytes,
    arrayBuffersBytes: memory.arrayBuffersBytes,
  }
}

function flushBatch(): void {
  if (batchTimer) {
    clearTimeout(batchTimer)
    batchTimer = null
  }
  if (pendingBatch.length === 0) return
  const batch = pendingBatch
  pendingBatch = []
  void processBatch(batch)
}

async function processBatch(tasks: DinoTask[]): Promise<void> {
  if (batchProcessing) return
  batchProcessing = true
  const batchStartedAt = performance.now()
  const memoryBefore = stageMetricsEnabled ? await captureEmbeddingChildMemory() : null
  const timings = createBatchTimings()
  const outcomes = new Map<number, { vector?: number[]; error?: string }>()
  try {
    if (tasks.length === 1) {
      const task = tasks[0]
      try {
        const vector = await processTask(task, timings)
        outcomes.set(task.id, { vector: requireNormalizedEmbeddingVector(vector, task.dim) })
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
            const vector = await processTask(task, timings)
            outcomes.set(task.id, {
              vector: requireNormalizedEmbeddingVector(vector, task.dim),
            })
          } catch (error: unknown) {
            outcomes.set(task.id, { error: errorMessage(error) })
          }
        }
      } else {
        const modelPath = tasks[0].modelPath
        const backend = tasks[0].backend
        // Decode in parallel and normalize alpha/grayscale inputs to RGB before inference.
        const validTasks: DinoTask[] = []
        const images: DinoRawImage[] = []
        let startedAt = performance.now()
        const decodedBatch = await decodeEmbeddingImagesInWaves(
          imagePaths,
          async (imagePath) => {
            if (!fs.existsSync(imagePath)) throw new Error('Image file not found')
            return readDinoImage(imagePath)
          },
          preparedHeaders,
        )
        const decoded = decodedBatch.results
        timings.decodeNormalizeMs += performance.now() - startedAt
        timings.decodedPixelBytes = Math.max(
          timings.decodedPixelBytes,
          totalEmbeddingDecodedRgbBytes(decodedBatch.headers),
        )
        for (let i = 0; i < decoded.length; i++) {
          const result = decoded[i]
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

        let batchCompleted = false
        if (validTasks.length > 0 && backend === 'cuda' && !cudaDisabled) {
          try {
            startedAt = performance.now()
            let output: Awaited<ReturnType<typeof inferCuda>>
            try {
              output = await inferCuda(validTasks[0], images)
            } finally {
              timings.inferenceMs += performance.now() - startedAt
            }
            timings.temporaryTensorBytes = Math.max(
              timings.temporaryTensorBytes,
              output.data.byteLength,
            )
            startedAt = performance.now()
            const dim = validTasks[0].dim
            for (let i = 0; i < validTasks.length; i++) {
              try {
                outcomes.set(validTasks[i].id, {
                  vector: requireNormalizedEmbeddingVector(
                    poolDinoEmbedding(output.data, output.dims, dim, i),
                    dim,
                  ),
                })
              } catch (error: unknown) {
                outcomes.set(validTasks[i].id, { error: errorMessage(error) })
              }
            }
            timings.postprocessMs += performance.now() - startedAt
            batchCompleted = true
          } catch {
            timings.fallbackUsed = true
            // Continue below with DirectML, whose loader already falls back to CPU.
          }
        }

        if (validTasks.length > 0 && !batchCompleted) {
          startedAt = performance.now()
          let runtime: Awaited<ReturnType<typeof getExtractor>>
          try {
            runtime = await getExtractor(modelPath, backend === 'cuda' ? 'gpu' : backend)
          } finally {
            timings.runtimeLoadMs += performance.now() - startedAt
          }
          reportProviderSelection(backend, runtime)

          // Run one model call for the decoded RGB batch.
          try {
            startedAt = performance.now()
            let output: Awaited<ReturnType<ImageFeatureExtractor>>
            try {
              output = await runtime.extractor(images)
            } finally {
              timings.inferenceMs += performance.now() - startedAt
            }
            const data = output?.data
            if (!data || typeof data.length !== 'number') {
              throw new Error('DINOv2 returned no embedding data')
            }
            timings.temporaryTensorBytes = Math.max(
              timings.temporaryTensorBytes,
              ArrayBuffer.isView(data) ? data.byteLength : data.length * 4,
            )
            startedAt = performance.now()
            const dim = tasks[0].dim
            for (let i = 0; i < validTasks.length; i++) {
              try {
                outcomes.set(validTasks[i].id, {
                  vector: requireNormalizedEmbeddingVector(
                    poolDinoEmbedding(data, output.dims, dim, i),
                    dim,
                  ),
                })
              } catch (error: unknown) {
                outcomes.set(validTasks[i].id, { error: errorMessage(error) })
              }
            }
            timings.postprocessMs += performance.now() - startedAt
          } catch {
            // Batch failed → fall back one-by-one.
            timings.fallbackUsed = true
            const fallbackStartedAt = performance.now()
            for (const task of validTasks) {
              try {
                const vector = await processTask(task, timings)
                outcomes.set(task.id, {
                  vector: requireNormalizedEmbeddingVector(vector, task.dim),
                })
              } catch (err: unknown) {
                outcomes.set(task.id, { error: errorMessage(err) })
              }
            }
            timings.fallbackMs += performance.now() - fallbackStartedAt
          }
        }
      }
    }
  } catch (err: unknown) {
    for (const task of tasks) {
      if (!outcomes.has(task.id)) outcomes.set(task.id, { error: errorMessage(err) })
    }
  } finally {
    for (const task of tasks) {
      if (!outcomes.has(task.id)) {
        outcomes.set(task.id, { error: 'DINO batch did not produce a result' })
      }
    }
    const succeeded = tasks.filter((task) => outcomes.get(task.id)?.vector).length
    const memoryAfter = stageMetricsEnabled ? await captureEmbeddingChildMemory() : null
    const memory =
      memoryBefore && memoryAfter
        ? peakEmbeddingChildMemory(memoryBefore, memoryAfter)
        : { rssBytes: 0, privateBytes: null, externalBytes: 0, arrayBuffersBytes: 0 }
    const metrics = createBatchMetrics(
      tasks,
      succeeded,
      tasks.length - succeeded,
      batchStartedAt,
      timings,
      memory,
    )
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index]
      const outcome = outcomes.get(task.id)!
      const resultMetrics = index === 0 ? metrics : undefined
      if (outcome.vector) writeSuccess(task, outcome.vector, resultMetrics)
      else writeFailure(task, outcome.error || 'DINO batch failed', resultMetrics)
    }
    batchProcessing = false
  }
}

// ── Stdin loop ────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  let task: DinoTask
  try {
    task = JSON.parse(line) as DinoTask
  } catch {
    return
  }
  if (stageMetricsEnabled) task.receivedAt = performance.now()
  pendingBatch.push(task)
  if (task.batchSize && task.batchSize >= 1 && task.batchSize <= 16) {
    batchSize = task.batchSize
  }
  if (batchProcessing) return
  if (pendingBatch.length >= batchSize) {
    flushBatch()
  } else {
    if (!batchTimer) {
      batchTimer = setTimeout(flushBatch, 80)
    }
  }
})

writeChildMessage({ type: 'ready' })
