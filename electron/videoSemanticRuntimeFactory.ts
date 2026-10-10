import fs from 'node:fs'
import path from 'node:path'
import { VIDEO_SEMANTIC_OLLAMA_TEST_IDENTITY } from '../shared/videoSemantic'
import {
  LlamaCppVideoSemanticRuntime,
  LLAMA_CPP_VIDEO_SEMANTIC_CONTEXT_TOKENS,
  LLAMA_CPP_VIDEO_SEMANTIC_GPU_LAYERS,
} from './llamaCppVideoSemanticRuntime'
import {
  OllamaVideoSemanticRuntime,
  OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_CONTEXT_TOKENS,
  OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_GPU_LAYERS,
} from './ollamaVideoSemanticRuntime'
import type { VideoSemanticRuntime, VideoSemanticRuntimeRequest } from './videoSemanticRuntime'

export const VIDEO_SEMANTIC_LLAMA_CPP_RELEASE = 'b10441'
export const VIDEO_SEMANTIC_LLAMA_CPP_COMMIT = '0177dcc7300bad8914bb838baabce87899812491'
export const VIDEO_SEMANTIC_GGUF_REVISION = '52d6c8ffea26cc873ac5ad116f8631268d7eb503'
export const VIDEO_SEMANTIC_LLAMA_CPP_DESCRIPTOR = 'video-semantic/llama-cpp-runtime.json'

const EXPECTED_RESOURCE_PATHS = {
  server: 'llama-cpp/llama-server.exe',
  model: 'video-semantic/Qwen3VL-2B-Instruct-Q4_K_M.gguf',
  projector: 'video-semantic/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf',
} as const
const SHA256_PATTERN = /^[a-f0-9]{64}$/

interface ApprovedLlamaCppDescriptor {
  schemaVersion: 1
  runtime: {
    release: string
    commit: string
    file: string
    sha256: string
  }
  model: {
    id: string
    revision: string
    quantization: string
    file: string
    sha256: string
  }
  projector: {
    file: string
    sha256: string
  }
  approval: {
    status: 'approved'
    approvedBy: string
    approvedAt: string
    evidenceId: string
    distributionProfile: 'online' | 'offline'
  }
}

export interface VideoSemanticRuntimeFactoryOptions {
  resourcesRoot: string
  allowManagedLlamaCpp: boolean
  descriptorExists?: (filePath: string) => boolean
  readDescriptor?: (filePath: string) => string
}

class BlockedManagedVideoSemanticRuntime implements VideoSemanticRuntime {
  readonly adapterId = 'llama-cpp-managed'

  constructor(private readonly reason: string) {}

  inspect() {
    return { adapterId: this.adapterId, state: 'error' as const, reason: this.reason }
  }

  generate(_request: VideoSemanticRuntimeRequest): Promise<string> {
    return Promise.reject(new Error(this.reason))
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function safeApprovalText(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:@/-]{2,127}$/i.test(value)
}

function parseApprovedDescriptor(raw: string): ApprovedLlamaCppDescriptor {
  if (Buffer.byteLength(raw, 'utf8') > 32 * 1024) throw new Error('descriptor-too-large')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('descriptor-invalid-json')
  }
  if (
    !isObject(value) ||
    !exactKeys(value, ['schemaVersion', 'runtime', 'model', 'projector', 'approval'])
  ) {
    throw new Error('descriptor-invalid-schema')
  }
  const runtime = value.runtime
  const model = value.model
  const projector = value.projector
  const approval = value.approval
  if (
    value.schemaVersion !== 1 ||
    !isObject(runtime) ||
    !exactKeys(runtime, ['release', 'commit', 'file', 'sha256']) ||
    runtime.release !== VIDEO_SEMANTIC_LLAMA_CPP_RELEASE ||
    runtime.commit !== VIDEO_SEMANTIC_LLAMA_CPP_COMMIT ||
    runtime.file !== EXPECTED_RESOURCE_PATHS.server ||
    typeof runtime.sha256 !== 'string' ||
    !SHA256_PATTERN.test(runtime.sha256) ||
    !isObject(model) ||
    !exactKeys(model, ['id', 'revision', 'quantization', 'file', 'sha256']) ||
    model.id !== 'qwen3-vl-2b-instruct-q4_k_m' ||
    model.revision !== VIDEO_SEMANTIC_GGUF_REVISION ||
    model.quantization !== 'Q4_K_M' ||
    model.file !== EXPECTED_RESOURCE_PATHS.model ||
    typeof model.sha256 !== 'string' ||
    !SHA256_PATTERN.test(model.sha256) ||
    !isObject(projector) ||
    !exactKeys(projector, ['file', 'sha256']) ||
    projector.file !== EXPECTED_RESOURCE_PATHS.projector ||
    typeof projector.sha256 !== 'string' ||
    !SHA256_PATTERN.test(projector.sha256) ||
    !isObject(approval) ||
    !exactKeys(approval, [
      'status',
      'approvedBy',
      'approvedAt',
      'evidenceId',
      'distributionProfile',
    ]) ||
    approval.status !== 'approved' ||
    !safeApprovalText(approval.approvedBy) ||
    !safeApprovalText(approval.evidenceId) ||
    !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(approval.approvedAt)) ||
    !['online', 'offline'].includes(String(approval.distributionProfile))
  ) {
    throw new Error('descriptor-invalid-schema')
  }
  return value as unknown as ApprovedLlamaCppDescriptor
}

function resolveResource(resourcesRoot: string, relativePath: string): string {
  const root = path.resolve(resourcesRoot)
  if (!path.isAbsolute(root)) throw new Error('resources-root-invalid')
  const target = path.resolve(root, ...relativePath.split('/'))
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('descriptor-path-escape')
  return target
}

function createOllamaRuntime(): VideoSemanticRuntime {
  return new OllamaVideoSemanticRuntime({
    modelName: VIDEO_SEMANTIC_OLLAMA_TEST_IDENTITY.modelName,
    expectedDigest: VIDEO_SEMANTIC_OLLAMA_TEST_IDENTITY.modelDigest,
    expectedQuantization: VIDEO_SEMANTIC_OLLAMA_TEST_IDENTITY.quantization,
    contextTokens: OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_CONTEXT_TOKENS,
    gpuLayers: OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_GPU_LAYERS,
  })
}

export function createDefaultVideoSemanticRuntime(
  options: VideoSemanticRuntimeFactoryOptions,
): VideoSemanticRuntime {
  if (!options.allowManagedLlamaCpp) return createOllamaRuntime()
  const descriptorPath = resolveResource(options.resourcesRoot, VIDEO_SEMANTIC_LLAMA_CPP_DESCRIPTOR)
  const exists = options.descriptorExists ?? fs.existsSync
  if (!exists(descriptorPath)) return createOllamaRuntime()
  try {
    const read = options.readDescriptor ?? ((filePath: string) => fs.readFileSync(filePath, 'utf8'))
    const descriptor = parseApprovedDescriptor(read(descriptorPath))
    return new LlamaCppVideoSemanticRuntime({
      serverExecutablePath: resolveResource(options.resourcesRoot, descriptor.runtime.file),
      modelPath: resolveResource(options.resourcesRoot, descriptor.model.file),
      mmprojPath: resolveResource(options.resourcesRoot, descriptor.projector.file),
      expectedServerSha256: descriptor.runtime.sha256,
      expectedModelSha256: descriptor.model.sha256,
      expectedMmprojSha256: descriptor.projector.sha256,
      modelId: descriptor.model.id,
      modelRevision: descriptor.model.revision,
      quantization: descriptor.model.quantization,
      contextTokens: LLAMA_CPP_VIDEO_SEMANTIC_CONTEXT_TOKENS,
      gpuLayers: LLAMA_CPP_VIDEO_SEMANTIC_GPU_LAYERS,
    })
  } catch {
    return new BlockedManagedVideoSemanticRuntime('managed-runtime-config-invalid')
  }
}
