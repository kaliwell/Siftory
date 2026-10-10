// ── User Model Runtime Child ───────────────────────────────
// Isolated Node child process that loads unvetted user-supplied ONNX models
// for the Model Platform import check and for subject/face/person inference.
// A malformed or hostile model can abort the ONNX native runtime; keeping
// that work out of the Electron main process means a crash here only kills
// this disposable child. The host (electron/userModelRuntimeHost.ts) owns
// limits, timeouts and recovery.
//
// Protocol: one JSON request per stdin line, one JSON response per stdout
// line. Generic tensor payloads travel as base64 little-endian float32;
// original-size SAM masks use a compact bitset. Both ends frame with
// MAX_USER_MODEL_RUNTIME_LINE_BYTES.
//
// Ops:
//   inspect — import-time graph contract check (no inference)
//   load    — create/cache a session and return its tensor metadata
//   run     — execute one bounded inference and return raw output tensors
//   run-sam-decoder — select and bit-pack the best original-size SAM mask

import fs from 'fs'
import * as ort from 'onnxruntime-node'
import type {
  UserModelProfileDefinition,
  UserModelTensorDescriptor,
} from '../shared/userModelPlatform'
import { MAX_USER_MODEL_RUNTIME_LINE_BYTES, packBestSamMask } from './embeddingChildLineFraming'
import {
  boundedBinarySlice,
  encodeUserModelBinaryFrame,
  USER_MODEL_RUNTIME_SESSION_BUDGET_BYTES,
  UserModelBinaryFrameDecoder,
} from './userModelBinaryProtocol'
import { inspectUserModelContract } from './userModelRuntimeAdapters'

const MAX_GRAPH_TENSORS = 128
const MAX_TENSOR_NAME_CHARS = 256
const MAX_TENSOR_SHAPE_DIMS = 8
const MAX_TENSOR_SYMBOL_CHARS = 64
const MAX_TENSOR_ELEMENTS = 64 * 1024 * 1024
const SESSION_NATIVE_OVERHEAD_BYTES_APPROX = 64 * 1024 * 1024

interface UserModelRuntimeRequest {
  id?: unknown
  op?: unknown
  modelPath?: unknown
  profile?: unknown
  maxBytes?: unknown
  feeds?: unknown
  masksOutputName?: unknown
  iouOutputName?: unknown
}

interface SessionTensorMetadata {
  name: string
  type: string
  isTensor: boolean
  shape: Array<number | string>
}

interface CachedSession {
  session: ort.InferenceSession
  ownedBytesApprox: number
  cacheOwned: boolean
  info: {
    inputNames: string[]
    outputNames: string[]
    inputMetadata: SessionTensorMetadata[]
    outputMetadata: SessionTensorMetadata[]
  }
}

const sessions = new Map<string, CachedSession>()

function sessionCacheMemorySnapshot(): {
  sessionCount: number
  ownedBytesApprox: number
  budgetBytes: number
} {
  return {
    sessionCount: sessions.size,
    ownedBytesApprox: [...sessions.values()].reduce(
      (sum, entry) => sum + entry.ownedBytesApprox,
      0,
    ),
    budgetBytes: USER_MODEL_RUNTIME_SESSION_BUDGET_BYTES,
  }
}

function send(message: unknown, bodyParts: readonly ArrayBufferView[] = []): void {
  const envelope =
    message && typeof message === 'object' && !Array.isArray(message)
      ? { ...message, runtimeMemory: sessionCacheMemorySnapshot() }
      : message
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return
  try {
    process.stdout.write(encodeUserModelBinaryFrame(envelope as Record<string, unknown>, bodyParts))
  } catch {
    const id =
      message && typeof message === 'object' && 'id' in message
        ? (message as { id?: unknown }).id
        : 0
    process.stdout.write(
      encodeUserModelBinaryFrame({
        id,
        ok: false,
        error: `User model runtime response exceeds ${MAX_USER_MODEL_RUNTIME_LINE_BYTES} bytes`,
        runtimeMemory: sessionCacheMemorySnapshot(),
      }),
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeTensor(metadata: ort.InferenceSession.ValueMetadata): UserModelTensorDescriptor {
  const shape = metadata.isTensor ? [...metadata.shape] : []
  if (
    !metadata.name ||
    metadata.name.length > MAX_TENSOR_NAME_CHARS ||
    shape.length > MAX_TENSOR_SHAPE_DIMS ||
    shape.some(
      (dimension) => typeof dimension === 'string' && dimension.length > MAX_TENSOR_SYMBOL_CHARS,
    )
  ) {
    throw new Error('Model graph metadata exceeds the platform safety limit')
  }
  return {
    name: metadata.name,
    type: metadata.isTensor ? metadata.type : 'non-tensor',
    shape,
  }
}

function describeSessionTensor(
  metadata: ort.InferenceSession.ValueMetadata,
): SessionTensorMetadata {
  const descriptor = describeTensor(metadata)
  return { ...descriptor, isTensor: metadata.isTensor }
}

function validateModelFile(modelPath: string, maxBytes: number): fs.Stats {
  const stat = fs.statSync(modelPath)
  if (!stat.isFile() || stat.size > maxBytes) {
    throw new Error('Model file exceeds the slot size limit')
  }
  return stat
}

function tensorElementCount(dims: readonly number[]): number {
  let count = 1
  for (const dimension of dims) {
    if (!Number.isSafeInteger(dimension) || dimension <= 0 || dimension > 65_536) {
      throw new Error('Tensor shape exceeds the platform safety limit')
    }
    count *= dimension
    if (count > MAX_TENSOR_ELEMENTS) {
      throw new Error('Tensor element count exceeds the platform safety limit')
    }
  }
  return count
}

function decodeTensorData(
  body: Buffer,
  dataOffset: unknown,
  dataBytes: unknown,
  dims: readonly number[],
): Float32Array {
  const bytes = boundedBinarySlice(body, dataOffset, dataBytes)
  const elements = tensorElementCount(dims)
  if (bytes.length !== elements * 4) {
    throw new Error('Tensor payload does not match its declared shape')
  }
  if (bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, elements)
  }
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))
}

function decodeFeeds(feeds: unknown, body: Buffer): Record<string, ort.Tensor> {
  if (!Array.isArray(feeds) || feeds.length === 0 || feeds.length > MAX_GRAPH_TENSORS) {
    throw new Error('Inference feeds are missing or exceed the platform safety limit')
  }
  const tensors: Record<string, ort.Tensor> = {}
  for (const feed of feeds) {
    if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
      throw new Error('Inference feed is invalid')
    }
    const { name, dims, dataOffset, dataBytes } = feed as {
      name?: unknown
      dims?: unknown
      dataOffset?: unknown
      dataBytes?: unknown
    }
    if (typeof name !== 'string' || !name || name.length > MAX_TENSOR_NAME_CHARS) {
      throw new Error('Inference feed name exceeds the platform safety limit')
    }
    if (!Array.isArray(dims) || dims.length === 0 || dims.length > MAX_TENSOR_SHAPE_DIMS) {
      throw new Error('Inference feed shape exceeds the platform safety limit')
    }
    const data = decodeTensorData(body, dataOffset, dataBytes, dims as number[])
    tensors[name] = new ort.Tensor('float32', data, dims as number[])
  }
  return tensors
}

async function loadSession(modelPath: string, maxBytes: number): Promise<CachedSession> {
  const stat = validateModelFile(modelPath, maxBytes)
  const key = `${modelPath}:${stat.size}:${stat.mtimeMs}`
  const cached = sessions.get(key)
  if (cached) {
    sessions.delete(key)
    sessions.set(key, cached)
    return cached
  }
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
  })
  if (
    session.inputMetadata.length > MAX_GRAPH_TENSORS ||
    session.outputMetadata.length > MAX_GRAPH_TENSORS
  ) {
    await session.release()
    throw new Error('Model graph exposes too many inputs or outputs')
  }
  const entry: CachedSession = {
    session,
    // ONNX Runtime does not expose native allocator ownership. Model bytes plus
    // a bounded native/session allowance is conservative and stable enough for
    // eviction decisions; process-tree Private Bytes remains the outer gate.
    ownedBytesApprox: Math.min(
      Number.MAX_SAFE_INTEGER,
      stat.size + Math.max(SESSION_NATIVE_OVERHEAD_BYTES_APPROX, Math.ceil(stat.size / 4)),
    ),
    cacheOwned: false,
    info: {
      inputNames: [...session.inputNames],
      outputNames: [...session.outputNames],
      inputMetadata: session.inputMetadata.map(describeSessionTensor),
      outputMetadata: session.outputMetadata.map(describeSessionTensor),
    },
  }
  if (entry.ownedBytesApprox > USER_MODEL_RUNTIME_SESSION_BUDGET_BYTES) return entry
  let currentBytes = sessionCacheMemorySnapshot().ownedBytesApprox
  while (
    sessions.size > 0 &&
    currentBytes + entry.ownedBytesApprox > USER_MODEL_RUNTIME_SESSION_BUDGET_BYTES
  ) {
    const oldestKey = sessions.keys().next().value
    const oldest = oldestKey ? sessions.get(oldestKey) : undefined
    if (!oldestKey || !oldest) break
    sessions.delete(oldestKey)
    currentBytes -= oldest.ownedBytesApprox
    await oldest.session.release().catch(() => {})
  }
  entry.cacheOwned = true
  sessions.set(key, entry)
  return entry
}

async function inspectModel(
  modelPath: string,
  profile: UserModelProfileDefinition,
  maxBytes: number,
) {
  validateModelFile(modelPath, maxBytes)
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'disabled',
  })
  try {
    if (
      session.inputMetadata.length > MAX_GRAPH_TENSORS ||
      session.outputMetadata.length > MAX_GRAPH_TENSORS
    ) {
      throw new Error('Model graph exposes too many inputs or outputs')
    }
    return inspectUserModelContract(
      profile,
      session.inputMetadata.map(describeTensor),
      session.outputMetadata.map(describeTensor),
    )
  } finally {
    await session.release()
  }
}

async function runModel(
  modelPath: string,
  maxBytes: number,
  feeds: unknown,
  body: Buffer,
): Promise<Array<{ name: string; dims: number[]; data: Float32Array }>> {
  const loaded = await loadSession(modelPath, maxBytes)
  try {
    const tensors = decodeFeeds(feeds, body)
    const outputs = await loaded.session.run(tensors)
    const result: Array<{ name: string; dims: number[]; data: Float32Array }> = []
    for (const [name, tensor] of Object.entries(outputs)) {
      const dims = [...tensor.dims]
      const elements = tensorElementCount(dims)
      // Non-float outputs (e.g. int64 NMS indices) are widened to float32 so
      // downstream adapters keep their existing number-based parsing.
      const data =
        tensor.type === 'float32'
          ? (tensor.data as Float32Array)
          : Float32Array.from(Array.from(tensor.data as ArrayLike<unknown>, Number))
      if (data.length !== elements) {
        throw new Error('Model output does not match its declared shape')
      }
      result.push({ name, dims, data })
    }
    return result
  } finally {
    if (!loaded.cacheOwned) await loaded.session.release().catch(() => {})
  }
}

function requireSamOutputName(
  value: unknown,
  outputNames: readonly string[],
  label: string,
): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_TENSOR_NAME_CHARS ||
    !outputNames.includes(value)
  ) {
    throw new Error(`SAM decoder ${label} output name is invalid`)
  }
  return value
}

async function runSamDecoder(
  modelPath: string,
  maxBytes: number,
  feeds: unknown,
  rawMasksOutputName: unknown,
  rawIouOutputName: unknown,
  body: Buffer,
): Promise<{ width: number; height: number; iou: number; maskBits: Uint8Array }> {
  const loaded = await loadSession(modelPath, maxBytes)
  try {
    const masksOutputName = requireSamOutputName(
      rawMasksOutputName,
      loaded.info.outputNames,
      'mask',
    )
    const iouOutputName = requireSamOutputName(rawIouOutputName, loaded.info.outputNames, 'IoU')
    if (masksOutputName === iouOutputName) {
      throw new Error('SAM decoder mask and IoU outputs must be distinct')
    }

    const outputs = await loaded.session.run(decodeFeeds(feeds, body), [
      masksOutputName,
      iouOutputName,
    ])
    const masksTensor = outputs[masksOutputName]
    const iouTensor = outputs[iouOutputName]
    if (
      !(masksTensor instanceof ort.Tensor) ||
      !(iouTensor instanceof ort.Tensor) ||
      masksTensor.type !== 'float32' ||
      iouTensor.type !== 'float32'
    ) {
      throw new Error('SAM decoder returned invalid output tensor types')
    }
    const packed = packBestSamMask(
      [...masksTensor.dims],
      masksTensor.data as Float32Array,
      iouTensor.data as Float32Array,
    )
    return {
      width: packed.width,
      height: packed.height,
      iou: packed.iou,
      maskBits: new Uint8Array(
        packed.maskBits.buffer,
        packed.maskBits.byteOffset,
        packed.maskBits.byteLength,
      ),
    }
  } finally {
    if (!loaded.cacheOwned) await loaded.session.release().catch(() => {})
  }
}

async function handle(request: UserModelRuntimeRequest, body: Buffer): Promise<void> {
  const id = typeof request.id === 'number' ? request.id : 0
  try {
    if (
      typeof request.modelPath !== 'string' ||
      !request.modelPath ||
      typeof request.maxBytes !== 'number' ||
      !Number.isFinite(request.maxBytes) ||
      request.maxBytes <= 0
    ) {
      throw new Error('Unsupported user model runtime request')
    }
    if (request.op === 'inspect') {
      if (!request.profile || typeof request.profile !== 'object') {
        throw new Error('Unsupported user model runtime request')
      }
      const inspection = await inspectModel(
        request.modelPath,
        request.profile as UserModelProfileDefinition,
        request.maxBytes,
      )
      send({ id, ok: true, inspection })
      return
    }
    if (request.op === 'load') {
      const loaded = await loadSession(request.modelPath, request.maxBytes)
      send({ id, ok: true, session: loaded.info })
      if (!loaded.cacheOwned) await loaded.session.release().catch(() => {})
      return
    }
    if (request.op === 'run') {
      const outputs = await runModel(request.modelPath, request.maxBytes, request.feeds, body)
      let offset = 0
      const descriptors = outputs.map((output) => {
        const descriptor = {
          name: output.name,
          dims: output.dims,
          dataOffset: offset,
          dataBytes: output.data.byteLength,
        }
        offset += output.data.byteLength
        return descriptor
      })
      send(
        { id, ok: true, outputs: descriptors },
        outputs.map((output) => output.data),
      )
      return
    }
    if (request.op === 'run-sam-decoder') {
      const mask = await runSamDecoder(
        request.modelPath,
        request.maxBytes,
        request.feeds,
        request.masksOutputName,
        request.iouOutputName,
        body,
      )
      send(
        {
          id,
          ok: true,
          mask: {
            width: mask.width,
            height: mask.height,
            iou: mask.iou,
            dataOffset: 0,
            dataBytes: mask.maskBits.byteLength,
          },
        },
        [mask.maskBits],
      )
      return
    }
    throw new Error('Unsupported user model runtime request')
  } catch (error) {
    send({ id, ok: false, error: errorMessage(error) })
  }
}

const stdinFramer = new UserModelBinaryFrameDecoder()
process.stdin.on('end', () => {
  // The parent exited or disposed us; never linger as an orphan.
  process.exit(0)
})
process.stdin.on('data', (chunk: Buffer) => {
  const frame = stdinFramer.push(chunk)
  if (frame.overflow) {
    // An oversized request cannot be answered; exit so the host rejects the
    // pending request immediately instead of waiting for the timeout.
    process.exit(1)
  }
  for (const framed of frame.frames) {
    void handle(framed.header as UserModelRuntimeRequest, framed.body)
  }
})
