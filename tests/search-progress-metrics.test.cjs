const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')
const { createSearchProgressMetrics, formatSearchThroughput } = loadTsModule(
  'shared/searchProgress.ts',
)

test('stage throughput and ETA exclude earlier query work and reset across byte/record phases', () => {
  let at = 0
  const metrics = createSearchProgressMetrics(() => at)
  metrics({ phase: 'vector_embedding', scanned: 0 })
  at = 19000
  metrics({ phase: 'vector_search', workStage: 'cache_building', unit: 'bytes', scanned: 0 })
  at = 20000
  const building = metrics({
    phase: 'vector_search',
    workStage: 'cache_building',
    unit: 'bytes',
    scanned: 1048576,
    total: 2097152,
  })
  assert.equal(building.throughputPerSecond, 1048576)
  assert.equal(building.etaMs, 1000)
  assert.equal(formatSearchThroughput(building.throughputPerSecond, 'bytes'), '1.00 MiB/s')
  const compacting = metrics({
    phase: 'vector_search',
    workStage: 'cache_compacting',
    unit: 'records',
    scanned: 0,
    total: 100,
  })
  assert.equal(compacting.throughputPerSecond, undefined)
  assert.equal(compacting.etaMs, undefined)
  at = 21000
  const records = metrics({
    phase: 'vector_search',
    workStage: 'cache_compacting',
    unit: 'records',
    scanned: 50,
    total: 100,
  })
  assert.equal(records.throughputPerSecond, 50)
  assert.equal(records.etaMs, 1000)
  assert.equal(formatSearchThroughput(records.throughputPerSecond, 'records'), '50.00 records/s')
})

test('unknown totals, reset counters and invalid rates cannot produce misleading speed/ETA', () => {
  let at = 0
  const metrics = createSearchProgressMetrics(() => at)
  metrics({ phase: 'hash', scanned: 0 })
  at = 1000
  assert.equal(metrics({ phase: 'hash', scanned: 200 }).throughputPerSecond, undefined)
  metrics({ phase: 'vector_search', unit: 'records', scanned: 0 })
  at = 2000
  assert.equal(metrics({ phase: 'vector_search', unit: 'records', scanned: 50 }).etaMs, undefined)
  const reset = metrics({ phase: 'vector_search', unit: 'records', scanned: 1, total: 100 })
  assert.equal(reset.throughputPerSecond, undefined)
  for (const value of [0, -1, NaN, Infinity, undefined])
    assert.equal(formatSearchThroughput(value, 'bytes'), '')
})
