import type { VideoSemanticRuntimeStatus } from '../shared/videoSemantic'
import type { VideoSemanticRuntime, VideoSemanticRuntimeRequest } from './videoSemanticRuntime'

const MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BASE64_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_IMAGE_BASE64_BYTES = 32 * 1024 * 1024
const MAX_COMPATIBILITY_OUTPUT_CHARS = 64 * 1024
const MAX_COMPATIBILITY_OBJECT_CANDIDATES = 64
const MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,159}$/i
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i
const BASE64_PATTERN = /^[a-z0-9+/]+={0,2}$/i
const MAX_CONTEXT_TOKENS = 16_384
const CONTEXT_TOKEN_TIERS = [8_192, 12_288, MAX_CONTEXT_TOKENS] as const
const PROMPT_BYTES_PER_ESTIMATED_TOKEN = 3
const CHAT_TEMPLATE_TOKEN_RESERVE = 512
const IMAGE_TOKEN_ESTIMATE = 768
const COMPLETION_TOKEN_MARGIN = 256

export const OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_CONTEXT_TOKENS = 8_192
export const OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_GPU_LAYERS = 20

const VIDEO_SEMANTIC_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    scenes: { type: 'array', items: { type: 'string' } },
    events: {
      type: 'array',
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
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          localId: { type: 'string' },
          description: { type: 'string' },
          actions: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
        },
        required: ['localId', 'description', 'actions', 'confidence'],
      },
    },
    objects: { type: 'array', items: { type: 'string' } },
    searchTags: { type: 'array', items: { type: 'string' } },
    visualText: { type: 'array', items: { type: 'string' } },
    audioEvents: { type: 'array', items: { type: 'string' } },
    language: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
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

const OUTPUT_SCHEMA_ESTIMATED_TOKENS = Math.ceil(
  Buffer.byteLength(JSON.stringify(VIDEO_SEMANTIC_OUTPUT_SCHEMA), 'utf8') /
    PROMPT_BYTES_PER_ESTIMATED_TOKEN,
)

interface FetchResponseLike {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type OllamaVideoSemanticFetch = (
  input: string,
  init: RequestInit,
) => Promise<FetchResponseLike>

export interface OllamaVideoSemanticRuntimeOptions {
  baseUrl?: string
  modelName: string
  expectedDigest?: string
  expectedQuantization?: string
  fetch?: OllamaVideoSemanticFetch
  inspectTimeoutMs?: number
  contextTokens?: number
  gpuLayers?: number
}

function validateLoopbackBaseUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Invalid Ollama base URL')
  }
  const host = parsed.hostname.toLowerCase()
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(host) ||
    !parsed.port ||
    Number(parsed.port) < 1 ||
    Number(parsed.port) > 65_535 ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Ollama URL must be an explicit HTTP loopback origin')
  }
  return parsed.origin
}

function validateModelName(value: string): string {
  const normalized = value.trim()
  if (!MODEL_NAME_PATTERN.test(normalized)) throw new Error('Invalid Ollama model name')
  return normalized
}

function safeTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1_000, Math.min(180_000, Math.floor(value!)))
}

function safeContextTokens(value: number | undefined): number {
  if (value === undefined) return 8_192
  if (!Number.isSafeInteger(value) || value < 4_096 || value > MAX_CONTEXT_TOKENS) {
    throw new Error('Ollama context tokens must be an integer between 4096 and 16384')
  }
  return value
}

function safeMaximumOutputTokens(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Ollama maximum output tokens must be a positive number')
  }
  return Math.max(1, Math.min(1_024, Math.floor(value)))
}

function safeGpuLayers(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_024) {
    throw new Error('Ollama GPU layers must be an integer between 0 and 1024')
  }
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

interface OllamaContextOverflow {
  promptTokens?: number
  contextTokens?: number
}

class OllamaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly contextOverflow?: OllamaContextOverflow,
  ) {
    super(
      contextOverflow
        ? `Ollama context overflow${
            contextOverflow.promptTokens && contextOverflow.contextTokens
              ? ` (prompt ${contextOverflow.promptTokens}, context ${contextOverflow.contextTokens})`
              : ''
          }`
        : `Ollama HTTP ${status}`,
    )
    this.name = 'OllamaHttpError'
  }
}

function positiveSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

function findContextOverflow(value: unknown, depth = 0): OllamaContextOverflow | undefined {
  if (depth > 4) return undefined
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (!normalized) return undefined
    if (normalized.length <= 16_384 && (normalized.startsWith('{') || normalized.startsWith('['))) {
      try {
        const nested = findContextOverflow(JSON.parse(normalized), depth + 1)
        if (nested) return nested
      } catch {
        // Fall through to the bounded diagnostic pattern.
      }
    }
    const match = normalized.match(
      /request\s*\((\d+)\s+tokens?\).*?(?:available\s+)?context\s+size\s*\((\d+)\s+tokens?\)/i,
    )
    if (match) {
      return { promptTokens: Number(match[1]), contextTokens: Number(match[2]) }
    }
    return /(?:exceed_context_size|context(?:\s+window|\s+size)?.*exceed|exceed.*context)/i.test(
      normalized,
    )
      ? {}
      : undefined
  }
  if (!isObject(value)) return undefined
  const promptTokens = positiveSafeInteger(value.n_prompt_tokens)
  const contextTokens = positiveSafeInteger(value.n_ctx)
  const kind = [value.type, value.code, value.message]
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
  if (
    (promptTokens !== undefined && contextTokens !== undefined && promptTokens > contextTokens) ||
    /(?:exceed_context_size|context(?:\s+window|\s+size)?.*exceed|exceed.*context)/i.test(kind)
  ) {
    return { promptTokens, contextTokens }
  }
  for (const key of ['error', 'message', 'details']) {
    const nested = findContextOverflow(value[key], depth + 1)
    if (nested) return nested
  }
  return undefined
}

function parseContextOverflow(text: string): OllamaContextOverflow | undefined {
  try {
    return findContextOverflow(JSON.parse(text))
  } catch {
    return findContextOverflow(text)
  }
}

export function estimateOllamaVideoSemanticPromptTokens(
  request: VideoSemanticRuntimeRequest,
): number {
  const messageBytes = request.prompt.messages.reduce(
    (total, message) => total + Buffer.byteLength(message.content, 'utf8'),
    0,
  )
  return (
    Math.ceil(messageBytes / PROMPT_BYTES_PER_ESTIMATED_TOKEN) +
    OUTPUT_SCHEMA_ESTIMATED_TOKENS +
    CHAT_TEMPLATE_TOKEN_RESERVE +
    request.images.length * IMAGE_TOKEN_ESTIMATE
  )
}

function selectContextTokens(required: number, configured: number, cap: number): number | null {
  const target = Math.max(required, configured, OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_CONTEXT_TOKENS)
  if (target > cap) return null
  return CONTEXT_TOKEN_TIERS.find((candidate) => candidate >= target && candidate <= cap) ?? cap
}

function extractTrailingJsonObject(value: string): string | null {
  let terminal = value.trim()
  if (!terminal || terminal.length > MAX_COMPATIBILITY_OUTPUT_CHARS) return null
  if (terminal.endsWith('```')) terminal = terminal.slice(0, -3).trimEnd()

  let cursor = terminal.lastIndexOf('{')
  let attempts = 0
  while (cursor >= 0 && attempts < MAX_COMPATIBILITY_OBJECT_CANDIDATES) {
    const candidate = terminal.slice(cursor)
    try {
      if (isObject(JSON.parse(candidate))) return candidate
    } catch {
      // Try the preceding opening brace. Nested objects make the final brace an invalid suffix.
    }
    cursor = terminal.lastIndexOf('{', cursor - 1)
    attempts += 1
  }
  return null
}

function validateImages(request: VideoSemanticRuntimeRequest): string[] {
  const images: string[] = []
  let totalBytes = 0
  for (const image of request.images) {
    if (!image.dataBase64) continue
    if (
      image.dataBase64.length % 4 !== 0 ||
      !BASE64_PATTERN.test(image.dataBase64) ||
      image.dataBase64.length > MAX_IMAGE_BASE64_BYTES
    ) {
      throw new Error('Invalid Ollama image payload')
    }
    totalBytes += image.dataBase64.length
    if (totalBytes > MAX_TOTAL_IMAGE_BASE64_BYTES) {
      throw new Error('Ollama image payload exceeds total limit')
    }
    images.push(image.dataBase64)
  }
  if (images.length !== request.images.length) {
    throw new Error('Ollama runtime requires in-memory image evidence')
  }
  return images
}

export class OllamaVideoSemanticRuntime implements VideoSemanticRuntime {
  readonly adapterId = 'ollama-loopback'
  private readonly baseUrl: string
  private readonly modelName: string
  private readonly expectedDigest?: string
  private readonly expectedQuantization?: string
  private readonly requestFetch: OllamaVideoSemanticFetch
  private readonly inspectTimeoutMs: number
  private readonly contextTokens: number
  private readonly gpuLayers?: number

  constructor(options: OllamaVideoSemanticRuntimeOptions) {
    this.baseUrl = validateLoopbackBaseUrl(options.baseUrl ?? 'http://127.0.0.1:11434')
    this.modelName = validateModelName(options.modelName)
    this.expectedDigest = options.expectedDigest?.toLowerCase()
    if (this.expectedDigest && !DIGEST_PATTERN.test(this.expectedDigest)) {
      throw new Error('Invalid expected Ollama model digest')
    }
    this.expectedQuantization = options.expectedQuantization
    this.requestFetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.inspectTimeoutMs = safeTimeout(options.inspectTimeoutMs, 3_000)
    this.contextTokens = safeContextTokens(options.contextTokens)
    this.gpuLayers = safeGpuLayers(options.gpuLayers)
  }

  private async request(
    pathname: '/api/tags' | '/api/chat',
    init: RequestInit,
    timeoutMs?: number,
  ): Promise<unknown> {
    const controller = new AbortController()
    const externalSignal = init.signal
    const timeout = setTimeout(
      () => controller.abort(new Error('Ollama request timed out')),
      safeTimeout(timeoutMs, pathname === '/api/tags' ? this.inspectTimeoutMs : 180_000),
    )
    const abort = () => controller.abort(externalSignal?.reason)
    externalSignal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await this.requestFetch(`${this.baseUrl}${pathname}`, {
        ...init,
        signal: controller.signal,
        redirect: 'error',
      })
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_HTTP_RESPONSE_BYTES) {
        throw new Error('Ollama response exceeds byte limit')
      }
      if (!response.ok) {
        throw new OllamaHttpError(response.status, parseContextOverflow(text))
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new Error('Ollama returned invalid JSON')
      }
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', abort)
    }
  }

  async inspect(): Promise<VideoSemanticRuntimeStatus> {
    try {
      const payload = await this.request('/api/tags', { method: 'GET' }, this.inspectTimeoutMs)
      if (!isObject(payload) || !Array.isArray(payload.models)) {
        return { adapterId: this.adapterId, state: 'error', reason: 'invalid-runtime-response' }
      }
      const model = payload.models.find(
        (candidate) =>
          isObject(candidate) &&
          (candidate.name === this.modelName || candidate.model === this.modelName),
      )
      if (!isObject(model)) {
        return { adapterId: this.adapterId, state: 'not-installed', reason: 'model-missing' }
      }
      const digest = typeof model.digest === 'string' ? model.digest.toLowerCase() : ''
      const details = isObject(model.details) ? model.details : {}
      const quantization =
        typeof details.quantization_level === 'string' ? details.quantization_level : ''
      if (!DIGEST_PATTERN.test(digest) || !quantization) {
        return { adapterId: this.adapterId, state: 'error', reason: 'model-identity-missing' }
      }
      if (
        (this.expectedDigest && digest !== this.expectedDigest) ||
        (this.expectedQuantization && quantization !== this.expectedQuantization)
      ) {
        return { adapterId: this.adapterId, state: 'error', reason: 'model-identity-mismatch' }
      }
      return {
        adapterId: this.adapterId,
        state: 'ready',
        model: {
          modelId: this.modelName,
          modelRevision: digest,
          quantization,
        },
      }
    } catch (error) {
      return {
        adapterId: this.adapterId,
        state: 'unavailable',
        reason: error instanceof Error ? error.message.slice(0, 300) : 'runtime-unreachable',
      }
    }
  }

  async generate(request: VideoSemanticRuntimeRequest, signal?: AbortSignal): Promise<string> {
    const images = validateImages(request)
    const configuredContextTokens = safeContextTokens(request.contextTokens ?? this.contextTokens)
    const maximumContextTokens = safeContextTokens(
      request.maximumContextTokens ?? MAX_CONTEXT_TOKENS,
    )
    const maximumOutputTokens = safeMaximumOutputTokens(request.maximumOutputTokens)
    const estimatedPromptTokens = estimateOllamaVideoSemanticPromptTokens(request)
    let contextTokens = selectContextTokens(
      estimatedPromptTokens + maximumOutputTokens + COMPLETION_TOKEN_MARGIN,
      configuredContextTokens,
      maximumContextTokens,
    )
    if (contextTokens === null) {
      throw new Error(
        `Ollama estimated prompt exceeds the context cap of ${maximumContextTokens} tokens`,
      )
    }
    const gpuLayers = safeGpuLayers(request.gpuLayers ?? this.gpuLayers)
    const messages = request.prompt.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.role === 'user' ? { images } : {}),
    }))
    let payload: unknown
    while (true) {
      try {
        payload = await this.request(
          '/api/chat',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal,
            body: JSON.stringify({
              model: this.modelName,
              messages,
              stream: false,
              think: false,
              format: VIDEO_SEMANTIC_OUTPUT_SCHEMA,
              options: {
                temperature: 0,
                num_ctx: contextTokens,
                num_predict: maximumOutputTokens,
                ...(gpuLayers === undefined ? {} : { num_gpu: gpuLayers }),
              },
              keep_alive: 0,
            }),
          },
          request.timeoutMs,
        )
        break
      } catch (error) {
        if (!(error instanceof OllamaHttpError) || !error.contextOverflow) throw error
        const requiredTokens = error.contextOverflow.promptTokens
          ? error.contextOverflow.promptTokens + maximumOutputTokens + COMPLETION_TOKEN_MARGIN
          : contextTokens + 1
        const nextContextTokens = selectContextTokens(
          requiredTokens,
          contextTokens + 1,
          maximumContextTokens,
        )
        if (nextContextTokens === null || nextContextTokens <= contextTokens) {
          throw new Error(
            `Ollama prompt exceeds the context cap of ${maximumContextTokens} tokens`,
            {
              cause: error,
            },
          )
        }
        contextTokens = nextContextTokens
      }
    }
    if (!isObject(payload) || !isObject(payload.message)) {
      throw new Error('Ollama chat response is invalid')
    }
    const content = typeof payload.message.content === 'string' ? payload.message.content : ''
    if (content.trim()) return extractTrailingJsonObject(content) ?? content.trim()

    // Some Qwen3-VL Ollama templates currently return schema-constrained output in `thinking`
    // even when think=false. Extract only one bounded terminal JSON object and discard the trace;
    // the strict semantic parser still applies authoritative schema and field allowlists afterwards.
    const thinking = typeof payload.message.thinking === 'string' ? payload.message.thinking : ''
    const compatibilityOutput = extractTrailingJsonObject(thinking)
    if (compatibilityOutput) return compatibilityOutput
    throw new Error('Ollama chat response did not contain a JSON object')
  }
}
