import { requireNormalizedEmbeddingVector } from './embeddingVectorValidation'
import type {
  EmbeddingProgress,
  EmbeddingProviderTelemetry,
  EmbeddingStageMetrics,
} from '../shared/vectorTypes'

export const MAX_EMBEDDING_CHILD_LINE_BYTES = 256 * 1024

/**
 * User-model runtime frames carry base64 float32 tensors (a 1024x1024x3 SAM
 * encoder feed is ~17 MB), so that child gets a larger but still hard cap.
 * Original-size SAM outputs are selected and bit-packed before transport.
 */
export const MAX_USER_MODEL_RUNTIME_LINE_BYTES = 96 * 1024 * 1024

export const MAX_SAM_MASK_TENSOR_ELEMENTS = 64 * 1024 * 1024
export const MAX_SAM_MASK_PIXELS = 64 * 1024 * 1024

export interface PackedSamMask {
  width: number
  height: number
  iou: number
  maskBits: Uint8Array
}

function requirePositiveSamDimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_536) {
    throw new Error(`SAM ${label} exceeds the platform safety limit`)
  }
  return value
}

/** Exact byte count for a one-bit-per-pixel SAM mask transport payload. */
export function packedSamMaskByteLength(width: number, height: number): number {
  const safeWidth = requirePositiveSamDimension(width, 'mask width')
  const safeHeight = requirePositiveSamDimension(height, 'mask height')
  const pixels = safeWidth * safeHeight
  if (!Number.isSafeInteger(pixels) || pixels > MAX_SAM_MASK_PIXELS) {
    throw new Error('SAM mask pixel count exceeds the platform safety limit')
  }
  return Math.ceil(pixels / 8)
}

/** Select the best-IoU plane and preserve its existing > 0 mask threshold. */
export function packBestSamMask(
  maskDims: readonly number[],
  maskData: ArrayLike<number>,
  iouData: ArrayLike<number>,
): PackedSamMask {
  if (maskDims.length !== 4) {
    throw new Error('SAM decoder returned an invalid mask shape')
  }
  const [batch, maskCount, height, width] = maskDims
  if (batch !== 1) throw new Error('SAM decoder returned an unsupported mask batch')
  requirePositiveSamDimension(maskCount, 'mask count')
  const byteLength = packedSamMaskByteLength(width, height)
  const pixels = width * height
  const totalElements = pixels * maskCount
  if (
    !Number.isSafeInteger(totalElements) ||
    totalElements > MAX_SAM_MASK_TENSOR_ELEMENTS ||
    maskData.length !== totalElements
  ) {
    throw new Error('SAM decoder mask tensor exceeds the platform safety limit')
  }
  if (iouData.length < maskCount) {
    throw new Error('SAM decoder returned too few IoU predictions')
  }

  let bestIndex = 0
  let bestIou = Number(iouData[0])
  if (!Number.isFinite(bestIou)) {
    throw new Error('SAM decoder returned a non-finite IoU prediction')
  }
  for (let index = 1; index < maskCount; index++) {
    const candidate = Number(iouData[index])
    if (!Number.isFinite(candidate)) {
      throw new Error('SAM decoder returned a non-finite IoU prediction')
    }
    if (candidate > bestIou) {
      bestIndex = index
      bestIou = candidate
    }
  }

  const maskBits = new Uint8Array(byteLength)
  const offset = bestIndex * pixels
  for (let index = 0; index < pixels; index++) {
    const value = Number(maskData[offset + index])
    if (!Number.isFinite(value)) {
      throw new Error('SAM decoder returned a non-finite mask value')
    }
    if (value > 0) maskBits[index >>> 3] |= 1 << (index & 7)
  }
  return { width, height, iou: bestIou, maskBits }
}

export function packedSamMaskHasPixel(maskBits: Uint8Array, index: number): boolean {
  return (maskBits[index >>> 3] & (1 << (index & 7))) !== 0
}

export interface EmbeddingChildLineFrameResult {
  lines: string[]
  overflow: boolean
}

export interface EmbeddingWorkerChildMessage {
  id?: number
  type?: string
  ok?: boolean
  vector?: unknown
  error?: string
  metrics?: unknown
  model?: unknown
  requestedBackend?: unknown
  selectedProvider?: unknown
  fallback?: unknown
  reason?: unknown
}

export interface EmbeddingWorkerProviderTelemetry {
  model: 'dino' | 'clip'
  requestedBackend: 'cpu' | 'gpu' | 'cuda'
  selectedProvider: 'cpu' | 'dml' | 'gpu' | 'cuda'
  fallback: boolean
  reason: string
}

const PROVIDER_REASON_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/

/** Accepts only the bounded, path-free provider telemetry child protocol. */
export function providerTelemetryFromChildMessage(
  message: EmbeddingWorkerChildMessage,
): EmbeddingWorkerProviderTelemetry | null {
  if (
    message.type !== 'provider-selected' ||
    (message.model !== 'dino' && message.model !== 'clip') ||
    !['cpu', 'gpu', 'cuda'].includes(String(message.requestedBackend)) ||
    !['cpu', 'dml', 'gpu', 'cuda'].includes(String(message.selectedProvider)) ||
    typeof message.fallback !== 'boolean' ||
    typeof message.reason !== 'string' ||
    !PROVIDER_REASON_PATTERN.test(message.reason)
  ) {
    return null
  }
  return {
    model: message.model,
    requestedBackend: message.requestedBackend as 'cpu' | 'gpu' | 'cuda',
    selectedProvider: message.selectedProvider as 'cpu' | 'dml' | 'gpu' | 'cuda',
    fallback: message.fallback,
    reason: message.reason,
  }
}

/** Purely aggregates bounded provider evidence without emitting an extra progress event. */
export function withEmbeddingProviderTelemetry(
  progress: EmbeddingProgress,
  telemetry: EmbeddingWorkerProviderTelemetry,
): EmbeddingProgress {
  const current = progress.providerTelemetry
  const requestedBackends = new Set(current?.requestedBackends || [])
  const selectedProviders = new Set(current?.selectedProviders || [])
  const reasons = new Set(current?.reasons || [])
  requestedBackends.add(telemetry.requestedBackend)
  selectedProviders.add(telemetry.selectedProvider)
  reasons.add(telemetry.reason)
  const next: EmbeddingProviderTelemetry = {
    schemaVersion: 1,
    model: telemetry.model,
    requestedBackends: [...requestedBackends].sort(),
    selectedProviders: [...selectedProviders].sort(),
    fallbackDetected: current?.fallbackDetected === true || telemetry.fallback,
    reports: Math.min(1_024, (current?.reports || 0) + 1),
    reasons: [...reasons].sort().slice(0, 16),
  }
  return { ...progress, providerTelemetry: next }
}

export interface EmbeddingWorkerBatchMetrics {
  model: 'dino' | 'clip'
  batchSize: number
  succeeded: number
  failed: number
  fallback: boolean
  queueWaitMsTotal: number
  queueWaitMsMax: number
  batchWallMs: number
  runtimeLoadMs: number
  decodeNormalizeMs: number
  preprocessMs: number
  inferenceMs: number
  postprocessMs: number
  fallbackMs: number
  tensorPrefetch: boolean
  tensorBytes: number
  prefetchPrepareMs: number
  prefetchWaitMs: number
  prefetchOverlapMs: number
  rssBytes: number
  privateBytes: number | null
  externalBytes: number
  arrayBuffersBytes: number
  decodedPixelBytes: number
  temporaryTensorBytes: number
}

export function embeddingStageMetricsEnabled(): boolean {
  return process.env.REASONIX_EMBEDDING_STAGE_METRICS === '1'
}

export function createEmbeddingStageMetrics(): EmbeddingStageMetrics {
  return {
    schemaVersion: 1,
    batches: 0,
    items: 0,
    succeeded: 0,
    failed: 0,
    fallbackBatches: 0,
    queueWaitMsTotal: 0,
    queueWaitMsMax: 0,
    batchWallMsTotal: 0,
    batchWallMsMax: 0,
    runtimeLoadMsTotal: 0,
    decodeNormalizeMsTotal: 0,
    preprocessMsTotal: 0,
    inferenceMsTotal: 0,
    postprocessMsTotal: 0,
    fallbackMsTotal: 0,
    persistenceOperations: 0,
    persistenceMsTotal: 0,
    persistenceMsMax: 0,
    persistencePeakPending: 0,
  }
}

export function addEmbeddingBatchMetrics(
  current: EmbeddingStageMetrics,
  metrics: EmbeddingWorkerBatchMetrics,
): EmbeddingStageMetrics {
  return {
    ...current,
    batches: current.batches + 1,
    items: current.items + metrics.batchSize,
    succeeded: current.succeeded + metrics.succeeded,
    failed: current.failed + metrics.failed,
    fallbackBatches: current.fallbackBatches + (metrics.fallback ? 1 : 0),
    queueWaitMsTotal: current.queueWaitMsTotal + metrics.queueWaitMsTotal,
    queueWaitMsMax: Math.max(current.queueWaitMsMax, metrics.queueWaitMsMax),
    batchWallMsTotal: current.batchWallMsTotal + metrics.batchWallMs,
    batchWallMsMax: Math.max(current.batchWallMsMax, metrics.batchWallMs),
    runtimeLoadMsTotal: current.runtimeLoadMsTotal + metrics.runtimeLoadMs,
    decodeNormalizeMsTotal: current.decodeNormalizeMsTotal + metrics.decodeNormalizeMs,
    preprocessMsTotal: current.preprocessMsTotal + metrics.preprocessMs,
    inferenceMsTotal: current.inferenceMsTotal + metrics.inferenceMs,
    postprocessMsTotal: current.postprocessMsTotal + metrics.postprocessMs,
    fallbackMsTotal: current.fallbackMsTotal + metrics.fallbackMs,
  }
}

export function addEmbeddingPersistenceEnqueued(
  current: EmbeddingStageMetrics,
  pendingPersistence: number,
): EmbeddingStageMetrics {
  return {
    ...current,
    persistencePeakPending: Math.max(current.persistencePeakPending, pendingPersistence),
  }
}

export function addEmbeddingPersistenceFinished(
  current: EmbeddingStageMetrics,
  elapsedMs: number,
): EmbeddingStageMetrics {
  return {
    ...current,
    persistenceOperations: current.persistenceOperations + 1,
    persistenceMsTotal: current.persistenceMsTotal + elapsedMs,
    persistenceMsMax: Math.max(current.persistenceMsMax, elapsedMs),
  }
}

const MAX_EMBEDDING_BATCH_SIZE = 16
const MAX_EMBEDDING_BATCH_STAGE_MS = 24 * 60 * 60 * 1000

function boundedStageNumber(value: unknown, maximum = MAX_EMBEDDING_BATCH_STAGE_MS): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : null
}

/** Validates optional child telemetry without trusting arbitrary stdout fields. */
export function batchMetricsFromChildMessage(
  message: EmbeddingWorkerChildMessage,
): EmbeddingWorkerBatchMetrics | null {
  const isStandaloneMetrics = message.type === 'batch-metrics'
  const isResultMetrics = message.type === undefined && Number.isInteger(message.id)
  if (
    (!isStandaloneMetrics && !isResultMetrics) ||
    !message.metrics ||
    typeof message.metrics !== 'object'
  ) {
    return null
  }
  const input = message.metrics as Record<string, unknown>
  if (input.model !== 'dino' && input.model !== 'clip') return null
  const batchSize = boundedStageNumber(input.batchSize, MAX_EMBEDDING_BATCH_SIZE)
  const succeeded = boundedStageNumber(input.succeeded, MAX_EMBEDDING_BATCH_SIZE)
  const failed = boundedStageNumber(input.failed, MAX_EMBEDDING_BATCH_SIZE)
  if (
    batchSize === null ||
    succeeded === null ||
    failed === null ||
    !Number.isInteger(batchSize) ||
    !Number.isInteger(succeeded) ||
    !Number.isInteger(failed) ||
    batchSize < 1 ||
    succeeded + failed !== batchSize ||
    typeof input.fallback !== 'boolean'
  ) {
    return null
  }
  const queueWaitMsTotal = boundedStageNumber(
    input.queueWaitMsTotal,
    MAX_EMBEDDING_BATCH_STAGE_MS * MAX_EMBEDDING_BATCH_SIZE,
  )
  const fields = [
    'queueWaitMsMax',
    'batchWallMs',
    'runtimeLoadMs',
    'decodeNormalizeMs',
    'preprocessMs',
    'inferenceMs',
    'postprocessMs',
    'fallbackMs',
  ] as const
  const values = Object.fromEntries(
    fields.map((field) => [field, boundedStageNumber(input[field])]),
  )
  if (queueWaitMsTotal === null || Object.values(values).some((value) => value === null)) {
    return null
  }
  const tensorBytes = boundedStageNumber(input.tensorBytes ?? 0, 16 * 1024 * 1024)
  const prefetchPrepareMs = boundedStageNumber(input.prefetchPrepareMs ?? 0)
  const prefetchWaitMs = boundedStageNumber(input.prefetchWaitMs ?? 0)
  const prefetchOverlapMs = boundedStageNumber(input.prefetchOverlapMs ?? 0)
  const rssBytes = boundedStageNumber(input.rssBytes ?? 0, 64 * 1024 * 1024 * 1024)
  const externalBytes = boundedStageNumber(input.externalBytes ?? 0, 64 * 1024 * 1024 * 1024)
  const arrayBuffersBytes = boundedStageNumber(
    input.arrayBuffersBytes ?? 0,
    64 * 1024 * 1024 * 1024,
  )
  const decodedPixelBytes = boundedStageNumber(input.decodedPixelBytes ?? 0, 4 * 1024 * 1024 * 1024)
  const temporaryTensorBytes = boundedStageNumber(
    input.temporaryTensorBytes ?? tensorBytes ?? 0,
    4 * 1024 * 1024 * 1024,
  )
  const privateBytes =
    input.privateBytes === undefined || input.privateBytes === null
      ? null
      : boundedStageNumber(input.privateBytes, 64 * 1024 * 1024 * 1024)
  if (
    tensorBytes === null ||
    prefetchPrepareMs === null ||
    prefetchWaitMs === null ||
    prefetchOverlapMs === null ||
    rssBytes === null ||
    externalBytes === null ||
    arrayBuffersBytes === null ||
    decodedPixelBytes === null ||
    temporaryTensorBytes === null ||
    (input.privateBytes !== undefined && input.privateBytes !== null && privateBytes === null)
  ) {
    return null
  }
  return {
    model: input.model,
    batchSize,
    succeeded,
    failed,
    fallback: input.fallback,
    queueWaitMsTotal,
    queueWaitMsMax: values.queueWaitMsMax!,
    batchWallMs: values.batchWallMs!,
    runtimeLoadMs: values.runtimeLoadMs!,
    decodeNormalizeMs: values.decodeNormalizeMs!,
    preprocessMs: values.preprocessMs!,
    inferenceMs: values.inferenceMs!,
    postprocessMs: values.postprocessMs!,
    fallbackMs: values.fallbackMs!,
    tensorPrefetch: input.tensorPrefetch === true,
    tensorBytes,
    prefetchPrepareMs,
    prefetchWaitMs,
    prefetchOverlapMs,
    rssBytes,
    privateBytes,
    externalBytes,
    arrayBuffersBytes,
    decodedPixelBytes,
    temporaryTensorBytes,
  }
}

export interface EmbeddingWorkerTaskContext<TLease = unknown> {
  imageId: string
  modelName: string
  dim: number
  jobId?: number
  jobLease?: TLease
}

export interface EmbeddingWorkerChildResult<TLease = unknown> {
  imageId: string
  ok: boolean
  vector?: number[]
  error?: string
  modelName: string
  modelVersion: string
  dim: number
  jobId?: number
  jobLease?: TLease
}

export function parseEmbeddingWorkerChildMessage(line: string): EmbeddingWorkerChildMessage | null {
  try {
    const parsed = JSON.parse(line) as EmbeddingWorkerChildMessage
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function workerResultFromChildMessage<TLease>(
  task: EmbeddingWorkerTaskContext<TLease>,
  message: EmbeddingWorkerChildMessage,
  workerName: 'CLIP' | 'DINO',
): EmbeddingWorkerChildResult<TLease> {
  const base = {
    imageId: task.imageId,
    modelName: task.modelName,
    modelVersion: '1.0.0',
    dim: task.dim,
    jobId: task.jobId,
    jobLease: task.jobLease,
  }
  if (message.ok !== true) {
    return {
      ...base,
      ok: false,
      error:
        typeof message.error === 'string' ? message.error : `${workerName} child returned an error`,
    }
  }
  try {
    return {
      ...base,
      ok: true,
      vector: requireNormalizedEmbeddingVector(message.vector, task.dim),
    }
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: `${workerName} child returned an invalid vector: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** Incremental UTF-8 line framing with a hard cap on any unfinished line. */
export class BoundedEmbeddingChildLineFramer {
  private buffered = ''
  private bufferedBytes = 0

  constructor(private readonly maxLineBytes = MAX_EMBEDDING_CHILD_LINE_BYTES) {
    if (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new RangeError(`Child line limit must be a positive integer, got ${maxLineBytes}`)
    }
  }

  push(chunk: string): EmbeddingChildLineFrameResult {
    const lines: string[] = []
    let start = 0
    for (;;) {
      const newline = chunk.indexOf('\n', start)
      const end = newline >= 0 ? newline : chunk.length
      const segment = chunk.slice(start, end)
      const segmentBytes = Buffer.byteLength(segment, 'utf8')
      if (this.bufferedBytes + segmentBytes > this.maxLineBytes) {
        this.reset()
        return { lines: [], overflow: true }
      }
      this.buffered += segment
      this.bufferedBytes += segmentBytes
      if (newline < 0) return { lines, overflow: false }
      lines.push(this.buffered)
      this.buffered = ''
      this.bufferedBytes = 0
      start = newline + 1
    }
  }

  reset(): void {
    this.buffered = ''
    this.bufferedBytes = 0
  }
}
