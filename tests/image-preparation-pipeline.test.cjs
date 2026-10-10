const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { createImagePreparationPipeline } = loadTsModule('electron/imagePreparationPipeline.ts')

function embeddingProgress(state, overrides = {}) {
  return {
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    running: 0,
    pending: 0,
    state,
    ...overrides,
  }
}

function createPipelineHarness(root, options = {}) {
  let scanStatus = {
    state: 'idle',
    indexedCount: 0,
    pendingCount: 0,
  }
  let scanComplete = false
  const scanListeners = new Set()
  let embeddingState = embeddingProgress('idle')
  const embeddingListeners = new Set()
  let streamReady = false
  let drainIndex = 0
  const calls = {
    configured: [],
    invalidated: [],
    builds: [],
    appended: [],
    scaled: [],
    stoppedScans: 0,
    stoppedEmbeddings: 0,
    indexes: 0,
  }
  const finishScan = (indexedCount = 4) => {
    if (scanComplete) return
    scanComplete = true
    scanStatus = {
      ...scanStatus,
      state: 'idle',
      indexedCount,
      message: `Scan complete. ${indexedCount} indexed`,
    }
    for (const listener of scanListeners) listener(scanStatus)
  }
  const finishEmbedding = (request, completed = 0, skipped = 0) => {
    embeddingState = embeddingProgress('done', {
      total: completed + skipped,
      completed,
      skipped,
    })
    for (const listener of embeddingListeners) listener(embeddingState)
  }
  const feed = options.feed || [
    { paths: [], generation: 1, pending: 0, dropped: 0 },
    {
      paths: [path.join(root, 'a.jpg'), path.join(root, 'b.jpg')],
      generation: 2,
      pending: 0,
      dropped: 0,
    },
    {
      paths: [path.join(root, 'c.jpg'), path.join(root, 'd.jpg')],
      generation: 2,
      pending: 0,
      dropped: 0,
    },
    { paths: [], generation: 2, pending: 0, dropped: 0 },
  ]
  const dependencies = {
    configureCommitFeed: (enabled, maxEntries) => {
      calls.configured.push({ enabled, maxEntries })
      return { ok: true }
    },
    drainCommitFeed: () => {
      const item = feed[Math.min(drainIndex++, feed.length - 1)]
      return { ok: true, enabled: true, ...item }
    },
    startScan: () => {
      scanStatus = {
        state: 'scanning',
        indexedCount: 0,
        pendingCount: 0,
        message: 'Scanning...',
      }
      return scanStatus
    },
    getScanStatus: () => scanStatus,
    onScanStatus: (listener) => {
      scanListeners.add(listener)
      return () => scanListeners.delete(listener)
    },
    scanLifecycleComplete: () => scanComplete,
    waitScanPersistence: async () => undefined,
    stopScan: async () => {
      calls.stoppedScans++
      finishScan(scanStatus.indexedCount)
      return scanStatus
    },
    getCatalogRevision: () => 'active-revision',
    getModelStatus: (modelName) => ({ name: modelName, state: 'downloaded' }),
    downloadModel: async () => ({ ok: true }),
    cancelDownload: () => ({ ok: true }),
    startEmbedding: async (request) => {
      calls.builds.push(request)
      if (request.streamSessionId) {
        streamReady = true
        embeddingState = embeddingProgress('running', {
          total: request.imageIds.length,
          pending: request.imageIds.length,
        })
        return { ok: true }
      }
      embeddingState = embeddingProgress('running', { total: 4, pending: 4 })
      setImmediate(() => finishEmbedding(request, 0, 4))
      return { ok: true }
    },
    getEmbeddingProgress: () => embeddingState,
    onEmbeddingProgress: (listener) => {
      embeddingListeners.add(listener)
      return () => embeddingListeners.delete(listener)
    },
    cancelQueuedEmbedding: () => false,
    stopEmbedding: () => {
      calls.stoppedEmbeddings++
      return { ok: true }
    },
    isStreamingEmbeddingReady: () => streamReady,
    appendStreamingEmbeddingInputs: async (_sessionId, paths, appendOptions) => {
      calls.appended.push({ paths: [...paths], options: appendOptions })
      finishScan(4)
      return { ok: true }
    },
    closeStreamingEmbedding: () => {
      streamReady = false
      finishEmbedding(calls.builds.at(-1), 4, 0)
      return { ok: true }
    },
    scaleStreamingEmbedding: (_sessionId, concurrency) => {
      calls.scaled.push(concurrency)
      return { ok: true }
    },
    invalidateCommittedInputs: async (paths) => calls.invalidated.push([...paths]),
    buildVectorIndex: async () => {
      calls.indexes++
      return { ok: true, count: 4 }
    },
    ...options.dependencies,
  }
  return { calls, dependencies, finishScan }
}

test('image preparation overlaps committed scan chunks with DINO and gates ready on final coverage', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-preparation-overlap-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']) {
    fs.writeFileSync(path.join(root, name), name)
  }
  const harness = createPipelineHarness(root)
  const snapshots = []
  const pipeline = createImagePreparationPipeline(harness.dependencies)

  const result = await pipeline({
    paths: [root],
    backend: 'cpu',
    maxConcurrentEmbeddings: 2,
    batchSize: 2,
    onProgress: (progress) => snapshots.push(progress),
  })

  assert.deepEqual(harness.calls.configured, [
    { enabled: true, maxEntries: 4096 },
    { enabled: false, maxEntries: 4096 },
  ])
  assert.deepEqual(
    harness.calls.invalidated.map((chunk) => chunk.map((item) => path.basename(item))),
    [
      ['a.jpg', 'b.jpg'],
      ['c.jpg', 'd.jpg'],
    ],
  )
  assert.equal(harness.calls.builds[0].modelName, 'dinov2_vitb14')
  assert.deepEqual(
    harness.calls.builds[0].imageIds.map((item) => path.basename(item)),
    ['a.jpg', 'b.jpg'],
  )
  assert.equal(harness.calls.builds[0].maxConcurrentEmbeddings, 2)
  assert.deepEqual(harness.calls.appended, [
    {
      paths: [path.join(root, 'c.jpg'), path.join(root, 'd.jpg')],
      options: { replaceKnown: true },
    },
  ])
  assert.deepEqual(harness.calls.scaled, [2])
  assert.deepEqual(
    harness.calls.builds.slice(1).map((request) => [request.modelName, request.scanPaths]),
    [
      ['dinov2_vitb14', [root]],
      ['clip_vit_base_patch32', [root]],
    ],
  )
  assert.equal(result.scanIndexed, 4)
  assert.equal(result.committedImages, 4)
  assert.equal(result.invalidatedImages, 4)
  assert.equal(harness.calls.indexes, 1)
  assert.equal(snapshots.at(-1).phase, 'done')
  assert.equal(snapshots.at(-1).percentage, 100)
  assert.equal(snapshots.at(-1).scanComplete, true)
  assert.equal(snapshots.at(-1).dinoEmbeddingComplete, true)
  assert.equal(snapshots.at(-1).clipEmbeddingComplete, true)
  assert.equal(snapshots.at(-1).vectorIndexComplete, true)
  assert.ok(snapshots.slice(0, -1).every((snapshot) => !snapshot.vectorIndexComplete))
})

test('warm image preparation performs no streaming or duplicate inference when scan commits no changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-preparation-warm-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const harness = createPipelineHarness(root, {
    feed: [{ paths: [], generation: 7, pending: 0, dropped: 0 }],
  })
  setImmediate(() => harness.finishScan(4))
  const pipeline = createImagePreparationPipeline(harness.dependencies)

  const result = await pipeline({
    paths: [root],
    backend: 'cpu',
    maxConcurrentEmbeddings: 2,
  })

  assert.equal(result.committedImages, 0)
  assert.equal(harness.calls.invalidated.length, 0)
  assert.equal(harness.calls.appended.length, 0)
  assert.deepEqual(
    harness.calls.builds.map((request) => [request.modelName, request.streamSessionId]),
    [
      ['dinov2_vitb14', undefined],
      ['clip_vit_base_patch32', undefined],
    ],
  )
  assert.equal(harness.calls.indexes, 1)
})

test('image preparation refuses ready when the committed active-set revision changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-preparation-revision-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let revisionRead = 0
  const harness = createPipelineHarness(root, {
    feed: [{ paths: [], generation: 9, pending: 0, dropped: 0 }],
    dependencies: {
      getCatalogRevision: () => (revisionRead++ === 0 ? 'revision-a' : 'revision-b'),
    },
  })
  setImmediate(() => harness.finishScan(4))
  const pipeline = createImagePreparationPipeline(harness.dependencies)

  await assert.rejects(
    pipeline({ paths: [root], backend: 'cpu', maxConcurrentEmbeddings: 1 }),
    /active set changed during preparation/,
  )
  assert.equal(harness.calls.indexes, 0)
})

test('image preparation cancellation stops only the scan and embedding work it owns', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-preparation-cancel-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const imagePath = path.join(root, 'a.jpg')
  fs.writeFileSync(imagePath, 'a')
  let cancelled = false
  const registeredCancellations = []
  const harness = createPipelineHarness(root, {
    feed: [
      { paths: [imagePath], generation: 4, pending: 0, dropped: 0 },
      { paths: [], generation: 4, pending: 0, dropped: 0 },
    ],
  })
  const startEmbedding = harness.dependencies.startEmbedding
  harness.dependencies.startEmbedding = async (request) => {
    const result = await startEmbedding(request)
    if (request.streamSessionId) setImmediate(() => (cancelled = true))
    return result
  }
  const pipeline = createImagePreparationPipeline(harness.dependencies)

  await assert.rejects(
    pipeline({
      paths: [root],
      backend: 'cpu',
      maxConcurrentEmbeddings: 2,
      isCancelled: () => cancelled,
      registerCancellation: (handler) => registeredCancellations.push(handler),
      batchSize: 1,
    }),
    (error) => error instanceof Error && error.name === 'AbortError',
  )
  assert.equal(harness.calls.stoppedEmbeddings, 1)
  assert.equal(harness.calls.stoppedScans, 1)
  assert.equal(harness.calls.indexes, 0)
  assert.equal(typeof registeredCancellations[0], 'function')
  assert.equal(registeredCancellations.at(-1), null)
  assert.deepEqual(harness.calls.configured.at(-1), { enabled: false, maxEntries: 4096 })
})

test('commit-feed drops remain observable while final coverage repairs missed chunks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-preparation-feed-drop-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const harness = createPipelineHarness(root, {
    feed: [{ paths: [], generation: 5, pending: 0, dropped: 3 }],
  })
  setImmediate(() => harness.finishScan(4))
  const pipeline = createImagePreparationPipeline(harness.dependencies)

  const result = await pipeline({ paths: [root], backend: 'cpu', maxConcurrentEmbeddings: 2 })

  assert.equal(result.commitFeedDropped, 3)
  assert.equal(harness.calls.appended.length, 0)
  assert.deepEqual(
    harness.calls.builds.map((request) => request.modelName),
    ['dinov2_vitb14', 'clip_vit_base_patch32'],
  )
  assert.equal(harness.calls.indexes, 1)
})

test('forced stream backpressure fails closed when the embedding stream terminates', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-preparation-backpressure-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const first = path.join(root, 'a.jpg')
  const second = path.join(root, 'b.jpg')
  fs.writeFileSync(first, 'a')
  fs.writeFileSync(second, 'b')
  let terminal = false
  const harness = createPipelineHarness(root, {
    feed: [
      { paths: [first, second], generation: 6, pending: 0, dropped: 0 },
      { paths: [], generation: 6, pending: 0, dropped: 0 },
    ],
    dependencies: {
      getEmbeddingProgress: () =>
        terminal
          ? embeddingProgress('error', {
              pending: 2,
              error: 'synthetic stream failure',
            })
          : embeddingProgress('running'),
    },
  })
  const startEmbedding = harness.dependencies.startEmbedding
  harness.dependencies.startEmbedding = async (request) => {
    const result = await startEmbedding(request)
    if (request.streamSessionId) terminal = true
    return result
  }
  const pipeline = createImagePreparationPipeline(harness.dependencies)

  await assert.rejects(
    pipeline({
      paths: [root],
      backend: 'cpu',
      maxConcurrentEmbeddings: 1,
      batchSize: 1,
    }),
    /synthetic stream failure/,
  )
  assert.equal(harness.calls.appended.length, 0)
  assert.equal(harness.calls.indexes, 0)
})
