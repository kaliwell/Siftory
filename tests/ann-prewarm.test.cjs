const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Worker } = require('node:worker_threads')
const { loadTsModule } = require('./guard-utils.cjs')

// Stub electron before loading the ANN host / prewarm service: worker
// resolution reads app.isPackaged, and the built worker bundle is exercised
// via dist-electron.
const electronModulePath = require.resolve('electron')
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: { app: { isPackaged: false, getPath: () => os.tmpdir() } },
}

const f16 = loadTsModule('electron/embeddingF16Cache.ts')
const store = loadTsModule('electron/authoritativeVectorStore.ts')
const migration = loadTsModule('electron/vectorStoreMigrationService.ts')
const prewarmApi = loadTsModule('electron/annPrewarmService.ts')
const annHost = loadTsModule('electron/vectorAnnWorkerHost.ts')

const workerPath = path.resolve(__dirname, '..', 'dist-electron', 'vectorAnnWorker.js')

test.after(() => {
  // The migration trigger fires the default (real-worker) scheduler in the
  // background; release the ref'd worker so the test process can exit.
  annHost.disposeVectorAnnWorker()
})

function fakeCache(directory, overrides = {}) {
  return {
    meta: {
      version: 2,
      modelName: 'dinov2_vitb14',
      embeddingType: 'global',
      dim: 3,
      count: 2,
      sourceRecordCount: 2,
      sourceFiles: [{ path: path.join(directory, 'source.jsonl'), size: 10, mtimeMs: 1 }],
      updatedAt: 1,
      generation: 'gen-1',
      ...overrides.meta,
    },
    vectorPath: path.join(directory, 'vectors.f16'),
    pathIndexPath: path.join(directory, 'vectors.paths.jsonl'),
    integrity: {
      vectors: { size: 12, sha256: 'a'.repeat(64) },
      paths: { size: 10, sha256: 'b'.repeat(64) },
    },
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function waitFor(predicate, timeoutMs = 5_000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('timed out waiting for ANN state')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('prewarm scheduler dedupes per generation and retries after failure', async () => {
  const errors = []
  let next = deferred()
  const calls = []
  const scheduler = prewarmApi.createAnnPrewarmScheduler(
    () => {
      calls.push(1)
      return next.promise
    },
    (message) => errors.push(message),
  )
  const cache = fakeCache(os.tmpdir())

  assert.equal(scheduler.schedule(cache), 'scheduled')
  assert.equal(scheduler.schedule(cache), 'duplicate', 'in-flight prewarm must not double-build')
  await tick()
  assert.equal(calls.length, 1)
  next.resolve()
  await tick()
  assert.equal(scheduler.schedule(cache), 'duplicate', 'warmed generation must not rebuild')
  assert.equal(calls.length, 1)

  next = deferred()
  const changed = fakeCache(os.tmpdir(), {
    meta: { count: 3, sourceRecordCount: 3, updatedAt: 2 },
  })
  assert.equal(scheduler.schedule(changed), 'scheduled', 'a new generation prewarms separately')
  next.reject(new Error('worker exploded'))
  await tick()
  assert.equal(errors.length, 1)
  assert.match(errors[0], /worker exploded/)
  assert.equal(scheduler.schedule(changed), 'scheduled', 'failed prewarm stays retryable')
  next = deferred()
  next.resolve()
  await tick()

  scheduler.clearHistory()
  next = deferred()
  assert.equal(scheduler.schedule(cache), 'scheduled', 'history reset re-arms the generation')
  next.resolve()
  await tick()
})

function row(imageId, vector, modelName = 'dinov2_vitb14') {
  return JSON.stringify({ modelName, embeddingType: 'global', imageId, dim: vector.length, vector })
}

async function waitForMigration() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const progress = migration.getVectorStoreMigrationProgress()
    if (progress.state !== 'running') return progress
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('migration test timed out')
}

test('authoritative generation ready schedules one prewarm per generation', async (t) => {
  migration.resetVectorStoreMigrationForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-prewarm-'))
  t.after(() => {
    // Stop the migration-triggered background prewarm before removing the
    // generation files it may still be verifying.
    annHost.disposeVectorAnnWorker()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const embeddings = path.join(root, 'vector-db', 'embeddings')
  fs.mkdirSync(embeddings, { recursive: true })
  const source = path.join(embeddings, 'dinov2_vitb14__global.jsonl')
  fs.writeFileSync(
    source,
    [row('C:\\images\\a.jpg', [1, 0, 0]), row('C:\\images\\b.jpg', [0, 2, 0])].join('\n'),
  )
  const options = {
    cacheDir: path.join(root, 'vector-db', 'embedding-cache'),
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim: 3,
    sourcePaths: [source],
  }
  const preview = migration.createVectorStoreMigrationPreview(root, [options])
  assert.equal(migration.startVectorStoreMigration(root, preview.token).ok, true)
  const completed = await waitForMigration()
  assert.equal(completed.state, 'completed', completed.errors.join('\n'))

  const warmed = []
  const scheduler = prewarmApi.createAnnPrewarmScheduler((cache) => {
    warmed.push(cache)
    return Promise.resolve()
  })
  const first = prewarmApi.scheduleAuthoritativeAnnPrewarm(options.cacheDir, scheduler)
  assert.equal(first.generation, completed.generation)
  assert.equal(first.scheduled, 1)
  assert.equal(first.skipped, 0)
  await tick()
  await tick()
  assert.equal(warmed.length, 1)

  // The handle minted for prewarm carries the manifest-pinned content proofs,
  // so the worker-side VAL-038 gate re-verifies the exact bytes it indexes.
  const manifest = store.readCurrentAuthoritativeManifest(
    path.join(root, 'vector-db', 'vector-store'),
  )
  assert.equal(warmed[0].meta.generation, completed.generation)
  assert.equal(warmed[0].integrity.vectors.sha256, manifest.entries[0].vectors.sha256)
  assert.equal(warmed[0].integrity.paths.sha256, manifest.entries[0].paths.sha256)

  const second = prewarmApi.scheduleAuthoritativeAnnPrewarm(options.cacheDir, scheduler)
  assert.equal(second.scheduled, 0, 'same generation is never prewarmed twice')
  assert.equal(second.skipped, 1)
  assert.equal(warmed.length, 1)

  scheduler.clearHistory()
  const restorePolicy = prewarmApi.configureAnnPrewarmRuntimePolicy({
    preferredModelName: 'dinov2_vitb14',
    canStart: () => false,
  })
  try {
    const blocked = prewarmApi.scheduleAuthoritativeAnnPrewarm(options.cacheDir, scheduler)
    assert.deepEqual(blocked, {
      generation: completed.generation,
      scheduled: 0,
      skipped: 1,
    })
    await tick()
    assert.equal(warmed.length, 1, 'runtime pressure/build policy must avoid vector reads')
  } finally {
    restorePolicy()
  }

  // Source freshness must not gate warming: removed import copies do not
  // invalidate the committed generation bytes.
  fs.unlinkSync(source)
  const third = prewarmApi.scheduleAuthoritativeAnnPrewarm(options.cacheDir, scheduler)
  assert.equal(third.scheduled, 1)

  const empty = prewarmApi.scheduleAuthoritativeAnnPrewarm(
    path.join(root, 'no-such-cache'),
    scheduler,
  )
  assert.deepEqual(empty, { generation: null, scheduled: 0, skipped: 0 })
})

function createCache(directory, options = {}) {
  const dim = options.dim || 32
  const count = options.count || 64
  const vectorPath = path.join(directory, 'synthetic.f16')
  const pathIndexPath = path.join(directory, 'synthetic.paths.jsonl')
  const vectors = Buffer.alloc(count * dim * 2)
  const paths = []
  for (let rowIndex = 0; rowIndex < count; rowIndex++) {
    const vector = new Float32Array(dim)
    vector[rowIndex % dim] = 1
    for (let dimension = 0; dimension < dim; dimension++) {
      vectors.writeUInt16LE(
        f16.float32ToFloat16(vector[dimension]),
        (rowIndex * dim + dimension) * 2,
      )
    }
    paths.push(JSON.stringify({ row: rowIndex, path: `C:\\synthetic\\image-${rowIndex}.png` }))
  }
  fs.writeFileSync(vectorPath, vectors)
  fs.writeFileSync(pathIndexPath, `${paths.join('\n')}\n`, 'utf8')
  return {
    meta: {
      version: 1,
      modelName: options.modelName || 'synthetic-model',
      embeddingType: 'global',
      dim,
      count,
      sourceRecordCount: count,
      sourceFiles: [{ path: vectorPath, size: vectors.length, mtimeMs: 1 }],
      updatedAt: 1,
      ...(options.generation ? { generation: options.generation } : {}),
    },
    vectorPath,
    pathIndexPath,
  }
}

function queryVector(dim) {
  return [1, ...new Array(dim - 1).fill(0)]
}

function createWorkerSession() {
  const worker = new Worker(workerPath)
  let nextRequestId = 1
  const send = (type, cache, extra = {}) =>
    new Promise((resolve, reject) => {
      const requestId = nextRequestId++
      const onError = (error) => {
        worker.off('message', onMessage)
        reject(error)
      }
      const onMessage = (message) => {
        if (message.requestId !== requestId || message.type === 'progress') return
        worker.off('error', onError)
        worker.off('message', onMessage)
        if (message.type === 'result') resolve(message.result)
        else reject(new Error(message.error || message.type))
      }
      worker.once('error', onError)
      worker.on('message', onMessage)
      worker.postMessage({
        type,
        requestId,
        cache,
        stopBuffer: new SharedArrayBuffer(4),
        ...extra,
      })
    })
  return {
    search: (cache) => send('search', cache, { queryVector: queryVector(cache.meta.dim), topK: 8 }),
    prewarm: (cache) => send('prewarm', cache),
    close: () => worker.terminate(),
  }
}

function signaturePaths(cache) {
  const base = path.basename(cache.vectorPath, path.extname(cache.vectorPath))
  const directory = path.dirname(cache.vectorPath)
  return {
    meta: path.join(directory, `${base}.ann-simhash-v1.json`),
    signatures: path.join(directory, `${base}.ann-simhash-v1.bin`),
  }
}

test('prewarm builds an index identical to the on-demand build', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-parity-'))
  try {
    const cache = createCache(directory, { count: 4096, dim: 64 })
    const files = signaturePaths(cache)

    const coldSession = createWorkerSession()
    const cold = await coldSession.search(cache)
    await coldSession.close()
    assert.equal(cold.built, true)
    assert.equal(cold.buildMode, 'full')
    const coldSignatures = fs.readFileSync(files.signatures)

    fs.unlinkSync(files.meta)
    fs.unlinkSync(files.signatures)

    const warmSession = createWorkerSession()
    try {
      const prewarmed = await warmSession.prewarm(cache)
      assert.equal(prewarmed.built, true)
      assert.equal(prewarmed.buildMode, 'full')
      assert.equal(prewarmed.indexedCount, cache.meta.count)
      assert.deepEqual(prewarmed.results, [])
      assert.deepEqual(fs.readFileSync(files.signatures), coldSignatures)

      const warm = await warmSession.search(cache)
      assert.equal(warm.built, false, 'prewarmed session must reuse the loaded index')
      assert.equal(warm.buildMode, 'none')
      assert.equal(warm.loadMs, 0)
      assert.equal(warm.snapshotLoadMode, 'none')
      assert.deepEqual(warm.results, cold.results)
    } finally {
      await warmSession.close()
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('warm first query skips the cold build cost', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-warm-'))
  try {
    const cache = createCache(directory, { count: 16384, dim: 64 })

    const coldSession = createWorkerSession()
    const coldStarted = performance.now()
    const cold = await coldSession.search(cache)
    const coldFirstQueryMs = performance.now() - coldStarted
    await coldSession.close()

    const files = signaturePaths(cache)
    fs.unlinkSync(files.meta)
    fs.unlinkSync(files.signatures)

    const warmSession = createWorkerSession()
    try {
      await warmSession.prewarm(cache)
      const warmStarted = performance.now()
      const warm = await warmSession.search(cache)
      const warmFirstQueryMs = performance.now() - warmStarted

      assert.equal(warm.built, false)
      assert.equal(warm.loadMs, 0)
      assert.deepEqual(warm.results, cold.results)
      assert.ok(
        warmFirstQueryMs < coldFirstQueryMs,
        `warm first query (${warmFirstQueryMs.toFixed(1)}ms) must beat cold (${coldFirstQueryMs.toFixed(1)}ms)`,
      )
      console.log(
        `[ann-prewarm benchmark] first query cold=${coldFirstQueryMs.toFixed(1)}ms warm=${warmFirstQueryMs.toFixed(1)}ms (16K x 64 synthetic)`,
      )
    } finally {
      await warmSession.close()
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('host searches preempt an in-flight prewarm, prewarms never preempt a search', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  annHost.disposeVectorAnnWorker()
  const directoryA = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-host-a-'))
  const directoryB = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-host-b-'))
  const directoryC = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-host-c-'))
  try {
    const cacheA = createCache(directoryA, { count: 16384, dim: 64 })
    const cacheB = createCache(directoryB, { count: 256, dim: 64 })
    const cacheC = createCache(directoryC, { count: 512, dim: 64 })

    // A real search supersedes the background prewarm immediately.
    const prewarm = annHost.prewarmVectorAnn(cacheA)
    const search = annHost.searchVectorAnn(cacheA, queryVector(cacheA.meta.dim), 8)
    await assert.rejects(prewarm, /superseded|cancelled/)
    const result = await search
    assert.equal(result.built, true)
    assert.equal(result.results[0].path, 'C:\\synthetic\\image-0.png')

    // A prewarm requested while a search runs waits behind it instead of
    // cancelling the user's query.
    const secondSearch = annHost.searchVectorAnn(cacheA, queryVector(cacheA.meta.dim), 8)
    const replaced = annHost.prewarmVectorAnn(cacheB)
    const queued = annHost.prewarmVectorAnn(cacheC)
    await assert.rejects(replaced, /replaced/)
    await secondSearch
    const queuedResult = await queued
    assert.equal(queuedResult.built, true)
    assert.equal(queuedResult.buildMode, 'full')
    assert.equal(queuedResult.indexedCount, cacheC.meta.count)
  } finally {
    annHost.disposeVectorAnnWorker()
    fs.rmSync(directoryA, { recursive: true, force: true })
    fs.rmSync(directoryB, { recursive: true, force: true })
    fs.rmSync(directoryC, { recursive: true, force: true })
  }
})

test('ANN host releases success, cancellation, and error paths after the idle window', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  annHost.disposeVectorAnnWorker()
  const restoreTimeout = annHost.setVectorAnnWorkerIdleTimeoutForTests(25)
  const successRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-release-ok-'))
  const cancelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-release-cancel-'))
  const errorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-release-error-'))
  try {
    const successCache = createCache(successRoot, { count: 1024, dim: 64 })
    await annHost.prewarmVectorAnn(successCache)
    await waitFor(() => annHost.getVectorAnnRuntimeMemorySnapshot().lifecycleState === 'absent')

    const cancelCache = createCache(cancelRoot, { count: 16384, dim: 64 })
    await assert.rejects(
      annHost.prewarmVectorAnn(cancelCache, { isCancelled: () => true }),
      /cancelled/,
    )
    await waitFor(() => annHost.getVectorAnnRuntimeMemorySnapshot().lifecycleState === 'absent')

    const errorCache = createCache(errorRoot, { count: 1024, dim: 64 })
    fs.rmSync(errorCache.vectorPath)
    await assert.rejects(annHost.prewarmVectorAnn(errorCache), /ANN|ENOENT|open/i)
    await waitFor(() => annHost.getVectorAnnRuntimeMemorySnapshot().lifecycleState === 'absent')

    const released = annHost.getVectorAnnRuntimeMemorySnapshot()
    assert.equal(released.workerResident, false)
    assert.equal(released.activeKind, null)
    assert.equal(released.queuedPrewarm, false)
    assert.equal(released.idleTimerScheduled, false)
    assert.equal(released.owned, null)
  } finally {
    restoreTimeout()
    annHost.disposeVectorAnnWorker()
    fs.rmSync(successRoot, { recursive: true, force: true })
    fs.rmSync(cancelRoot, { recursive: true, force: true })
    fs.rmSync(errorRoot, { recursive: true, force: true })
  }
})

test('memory pressure releases idle ANN state without interrupting an active search', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  annHost.disposeVectorAnnWorker()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-pressure-'))
  try {
    const cache = createCache(directory, { count: 16384, dim: 64 })
    await annHost.prewarmVectorAnn(cache)
    assert.equal(annHost.getVectorAnnRuntimeMemorySnapshot().lifecycleState, 'idle')
    assert.deepEqual(annHost.requestVectorAnnMemoryPressureRelease(), {
      released: true,
      deferred: false,
    })
    await waitFor(() => annHost.getVectorAnnRuntimeMemorySnapshot().lifecycleState === 'absent')

    const search = annHost.searchVectorAnn(cache, queryVector(cache.meta.dim), 8)
    assert.deepEqual(annHost.requestVectorAnnMemoryPressureRelease(), {
      released: false,
      deferred: true,
    })
    assert.equal(annHost.getVectorAnnRuntimeMemorySnapshot().memoryPressureReleasePending, true)
    const result = await search
    assert.equal(result.results[0].path, 'C:\\synthetic\\image-0.png')
    await waitFor(() => annHost.getVectorAnnRuntimeMemorySnapshot().lifecycleState === 'absent')
    const released = annHost.getVectorAnnRuntimeMemorySnapshot()
    assert.equal(released.memoryPressureReleasePending, false)
    assert.equal(released.workerResident, false)
  } finally {
    annHost.disposeVectorAnnWorker()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('generation and model switches replace the resident ANN worker and safe resident key', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  annHost.disposeVectorAnnWorker()
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-generation-a-'))
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-generation-b-'))
  const rootC = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-model-c-'))
  try {
    const cacheA = createCache(rootA, { generation: 'a' })
    const cacheB = createCache(rootB, { generation: 'b' })
    const cacheC = createCache(rootC, { generation: 'c', modelName: 'other-model' })
    await annHost.prewarmVectorAnn(cacheA)
    const first = annHost.getVectorAnnRuntimeMemorySnapshot()
    assert.equal(first.residentModel, 'synthetic-model')
    assert.match(first.residentKey, /^[a-f0-9]{64}$/)

    await annHost.searchVectorAnn(cacheB, queryVector(cacheB.meta.dim), 8)
    const second = annHost.getVectorAnnRuntimeMemorySnapshot()
    assert.ok(second.lifecycleGeneration > first.lifecycleGeneration)
    assert.notEqual(second.residentKey, first.residentKey)
    assert.equal(second.residentModel, 'synthetic-model')

    await annHost.searchVectorAnn(cacheC, queryVector(cacheC.meta.dim), 8)
    const third = annHost.getVectorAnnRuntimeMemorySnapshot()
    assert.ok(third.lifecycleGeneration > second.lifecycleGeneration)
    assert.notEqual(third.residentKey, second.residentKey)
    assert.equal(third.residentModel, 'other-model')
  } finally {
    annHost.disposeVectorAnnWorker()
    fs.rmSync(rootA, { recursive: true, force: true })
    fs.rmSync(rootB, { recursive: true, force: true })
    fs.rmSync(rootC, { recursive: true, force: true })
  }
})

test('host dedupes concurrent prewarms and reuses the warmed index', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  annHost.disposeVectorAnnWorker()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-host-dedupe-'))
  try {
    const cache = createCache(directory, { count: 1024, dim: 64 })
    const first = annHost.prewarmVectorAnn(cache)
    const second = annHost.prewarmVectorAnn(cache)
    assert.strictEqual(first, second, 'same generation shares one in-flight prewarm')
    const warmed = await first
    assert.equal(warmed.built, true)

    const again = await annHost.prewarmVectorAnn(cache)
    assert.equal(again.built, false, 'already-loaded generation is not rebuilt')
    assert.equal(again.buildMode, 'none')
    assert.equal(again.loadMs, 0)
  } finally {
    annHost.disposeVectorAnnWorker()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('ANN host exposes explicit lifecycle states and idempotent disposal', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  annHost.disposeVectorAnnWorker()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-host-state-'))
  try {
    const cache = createCache(directory, { count: 1024, dim: 64 })
    const generationBefore = annHost.getVectorAnnRuntimeMemorySnapshot().lifecycleGeneration
    const request = annHost.prewarmVectorAnn(cache)
    const active = annHost.getVectorAnnRuntimeMemorySnapshot()
    assert.equal(active.lifecycleState, 'active')
    assert.equal(active.activeKind, 'prewarm')
    assert.ok(active.lifecycleGeneration > generationBefore)

    await request
    const idle = annHost.getVectorAnnRuntimeMemorySnapshot()
    assert.equal(idle.lifecycleState, 'idle')
    assert.equal(idle.idleTimerScheduled, true)
    assert.match(idle.lifecycleReason, /completed/)

    annHost.disposeVectorAnnWorker()
    const disposing = annHost.getVectorAnnRuntimeMemorySnapshot()
    assert.equal(disposing.workerResident, false)
    assert.equal(disposing.lifecycleState, 'disposing')
    assert.equal(disposing.activeKind, null)
    assert.equal(disposing.owned, null)

    annHost.disposeVectorAnnWorker()
    const disposedAgain = annHost.getVectorAnnRuntimeMemorySnapshot()
    assert.equal(disposedAgain.workerResident, false)
    assert.equal(disposedAgain.lifecycleState, 'absent')
    assert.match(disposedAgain.lifecycleReason, /already-absent/)
  } finally {
    annHost.disposeVectorAnnWorker()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
