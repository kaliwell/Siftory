const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { decideEmbeddingRuntimeResources } = loadTsModule(
  'electron/embeddingRuntimeResourcePolicy.ts',
)
const GIB = 1024 ** 3

function decide(overrides = {}) {
  return decideEmbeddingRuntimeResources({
    backend: 'gpu',
    modelName: 'dinov2_vitb14',
    batchMode: 'auto',
    currentBatchSize: 8,
    currentConcurrency: 2,
    providerConcurrencyLimit: 2,
    freeSystemMemoryBytes: 8 * GIB,
    totalSystemMemoryBytes: 16 * GIB,
    freeVideoMemoryBytes: 4 * GIB,
    totalVideoMemoryBytes: 8 * GIB,
    ...overrides,
  })
}

test('high live RAM and VRAM preserve GPU overlap and auto batch capacity', () => {
  const result = decide()
  assert.equal(result.concurrency, 2)
  assert.equal(result.batchSize, 16)
  assert.equal(result.constrained, false)
})

test('memory and VRAM pressure bound new work without dropping the active batch', () => {
  for (const reason of ['memory', 'vram']) {
    const result = decide({ pressureReasons: [reason] })
    assert.equal(result.concurrency, 1)
    assert.equal(result.batchSize, 4)
    assert.equal(result.constrained, true)
  }
})

test('stable 16 GiB headroom preserves two workers while selecting a bounded auto batch', () => {
  const result = decide({
    freeSystemMemoryBytes: 5 * GIB,
    totalSystemMemoryBytes: 16 * GIB,
    freeVideoMemoryBytes: 2.5 * GIB,
    totalVideoMemoryBytes: 4 * GIB,
  })
  assert.equal(result.concurrency, 2)
  assert.equal(result.batchSize, 8)
  assert.equal(result.constrained, false)
  assert.equal(result.reason, 'stable-live-headroom')
})

test('high headroom restores provider concurrency after a constrained sample', () => {
  const constrained = decide({
    freeSystemMemoryBytes: 2 * GIB,
    currentConcurrency: 2,
  })
  assert.equal(constrained.concurrency, 1)
  assert.equal(constrained.batchSize, 4)

  const recovered = decide({ currentConcurrency: constrained.concurrency })
  assert.equal(recovered.concurrency, 2)
  assert.equal(recovered.batchSize, 16)
})

test('invalid concurrency telemetry fails closed to one worker', () => {
  const result = decide({
    currentConcurrency: Number.NaN,
    providerConcurrencyLimit: Number.NaN,
  })
  assert.equal(result.concurrency, 1)
  assert.equal(result.batchSize, 16)
})

test('manual/default batch selections are never rewritten by live policy', () => {
  assert.equal(
    decide({ batchMode: 'manual', currentBatchSize: 3, pressureReasons: ['memory'] }).batchSize,
    3,
  )
  assert.equal(
    decide({ batchMode: 'default', currentBatchSize: 4, pressureReasons: ['vram'] }).batchSize,
    4,
  )
})

test('embedding service retires only idle workers and keeps queued tasks', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'embeddingService.ts'),
    'utf8',
  )
  assert.match(source, /if \(\(assignments\.get\(child\)\?\.size \|\| 0\) > 0\) continue/)
  assert.match(source, /for \(const task of taskQueue\) task\.batchSize = decision\.batchSize/)
  assert.doesNotMatch(source, /applyEmbeddingRuntimeResourcePressure[\s\S]*?taskQueue\s*=\s*\[\]/)
})
