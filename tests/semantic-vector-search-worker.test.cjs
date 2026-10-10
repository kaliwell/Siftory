// VAL-028: parity, cancellation, integrity, scope-reuse and 78K-scale
// benchmark fixtures for the CLIP semantic vector search worker. The worker
// bundle is produced by `npm run build:renderer` (wired into test:vector-ann);
// without it every test skips like the ANN worker fixtures.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { PerformanceObserver } = require('node:perf_hooks')
const { Worker } = require('node:worker_threads')
const { loadTsModule } = require('./guard-utils.cjs')

const f16 = loadTsModule('electron/embeddingF16Cache.ts')
const clipScan = loadTsModule('electron/semanticClipScan.ts')
const cacheIntegrity = loadTsModule('electron/embeddingCacheIntegrity.ts')
const workerPath = path.resolve(__dirname, '..', 'dist-electron', 'semanticVectorSearchWorker.js')

// Stub electron before loading the host: worker resolution reads
// app.isPackaged, and the built worker bundle is exercised via dist-electron.
const electronModulePath = require.resolve('electron')
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: { app: { isPackaged: false, getPath: () => os.tmpdir() } },
}
const semanticHost = loadTsModule('electron/semanticVectorSearchWorkerHost.ts')

function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** Synthetic F16 cache with deterministic pseudo-random L2-normalized rows. */
function createCache(directory, options = {}) {
  const dim = options.dim || 32
  const count = options.count || 64
  const seed = options.seed || 42
  const vectorPath = path.join(directory, 'synthetic.f16')
  const pathIndexPath = path.join(directory, 'synthetic.paths.jsonl')
  const vectors = Buffer.alloc(count * dim * 2)
  const random = lcg(seed)
  const row = new Float64Array(dim)
  const paths = []
  for (let rowIndex = 0; rowIndex < count; rowIndex++) {
    let normSquared = 0
    for (let dimension = 0; dimension < dim; dimension++) {
      row[dimension] = random() * 2 - 1
      normSquared += row[dimension] * row[dimension]
    }
    const norm = Math.sqrt(normSquared) || 1
    for (let dimension = 0; dimension < dim; dimension++) {
      vectors.writeUInt16LE(
        f16.float32ToFloat16(row[dimension] / norm),
        (rowIndex * dim + dimension) * 2,
      )
    }
    paths.push(JSON.stringify({ row: rowIndex, path: `C:\\synthetic\\image-${rowIndex}.png` }))
  }
  fs.writeFileSync(vectorPath, vectors)
  fs.writeFileSync(pathIndexPath, `${paths.join('\n')}\n`, 'utf8')
  return {
    meta: {
      version: 3,
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

/** Committed delta segment; duplicateLastBasePath replays a base path forward. */
function appendDelta(cache, count, options = {}) {
  const baseCount = cache.delta?.baseCount ?? cache.meta.count
  const previousDeltaCount = cache.meta.count - baseCount
  const vectorPath =
    cache.delta?.vectorPath ?? path.join(path.dirname(cache.vectorPath), 'delta.f16')
  const pathIndexPath =
    cache.delta?.pathIndexPath ?? path.join(path.dirname(cache.vectorPath), 'delta.paths.jsonl')
  const vectors = Buffer.alloc(count * cache.meta.dim * 2)
  const random = lcg(9000 + previousDeltaCount)
  const row = new Float64Array(cache.meta.dim)
  const paths = []
  for (let index = 0; index < count; index++) {
    let normSquared = 0
    for (let dimension = 0; dimension < cache.meta.dim; dimension++) {
      row[dimension] = random() * 2 - 1
      normSquared += row[dimension] * row[dimension]
    }
    const norm = Math.sqrt(normSquared) || 1
    for (let dimension = 0; dimension < cache.meta.dim; dimension++) {
      vectors.writeUInt16LE(
        f16.float32ToFloat16(row[dimension] / norm),
        (index * cache.meta.dim + dimension) * 2,
      )
    }
    const rowIndex = baseCount + previousDeltaCount + index
    const filePath =
      options.duplicateFirstBasePath && index === 0
        ? 'C:\\synthetic\\image-0.png'
        : `C:\\synthetic\\delta-${previousDeltaCount + index}.png`
    paths.push(JSON.stringify({ row: rowIndex, path: filePath }))
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

/** Deterministic normalized query; not necessarily one-hot. */
function createQuery(dim, seed = 7) {
  const random = lcg(seed)
  const query = new Array(dim)
  let normSquared = 0
  for (let dimension = 0; dimension < dim; dimension++) {
    query[dimension] = random() * 2 - 1
    normSquared += query[dimension] * query[dimension]
  }
  const norm = Math.sqrt(normSquared) || 1
  for (let dimension = 0; dimension < dim; dimension++) query[dimension] /= norm
  return query
}

function scopeKeysFor(cache, predicate) {
  return f16
    .readEmbeddingF16CachePaths(cache)
    .filter(predicate)
    .map((filePath) => f16.embeddingCachePathKey(filePath))
}

function createWorkerSession() {
  const worker = new Worker(workerPath)
  let nextRequestId = 1
  return {
    search({ cache, query, candidateK, scopeId = 0, scopeKeys, stopBuffer }) {
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
          queryVector: query,
          candidateK,
          stopBuffer: stopBuffer || new SharedArrayBuffer(4),
          scopeId,
          ...(scopeKeys ? { scopeKeys } : {}),
        })
      })
    },
    close() {
      return worker.terminate()
    },
  }
}

function withTempDirectory(prefix, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return Promise.resolve()
    .then(() => run(directory))
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }))
}

/**
 * Host-path comparison: identical path order, scores within F16 tolerance.
 * The host re-validates/re-normalizes the query, which can drift the dot by
 * ~1e-14; the raw worker path is asserted bit-identical instead (see the
 * parity fixture above).
 */
function assertHostCandidatesMatch(actual, expected) {
  assert.equal(actual.length, expected.length)
  assert.deepEqual(
    actual.map((candidate) => candidate.path),
    expected.map((candidate) => candidate.path),
  )
  for (let index = 0; index < actual.length; index++) {
    assert.ok(
      Math.abs(actual[index].score - expected[index].score) <= 1e-9,
      `score drift at rank ${index}: ${actual[index].score} vs ${expected[index].score}`,
    )
    assert.equal(actual[index].cacheRow, expected[index].cacheRow)
    assert.deepEqual(actual[index].reasons, expected[index].reasons)
  }
}

test('worker scan is bit-identical to the in-process reference scan', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  await withTempDirectory('floating-clock-semantic-parity-', async (directory) => {
    const cache = createCache(directory, { dim: 64, count: 3000 })
    appendDelta(cache, 500, { duplicateFirstBasePath: true })
    const query = createQuery(cache.meta.dim)
    const topK = 25
    const session = createWorkerSession()
    try {
      // Unscoped parity, including the duplicate-path delta revision.
      const reference = await clipScan.scanSemanticClipCache(cache, {
        query,
        candidateK: topK,
      })
      const scanned = await session.search({ cache, query, candidateK: topK })
      assert.equal(scanned.scanned, reference.scanned)
      assert.deepEqual(scanned.candidates, reference.baseCandidates)
      assert.equal(
        scanned.candidates.some((candidate) => candidate.path === 'C:\\synthetic\\image-0.png'),
        reference.baseCandidates.some(
          (candidate) => candidate.path === 'C:\\synthetic\\image-0.png',
        ),
      )

      // Scoped parity: the scope filter runs before the bounded topK heap.
      const keys = scopeKeysFor(
        cache,
        (filePath) => Number(filePath.match(/(\d+)\.png$/)[1]) % 3 === 0,
      )
      const scopedReference = await clipScan.scanSemanticClipCache(cache, {
        query,
        candidateK: topK,
        acceptPathKeys: new Set(keys),
      })
      const scoped = await session.search({
        cache,
        query,
        candidateK: topK,
        scopeId: 1,
        scopeKeys: keys,
      })
      assert.equal(scoped.scanned, scopedReference.scanned)
      assert.deepEqual(scoped.candidates, scopedReference.baseCandidates)
      assert.ok(
        scoped.candidates.every((candidate) =>
          keys.includes(f16.embeddingCachePathKey(candidate.path)),
        ),
      )
    } finally {
      await session.close()
    }
  })
})

test('worker shares the scope snapshot across queries by scope id', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  await withTempDirectory('floating-clock-semantic-scope-', async (directory) => {
    const cache = createCache(directory, { dim: 32, count: 512 })
    const query = createQuery(cache.meta.dim)
    const keys = scopeKeysFor(cache, (filePath) => filePath.includes('image-1'))
    const session = createWorkerSession()
    try {
      const first = await session.search({
        cache,
        query,
        candidateK: 10,
        scopeId: 5,
        scopeKeys: keys,
      })
      // Same scope id without resending the keys: the worker must reuse the
      // snapshot it already holds (VAL-035 per-query structured clone removed).
      const reused = await session.search({ cache, query, candidateK: 10, scopeId: 5 })
      assert.deepEqual(reused.candidates, first.candidates)
      // scopeId 0 clears the scope again.
      const cleared = await session.search({ cache, query, candidateK: 10, scopeId: 0 })
      assert.ok(cleared.candidates.length >= first.candidates.length)
      // An unknown scope id without keys fails closed.
      await assert.rejects(
        () => session.search({ cache, query, candidateK: 10, scopeId: 99 }),
        /scope snapshot is missing/,
      )
    } finally {
      await session.close()
    }
  })
})

test('worker rejects a cache whose VAL-038 content proof no longer matches', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  await withTempDirectory('floating-clock-semantic-integrity-', async (directory) => {
    const cache = createCache(directory, { dim: 32, count: 256 })
    cache.integrity = {
      vectors: cacheIntegrity.createEmbeddingCacheFileProof(cache.vectorPath),
      paths: cacheIntegrity.createEmbeddingCacheFileProof(cache.pathIndexPath),
    }
    const query = createQuery(cache.meta.dim)
    const session = createWorkerSession()
    try {
      const proven = await session.search({ cache, query, candidateK: 4 })
      assert.equal(proven.scanned, cache.meta.count)

      const bytes = fs.readFileSync(cache.vectorPath)
      bytes[0] ^= 0xff
      fs.writeFileSync(cache.vectorPath, bytes)
      // A re-minted handle (new source file state) forces a reload; the
      // re-verified proof must then fail closed instead of serving bytes that
      // changed after the handle's proofs were committed.
      cache.meta.sourceFiles = [
        {
          path: cache.vectorPath,
          size: bytes.length,
          mtimeMs: fs.statSync(cache.vectorPath).mtimeMs,
        },
      ]
      await assert.rejects(
        () => session.search({ cache, query, candidateK: 4 }),
        /integrity proof mismatch/,
      )
    } finally {
      await session.close()
    }
  })
})

test('worker honors a pre-armed cancellation flag immediately', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  await withTempDirectory('floating-clock-semantic-cancel-', async (directory) => {
    const cache = createCache(directory, { dim: 64, count: 2048 })
    const stopBuffer = new SharedArrayBuffer(4)
    Atomics.store(new Int32Array(stopBuffer), 0, 1)
    const session = createWorkerSession()
    try {
      await assert.rejects(
        () =>
          session.search({
            cache,
            query: createQuery(cache.meta.dim),
            candidateK: 8,
            stopBuffer,
          }),
        /cancelled/i,
      )
    } finally {
      await session.close()
    }
  })
})

test('host cancels a queued scan immediately without disturbing the active one', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  await withTempDirectory('floating-clock-semantic-host-queue-', async (directory) => {
    const cache = createCache(directory, { dim: 128, count: 20000 })
    const query = createQuery(cache.meta.dim)
    try {
      const active = semanticHost.searchSemanticVectorScan(cache, query, 8)
      const queued = semanticHost.searchSemanticVectorScan(cache, query, 8, {
        isCancelled: () => true,
      })
      await assert.rejects(queued, /Semantic search cancelled/)
      const result = await active
      assert.equal(result.scanned, cache.meta.count)
    } finally {
      semanticHost.disposeSemanticVectorSearchWorker()
    }
  })
})

async function withinDeadline(promise, timeoutMs = 2_000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('queued query was not dispatched')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('host advances past a cancelled queue head without requiring a new request', async () => {
  assert.ok(fs.existsSync(workerPath), 'the worker bundle is required for the protocol regression')
  await withTempDirectory('siftory-semantic-cancel-head-', async (directory) => {
    const cache = createCache(directory, { count: 256, dim: 2 })
    let cancelMiddle = false
    try {
      const first = semanticHost.searchSemanticVectorScan(cache, [1, 0], 5, {
        onProgress: () => {
          cancelMiddle = true
        },
      })
      const middle = semanticHost
        .searchSemanticVectorScan(cache, [1, 0], 5, {
          isCancelled: () => cancelMiddle,
        })
        .then(
          () => 'unexpected-success',
          (error) => error.message,
        )
      const last = semanticHost.searchSemanticVectorScan(cache, [1, 0], 5)
      const [firstResult, cancellation, lastResult] = await withinDeadline(
        Promise.all([first, middle, last]),
      )
      assert.equal(cancellation, 'Semantic search cancelled')
      assert.deepEqual(lastResult.candidates, firstResult.candidates)
    } finally {
      semanticHost.disposeSemanticVectorSearchWorker()
    }
  })
})

test('cancelled scoped queue entries cannot erase the payload needed by later scoped queries', async () => {
  assert.ok(fs.existsSync(workerPath))
  await withTempDirectory('siftory-semantic-cancel-scope-', async (directory) => {
    const cache = createCache(directory, { count: 256, dim: 2 })
    const oldScope = scopeKeysFor(cache, (filePath) => filePath.endsWith('image-0.png'))
    const newScope = scopeKeysFor(cache, (filePath) => filePath.endsWith('image-1.png'))
    let cancelMiddle = false
    try {
      const first = semanticHost.searchSemanticVectorScan(cache, [1, 0], 5, {
        acceptPathKeys: oldScope,
        onProgress: () => {
          cancelMiddle = true
        },
      })
      const middle = semanticHost
        .searchSemanticVectorScan(cache, [1, 0], 5, {
          acceptPathKeys: newScope,
          isCancelled: () => cancelMiddle,
        })
        .catch((error) => error.message)
      const last = semanticHost.searchSemanticVectorScan(cache, [1, 0], 5, {
        acceptPathKeys: newScope,
      })
      const [, cancellation, result] = await withinDeadline(Promise.all([first, middle, last]))
      assert.equal(cancellation, 'Semantic search cancelled')
      assert.deepEqual(
        result.candidates.map((candidate) => candidate.path),
        ['C:\\synthetic\\image-1.png'],
      )
      const reused = await semanticHost.searchSemanticVectorScan(cache, [1, 0], 5, {
        acceptPathKeys: newScope,
      })
      assert.deepEqual(reused.candidates, result.candidates)
    } finally {
      semanticHost.disposeSemanticVectorSearchWorker()
    }
  })
})

test('a failed cache load does not acknowledge a scope the worker never consumed', async () => {
  assert.ok(fs.existsSync(workerPath))
  await withTempDirectory('siftory-semantic-failed-scope-', async (directory) => {
    const cache = createCache(directory, { count: 32, dim: 2 })
    const keys = scopeKeysFor(cache, (filePath) => filePath.endsWith('image-2.png'))
    try {
      await assert.rejects(
        semanticHost.searchSemanticVectorScan(
          { ...cache, vectorPath: path.join(directory, 'missing.f16') },
          [1, 0],
          5,
          { acceptPathKeys: keys },
        ),
        /ENOENT/,
      )
      const result = await semanticHost.searchSemanticVectorScan(cache, [1, 0], 5, {
        acceptPathKeys: keys,
      })
      assert.deepEqual(
        result.candidates.map((candidate) => candidate.path),
        ['C:\\synthetic\\image-2.png'],
      )
    } finally {
      semanticHost.disposeSemanticVectorSearchWorker()
    }
  })
})

test('78K benchmark: warm P95, heap/GC contrast and bit parity at scale', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  await withTempDirectory('floating-clock-semantic-78k-', async (directory) => {
    const count = 78000
    const dim = 512
    const cache = createCache(directory, { dim, count, seed: 1337 })
    const query = createQuery(dim, 99)
    const topK = 50

    const observeGc = async (run) => {
      let events = 0
      const observer = new PerformanceObserver((list) => {
        events += list.getEntries().length
      })
      observer.observe({ entryTypes: ['gc'] })
      const heapBefore = process.memoryUsage().heapUsed
      const result = await run()
      const heapAfter = process.memoryUsage().heapUsed
      observer.disconnect()
      return { result, gcEvents: events, heapDelta: heapAfter - heapBefore }
    }

    // Reference exact scan in this (main) process: the per-query baseline.
    const baseline = await observeGc(() =>
      clipScan.scanSemanticClipCache(cache, { query, candidateK: topK }),
    )

    // Warm-up + cache load in the worker, then timed warm iterations.
    const warmup = await semanticHost.searchSemanticVectorScan(cache, query, topK)
    assert.equal(warmup.cacheReused, false)
    assertHostCandidatesMatch(warmup.candidates, baseline.result.baseCandidates)
    assert.equal(warmup.scanned, baseline.result.scanned)

    const iterations = 12
    const timings = []
    let workerProbe = null
    for (let index = 0; index < iterations; index++) {
      workerProbe = await observeGc(() => semanticHost.searchSemanticVectorScan(cache, query, topK))
      assert.equal(workerProbe.result.cacheReused, true)
      assertHostCandidatesMatch(workerProbe.result.candidates, baseline.result.baseCandidates)
      timings.push(workerProbe.result.searchMs)
    }
    semanticHost.disposeSemanticVectorSearchWorker()

    const sorted = [...timings].sort((a, b) => a - b)
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
    console.log(
      `[VAL-028 benchmark] 78K×512 warm scan ms: min=${sorted[0]} p95=${p95} ` +
        `max=${sorted[sorted.length - 1]}; main-process gc events exact=${baseline.gcEvents} ` +
        `worker=${workerProbe.gcEvents}; heap delta MiB exact=${(baseline.heapDelta / 1048576).toFixed(1)} ` +
        `worker=${(workerProbe.heapDelta / 1048576).toFixed(1)}`,
    )
    // Generous ceiling: guards against pathological regressions only.
    assert.ok(p95 < 5000, `warm P95 ${p95}ms exceeded the 5000ms ceiling`)
    assert.ok(
      baseline.gcEvents >= 2,
      `expected the in-process reference scan to trigger GC pressure, got ${baseline.gcEvents}`,
    )
    assert.ok(
      workerProbe.gcEvents < baseline.gcEvents,
      `worker path GC events (${workerProbe.gcEvents}) must stay below the in-process baseline (${baseline.gcEvents})`,
    )
  })
})

test('host cancels a 78K scan mid-flight via the shared stop flag', async (context) => {
  if (!fs.existsSync(workerPath)) {
    context.skip('run npm run build:renderer before the worker integration test')
    return
  }
  await withTempDirectory('floating-clock-semantic-78k-cancel-', async (directory) => {
    const cache = createCache(directory, { dim: 512, count: 78000, seed: 2024 })
    const query = createQuery(cache.meta.dim, 5)
    let cancelAtProgress = false
    try {
      await assert.rejects(
        semanticHost.searchSemanticVectorScan(cache, query, 50, {
          isCancelled: () => cancelAtProgress,
          onProgress: (progress) => {
            if (progress.scanned >= 4096) cancelAtProgress = true
          },
        }),
        /Semantic search cancelled/,
      )
    } finally {
      semanticHost.disposeSemanticVectorSearchWorker()
    }
  })
})
