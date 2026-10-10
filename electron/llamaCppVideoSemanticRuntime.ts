import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import type { VideoSemanticRuntimeStatus } from '../shared/videoSemantic'
import type { VideoSemanticRuntime, VideoSemanticRuntimeRequest } from './videoSemanticRuntime'

const MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BASE64_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_IMAGE_BASE64_BYTES = 32 * 1024 * 1024
const MAX_COMPATIBILITY_OUTPUT_CHARS = 64 * 1024
const BASE64_PATTERN = /^[a-z0-9+/]+={0,2}$/i
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,159}$/i

export const LLAMA_CPP_VIDEO_SEMANTIC_CONTEXT_TOKENS = 4_096
export const LLAMA_CPP_VIDEO_SEMANTIC_GPU_LAYERS = 20

const VIDEO_SEMANTIC_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    scenes: { type: 'array', maxItems: 4, items: { type: 'string' } },
    events: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
          startMs: { type: 'integer' },
          endMs: { type: 'integer' },
          confidence: { type: 'number' },
        },
        required: ['label', 'description', 'startMs', 'endMs', 'confidence'],
      },
    },
    persons: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          localId: { type: 'string' },
          description: { type: 'string' },
          actions: { type: 'array', maxItems: 4, items: { type: 'string' } },
          confidence: { type: 'number' },
        },
        required: ['localId', 'description', 'actions', 'confidence'],
      },
    },
    objects: { type: 'array', maxItems: 8, items: { type: 'string' } },
    searchTags: { type: 'array', maxItems: 8, items: { type: 'string' } },
    visualText: { type: 'array', maxItems: 8, items: { type: 'string' } },
    audioEvents: { type: 'array', maxItems: 4, items: { type: 'string' } },
    language: { type: 'string' },
    warnings: { type: 'array', maxItems: 8, items: { type: 'string' } },
  },
  required: [
    'summary',
    'scenes',
    'events',
    'persons',
    'objects',
    'searchTags',
    'visualText',
    'audioEvents',
    'warnings',
  ],
} as const

interface FetchResponseLike {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type LlamaCppVideoSemanticFetch = (
  input: string,
  init: RequestInit,
) => Promise<FetchResponseLike>

export type LlamaCppSpawn = (
  executable: string,
  args: readonly string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    shell: false
    windowsHide: true
    stdio: ['ignore', 'ignore', 'ignore']
  },
) => ChildProcess

export interface LlamaCppVideoSemanticRuntimeOptions {
  serverExecutablePath: string
  modelPath: string
  mmprojPath: string
  expectedServerSha256: string
  expectedModelSha256: string
  expectedMmprojSha256: string
  modelId: string
  modelRevision: string
  quantization: string
  port?: number
  contextTokens?: number
  gpuLayers?: number
  startupTimeoutMs?: number
  inspectTimeoutMs?: number
  fetch?: LlamaCppVideoSemanticFetch
  spawn?: LlamaCppSpawn
  hashFile?: (filePath: string) => Promise<string>
  fileExists?: (filePath: string) => Promise<boolean>
  apiKey?: string
}

class LlamaCppResourceError extends Error {
  constructor(
    readonly state: 'not-installed' | 'error',
    message: string,
  ) {
    super(message)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function safeAbsoluteFile(value: string, label: string, extension: string): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.extname(value).toLowerCase() !== extension
  ) {
    throw new Error(`${label} must be an absolute ${extension} file path`)
  }
  return path.normalize(value)
}

function safeDigest(value: string, label: string): string {
  const normalized = String(value).trim().toLowerCase()
  if (!DIGEST_PATTERN.test(normalized)) throw new Error(`${label} must be a SHA-256 digest`)
  return normalized
}

function safeInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return resolved
}

function safeTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1_000, Math.min(180_000, Math.floor(value!)))
}

function safeText(value: string, label: string, pattern = MODEL_ID_PATTERN): string {
  const normalized = String(value).trim()
  if (!pattern.test(normalized)) throw new Error(`Invalid llama.cpp ${label}`)
  return normalized
}

async function defaultHashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function defaultFileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function extractTrailingJsonObject(value: string): string | null {
  let terminal = value.trim()
  if (!terminal || terminal.length > MAX_COMPATIBILITY_OUTPUT_CHARS) return null
  if (terminal.endsWith('```')) terminal = terminal.slice(0, -3).trimEnd()
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < terminal.length; index += 1) {
    const character = terminal[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (character !== '}' || depth === 0) continue
    depth -= 1
    if (depth !== 0 || start < 0 || terminal.slice(index + 1).trim()) continue
    const candidate = terminal.slice(start, index + 1)
    try {
      if (isObject(JSON.parse(candidate))) return candidate
    } catch {
      // Continue looking if a preceding non-JSON brace sequence reached depth zero.
    }
  }
  return null
}

function imageContent(request: VideoSemanticRuntimeRequest): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [
    { type: 'text', text: request.prompt.messages[1].content },
  ]
  let totalBytes = 0
  for (const image of request.images) {
    const data = image.dataBase64 ?? ''
    if (!data || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
      throw new Error('llama.cpp runtime requires valid in-memory image evidence')
    }
    if (data.length > MAX_IMAGE_BASE64_BYTES) {
      throw new Error('llama.cpp image payload exceeds per-image limit')
    }
    totalBytes += data.length
    if (totalBytes > MAX_TOTAL_IMAGE_BASE64_BYTES) {
      throw new Error('llama.cpp image payload exceeds total limit')
    }
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType ?? 'image/jpeg'};base64,${data}` },
    })
  }
  return parts
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function sidecarEnvironment(apiKey: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('LLAMA_')) environment[name] = value
  }
  return {
    ...environment,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    LLAMA_API_KEY: apiKey,
  }
}

export class LlamaCppVideoSemanticRuntime implements VideoSemanticRuntime {
  readonly adapterId = 'llama-cpp-managed'
  private readonly executablePath: string
  private readonly modelPath: string
  private readonly mmprojPath: string
  private readonly expectedServerSha256: string
  private readonly expectedModelSha256: string
  private readonly expectedMmprojSha256: string
  private readonly modelId: string
  private readonly modelRevision: string
  private readonly quantization: string
  private readonly port: number
  private readonly contextTokens: number
  private readonly gpuLayers: number
  private readonly startupTimeoutMs: number
  private readonly inspectTimeoutMs: number
  private readonly requestFetch: LlamaCppVideoSemanticFetch
  private readonly spawnProcess: LlamaCppSpawn
  private readonly hashFile: (filePath: string) => Promise<string>
  private readonly fileExists: (filePath: string) => Promise<boolean>
  private readonly apiKey: string
  private child: ChildProcess | null = null
  private startPromise: Promise<void> | null = null
  private resourcesVerified = false

  constructor(options: LlamaCppVideoSemanticRuntimeOptions) {
    this.executablePath = safeAbsoluteFile(
      options.serverExecutablePath,
      'server executable',
      '.exe',
    )
    this.modelPath = safeAbsoluteFile(options.modelPath, 'model', '.gguf')
    this.mmprojPath = safeAbsoluteFile(options.mmprojPath, 'multimodal projector', '.gguf')
    this.expectedServerSha256 = safeDigest(options.expectedServerSha256, 'server digest')
    this.expectedModelSha256 = safeDigest(options.expectedModelSha256, 'model digest')
    this.expectedMmprojSha256 = safeDigest(options.expectedMmprojSha256, 'projector digest')
    this.modelId = safeText(options.modelId, 'model id')
    this.modelRevision = safeText(options.modelRevision, 'model revision', /^[a-f0-9]{7,64}$/i)
    this.quantization = safeText(options.quantization, 'quantization', /^[a-z0-9_]{2,32}$/i)
    this.port = safeInteger(options.port, 49_173, 1_024, 65_535, 'llama.cpp port')
    this.contextTokens = safeInteger(
      options.contextTokens,
      LLAMA_CPP_VIDEO_SEMANTIC_CONTEXT_TOKENS,
      4_096,
      16_384,
      'llama.cpp context tokens',
    )
    this.gpuLayers = safeInteger(
      options.gpuLayers,
      LLAMA_CPP_VIDEO_SEMANTIC_GPU_LAYERS,
      0,
      1_024,
      'llama.cpp GPU layers',
    )
    this.startupTimeoutMs = safeTimeout(options.startupTimeoutMs, 120_000)
    this.inspectTimeoutMs = safeTimeout(options.inspectTimeoutMs, 3_000)
    this.requestFetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.spawnProcess = options.spawn ?? (nodeSpawn as LlamaCppSpawn)
    this.hashFile = options.hashFile ?? defaultHashFile
    this.fileExists = options.fileExists ?? defaultFileExists
    this.apiKey = options.apiKey ?? randomBytes(32).toString('hex')
    if (!/^[a-z0-9]{32,128}$/i.test(this.apiKey)) throw new Error('Invalid llama.cpp API key')
  }

  private async verifyResources(): Promise<void> {
    if (this.resourcesVerified) return
    const resources = [
      [this.executablePath, this.expectedServerSha256, 'server'],
      [this.modelPath, this.expectedModelSha256, 'model'],
      [this.mmprojPath, this.expectedMmprojSha256, 'projector'],
    ] as const
    for (const [filePath, expected, label] of resources) {
      if (!(await this.fileExists(filePath))) {
        throw new LlamaCppResourceError('not-installed', `${label}-missing`)
      }
      let actual: string
      try {
        actual = (await this.hashFile(filePath)).toLowerCase()
      } catch {
        throw new LlamaCppResourceError('error', `${label}-unreadable`)
      }
      if (actual !== expected) throw new LlamaCppResourceError('error', `${label}-digest-mismatch`)
    }
    this.resourcesVerified = true
  }

  private request(
    pathname: '/v1/models' | '/v1/chat/completions',
    init: RequestInit,
    timeoutMs: number,
  ) {
    return this.requestJson(pathname, init, timeoutMs)
  }

  private async requestJson(
    pathname: '/v1/models' | '/v1/chat/completions',
    init: RequestInit,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController()
    const externalSignal = init.signal
    const timeout = setTimeout(
      () => controller.abort(new Error('llama.cpp request timed out')),
      safeTimeout(timeoutMs, this.inspectTimeoutMs),
    )
    const abort = () => controller.abort(externalSignal?.reason)
    externalSignal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await this.requestFetch(`http://127.0.0.1:${this.port}${pathname}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(init.headers ?? {}),
        },
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`llama.cpp HTTP ${response.status}`)
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_HTTP_RESPONSE_BYTES) {
        throw new Error('llama.cpp response exceeds byte limit')
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new Error('llama.cpp returned invalid JSON')
      }
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', abort)
    }
  }

  private modelIsReady(payload: unknown): boolean {
    return (
      isObject(payload) &&
      Array.isArray(payload.data) &&
      payload.data.some((entry) => isObject(entry) && entry.id === this.modelId)
    )
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !childExited(this.child)) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startServer()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async startServer(): Promise<void> {
    await this.verifyResources()
    const args = [
      '--model',
      this.modelPath,
      '--mmproj',
      this.mmprojPath,
      '--no-mmproj-auto',
      '--host',
      '127.0.0.1',
      '--port',
      String(this.port),
      '--alias',
      this.modelId,
      '--ctx-size',
      String(this.contextTokens),
      '--n-gpu-layers',
      String(this.gpuLayers),
      '--parallel',
      '1',
      '--no-ui',
      '--reasoning',
      'off',
      '--jinja',
    ]
    const child = this.spawnProcess(this.executablePath, args, {
      cwd: path.dirname(this.executablePath),
      env: sidecarEnvironment(this.apiKey),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    this.child = child
    let spawnError: Error | null = null
    child.once('error', (error) => {
      spawnError = error
      if (this.child === child) this.child = null
    })
    const deadline = Date.now() + this.startupTimeoutMs
    while (Date.now() < deadline) {
      if (spawnError) throw new Error('llama.cpp server could not be started')
      if (childExited(child)) {
        this.child = null
        throw new Error('llama.cpp server exited during startup')
      }
      try {
        const payload = await this.request('/v1/models', { method: 'GET' }, 1_000)
        if (this.modelIsReady(payload)) return
      } catch {
        // Loading can take tens of seconds; retry until the bounded deadline.
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    child.kill()
    this.child = null
    throw new Error('llama.cpp server startup timed out')
  }

  async inspect(): Promise<VideoSemanticRuntimeStatus> {
    try {
      await this.ensureStarted()
      const payload = await this.request('/v1/models', { method: 'GET' }, this.inspectTimeoutMs)
      if (!this.modelIsReady(payload)) {
        return { adapterId: this.adapterId, state: 'error', reason: 'model-identity-mismatch' }
      }
      return {
        adapterId: this.adapterId,
        state: 'ready',
        model: {
          modelId: this.modelId,
          modelRevision: this.modelRevision,
          quantization: this.quantization,
        },
      }
    } catch (error) {
      if (error instanceof LlamaCppResourceError) {
        return { adapterId: this.adapterId, state: error.state, reason: error.message }
      }
      return {
        adapterId: this.adapterId,
        state: 'unavailable',
        reason: error instanceof Error ? error.message.slice(0, 300) : 'runtime-unavailable',
      }
    }
  }

  async generate(request: VideoSemanticRuntimeRequest, signal?: AbortSignal): Promise<string> {
    await this.ensureStarted()
    const contextTokens = safeInteger(
      request.contextTokens,
      this.contextTokens,
      4_096,
      16_384,
      'llama.cpp context tokens',
    )
    const payload = await this.request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: this.modelId,
          messages: [
            { role: 'system', content: request.prompt.messages[0].content },
            { role: 'user', content: imageContent(request) },
          ],
          stream: false,
          temperature: 0,
          max_tokens: safeInteger(
            request.maximumOutputTokens,
            512,
            1,
            1_024,
            'llama.cpp maximum output tokens',
          ),
          response_format: { type: 'json_object', schema: VIDEO_SEMANTIC_OUTPUT_SCHEMA },
          chat_template_kwargs: { enable_thinking: false },
          n_ctx: contextTokens,
        }),
      },
      request.timeoutMs,
    )
    if (!isObject(payload) || !Array.isArray(payload.choices) || !isObject(payload.choices[0])) {
      throw new Error('llama.cpp chat response is invalid')
    }
    const finishReason = payload.choices[0].finish_reason
    if (finishReason === 'length' || finishReason === 'max_tokens') {
      throw new Error('llama.cpp output truncated at token limit')
    }
    const message = isObject(payload.choices[0].message) ? payload.choices[0].message : {}
    const content = typeof message.content === 'string' ? message.content.trim() : ''
    if (content) return extractTrailingJsonObject(content) ?? content
    const reasoning =
      typeof message.reasoning_content === 'string' ? message.reasoning_content.trim() : ''
    const compatibilityOutput = extractTrailingJsonObject(reasoning)
    if (compatibilityOutput) return compatibilityOutput
    throw new Error('llama.cpp chat response did not contain a JSON object')
  }

  async dispose(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child || childExited(child)) return
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!childExited(child)) child.kill()
        resolve()
      }, 3_000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      child.kill()
    })
  }
}
