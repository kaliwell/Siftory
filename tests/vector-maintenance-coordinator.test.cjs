const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const coordinator = loadTsModule('electron/vectorMaintenanceService.ts')

test('vector searches block writers and exclusive maintenance until every reader releases', () => {
  const releaseSearchA = coordinator.tryAcquireVectorSearchReservation()
  const releaseSearchB = coordinator.tryAcquireVectorSearchReservation()

  assert.equal(typeof releaseSearchA, 'function')
  assert.equal(typeof releaseSearchB, 'function')
  assert.equal(coordinator.isVectorSearchReservationActive(), true)
  assert.equal(coordinator.tryAcquireVectorMutationReservation(), null)
  assert.equal(coordinator.isVectorMaintenanceReservationActive(), true)
  assert.equal(coordinator.tryAcquireVectorExclusiveMaintenance(), null)

  releaseSearchA()
  releaseSearchA()
  assert.equal(
    coordinator.isVectorSearchReservationActive(),
    true,
    'a double release must not consume another reader lease',
  )
  assert.equal(coordinator.tryAcquireVectorExclusiveMaintenance(), null)

  releaseSearchB()
  assert.equal(coordinator.isVectorSearchReservationActive(), false)
  const releaseMutation = coordinator.tryAcquireVectorMutationReservation()
  assert.equal(typeof releaseMutation, 'function')
  assert.equal(coordinator.tryAcquireVectorSearchReservation(), null)
  assert.equal(coordinator.tryAcquireVectorExclusiveMaintenance(), null)
  releaseMutation()
  releaseMutation()
  assert.equal(coordinator.isVectorMutationReservationActive(), false)
  assert.equal(coordinator.isVectorMaintenanceReservationActive(), false)
})

test('exclusive vector maintenance blocks new readers and writers and releases exactly once', () => {
  const releaseExclusive = coordinator.tryAcquireVectorExclusiveMaintenance()
  assert.equal(typeof releaseExclusive, 'function')
  assert.equal(coordinator.isVectorExclusiveMaintenanceReserved(), true)
  assert.equal(coordinator.tryAcquireVectorSearchReservation(), null)
  assert.equal(coordinator.tryAcquireVectorMutationReservation(), null)
  assert.equal(coordinator.tryAcquireVectorExclusiveMaintenance(), null)

  const releaseOwnedMutation = coordinator.tryAcquireVectorMutationReservation(releaseExclusive)
  assert.equal(
    typeof releaseOwnedMutation,
    'function',
    'the active exclusive owner may register its nested source-sync write',
  )
  assert.equal(coordinator.isVectorMutationReservationActive(), true)
  assert.equal(coordinator.tryAcquireVectorMutationReservation(), null)
  releaseOwnedMutation()
  assert.equal(coordinator.isVectorMutationReservationActive(), false)

  releaseExclusive()
  releaseExclusive()
  assert.equal(coordinator.isVectorExclusiveMaintenanceReserved(), false)
  assert.equal(coordinator.isVectorMaintenanceReservationActive(), false)

  const releaseSearch = coordinator.tryAcquireVectorSearchReservation()
  assert.equal(typeof releaseSearch, 'function')
  assert.equal(coordinator.tryAcquireVectorMutationReservation(), null)
  releaseSearch()
  const releaseMutation = coordinator.tryAcquireVectorMutationReservation()
  assert.equal(typeof releaseMutation, 'function')
  assert.equal(coordinator.tryAcquireVectorSearchReservation(), null)
  releaseMutation()
  assert.equal(coordinator.isVectorMaintenanceReservationActive(), false)
})
