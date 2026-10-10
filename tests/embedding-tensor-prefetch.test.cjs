const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const policy = loadTsModule('electron/embeddingTensorPrefetchPolicy.ts')

const GIB = 1024 ** 3

function decide(overrides = {}) {
  return policy.decideEmbeddingTensorPrefetch({
    requested: true,
    backend: 'gpu',
    paused: false,
    stopping: false,
    queueLength: 100,
    assignedTasks: 4,
    batchSize: 4,
    freeSystemMemoryBytes: 2 * GIB,
    ...overrides,
  })
}

test('tensor prefetch stays default-off and requires an explicit diagnostic override', () => {
  assert.equal(policy.embeddingTensorPrefetchRequested({}), false)
  assert.equal(
    policy.embeddingTensorPrefetchRequested({ REASONIX_EMBEDDING_TENSOR_PREFETCH: '1' }),
    true,
  )
  assert.equal(
    policy.embeddingTensorPrefetchRequested({ REASONIX_EMBEDDING_TENSOR_PREFETCH: '0' }),
    false,
  )
  assert.deepEqual(decide(), { allowed: true, reason: 'enabled' })
  assert.equal(decide({ requested: false }).reason, 'not-requested')
  assert.equal(decide({ backend: 'cpu' }).reason, 'unsupported-backend')
  assert.equal(decide({ backend: 'cuda' }).reason, 'unsupported-backend')
  assert.equal(decide({ assignedTasks: 0 }).reason, 'lookahead-full')
  assert.equal(decide({ assignedTasks: 5 }).reason, 'lookahead-full')
  assert.equal(decide({ batchSize: 17 }).reason, 'invalid-batch-size')
})

test('tensor prefetch stops at pause, stop, empty queue, and low memory boundaries', () => {
  assert.equal(decide({ paused: true }).reason, 'paused')
  assert.equal(decide({ stopping: true }).reason, 'stopping')
  assert.equal(decide({ queueLength: 0 }).reason, 'queue-empty')
  assert.equal(
    decide({ freeSystemMemoryBytes: policy.EMBEDDING_TENSOR_PREFETCH_MIN_FREE_BYTES - 1 }).reason,
    'low-system-memory',
  )
})

test('prepared tensor payload accounting is typed-array-only and bounded', () => {
  assert.equal(
    policy.embeddingTensorPayloadBytes({
      pixels: { data: new Float32Array(12) },
      ids: { data: new BigInt64Array(3) },
      ignored: { data: [1, 2, 3] },
    }),
    72,
  )
  assert.ok(
    policy.embeddingTensorPayloadBytes({
      oversized: { data: new Uint8Array(policy.EMBEDDING_TENSOR_PREFETCH_MAX_BYTES + 1) },
    }) > policy.EMBEDDING_TENSOR_PREFETCH_MAX_BYTES,
  )
})

test('CLIP protocol keeps a single prepared batch and production dispatch owns admission', () => {
  const root = path.join(__dirname, '..')
  const child = fs.readFileSync(path.join(root, 'electron', 'clipEmbeddingChild.ts'), 'utf8')
  const service = fs.readFileSync(path.join(root, 'electron', 'embeddingService.ts'), 'utf8')
  const dino = fs.readFileSync(path.join(root, 'electron', 'dinoEmbeddingChild.ts'), 'utf8')

  assert.match(child, /prefetchedBatch:[\s\S]*?\| null = null/)
  assert.match(child, /type: 'prefetch-request', depth: 1/)
  assert.match(child, /type: 'control'[\s\S]*?action: 'pause' \| 'resume'/)
  assert.match(child, /readClipTensorPrefetchImage/)
  assert.match(service, /decideEmbeddingTensorPrefetch/)
  assert.match(service, /freeSystemMemoryBytes: os\.freemem\(\)/)
  assert.doesNotMatch(dino, /REASONIX_EMBEDDING_TENSOR_PREFETCH/)
})
