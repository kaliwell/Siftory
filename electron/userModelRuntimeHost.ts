// ── User Model Runtime Host ────────────────────────────────
// Owns the disposable child process (electron/userModelRuntimeChild.ts) that
// loads and executes unvetted user-supplied ONNX models. Guarantees for the
// main process:
//   - resource limits: the child runs with a bounded V8 heap and every model
//     file is size-checked before the runtime touches it
//   - per-request timeout: a hung runtime is killed and reported as an error
//   - crash recovery: a child that exits or floods its output fails only the
//     active request; the next request spawns a fresh child
//   - stale exit events from an already replaced child are ignored (SMP-009)
//   - response tensors are structurally re-validated on decode, so a corrupt
//     payload can never hand main a malformed Float32Array

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { UserModelInspection, UserModelProfileDefinition } from '../shared/userModelPlatform'
import {
  BoundedEmbeddingChildLineFramer,
  MAX_USER_MODEL_RUNTIME_LINE_BYTES,
  packedSamMaskByteLength,
} from './embeddingChildLineFraming'
import {
  boundedBinarySlice,
  encodeUserModelBinaryFrame,
  USER_MODEL_RUNTIME_SESSION_BUDGET_BYTES,
  UserModelBinaryFrameDecoder,
} from './userModelBinaryProtocol'

const USER_MODEL_RUNTIME_TIMEOUT_MS = 120_000
const USER_MODEL_RUNTIME_MAX_OLD_SPACE_MB = 512
const MAX_RESPONSE_TENSOR_DIMS = 8
const MAX_RESPONSE_TENSOR_ELEMENTS = 64 * 1024 * 1024
const USER_MODEL_STDERR_LIMIT = 4_096
const USER_MODEL_EMBEDDED_PATH_PATTERN =
  /(?:[a-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:users|home|root|tmp|var|etc|mnt|volumes)\/)[^\r\n"']*/gi

/** Keep child diagnostics useful without emitting user/model/temp paths. */
export function sanitizeUserModelRuntimeStderr(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replaceAll('\u0000', '')
    .slice(0, USER_MODEL_STDERR_LIMIT)
    .replace(USER_MODEL_EMBEDDED_PATH_PATTERN, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface UserModelSessionTensorMetadata {
  name: string
  type: string
  isTensor: boolean
  shape: Array<number | string>
}

export interface UserModelChildSessionInfo {
  inputNames: string[]
  outputNames: string[]
  inputMetadata: UserModelSessionTensorMetadata[]
  outputMetadata: UserModelSessionTensorMetadata[]
}

export interface UserModelRunFeed {
  name: string
  dims: number[]
  data: Float32Array
}

export interface UserModelRunOutput {
  name: string
  dims: number[]
  data: Float32Array
}

export interface UserModelSamMaskOutput {
  width: number
  height: number
  iou: number
  maskBits: Uint8Array
}

interface PendingRequest {
  id: number
  resolve: (message: Record<string, unknown>) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

let child: ChildProcessWithoutNullStreams | null = null
let pending: PendingRequest | null = null
let nextRequestId = 1
let tail: Promise<unknown> = Promise.resolve()
let idleTimer: ReturnType<typeof setTimeout> | null = null
const RUNTIME_CHILD_IDLE_TIMEOUT_MS = 5 * 60 * 1000
let childScriptOverride: string | null = null
let timeoutOverrideMs: number | null = null
let maxOldSpaceOverrideMb: number | null = null
let idleTimeoutOverrideMs: number | null = null
let pressureReleasePending = false
let lastRuntimeMemory = {
  sessionCount: 0,
  ownedBytesApprox: 0,
  budgetBytes: USER_MODEL_RUNTIME_SESSION_BUDGET_BYTES,
}
const binaryProtocolChildren = new WeakSet<ChildProcessWithoutNullStreams>()
const RESPONSE_BINARY_BODY = Symbol('user-model-runtime-response-body')

function runtimeChildPath(): string {
  if (childScriptOverride) return childScriptOverride
  const candidates = [
    path.join(__dirname, 'userModelRuntimeChild.js'),
    path.join(__dirname, '..', 'dist-electron', 'userModelRuntimeChild.js'),
    path.join(process.resourcesPath || '', 'userModelRuntimeChild.js'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

/** Test hook: point the host at fixture children and shorten the timeout. */
export function setUserModelRuntimeChildOptionsForTests(options?: {
  scriptPath?: string
  timeoutMs?: number
  maxOldSpaceMb?: number
  idleTimeoutMs?: number
}): void {
  childScriptOverride = options?.scriptPath ?? null
  timeoutOverrideMs = options?.timeoutMs ?? null
  maxOldSpaceOverrideMb = options?.maxOldSpaceMb ?? null
  idleTimeoutOverrideMs = options?.idleTimeoutMs ?? null
}

function clearIdleTimer(): void {
  if (!idleTimer) return
  clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleDispose(): void {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (!pending && child) {
      failActive(child, new Error('User model runtime idle timeout'))
    }
  }, idleTimeoutOverrideMs ?? RUNTIME_CHILD_IDLE_TIMEOUT_MS)
  idleTimer.unref()
}

function failActive(failedChild: ChildProcessWithoutNullStreams, error: Error): void {
  // Ignore events from a child that already left the active slot (SMP-009).
  if (child !== failedChild) return
  child = null
  clearIdleTimer()
  pressureReleasePending = false
  lastRuntimeMemory = {
    sessionCount: 0,
    ownedBytesApprox: 0,
    budgetBytes: USER_MODEL_RUNTIME_SESSION_BUDGET_BYTES,
  }
  const current = pending
  pending = null
  if (current) {
    clearTimeout(current.timeout)
    current.reject(error)
  }
  try {
    failedChild.kill()
  } catch {
    /* The failed child may already have exited. */
  }
}

function spawnRuntimeChild(): ChildProcessWithoutNullStreams {
  const scriptPath = runtimeChildPath()
  const nodePath = [
    process.env.NODE_PATH,
    path.join(process.resourcesPath || '', 'app.asar', 'node_modules'),
    path.join(process.resourcesPath || '', 'app', 'node_modules'),
    path.join(__dirname, '..', 'node_modules'),
  ]
    .filter(Boolean)
    .join(path.delimiter)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: nodePath }
  const maxOldSpace = maxOldSpaceOverrideMb ?? USER_MODEL_RUNTIME_MAX_OLD_SPACE_MB
  const spawned = spawn(process.execPath, [`--max-old-space-size=${maxOldSpace}`, scriptPath], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child = spawned
  const usesBinaryProtocol = path.basename(scriptPath).toLowerCase() === 'usermodelruntimechild.js'
  if (usesBinaryProtocol) binaryProtocolChildren.add(spawned)
  // A warm idle child must never keep the parent event loop alive.
  spawned.unref()
  for (const stream of [spawned.stdin, spawned.stdout, spawned.stderr]) {
    ;(stream as unknown as { unref?: () => void }).unref?.()
  }
  spawned.stderr.setEncoding('utf8')
  if (usesBinaryProtocol) {
    const stdoutFramer = new UserModelBinaryFrameDecoder()
    spawned.stdout.on('data', (chunk: Buffer) => {
      const frame = stdoutFramer.push(chunk)
      if (frame.overflow) {
        failActive(spawned, new Error('User model runtime output binary frame exceeded its limit'))
        return
      }
      for (const response of frame.frames) {
        handleChildMessage(spawned, response.header, response.body)
      }
    })
  } else {
    spawned.stdout.setEncoding('utf8')
    const stdoutFramer = new BoundedEmbeddingChildLineFramer(MAX_USER_MODEL_RUNTIME_LINE_BYTES)
    spawned.stdout.on('data', (chunk: string) => {
      const frame = stdoutFramer.push(chunk)
      if (frame.overflow) {
        failActive(
          spawned,
          new Error(
            `User model runtime output line exceeded ${MAX_USER_MODEL_RUNTIME_LINE_BYTES} bytes`,
          ),
        )
        return
      }
      for (const framedLine of frame.lines) {
        const line = framedLine.trim()
        if (line) handleChildLine(spawned, line)
      }
    })
  }
  spawned.stderr.on('data', (chunk: string) => {
    const diagnostic = sanitizeUserModelRuntimeStderr(chunk)
    if (diagnostic) console.warn('[userModelRuntimeChild]', diagnostic)
  })
  spawned.stdin.on('error', (error) => {
    failActive(spawned, new Error(`User model runtime stdin error: ${error.message}`))
  })
  spawned.on('error', (error) => {
    failActive(spawned, new Error(`User model runtime process error: ${error.message}`))
  })
  spawned.on('exit', (code, signal) => {
    failActive(
      spawned,
      new Error(`User model runtime exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`),
    )
  })
  return spawned
}

function handleChildLine(source: ChildProcessWithoutNullStreams, line: string): void {
  if (source !== child) return
  let message: { id?: unknown }
  try {
    message = JSON.parse(line) as typeof message
  } catch {
    return
  }
  handleChildMessage(source, message as Record<string, unknown>, Buffer.alloc(0))
}

function handleChildMessage(
  source: ChildProcessWithoutNullStreams,
  message: Record<string, unknown>,
  body: Buffer,
): void {
  if (source !== child) return
  const current = pending
  if (!current || message.id !== current.id) return
  const runtimeMemory = (message as { runtimeMemory?: unknown }).runtimeMemory
  if (runtimeMemory && typeof runtimeMemory === 'object' && !Array.isArray(runtimeMemory)) {
    const candidate = runtimeMemory as Record<string, unknown>
    if (
      Number.isSafeInteger(candidate.sessionCount) &&
      (candidate.sessionCount as number) >= 0 &&
      Number.isSafeInteger(candidate.ownedBytesApprox) &&
      (candidate.ownedBytesApprox as number) >= 0 &&
      candidate.budgetBytes === USER_MODEL_RUNTIME_SESSION_BUDGET_BYTES
    ) {
      lastRuntimeMemory = {
        sessionCount: candidate.sessionCount as number,
        ownedBytesApprox: candidate.ownedBytesApprox as number,
        budgetBytes: USER_MODEL_RUNTIME_SESSION_BUDGET_BYTES,
      }
    }
  }
  pending = null
  clearTimeout(current.timeout)
  Object.defineProperty(message, RESPONSE_BINARY_BODY, { value: body })
  current.resolve(message as Record<string, unknown>)
  if (pressureReleasePending) {
    failActive(source, new Error('User model runtime released after active request'))
  } else {
    scheduleIdleDispose()
  }
}

function encodeBinaryRequest(id: number, payload: Record<string, unknown>): Buffer {
  const feeds = Array.isArray(payload.feeds)
    ? (payload.feeds as readonly UserModelRunFeed[])
    : undefined
  if (!feeds) return encodeUserModelBinaryFrame({ id, ...payload })
  let offset = 0
  const descriptors = feeds.map((feed) => {
    const descriptor = {
      name: feed.name,
      dims: feed.dims,
      dataOffset: offset,
      dataBytes: feed.data.byteLength,
    }
    offset += feed.data.byteLength
    return descriptor
  })
  return encodeUserModelBinaryFrame(
    { id, ...payload, feeds: descriptors },
    feeds.map((feed) => feed.data),
  )
}

function encodeLegacyRequest(id: number, payload: Record<string, unknown>): string {
  const feeds = Array.isArray(payload.feeds)
    ? encodeFeeds(payload.feeds as readonly UserModelRunFeed[])
    : undefined
  return `${JSON.stringify({ id, ...payload, ...(feeds ? { feeds } : {}) })}\n`
}

function performRequest(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    clearIdleTimer()
    const active = child ?? spawnRuntimeChild()
    const timeout = setTimeout(
      () => failActive(active, new Error('User model runtime request timed out')),
      timeoutOverrideMs ?? USER_MODEL_RUNTIME_TIMEOUT_MS,
    )
    pending = { id: nextRequestId++, resolve, reject, timeout }
    let request: Buffer | string
    try {
      request = binaryProtocolChildren.has(active)
        ? encodeBinaryRequest(pending.id, payload)
        : encodeLegacyRequest(pending.id, payload)
    } catch (error) {
      clearTimeout(timeout)
      pending = null
      scheduleIdleDispose()
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    active.stdin.write(request, (error) => {
      if (error) {
        failActive(active, new Error(`User model runtime write failed: ${error.message}`))
      }
    })
  })
}

function enqueue<T>(payload: Record<string, unknown>): Promise<T> {
  const run = tail.then(() => performRequest(payload) as Promise<T>)
  tail = run.catch(() => {})
  return run
}

function unwrapError(message: Record<string, unknown>): Error {
  return new Error(
    typeof message.error === 'string' && message.error
      ? message.error
      : 'User model runtime request failed',
  )
}

function encodeFeedData(data: Float32Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
}

function encodeFeeds(feeds: readonly UserModelRunFeed[]): Array<Record<string, unknown>> {
  return feeds.map((feed) => ({
    name: feed.name,
    dims: feed.dims,
    dataB64: encodeFeedData(feed.data),
  }))
}

function decodeResponseTensor(raw: unknown, body: Buffer): UserModelRunOutput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('User model runtime returned an invalid output tensor')
  }
  const { name, dims, dataB64, dataOffset, dataBytes } = raw as {
    name?: unknown
    dims?: unknown
    dataB64?: unknown
    dataOffset?: unknown
    dataBytes?: unknown
  }
  if (typeof name !== 'string' || !name || name.length > 256) {
    throw new Error('User model runtime returned an invalid tensor name')
  }
  if (
    !Array.isArray(dims) ||
    dims.length === 0 ||
    dims.length > MAX_RESPONSE_TENSOR_DIMS ||
    dims.some((dimension) => !Number.isSafeInteger(dimension) || dimension <= 0)
  ) {
    throw new Error('User model runtime returned an invalid tensor shape')
  }
  const elements = (dims as number[]).reduce((count, dimension) => count * dimension, 1)
  if (elements > MAX_RESPONSE_TENSOR_ELEMENTS) {
    throw new Error('User model runtime returned an oversized tensor')
  }
  if (typeof dataB64 !== 'string' && body.length === 0) {
    throw new Error('User model runtime returned an invalid tensor payload')
  }
  const bytes =
    typeof dataB64 === 'string'
      ? Buffer.from(dataB64, 'base64')
      : boundedBinarySlice(body, dataOffset, dataBytes)
  if (bytes.length !== elements * 4) {
    throw new Error('User model runtime tensor payload does not match its declared shape')
  }
  return {
    name,
    dims: dims as number[],
    data:
      bytes.byteOffset % 4 === 0
        ? new Float32Array(bytes.buffer, bytes.byteOffset, elements)
        : new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)),
  }
}

function decodeSamMask(raw: unknown, body: Buffer): UserModelSamMaskOutput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('User model runtime returned an invalid SAM mask')
  }
  const { width, height, iou, maskBitsB64, dataOffset, dataBytes } = raw as {
    width?: unknown
    height?: unknown
    iou?: unknown
    maskBitsB64?: unknown
    dataOffset?: unknown
    dataBytes?: unknown
  }
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    typeof iou !== 'number' ||
    !Number.isFinite(iou) ||
    (typeof maskBitsB64 !== 'string' && body.length === 0)
  ) {
    throw new Error('User model runtime returned invalid SAM mask metadata')
  }
  const expectedBytes = packedSamMaskByteLength(width, height)
  const bytes = (() => {
    if (typeof maskBitsB64 !== 'string') {
      return boundedBinarySlice(body, dataOffset, dataBytes)
    }
    const expectedBase64Length = Math.ceil(expectedBytes / 3) * 4
    if (
      maskBitsB64.length !== expectedBase64Length ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(maskBitsB64)
    ) {
      throw new Error('User model runtime returned an invalid SAM mask payload')
    }
    return Buffer.from(maskBitsB64, 'base64')
  })()
  if (bytes.length !== expectedBytes) {
    throw new Error('User model runtime SAM mask payload does not match its declared shape')
  }
  return {
    width,
    height,
    iou,
    maskBits: new Uint8Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ),
  }
}

/**
 * Run the unvetted-ONNX import inspection inside the isolated child process.
 * Requests are serialized: one request per child at a time.
 */
export async function inspectUserModelInIsolation(
  modelPath: string,
  profile: UserModelProfileDefinition,
  maxBytes: number,
): Promise<UserModelInspection> {
  const message = await enqueue<Record<string, unknown>>({
    op: 'inspect',
    modelPath,
    profile,
    maxBytes,
  })
  if (message.ok !== true || !message.inspection) throw unwrapError(message)
  return message.inspection as UserModelInspection
}

/** Load (or reuse) a session in the child and return its tensor metadata. */
export async function loadUserModelSessionInIsolation(
  modelPath: string,
  maxBytes: number,
): Promise<UserModelChildSessionInfo> {
  const message = await enqueue<Record<string, unknown>>({ op: 'load', modelPath, maxBytes })
  if (message.ok !== true || !message.session) throw unwrapError(message)
  return message.session as UserModelChildSessionInfo
}

/** Execute one bounded inference in the child and return raw output tensors. */
export async function runUserModelInIsolation(
  modelPath: string,
  maxBytes: number,
  feeds: readonly UserModelRunFeed[],
): Promise<UserModelRunOutput[]> {
  const message = await enqueue<Record<string, unknown>>({
    op: 'run',
    modelPath,
    maxBytes,
    feeds,
  })
  if (message.ok !== true || !Array.isArray(message.outputs)) throw unwrapError(message)
  const body = (message as Record<PropertyKey, unknown>)[RESPONSE_BINARY_BODY]
  const binaryBody = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
  return (message.outputs as unknown[]).map((output) => decodeResponseTensor(output, binaryBody))
}

/**
 * Execute a SAM decoder and return only its winning > 0 mask, bit-packed in
 * the isolated child so original-size multi-mask tensors never cross IPC.
 */
export async function runSamDecoderInIsolation(
  modelPath: string,
  maxBytes: number,
  feeds: readonly UserModelRunFeed[],
  masksOutputName: string,
  iouOutputName: string,
): Promise<UserModelSamMaskOutput> {
  const message = await enqueue<Record<string, unknown>>({
    op: 'run-sam-decoder',
    modelPath,
    maxBytes,
    feeds,
    masksOutputName,
    iouOutputName,
  })
  if (message.ok !== true || !message.mask) throw unwrapError(message)
  const body = (message as Record<PropertyKey, unknown>)[RESPONSE_BINARY_BODY]
  return decodeSamMask(message.mask, Buffer.isBuffer(body) ? body : Buffer.alloc(0))
}

export function disposeUserModelRuntimeChild(): void {
  const current = child
  if (current) failActive(current, new Error('User model runtime disposed'))
}

export function getUserModelRuntimeMemorySnapshot(): {
  childResident: boolean
  activeRequest: boolean
  sessionCount: number
  ownedBytesApprox: number
  budgetBytes: number
} {
  return {
    childResident: child !== null,
    activeRequest: pending !== null,
    ...lastRuntimeMemory,
  }
}

export function requestUserModelRuntimeMemoryPressureRelease(): {
  status: 'released' | 'deferred' | 'empty'
  activeRequest: boolean
} {
  const current = child
  if (!current) return { status: 'empty', activeRequest: false }
  if (pending) {
    pressureReleasePending = true
    clearIdleTimer()
    return { status: 'deferred', activeRequest: true }
  }
  failActive(current, new Error('User model runtime released for memory pressure'))
  return { status: 'released', activeRequest: false }
}
