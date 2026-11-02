// Real-data acceptance runs on a private copy. No model inference, source
// migration, index repair or writes to the active application library.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { Worker } = require('node:worker_threads')
const { loadTsModule } = require('../tests/guard-utils.cjs')
const {
  defaultMaintenanceRoot,
  validateMaintenanceRoot,
  bindMaintenanceStorageRoot,
} = require('./maintenance-storage-context.cjs')
const api = loadTsModule('electron/embeddingF16Cache.ts')
const { MODEL_DIMENSIONS, readBenchmarkSnapshot } = require('./vector-benchmark-snapshot.cjs')
const workerPath = path.resolve(__dirname, '../dist-electron/vectorAnnWorker.js')

function option(name) {
  return process.argv
    .slice(2)
    .find((item) => item.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
}

function digest(file) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytes
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes))
    return hash.digest('hex')
  } finally {
    fs.closeSync(descriptor)
  }
}

function sourceFiles(cache) {
  return [
    cache.vectorPath,
    cache.pathIndexPath,
    ...(cache.delta ? [cache.delta.vectorPath, cache.delta.pathIndexPath] : []),
  ]
}

function copyCache(cache, directory) {
  const copy = (file, name) => {
    const target = path.join(directory, name)
    fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL)
    return target
  }
  return {
    ...cache,
    vectorPath: copy(cache.vectorPath, 'snapshot.f16'),
    pathIndexPath: copy(cache.pathIndexPath, 'snapshot.paths.jsonl'),
    ...(cache.delta
      ? {
          delta: {
            ...cache.delta,
            vectorPath: copy(cache.delta.vectorPath, 'delta.f16'),
            pathIndexPath: copy(cache.delta.pathIndexPath, 'delta.paths.jsonl'),
          },
        }
      : {}),
  }
}

function fixture(directory, composite) {
  const dim = 128,
    count = 2048
  const vectors = Buffer.alloc(dim * count * 2)
  const paths = []
  let seed = 12345
  for (let row = 0; row < count; row++) {
    const vector = new Float32Array(dim)
    let norm = 0
    for (let column = 0; column < dim; column++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      vector[column] = seed / 0x100000000 - 0.5
      norm += vector[column] ** 2
    }
    norm = Math.sqrt(norm)
    vector.forEach((value, column) =>
      vectors.writeUInt16LE(api.float32ToFloat16(value / norm), (row * dim + column) * 2),
    )
    paths.push(JSON.stringify({ row, path: `synthetic/image-${row}.png` }))
  }
  const vectorPath = path.join(directory, 'fixture.f16')
  const pathIndexPath = path.join(directory, 'fixture.paths.jsonl')
  const baseCount = composite ? 1234 : count
  fs.writeFileSync(vectorPath, vectors.subarray(0, baseCount * dim * 2))
  fs.writeFileSync(pathIndexPath, paths.slice(0, baseCount).join('\n') + '\n')
  let delta
  if (composite) {
    delta = {
      vectorPath: path.join(directory, 'fixture-delta.f16'),
      pathIndexPath: path.join(directory, 'fixture-delta.paths.jsonl'),
      baseCount,
    }
    fs.writeFileSync(delta.vectorPath, vectors.subarray(baseCount * dim * 2))
    fs.writeFileSync(delta.pathIndexPath, paths.slice(baseCount).join('\n') + '\n')
  }
  return {
    meta: {
      version: 1,
      modelName: 'synthetic',
      embeddingType: 'global',
      count,
      dim,
      sourceRecordCount: count,
      sourceFiles: [],
      updatedAt: 1,
    },
    vectorPath,
    pathIndexPath,
    ...(delta ? { delta } : {}),
  }
}

function session(scalar) {
  const worker = new Worker(workerPath, {
    env: { ...process.env, SIFTORY_F16_RERANK_SCALAR: scalar ? '1' : '0' },
  })
  let nextId = 0
  return {
    worker,
    request(type, cache, queryVector) {
      return new Promise((resolve, reject) => {
        const requestId = ++nextId
        const stopBuffer = new SharedArrayBuffer(4)
        const finish = (error, result) => {
          clearTimeout(timeout)
          worker.off('message', onMessage)
          worker.off('error', onError)
          worker.off('exit', onExit)
          if (error) reject(error)
          else resolve(result)
        }
        const onError = (error) => finish(error)
        const onExit = (code) => finish(new Error(`ANN benchmark worker exited: ${code}`))
        const onMessage = (message) => {
          if (message.requestId !== requestId || message.type === 'progress') return
          if (message.type === 'result') finish(null, message.result)
          else finish(new Error(message.error || message.type))
        }
        const timeout = setTimeout(
          () => {
            Atomics.store(new Int32Array(stopBuffer), 0, 1)
            finish(new Error('ANN benchmark request exceeded ten minutes'))
          },
          10 * 60 * 1000,
        )
        worker.on('message', onMessage)
        worker.once('error', onError)
        worker.once('exit', onExit)
        worker.postMessage({
          type,
          requestId,
          cache,
          stopBuffer,
          ...(queryVector ? { queryVector: Array.from(queryVector), topK: 200 } : {}),
        })
      })
    },
  }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

async function main() {
  if (!fs.existsSync(workerPath)) throw new Error('Run npm run build:renderer first')
  const samples = Number(option('samples') || 20)
  if (!Number.isSafeInteger(samples) || samples < 3 || samples > 100)
    throw new Error('--samples must be between 3 and 100')
  const compositeFixture = process.argv.includes('--fixture-composite')
  const synthetic = compositeFixture || process.argv.includes('--fixture')
  const modelName = option('model') || 'dinov2_vitb14'
  if (!MODEL_DIMENSIONS[modelName])
    throw new Error('--model must be dinov2_vitb14 or clip_vit_base_patch32')
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'siftory-local-vector-benchmark-'),
  )
  const sessions = []
  let restoreStorageRoot
  try {
    const root = synthetic
      ? null
      : option('user-data')
        ? validateMaintenanceRoot(option('user-data'))
        : defaultMaintenanceRoot()
    if (root) restoreStorageRoot = bindMaintenanceStorageRoot(root)
    const source = synthetic
      ? fixture(directory, compositeFixture)
      : readBenchmarkSnapshot(root, modelName)
    if (!source || source.meta.count < 50)
      throw new Error(
        `No complete ${modelName} vector snapshot with at least 50 rows; benchmark does not rebuild user data`,
      )
    console.error(
      '[vector-local] Checking and copying the committed snapshot; original files stay read-only',
    )
    const originals = sourceFiles(source)
    const before = originals.map(digest)
    const cache = copyCache(source, directory)
    assert.deepEqual(sourceFiles(cache).map(digest), before, 'source changed during snapshot copy')
    const rows = api.readEmbeddingF16CacheLatestPathRowsSync(cache)
    if (rows.length < samples)
      throw new Error('Not enough distinct paths for the requested sample count')
    const selected = Array.from(
      { length: samples },
      (_, index) => rows[Math.floor((index * rows.length) / samples)].path,
    )
    const queries = await api.readEmbeddingF16VectorsForPaths(cache, selected)
    if (queries.size !== samples) throw new Error('Could not read every sampled query vector')
    const scalar = session(true),
      lookup = session(false)
    sessions.push(scalar, lookup)
    await scalar.request('prewarm', cache)
    await lookup.request('prewarm', cache)
    for (const mode of sessions) await mode.request('search', cache, queries.values().next().value)
    const measurements = []
    for (let index = 0; index < selected.length; index++) {
      const query = queries.get(api.embeddingCachePathKey(selected[index]))
      const exactStart = performance.now()
      const exact = await api.searchEmbeddingF16Cache(cache, { queryVector: query, topK: 50 })
      if (exact.length === 0) throw new Error('Exact baseline returned no results')
      const exactMs = performance.now() - exactStart
      const results = new Map()
      for (const mode of index % 2 === 0 ? sessions : [...sessions].reverse()) {
        const started = performance.now()
        const result = await mode.request('search', cache, query)
        results.set(mode, { result, wallMs: performance.now() - started })
      }
      const baseline = results.get(scalar),
        optimized = results.get(lookup)
      assert.deepEqual(
        optimized.result.results,
        baseline.result.results,
        'optimized scores or ranks changed',
      )
      const actualPaths = new Set(
        optimized.result.results.map((item) => api.embeddingCachePathKey(item.path)),
      )
      measurements.push({
        sample: index + 1,
        exactMs,
        scalarWallMs: baseline.wallMs,
        lookupWallMs: optimized.wallMs,
        scalarTimings: baseline.result.timings,
        lookupTimings: optimized.result.timings,
        candidateRatio:
          optimized.result.candidateCount / Math.max(1, optimized.result.indexedCount),
        recall50In200:
          exact.filter((item) => actualPaths.has(api.embeddingCachePathKey(item.path))).length /
          exact.length,
        firstMatch:
          api.embeddingCachePathKey(exact[0].path) ===
          api.embeddingCachePathKey(optimized.result.results[0]?.path || ''),
      })
      console.error(`[vector-local] ${index + 1}/${samples}`)
    }
    const sourceUnchanged = JSON.stringify(before) === JSON.stringify(originals.map(digest))
    const averageRecall = measurements.reduce((sum, item) => sum + item.recall50In200, 0) / samples
    const minimumRecall = Math.min(...measurements.map((item) => item.recall50In200))
    const failures = []
    if (!sourceUnchanged) failures.push('source snapshot changed; close Siftory before measuring')
    if (averageRecall < 0.995 || minimumRecall < 0.96)
      failures.push('ANN recall below average 99.5% / minimum 96% acceptance')
    if (measurements.some((item) => !item.firstMatch))
      failures.push('ANN first result differs from exact baseline')
    const report = {
      schemaVersion: 1,
      implementationSha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.resolve(__dirname, '../electron/f16DotProduct.ts')))
        .update(fs.readFileSync(path.resolve(__dirname, '../electron/vectorAnnWorker.ts')))
        .digest('hex'),
      synthetic,
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model,
      },
      workload: {
        modelName: cache.meta.modelName,
        rows: cache.meta.count,
        dim: cache.meta.dim,
        samples,
        composite: Boolean(cache.delta),
      },
      scalarP50Ms: percentile(
        measurements.map((item) => item.scalarWallMs),
        0.5,
      ),
      lookupP50Ms: percentile(
        measurements.map((item) => item.lookupWallMs),
        0.5,
      ),
      scalarP95Ms: percentile(
        measurements.map((item) => item.scalarWallMs),
        0.95,
      ),
      lookupP95Ms: percentile(
        measurements.map((item) => item.lookupWallMs),
        0.95,
      ),
      averageRecall,
      minimumRecall,
      measurements,
      safety: {
        sourceFilesUnchanged: sourceUnchanged,
        isolatedDerivedIndex: true,
        originalPathsOmittedFromReport: true,
      },
      gate: { passed: failures.length === 0, exactScalarLookupParity: true, failures },
      scope:
        'Warm ANN CPU search over a copied committed vector snapshot. Excludes query-image inference, GPU, original-media IO, real NAS scans and UI. Recall is agreement with exact vector search, not a human relevance score. No speed threshold on shared hardware.',
    }
    const output = path.resolve(__dirname, '../artifacts/benchmark/vector-local/latest.json')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log(
      JSON.stringify(
        {
          ok: report.gate.passed,
          output,
          averageRecall,
          minimumRecall,
          scalarP50Ms: report.scalarP50Ms,
          lookupP50Ms: report.lookupP50Ms,
          gate: report.gate,
        },
        null,
        2,
      ),
    )
    if (!report.gate.passed) process.exitCode = 1
    return report
  } finally {
    await Promise.allSettled(sessions.map((mode) => mode.worker.terminate()))
    restoreStorageRoot?.()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
module.exports = { main }
