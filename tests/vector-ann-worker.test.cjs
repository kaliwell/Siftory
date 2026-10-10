const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Worker } = require('node:worker_threads')
const { loadTsModule } = require('./guard-utils.cjs')

const f16 = loadTsModule('electron/embeddingF16Cache.ts')
const integrityStore = loadTsModule('electron/authoritativeVectorStore.ts')
const workerPath = path.resolve(__dirname, '..', 'dist-electron', 'vectorAnnWorker.js')

// Stub electron before loading the ANN host: worker resolution reads
// app.isPackaged, and the built worker bundle is exercised via dist-electron.
const electronModulePath = require.resolve('electron')
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: { app: { isPackaged: false, getPath: () => os.tmpdir() } },
}
const annHost = loadTsModule('electron/vectorAnnWorkerHost.ts')

function createCache(directory, options = {}) {
  const dim = options.dim || 32
  const count = options.count || 64
  const vectorPath = path.join(directory, 'synthetic.f16')
  const pathIndexPath = path.join(directory, 'synthetic.paths.jsonl')
  const vectors = Buffer.alloc(count * dim * 2)
  const paths = []
  for (let row = 0; row < count; row++) {
    const vector = new Float32Array(dim)
    vector[row % dim] = 1
    for (let dimension = 0; dimension < dim; dimension++) {
      vectors.writeUInt16LE(f16.float32ToFloat16(vector[dimension]), (row * dim + dimension) * 2)
    }
    paths.push(JSON.stringify({ row, path: `C:\\synthetic\\image-${row}.png` }))
  }
  fs.writeFileSync(vectorPath, vectors)
  fs.writeFileSync(pathIndexPath, `${paths.join('\n')}\n`, 'utf8')
  return {
    meta: {
      version: 1,
      modelName: 'synthetic-model',
      embeddingType: 'global',
      dim,
      count,
      sourceRecordCount: count,
      sourceFiles: [{ path: vectorPath, size: vectors.length, mtimeMs: 1 }],
      updatedAt: 1,
    },
    vectorPath,
    pathIndexPath,
  }
}

function appendDelta(cache, count, options = {}) {
  const baseCount = cache.delta?.baseCount ?? cache.meta.count
  const previousDeltaCount = cache.meta.count - baseCount
  const vectorPath =
    cache.delta?.vectorPath ?? path.join(path.dirname(cache.vectorPath), 'delta.f16')
  const pathIndexPath =
    cache.delta?.pathIndexPath ?? path.join(path.dirname(cache.vectorPath), 'delta.paths.jsonl')
  const vectors = Buffer.alloc(count * cache.meta.dim * 2)
  const paths = []
  for (let index = 0; index < count; index++) {
    const row = baseCount + previousDeltaCount + index
    const dimension = (row + 3) % cache.meta.dim
    for (let offset = 0; offset < cache.meta.dim; offset++) {
      vectors.writeUInt16LE(
        f16.float32ToFloat16(offset === dimension ? 1 : 0),
        (index * cache.meta.dim + offset) * 2,
      )
    }
    const filePath =
      options.duplicateFirstPath && index === 0
        ? 'C:\\synthetic\\image-0.png'
        : `${options.pathPrefix || 'C:\\synthetic\\delta-'}${previousDeltaCount + index}.png`
    paths.push(JSON.stringify({ row, path: filePath }))
  }
  fs.appendFileSync(vectorPath, vectors)
  fs.appendFileSync(pathIndexPath, `${paths.join('\n')}\n`, 'utf8')
  cache.delta = { vectorPath, pathIndexPath, baseCount }
  cache.meta.count += count
  cache.meta.sourceRecordCount += count
  cache.meta.updatedAt += 1
  cache.meta.sourceFiles = [
    cache.meta.sourceFiles[0],
    ...[vectorPath, pathIndexPath].map((filePath) => {
      const stat = fs.statSync(filePath)
      return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs }
    }),
  ]
}

function createSearchSession() {
  const worker = new Worker(workerPath)
  let nextRequestId = 1
  return {
    search(cache) {
      const requestId = nextRequestId++
      return new Promise((resolve, reject) => {
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
          type: 'search',
          requestId,
          cache,
          queryVector: [1, ...new Array(cache.meta.dim - 1).fill(0)],
          topK: 8,
          stopBuffer: new SharedArrayBuffer(4),
        })
      })
    },
    close() {
      return worker.terminate()
    },
  }
}

async function search(cache) {
  const session = createSearchSession()
  try {
    return await session.search(cache)
  } finally {
    await session.close()
  }
}

test('ANN worker rebuilds a missing or corrupt derived index', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-'))
  try {
    const cache = createCache(directory)
    const first = await search(cache)
    assert.equal(first.built, true)
    assert.equal(first.buildMode, 'full')
    assert.equal(first.results[0].path, 'C:\\synthetic\\image-0.png')

    const signaturePath = path.join(directory, 'synthetic.ann-simhash-v1.bin')
    fs.writeFileSync(signaturePath, Buffer.from([1, 2, 3]))
    const rebuilt = await search(cache)
    assert.equal(rebuilt.built, true)
    assert.equal(rebuilt.buildMode, 'full')
    assert.equal(fs.statSync(signaturePath).size, cache.meta.count * 8)
    assert.equal(rebuilt.results[0].path, 'C:\\synthetic\\image-0.png')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('ANN worker cold restart reuses proven Q8/signature sidecars without a full F16 read', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-sidecar-'))
  try {
    const cache = createCache(directory, { count: 4096 })
    const first = await search(cache)
    assert.equal(first.snapshotLoadMode, 'full')
    assert.ok(first.vectorBytesRead > 0)
    const second = await search(cache)
    assert.equal(second.snapshotLoadMode, 'sidecar-only')
    assert.equal(second.vectorBytesRead, 0)
    assert.deepEqual(second.results, first.results)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('ANN worker extends signatures for a committed delta and remains byte-identical', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-incremental-'))
  try {
    const cache = createCache(directory)
    await search(cache)
    const signaturePath = path.join(directory, 'synthetic.ann-simhash-v1.bin')
    const metaPath = path.join(directory, 'synthetic.ann-simhash-v1.json')
    const baseSignatures = fs.readFileSync(signaturePath)

    appendDelta(cache, 12, { duplicateFirstPath: true })
    const extended = await search(cache)
    const incrementalSignatures = fs.readFileSync(signaturePath)
    assert.equal(extended.built, true)
    assert.equal(extended.buildMode, 'incremental')
    assert.equal(extended.indexedCount, cache.meta.count)
    assert.equal(
      extended.results.some((item) => item.path === 'C:\\synthetic\\image-0.png'),
      false,
      'the obsolete base revision must not survive a duplicate-path delta update',
    )
    assert.deepEqual(incrementalSignatures.subarray(0, baseSignatures.length), baseSignatures)

    fs.unlinkSync(metaPath)
    fs.unlinkSync(signaturePath)
    const rebuilt = await search(cache)
    assert.equal(rebuilt.buildMode, 'full')
    assert.deepEqual(fs.readFileSync(signaturePath), incrementalSignatures)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('ANN worker hot snapshot reads only appended delta vectors and paths', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-hot-delta-'))
  const session = createSearchSession()
  try {
    const cache = createCache(directory)
    const rowBytes = cache.meta.dim * 2
    const first = await session.search(cache)
    assert.equal(first.snapshotLoadMode, 'full')
    assert.equal(first.vectorBytesRead, cache.meta.count * rowBytes)

    const baseBytes = first.vectorBytesRead
    appendDelta(cache, 5, { pathPrefix: 'C:\\合成\\增量-' })
    const hot = await session.search(cache)
    assert.equal(hot.buildMode, 'incremental')
    assert.equal(hot.snapshotLoadMode, 'delta-only')
    assert.equal(hot.vectorBytesRead, 5 * rowBytes)
    assert.equal(hot.reusedVectorBytes, baseBytes)
    assert.ok(hot.pathBytesRead > 0)
    assert.ok(hot.vectorBytesRead < cache.meta.count * rowBytes)

    appendDelta(cache, 2, { pathPrefix: 'C:\\合成\\第二批-' })
    const secondHot = await session.search(cache)
    assert.equal(secondHot.snapshotLoadMode, 'delta-only')
    assert.equal(secondHot.vectorBytesRead, 2 * rowBytes)
    assert.equal(secondHot.reusedVectorBytes, (cache.meta.count - 2) * rowBytes)

    cache.meta.sourceFiles.at(-1).mtimeMs += 1
    const metadataOnly = await session.search(cache)
    assert.equal(metadataOnly.snapshotLoadMode, 'metadata-only')
    assert.equal(metadataOnly.vectorBytesRead, 0)
    assert.equal(metadataOnly.pathBytesRead, 0)

    const reused = await session.search(cache)
    assert.equal(reused.snapshotLoadMode, 'none')
    assert.equal(reused.vectorBytesRead, 0)
    assert.equal(reused.pathBytesRead, 0)
    assert.equal(reused.reusedVectorBytes, cache.meta.count * rowBytes)

    const signaturePath = path.join(directory, 'synthetic.ann-simhash-v1.bin')
    const metaPath = path.join(directory, 'synthetic.ann-simhash-v1.json')
    const hotSignatures = fs.readFileSync(signaturePath)
    fs.unlinkSync(metaPath)
    fs.unlinkSync(signaturePath)
    const cold = await search(cache)
    assert.equal(cold.snapshotLoadMode, 'full')
    assert.deepEqual(secondHot.results, cold.results)
    assert.deepEqual(fs.readFileSync(signaturePath), hotSignatures)
  } finally {
    await session.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('ANN hot delta vector I/O scales with appended rows instead of base rows', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-hot-scale-'))
  const session = createSearchSession()
  try {
    const cache = createCache(directory, { count: 4096 })
    const rowBytes = cache.meta.dim * 2
    await session.search(cache)
    appendDelta(cache, 4)
    const hot = await session.search(cache)
    assert.equal(hot.snapshotLoadMode, 'delta-only')
    assert.equal(hot.vectorBytesRead, 4 * rowBytes)
    assert.equal(hot.reusedVectorBytes, 4096 * rowBytes)
    assert.ok(hot.vectorBytesRead / (hot.vectorBytesRead + hot.reusedVectorBytes) < 0.001)
  } finally {
    await session.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('ANN worker falls back to a full rebuild when the committed delta prefix changes', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-prefix-'))
  const session = createSearchSession()
  try {
    const cache = createCache(directory)
    await session.search(cache)
    appendDelta(cache, 4)
    assert.equal((await session.search(cache)).snapshotLoadMode, 'delta-only')

    const delta = fs.readFileSync(cache.delta.vectorPath)
    delta.writeUInt16LE(f16.float32ToFloat16(0.5), 0)
    fs.writeFileSync(cache.delta.vectorPath, delta)
    appendDelta(cache, 1)
    const rebuilt = await session.search(cache)
    assert.equal(rebuilt.buildMode, 'full')
    assert.equal(rebuilt.snapshotLoadMode, 'full')
  } finally {
    await session.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('ANN worker chunk anchors catch an early delta rewrite beyond the 64 KiB tail', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-chunks-'))
  const session = createSearchSession()
  try {
    const cache = createCache(directory)
    await session.search(cache)
    appendDelta(cache, 2048)
    assert.equal((await session.search(cache)).snapshotLoadMode, 'delta-only')

    const metaPath = path.join(directory, 'synthetic.ann-simhash-v1.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    assert.equal(meta.deltaChunkIntegrity.chunks.length, 4)
    const oldDeltaBytes = 2048 * cache.meta.dim * 2
    const oldTail = integrityStore.sha256FileTailSync(cache.delta.vectorPath, oldDeltaBytes)
    const delta = fs.readFileSync(cache.delta.vectorPath)
    delta.writeUInt16LE(f16.float32ToFloat16(0.5), 0)
    fs.writeFileSync(cache.delta.vectorPath, delta)
    assert.equal(
      integrityStore.sha256FileTailSync(cache.delta.vectorPath, oldDeltaBytes),
      oldTail,
      'the legacy tail window does not cover the changed first chunk',
    )

    appendDelta(cache, 1)
    const rebuilt = await session.search(cache)
    assert.equal(rebuilt.buildMode, 'full')
    assert.equal(rebuilt.snapshotLoadMode, 'full')
  } finally {
    await session.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('ANN worker rejects a hot path snapshot when the committed path prefix changes', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-path-prefix-'))
  const session = createSearchSession()
  try {
    const cache = createCache(directory)
    await session.search(cache)
    appendDelta(cache, 4)
    assert.equal((await session.search(cache)).snapshotLoadMode, 'delta-only')

    const pathRows = fs
      .readFileSync(cache.delta.pathIndexPath, 'utf8')
      .replace('delta-0.png', 'evilx-0.png')
    fs.writeFileSync(cache.delta.pathIndexPath, pathRows, 'utf8')
    appendDelta(cache, 1)
    const rebuilt = await session.search(cache)
    assert.equal(rebuilt.snapshotLoadMode, 'full')
    assert.equal(rebuilt.vectorBytesRead, cache.meta.count * cache.meta.dim * 2)
  } finally {
    await session.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('ANN worker does not extend signatures across a generation change', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-generation-'))
  const session = createSearchSession()
  try {
    const cache = createCache(directory)
    cache.meta.generation = 'generation-a'
    await session.search(cache)
    cache.meta.generation = 'generation-b'
    appendDelta(cache, 2)
    const rebuilt = await session.search(cache)
    assert.equal(rebuilt.buildMode, 'full')
    assert.equal(rebuilt.snapshotLoadMode, 'full')
  } finally {
    await session.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function scopedFixtureCache(directory) {
  const dim = 32
  const entries = []
  // Eight out-of-scope rows match the query exactly and dominate the global
  // topK; two in-scope rows are near the query but score slightly lower.
  for (let index = 0; index < 8; index++) {
    entries.push({ path: `C:\\global\\hit-${index}.png`, vector: [1, 0] })
  }
  entries.push({ path: 'C:\\native\\in-a.png', vector: [0.999, 0.045] })
  entries.push({ path: 'C:\\native\\in-b.png', vector: [0.99, 0.141] })
  for (let row = entries.length; row < 64; row++) {
    entries.push({ path: `C:\\filler\\pad-${row}.png`, vector: [0, 0, 1] })
  }
  const vectorPath = path.join(directory, 'scoped.f16')
  const pathIndexPath = path.join(directory, 'scoped.paths.jsonl')
  const vectors = Buffer.alloc(entries.length * dim * 2)
  const paths = []
  entries.forEach((entry, row) => {
    const vector = new Float32Array(dim)
    for (let dimension = 0; dimension < entry.vector.length; dimension++) {
      vector[dimension] = entry.vector[dimension]
    }
    const norm = Math.hypot(...vector)
    for (let dimension = 0; dimension < dim; dimension++) {
      vectors.writeUInt16LE(
        f16.float32ToFloat16(vector[dimension] / norm),
        (row * dim + dimension) * 2,
      )
    }
    paths.push(JSON.stringify({ row, path: entry.path }))
  })
  fs.writeFileSync(vectorPath, vectors)
  fs.writeFileSync(pathIndexPath, `${paths.join('\n')}\n`, 'utf8')
  return {
    meta: {
      version: 1,
      modelName: 'synthetic-model',
      embeddingType: 'global',
      dim,
      count: entries.length,
      sourceRecordCount: entries.length,
      sourceFiles: [{ path: vectorPath, size: vectors.length, mtimeMs: 1 }],
      updatedAt: 1,
    },
    vectorPath,
    pathIndexPath,
  }
}

function scopedQuery(cache) {
  return [1, ...new Array(cache.meta.dim - 1).fill(0)]
}

test('ANN worker applies the scope snapshot before its bounded topK selection', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-scope-'))
  try {
    const cache = scopedFixtureCache(directory)
    const scopePaths = ['C:\\native\\in-a.png', 'C:\\native\\in-b.png']

    const unscoped = await search(cache)
    assert.ok(
      unscoped.results.every((item) => item.path.startsWith('C:\\global\\')),
      'fixture premise: the unscoped topK is filled with out-of-scope global hits',
    )

    const scoped = await new Promise((resolve, reject) => {
      const worker = new Worker(workerPath)
      const onError = (error) => {
        worker.terminate()
        reject(error)
      }
      const onMessage = (message) => {
        if (message.type === 'progress') return
        worker.off('error', onError)
        worker.off('message', onMessage)
        worker.terminate()
        if (message.type === 'result') resolve(message.result)
        else reject(new Error(message.error || message.type))
      }
      worker.once('error', onError)
      worker.on('message', onMessage)
      worker.postMessage({
        type: 'search',
        requestId: 1,
        cache,
        queryVector: scopedQuery(cache),
        topK: 4,
        stopBuffer: new SharedArrayBuffer(4),
        acceptPathKeys: scopePaths,
      })
    })
    assert.deepEqual(
      scoped.results.map((item) => item.path),
      scopePaths,
      'a scoped search must fill its result slots from in-scope candidates',
    )
    assert.ok(scoped.results[0].score > scoped.results[1].score)

    // Exact-fallback parity: the scoped ANN selection matches the exact
    // prefiltered Float16 scan over the same cache and scope.
    const exact = await f16.searchEmbeddingF16Cache(cache, {
      queryVector: scopedQuery(cache),
      topK: 2,
      acceptPath: (filePath) => scopePaths.includes(filePath),
    })
    assert.deepEqual(
      exact.map((item) => item.path),
      scoped.results.map((item) => item.path),
    )
    for (let index = 0; index < exact.length; index++) {
      assert.ok(Math.abs(exact[index].score - scoped.results[index].score) <= 2e-3)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('ANN host forwards the scope snapshot to the worker', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-scope-host-'))
  try {
    const cache = scopedFixtureCache(directory)
    const scopePaths = ['C:\\native\\in-a.png', 'C:\\native\\in-b.png']
    try {
      const unscoped = await annHost.searchVectorAnn(cache, scopedQuery(cache), 4)
      assert.ok(unscoped.results.every((item) => item.path.startsWith('C:\\global\\')))
      assert.equal(unscoped.memory.vectorBytes, cache.meta.count * cache.meta.dim * 2)
      assert.ok(unscoped.memory.signatureBytes > 0)
      assert.ok(unscoped.memory.projectionBytes > 0)
      assert.ok(unscoped.memory.pathUtf8Bytes > 0)
      assert.ok(unscoped.memory.totalOwnedBytesApprox >= unscoped.memory.vectorBytes)
      assert.deepEqual(annHost.getVectorAnnRuntimeMemorySnapshot().owned, unscoped.memory)
      const scoped = await annHost.searchVectorAnn(cache, scopedQuery(cache), 4, {
        acceptPathKeys: scopePaths,
      })
      assert.deepEqual(
        scoped.results.map((item) => item.path),
        scopePaths,
      )
      const batch = await annHost.searchVectorAnnBatch(
        cache,
        [scopedQuery(cache), scopedQuery(cache)],
        4,
        { acceptPathKeys: scopePaths, candidateRatio: 0.1 },
      )
      assert.equal(batch.results.length, 0)
      assert.equal(batch.queryResults.length, 2)
      assert.deepEqual(batch.queryResults[0].results, batch.queryResults[1].results)
      assert.deepEqual(
        batch.queryResults[0].results.map((item) => item.path),
        scopePaths,
      )
      assert.equal(
        batch.candidateCount,
        batch.queryResults.reduce((sum, item) => sum + item.candidateCount, 0),
      )
      await assert.rejects(() => annHost.searchVectorAnnBatch(cache, [], 4), /between 1 and 8/)
    } finally {
      annHost.disposeVectorAnnWorker()
      const disposed = annHost.getVectorAnnRuntimeMemorySnapshot()
      assert.equal(disposed.workerResident, false)
      assert.ok(['disposing', 'absent'].includes(disposed.lifecycleState))
      assert.equal(disposed.activeKind, null)
      assert.equal(disposed.queuedPrewarm, false)
      assert.equal(disposed.idleTimerScheduled, false)
      assert.equal(disposed.owned, null)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
