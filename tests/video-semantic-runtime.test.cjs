const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { VideoSemanticDatabase } = loadTsModule('electron/videoSemanticDatabase.ts')
const { VideoSemanticJobService } = loadTsModule('electron/videoSemanticJobService.ts')
const { VideoSemanticPipelineService } = loadTsModule('electron/videoSemanticPipelineService.ts')
const { FakeVideoSemanticRuntime, VideoSemanticRuntimeRegistry } = loadTsModule(
  'electron/videoSemanticRuntime.ts',
)

const RESOURCE_BUDGET = Object.freeze({
  tier: 'low-vram-4g',
  execution: 'gpu',
  maxConcurrency: 1,
  maxFramesPerSegment: 4,
  preferredFrameWidth: 384,
  contextTokens: 4_096,
  maximumContextTokens: 8_192,
  maximumOutputTokens: 1_024,
  segmentTimeoutMs: 180_000,
  minimumFreeGpuBytes: Math.floor(2.5 * 1024 ** 3),
  systemMemorySoftLimitBytes: 12 * 1024 ** 3,
  gpuLayers: 20,
})

function scope() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-semantic-runtime-'))
  const database = new VideoSemanticDatabase(path.join(dir, 'video-semantic.sqlite'))
  const jobs = new VideoSemanticJobService(database)
  const pipeline = new VideoSemanticPipelineService(database, jobs)
  return {
    database,
    jobs,
    pipeline,
    close() {
      database.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function segments(count = 2, frameCount = 6) {
  return Array.from({ length: count }, (_, index) => ({
    segmentId: `planned-${index + 1}`,
    startMs: index * 10_000,
    endMs: index * 10_000 + 9_000,
    evidenceFrameIds: Array.from({ length: frameCount }, (__, frame) =>
      (index * frameCount + frame + 1).toString(16).padStart(40, '0'),
    ),
    evidenceFrameDigest: `digest-${index + 1}`,
  }))
}

function createJob(jobs, count = 2) {
  return jobs.createJob({
    assetId: 'asset-1',
    videoId: 'video-1',
    generationId: 'generation-1',
    profileId: 'general',
    segments: segments(count),
    now: 100,
  })
}

function evidence(attempt) {
  const duration = attempt.segment.endMs - attempt.segment.startMs
  return {
    frames: attempt.segment.evidenceFrameIds.map((frameId, index, all) => ({
      frameId,
      timestampMs:
        attempt.segment.startMs + Math.floor((duration * index) / Math.max(1, all.length)),
    })),
    untrustedText: [
      {
        kind: 'subtitle',
        sourceRef: `${attempt.segment.segmentId}:subtitle`,
        startMs: attempt.segment.startMs,
        endMs: attempt.segment.endMs,
        text: 'Fixture dialogue',
      },
    ],
  }
}

function validRuntimeOutput() {
  return JSON.stringify({
    summary: 'A bounded retry succeeded.',
    scenes: [],
    events: [],
    persons: [],
    objects: [],
    searchTags: ['retry'],
    visualText: [],
    audioEvents: [],
    warnings: [],
  })
}

test('fake runtime runs a complete job and atomically activates searchable records', async () => {
  const testScope = scope()
  try {
    const job = createJob(testScope.jobs)
    const runtime = new FakeVideoSemanticRuntime()
    const result = await testScope.pipeline.run({
      jobId: job.jobId,
      sourceFingerprint: 'size:100;mtime:200',
      runtime,
      loadEvidence: evidence,
      resourceBudget: RESOURCE_BUDGET,
      now: () => 200,
    })
    assert.equal(result.job.state, 'done')
    assert.equal(result.activated, true)
    assert.equal(result.stagedSegments, 2)
    assert.equal(testScope.database.getActiveGenerationId('video-1'), 'generation-1')
    assert.equal(testScope.database.getActiveSegments('video-1').length, 2)
    assert.equal(testScope.database.getStagedJobResults(job.jobId).length, 0)
    assert.equal(runtime.requests.length, 2)
    assert.equal(runtime.requests[0].prompt.messages[0].role, 'system')
  } finally {
    testScope.close()
  }
})

test('stopped jobs retain staged records and resume without repeating committed segments', async () => {
  const testScope = scope()
  try {
    const job = createJob(testScope.jobs)
    const firstRuntime = new FakeVideoSemanticRuntime((request) => {
      testScope.jobs.requestStop(request.jobId, 150)
      return JSON.stringify({
        summary: 'First staged segment.',
        scenes: [],
        events: [],
        persons: [],
        objects: [],
        searchTags: ['first'],
        visualText: [],
        audioEvents: [],
        warnings: [],
      })
    })
    const stopped = await testScope.pipeline.run({
      jobId: job.jobId,
      sourceFingerprint: 'source-1',
      runtime: firstRuntime,
      loadEvidence: evidence,
      resourceBudget: RESOURCE_BUDGET,
    })
    assert.equal(stopped.job.state, 'stopped')
    assert.equal(stopped.stagedSegments, 1)
    assert.equal(stopped.activated, false)
    assert.equal(testScope.database.getActiveGenerationId('video-1'), null)

    testScope.jobs.resumeJob(job.jobId, 160)
    const secondRuntime = new FakeVideoSemanticRuntime()
    const resumed = await testScope.pipeline.run({
      jobId: job.jobId,
      sourceFingerprint: 'source-1',
      runtime: secondRuntime,
      loadEvidence: evidence,
      resourceBudget: RESOURCE_BUDGET,
    })
    assert.equal(resumed.activated, true)
    assert.equal(firstRuntime.requests.length, 1)
    assert.equal(secondRuntime.requests.length, 1)
    assert.equal(secondRuntime.requests[0].plannedSegmentId, 'planned-2')
    assert.equal(testScope.database.getActiveSegments('video-1').length, 2)
  } finally {
    testScope.close()
  }
})

test('invalid runtime output exhausts bounded retries and never replaces the active generation', async () => {
  const testScope = scope()
  try {
    const job = createJob(testScope.jobs, 1)
    const runtime = new FakeVideoSemanticRuntime(() => '{invalid')
    const result = await testScope.pipeline.run({
      jobId: job.jobId,
      sourceFingerprint: 'source-1',
      runtime,
      loadEvidence: evidence,
      resourceBudget: RESOURCE_BUDGET,
    })
    assert.equal(result.job.state, 'done')
    assert.equal(result.job.failedSegments, 1)
    assert.equal(result.activated, false)
    assert.equal(runtime.requests.length, 3)
    assert.deepEqual(
      runtime.requests.map((request) => request.images.length),
      [4, 4, 2],
    )
    assert.deepEqual(
      runtime.requests.map((request) => request.contextTokens),
      [4_096, 4_096, 8_192],
    )
    assert.ok(runtime.requests.every((request) => request.gpuLayers === 20))
    assert.ok(runtime.requests.every((request) => request.maximumOutputTokens === 1_024))
    assert.equal(testScope.database.getActiveGenerationId('video-1'), null)
  } finally {
    testScope.close()
  }
})

test('a bounded retry raises a caller-limited output budget from 512 to 1024 tokens', async () => {
  const testScope = scope()
  try {
    const job = createJob(testScope.jobs, 1)
    let call = 0
    const runtime = new FakeVideoSemanticRuntime(() => {
      call += 1
      if (call === 1) throw new Error('llama.cpp output truncated at token limit')
      return validRuntimeOutput()
    })
    const result = await testScope.pipeline.run({
      jobId: job.jobId,
      sourceFingerprint: 'source-1',
      runtime,
      loadEvidence: evidence,
      resourceBudget: RESOURCE_BUDGET,
      maximumOutputTokens: 512,
    })
    assert.equal(result.activated, true)
    assert.deepEqual(
      runtime.requests.map((request) => request.maximumOutputTokens),
      [512, 1_024],
    )
  } finally {
    testScope.close()
  }
})

test('unavailable runtime pauses without loading evidence or changing active data', async () => {
  const testScope = scope()
  try {
    const job = createJob(testScope.jobs, 1)
    let loaded = false
    const runtime = {
      adapterId: 'missing',
      inspect: () => ({ adapterId: 'missing', state: 'not-installed', reason: 'model-missing' }),
      generate: async () => {
        throw new Error('must not generate')
      },
    }
    const result = await testScope.pipeline.run({
      jobId: job.jobId,
      sourceFingerprint: 'source-1',
      runtime,
      resourceBudget: RESOURCE_BUDGET,
      loadEvidence: () => {
        loaded = true
        return { frames: [] }
      },
    })
    assert.equal(result.job.state, 'paused')
    assert.equal(result.job.lastError, 'model-missing')
    assert.equal(loaded, false)
  } finally {
    testScope.close()
  }
})

test('runtime registry replaces adapters and disposes the previous instance', async () => {
  let disposed = false
  const first = new FakeVideoSemanticRuntime()
  first.dispose = () => {
    disposed = true
  }
  const second = new FakeVideoSemanticRuntime()
  const registry = new VideoSemanticRuntimeRegistry(first)
  await registry.replace(second)
  assert.equal(disposed, true)
  assert.equal(registry.get(), second)
})
