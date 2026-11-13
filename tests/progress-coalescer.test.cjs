const assert = require('node:assert/strict')
const test = require('node:test')
const { setTimeout: delay } = require('node:timers/promises')
const { loadTsModule } = require('./guard-utils.cjs')
const { createProgressCoalescer } = loadTsModule('electron/progressCoalescer.ts')
test('progress bursts deliver the latest state and terminal events cancel stale delivery', async () => {
  let value = 0
  const received = []
  const emit = createProgressCoalescer(() => received.push(value), 20)
  emit('indexing')
  for (value = 1; value < 100; value++) emit('indexing')
  assert.deepEqual(received, [0])
  await delay(40)
  assert.deepEqual(received, [0, 100])
  emit('indexing')
  value = 101
  emit()
  assert.deepEqual(received, [0, 100, 101])
  await delay(40)
  assert.deepEqual(received, [0, 100, 101])
})

test('new task and phase transitions remain immediate even with pending progress', async () => {
  let value = 'first'
  const received = []
  const emit = createProgressCoalescer(() => received.push(value), 20)
  emit('task-1:scan')
  value = 'intermediate'
  emit('task-1:scan')
  value = 'phase'
  emit('task-1:embed')
  value = 'new-task'
  emit('task-2:scan')
  value = 'done'
  emit()
  await delay(40)
  assert.deepEqual(received, ['first', 'phase', 'new-task', 'done'])
})
