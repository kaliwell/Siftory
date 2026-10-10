const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { VideoSemanticBuildCoordinator } = loadTsModule('electron/videoSemanticBuildCoordinator.ts')
const { VideoSemanticDatabase } = loadTsModule('electron/videoSemanticDatabase.ts')
const { VideoSemanticJobService } = loadTsModule('electron/videoSemanticJobService.ts')
const { FakeVideoSemanticRuntime } = loadTsModule('electron/videoSemanticRuntime.ts')

const GIB = 1024 ** 3

function scope(initialFreeGpuBytes = 3 * GIB) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-semantic-build-'))
  const framesRoot = path.join(dir, 'media-search', 'frames')
  const videoId = 'a'.repeat(40)
  const videoFramesRoot = path.join(framesRoot, videoId)
  fs.mkdirSync(videoFramesRoot, { recursive: true })
  const video = {
    videoId,
    path: 'D:\\authorized\\fixture.mp4',
    name: 'fixture.mp4',
    ext: '.mp4',
    sizeBytes: 10_000,
    mtimeMs: 200,
    durationMs: 25_000,
    width: 1920,
    height: 1080,
    metadataStatus: 'done',
    discoveredAt: 100,
    updatedAt: 200,
  }
  const frames = [0, 4_000, 8_000, 12_000, 16_000, 20_000, 24_000].map((timestampMs, index) => {
    const frameId = (index + 1).toString(16).padStart(40, '0')
    const imagePath = path.join(videoFramesRoot, `${frameId}.jpg`)
    fs.writeFileSync(imagePath, Buffer.from(`frame-${index + 1}`))
    return {
      frameId,
      videoId,
      videoPath: video.path,
      timestampMs,
      imagePath,
      status: 'done',
      createdAt: 100,
      updatedAt: 100,
    }
  })
  const database = new VideoSemanticDatabase(path.join(dir, 'video-semantic.sqlite'))
  const jobs = new VideoSemanticJobService(database)
  const runtime = new FakeVideoSemanticRuntime()
  const schedulerRequests = []
  const scheduler = {
    enqueue(request) {
      schedulerRequests.push(request)
      return { id: schedulerRequests.length, promise: Promise.resolve().then(request.run) }
    },
  }
  let freeGpuBytes = initialFreeGpuBytes
  const coordinator = new VideoSemanticBuildCoordinator({
    database,
    jobs,
    runtime,
    scheduler,
    getVideo: (requested) => (requested === videoId ? video : undefined),
    getFrames: () => frames,
    framesRoot,
    resourceProbe: () => ({
      gpuTotalBytes: 4 * GIB,
      gpuFreeBytes: freeGpuBytes,
      systemMemoryTotalBytes: 16 * GIB,
    }),
    generationIdFactory: () => 'generation-1',
    now: () => 300,
  })
  return {
    dir,
    video,
    frames,
    framesRoot,
    database,
    jobs,
    runtime,
    schedulerRequests,
    coordinator,
    setFreeGpuBytes(value) {
      freeGpuBytes = value
    },
    async waitForTerminal(jobId) {
      for (let count = 0; count < 100; count += 1) {
        const job = jobs.getJob(jobId)
        if (job?.state === 'done' || job?.state === 'paused' || job?.state === 'stopped') return job
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error('Timed out waiting for video semantic job')
    },
    close() {
      database.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('coordinator plans cached evidence and runs the real pipeline in the video-deep lane', async () => {
  const testScope = scope()
  try {
    testScope.database.setVideoProfileOverride(testScope.video.videoId, 'sports')
    const started = await testScope.coordinator.start(testScope.video.videoId)
    assert.equal(started.started, true)
    assert.equal(started.resources.budget.maxFramesPerSegment, 4)
    assert.equal(testScope.schedulerRequests.length, 1)
    assert.equal(testScope.schedulerRequests[0].stage, 'video-deep')
    assert.deepEqual(testScope.schedulerRequests[0].paths, [testScope.video.path])

    const terminal = await testScope.waitForTerminal(started.job.jobId)
    assert.equal(terminal.state, 'done')
    assert.equal(terminal.failedSegments, 0)
    assert.equal(testScope.database.getActiveGenerationId(testScope.video.videoId), 'generation-1')
    assert.ok(testScope.runtime.requests.length > 0)
    assert.ok(testScope.runtime.requests.every((request) => request.images.length <= 4))
    assert.ok(testScope.runtime.requests.every((request) => request.contextTokens === 8_192))
    assert.ok(
      testScope.runtime.requests.every((request) => request.maximumContextTokens === 16_384),
    )
    assert.ok(testScope.runtime.requests.every((request) => request.gpuLayers === 20))
    assert.ok(
      testScope.runtime.requests.every((request) =>
        request.images.every((image) => typeof image.dataBase64 === 'string'),
      ),
    )
  } finally {
    testScope.close()
  }
})

test('coordinator persists waiting-gpu and resumes the same job when resources recover', async () => {
  const testScope = scope(2 * GIB)
  try {
    const waiting = await testScope.coordinator.start(testScope.video.videoId)
    assert.equal(waiting.started, false)
    assert.equal(waiting.reason, 'waiting-for-free-gpu-memory')
    assert.equal(waiting.job.state, 'paused')
    assert.equal(testScope.schedulerRequests.length, 0)

    testScope.setFreeGpuBytes(3 * GIB)
    const resumed = await testScope.coordinator.resume(waiting.job.jobId)
    assert.equal(resumed.started, true)
    assert.equal(resumed.job.jobId, waiting.job.jobId)
    const terminal = await testScope.waitForTerminal(waiting.job.jobId)
    assert.equal(terminal.state, 'done')
    assert.equal(testScope.schedulerRequests.length, 1)
  } finally {
    testScope.close()
  }
})

test('coordinator rejects evidence paths outside the controlled frame cache', async () => {
  const testScope = scope()
  const outside = path.join(testScope.dir, 'outside.jpg')
  fs.writeFileSync(outside, 'outside')
  testScope.frames[0].imagePath = outside
  try {
    const started = await testScope.coordinator.start(testScope.video.videoId)
    const terminal = await testScope.waitForTerminal(started.job.jobId)
    assert.equal(terminal.state, 'done')
    assert.ok(terminal.failedSegments > 0)
    assert.match(terminal.lastError, /controlled frame cache/)
    assert.equal(testScope.database.getActiveGenerationId(testScope.video.videoId), null)
  } finally {
    testScope.close()
  }
})
