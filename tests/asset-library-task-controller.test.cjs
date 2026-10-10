const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { AssetLibraryTaskController, taskPercent } = loadTsModule(
  'electron/assetLibraryTaskController.ts',
)

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.fail('condition was not reached')
}

test('task percent clamps invalid and out-of-range progress', () => {
  assert.equal(taskPercent(5, 10), 50)
  assert.equal(taskPercent(-1, 10), 0)
  assert.equal(taskPercent(20, 10), 100)
  assert.equal(taskPercent(1, 0), 0)
})

test('task controller publishes lifecycle progress and rejects concurrent tasks', async () => {
  const controller = new AssetLibraryTaskController()
  const events = []
  let finish
  controller.setProgressListener((progress) => events.push(progress))
  const first = controller.startTask(
    'sync',
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )

  assert.equal(first.ok, true)
  assert.equal(controller.startTask('clustering', async () => 'unused').ok, false)
  assert.equal(events.at(-1).state, 'running')
  finish('Synced')
  await waitFor(() => controller.getProgress()?.state === 'done')
  assert.equal(controller.getProgress().message, 'Synced')
  assert.equal(controller.getProgress().percent, 100)
})

test('task controller stops only a matching task and mirrors worker cancellation', async () => {
  const controller = new AssetLibraryTaskController()
  let release
  let cancelled = 0
  const started = controller.startTask(
    'clustering',
    (task) =>
      new Promise((resolve) => {
        release = () => resolve(task.cancelled ? 'Stopped' : 'Done')
      }),
  )

  assert.equal(controller.stopTask('different-task').ok, false)
  assert.equal(controller.stopTask(started.taskId, () => (cancelled += 1)).ok, true)
  assert.equal(cancelled, 1)
  assert.equal(controller.getProgress().message, 'Stopping...')
  release()
  await waitFor(() => controller.getProgress()?.state === 'stopped')
})

test('task controller serializes mutations and blocks tasks while writes are pending', async () => {
  const controller = new AssetLibraryTaskController()
  const order = []
  let release
  const first = controller.runMutation(
    () =>
      new Promise((resolve) => {
        order.push('first-start')
        release = () => {
          order.push('first-end')
          resolve('first')
        }
      }),
  )
  const second = controller.runMutation(() => {
    order.push('second')
    return 'second'
  })

  await waitFor(() => order.length === 1)
  assert.equal(controller.startTask('sync', async () => 'unused').ok, false)
  release()
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.deepEqual(order, ['first-start', 'first-end', 'second'])
  assert.equal(controller.hasPendingMutations(), false)
})
