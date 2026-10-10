import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs'
import path from 'path'

const MAGIC = 0x4d454346
const PROTOCOL_VERSION = 1
const HEADER_BYTES = 16
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024
const MAX_TENSORS = 8
const MAX_RANK = 8

const MESSAGE = {
  hello: 1,
  infer: 2,
  result: 3,
  error: 4,
  ping: 5,
  pong: 6,
  shutdown: 7,
} as const

export type CudaTensorInput =
  | {
      name: string
      dtype: 'float32'
      dimensions: number[]
      data: Float32Array
    }
  | {
      name: string
      dtype: 'int64'
      dimensions: number[]
      data: BigInt64Array
    }

export interface CudaTensorOutput {
  dtype: 'float32'
  dimensions: number[]
  data: Float32Array
}

export interface CudaWorkerHello {
  protocolVersion: number
  provider: 'cuda'
  deviceId: number
  model: string
  ortVersion: string
  availableProviders: string[]
}

export interface CudaEmbeddingWorkerOptions {
  workerPath: string
  runtimeDir: string
  modelPath: string
  modelId: string
  outputName: string
  dllDirectories?: string[]
  startupTimeoutMs?: number
  inferenceTimeoutMs?: number
  onStderr?: (message: string) => void
}

interface PendingRequest {
  resolve: (output: CudaTensorOutput) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateAbsoluteFile(filePath: string, label: string): string {
  const resolved = path.resolve(filePath)
  if (!path.isAbsolute(filePath) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} must be an existing absolute file`)
  }
  return resolved
}

function validateAbsoluteDirectory(directoryPath: string, label: string): string {
  const resolved = path.resolve(directoryPath)
  if (!path.isAbsolute(directoryPath) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} must be an existing absolute directory`)
  }
  return resolved
}

function valueCount(dimensions: readonly number[]): number {
  if (dimensions.length === 0 || dimensions.length > MAX_RANK) {
    throw new Error('CUDA tensor rank is outside the protocol limit')
  }
  let count = 1
  for (const dimension of dimensions) {
    if (!Number.isSafeInteger(dimension) || dimension < 1) {
      throw new Error('CUDA tensor dimensions must be positive safe integers')
    }
    count *= dimension
    if (!Number.isSafeInteger(count) || count > 64 * 1024 * 1024) {
      throw new Error('CUDA tensor value count exceeds the protocol limit')
    }
  }
  return count
}

function encodeInferencePayload(tensors: readonly CudaTensorInput[]): Buffer {
  if (tensors.length === 0 || tensors.length > MAX_TENSORS) {
    throw new Error('CUDA tensor count is outside the protocol limit')
  }
  const names = new Set<string>()
  const chunks: Buffer[] = []
  const count = Buffer.allocUnsafe(2)
  count.writeUInt16LE(tensors.length)
  chunks.push(count)
  for (const tensor of tensors) {
    if (names.has(tensor.name)) throw new Error(`duplicate CUDA tensor name: ${tensor.name}`)
    names.add(tensor.name)
    const name = Buffer.from(tensor.name, 'utf8')
    if (name.length === 0 || name.length > 128) throw new Error('CUDA tensor name is invalid')
    const expectedValues = valueCount(tensor.dimensions)
    if (tensor.data.length !== expectedValues) {
      throw new Error(`${tensor.name}: CUDA tensor dimensions do not match its data`)
    }
    const descriptor = Buffer.allocUnsafe(6)
    descriptor.writeUInt16LE(name.length, 0)
    descriptor.writeUInt8(tensor.dtype === 'float32' ? 1 : 2, 2)
    descriptor.writeUInt8(tensor.dimensions.length, 3)
    descriptor.writeUInt16LE(0, 4)
    const shapeAndLength = Buffer.allocUnsafe(tensor.dimensions.length * 8 + 8)
    let offset = 0
    for (const dimension of tensor.dimensions) {
      shapeAndLength.writeBigInt64LE(BigInt(dimension), offset)
      offset += 8
    }
    shapeAndLength.writeBigUInt64LE(BigInt(tensor.data.byteLength), offset)
    chunks.push(
      descriptor,
      name,
      shapeAndLength,
      Buffer.from(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength),
    )
  }
  const payload = Buffer.concat(chunks)
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error('CUDA inference payload is too large')
  return payload
}

function encodeMessage(
  type: number,
  requestId: number,
  payload: Uint8Array = Buffer.alloc(0),
): Buffer {
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error('CUDA worker payload is too large')
  const header = Buffer.allocUnsafe(HEADER_BYTES)
  header.writeUInt32LE(MAGIC, 0)
  header.writeUInt16LE(PROTOCOL_VERSION, 4)
  header.writeUInt16LE(type, 6)
  header.writeUInt32LE(requestId, 8)
  header.writeUInt32LE(payload.length, 12)
  return payload.length > 0 ? Buffer.concat([header, payload]) : header
}

function decodeFloatOutput(payload: Buffer): CudaTensorOutput {
  if (payload.length < 12) throw new Error('CUDA worker returned a truncated tensor')
  const dtype = payload.readUInt8(0)
  const rank = payload.readUInt8(1)
  if (dtype !== 1 || rank === 0 || rank > MAX_RANK) {
    throw new Error('CUDA worker returned an unsupported tensor')
  }
  const descriptorBytes = 4 + rank * 8 + 8
  if (payload.length < descriptorBytes)
    throw new Error('CUDA worker tensor descriptor is truncated')
  const dimensions: number[] = []
  let offset = 4
  for (let index = 0; index < rank; index += 1) {
    const dimension = Number(payload.readBigInt64LE(offset))
    dimensions.push(dimension)
    offset += 8
  }
  const dataBytes = Number(payload.readBigUInt64LE(offset))
  offset += 8
  const expectedValues = valueCount(dimensions)
  if (dataBytes !== expectedValues * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error('CUDA worker tensor byte length is invalid')
  }
  if (offset + dataBytes !== payload.length) throw new Error('CUDA worker tensor has trailing data')
  const copied = Uint8Array.from(payload.subarray(offset))
  return { dtype: 'float32', dimensions, data: new Float32Array(copied.buffer) }
}

export class CudaEmbeddingWorkerClient {
  readonly hello: Promise<CudaWorkerHello>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private readonly inferenceTimeoutMs: number
  private stdoutBuffer = Buffer.alloc(0)
  private nextRequestId = 1
  private closed = false
  private resolveHello!: (hello: CudaWorkerHello) => void
  private rejectHello!: (error: Error) => void
  private startupTimer: ReturnType<typeof setTimeout>

  constructor(options: CudaEmbeddingWorkerOptions) {
    const workerPath = validateAbsoluteFile(options.workerPath, 'CUDA worker path')
    const modelPath = validateAbsoluteFile(options.modelPath, 'CUDA model path')
    const runtimeDir = validateAbsoluteDirectory(options.runtimeDir, 'CUDA runtime directory')
    if (path.dirname(workerPath).toLowerCase() !== runtimeDir.toLowerCase()) {
      throw new Error('CUDA worker must be colocated with its private ONNX Runtime DLLs')
    }
    const dllDirectories = (options.dllDirectories || []).map((directory, index) =>
      validateAbsoluteDirectory(directory, `CUDA DLL directory ${index}`),
    )
    this.inferenceTimeoutMs = Math.max(1_000, options.inferenceTimeoutMs || 120_000)
    this.hello = new Promise<CudaWorkerHello>((resolve, reject) => {
      this.resolveHello = resolve
      this.rejectHello = reject
    })
    const env = {
      ...process.env,
      PATH: [runtimeDir, ...dllDirectories, process.env.PATH || ''].join(path.delimiter),
    }
    const workerArguments = [
      '--model-path',
      modelPath,
      '--runtime-dir',
      runtimeDir,
      ...dllDirectories.flatMap((directory) => ['--dll-dir', directory]),
      '--model-id',
      options.modelId,
      '--output-name',
      options.outputName,
    ]
    this.child = spawn(workerPath, workerArguments, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.startupTimer = setTimeout(
      () => {
        this.fail(new Error('CUDA worker startup timed out'))
      },
      Math.max(1_000, options.startupTimeoutMs || 120_000),
    )
    this.child.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => options.onStderr?.(chunk.trim()))
    this.child.stdin.on('error', (error) => this.fail(error))
    this.child.on('error', (error) => this.fail(error))
    this.child.on('exit', (code, signal) => {
      if (!this.closed) {
        this.fail(
          new Error(`CUDA worker exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`),
        )
      }
    })
  }

  async infer(tensors: readonly CudaTensorInput[]): Promise<CudaTensorOutput> {
    await this.hello
    if (this.closed) throw new Error('CUDA worker is closed')
    const requestId = this.nextRequestId++
    const payload = encodeInferencePayload(tensors)
    return new Promise<CudaTensorOutput>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('CUDA inference timed out'))
      }, this.inferenceTimeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      this.child.stdin.write(encodeMessage(MESSAGE.infer, requestId, payload), (error) => {
        if (!error) return
        const pending = this.pending.get(requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(requestId)
        pending.reject(error)
      })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.startupTimer)
    try {
      if (this.child.stdin.writable) this.child.stdin.write(encodeMessage(MESSAGE.shutdown, 0))
    } catch {
      // The process is already unavailable.
    }
    const timer = setTimeout(() => this.child.kill(), 1_000)
    timer.unref()
    this.rejectPending(new Error('CUDA worker closed'))
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])
    while (this.stdoutBuffer.length >= HEADER_BYTES) {
      const magic = this.stdoutBuffer.readUInt32LE(0)
      const version = this.stdoutBuffer.readUInt16LE(4)
      const type = this.stdoutBuffer.readUInt16LE(6)
      const requestId = this.stdoutBuffer.readUInt32LE(8)
      const payloadBytes = this.stdoutBuffer.readUInt32LE(12)
      if (magic !== MAGIC || version !== PROTOCOL_VERSION || payloadBytes > MAX_PAYLOAD_BYTES) {
        this.fail(new Error('CUDA worker returned an invalid message header'))
        return
      }
      if (this.stdoutBuffer.length < HEADER_BYTES + payloadBytes) return
      const payload = this.stdoutBuffer.subarray(HEADER_BYTES, HEADER_BYTES + payloadBytes)
      this.stdoutBuffer = this.stdoutBuffer.subarray(HEADER_BYTES + payloadBytes)
      try {
        this.handleMessage(type, requestId, payload)
      } catch (error) {
        this.fail(new Error(`CUDA worker response failed validation: ${errorMessage(error)}`))
        return
      }
    }
  }

  private handleMessage(type: number, requestId: number, payload: Buffer): void {
    if (type === MESSAGE.hello) {
      const hello = JSON.parse(payload.toString('utf8')) as CudaWorkerHello
      if (
        hello.protocolVersion !== PROTOCOL_VERSION ||
        hello.provider !== 'cuda' ||
        !hello.availableProviders?.includes('CUDAExecutionProvider')
      ) {
        throw new Error('CUDA worker handshake did not confirm CUDAExecutionProvider')
      }
      clearTimeout(this.startupTimer)
      this.resolveHello(hello)
      return
    }
    const pending = this.pending.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    if (type === MESSAGE.result) {
      pending.resolve(decodeFloatOutput(payload))
      return
    }
    if (type === MESSAGE.error) {
      const parsed = JSON.parse(payload.toString('utf8')) as { error?: unknown }
      pending.reject(
        new Error(typeof parsed.error === 'string' ? parsed.error : 'CUDA worker error'),
      )
      return
    }
    pending.reject(new Error(`unexpected CUDA worker message type ${type}`))
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.startupTimer)
    this.rejectHello(error)
    this.rejectPending(error)
    try {
      this.child.kill()
    } catch {
      // The process is already unavailable.
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export const cudaEmbeddingProtocol = {
  magic: MAGIC,
  version: PROTOCOL_VERSION,
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
} as const
