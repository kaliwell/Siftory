const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')

const {
  digestConsistency,
  percentile,
  summarizeNumbers,
  summarizePhases,
  summarizeResources,
} = require('../scripts/run-search-library-preparation-benchmark.cjs')
const {
  safeRemoveTempRoot,
  snapshotFiles,
} = require('./search-library-preparation-benchmark-utils.cjs')
const {
  embeddingStageBreakdown,
  progressIntervals,
  resolveBenchmarkDirectory,
} = require('../scripts/analyze-image-preparation-stages.cjs')
const {
  parseArgs: parseImagePreparationArgs,
  validateOutputDirectory,
} = require('../scripts/run-image-preparation-pipeline-ab.cjs')
const {
  analyzeReports: analyzeEmbeddingPolicyReports,
} = require('../scripts/analyze-embedding-policy-matrix.cjs')
const {
  analyzeReports: analyzeJointSchedulingReports,
} = require('../scripts/analyze-image-joint-scheduling-matrix.cjs')
const { orderForRound } = require('./image-search-joint-scheduling-benchmark.cjs')

test('uses nearest-rank P50/P95 and never selects only the fastest run', () => {
  assert.equal(percentile([30, 10, 20], 0.5), 20)
  assert.equal(percentile([30, 10, 20], 0.95), 30)
  assert.deepEqual(summarizeNumbers([30, 10, 20]), {
    samples: 3,
    p50: 20,
    p95: 30,
    max: 30,
  })
})

test('image preparation A/B accepts a 1000-image diagnostic corpus', () => {
  assert.equal(parseImagePreparationArgs(['--sample=1000']).sample, 1000)
  assert.equal(parseImagePreparationArgs(['--sample=5000']).sample, 1000)
  assert.equal(parseImagePreparationArgs(['--skip-analysis']).skipAnalysis, true)
})

test('stage analysis accepts only strict children of configured managed artifact roots', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-analysis-root-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const benchmark = path.join(root, 'benchmark')
  const automation = path.join(root, 'automation')
  const run = path.join(automation, 'run')
  fs.mkdirSync(benchmark)
  fs.mkdirSync(run, { recursive: true })
  assert.equal(resolveBenchmarkDirectory([`--dir=${run}`], [benchmark, automation]), run)
  assert.throws(
    () => resolveBenchmarkDirectory([`--dir=${automation}`], [benchmark, automation]),
    /managed benchmark artifact root/,
  )
  assert.throws(
    () => resolveBenchmarkDirectory([`--dir=${root}`], [benchmark, automation]),
    /managed benchmark artifact root/,
  )
  assert.doesNotThrow(() =>
    validateOutputDirectory(
      path.join(projectRoot, 'artifacts', 'automation', 'image-preparation-contract'),
    ),
  )
})

test('aggregates phase and resource metrics without inventing unavailable GPU values', () => {
  const reports = [
    {
      phases: { scanMs: 10, totalMs: 30 },
      resources: { memory: { mainPeakRssMiB: 100 }, gpu: null },
    },
    {
      phases: { scanMs: 20, totalMs: 50 },
      resources: { memory: { mainPeakRssMiB: 120 }, gpu: null },
    },
    {
      phases: { scanMs: 15, totalMs: 40 },
      resources: { memory: { mainPeakRssMiB: 110 }, gpu: null },
    },
  ]
  assert.equal(summarizePhases(reports).scanMs.p50, 15)
  assert.equal(summarizePhases(reports).totalMs.p95, 50)
  const resources = summarizeResources(reports)
  assert.equal(resources['memory.mainPeakRssMiB'].p50, 110)
  assert.equal(resources['gpu.peakDeltaUsedMiB'].samples, 0)
})

test('requires every repeated run to provide the same correctness digest', () => {
  const consistent = digestConsistency([{ hash: 'a' }, { hash: 'a' }, { hash: 'a' }], {
    output: (report) => report.hash,
  })
  const missing = digestConsistency([{ hash: 'a' }, {}, { hash: 'a' }], {
    output: (report) => report.hash,
  })
  assert.equal(consistent.output.consistent, true)
  assert.equal(missing.output.consistent, false)
})

test('source snapshots detect metadata changes and temp cleanup is prefix guarded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-benchmark-test-'))
  const filePath = path.join(root, 'fixture.txt')
  fs.writeFileSync(filePath, 'fixed corpus', 'utf8')
  const before = snapshotFiles([filePath])
  const after = snapshotFiles([filePath])
  assert.deepEqual(after, before)
  assert.throws(() => safeRemoveTempRoot(root, 'wrong-prefix-'), /Refusing to remove/)
  safeRemoveTempRoot(root, 'siftory-benchmark-test-')
  assert.equal(fs.existsSync(root), false)
})

test('stage interval analysis separates startup latency from a mid-run stall', () => {
  const startup = progressIntervals(
    [
      { atMs: 0, completed: 0 },
      { atMs: 3_200, completed: 10 },
      { atMs: 4_200, completed: 20 },
    ],
    'completed',
  )
  assert.equal(startup.largestChangeGap.location, 'startup')
  assert.equal(startup.suspectedMidRunStalls, 0)

  const stalled = progressIntervals(
    [
      { atMs: 0, completed: 0 },
      { atMs: 1_000, completed: 10 },
      { atMs: 2_000, completed: 10 },
      { atMs: 3_000, completed: 10 },
      { atMs: 4_000, completed: 10 },
      { atMs: 5_000, completed: 20 },
      { atMs: 6_000, completed: 30 },
    ],
    'completed',
  )
  assert.equal(stalled.largestChangeGap.location, 'mid-run')
  assert.equal(stalled.largestChangeGap.gapMs, 4_000)
  assert.equal(stalled.suspectedMidRunStalls, 1)
})

test('stage interval analysis reports partial coverage and ignores counter resets', () => {
  const result = progressIntervals(
    [
      { atMs: 0, completed: 80 },
      { atMs: 1_000, completed: 100 },
      { atMs: 2_000, completed: 0 },
      { atMs: 3_000, completed: 0 },
    ],
    'completed',
  )
  assert.equal(result.partialCoverage, true)
  assert.equal(result.resets, 1)
  assert.equal(result.changes, 1)
})

test('embedding stage analysis separates pre-inference, inference, and persistence', () => {
  const result = embeddingStageBreakdown({
    stageMetrics: {
      schemaVersion: 1,
      batches: 2,
      items: 8,
      succeeded: 8,
      failed: 0,
      fallbackBatches: 1,
      queueWaitMsTotal: 16,
      queueWaitMsMax: 5,
      batchWallMsTotal: 200,
      batchWallMsMax: 110,
      runtimeLoadMsTotal: 10,
      decodeNormalizeMsTotal: 40,
      preprocessMsTotal: 20,
      inferenceMsTotal: 120,
      postprocessMsTotal: 10,
      fallbackMsTotal: 25,
      persistenceOperations: 8,
      persistenceMsTotal: 32,
      persistenceMsMax: 6,
      persistencePeakPending: 3,
    },
  })
  assert.equal(result.available, true)
  assert.equal(result.preInferenceMs, 60)
  assert.equal(result.coreStageMs, 200)
  assert.equal(result.preInferenceSharePercent, 30)
  assert.equal(result.inferenceSharePercent, 60)
  assert.equal(result.queueWaitMsPerItem, 2)
  assert.equal(result.persistenceMsAverage, 4)
  assert.equal(result.fallbackBatchPercent, 50)
  assert.equal(embeddingStageBreakdown({}).available, false)
})

test('embedding policy matrix requires three rounds and a five percent P50 gain', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-policy-matrix-test-'))
  t.after(() => safeRemoveTempRoot(root, 'siftory-policy-matrix-test-'))
  const sourceSnapshot = { count: 256, totalBytes: 1234, sha256: 'fixed' }
  const candidateTimes = [90, 92, 91]
  const baselineTimes = [100, 101, 99]
  const files = candidateTimes.map((candidateElapsed, index) => {
    const filePath = path.join(root, `round-${index + 1}.json`)
    const completed = (jobs, elapsedMs) => ({
      status: 'completed',
      model: 'dino',
      jobs,
      batchSize: 4,
      elapsedMs,
      imagesPerSecond: 256_000 / elapsedMs,
      digest: 'same',
      qualityVsBaseline: { minCosine: 1, maxAbsDiff: 0 },
      stageMetrics: { preInferenceSharePercent: 60 },
      resources: {
        sampling: { samples: 10, errors: 0 },
        memory: { systemMinFreeMiB: 512, childPeakAggregateRssMiBApprox: 1024 },
        gpu: { peakUsedMiB: 2048, peakDeltaUsedMiB: 512 },
      },
    })
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        runs: [completed(1, candidateElapsed), completed(2, baselineTimes[index])],
        safety: { sourceSnapshot },
      }),
      'utf8',
    )
    return filePath
  })
  const analysis = analyzeEmbeddingPolicyReports(files)
  const candidate = analysis.groups.find((group) => group.jobs === 1)
  assert.equal(candidate.runs, 3)
  assert.equal(candidate.improvementPercent > 5, true)
  assert.equal(candidate.decision, 'candidate-for-1000-image-final')
  assert.deepEqual(analysis.recommendations[0], {
    model: 'dino',
    action: 'advance-candidate',
    jobs: 1,
    batchSize: 4,
    improvementPercent: candidate.improvementPercent,
  })
  assert.equal(analysis.sourceSnapshotConsistent, true)
})

test('joint scheduling matrix selects only a three-round end-to-end candidate', () => {
  const sourceSnapshot = { count: 256, totalBytes: 1234, sha256: 'fixed' }
  const createReport = (scanWorkers, embeddingJobs, readyMs) => ({
    ok: true,
    config: { requestedScanWorkers: scanWorkers, jobs: embeddingJobs, batchSize: 4 },
    phases: { libraryReadyMs: readyMs },
    scan: {
      digest: { count: 256, sha256: 'native' },
      progress: {
        scanWorkerCount: scanWorkers,
        decodeMsTotal: 100,
        queueWaitMs: 20,
      },
    },
    embeddingDigests: {
      dino: { count: 256, stableSha256: 'dino' },
      clip: { count: 256, stableSha256: 'clip' },
    },
    dino: { progress: { failed: 0, stageMetrics: { fallbackBatches: 0 } } },
    clip: { progress: { failed: 0, stageMetrics: { fallbackBatches: 0 } } },
    vectorIndex: { status: { built: true, count: 256, dim: 768 } },
    pipeline: {
      result: {
        commitFeedDropped: 0,
        timings: {
          scanReadyMs: readyMs * 0.6,
          dinoReadyMs: readyMs * 0.61,
          clipReadyMs: readyMs * 0.99,
        },
      },
    },
    resources: {
      sampling: { errors: 0, processRaceSkips: 0 },
      memory: {
        systemMinFreeMiB: 512,
        mainPeakRssMiB: 700,
        childPeakAggregateRssMiBApprox: 2800,
      },
      gpu: { peakUsedMiB: 2800, totalMiB: 4096 },
    },
    safety: { sourceUnchanged: true, sourceSnapshot },
  })
  const reports = [100, 101, 99].flatMap((baselineMs, index) => [
    createReport(3, 2, baselineMs),
    createReport(2, 2, [90, 92, 91][index]),
  ])
  const analysis = analyzeJointSchedulingReports(reports)
  const candidate = analysis.groups.find(
    (group) => group.scanWorkers === 2 && group.embeddingJobs === 2,
  )
  assert.equal(candidate.runs, 3)
  assert.equal(candidate.decision, 'finalist')
  assert.equal(candidate.improvementPercent > 5, true)
  assert.deepEqual(analysis.recommendation, {
    action: 'run-1000-image-final',
    scanWorkers: 2,
    embeddingJobs: 2,
    batchSize: 4,
  })
  assert.equal(analysis.correctness.globalParity, true)
  assert.equal(analysis.correctness.sourceParity, true)
})

test('joint scheduling order rotates and reverses without dropping combinations', () => {
  const combos = [
    { scanWorkers: 2, embeddingJobs: 1 },
    { scanWorkers: 3, embeddingJobs: 2 },
    { scanWorkers: 4, embeddingJobs: 2 },
  ]
  const first = orderForRound(combos, 0)
  const second = orderForRound(combos, 1)
  assert.deepEqual(first, combos)
  assert.equal(second.length, combos.length)
  assert.deepEqual(
    [...second].sort((left, right) => left.scanWorkers - right.scanWorkers),
    [...combos].sort((left, right) => left.scanWorkers - right.scanWorkers),
  )
  assert.notDeepEqual(second, first)
})
