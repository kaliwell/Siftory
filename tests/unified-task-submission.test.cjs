const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const { submitUnifiedTask } = loadTsModule('electron/unifiedTaskSubmission.ts')
const { createEmbeddingTaskScheduling } = loadTsModule('electron/embeddingTaskScheduling.ts')
const { createImageSearchTaskScheduling } = loadTsModule('electron/imageSearchTaskScheduling.ts')

test('staged submission preserves stage, P0 paths, and awaits scheduler completion', async () => {
  let submitted
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const scheduler = {
    enqueue(request) {
      submitted = request
      return { promise: gate.then(request.run) }
    },
  }
  let ran = false
  const completion = submitUnifiedTask(scheduler, {
    stage: 'preview',
    priority: 0,
    paths: ['D:\\visible.jpg'],
    run: () => {
      ran = true
      return 'ready'
    },
  })
  await Promise.resolve()
  assert.equal(ran, false)
  assert.equal(submitted.stage, 'preview')
  assert.equal(submitted.priority, 0)
  assert.deepEqual(submitted.paths, ['D:\\visible.jpg'])
  release()
  assert.equal(await completion, 'ready')
  assert.equal(ran, true)
})

test('staged submission retains direct fallback for isolated callers and tests', async () => {
  const value = await submitUnifiedTask(undefined, {
    stage: 'hash',
    run: async () => 42,
  })
  assert.equal(value, 42)
})

function embeddingProgress(state) {
  return { total: 0, completed: 0, failed: 0, skipped: 0, running: 0, pending: 0, state }
}

test('D5 reservation returns immediately and holds the GPU task until terminal progress', async () => {
  let progress = embeddingProgress('idle')
  let listener = null
  let scheduled
  const coordinator = createEmbeddingTaskScheduling({
    reserve: () => {
      progress = embeddingProgress('queued')
      return { ok: true }
    },
    start: async () => {
      progress = embeddingProgress('running')
      return { ok: true }
    },
    getProgress: () => progress,
    onProgress: (callback) => {
      listener = callback
      return () => {
        listener = null
      }
    },
    finishQueued: () => false,
    failActive: () => false,
  })
  const scheduler = {
    enqueue(request) {
      scheduled = request
      return { id: 7, promise: Promise.resolve() }
    },
  }
  assert.deepEqual(
    coordinator.queue({ modelName: 'dinov2_vitb14', embeddingType: 'global' }, scheduler),
    { ok: true },
  )
  assert.equal(progress.state, 'queued')
  assert.equal(scheduled.stage, 'embedding')
  let completed = false
  const running = scheduled.run().then(() => {
    completed = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(progress.state, 'running')
  assert.equal(completed, false)
  progress = embeddingProgress('done')
  listener(progress)
  await running
  assert.equal(completed, true)
  assert.equal(listener, null)
})

test('D5 queued cancellation removes the scheduler task before inference starts', () => {
  let progress = embeddingProgress('idle')
  let cancelledId = null
  let finishedQueued = false
  const coordinator = createEmbeddingTaskScheduling({
    reserve: () => {
      progress = embeddingProgress('queued')
      return { ok: true }
    },
    start: async () => {
      throw new Error('must not start')
    },
    getProgress: () => progress,
    onProgress: () => () => {},
    finishQueued: () => {
      progress = embeddingProgress('done')
      finishedQueued = true
      return true
    },
    failActive: () => false,
  })
  coordinator.queue(
    { modelName: 'dinov2_vitb14', embeddingType: 'global' },
    {
      enqueue: () => ({ id: 11, promise: new Promise(() => {}) }),
      cancel: (id) => {
        cancelledId = id
        return true
      },
    },
  )
  assert.equal(coordinator.cancelQueued(), true)
  assert.equal(cancelledId, 11)
  assert.equal(finishedQueued, true)
  assert.equal(progress.state, 'done')
})

test('D5 stale scheduler rejection cannot poison a newer reservation', async () => {
  let progress = embeddingProgress('idle')
  let rejectFirst
  const coordinator = createEmbeddingTaskScheduling({
    reserve: () => {
      progress = embeddingProgress('queued')
      return { ok: true }
    },
    start: async () => ({ ok: true }),
    getProgress: () => progress,
    onProgress: () => () => {},
    finishQueued: () => {
      progress = embeddingProgress('error')
      return true
    },
    failActive: () => false,
  })
  coordinator.queue(
    { modelName: 'dinov2_vitb14', embeddingType: 'global' },
    {
      enqueue: () => ({
        id: 21,
        promise: new Promise((_resolve, reject) => {
          rejectFirst = reject
        }),
      }),
    },
  )
  progress = embeddingProgress('done')
  coordinator.queue(
    { modelName: 'dinov2_vitb14', embeddingType: 'global' },
    { enqueue: () => ({ id: 22, promise: new Promise(() => {}) }) },
  )
  rejectFirst(new Error('stale task failure'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(progress.state, 'queued')
})

test('legacy D3/D4 composite scan holds the local task until scan and persistence finish', async () => {
  let status = { state: 'idle', indexedCount: 0, pendingCount: 0 }
  let listener = null
  let scheduled
  let persistenceFinished = false
  const coordinator = createImageSearchTaskScheduling({
    reserve: () => {
      status = { ...status, state: 'queued' }
      return status
    },
    start: () => {
      status = { ...status, state: 'scanning' }
      return status
    },
    getStatus: () => status,
    onStatus: (callback) => {
      listener = callback
      return () => {
        listener = null
      }
    },
    finishQueued: () => false,
    failActive: () => false,
    isComplete: () => status.state === 'idle' || status.state === 'error',
    waitForPersistence: async () => {
      persistenceFinished = true
    },
  })
  coordinator.queue(
    { paths: ['D:\\library'], buildThumbnails: true },
    {
      enqueue: (request) => {
        scheduled = request
        return { id: 31, promise: new Promise(() => {}) }
      },
    },
  )
  assert.equal(status.state, 'queued')
  assert.equal(scheduled.stage, 'hash')
  assert.equal(scheduled.priority, 1)
  let completed = false
  const running = scheduled.run().then(() => {
    completed = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, false)
  status = { ...status, state: 'idle' }
  listener(status)
  await running
  assert.equal(completed, true)
  assert.equal(persistenceFinished, true)
  assert.equal(listener, null)
})

test('legacy D3/D4 waits past the native idle notification until lifecycle finalization', async () => {
  let status = { state: 'idle', indexedCount: 0, pendingCount: 0 }
  let listener = null
  let finalized = false
  let scheduled
  const coordinator = createImageSearchTaskScheduling({
    reserve: () => {
      status = { ...status, state: 'queued' }
      return status
    },
    start: () => {
      status = { ...status, state: 'scanning' }
      return status
    },
    getStatus: () => status,
    onStatus: (callback) => {
      listener = callback
      return () => {
        listener = null
      }
    },
    finishQueued: () => false,
    failActive: () => false,
    isComplete: () => finalized,
    waitForPersistence: async () => {},
  })
  coordinator.queue(
    { paths: ['D:\\library'], buildThumbnails: true },
    {
      enqueue: (request) => {
        scheduled = request
        return { id: 33, promise: new Promise(() => {}) }
      },
    },
  )
  let completed = false
  const running = scheduled.run().then(() => {
    completed = true
  })
  status = { ...status, state: 'idle' }
  listener(status)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(completed, false)
  finalized = true
  listener(status)
  await running
  assert.equal(completed, true)
})

test('legacy D3/D4 queued scan can be cancelled before native work starts', () => {
  let status = { state: 'idle', indexedCount: 0, pendingCount: 0 }
  let cancelledId
  const coordinator = createImageSearchTaskScheduling({
    reserve: () => {
      status = { ...status, state: 'queued' }
      return status
    },
    start: () => {
      throw new Error('must not start')
    },
    getStatus: () => status,
    onStatus: () => () => {},
    finishQueued: () => {
      status = { ...status, state: 'idle' }
      return true
    },
    failActive: () => false,
    isComplete: () => status.state === 'idle' || status.state === 'error',
    waitForPersistence: async () => {},
  })
  coordinator.queue(
    { paths: ['D:\\library'] },
    {
      enqueue: () => ({ id: 32, promise: new Promise(() => {}) }),
      cancel: (id) => {
        cancelledId = id
        return true
      },
    },
  )
  assert.equal(coordinator.cancelQueued(), true)
  assert.equal(cancelledId, 32)
  assert.equal(status.state, 'idle')
})

test('legacy D3/D4 persistence failure is surfaced after the native scan becomes idle', async () => {
  let status = { state: 'idle', indexedCount: 0, pendingCount: 0 }
  let listener = null
  let scheduledPromise
  let failedWith
  const coordinator = createImageSearchTaskScheduling({
    reserve: () => {
      status = { ...status, state: 'queued' }
      return status
    },
    start: () => {
      status = { ...status, state: 'scanning' }
      setImmediate(() => {
        status = { ...status, state: 'idle' }
        listener(status)
      })
      return status
    },
    getStatus: () => status,
    onStatus: (callback) => {
      listener = callback
      return () => {
        listener = null
      }
    },
    finishQueued: () => false,
    failActive: (error) => {
      failedWith = error
      status = { ...status, state: 'error' }
      return true
    },
    isComplete: () => status.state === 'idle',
    waitForPersistence: async () => {
      throw new Error('manifest write failed')
    },
  })
  coordinator.queue(
    { paths: ['D:\\library'] },
    {
      enqueue: (request) => {
        scheduledPromise = Promise.resolve().then(request.run)
        return { id: 34, promise: scheduledPromise }
      },
    },
  )
  await assert.rejects(scheduledPromise, /manifest write failed/)
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(String(failedWith), /manifest write failed/)
  assert.equal(status.state, 'error')
})

test('production staged handlers submit previews, frame extraction, and explicit hashes', () => {
  const thumbnailSource = require('node:fs').readFileSync('electron/thumbnailIpc.ts', 'utf8')
  const imageSearchSource = require('node:fs').readFileSync('electron/imageSearchIpc.ts', 'utf8')
  const mainSource = require('node:fs').readFileSync('electron/main.ts', 'utf8')
  const mediaTaskSource = require('node:fs').readFileSync('electron/mediaTaskQueue.ts', 'utf8')
  const mediaIpcSource = require('node:fs').readFileSync('electron/mediaSearchIpc.ts', 'utf8')
  const vectorSource = require('node:fs').readFileSync('electron/vectorIpc.ts', 'utf8')
  const embeddingSource = require('node:fs').readFileSync(
    'electron/embeddingTaskScheduling.ts',
    'utf8',
  )
  const imageTaskSource = require('node:fs').readFileSync(
    'electron/imageSearchTaskScheduling.ts',
    'utf8',
  )
  assert.match(thumbnailSource, /stage: 'preview',[\s\S]*?priority: 0,[\s\S]*?paths: \[safePath\]/)
  assert.match(thumbnailSource, /stage: 'preview',[\s\S]*?priority: 0,[\s\S]*?paths: selectedFiles/)
  assert.match(thumbnailSource, /paths: safeBatchPaths,[\s\S]*?visible thumbnail batch/)
  assert.match(imageSearchSource, /stage: 'hash',[\s\S]*?priority: 0,[\s\S]*?paths: \[filePath\]/)
  assert.match(mainSource, /registerImageSearchIpc\([\s\S]*?getUnifiedTaskScheduler\(\)\)/)
  assert.match(mainSource, /registerThumbnailIpc\([\s\S]*?getUnifiedTaskScheduler\(\)\)/)
  assert.match(
    mediaTaskSource,
    /stage: 'preview',[\s\S]*?priority: 1,[\s\S]*?paths: videos\.map\(\(video\) => video\.path\)/,
  )
  assert.match(mediaTaskSource, /runMediaPreparationPipeline\(\{/)
  assert.match(mainSource, /registerMediaSearchCoreIpc\([\s\S]*?getUnifiedTaskScheduler\(\)\)/)
  assert.match(mediaIpcSource, /queueEmbeddingBuild\(buildRequest, taskScheduler\)/)
  assert.match(mediaIpcSource, /if \(!result\.ok\) clearMediaFrameEmbeddingBuildActive\(\)/)
  assert.match(vectorSource, /queueEmbeddingBuild\(buildRequest, taskScheduler\)/)
  assert.match(mainSource, /registerVectorIpc\([\s\S]*?getUnifiedTaskScheduler\(\)\)/)
  assert.match(embeddingSource, /deps\.start\(request, \{ acceptQueuedReservation: true \}\)/)
  assert.match(embeddingSource, /await waitForTerminal\(\)/)
  assert.match(imageSearchSource, /queueImageSearchScan\(args, taskScheduler\)/)
  assert.match(imageTaskSource, /stage: 'hash',[\s\S]*?priority: 1/)
  assert.match(imageTaskSource, /await deps\.waitForPersistence\(\)/)
})
