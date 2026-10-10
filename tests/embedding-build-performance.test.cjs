const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { loadTsModule } = require('./guard-utils.cjs')
const { filterSupportedEmbeddingInputs, hasSupportedEmbeddingImageSignature } = loadTsModule(
  'electron/embeddingInputValidation.ts',
)
const { collectExistingEmbeddingIdsFromFastIndex } = loadTsModule(
  'electron/embeddingExistingIndex.ts',
)
const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')
const { poolDinoEmbedding } = loadTsModule('electron/dinoEmbeddingMath.ts')
const { calculateEmbeddingInferenceRate } = loadTsModule('electron/embeddingProgressRate.ts')
const { MAX_DIRECTML_STREAM_CONCURRENCY } = loadTsModule(
  'electron/embeddingStreamController.ts',
)
const { resolveComputeBackend, selectUsableGpuDevice } = loadTsModule(
  'electron/computeBackendPolicy.ts',
)

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-build-performance-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('Simple compute policy selects hardware GPU and falls back to CPU', () => {
  const hardware = selectUsableGpuDevice([
    { active: true, deviceString: 'Microsoft Basic Render Driver' },
    { active: false, deviceString: 'NVIDIA GeForce RTX 4070', vendorId: 0x10de },
  ])
  assert.equal(hardware.deviceString, 'NVIDIA GeForce RTX 4070')
  assert.equal(
    resolveComputeBackend('auto', {
      gpuAvailable: true,
      recommendedBackend: 'gpu',
      reason: 'test',
      checkedAt: 0,
    }),
    'gpu',
  )
  assert.equal(
    resolveComputeBackend('gpu', {
      gpuAvailable: false,
      recommendedBackend: 'cpu',
      reason: 'test',
      checkedAt: 0,
    }),
    'cpu',
  )
  assert.equal(
    resolveComputeBackend('cpu', {
      gpuAvailable: true,
      recommendedBackend: 'gpu',
      reason: 'test',
      checkedAt: 0,
    }),
    'cpu',
  )
})

test('embedding input signature filter rejects extension-spoofed images', () => {
  assert.equal(
    hasSupportedEmbeddingImageSignature(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ),
    true,
  )
  assert.equal(hasSupportedEmbeddingImageSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true)
  assert.equal(
    hasSupportedEmbeddingImageSignature(Buffer.from([0x90, 0x1d, 0x30, 0x01, 0x61, 0x62])),
    false,
  )
})

test('embedding input rejection cache is reused and invalidated after a file changes', async (t) => {
  const dir = createTempDir(t)
  const imagePath = path.join(dir, 'spoofed.png')
  const cachePath = path.join(dir, 'rejections.json')
  fs.writeFileSync(imagePath, Buffer.from([0x90, 0x1d, 0x30, 0x01, 0x61, 0x62]))

  const first = await filterSupportedEmbeddingInputs([{ imagePath }], { cachePath })
  const second = await filterSupportedEmbeddingInputs([{ imagePath }], { cachePath })
  assert.deepEqual(
    { accepted: first.accepted.length, rejected: first.rejected, cached: first.cachedRejected },
    { accepted: 0, rejected: 1, cached: 0 },
  )
  assert.equal(second.cachedRejected, 1)

  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))
  const changed = await filterSupportedEmbeddingInputs([{ imagePath }], { cachePath })
  assert.equal(changed.accepted.length, 1)
  assert.equal(changed.rejected, 0)
})

test('DINO existing-ID fast path combines the compact path index with only the source tail', async (t) => {
  const dir = createTempDir(t)
  const vectorDbDir = path.join(dir, 'vector-db')
  const cacheDir = path.join(vectorDbDir, 'embedding-cache')
  const sourcePath = path.join(vectorDbDir, 'embeddings.jsonl')
  fs.mkdirSync(cacheDir, { recursive: true })

  const prefix = `${JSON.stringify({
    modelName: 'dinov2_vitb14',
    embeddingType: 'dino',
    imageId: 'cached-image',
  })}\n`
  fs.writeFileSync(sourcePath, prefix)
  const base = 'dinov2_vitb14__dino'
  fs.writeFileSync(
    path.join(cacheDir, `${base}.paths.jsonl`),
    `${JSON.stringify({ row: 0, path: 'cached-image' })}\n`,
  )
  fs.writeFileSync(
    path.join(cacheDir, `${base}.f16.json`),
    JSON.stringify({
      version: cacheApi.EMBEDDING_F16_CACHE_VERSION,
      modelName: 'dinov2_vitb14',
      embeddingType: 'dino',
      dim: 2,
      count: 1,
      sourceFiles: [{ path: sourcePath, size: Buffer.byteLength(prefix) }],
    }),
  )
  fs.appendFileSync(
    sourcePath,
    [
      {
        modelName: 'dinov2_vitb14',
        embeddingType: 'dino',
        imageId: 'C:\\images\\new.jpg',
        dim: 2,
        vector: [1, 0],
      },
      {
        modelName: 'dinov2_vitb14',
        embeddingType: 'dino',
        imageId: 'c:/IMAGES/new.jpg',
        dim: 999,
        vector: [1, 0],
      },
      {
        modelName: 'dinov2_vitb14',
        embeddingType: 'dino',
        imageId: 'other-image',
        dim: 2,
        vector: [0, 1],
      },
    ].map((item) => `${JSON.stringify(item)}\n`).join(''),
  )

  const existing = await collectExistingEmbeddingIdsFromFastIndex({
    vectorDbDir,
    modelName: 'dinov2_vitb14',
    embeddingType: 'dino',
    dim: 2,
    sourcePaths: [sourcePath],
  })
  assert.deepEqual([...existing].sort(), ['cached-image', 'other-image'])
})

test('CLIP existing-ID fast path combines its F16 path index with only the source tail', async (t) => {
  const dir = createTempDir(t)
  const vectorDbDir = path.join(dir, 'vector-db')
  const cacheDir = path.join(vectorDbDir, 'embedding-cache')
  const sourcePath = path.join(vectorDbDir, 'embeddings', 'clip_vit_base_patch32__global.jsonl')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true })

  const prefix = `${JSON.stringify({
    modelName: 'clip_vit_base_patch32',
    embeddingType: 'global',
    imageId: 'cached-clip',
  })}\n`
  fs.writeFileSync(sourcePath, prefix)
  const base = 'clip_vit_base_patch32__global'
  fs.writeFileSync(
    path.join(cacheDir, `${base}.paths.jsonl`),
    `${JSON.stringify({ row: 0, path: 'cached-clip' })}\n`,
  )
  fs.writeFileSync(
    path.join(cacheDir, `${base}.f16.json`),
    JSON.stringify({
      version: cacheApi.EMBEDDING_F16_CACHE_VERSION,
      modelName: 'clip_vit_base_patch32',
      embeddingType: 'global',
      dim: 512,
      count: 1,
      sourceFiles: [{ path: sourcePath, size: Buffer.byteLength(prefix) }],
    }),
  )
  fs.appendFileSync(
    sourcePath,
    `${JSON.stringify({
      modelName: 'clip_vit_base_patch32',
      embeddingType: 'global',
      imageId: 'new-clip',
      dim: 512,
      vector: [1, ...Array(511).fill(0)],
    })}\n`,
  )

  const existing = await collectExistingEmbeddingIdsFromFastIndex({
    vectorDbDir,
    modelName: 'clip_vit_base_patch32',
    embeddingType: 'global',
    dim: 512,
    sourcePaths: [sourcePath],
  })
  assert.deepEqual([...existing].sort(), ['cached-clip', 'new-clip'])
})

test('DINO pooling addresses the correct image in a batched tensor and excludes CLS', () => {
  const data = [
    99,
    99,
    1,
    0,
    1,
    0, // batch 0
    88,
    88,
    3,
    4,
    3,
    4, // batch 1
  ]
  const pooled = poolDinoEmbedding(data, [2, 3, 2], 2, 1)
  assert.ok(Math.abs(pooled[0] - 0.6) < 1e-9)
  assert.ok(Math.abs(pooled[1] - 0.8) < 1e-9)
})

test('DINO pooling rejects ambiguous or wrong output shapes instead of slicing across batches', () => {
  assert.throws(() => poolDinoEmbedding([1, 2, 3, 4], [1, 1, 4], 2, 0), /shape mismatch/)
  assert.throws(() => poolDinoEmbedding([1, 2, 3, 4], undefined, 2, 0), /missing|length/)
  assert.throws(() => poolDinoEmbedding([1, 2], [2, 1, 2], 2, 1), /shape|length/)
})

test('embedding service dispatches actual batches and caps Windows DirectML workers', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'electron', 'embeddingService.ts'),
    'utf8',
  )
  assert.equal(MAX_DIRECTML_STREAM_CONCURRENCY, 2)
  assert.match(
    source,
    /MAX_DIRECTML_STREAM_CONCURRENCY\s+as\s+MAX_DIRECTML_GPU_CONCURRENCY/,
  )
  assert.match(source, /taskQueue\.splice\(0,\s*requestedBatchSize\)/)
  assert.match(source, /new Map<number,\s*WorkerTask>\(\)/)
  assert.equal((source.match(/inputSize: task\.inputSize/g) || []).length, 2)
})

test('embedding throughput excludes skipped preprocessing work and paused time', () => {
  const rate = calculateEmbeddingInferenceRate({
    completed: 80,
    failed: 20,
    pending: 400,
    running: 8,
    state: 'running',
    inferenceStartedAt: 1_000,
    inferencePausedTotalMs: 2_000,
    now: 13_000,
  })
  assert.equal(rate.itemsPerSecond, 10)
  assert.equal(rate.activeElapsedMs, 10_000)
  assert.equal(rate.etaMs, 40_800)

  const paused = calculateEmbeddingInferenceRate({
    completed: 100,
    failed: 0,
    pending: 100,
    running: 0,
    state: 'paused',
    inferenceStartedAt: 1_000,
    inferencePausedAt: 11_000,
    now: 21_000,
  })
  assert.equal(paused.itemsPerSecond, 10)
  assert.equal(paused.etaMs, undefined)
})
