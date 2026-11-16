const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const { loadTsModule } = require('./guard-utils.cjs')

function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-postcheck-service-'))
  const source = path.join(root, 'unsupported.jpg')
  const header = Buffer.from('ffd8ffc100110c01e0028003011100021101031101ffd9', 'hex')
  fs.writeFileSync(source, header)
  const { ScanErrorRecorder } = loadTsModule('electron/scanErrorLog.ts')
  const recorder = new ScanErrorRecorder()
  const records = [],
    failures = [],
    snapshots = []
  let settled = 0
  recorder.configure(
    (_id, event, detail) => records.push({ event, detail }),
    async () => {
      settled++
      if (options.diagnosticsFailure) throw Error('diagnostic disk unavailable')
    },
  )
  const store = {
    getPersistenceStatus: () => ({ pendingWrites: 0 }),
    replaceAll: (jobs) => snapshots.push(structuredClone(jobs)),
    flush: async () => {},
  }
  const mocks = {
    './storagePathResolver': { getConfiguredStorageRoot: () => root },
    './vectorDatabaseService': {
      jobStore: store,
      appendEmbeddingNoUpsertAsync: options.persist || (async () => {}),
    },
    './embeddingJobLedgerSession': loadTsModule('electron/embeddingJobLedgerSession.ts'),
    './embeddingInputFailureReview': loadTsModule('electron/embeddingInputFailureReview.ts'),
    './scanErrorLog': { scanErrorRecorder: recorder },
    './embeddingStreamController': {
      createEmbeddingStreamController: () => ({ isOpen: () => false, clear: () => {} }),
    },
    './embeddingChildLineFraming': {
      createEmbeddingStageMetrics: () => ({}),
      embeddingStageMetricsEnabled: () => false,
    },
    './embeddingProgressRuntime': {
      nextEmbeddingProgress: (progress, patch) => ({ ...progress, ...patch }),
      recordEmbeddingPersistenceEnqueuedRuntime: (metrics) => metrics,
      recordEmbeddingPersistenceFinishedRuntime: (input) => input.stageMetrics,
    },
    './embeddingLogRetention': {
      appendEmbeddingFailure: (_file, row) => failures.push(row),
      appendEmbeddingDiagnostic: () => {},
      selectRetainedEmbeddingJobs: (jobs) => jobs,
    },
  }
  const file = path.resolve(__dirname, '../electron/embeddingService.ts')
  const mod = new Module(file, module)
  mod.filename = file
  mod.paths = Module._nodeModulePaths(path.dirname(file))
  mod.require = (id) => {
    if (mocks[id]) return mocks[id]
    if (!id.startsWith('.')) return require(id)
    return {}
  }
  const extra = `
    export const __postcheckTest = {
      start(count, run) {
        jobLedgerSession.finish('test-reset', true);
        buildRunId = run; stopping = false; paused = false;
        taskQueue = []; pendingPersistence = 0; preparationProducerOpen = false;
        inputReviewActive = false; failedInputReviews = [];
        progress = { state: 'running', modelName: 'dinov2_vitb14', total: count, completed: 0, failed: 0, skipped: 0, inputSkipped: 0, running: count, pending: 0 };
        const jobs = Array.from({length:count}, (_, i) => ({ id:i+1, imageId:'source-'+i+'.jpg', path:'source-'+i+'.jpg', status:'pending', modelName:'dinov2_vitb14', embeddingType:'global', retries:0, createdAt:Date.now() }));
        jobLedgerSession.start(jobs, run);
        return jobs.map(j => ({ imageId:j.imageId, modelName:j.modelName, modelVersion:'1.0.0', dim:2, jobId:j.id, jobLease:jobLedgerSession.claim(j.id), ok:false, error:'Unknown error', inputFailure:true }));
      },
      handle:handleResult, progress:()=>({...progress}), stop:stopEmbeddingBuild
    };
  `
  mod._compile(
    ts.transpileModule(fs.readFileSync(file, 'utf8') + extra, {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    file,
  )
  t.after(() => {
    mod.exports.__postcheckTest.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    ...mod.exports.__postcheckTest,
    source,
    records,
    failures,
    snapshots,
    settled: () => settled,
  }
}

async function done(h) {
  const deadline = Date.now() + 3000
  while (!['done', 'error'].includes(h.progress().state)) {
    assert.ok(Date.now() < deadline, 'postcheck must settle')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('real service final review preserves successful vectors and records rejected files as skipped', async (t) => {
  const h = harness(t)
  const [good, bad] = h.start(2, 'build-a')
  h.handle({ ...good, ok: true, vector: [1, 0] })
  h.handle({ ...bad, inputPath: h.source })
  await done(h)
  const p = h.progress()
  assert.deepEqual([p.completed, p.failed, p.skipped, p.inputSkipped], [1, 0, 1, 1])
  // Existing retention prunes completed/skipped jobs, but retains failed jobs.
  assert.deepEqual(h.snapshots.at(-1), [])
  assert.equal(h.failures.length, 0)
  const row = h.records.flatMap((r) => r.detail.items || [])[0]
  assert.equal(row.stage, 'embedding-input')
  assert.equal(row.severity, 'skipped')
  assert.equal(row.code, 'INPUT_NOT_SUPPORTED')
  assert.ok(!JSON.stringify(h.records).includes(h.source))
})

test('unmarked unknown and GPU failures are retained as failures in the real service', async (t) => {
  const h = harness(t)
  const [unknown, gpu] = h.start(2, 'build-b')
  h.handle({ ...unknown, inputPath: h.source, inputFailure: false })
  h.handle({ ...gpu, inputPath: h.source, error: 'CUDA out of memory' })
  await done(h)
  assert.equal(h.progress().failed, 2)
  assert.equal(h.progress().skipped, 0)
  assert.equal(h.failures.length, 2)
  const rows = h.records.flatMap((r) => r.detail.items || [])
  assert.equal(rows.length, 2)
  assert.ok(
    rows.every(
      (r) => r.stage === 'embedding' && r.code === 'EMBEDDING_FAILED' && r.severity === 'error',
    ),
  )
  assert.deepEqual(
    h.snapshots.at(-1).map((job) => job.status),
    ['failed', 'failed'],
  )
})

test('an inconclusive input review exports the per-file failure instead of only a final count', async (t) => {
  const h = harness(t)
  const header = fs.readFileSync(h.source)
  header[6] = 8
  fs.writeFileSync(h.source, header)
  const [task] = h.start(1, 'inconclusive-input')
  h.handle({ ...task, inputPath: h.source })
  await done(h)
  assert.equal(h.progress().failed, 1)
  assert.equal(h.progress().skipped, 0)
  const rows = h.records.flatMap((r) => r.detail.items || [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].reason, 'Unknown error')
  assert.equal(rows[0].details.inputDecodeFailure, true)
  assert.equal(rows[0].details.model, 'dinov2_vitb14')
  assert.ok(rows[0].sourceId)
  assert.equal(h.failures.length, 1)
})

test('vector persistence failures cannot be reclassified as unsupported images', async (t) => {
  const h = harness(t, {
    persist: async () => {
      throw Error('ENOSPC')
    },
  })
  const [task] = h.start(1, 'build-c')
  h.handle({ ...task, inputPath: h.source, ok: true, vector: [1, 0] })
  await done(h)
  assert.equal(h.progress().failed, 1)
  assert.equal(h.progress().skipped, 0)
  assert.match(h.failures[0].error, /Vector persistence failed/)
})

test('postcheck persistence errors remain real errors instead of reporting a clean completion', async (t) => {
  const h = harness(t, { diagnosticsFailure: true })
  const [task] = h.start(1, 'diagnostic-error')
  h.handle({ ...task, inputPath: h.source })
  await done(h)
  assert.equal(h.progress().state, 'error')
  assert.match(h.progress().error, /Input header review failed/)
})

test('a late header review cannot change the next build or a stopped build', async (t) => {
  const h = harness(t)
  const [old] = h.start(1, 'old-run')
  h.handle({ ...old, inputPath: h.source })
  h.start(1, 'new-run')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual([h.progress().running, h.progress().failed, h.progress().skipped], [1, 0, 0])
  const [stopped] = h.start(1, 'stopped-run')
  h.handle({ ...stopped, inputPath: h.source })
  h.stop()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(h.progress().skipped, 0)
  assert.equal(h.records.flatMap((r) => r.detail.items || []).length, 0)
})

test('bulk rejected inputs are persisted in bounded batches before completion', async (t) => {
  const h = harness(t)
  const tasks = h.start(160, 'bulk-run')
  for (const task of tasks) h.handle({ ...task, inputPath: h.source })
  await done(h)
  assert.equal(h.progress().failed, 0)
  assert.equal(h.progress().skipped, 160)
  assert.ok(h.settled() >= 3)
  assert.equal(h.records.flatMap((r) => r.detail.items || []).length, 160)
})
