#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { Worker } = require('node:worker_threads')
const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')

function option(argv, name, fallback = '') {
  return argv.find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function parseArgs(argv, projectRoot = path.resolve(__dirname, '..')) {
  for (const entry of argv) {
    if (!/^--(?:cycles|query-count)=/.test(entry)) {
      throw new Error(`Unknown search soak argument: ${entry}`)
    }
  }
  const cycles = Number(option(argv, 'cycles', '1000'))
  const queryCount = Number(option(argv, 'query-count', '8'))
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 10_000) {
    throw new Error('--cycles must be an integer between 1 and 10000')
  }
  if (!Number.isInteger(queryCount) || queryCount < 2 || queryCount > 16) {
    throw new Error('--query-count must be an integer between 2 and 16')
  }
  return { cycles, projectRoot, queryCount }
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] || 0
}

function snapshotFile(filePath) {
  const stat = fs.statSync(filePath)
  const descriptor = fs.openSync(filePath, 'r')
  const hash = crypto.createHash('sha256')
  try {
    const bytes = Math.min(64 * 1024, stat.size)
    for (const offset of [...new Set([0, Math.max(0, stat.size - bytes)])]) {
      const buffer = Buffer.allocUnsafe(bytes)
      const read = fs.readSync(descriptor, buffer, 0, bytes, offset)
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return { size: stat.size, mtimeMs: stat.mtimeMs, sampledSha256: hash.digest('hex') }
}

async function selectQueryPaths(pathsFile, rowCount, queryCount) {
  const targets = new Set(
    Array.from({ length: queryCount }, (_, index) =>
      Math.min(rowCount - 1, Math.floor(((index + 1) * rowCount) / (queryCount + 1))),
    ),
  )
  const selected = []
  let ordinal = 0
  const lines = readline.createInterface({
    input: fs.createReadStream(pathsFile, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    if (targets.has(ordinal)) {
      const entry = JSON.parse(line)
      if (typeof entry.path === 'string') selected.push(entry.path)
      if (selected.length === targets.size) break
    }
    ordinal += 1
  }
  lines.close()
  if (selected.length !== queryCount) throw new Error('Fixed search soak queries are incomplete')
  return selected
}

function resultDigest(searchResponse) {
  const results = Array.isArray(searchResponse) ? searchResponse : searchResponse?.results
  if (!Array.isArray(results)) throw new Error('ANN search response has no result list')
  return crypto
    .createHash('sha256')
    .update(results.map((entry) => cacheApi.embeddingCachePathKey(entry.path)).join('\n'))
    .digest('hex')
}

async function runSearchSoak(options) {
  const userData = path.join(process.env.APPDATA || '', 'floating-clock-electron')
  const sourceRoot = path.join(userData, 'vector-db', 'embedding-cache')
  const sourceMeta = path.join(sourceRoot, 'dinov2_vitb14__global.f16.json')
  const sourceVectors = path.join(sourceRoot, 'dinov2_vitb14__global.f16')
  const sourcePaths = path.join(sourceRoot, 'dinov2_vitb14__global.paths.jsonl')
  const workerPath = path.join(options.projectRoot, 'dist-electron', 'vectorAnnWorker.js')
  const sources = [sourceMeta, sourceVectors, sourcePaths]
  for (const candidate of [...sources, workerPath]) {
    const entry = fs.lstatSync(candidate)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Search soak input is unavailable')
  }
  const before = sources.map(snapshotFile)
  const meta = JSON.parse(fs.readFileSync(sourceMeta, 'utf8'))
  const queryPaths = await selectQueryPaths(sourcePaths, Number(meta.count), options.queryCount)
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-search-soak-'))
  const vectorPath = path.join(isolatedRoot, 'vectors.f16')
  const pathIndexPath = path.join(isolatedRoot, 'paths.jsonl')
  fs.linkSync(sourceVectors, vectorPath)
  fs.linkSync(sourcePaths, pathIndexPath)
  const cache = { meta, vectorPath, pathIndexPath }
  const vectors = await cacheApi.readEmbeddingF16VectorsForPaths(cache, queryPaths)
  const queries = queryPaths.map((queryPath) => vectors.get(cacheApi.embeddingCachePathKey(queryPath)))
  if (queries.some((query) => !query)) throw new Error('Search soak query vectors are unavailable')
  const worker = new Worker(workerPath)
  let requestId = 0
  const request = (type, queryVector) =>
    new Promise((resolve, reject) => {
      const id = ++requestId
      const onMessage = (message) => {
        if (message.requestId !== id) return
        if (message.type === 'result') {
          worker.off('message', onMessage)
          resolve(message.result)
        } else if (message.type === 'error' || message.type === 'cancelled') {
          worker.off('message', onMessage)
          reject(new Error(message.error || message.type || 'ANN worker failed'))
        }
      }
      worker.on('message', onMessage)
      worker.postMessage({
        type,
        requestId: id,
        cache,
        ...(queryVector ? { queryVector: Array.from(queryVector), topK: 50 } : {}),
        stopBuffer: new SharedArrayBuffer(4),
      })
    })
  const startedAt = new Date().toISOString()
  let completedCycles = 0
  let stableResultDigests = true
  const timings = []
  try {
    const prewarmStarted = performance.now()
    await request('prewarm')
    const prewarmMs = performance.now() - prewarmStarted
    const expected = []
    for (const query of queries) expected.push(resultDigest(await request('search', query)))
    for (let cycle = 0; cycle < options.cycles; cycle += 1) {
      const queryIndex = cycle % queries.length
      const started = performance.now()
      const results = await request('search', queries[queryIndex])
      timings.push(performance.now() - started)
      if (resultDigest(results) !== expected[queryIndex]) {
        stableResultDigests = false
        break
      }
      completedCycles += 1
    }
    const after = sources.map(snapshotFile)
    const sourceFilesUnchanged = JSON.stringify(before) === JSON.stringify(after)
    const report = {
      schema: 'siftory-runtime-memory-search-soak/v1',
      status:
        completedCycles === options.cycles && stableResultDigests && sourceFilesUnchanged
          ? 'passed'
          : 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      requestedCycles: options.cycles,
      completedCycles,
      queryCount: queries.length,
      prewarmMs,
      searchP50Ms: percentile(timings, 0.5),
      searchP95Ms: percentile(timings, 0.95),
      stableResultDigests,
      resultDigest: crypto.createHash('sha256').update(expected.join('\n')).digest('hex'),
      safety: { sourceFilesUnchanged },
    }
    return report
  } finally {
    await worker.terminate().catch(() => undefined)
    fs.rmSync(isolatedRoot, { recursive: true, force: true })
  }
}

if (require.main === module) {
  runSearchSoak(parseArgs(process.argv.slice(2)))
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`)
      if (report.status !== 'passed') process.exitCode = 1
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}

module.exports = { parseArgs, resultDigest, selectQueryPaths }
