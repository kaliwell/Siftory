import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'

export type EmbeddingInferenceProvider = 'cpu' | 'directml' | 'cuda' | 'gpu'
export type CudaEmbeddingModelId = 'dino' | 'clip-image'

interface CudaModelConfig {
  id: CudaEmbeddingModelId
  modelName: 'dinov2_vitb14' | 'clip_vit_base_patch32'
  outputName: 'last_hidden_state' | 'image_embeds'
  sha256: string
}

const MODEL_CONFIGS: readonly CudaModelConfig[] = [
  {
    id: 'dino',
    modelName: 'dinov2_vitb14',
    outputName: 'last_hidden_state',
    sha256: '19f697cf7cddfbbaa4b146b813e726a1e4ed89aa5fd363cdc38d689a3b5f6018',
  },
  {
    id: 'clip-image',
    modelName: 'clip_vit_base_patch32',
    outputName: 'image_embeds',
    sha256: '1f518bedb1851294737a141e06149883cb289160760224f2da5498886e49d5cb',
  },
]

interface CudaGateFile {
  schemaVersion?: unknown
  ortVersion?: unknown
  models?: unknown
}

interface RuntimeManifestArtifact {
  sha256?: unknown
  sizeBytes?: unknown
  targetPath?: unknown
}

interface RuntimeManifestComponent {
  artifacts?: unknown
}

interface RuntimeManifestFile {
  schemaVersion?: unknown
  manifestId?: unknown
  components?: unknown
}

export const cudaEmbeddingRuntimeFiles = [
  'floating_clock_cuda_embedding_worker.exe',
  'provider-gates.json',
  'onnxruntime.dll',
  'onnxruntime_providers_cuda.dll',
  'onnxruntime_providers_shared.dll',
  'cudart64_12.dll',
  'cublas64_12.dll',
  'cublasLt64_12.dll',
  'cufft64_11.dll',
  'nvrtc64_120_0.dll',
  'nvrtc-builtins64_128.dll',
  'cudnn64_9.dll',
  'cudnn_graph64_9.dll',
  'cudnn_ops64_9.dll',
  'cudnn_engines_precompiled64_9.dll',
  'cudnn_engines_runtime_compiled64_9.dll',
  'cudnn_heuristic64_9.dll',
] as const

const runtimeHashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>()

interface CudaModelGate {
  id?: unknown
  modelSha256?: unknown
  passed?: unknown
  minimumCosine?: unknown
  speedup?: unknown
  performanceCriticalCpuOperations?: unknown
}

export interface EmbeddingProviderResolution {
  provider: EmbeddingInferenceProvider
  reason: string
  cuda?: {
    workerPath: string
    runtimeDir: string
    modelId: CudaEmbeddingModelId
    outputName: string
  }
}

export interface EmbeddingProviderResolveOptions {
  backend: 'cpu' | 'gpu'
  modelName: string
  modelPath: string
  platform?: NodeJS.Platform
  resourcesPath?: string
  cudaRuntimeDir?: string
  cudaRuntimeManifestPath?: string
  modelSha256?: string
}

function sha256File(filePath: string): string | null {
  let handle: number | undefined
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  const hash = createHash('sha256')
  try {
    handle = fs.openSync(filePath, 'r')
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
    return hash.digest('hex')
  } catch {
    return null
  } finally {
    if (handle !== undefined) fs.closeSync(handle)
  }
}

function cachedSha256File(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath)
    const cached = runtimeHashCache.get(filePath)
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.sha256
    const sha256 = sha256File(filePath)
    if (sha256) runtimeHashCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 })
    return sha256
  } catch {
    return null
  }
}

function readRuntimeManifest(manifestPath: string): RuntimeManifestFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RuntimeManifestFile
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function runtimeIntegrityPassed(runtimeDir: string, manifestPath: string): boolean {
  const manifest = readRuntimeManifest(manifestPath)
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.manifestId !== 'floating-clock-runtime-resources' ||
    !Array.isArray(manifest.components)
  ) {
    return false
  }
  const artifacts = (manifest.components as RuntimeManifestComponent[]).flatMap((component) =>
    Array.isArray(component?.artifacts) ? (component.artifacts as RuntimeManifestArtifact[]) : [],
  )
  const byTarget = new Map(
    artifacts
      .filter((artifact) => typeof artifact?.targetPath === 'string')
      .map((artifact) => [artifact.targetPath as string, artifact]),
  )
  return cudaEmbeddingRuntimeFiles.every((fileName) => {
    const artifact = byTarget.get(`cuda-runtime/${fileName}`)
    if (
      !artifact ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      (artifact.sizeBytes as number) <= 0
    ) {
      return false
    }
    const filePath = path.join(runtimeDir, fileName)
    try {
      const stat = fs.statSync(filePath)
      return (
        stat.isFile() &&
        stat.size === artifact.sizeBytes &&
        cachedSha256File(filePath) === artifact.sha256
      )
    } catch {
      return false
    }
  })
}

function readGateFile(gatePath: string): CudaGateFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(gatePath, 'utf8')) as CudaGateFile
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function selectModelGate(gates: CudaGateFile, config: CudaModelConfig): CudaModelGate | null {
  if (!Array.isArray(gates.models)) return null
  const gate = gates.models.find((candidate): candidate is CudaModelGate =>
    Boolean(
      candidate && typeof candidate === 'object' && (candidate as CudaModelGate).id === config.id,
    ),
  )
  return gate || null
}

function gatePassed(gate: CudaModelGate | null, config: CudaModelConfig): boolean {
  return Boolean(
    gate &&
    gate.passed === true &&
    gate.modelSha256 === config.sha256 &&
    typeof gate.minimumCosine === 'number' &&
    gate.minimumCosine >= 0.999 &&
    typeof gate.speedup === 'number' &&
    gate.speedup >= 1.5 &&
    Array.isArray(gate.performanceCriticalCpuOperations) &&
    gate.performanceCriticalCpuOperations.length === 0,
  )
}

export function resolveEmbeddingInferenceProvider(
  options: EmbeddingProviderResolveOptions,
): EmbeddingProviderResolution {
  if (options.backend === 'cpu') return { provider: 'cpu', reason: 'cpu-requested' }
  const platform = options.platform || process.platform
  if (platform !== 'win32') return { provider: 'gpu', reason: 'non-windows-gpu-runtime' }
  const config = MODEL_CONFIGS.find((candidate) => candidate.modelName === options.modelName)
  if (!config) return { provider: 'directml', reason: 'cuda-model-not-supported' }
  if (!path.isAbsolute(options.modelPath) || !fs.existsSync(options.modelPath)) {
    return { provider: 'directml', reason: 'cuda-model-path-unavailable' }
  }
  const configuredRoot = options.cudaRuntimeDir || process.env.FLOATING_CLOCK_CUDA_RUNTIME_DIR
  const runtimeDir = configuredRoot
    ? path.resolve(configuredRoot)
    : path.resolve(options.resourcesPath || process.resourcesPath || '', 'cuda-runtime')
  if (!path.isAbsolute(runtimeDir) || !fs.existsSync(runtimeDir)) {
    return { provider: 'directml', reason: 'cuda-runtime-missing' }
  }
  const workerPath = path.join(runtimeDir, 'floating_clock_cuda_embedding_worker.exe')
  const requiredFiles = cudaEmbeddingRuntimeFiles.map((fileName) => path.join(runtimeDir, fileName))
  if (requiredFiles.some((filePath) => !fs.existsSync(filePath))) {
    return { provider: 'directml', reason: 'cuda-runtime-incomplete' }
  }
  const configuredManifest =
    options.cudaRuntimeManifestPath || process.env.FLOATING_CLOCK_CUDA_RUNTIME_MANIFEST
  const runtimeManifestPath = configuredManifest
    ? path.resolve(configuredManifest)
    : path.resolve(options.resourcesPath || process.resourcesPath || '', 'runtime-manifest.json')
  if (!runtimeIntegrityPassed(runtimeDir, runtimeManifestPath)) {
    return { provider: 'directml', reason: 'cuda-runtime-integrity-failed' }
  }
  const gates = readGateFile(path.join(runtimeDir, 'provider-gates.json'))
  if (!gates || gates.schemaVersion !== 1 || gates.ortVersion !== '1.24.3') {
    return { provider: 'directml', reason: 'cuda-runtime-gate-invalid' }
  }
  if (!gatePassed(selectModelGate(gates, config), config)) {
    return { provider: 'directml', reason: 'cuda-model-gate-failed' }
  }
  if ((options.modelSha256 || sha256File(options.modelPath)) !== config.sha256) {
    return { provider: 'directml', reason: 'cuda-model-hash-mismatch' }
  }
  return {
    provider: 'cuda',
    reason: 'cuda-model-gate-passed',
    cuda: {
      workerPath,
      runtimeDir,
      modelId: config.id,
      outputName: config.outputName,
    },
  }
}

export const cudaEmbeddingModels = MODEL_CONFIGS
