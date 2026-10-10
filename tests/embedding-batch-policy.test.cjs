const assert = require('node:assert/strict')
const test = require('node:test')

const { loadTsModule } = require('./guard-utils.cjs')
const { parseNvidiaSmiMemory, selectEmbeddingBatchSize } = loadTsModule(
  'electron/embeddingBatchPolicy.ts',
)

const GIB = 1024 ** 3

function select(overrides = {}) {
  return selectEmbeddingBatchSize({
    requestedBatchSize: 0,
    backend: 'gpu',
    modelName: 'clip_vit_base_patch32',
    maxConcurrency: 2,
    freeSystemMemoryBytes: 8 * GIB,
    totalSystemMemoryBytes: 16 * GIB,
    freeVideoMemoryBytes: 4 * GIB,
    totalVideoMemoryBytes: 4 * GIB,
    ...overrides,
  })
}

test('manual batch values are preserved and clamped independently of memory', () => {
  assert.deepEqual(select({ requestedBatchSize: 2 }).batchSize, 2)
  assert.deepEqual(select({ requestedBatchSize: 20 }).batchSize, 16)
  assert.equal(select({ requestedBatchSize: 2 }).mode, 'manual')
})

test('missing batch keeps the legacy batch 4 while explicit zero enables Auto', () => {
  assert.equal(select({ requestedBatchSize: undefined }).batchSize, 4)
  assert.equal(select({ requestedBatchSize: undefined }).mode, 'default')
  assert.equal(select().batchSize, 16)
  assert.equal(select().mode, 'auto')
})

test('Auto selects 16, 8, or 4 from live RAM and VRAM headroom', () => {
  assert.equal(select().batchSize, 16)
  assert.equal(select({ freeSystemMemoryBytes: 4.8 * GIB }).batchSize, 8)
  assert.equal(select({ freeSystemMemoryBytes: 3.5 * GIB }).batchSize, 4)
  assert.equal(select({ freeVideoMemoryBytes: 2.5 * GIB }).batchSize, 8)
  assert.equal(select({ freeVideoMemoryBytes: 2 * GIB }).batchSize, 4)
})

test('Auto remains conservative for CPU and unbenchmarked CUDA runtimes', () => {
  assert.equal(select({ backend: 'cpu' }).batchSize, 4)
  assert.equal(select({ backend: 'cuda' }).batchSize, 4)
})

test('NVIDIA CSV telemetry parser selects the adapter with most free VRAM', () => {
  const memory = parseNvidiaSmiMemory('1024, 4096\r\n6144, 8192\r\n')
  assert.deepEqual(memory, {
    freeVideoMemoryBytes: 6144 * 1024 * 1024,
    totalVideoMemoryBytes: 8192 * 1024 * 1024,
  })
  assert.equal(parseNvidiaSmiMemory('not available'), null)
})

test('renderer exposes Auto and removes unreachable child-process batch values', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const controls = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'EmbeddingBuildControls.tsx'),
    'utf8',
  )
  const panel = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'ImageSearchPanel.tsx'),
    'utf8',
  )
  assert.match(controls, /<option value=\{0\}>\{t\('Auto'\)\}<\/option>/)
  assert.doesNotMatch(controls, /18, 20/)
  assert.match(
    panel,
    /const batchSize = useStore\(\(s\) => s\.imageSearchUiPreferences\.embeddingBatchSize\)/,
  )
  assert.match(panel, /setImageSearchUiPreferences\(\{ embeddingBatchSize: value \}\)/)
  assert.doesNotMatch(panel, /localStorage/)
})
