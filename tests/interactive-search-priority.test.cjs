const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')
const priority = loadTsModule('electron/interactiveSearchPriority.ts')
const tick = () => new Promise((resolve) => queueMicrotask(resolve))

test('multiple queries defer background work until the last query releases', async (t) => {
  let resumes = 0
  const off = priority.onInteractiveSearchIdle(() => {
    resumes++
  })
  t.after(off)
  const first = priority.reserveInteractiveSearch()
  const second = priority.reserveInteractiveSearch()
  assert.equal(priority.isInteractiveSearchActive(), true)
  first()
  first()
  await tick()
  assert.equal(resumes, 0)
  assert.equal(priority.isInteractiveSearchActive(), true)
  second()
  await tick()
  assert.equal(priority.isInteractiveSearchActive(), false)
  assert.equal(resumes, 1)
})

test('a new query before idle notification prevents an accidental background restart', async (t) => {
  let resumes = 0
  t.after(
    priority.onInteractiveSearchIdle(() => {
      resumes++
    }),
  )
  const first = priority.reserveInteractiveSearch()
  first()
  const second = priority.reserveInteractiveSearch()
  await tick()
  assert.equal(resumes, 0)
  second()
  await tick()
  assert.equal(resumes, 1)
})

test('query reservation follows maintenance admission and always releases in a failing query', async () => {
  const coordinator = loadTsModule('electron/vectorMaintenanceService.ts')
  const exclusive = coordinator.tryAcquireVectorExclusiveMaintenance()
  assert.equal(coordinator.tryAcquireVectorSearchReservation(), null)
  assert.equal(priority.isInteractiveSearchActive(), false)
  exclusive()
  await assert.rejects(async () => {
    const release = coordinator.tryAcquireVectorSearchReservation()
    try {
      assert.equal(priority.isInteractiveSearchActive(), true)
      throw Error('query decode failed')
    } finally {
      release()
    }
  }, /query decode failed/)
  await tick()
  assert.equal(priority.isInteractiveSearchActive(), false)
  const writer = coordinator.tryAcquireVectorMutationReservation()
  assert.equal(typeof writer, 'function')
  writer()
})
