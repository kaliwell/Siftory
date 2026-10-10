const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { createCoalescedFrameIndexBuilder } = loadTsModule('electron/mediaFrameEmbeddingState.ts')

test('frame index rebuild requests arriving during a build are drained in a second pass', async () => {
  const scheduled = []
  const resolvers = []
  let builds = 0
  const controller = createCoalescedFrameIndexBuilder(
    () => {
      builds++
      return new Promise((resolve) => resolvers.push(resolve))
    },
    (run) => scheduled.push(run),
    assert.fail,
  )

  controller.request()
  controller.request()
  assert.equal(scheduled.length, 1)
  scheduled.shift()()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(builds, 1)

  controller.request()
  resolvers.shift()()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(builds, 2)
  assert.equal(scheduled.length, 0)

  resolvers.shift()()
  await new Promise((resolve) => setImmediate(resolve))

  controller.request()
  assert.equal(scheduled.length, 1)
})

test('a failed frame index build does not discard a rebuild requested while it was running', async () => {
  const scheduled = []
  const resolvers = []
  const errors = []
  let builds = 0
  const controller = createCoalescedFrameIndexBuilder(
    () => {
      builds++
      return new Promise((resolve, reject) => resolvers.push({ resolve, reject }))
    },
    (run) => scheduled.push(run),
    (error) => errors.push(error),
  )

  controller.request()
  scheduled.shift()()
  await new Promise((resolve) => setImmediate(resolve))
  controller.request()
  resolvers.shift().reject(new Error('first build failed'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(errors.length, 1)
  assert.equal(builds, 2)
  resolvers.shift().resolve()
  await new Promise((resolve) => setImmediate(resolve))
})

test('a throwing scheduler and error reporter do not strand the frame index builder', async () => {
  let scheduleAttempts = 0
  let scheduled
  let builds = 0
  const reported = []
  const controller = createCoalescedFrameIndexBuilder(
    async () => {
      builds += 1
    },
    (run) => {
      scheduleAttempts += 1
      if (scheduleAttempts === 1) throw new Error('scheduler unavailable')
      scheduled = run
    },
    (error) => {
      reported.push(error)
      throw new Error('reporter unavailable')
    },
  )

  assert.doesNotThrow(() => controller.request())
  assert.equal(controller.isPending(), false)
  assert.equal(reported.length, 1)
  assert.match(reported[0].message, /scheduler unavailable/)

  controller.request()
  assert.equal(controller.isPending(), true)
  scheduled()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(builds, 1)
  assert.equal(controller.isPending(), false)
})

test('a throwing build error reporter still releases pending state for a later request', async () => {
  let scheduled
  let attempts = 0
  let reports = 0
  const controller = createCoalescedFrameIndexBuilder(
    async () => {
      attempts += 1
      if (attempts === 1) throw new Error('build failed')
    },
    (run) => {
      scheduled = run
    },
    () => {
      reports += 1
      throw new Error('reporting failed')
    },
  )

  controller.request()
  scheduled()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reports, 1)
  assert.equal(controller.isPending(), false)

  controller.request()
  scheduled()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(attempts, 2)
  assert.equal(controller.isPending(), false)
})
