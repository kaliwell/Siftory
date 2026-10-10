const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { UnifiedTaskScheduler } = loadTsModule('electron/unifiedTaskScheduler.ts')
const { VideoSemanticDatabase } = loadTsModule('electron/videoSemanticDatabase.ts')
const { VideoSemanticJobService } = loadTsModule('electron/videoSemanticJobService.ts')
const { decideVideoSemanticResources, queueVideoSemanticJob } = loadTsModule(
  'electron/videoSemanticTaskScheduling.ts',
)

const GIB = 1024 * 1024 * 1024

function fixture(frameCount = 12) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-semantic-scheduling-'))
  const database = new VideoSemanticDatabase(path.join(dir, 'video-semantic.sqlite'))
  const jobService = new VideoSemanticJobService(database)
  const job = jobService.createJob({
    assetId: 'asset-1',
    videoId: 'video-1',
    generationId: 'generation-1',
    profileId: 'general',
    segments: [
      {
        segmentId: 'segment-1',
        startMs: 0,
        endMs: 10_000,
        evidenceFrameIds: Array.from({ length: frameCount }, (_, index) =>
          (index + 1).toString(16).padStart(40, '0'),
        ),
        evidenceFrameDigest: 'digest-1',
      },
    ],
    now: 100,
  })
  return {
    database,
    jobService,
    job,
    close() {
      database.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('resource decision selects the bounded 4 GiB profile used by this device', () => {
  const decision = decideVideoSemanticResources({
    gpuTotalBytes: 4 * GIB,
    gpuFreeBytes: 3.5 * GIB,
    systemMemoryTotalBytes: 16 * GIB,
  })
  assert.equal(decision.state, 'ready')
  assert.equal(decision.budget.tier, 'low-vram-4g')
  assert.equal(decision.budget.execution, 'gpu')
  assert.equal(decision.budget.maxConcurrency, 1)
  assert.equal(decision.budget.maxFramesPerSegment, 4)
  assert.equal(decision.budget.contextTokens, 8_192)
  assert.equal(decision.budget.maximumContextTokens, 16_384)
  assert.equal(decision.budget.maximumOutputTokens, 1_024)
  assert.equal(decision.budget.minimumFreeGpuBytes, Math.floor(2.5 * 1024 ** 3))
  assert.equal(decision.budget.gpuLayers, 20)
  assert.equal(decision.budget.segmentTimeoutMs, 180_000)
})

test('insufficient free VRAM pauses a job without invoking the processor', async () => {
  const testFixture = fixture(8)
  try {
    let calls = 0
    const result = await queueVideoSemanticJob({
      jobService: testFixture.jobService,
      jobId: testFixture.job.jobId,
      resourceProbe: () => ({
        gpuTotalBytes: 4 * GIB,
        gpuFreeBytes: 2 * GIB,
        systemMemoryTotalBytes: 16 * GIB,
      }),
      processor: () => {
        calls += 1
      },
    })
    assert.equal(result.state, 'waiting-gpu')
    assert.equal(result.job.state, 'paused')
    assert.equal(result.job.cursor, 0)
    assert.equal(calls, 0)
  } finally {
    testFixture.close()
  }
})

test('video semantic work waits behind embedding in the shared single GPU lane', async () => {
  const testFixture = fixture(12)
  const scheduler = new UnifiedTaskScheduler({ localConcurrency: 1, gpuConcurrency: 1 })
  let releaseEmbedding
  const embeddingGate = new Promise((resolve) => {
    releaseEmbedding = resolve
  })
  const embedding = scheduler.enqueue({ stage: 'embedding', run: () => embeddingGate })
  let processorStarted = false
  try {
    const semantic = queueVideoSemanticJob({
      scheduler,
      jobService: testFixture.jobService,
      jobId: testFixture.job.jobId,
      authorizedPaths: ['D:\\authorized\\video.mp4'],
      resourceProbe: () => ({
        gpuTotalBytes: 4 * GIB,
        gpuFreeBytes: 3.5 * GIB,
        systemMemoryTotalBytes: 16 * GIB,
      }),
      processor: ({ segment, budget }) => {
        processorStarted = true
        assert.equal(budget.maxConcurrency, 1)
        assert.equal(segment.evidenceFrameIds.length, 4)
        assert.equal(segment.evidenceFrameIds[0], '1'.padStart(40, '0'))
        assert.equal(segment.evidenceFrameIds.at(-1), 'c'.padStart(40, '0'))
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(processorStarted, false)
    assert.equal(scheduler.stats().lanes.gpu.running, 1)
    assert.equal(scheduler.stats().lanes.gpu.queued, 1)
    releaseEmbedding()
    await embedding.promise
    const result = await semantic
    assert.equal(result.state, 'done')
    assert.equal(result.job.state, 'done')
    assert.equal(processorStarted, true)
  } finally {
    releaseEmbedding?.()
    testFixture.close()
  }
})

test('CPU fallback is bounded and low-memory devices are unsupported', () => {
  const cpu = decideVideoSemanticResources({ systemMemoryTotalBytes: 16 * GIB })
  assert.equal(cpu.state, 'ready')
  assert.equal(cpu.budget.tier, 'cpu-memory')
  assert.equal(cpu.budget.execution, 'cpu')
  assert.equal(cpu.budget.maxFramesPerSegment, 4)
  assert.equal(cpu.budget.gpuLayers, 0)

  const unsupported = decideVideoSemanticResources({ systemMemoryTotalBytes: 8 * GIB })
  assert.equal(unsupported.state, 'unsupported')
  assert.equal(unsupported.budget.execution, 'unavailable')
})
