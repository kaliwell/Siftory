const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { VideoSemanticDatabase } = loadTsModule('electron/videoSemanticDatabase.ts')
const { VideoSemanticJobService } = loadTsModule('electron/videoSemanticJobService.ts')

function scope() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-semantic-job-'))
  const database = new VideoSemanticDatabase(path.join(dir, 'video-semantic.sqlite'))
  const service = new VideoSemanticJobService(database)
  return {
    database,
    service,
    close() {
      database.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function segments(count = 3, frameCount = 6) {
  return Array.from({ length: count }, (_, index) => ({
    segmentId: `segment-${index + 1}`,
    startMs: index * 10_000,
    endMs: index * 10_000 + 9_000,
    evidenceFrameIds: Array.from({ length: frameCount }, (__, frame) =>
      (index * frameCount + frame + 1).toString(16).padStart(40, '0'),
    ),
    evidenceFrameDigest: `digest-${index + 1}`,
  }))
}

function create(service, generationId = 'generation-1', plan = segments(), now = 100) {
  return service.createJob({
    assetId: 'asset-1',
    videoId: 'video-1',
    generationId,
    profileId: 'general',
    segments: plan,
    now,
  })
}

test('job creation is deterministic and the same plan resumes the same record', () => {
  const testScope = scope()
  try {
    const first = create(testScope.service)
    const second = create(testScope.service, 'generation-1', [...segments()], 999)
    assert.equal(first.jobId, second.jobId)
    assert.equal(second.createdAt, 100)
    assert.equal(second.state, 'queued')
    assert.deepEqual(
      second.segments.map((item) => item.segmentId),
      ['segment-1', 'segment-2', 'segment-3'],
    )
  } finally {
    testScope.close()
  }
})

test('job retries twice and progressively reduces evidence before continuing', async () => {
  const testScope = scope()
  try {
    const job = create(testScope.service)
    const attempts = []
    const completed = await testScope.service.runJob(
      job.jobId,
      ({ segment, attempt, reducedEvidence }) => {
        attempts.push({
          id: segment.segmentId,
          attempt,
          frames: segment.evidenceFrameIds.length,
          reducedEvidence,
        })
        if (segment.segmentId === 'segment-2' && attempt < 3) throw new Error('transient failure')
      },
    )
    assert.equal(completed.state, 'done')
    assert.equal(completed.completedSegments, 3)
    assert.equal(completed.failedSegments, 0)
    assert.equal(completed.cursor, 3)
    assert.equal(completed.attemptsBySegment['segment-2'], 3)
    assert.deepEqual(
      attempts.filter((entry) => entry.id === 'segment-2').map((entry) => entry.frames),
      [6, 4, 2],
    )
    assert.equal(
      attempts.find((entry) => entry.id === 'segment-2' && entry.attempt === 2).reducedEvidence,
      true,
    )
    assert.equal(
      attempts.find((entry) => entry.id === 'segment-2' && entry.attempt === 3).reducedEvidence,
      true,
    )
  } finally {
    testScope.close()
  }
})

test('permanent segment failure is recorded after three attempts and does not abort the video', async () => {
  const testScope = scope()
  try {
    const job = create(testScope.service)
    const completed = await testScope.service.runJob(job.jobId, ({ segment }) => {
      if (segment.segmentId === 'segment-2') throw new Error('permanent failure')
    })
    assert.equal(completed.state, 'done')
    assert.equal(completed.completedSegments, 2)
    assert.equal(completed.failedSegments, 1)
    assert.equal(completed.cursor, 3)
    assert.equal(completed.lastError, 'permanent failure')
  } finally {
    testScope.close()
  }
})

test('stop persists after the current segment and resume processes only the remaining cursor', async () => {
  const testScope = scope()
  try {
    const job = create(testScope.service)
    const firstRun = []
    const stopped = await testScope.service.runJob(job.jobId, async ({ segment }) => {
      firstRun.push(segment.segmentId)
      if (segment.segmentId === 'segment-1') testScope.service.requestStop(job.jobId, 200)
    })
    assert.equal(stopped.state, 'stopped')
    assert.equal(stopped.cursor, 1)
    assert.deepEqual(firstRun, ['segment-1'])

    const replacementService = new VideoSemanticJobService(testScope.database)
    replacementService.resumeJob(job.jobId, 300)
    const secondRun = []
    const done = await replacementService.runJob(job.jobId, ({ segment }) => {
      secondRun.push(segment.segmentId)
    })
    assert.equal(done.state, 'done')
    assert.deepEqual(secondRun, ['segment-2', 'segment-3'])
    assert.equal(done.completedSegments, 3)
  } finally {
    testScope.close()
  }
})

test('startup recovery requeues interrupted running jobs without advancing the cursor', () => {
  const testScope = scope()
  try {
    const job = create(testScope.service)
    testScope.database.putJob({
      ...job,
      state: 'running',
      currentSegmentId: 'segment-1',
      attemptsBySegment: { 'segment-1': 1 },
      updatedAt: 150,
    })
    assert.equal(testScope.service.recoverInterruptedJobs(200), 1)
    const recovered = testScope.service.getJob(job.jobId)
    assert.equal(recovered.state, 'queued')
    assert.equal(recovered.cursor, 0)
    assert.equal(recovered.currentSegmentId, undefined)
    assert.equal(recovered.lastError, 'interrupted-before-terminal-state')
  } finally {
    testScope.close()
  }
})

test('single-video rebuild creates a separate generation job and preserves old checkpoints', () => {
  const testScope = scope()
  try {
    const oldJob = create(testScope.service, 'generation-1')
    const rebuild = create(testScope.service, 'generation-2', segments(), 101)
    assert.notEqual(oldJob.jobId, rebuild.jobId)
    assert.deepEqual(
      testScope.database.listJobs('video-1').map((job) => job.generationId),
      ['generation-1', 'generation-2'],
    )
  } finally {
    testScope.close()
  }
})

test('job plan rejects duplicate ids, invalid ranges, and non-authoritative frame ids', () => {
  const testScope = scope()
  try {
    const duplicate = segments(2)
    duplicate[1].segmentId = duplicate[0].segmentId
    assert.throws(() => create(testScope.service, 'g-duplicate', duplicate))
    assert.throws(() =>
      create(testScope.service, 'g-range', [{ ...segments(1)[0], startMs: 10_000, endMs: 9_000 }]),
    )
    assert.throws(() =>
      create(testScope.service, 'g-frame', [
        { ...segments(1)[0], evidenceFrameIds: ['C:\\outside.jpg'] },
      ]),
    )
  } finally {
    testScope.close()
  }
})
