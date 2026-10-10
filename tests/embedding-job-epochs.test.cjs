const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  EMBEDDING_JOB_LEASE_TIMEOUT_MS,
  EmbeddingJobEpochLedger,
  hasLiveEmbeddingJobLease,
  nextEmbeddingJobEpoch,
} = loadTsModule('electron/embeddingJobEpochLedger.ts')

const NOW = Date.parse('2026-08-07T00:00:00.000Z')

function job(id, overrides = {}) {
  return {
    id,
    imageId: `C:\\images\\${id}.jpg`,
    path: `C:\\images\\${id}.jpg`,
    status: 'pending',
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    retries: 0,
    createdAt: NOW - 60_000,
    ...overrides,
  }
}

test('new epoch recovers expired leases but preserves a live owner', () => {
  const expired = job(1, {
    status: 'running',
    epoch: 7,
    owner: 'old-run',
    heartbeatAt: NOW - EMBEDDING_JOB_LEASE_TIMEOUT_MS - 1,
  })
  const live = job(2, {
    status: 'running',
    epoch: 8,
    owner: 'live-run',
    heartbeatAt: NOW - 1_000,
  })
  const livePending = job(4, {
    status: 'pending',
    epoch: 8,
    owner: 'live-pending-run',
    heartbeatAt: NOW - 1_000,
  })
  const ledger = new EmbeddingJobEpochLedger([expired, live, job(3), livePending], 'new-run', {
    now: NOW,
  })

  assert.equal(nextEmbeddingJobEpoch([expired, live]), 9)
  assert.equal(ledger.epoch, NOW)
  assert.equal(hasLiveEmbeddingJobLease(live, NOW), true)
  assert.deepEqual(
    ledger.listRunnable('dinov2_vitb14', 'global').map((item) => item.id),
    [1, 3],
  )
  const recovered = ledger.snapshot().find((item) => item.id === 1)
  assert.equal(recovered.status, 'pending')
  assert.equal(recovered.epoch, NOW)
  assert.equal(recovered.owner, undefined)
  assert.equal(ledger.snapshot().find((item) => item.id === 2).owner, 'live-run')
  assert.equal(
    ledger.reconcileExisting(
      new Set(['C:\\images\\2.jpg']),
      'dinov2_vitb14',
      'global',
      NOW,
    ),
    0,
  )
})

test('epoch and owner fence late completion from a previous build', () => {
  const first = new EmbeddingJobEpochLedger([job(1, { epoch: 2 })], 'run-a', { now: NOW })
  const claimedA = first.claim(1, NOW)
  const tokenA = { epoch: claimedA.epoch, owner: claimedA.owner }
  first.heartbeat(NOW + 5_000)
  const checkpoint = first.takeDirtySnapshot()

  const restartAt = NOW + 5_000 + EMBEDDING_JOB_LEASE_TIMEOUT_MS + 1
  const second = new EmbeddingJobEpochLedger(checkpoint, 'run-b', { now: restartAt })
  const claimedB = second.claim(1, restartAt)
  const tokenB = { epoch: claimedB.epoch, owner: claimedB.owner }

  assert.equal(second.complete(1, tokenA, restartAt + 1), false)
  assert.equal(second.complete(1, tokenB, restartAt + 2), true)
  assert.equal(second.snapshot()[0].status, 'completed')
  assert.equal(second.snapshot()[0].owner, 'run-b')
})

test('heartbeat checkpoint makes crash recovery deterministic and reconciliation closes persisted work', () => {
  const first = new EmbeddingJobEpochLedger([job(1), job(2)], 'run-a', { now: NOW })
  const claimedOne = first.claim(1, NOW)
  const claimedTwo = first.claim(2, NOW)
  first.heartbeat(NOW + 10_000)
  const persistedCheckpoint = first.takeDirtySnapshot()

  // The vector for job 1 commits after the last job snapshot, then the process
  // crashes. The next process sees the last checkpoint, expires both leases,
  // and reconciles job 1 from the authoritative embedding shard.
  first.complete(1, { epoch: claimedOne.epoch, owner: claimedOne.owner }, NOW + 11_000)
  const restartAt = NOW + 10_000 + EMBEDDING_JOB_LEASE_TIMEOUT_MS + 1
  const restarted = new EmbeddingJobEpochLedger(persistedCheckpoint, 'run-b', { now: restartAt })
  assert.equal(
    restarted.reconcileExisting(
      new Set(['C:\\images\\1.jpg']),
      'dinov2_vitb14',
      'global',
      restartAt,
    ),
    1,
  )
  assert.deepEqual(
    restarted.listRunnable('dinov2_vitb14', 'global').map((item) => item.id),
    [2],
  )
  assert.equal(restarted.snapshot().find((item) => item.id === 1).status, 'completed')
  assert.equal(claimedTwo.status, 'running')
})

test('failed, skipped, and released jobs transition through one owned epoch', () => {
  const ledger = new EmbeddingJobEpochLedger([job(1), job(2), job(3)], 'run-a', { now: NOW })
  const failed = ledger.claim(1, NOW)
  const released = ledger.claim(2, NOW)
  assert.equal(
    ledger.fail(1, { epoch: failed.epoch, owner: failed.owner }, 'decode failed', NOW + 1),
    true,
  )
  assert.equal(ledger.skip(3, 'unsupported input', NOW + 2), true)
  assert.equal(ledger.release(NOW + 3), 1)

  const snapshot = ledger.snapshot()
  assert.equal(snapshot.find((item) => item.id === 1).status, 'failed')
  assert.equal(snapshot.find((item) => item.id === 1).retries, 1)
  assert.equal(snapshot.find((item) => item.id === 2).status, 'pending')
  assert.equal(snapshot.find((item) => item.id === 2).owner, undefined)
  assert.equal(snapshot.find((item) => item.id === 3).status, 'skipped')
  assert.equal(released.owner, 'run-a')
})

test('job selection and reconciliation use canonical path identity', () => {
  const ledger = new EmbeddingJobEpochLedger(
    [job(1, { imageId: 'C:\\Images\\A.jpg' }), job(2)],
    'run-a',
    { now: NOW },
  )
  const requested = new Set(['c:/IMAGES/a.jpg'])
  assert.deepEqual(
    ledger.listMatching('dinov2_vitb14', 'global', requested).map((item) => item.id),
    [1],
  )
  assert.deepEqual(
    ledger.listRunnable('dinov2_vitb14', 'global', requested).map((item) => item.id),
    [1],
  )
  assert.equal(
    ledger.reconcileExisting(
      new Set(['c:/images/A.jpg']),
      'dinov2_vitb14',
      'global',
      NOW,
    ),
    1,
  )
  assert.equal(ledger.snapshot().find((item) => item.id === 1).status, 'completed')
})

test('embedding runtime wires epoch claims, heartbeat snapshots, fencing, and terminal compaction', () => {
  const service = fs.readFileSync(
    path.resolve(__dirname, '../electron/embeddingService.ts'),
    'utf8',
  )
  const session = fs.readFileSync(
    path.resolve(__dirname, '../electron/embeddingJobLedgerSession.ts'),
    'utf8',
  )
  assert.match(service, /jobLedgerSession\.start\(jobs, buildRunId\)/)
  assert.match(session, /new EmbeddingJobEpochLedger\(jobs, owner\)/)
  assert.match(session, /this\.current\?\.heartbeat\(\)/)
  assert.match(session, /this\.current\?\.complete\(jobId, lease\)/)
  assert.match(session, /this\.current\?\.fail\(jobId, lease, error\)/)
  assert.match(session, /selectRetainedEmbeddingJobs\(ledger\.snapshot\(\), Date\.now\(\)\)/)
})
