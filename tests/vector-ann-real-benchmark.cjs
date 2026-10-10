const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('./guard-utils.cjs')

const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')
const annApi = loadTsModule('electron/vectorAnnIndex.ts')
const userData = path.join(process.env.APPDATA || '', 'floating-clock-electron')
const sourceCacheDir = path.join(userData, 'vector-db', 'embedding-cache')
const metaPath = path.join(sourceCacheDir, 'dinov2_vitb14__global.f16.json')
const sourceVectorPath = path.join(sourceCacheDir, 'dinov2_vitb14__global.f16')
const sourcePathIndexPath = path.join(sourceCacheDir, 'dinov2_vitb14__global.paths.jsonl')
const workerPath = path.resolve(__dirname, '..', 'dist-electron', 'vectorAnnWorker.js')

if (
  !fs.existsSync(metaPath) ||
  !fs.existsSync(sourceVectorPath) ||
  !fs.existsSync(sourcePathIndexPath) ||
  !fs.existsSync(workerPath)
) {
  console.error('Build the renderer and DINO Float16 cache before running this benchmark.')
  process.exit(1)
}

const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-ann-real-'))
const vectorPath = path.join(isolatedRoot, 'dinov2_vitb14__global.f16')
const pathIndexPath = path.join(isolatedRoot, 'dinov2_vitb14__global.paths.jsonl')
fs.linkSync(sourceVectorPath, vectorPath)
fs.linkSync(sourcePathIndexPath, pathIndexPath)
const cache = { meta, vectorPath, pathIndexPath }
const rows = fs
  .readFileSync(sourcePathIndexPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const preferred = 'D:\\PxHereDataset\\images\\pxhere-001100\\46495.jpg'
const requestedSamples = Number.parseInt(process.argv[2] || '12', 10)
const sampleCount = Math.min(
  50,
  Math.max(2, Number.isFinite(requestedSamples) ? requestedSamples : 12),
)
const samplePaths = [
  preferred,
  ...Array.from(
    { length: sampleCount - 1 },
    (_, index) => rows[Math.floor((rows.length * (index + 1)) / sampleCount)].path,
  ),
]
const worker = new Worker(workerPath)
let requestId = 0

function workerRequest(type, queryVector, topK) {
  return new Promise((resolve, reject) => {
    const id = ++requestId
    const stopBuffer = new SharedArrayBuffer(4)
    const onMessage = (message) => {
      if (message.requestId !== id) return
      if (message.type === 'result') {
        worker.off('message', onMessage)
        resolve(message.result)
      } else if (message.type === 'error' || message.type === 'cancelled') {
        worker.off('message', onMessage)
        reject(new Error(message.error || message.type))
      }
    }
    worker.on('message', onMessage)
    worker.postMessage({
      type,
      requestId: id,
      cache,
      ...(queryVector ? { queryVector: Array.from(queryVector) } : {}),
      ...(topK ? { topK } : {}),
      stopBuffer,
    })
  })
}

function annSearch(queryVector, topK) {
  return workerRequest('search', queryVector, topK)
}

function annPrewarm() {
  return workerRequest('prewarm')
}

function recall(expected, actual) {
  const actualPaths = new Set(actual.map((item) => item.path.toLowerCase()))
  return (
    expected.filter((item) => actualPaths.has(item.path.toLowerCase())).length / expected.length
  )
}

function percentile(values, percentileValue) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)]
}

function snapshotFile(filePath) {
  const stat = fs.statSync(filePath)
  const descriptor = fs.openSync(filePath, 'r')
  const hash = crypto.createHash('sha256')
  try {
    const windowBytes = Math.min(64 * 1024, stat.size)
    const offsets = [
      ...new Set([
        0,
        Math.max(0, Math.floor((stat.size - windowBytes) / 2)),
        Math.max(0, stat.size - windowBytes),
      ]),
    ]
    for (const offset of offsets) {
      const buffer = Buffer.allocUnsafe(windowBytes)
      const read = fs.readSync(descriptor, buffer, 0, windowBytes, offset)
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return { size: stat.size, mtimeMs: stat.mtimeMs, sampledSha256: hash.digest('hex') }
}

function sourceSnapshot() {
  return {
    meta: snapshotFile(metaPath),
    vectors: snapshotFile(sourceVectorPath),
    paths: snapshotFile(sourcePathIndexPath),
  }
}

function queryId(filePath) {
  return crypto
    .createHash('sha256')
    .update(cacheApi.embeddingCachePathKey(filePath))
    .digest('hex')
    .slice(0, 16)
}

async function main() {
  const beforeSource = sourceSnapshot()
  const vectors = await cacheApi.readEmbeddingF16VectorsForPaths(cache, samplePaths)
  const report = []
  const exactByPath = new Map()

  // Keep the exact baseline and ANN timing in separate phases. Alternating them
  // causes both readers to compete for the same large vector file and measures
  // benchmark-induced I/O contention that the application path does not create.
  for (let index = 0; index < samplePaths.length; index++) {
    const queryPath = samplePaths[index]
    const query = vectors.get(cacheApi.embeddingCachePathKey(queryPath))
    if (!query) continue
    const startedAt = performance.now()
    const exact = await cacheApi.searchEmbeddingF16Cache(cache, {
      queryVector: query,
      topK: 50,
    })
    exactByPath.set(queryPath, {
      results: exact,
      elapsedMs: performance.now() - startedAt,
    })
    console.error(`[ann-real] exact ${index + 1}/${samplePaths.length}`)
  }

  const rssBeforePrewarm = process.memoryUsage().rss
  const prewarmStartedAt = performance.now()
  const prewarm = await annPrewarm()
  const prewarmWallMs = performance.now() - prewarmStartedAt
  const rssAfterPrewarm = process.memoryUsage().rss

  for (let index = 0; index < samplePaths.length; index++) {
    const queryPath = samplePaths[index]
    const query = vectors.get(cacheApi.embeddingCachePathKey(queryPath))
    const exactEntry = exactByPath.get(queryPath)
    if (!query || !exactEntry) continue
    const startedAt = performance.now()
    const ann = await annSearch(query, 200)
    const wallMs = performance.now() - startedAt
    report.push({
      queryId: queryId(queryPath),
      exactMs: Math.round(exactEntry.elapsedMs),
      annWallMs: Math.round(wallMs),
      annWorkerMs: ann.searchMs,
      annLoadMs: ann.loadMs,
      annBuilt: ann.built,
      snapshotLoadMode: ann.snapshotLoadMode,
      vectorBytesRead: ann.vectorBytesRead,
      pathBytesRead: ann.pathBytesRead,
      reusedVectorBytes: ann.reusedVectorBytes,
      candidates: ann.candidateCount,
      candidateRatio: Number((ann.candidateCount / Math.max(1, ann.indexedCount)).toFixed(6)),
      recall50In200: Number(recall(exactEntry.results, ann.results).toFixed(4)),
      firstMatch:
        cacheApi.embeddingCachePathKey(exactEntry.results[0]?.path || '') ===
        cacheApi.embeddingCachePathKey(ann.results[0]?.path || ''),
    })
    console.error(`[ann-real] candidate ${index + 1}/${samplePaths.length}`)
  }
  const averageRecall =
    report.reduce((sum, item) => sum + item.recall50In200, 0) / Math.max(1, report.length)
  const minimumRecall = Math.min(...report.map((item) => item.recall50In200))
  const exactTotalMs = report.reduce((sum, item) => sum + item.exactMs, 0)
  const annTotalMs = report.reduce((sum, item) => sum + item.annWallMs, 0)
  const exactP95Ms = percentile(
    report.map((item) => item.exactMs),
    95,
  )
  const annP95Ms = percentile(
    report.map((item) => item.annWallMs),
    95,
  )
  const exactP50Ms = percentile(
    report.map((item) => item.exactMs),
    50,
  )
  const annP50Ms = percentile(
    report.map((item) => item.annWallMs),
    50,
  )
  const p95ImprovementPercent = ((exactP95Ms - annP95Ms) / Math.max(1, exactP95Ms)) * 100
  const afterSource = sourceSnapshot()
  const sourceFilesUnchanged = JSON.stringify(beforeSource) === JSON.stringify(afterSource)
  const maximumCandidateRatio = Math.max(...report.map((item) => item.candidateRatio))
  const minimumCandidateRatio = Math.min(...report.map((item) => item.candidateRatio))
  const firstMatchRate =
    report.filter((item) => item.firstMatch).length / Math.max(1, report.length)
  const failures = []
  if (averageRecall < 0.995) failures.push(`average Recall@50 ${averageRecall.toFixed(4)} < 0.995`)
  if (minimumRecall < 0.96) failures.push(`minimum Recall@50 ${minimumRecall.toFixed(4)} < 0.96`)
  if (firstMatchRate < 1) failures.push(`first-match rate ${firstMatchRate.toFixed(4)} < 1`)
  if (minimumCandidateRatio < 0.05 || maximumCandidateRatio > 0.2) {
    failures.push(
      `candidate ratio ${(minimumCandidateRatio * 100).toFixed(2)}%-${(maximumCandidateRatio * 100).toFixed(2)}% is outside 5%-20%`,
    )
  }
  if (p95ImprovementPercent < 25) {
    failures.push(`P95 improvement ${p95ImprovementPercent.toFixed(2)}% < 25%`)
  }
  if (!sourceFilesUnchanged) failures.push('source snapshot changed')
  const output = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    cacheCount: meta.count,
    dimensions: meta.dim,
    samples: report.length,
    projectionDimensions: annApi.VECTOR_ANN_PROJECTION_DIMENSIONS,
    averageRecall50In200: Number(averageRecall.toFixed(4)),
    minimumRecall50In200: Number(minimumRecall.toFixed(4)),
    firstMatchRate: Number(firstMatchRate.toFixed(4)),
    candidateRatio: {
      minimum: minimumCandidateRatio,
      maximum: maximumCandidateRatio,
    },
    exactP95Ms,
    annP95Ms,
    exactP50Ms,
    annP50Ms,
    p50ImprovementPercent: Number(
      (((exactP50Ms - annP50Ms) / Math.max(1, exactP50Ms)) * 100).toFixed(2),
    ),
    p95ImprovementPercent: Number(p95ImprovementPercent.toFixed(2)),
    aggregateSpeedup: Number((exactTotalMs / Math.max(1, annTotalMs)).toFixed(2)),
    prewarm: {
      wallMs: Number(prewarmWallMs.toFixed(2)),
      built: prewarm.built,
      buildMode: prewarm.buildMode,
      snapshotLoadMode: prewarm.snapshotLoadMode,
      processRssAfterMiB: Number((rssAfterPrewarm / 1024 / 1024).toFixed(2)),
      processRssDeltaMiB: Number(((rssAfterPrewarm - rssBeforePrewarm) / 1024 / 1024).toFixed(2)),
    },
    safety: {
      sourceFilesUnchanged,
      isolatedDerivedIndex: true,
    },
    gate: { passed: failures.length === 0, failures },
    report,
  }
  const artifactRoot = path.resolve(__dirname, '..', 'artifacts', 'benchmark', 'vector-ann-prep007')
  const directoryName = output.generatedAt.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const reportDirectory = path.join(artifactRoot, directoryName)
  fs.mkdirSync(reportDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(reportDirectory, 'report.json'),
    `${JSON.stringify(output, null, 2)}\n`,
  )
  fs.writeFileSync(
    path.join(reportDirectory, 'report.md'),
    `# PREP-007 Q8 projection ANN gate\n\n` +
      `- Snapshot: ${output.cacheCount.toLocaleString()} rows × ${output.dimensions} dimensions\n` +
      `- Samples: ${output.samples}\n` +
      `- Recall@50 average/minimum: ${output.averageRecall50In200}/${output.minimumRecall50In200}\n` +
      `- First-match rate: ${output.firstMatchRate}\n` +
      `- Candidate ratio: ${(output.candidateRatio.minimum * 100).toFixed(2)}%-${(output.candidateRatio.maximum * 100).toFixed(2)}%\n` +
      `- Exact/ANN P50: ${output.exactP50Ms}/${output.annP50Ms} ms\n` +
      `- Exact/ANN P95: ${output.exactP95Ms}/${output.annP95Ms} ms\n` +
      `- P95 improvement: ${output.p95ImprovementPercent}%\n` +
      `- Aggregate speedup: ${output.aggregateSpeedup}×\n` +
      `- Source unchanged: ${output.safety.sourceFilesUnchanged}\n` +
      `- Gate: **${output.gate.passed ? 'PASS' : 'FAIL'}**\n`,
  )
  fs.mkdirSync(artifactRoot, { recursive: true })
  fs.writeFileSync(
    path.join(artifactRoot, 'latest.json'),
    `${JSON.stringify(
      {
        generatedAt: output.generatedAt,
        reportDirectory: directoryName,
        reportFile: `artifacts/benchmark/vector-ann-prep007/${directoryName}/report.json`,
        gate: output.gate,
      },
      null,
      2,
    )}\n`,
  )
  console.log(JSON.stringify(output, null, 2))
  if (!output.gate.passed) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => worker.terminate())
  .finally(() => {
    const resolvedRoot = path.resolve(isolatedRoot)
    if (
      path.dirname(resolvedRoot) === path.resolve(os.tmpdir()) &&
      path.basename(resolvedRoot).startsWith('floating-clock-ann-real-')
    ) {
      fs.rmSync(resolvedRoot, { recursive: true, force: true })
    }
  })
