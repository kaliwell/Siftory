const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  ensureSetupModel,
  runSetupEmbeddingBuild,
  runSetupWorkflow,
  setupSnapshotFromImagePreparationProgress,
  setupSnapshotFromEmbeddingProgress,
  setupDelay,
  startDeferredSimpleThumbnails,
} = loadTsModule('src/services/searchSetupWorkflow.ts')

test('main-process image preparation maps into the four-step setup display', () => {
  const running = setupSnapshotFromImagePreparationProgress({
    taskId: 'prep-1',
    state: 'running',
    phase: 'embedding-clip',
    percentage: 73,
    message: 'Building complete CLIP coverage...',
    scanIndexed: 16,
    committedImages: 12,
    invalidatedImages: 12,
    commitFeedDropped: 0,
    scanComplete: true,
    dinoEmbeddingComplete: true,
    clipEmbeddingComplete: false,
    vectorIndexComplete: false,
  })
  assert.deepEqual(running, {
    state: 'running',
    stepId: 'clip-embeddings',
    stepLabel: 'Build CLIP embeddings',
    stepIndex: 3,
    totalSteps: 4,
    stepPercent: 73,
    percent: 73,
    message: 'Building complete CLIP coverage...',
    error: undefined,
  })

  const done = setupSnapshotFromImagePreparationProgress({
    ...running,
    state: 'done',
    phase: 'done',
    percentage: 100,
  })
  assert.equal(done.state, 'done')
  assert.equal(done.stepId, 'vector-index')
  assert.equal(done.stepIndex, 4)
  assert.equal(done.stepPercent, 100)
})

test('simple setup can restore its progress display from main-process embedding state', () => {
  assert.equal(
    setupSnapshotFromEmbeddingProgress({
      state: 'idle',
      total: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      running: 0,
      pending: 0,
    }),
    null,
  )
  assert.deepEqual(
    setupSnapshotFromEmbeddingProgress({
      state: 'running',
      total: 100,
      completed: 72,
      failed: 2,
      skipped: 6,
      running: 2,
      pending: 18,
    }),
    {
      state: 'running',
      stepId: 'background-embeddings',
      stepLabel: 'Build embeddings',
      stepIndex: 1,
      totalSteps: 1,
      stepPercent: 80,
      percent: 80,
      message: 'Building embeddings...',
      error: undefined,
      runtimeError: undefined,
    },
  )
  assert.equal(
    setupSnapshotFromEmbeddingProgress({
      state: 'done',
      total: 100,
      completed: 92,
      failed: 2,
      skipped: 6,
      running: 0,
      pending: 0,
    }).percent,
    100,
  )
})

test('Image Search stays mounted while hidden so setup orchestration is not cancelled', () => {
  const registry = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'config', 'panelRegistry.ts'),
    'utf8',
  )
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
  assert.match(registry, /id: 'imageSearch'[\s\S]*?preserveWhenHidden: true/)
  assert.match(app, /preserveWhenHidden && mountedLazyPanelIds\.current\.has\(id\)/)
})

test('Media Search also stays mounted while its six-step library setup is running', () => {
  const registry = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'config', 'panelRegistry.ts'),
    'utf8',
  )
  assert.match(registry, /id: 'mediaSearch'[\s\S]*?preserveWhenHidden: true/)
})

test('setup workflow runs steps in order and maps child progress to overall progress', async () => {
  const calls = []
  const snapshots = []
  const controller = new AbortController()
  const final = await runSetupWorkflow(
    [
      {
        id: 'first',
        label: 'First',
        run: async ({ report }) => {
          calls.push('first')
          report(50, 'First half')
        },
      },
      {
        id: 'second',
        label: 'Second',
        run: async ({ report }) => {
          calls.push('second')
          report(25, 'Second quarter')
        },
      },
    ],
    { signal: controller.signal, onChange: (snapshot) => snapshots.push(snapshot) },
  )

  assert.deepEqual(calls, ['first', 'second'])
  assert.equal(final.state, 'done')
  assert.equal(final.percent, 100)
  assert.ok(
    snapshots.some((snapshot) => snapshot.message === 'First half' && snapshot.percent === 25),
  )
  assert.ok(
    snapshots.some((snapshot) => snapshot.message === 'Second quarter' && snapshot.percent === 63),
  )
})

test('setup workflow stops after the first failed step', async () => {
  const calls = []
  const final = await runSetupWorkflow(
    [
      {
        id: 'failed',
        label: 'Failed',
        run: async () => {
          calls.push('failed')
          throw new Error('fixed failure')
        },
      },
      { id: 'unreachable', label: 'Unreachable', run: async () => calls.push('unreachable') },
    ],
    { signal: new AbortController().signal, onChange: () => {} },
  )

  assert.deepEqual(calls, ['failed'])
  assert.equal(final.state, 'error')
  assert.equal(final.error, 'fixed failure')
})

test('setup workflow preserves structured runtime failures for renderer translation', async () => {
  const final = await runSetupWorkflow(
    [
      {
        id: 'embedding',
        label: 'Embedding',
        run: (context) =>
          runSetupEmbeddingBuild(
            {
              startEmbeddingBuild: async () => ({
                ok: false,
                runtimeError: {
                  code: 'EMBEDDING_PREPARATION_FAILED',
                  detail: 'preparation child exit 9',
                },
              }),
            },
            { modelName: 'dinov2_vitb14', embeddingType: 'global' },
            context,
          ),
      },
    ],
    { signal: new AbortController().signal, onChange: () => {} },
  )

  assert.equal(final.state, 'error')
  assert.deepEqual(final.runtimeError, {
    code: 'EMBEDDING_PREPARATION_FAILED',
    detail: 'preparation child exit 9',
  })
})

test('setup workflow cancellation interrupts an active delay', async () => {
  const controller = new AbortController()
  const finalPromise = runSetupWorkflow(
    [
      {
        id: 'waiting',
        label: 'Waiting',
        run: async ({ signal }) => setupDelay(5_000, signal),
      },
    ],
    { signal: controller.signal, onChange: () => {} },
  )
  setTimeout(() => controller.abort(), 10)
  const final = await finalPromise
  assert.equal(final.state, 'cancelled')
})

test('model preparation skips downloads for an installed model', async () => {
  let downloads = 0
  const reports = []
  await ensureSetupModel(
    {
      getModelStatus: async () => ({ state: 'downloaded', name: 'dinov2_vitb14' }),
      downloadModel: async () => {
        downloads++
        return { ok: true }
      },
      startEmbeddingBuild: async () => ({ ok: true }),
      getEmbeddingProgress: async () => ({ state: 'done', total: 0 }),
    },
    'dinov2_vitb14',
    {
      signal: new AbortController().signal,
      report: (percent, message) => reports.push({ percent, message }),
    },
  )
  assert.equal(downloads, 0)
  assert.equal(reports.at(-1).percent, 100)
})

test('embedding setup waits for terminal progress before completing', async () => {
  const states = [
    {
      state: 'running',
      total: 4,
      completed: 2,
      failed: 0,
      skipped: 0,
      running: 1,
      pending: 1,
    },
    {
      state: 'done',
      total: 4,
      completed: 4,
      failed: 0,
      skipped: 0,
      running: 0,
      pending: 0,
    },
  ]
  const reports = []
  await runSetupEmbeddingBuild(
    {
      getModelStatus: async () => ({ state: 'downloaded', name: 'dinov2_vitb14' }),
      downloadModel: async () => ({ ok: true }),
      startEmbeddingBuild: async () => ({ ok: true }),
      getEmbeddingProgress: async () => states.shift(),
    },
    { modelName: 'dinov2_vitb14', embeddingType: 'global', scanPaths: ['C:\\Images'] },
    {
      signal: new AbortController().signal,
      report: (percent, message) => reports.push({ percent, message }),
    },
  )
  assert.deepEqual(
    reports.map((report) => report.percent),
    [0, 50, 100],
  )
})

test('Simple setup starts Native thumbnails after library readiness and honors opt-out', async () => {
  const calls = []
  const api = {
    startThumbnailRebuild: async (...args) => {
      calls.push(args)
      return { ok: true }
    },
  }
  assert.deepEqual(await startDeferredSimpleThumbnails(api, ['D:\\Images'], false, 2, 4), {
    started: false,
  })
  assert.deepEqual(await startDeferredSimpleThumbnails(api, ['D:\\Images'], true, 2, 0), {
    started: true,
  })
  assert.deepEqual(calls, [[['D:\\Images'], 'native', 2, 4]])
})

test('Simple scan omits thumbnails from its critical path', () => {
  const panel = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'ImageSearchPanel.tsx'),
    'utf8',
  )
  assert.match(panel, /imageSearchBridge\.prepareLibrary\(\{[\s\S]*?buildThumbnails: false/)
  assert.match(panel, /progress\.state === 'done'[\s\S]*?startDeferredSimpleThumbnails/)
  assert.match(panel, /imageSearchBridge\.stopPreparation\(taskId\)/)
  assert.doesNotMatch(panel, /runSetupWorkflow/)
})
