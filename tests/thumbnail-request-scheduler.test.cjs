const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { BoundedBatchScheduler } = loadTsModule('src/utils/boundedBatchScheduler.ts')

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('thumbnail scheduler batches and de-duplicates matching requests', async () => {
  const batches = []
  const scheduler = new BoundedBatchScheduler({
    batchSize: 4,
    delayMs: 0,
    maxQueued: 8,
    keyOf: (input) => input.key,
    loadBatch: async (inputs) => {
      batches.push(inputs.map((input) => input.key))
      return new Map(inputs.map((input) => [input.key, `loaded:${input.key}`]))
    },
  })
  const [first, duplicate] = await Promise.all([
    scheduler.request({ key: 'a' }),
    scheduler.request({ key: 'a' }),
  ])
  assert.equal(first, 'loaded:a')
  assert.equal(duplicate, 'loaded:a')
  assert.deepEqual(batches, [['a']])
})

test('thumbnail scheduler removes aborted queued work before loading', async () => {
  const loaded = []
  const scheduler = new BoundedBatchScheduler({
    batchSize: 4,
    delayMs: 2,
    maxQueued: 8,
    keyOf: (input) => input,
    loadBatch: async (inputs) => {
      loaded.push(...inputs)
      return new Map(inputs.map((input) => [input, input]))
    },
  })
  const controller = new AbortController()
  const result = scheduler.request('stale', { signal: controller.signal })
  controller.abort()
  assert.equal(await result, null)
  await tick()
  assert.deepEqual(loaded, [])
})

test('thumbnail scheduler bounds queue and keeps newer high-priority work', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const loaded = []
  const scheduler = new BoundedBatchScheduler({
    batchSize: 1,
    delayMs: 0,
    maxQueued: 2,
    keyOf: (input) => input,
    loadBatch: async (inputs) => {
      loaded.push(...inputs)
      if (inputs[0] === 'blocking') await gate
      return new Map(inputs.map((input) => [input, input]))
    },
  })
  const blocking = scheduler.request('blocking')
  await tick()
  const stale = scheduler.request('stale', { priority: 0 })
  const current = scheduler.request('current', { priority: 10 })
  const newest = scheduler.request('newest', { priority: 10 })
  assert.equal(scheduler.queuedCount(), 2)
  assert.equal(await stale, null)
  release()
  assert.equal(await blocking, 'blocking')
  assert.deepEqual(await Promise.all([current, newest]), ['current', 'newest'])
  assert.deepEqual(loaded, ['blocking', 'current', 'newest'])
})

test('thumbnail scheduler drops 1000 fast-scroll requests that leave the viewport', async () => {
  const loaded = []
  const scheduler = new BoundedBatchScheduler({
    batchSize: 16,
    delayMs: 2,
    maxQueued: 64,
    keyOf: (input) => input,
    loadBatch: async (inputs) => {
      loaded.push(...inputs)
      return new Map(inputs.map((input) => [input, input]))
    },
  })
  const stale = []
  for (let index = 0; index < 980; index += 1) {
    const controller = new AbortController()
    stale.push(scheduler.request(`stale-${index}`, { signal: controller.signal }))
    controller.abort()
  }
  const current = Array.from({ length: 20 }, (_, index) => scheduler.request(`current-${index}`))
  assert.ok((await Promise.all(stale)).every((result) => result === null))
  assert.equal(scheduler.queuedCount(), 20)
  assert.deepEqual(
    await Promise.all(current),
    Array.from({ length: 20 }, (_, i) => `current-${i}`),
  )
  assert.equal(loaded.length, 20)
})
