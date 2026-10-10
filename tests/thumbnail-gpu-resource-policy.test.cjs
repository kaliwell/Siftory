const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { decideThumbnailGpuResources } = loadTsModule(
  'electron/thumbnailGpuResourcePolicy.ts',
)

const GIB = 1024 ** 3

test('thumbnail GPU policy bounds contexts and source bytes across 1/2/8 lane requests', () => {
  assert.deepEqual(
    decideThumbnailGpuResources({
      requestedLanes: 8,
      totalSystemMemoryBytes: 16 * GIB,
      freeSystemMemoryBytes: 8 * GIB,
    }),
    { lanes: 2, inFlightSourceBytes: 96 * 1024 ** 2, reason: 'default' },
  )
  assert.deepEqual(
    decideThumbnailGpuResources({
      requestedLanes: 8,
      totalSystemMemoryBytes: 64 * GIB,
      freeSystemMemoryBytes: 32 * GIB,
    }),
    { lanes: 4, inFlightSourceBytes: 128 * 1024 ** 2, reason: 'high-headroom' },
  )
  assert.deepEqual(
    decideThumbnailGpuResources({
      requestedLanes: 2,
      totalSystemMemoryBytes: 16 * GIB,
      freeSystemMemoryBytes: 2 * GIB,
    }),
    { lanes: 1, inFlightSourceBytes: 64 * 1024 ** 2, reason: 'memory-pressure' },
  )
  assert.equal(
    decideThumbnailGpuResources({
      requestedLanes: 1,
      totalSystemMemoryBytes: 64 * GIB,
      freeSystemMemoryBytes: 32 * GIB,
    }).lanes,
    1,
  )
})
