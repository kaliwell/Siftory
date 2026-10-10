const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { loadTsModule } = require('./guard-utils.cjs')
const { cudaEmbeddingModels, cudaEmbeddingRuntimeFiles, resolveEmbeddingInferenceProvider } =
  loadTsModule('electron/embeddingCudaRuntime.ts')
const { CudaEmbeddingWorkerClient, cudaEmbeddingProtocol } = loadTsModule(
  'electron/cudaEmbeddingWorkerClient.ts',
)
const { createProviderGates } = require('../scripts/create-cuda-provider-gates.cjs')

function createTempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cuda-embedding-worker-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function createFakeCudaRuntime(t, modelName, gateOverrides = {}) {
  const directory = createTempDir(t)
  const modelPath = path.join(directory, 'model.onnx')
  for (const name of ['model.onnx', ...cudaEmbeddingRuntimeFiles]) {
    fs.writeFileSync(path.join(directory, name), 'fixture')
  }
  const config = cudaEmbeddingModels.find((candidate) => candidate.modelName === modelName)
  fs.writeFileSync(
    path.join(directory, 'provider-gates.json'),
    JSON.stringify({
      schemaVersion: 1,
      ortVersion: '1.24.3',
      models: [
        {
          id: config.id,
          modelSha256: config.sha256,
          passed: true,
          minimumCosine: 0.999999,
          speedup: 2,
          performanceCriticalCpuOperations: [],
          ...gateOverrides,
        },
      ],
    }),
  )
  fs.writeFileSync(
    path.join(directory, 'runtime-manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      manifestId: 'floating-clock-runtime-resources',
      components: [
        {
          artifacts: cudaEmbeddingRuntimeFiles.map((name) => {
            const contents = fs.readFileSync(path.join(directory, name))
            return {
              targetPath: `cuda-runtime/${name}`,
              sizeBytes: contents.length,
              sha256: crypto.createHash('sha256').update(contents).digest('hex'),
            }
          }),
        },
      ],
    }),
  )
  return { directory, modelPath }
}

test('embedding provider router selects CUDA only for a fully gated model runtime', (t) => {
  const { directory, modelPath } = createFakeCudaRuntime(t, 'dinov2_vitb14')
  const resolution = resolveEmbeddingInferenceProvider({
    backend: 'gpu',
    modelName: 'dinov2_vitb14',
    modelPath,
    platform: 'win32',
    cudaRuntimeDir: directory,
    cudaRuntimeManifestPath: path.join(directory, 'runtime-manifest.json'),
    modelSha256: cudaEmbeddingModels.find((candidate) => candidate.modelName === 'dinov2_vitb14')
      .sha256,
  })
  assert.equal(resolution.provider, 'cuda')
  assert.equal(resolution.cuda.modelId, 'dino')
  assert.equal(resolution.cuda.outputName, 'last_hidden_state')
})

test('embedding provider router fails closed to DirectML for incomplete or failed CUDA gates', (t) => {
  const failed = createFakeCudaRuntime(t, 'clip_vit_base_patch32', { speedup: 1.49 })
  assert.deepEqual(
    resolveEmbeddingInferenceProvider({
      backend: 'gpu',
      modelName: 'clip_vit_base_patch32',
      modelPath: failed.modelPath,
      platform: 'win32',
      cudaRuntimeDir: failed.directory,
      cudaRuntimeManifestPath: path.join(failed.directory, 'runtime-manifest.json'),
      modelSha256: cudaEmbeddingModels.find(
        (candidate) => candidate.modelName === 'clip_vit_base_patch32',
      ).sha256,
    }),
    { provider: 'directml', reason: 'cuda-model-gate-failed' },
  )

  const incomplete = createFakeCudaRuntime(t, 'dinov2_vitb14')
  fs.rmSync(path.join(incomplete.directory, 'onnxruntime_providers_cuda.dll'))
  assert.equal(
    resolveEmbeddingInferenceProvider({
      backend: 'gpu',
      modelName: 'dinov2_vitb14',
      modelPath: incomplete.modelPath,
      platform: 'win32',
      cudaRuntimeDir: incomplete.directory,
      cudaRuntimeManifestPath: path.join(incomplete.directory, 'runtime-manifest.json'),
      modelSha256: cudaEmbeddingModels.find((candidate) => candidate.modelName === 'dinov2_vitb14')
        .sha256,
    }).reason,
    'cuda-runtime-incomplete',
  )

  const mismatched = createFakeCudaRuntime(t, 'dinov2_vitb14')
  assert.equal(
    resolveEmbeddingInferenceProvider({
      backend: 'gpu',
      modelName: 'dinov2_vitb14',
      modelPath: mismatched.modelPath,
      platform: 'win32',
      cudaRuntimeDir: mismatched.directory,
      cudaRuntimeManifestPath: path.join(mismatched.directory, 'runtime-manifest.json'),
      modelSha256: '0'.repeat(64),
    }).reason,
    'cuda-model-hash-mismatch',
  )

  const tampered = createFakeCudaRuntime(t, 'dinov2_vitb14')
  fs.writeFileSync(path.join(tampered.directory, 'cublas64_12.dll'), 'tamper!')
  assert.equal(
    resolveEmbeddingInferenceProvider({
      backend: 'gpu',
      modelName: 'dinov2_vitb14',
      modelPath: tampered.modelPath,
      platform: 'win32',
      cudaRuntimeDir: tampered.directory,
      cudaRuntimeManifestPath: path.join(tampered.directory, 'runtime-manifest.json'),
      modelSha256: cudaEmbeddingModels.find((candidate) => candidate.modelName === 'dinov2_vitb14')
        .sha256,
    }).reason,
    'cuda-runtime-integrity-failed',
  )
})

test('embedding provider router preserves CPU requests and non-Windows GPU routing', (t) => {
  const { modelPath } = createFakeCudaRuntime(t, 'dinov2_vitb14')
  assert.deepEqual(
    resolveEmbeddingInferenceProvider({
      backend: 'cpu',
      modelName: 'dinov2_vitb14',
      modelPath,
      platform: 'win32',
      modelSha256: cudaEmbeddingModels.find((candidate) => candidate.modelName === 'dinov2_vitb14')
        .sha256,
    }),
    { provider: 'cpu', reason: 'cpu-requested' },
  )
  assert.deepEqual(
    resolveEmbeddingInferenceProvider({
      backend: 'gpu',
      modelName: 'dinov2_vitb14',
      modelPath,
      platform: 'linux',
    }),
    { provider: 'gpu', reason: 'non-windows-gpu-runtime' },
  )
  assert.equal(cudaEmbeddingProtocol.version, 1)
  assert.equal(cudaEmbeddingProtocol.maxPayloadBytes, 256 * 1024 * 1024)
})

test('embedding service forwards gated CUDA configuration and children retain fallback paths', () => {
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'embeddingService.ts'),
    'utf8',
  )
  const dino = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'dinoEmbeddingChild.ts'),
    'utf8',
  )
  const clip = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'clipEmbeddingChild.ts'),
    'utf8',
  )
  assert.match(service, /resolveEmbeddingInferenceProvider/)
  assert.match(service, /effectiveBackend === 'cuda'\s*\? 1/)
  assert.match(service, /cuda: task\.cuda/)
  assert.match(dino, /DINO CUDA inference unavailable/)
  assert.match(dino, /backend: 'gpu', cuda: undefined/)
  assert.match(clip, /CLIP CUDA inference unavailable/)
  assert.match(clip, /CLIP GPU backend unavailable/)
})

test('provider gate generator accepts only complete passing DINO and CLIP reports', () => {
  const report = (model, modelSha256, speedup = 2) => ({
    schemaVersion: 1,
    model,
    modelSha256,
    passed: true,
    performanceGate: { speedup },
    parity: { ok: true, metrics: { minimumCosine: 0.99999 } },
    performanceCriticalCpuOperations: [],
  })
  const gates = createProviderGates([
    report('dinov2_vitb14', 'dino-sha'),
    report('clip_vit_base_patch32_image', 'clip-sha'),
  ])
  assert.deepEqual(
    gates.models.map((entry) => entry.id),
    ['dino', 'clip-image'],
  )
  assert.throws(
    () =>
      createProviderGates([
        report('dinov2_vitb14', 'dino-sha'),
        report('clip_vit_base_patch32_image', 'clip-sha', 1.49),
      ]),
    /did not pass every CUDA provider gate/,
  )
})

const sharedNativeFixture = {
  workerPath: process.env.REASONIX_CUDA_WORKER_PATH,
  runtimeDir: process.env.REASONIX_CUDA_RUNTIME_DIR,
  dllDirectories: (process.env.REASONIX_CUDA_DLL_DIRS || '').split(path.delimiter).filter(Boolean),
}
const nativeFixtures = [
  {
    name: 'DINO',
    modelId: 'dino',
    ...sharedNativeFixture,
    modelPath: process.env.REASONIX_CUDA_MODEL_PATH,
    manifestPath: process.env.REASONIX_CUDA_INPUT_MANIFEST,
    referenceRawPath: process.env.REASONIX_CUDA_REFERENCE_RAW,
  },
  {
    name: 'CLIP image',
    modelId: 'clip-image',
    ...sharedNativeFixture,
    modelPath: process.env.REASONIX_CLIP_CUDA_MODEL_PATH,
    manifestPath: process.env.REASONIX_CLIP_CUDA_INPUT_MANIFEST,
    referenceRawPath: process.env.REASONIX_CLIP_CUDA_REFERENCE_RAW,
  },
]

for (const nativeFixture of nativeFixtures) {
  const nativeFixtureReady = Object.entries(nativeFixture)
    .filter(([name]) => !['dllDirectories', 'name', 'modelId'].includes(name))
    .every(([, value]) => typeof value === 'string' && fs.existsSync(value))
  test(
    `native CUDA worker reproduces the isolated Python CUDA output for ${nativeFixture.name}`,
    { skip: nativeFixtureReady ? false : `set ${nativeFixture.name} CUDA fixture variables` },
    async () => {
      const manifest = JSON.parse(fs.readFileSync(nativeFixture.manifestPath, 'utf8'))
      const tensors = manifest.tensors.map((entry) => {
        const raw = fs.readFileSync(path.join(path.dirname(nativeFixture.manifestPath), entry.file))
        const copied = Uint8Array.from(raw)
        return {
          name: entry.name,
          dtype: entry.dtype,
          dimensions: entry.dimensions,
          data:
            entry.dtype === 'float32'
              ? new Float32Array(copied.buffer)
              : new BigInt64Array(copied.buffer),
        }
      })
      const client = new CudaEmbeddingWorkerClient({
        workerPath: nativeFixture.workerPath,
        runtimeDir: nativeFixture.runtimeDir,
        modelPath: nativeFixture.modelPath,
        modelId: nativeFixture.modelId,
        outputName: manifest.outputName,
        dllDirectories: nativeFixture.dllDirectories,
        onStderr: (message) => process.stderr.write(`[cuda-worker] ${message}\n`),
      })
      try {
        const hello = await client.hello
        assert.equal(hello.provider, 'cuda')
        assert.ok(hello.availableProviders.includes('CUDAExecutionProvider'))
        const output = await client.infer(tensors)
        const referenceBytes = Uint8Array.from(fs.readFileSync(nativeFixture.referenceRawPath))
        const reference = new Float32Array(referenceBytes.buffer)
        assert.equal(output.data.length, reference.length)
        let maximumAbsoluteError = 0
        for (let index = 0; index < reference.length; index += 1) {
          maximumAbsoluteError = Math.max(
            maximumAbsoluteError,
            Math.abs(output.data[index] - reference[index]),
          )
        }
        assert.ok(maximumAbsoluteError <= 1e-6, `maximum absolute error: ${maximumAbsoluteError}`)
      } finally {
        client.close()
      }
    },
  )
}
