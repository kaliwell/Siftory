const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { performance } = require('node:perf_hooks')
const { Worker } = require('node:worker_threads')
const { loadTsModule } = require('./guard-utils.cjs')

const f16 = loadTsModule('electron/embeddingF16Cache.ts')
const feedback = loadTsModule('electron/assetFeedbackModel.ts')
const categoryWorker = loadTsModule('electron/assetCategoryFeedbackWorker.ts')

const repoRoot = path.resolve(__dirname, '..')
const userData = path.join(process.env.APPDATA || '', 'floating-clock-electron')
const sourceCacheDir = path.join(userData, 'vector-db', 'embedding-cache')
const sourceMetaPath = path.join(sourceCacheDir, 'clip_vit_base_patch32__global.f16.json')
const sourceVectorPath = path.join(sourceCacheDir, 'clip_vit_base_patch32__global.f16')
const sourcePathIndexPath = path.join(
  sourceCacheDir,
  'clip_vit_base_patch32__global.paths.jsonl',
)
const assetsPath = path.join(userData, 'asset-library', 'assets.jsonl')
const datasetPath = path.join(repoRoot, 'artifacts', 'neko-search-annotation', 'dataset.json')
const judgmentsPath = path.join(repoRoot, 'artifacts', 'neko-search-annotation', 'judgments.json')
const annWorkerPath = path.join(repoRoot, 'dist-electron', 'vectorAnnWorker.js')
const required = [
  sourceMetaPath,
  sourceVectorPath,
  sourcePathIndexPath,
  assetsPath,
  datasetPath,
  judgmentsPath,
  annWorkerPath,
]
for (const filePath of required) {
  if (!fs.existsSync(filePath)) {
    console.error(`Missing PREP-008 benchmark input: ${path.basename(filePath)}`)
    process.exit(1)
  }
}

const requestedRuns = Number.parseInt(process.argv[2] || '3', 10)
const runs = Math.max(3, Math.min(5, Number.isFinite(requestedRuns) ? requestedRuns : 3))
const topK = 100
const clipCandidateK = 1000
const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-neko-ann-'))
const vectorPath = path.join(isolatedRoot, 'clip_vit_base_patch32__global.f16')
const pathIndexPath = path.join(isolatedRoot, 'clip_vit_base_patch32__global.paths.jsonl')
fs.linkSync(sourceVectorPath, vectorPath)
fs.linkSync(sourcePathIndexPath, pathIndexPath)
const meta = JSON.parse(fs.readFileSync(sourceMetaPath, 'utf8'))
const cache = { meta, vectorPath, pathIndexPath }
const preparedCache = {
  dim: meta.dim,
  count: meta.count,
  vectorPath,
  pathListPath: pathIndexPath,
  dtype: 'f16-le',
}
const annWorker = new Worker(annWorkerPath)
let nextRequestId = 1

function snapshotFile(filePath) {
  const stat = fs.statSync(filePath)
  const descriptor = fs.openSync(filePath, 'r')
  const hash = crypto.createHash('sha256')
  try {
    const windowBytes = Math.min(64 * 1024, stat.size)
    const offsets = [
      0,
      Math.max(0, Math.floor((stat.size - windowBytes) / 2)),
      Math.max(0, stat.size - windowBytes),
    ]
    for (const offset of [...new Set(offsets)]) {
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
    meta: snapshotFile(sourceMetaPath),
    vectors: snapshotFile(sourceVectorPath),
    paths: snapshotFile(sourcePathIndexPath),
    assets: snapshotFile(assetsPath),
    dataset: snapshotFile(datasetPath),
    judgments: snapshotFile(judgmentsPath),
  }
}

function annRequest(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId++
    const stopBuffer = new SharedArrayBuffer(4)
    const onMessage = (message) => {
      if (message.requestId !== requestId) return
      if (message.type === 'result') {
        annWorker.off('message', onMessage)
        resolve(message.result)
      } else if (message.type === 'error' || message.type === 'cancelled') {
        annWorker.off('message', onMessage)
        reject(new Error(message.error || message.type))
      }
    }
    annWorker.on('message', onMessage)
    annWorker.postMessage({
      type,
      requestId,
      cache,
      ...payload,
      stopBuffer,
    })
  })
}

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)]
}

function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function resultPaths(result, limit) {
  return result.hits.slice(0, limit).map((hit) => f16.embeddingCachePathKey(hit.path))
}

function overlapAtK(expected, actual, limit) {
  const wanted = new Set(resultPaths(expected, limit))
  const received = new Set(resultPaths(actual, limit))
  let overlap = 0
  for (const key of wanted) if (received.has(key)) overlap += 1
  return overlap / Math.max(1, wanted.size)
}

function rankedMetrics(result, labels) {
  const ranked = result.hits
    .map((hit) => ({ key: f16.embeddingCachePathKey(hit.path), score: hit.score }))
    .filter((item) => labels.has(item.key))
  const relevantTotal = [...labels.values()].filter((label) => label === 'relevant').length
  const precision = (limit) => {
    const top = ranked.slice(0, limit)
    return top.filter((item) => labels.get(item.key) === 'relevant').length / Math.max(1, limit)
  }
  const relevantAt50 = ranked
    .slice(0, 50)
    .filter((item) => labels.get(item.key) === 'relevant').length
  const idealRelevant = Math.min(20, relevantTotal)
  let dcg = 0
  for (let index = 0; index < Math.min(20, ranked.length); index++) {
    if (labels.get(ranked[index].key) === 'relevant') dcg += 1 / Math.log2(index + 2)
  }
  let idealDcg = 0
  for (let index = 0; index < idealRelevant; index++) idealDcg += 1 / Math.log2(index + 2)
  return {
    precisionAt20: round(precision(20)),
    precisionAt50: round(precision(50)),
    recallAt50: round(relevantAt50 / Math.max(1, relevantTotal)),
    ndcgAt20: round(idealDcg > 0 ? dcg / idealDcg : 0),
    rejectIntrusionAt20: round(
      ranked.slice(0, 20).filter((item) => labels.get(item.key) === 'not_relevant').length /
        20,
    ),
    judgedReturned: ranked.length,
  }
}

async function loadActiveAssets() {
  const byId = new Map()
  const lines = readline.createInterface({
    input: fs.createReadStream(assetsPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    if (!line) continue
    try {
      const row = JSON.parse(line)
      if (Number.isSafeInteger(row.id)) byId.set(row.id, row)
    } catch {
      // The production store also ignores malformed historical rows.
    }
  }
  return [...byId.values()]
    .filter(
      (asset) =>
        typeof asset.path === 'string' &&
        asset.missing !== true &&
        asset.archived !== true &&
        asset.deletedAt == null,
    )
    .map((asset) => ({
      id: asset.id,
      pathKey: f16.embeddingCachePathKey(asset.path),
    }))
}

async function buildFixture() {
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'))
  const judgmentBook = JSON.parse(fs.readFileSync(judgmentsPath, 'utf8')).judgments || {}
  const category = dataset.categories.find(
    (candidate) =>
      Array.isArray(candidate.candidates) &&
      candidate.candidates.some((item) => judgmentBook[String(candidate.id)]?.[item.id]),
  )
  if (!category) throw new Error('No fully judged NekoSearch category is available')
  const judgments = judgmentBook[String(category.id)] || {}
  const judged = category.candidates.flatMap((candidate) => {
    const label = judgments[candidate.id]?.label
    return label === 'relevant' || label === 'not_relevant'
      ? [{ path: candidate.path, label }]
      : []
  })
  const vectors = await f16.readEmbeddingF16VectorsForPaths(
    cache,
    judged.map((item) => item.path),
  )
  const positives = []
  const negatives = []
  const labels = new Map()
  for (const item of judged) {
    const key = f16.embeddingCachePathKey(item.path)
    const vector = vectors.get(key)
    if (!vector) continue
    labels.set(key, item.label)
    ;(item.label === 'relevant' ? positives : negatives).push({
      path: item.path,
      vector,
      weight: 1,
    })
  }
  const target = feedback.buildFeedbackTargetModel({
    key: `category:${category.id}`,
    kind: 'category',
    id: Number(category.id),
    name: category.name,
    positiveSampleCount: positives.length,
    negativeSampleCount: negatives.length,
    positiveVectors: positives,
    negativeVectors: negatives,
  })
  if (!target) throw new Error('The judged category has no usable CLIP target')
  return {
    categoryId: crypto.createHash('sha256').update(String(category.id)).digest('hex').slice(0, 12),
    target,
    labels,
    positives: positives.length,
    negatives: negatives.length,
  }
}

function workerInput(fixture, eligibleAssets, clipAnnCandidates) {
  return {
    kind: 'category_search',
    cache: preparedCache,
    target: fixture.target,
    eligibleAssets,
    clipCandidateK,
    topK,
    ...(clipAnnCandidates ? { clipAnnCandidates } : {}),
    dino: {
      cacheDir: path.join(isolatedRoot, 'dino-cache'),
      modelName: 'dinov2_vitb14',
      embeddingType: 'global',
      dim: 768,
      sourcePaths: [],
    },
  }
}

async function runCategory(input) {
  const startedAt = performance.now()
  const outcome = await categoryWorker.runAssetCategorySearch(
    input,
    new Int32Array(new SharedArrayBuffer(4)),
    () => {},
  )
  if (outcome.stopped || !outcome.result) throw new Error('NekoSearch benchmark stopped')
  return { result: outcome.result, elapsedMs: performance.now() - startedAt }
}

async function recallAnnRows(centers, acceptPathKeys) {
  const recalled = new Map()
  const ann = await annRequest('search-batch', {
    queryVectors: centers.map((center) => Array.from(center)),
    topK: clipCandidateK,
    candidateRatio: 0.1,
    acceptPathKeys,
  })
  if (!ann.queryResults || ann.queryResults.length !== centers.length) {
    throw new Error('ANN batch result count mismatch')
  }
  for (const queryResult of ann.queryResults) {
    for (const candidate of queryResult.results) {
      recalled.set(f16.embeddingCachePathKey(candidate.path), {
        path: candidate.path,
        row: candidate.row,
      })
    }
  }
  return {
    rows: [...recalled.values()].sort(
      (left, right) => left.row - right.row || left.path.localeCompare(right.path),
    ),
    internalCandidates: ann.candidateCount,
    indexedCount: ann.indexedCount,
    searchMs: ann.searchMs,
  }
}

async function main() {
  const beforeSource = sourceSnapshot()
  const fixture = await buildFixture()
  const eligibleAssets = await loadActiveAssets()
  const acceptPathKeys = eligibleAssets.map((asset) => asset.pathKey)
  const acceptPathKeySet = new Set(acceptPathKeys)
  const centers = feedback.buildFeedbackSearchCenters(fixture.target, 4)
  if (centers.length === 0) throw new Error('No CLIP feedback centers were produced')

  const exactRuns = []
  let exactReference
  for (let index = 0; index < runs; index++) {
    const current = await runCategory(workerInput(fixture, eligibleAssets))
    exactReference ||= current.result
    exactRuns.push(round(current.elapsedMs, 2))
    console.error(`[neko-ann] exact ${index + 1}/${runs}`)
  }

  const rssBeforePrewarm = process.memoryUsage().rss
  const prewarmStartedAt = performance.now()
  const prewarm = await annRequest('prewarm')
  const prewarmMs = performance.now() - prewarmStartedAt
  const rssAfterPrewarm = process.memoryUsage().rss
  const annRuns = []
  const parity = []
  let finalRecall
  for (let index = 0; index < runs; index++) {
    const startedAt = performance.now()
    const recallStartedAt = performance.now()
    const recalled = await recallAnnRows(centers, acceptPathKeys)
    const recallWallMs = performance.now() - recallStartedAt
    const current = await runCategory(workerInput(fixture, eligibleAssets, recalled.rows))
    const elapsedMs = performance.now() - startedAt
    annRuns.push(round(elapsedMs, 2))
    finalRecall = recalled
    const exactScores = new Map(
      exactReference.hits.map((hit) => [f16.embeddingCachePathKey(hit.path), hit.score]),
    )
    let maximumCommonScoreError = 0
    for (const hit of current.result.hits) {
      const expected = exactScores.get(f16.embeddingCachePathKey(hit.path))
      if (expected !== undefined) {
        maximumCommonScoreError = Math.max(maximumCommonScoreError, Math.abs(expected - hit.score))
      }
    }
    parity.push({
      top20Overlap: round(overlapAtK(exactReference, current.result, 20)),
      top50Overlap: round(overlapAtK(exactReference, current.result, 50)),
      top100Overlap: round(overlapAtK(exactReference, current.result, 100)),
      firstMatch: resultPaths(exactReference, 1)[0] === resultPaths(current.result, 1)[0],
      maximumCommonScoreError,
      metrics: rankedMetrics(current.result, fixture.labels),
      activeFilterViolations: current.result.hits.filter(
        (hit) => !acceptPathKeySet.has(f16.embeddingCachePathKey(hit.path)),
      ).length,
      recallWallMs: round(recallWallMs, 2),
      exactRerankMs: round(current.elapsedMs, 2),
      annRows: recalled.rows.length,
      internalCandidateRatioOfIndexed: round(
        recalled.internalCandidates / Math.max(1, recalled.indexedCount * centers.length),
        6,
      ),
      internalCandidateRatioOfActive: round(
        recalled.internalCandidates / Math.max(1, eligibleAssets.length * centers.length),
        6,
      ),
    })
    console.error(`[neko-ann] candidate ${index + 1}/${runs}`)
  }

  const exactMetrics = rankedMetrics(exactReference, fixture.labels)
  const exactP95Ms = percentile(exactRuns, 0.95)
  const annP95Ms = percentile(annRuns, 0.95)
  const p95ImprovementPercent = ((exactP95Ms - annP95Ms) / Math.max(1, exactP95Ms)) * 100
  const minimum = (field) => Math.min(...parity.map((item) => item[field]))
  const maximumScoreError = Math.max(...parity.map((item) => item.maximumCommonScoreError))
  const metricDrops = {
    precisionAt20: Math.max(
      ...parity.map((item) => exactMetrics.precisionAt20 - item.metrics.precisionAt20),
    ),
    recallAt50: Math.max(
      ...parity.map((item) => exactMetrics.recallAt50 - item.metrics.recallAt50),
    ),
    ndcgAt20Relative: Math.max(
      ...parity.map(
        (item) =>
          (exactMetrics.ndcgAt20 - item.metrics.ndcgAt20) /
          Math.max(0.0001, exactMetrics.ndcgAt20),
      ),
    ),
    rejectIntrusionAt20Rise: Math.max(
      ...parity.map(
        (item) => item.metrics.rejectIntrusionAt20 - exactMetrics.rejectIntrusionAt20,
      ),
    ),
  }
  const afterSource = sourceSnapshot()
  const sourceFilesUnchanged = JSON.stringify(beforeSource) === JSON.stringify(afterSource)
  const failures = []
  if (minimum('top50Overlap') < 0.98) failures.push('Top-50 exact overlap is below 98%')
  if (parity.some((item) => !item.firstMatch)) failures.push('First result changed')
  if (maximumScoreError > 1e-6) failures.push('Common exact scores changed')
  if (metricDrops.precisionAt20 > 0.02) failures.push('Precision@20 dropped by more than 2pt')
  if (metricDrops.recallAt50 > 0.01) failures.push('Recall@50 dropped by more than 1pt')
  if (metricDrops.ndcgAt20Relative > 0.02) failures.push('nDCG@20 dropped by more than 2%')
  if (metricDrops.rejectIntrusionAt20Rise > 0.01) {
    failures.push('Reject intrusion@20 rose by more than 1pt')
  }
  if (parity.some((item) => item.activeFilterViolations > 0)) {
    failures.push('ANN returned an inactive asset')
  }
  if (p95ImprovementPercent < 30) failures.push('P95 improvement is below 30%')
  if (!sourceFilesUnchanged) failures.push('A source file changed')

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    categoryId: fixture.categoryId,
    judgedSamples: { positive: fixture.positives, negative: fixture.negatives },
    cache: { count: meta.count, dim: meta.dim, activeCount: eligibleAssets.length },
    centers: centers.length,
    topK,
    clipCandidateK,
    exact: {
      runsMs: exactRuns,
      p50Ms: round(percentile(exactRuns, 0.5), 2),
      p95Ms: round(exactP95Ms, 2),
      metrics: exactMetrics,
    },
    ann: {
      runsMs: annRuns,
      p50Ms: round(percentile(annRuns, 0.5), 2),
      p95Ms: round(annP95Ms, 2),
      p95ImprovementPercent: round(p95ImprovementPercent, 2),
      recalledRows: finalRecall.rows.length,
      internalCandidatesPerCenter: round(
        finalRecall.internalCandidates / Math.max(1, centers.length),
        2,
      ),
      internalCandidateRatioOfIndexed: parity[0].internalCandidateRatioOfIndexed,
      internalCandidateRatioOfActive: parity[0].internalCandidateRatioOfActive,
      recallP95Ms: round(percentile(parity.map((item) => item.recallWallMs), 0.95), 2),
      exactRerankP95Ms: round(
        percentile(
          parity.map((item) => item.exactRerankMs),
          0.95,
        ),
        2,
      ),
      prewarmMs: round(prewarmMs, 2),
      prewarmBuildMode: prewarm.buildMode,
      processRssAfterMiB: round(rssAfterPrewarm / 1024 / 1024, 2),
      processRssDeltaMiB: round((rssAfterPrewarm - rssBeforePrewarm) / 1024 / 1024, 2),
    },
    parity: {
      minimumTop20Overlap: minimum('top20Overlap'),
      minimumTop50Overlap: minimum('top50Overlap'),
      minimumTop100Overlap: minimum('top100Overlap'),
      firstMatchRate: round(parity.filter((item) => item.firstMatch).length / parity.length),
      maximumCommonScoreError: maximumScoreError,
      metricDrops,
      runs: parity,
    },
    safety: { sourceFilesUnchanged, isolatedDerivedIndex: true },
    gate: { passed: failures.length === 0, failures },
  }

  const artifactRoot = path.join(repoRoot, 'artifacts', 'benchmark', 'neko-ann-prep008')
  const directoryName = output.generatedAt.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const reportDirectory = path.join(artifactRoot, directoryName)
  fs.mkdirSync(reportDirectory, { recursive: true })
  fs.writeFileSync(path.join(reportDirectory, 'report.json'), `${JSON.stringify(output, null, 2)}\n`)
  fs.writeFileSync(
    path.join(reportDirectory, 'report.md'),
    `# PREP-008 NekoSearch ANN gate\n\n` +
      `- Cache: ${output.cache.count.toLocaleString()} rows × ${output.cache.dim} dimensions\n` +
      `- Active assets: ${output.cache.activeCount.toLocaleString()}\n` +
      `- Exact/ANN P95: ${output.exact.p95Ms}/${output.ann.p95Ms} ms\n` +
      `- P95 improvement: ${output.ann.p95ImprovementPercent}%\n` +
      `- Top-50 overlap: ${output.parity.minimumTop50Overlap}\n` +
      `- First-match rate: ${output.parity.firstMatchRate}\n` +
      `- Source unchanged: ${output.safety.sourceFilesUnchanged}\n` +
      `- Gate: **${output.gate.passed ? 'PASS' : 'FAIL'}**\n`,
  )
  fs.writeFileSync(
    path.join(artifactRoot, 'latest.json'),
    `${JSON.stringify(
      {
        generatedAt: output.generatedAt,
        reportDirectory: directoryName,
        reportFile: `artifacts/benchmark/neko-ann-prep008/${directoryName}/report.json`,
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
  .finally(() => annWorker.terminate())
  .finally(() => {
    const resolvedRoot = path.resolve(isolatedRoot)
    if (
      path.dirname(resolvedRoot) === path.resolve(os.tmpdir()) &&
      path.basename(resolvedRoot).startsWith('floating-clock-neko-ann-')
    ) {
      fs.rmSync(resolvedRoot, { recursive: true, force: true })
    }
  })
