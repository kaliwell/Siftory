const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { VideoSemanticDatabase } = loadTsModule('electron/videoSemanticDatabase.ts')
const { VideoSemanticJobService } = loadTsModule('electron/videoSemanticJobService.ts')
const { VideoSemanticUiService } = loadTsModule('electron/videoSemanticUiService.ts')

function scope(runtimeStatus, buildStarter, resumeStarter) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-semantic-ui-'))
  const file = path.join(dir, 'video-semantic.sqlite')
  const database = new VideoSemanticDatabase(file)
  const jobs = new VideoSemanticJobService(database)
  const service = new VideoSemanticUiService(
    database,
    jobs,
    runtimeStatus,
    buildStarter,
    resumeStarter,
  )
  return {
    dir,
    file,
    database,
    jobs,
    service,
    close() {
      database.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function createJob(jobs) {
  return jobs.createJob({
    assetId: 'asset-1',
    videoId: 'video-1',
    generationId: 'generation-1',
    profileId: 'sports',
    segments: [
      {
        segmentId: 'segment-1',
        startMs: 0,
        endMs: 10_000,
        evidenceFrameIds: ['a'.repeat(40)],
        evidenceFrameDigest: 'digest-1',
      },
      {
        segmentId: 'segment-2',
        startMs: 10_000,
        endMs: 20_000,
        evidenceFrameIds: ['b'.repeat(40)],
        evidenceFrameDigest: 'digest-2',
      },
    ],
    now: 100,
  })
}

test('UI status restores persisted profile and job progress from main-process SQLite', async () => {
  const testScope = scope(() => ({
    adapterId: 'fake',
    state: 'ready',
    model: { modelId: 'fake', modelRevision: 'v1', quantization: 'none' },
  }))
  try {
    await testScope.service.setProfile('video-1', 'sports')
    const job = createJob(testScope.jobs)
    testScope.database.putJob({
      ...job,
      state: 'running',
      cursor: 1,
      completedSegments: 1,
      currentSegmentId: 'segment-2',
      updatedAt: 200,
    })

    testScope.database.close()
    const reopened = new VideoSemanticDatabase(testScope.file)
    const restored = new VideoSemanticUiService(
      reopened,
      new VideoSemanticJobService(reopened),
      () => ({
        adapterId: 'fake',
        state: 'ready',
        model: { modelId: 'fake', modelRevision: 'v1', quantization: 'none' },
      }),
    )
    const status = await restored.getStatus('video-1')
    assert.equal(status.profileOverride, 'sports')
    assert.equal(status.jobs[0].state, 'running')
    assert.equal(status.jobs[0].completedSegments, 1)
    assert.equal(status.jobs[0].totalSegments, 2)
    assert.equal(status.jobs[0].currentSegmentId, 'segment-2')
    assert.equal(status.canStop, true)
    assert.equal(status.canBuild, false)
    reopened.close()
  } finally {
    testScope.close()
  }
})

test('missing runtime is explicit and build does not create work or download a model', async () => {
  const testScope = scope()
  try {
    const before = await testScope.service.getStatus('video-1')
    assert.equal(before.runtime.state, 'not-installed')
    assert.equal(before.runtime.reason, 'model-missing')
    assert.equal(before.canBuild, false)
    const result = await testScope.service.start('video-1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'model-missing')
    assert.deepEqual(testScope.database.listJobs('video-1'), [])
  } finally {
    testScope.close()
  }
})

test('ready runtime stays inspectable without enabling build before the evidence planner exists', async () => {
  const testScope = scope(() => ({
    adapterId: 'ollama-loopback',
    state: 'ready',
    model: {
      modelId: 'qwen3-vl:2b',
      modelRevision: '0'.repeat(64),
      quantization: 'Q4_K_M',
    },
  }))
  try {
    const status = await testScope.service.getStatus('video-1')
    assert.equal(status.runtime.state, 'ready')
    assert.equal(status.canBuild, false)
    const result = await testScope.service.start('video-1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'video-semantic-evidence-planner-not-ready')
    assert.deepEqual(testScope.database.listJobs('video-1'), [])
  } finally {
    testScope.close()
  }
})

test('runtime inspection is shared across status cards and can still be forced by user action', async () => {
  let inspections = 0
  const testScope = scope(async () => {
    inspections += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return {
      adapterId: 'ollama-loopback',
      state: 'ready',
      model: {
        modelId: 'qwen3-vl:2b',
        modelRevision: '0'.repeat(64),
        quantization: 'Q4_K_M',
      },
    }
  })
  try {
    await Promise.all([testScope.service.getStatus(), testScope.service.getStatus()])
    await testScope.service.getStatus()
    assert.equal(inspections, 1)

    await testScope.service.getStatus(undefined, true)
    assert.equal(inspections, 2)
  } finally {
    testScope.close()
  }
})

test('ready runtime enables build and delegates resumable work to the coordinator', async () => {
  let startedVideoId
  let resumedJobId
  let testScope
  const runtime = () => ({
    adapterId: 'fake',
    state: 'ready',
    model: { modelId: 'fake', modelRevision: 'v1', quantization: 'none' },
  })
  testScope = scope(
    runtime,
    async (videoId) => {
      startedVideoId = videoId
      return { ok: true, status: await testScope.service.getStatus(videoId) }
    },
    async (jobId) => {
      resumedJobId = jobId
      const job = testScope.jobs.getJob(jobId)
      return { ok: true, status: await testScope.service.getStatus(job.videoId) }
    },
  )
  try {
    const status = await testScope.service.getStatus('video-1')
    assert.equal(status.canBuild, true)
    assert.equal((await testScope.service.start('video-1')).ok, true)
    assert.equal(startedVideoId, 'video-1')

    const job = createJob(testScope.jobs)
    testScope.jobs.requestStop(job.jobId, 150)
    assert.equal((await testScope.service.resume(job.jobId)).ok, true)
    assert.equal(resumedJobId, job.jobId)
  } finally {
    testScope.close()
  }
})

test('resume without a runtime persists a safe paused state for later restoration', async () => {
  const testScope = scope()
  try {
    const job = createJob(testScope.jobs)
    testScope.jobs.requestStop(job.jobId, 150)
    const result = await testScope.service.resume(job.jobId)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'model-missing')
    const restored = await testScope.service.getStatus('video-1')
    assert.equal(restored.jobs[0].state, 'paused')
    assert.equal(restored.jobs[0].lastError, 'model-missing')
    assert.equal(restored.canResume, true)
  } finally {
    testScope.close()
  }
})

test('a rejected resume starter rolls the job back to a resumable paused state', async () => {
  const testScope = scope(
    () => ({
      adapterId: 'fake',
      state: 'ready',
      model: { modelId: 'fake', modelRevision: 'v1', quantization: 'none' },
    }),
    undefined,
    async () => ({ ok: false, error: 'resume backend busy' }),
  )
  try {
    const job = createJob(testScope.jobs)
    testScope.jobs.requestStop(job.jobId, 150)

    const result = await testScope.service.resume(job.jobId)
    const restored = await testScope.service.getStatus('video-1')

    assert.equal(result.ok, false)
    assert.equal(result.error, 'resume backend busy')
    assert.equal(restored.jobs[0].state, 'paused')
    assert.equal(restored.jobs[0].lastError, 'resume backend busy')
    assert.equal(restored.canResume, true)
    assert.equal(testScope.service.hasActiveJob(), false)
  } finally {
    testScope.close()
  }
})

test('a throwing resume starter rolls the job back instead of leaking active work', async () => {
  const testScope = scope(
    () => ({
      adapterId: 'fake',
      state: 'ready',
      model: { modelId: 'fake', modelRevision: 'v1', quantization: 'none' },
    }),
    undefined,
    async () => {
      throw new Error('resume worker crashed')
    },
  )
  try {
    const job = createJob(testScope.jobs)
    testScope.jobs.requestStop(job.jobId, 150)

    const result = await testScope.service.resume(job.jobId)
    const restored = await testScope.service.getStatus('video-1')

    assert.equal(result.ok, false)
    assert.equal(result.error, 'resume worker crashed')
    assert.equal(restored.jobs[0].state, 'paused')
    assert.equal(restored.jobs[0].lastError, 'resume worker crashed')
    assert.equal(restored.canResume, true)
    assert.equal(testScope.service.hasActiveJob(), false)
  } finally {
    testScope.close()
  }
})

test('renderer, preload, and main-process contracts expose restorable per-video controls', () => {
  const component = fs.readFileSync('src/components/VideoSemanticStatusCard.tsx', 'utf8')
  const mediaPanel = fs.readFileSync('src/components/MediaSearchPanel.tsx', 'utf8')
  const settings = fs.readFileSync('src/components/SettingsPanel.tsx', 'utf8')
  const preload = fs.readFileSync('electron/preload.ts', 'utf8')
  const ipc = fs.readFileSync('electron/mediaSearchIpc.ts', 'utf8')
  assert.match(component, /getVideoSemanticStatus/)
  assert.match(component, /setInterval/)
  assert.match(component, /activelyBuilding \? 3_000 : 15_000/)
  assert.match(component, /refresh\(true\)/)
  assert.match(component, /video-semantic-progress/)
  assert.match(component, /startVideoSemanticBuild/)
  assert.match(component, /stopVideoSemanticJob/)
  assert.match(component, /resumeVideoSemanticJob/)
  assert.match(mediaPanel, /<VideoSemanticStatusCard videos=\{videos\}/)
  assert.match(settings, /<VideoSemanticStatusCard compact/)
  assert.match(preload, /mediaSearch:getVideoSemanticStatus/)
  assert.match(ipc, /mediaSearch:setVideoSemanticProfile/)
  assert.match(ipc, /createDefaultVideoSemanticRuntime/)
  assert.match(ipc, /allowManagedLlamaCpp: app\.isPackaged/)
  assert.match(ipc, /runtime\.dispose/)
  assert.match(ipc, /VideoSemanticBuildCoordinator/)
  assert.match(ipc, /recoverInterruptedJobs/)
})
