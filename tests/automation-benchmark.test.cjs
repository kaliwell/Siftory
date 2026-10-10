const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const {
  DEFAULT_DATASET,
  baselineContextIssues,
  compareMetrics,
  createBoundedCapture,
  createPlan,
  diagnoseGpuHeadroom,
  escapeHtml,
  extractBaselineMetrics,
  extractBenchmarkMetrics,
  inspectDataset,
  isPathInside,
  parseArgs,
  renderHtml,
  resolveNpmInvocation,
  runAutomationBenchmark,
  runStage,
  validateRunPaths,
} = require('../scripts/run-automation-benchmark.cjs')
const {
  writeLatestPointer: writeMediaPreparationLatestPointer,
} = require('../scripts/run-media-preparation-pipeline-ab.cjs')

const projectRoot = path.resolve(__dirname, '..')

function createImageReport(overrides = {}) {
  return {
    schemaVersion: 1,
    config: { sample: 16, runs: 3, backend: 'gpu', jobs: 2, batchSize: 4 },
    performance: {
      libraryReadyMs: {
        overlap: { samples: 3, p50: 105, p95: 125, max: 125 },
      },
      resources: {
        'memory.mainPeakRssMiB': {
          overlap: { samples: 3, p50: 520, p95: 570, max: 570 },
        },
        'memory.childPeakAggregateRssMiBApprox': {
          overlap: { samples: 3, p50: 1050, p95: 1150, max: 1150 },
        },
      },
    },
    runs: {
      overlap: [
        { phases: { totalMs: 140 } },
        { phases: { totalMs: 145 } },
        { phases: { totalMs: 155 } },
      ],
    },
    safety: {
      sourceFilesUnchanged: true,
      isolatedUserData: true,
      realLibraryWritten: false,
    },
    gate: { passed: true, failures: [] },
    ...overrides,
  }
}

function createMediaReport() {
  return {
    schemaVersion: 1,
    config: {
      runs: 3,
      backend: 'gpu',
      jobs: 2,
      batchSize: 4,
      fixtureCfrSeconds: 120,
    },
    performance: {
      libraryReadyMs: { overlap: { samples: 3, p50: 205, p95: 225, max: 225 } },
      resources: {
        'memory.mainPeakRssMiB': {
          overlap: { samples: 3, p50: 420, p95: 470, max: 470 },
        },
        'memory.childPeakAggregateRssMiBApprox': {
          overlap: { samples: 3, p50: 850, p95: 950, max: 950 },
        },
      },
    },
    runs: {
      overlap: [
        { phases: { totalMs: 240 }, counts: { total: 3 } },
        { phases: { totalMs: 245 }, counts: { total: 3 } },
        { phases: { totalMs: 255 }, counts: { total: 3 } },
      ],
    },
    safety: { sourceFilesUnchanged: true, isolatedUserData: true },
    gate: { passed: true, failures: [] },
  }
}

function createCombinedBaseline(datasetRealPath) {
  return {
    schemaVersion: 1,
    config: {
      datasetRealPath,
      imageSample: 16,
      backend: 'gpu',
      jobs: 2,
      batchSize: 4,
    },
    image: {
      phases: {
        libraryReadyMs: { samples: 3, p50: 100, p95: 120, max: 120 },
        totalMs: { samples: 3, p50: 140, p95: 150, max: 150 },
      },
      resources: {
        'memory.mainPeakRssMiB': { samples: 3, p50: 500, p95: 550, max: 550 },
        'memory.childPeakAggregateRssMiBApprox': {
          samples: 3,
          p50: 1000,
          p95: 1100,
          max: 1100,
        },
      },
    },
  }
}

function successfulStageResult(durationMs = 25) {
  return {
    startedAt: '2026-08-24T00:00:00.000Z',
    finishedAt: '2026-08-24T00:00:00.025Z',
    durationMs,
    exitCode: 0,
    signal: null,
    timedOut: false,
    error: null,
    stdout: { text: 'ok\n', totalBytes: 3, capturedBytes: 3, truncated: false },
    stderr: { text: '', totalBytes: 0, capturedBytes: 0, truncated: false },
  }
}

test('argument parser defaults to the fixed PxHere quick corpus and isolated output', () => {
  const now = new Date('2026-08-24T01:02:03.004Z')
  const options = parseArgs([], { projectRoot, now })
  assert.equal(options.dataset, path.resolve(DEFAULT_DATASET))
  assert.equal(options.mode, 'quick')
  assert.equal(options.imageSample, 16)
  assert.equal(options.pairedRuns, 3)
  assert.equal(options.thresholdPercent, 10)
  assert.ok(
    isPathInside(path.join(projectRoot, 'artifacts', 'automation'), options.outputDirectory),
  )
  assert.match(options.outputDirectory, /2026-08-24_01-02-03-004$/)
})

test('argument parser supports full, baseline, threshold and rejects unsafe combinations', () => {
  const options = parseArgs(
    [
      '--full',
      '--dataset=D:\\fixed',
      '--baseline=baseline.json',
      '--output-dir=artifacts/automation/full-run',
      '--threshold-percent=7.5',
    ],
    { projectRoot },
  )
  assert.equal(options.mode, 'full')
  assert.equal(options.imageSample, 1000)
  assert.equal(options.thresholdPercent, 7.5)
  assert.equal(options.baseline, path.join(projectRoot, 'baseline.json'))
  assert.throws(() => parseArgs(['--quick', '--full'], { projectRoot }), /mutually exclusive/)
  assert.throws(() => parseArgs(['--threshold-percent=-1'], { projectRoot }), /between 0 and 100/)
  assert.throws(() => parseArgs(['--output-dir=outside'], { projectRoot }), /must be a child/)
  assert.throws(() => parseArgs(['--mystery'], { projectRoot }), /Unknown/)
})

test('quick and full plans reuse the existing image analyzer and optional media benchmark', () => {
  const quick = parseArgs(['--output-dir=artifacts/automation/quick-plan'], { projectRoot })
  const full = parseArgs(['--full', '--output-dir=artifacts/automation/full-plan'], { projectRoot })
  assert.deepEqual(
    createPlan(quick, {
      npm: { command: 'node', prefixArgs: ['npm-cli'], display: 'npm' },
    }).stages.map((stage) => stage.packageScript),
    ['benchmark:image-search:preparation:ab', 'benchmark:image-search:preparation:analyze'],
  )
  const fullPlan = createPlan(full, {
    npm: { command: 'node', prefixArgs: ['npm-cli'], display: 'npm' },
  })
  assert.deepEqual(
    fullPlan.stages.map((stage) => stage.packageScript),
    [
      'benchmark:image-search:preparation:ab',
      'benchmark:image-search:preparation:analyze',
      'benchmark:media-search:preparation:ab',
    ],
  )
  assert.ok(
    fullPlan.stages.every((stage) => isPathInside(full.automationRoot, stage.outputDirectory)),
  )
  assert.ok(fullPlan.stages[0].args.some((argument) => argument === '--sample=1000'))
  assert.ok(fullPlan.stages[0].args.includes('--skip-analysis'))
})

test('default benchmark npm invocation uses npm-cli.js without a command shell', () => {
  const npm = resolveNpmInvocation({})
  assert.equal(npm.command, process.execPath)
  assert.match(npm.prefixArgs[0], /npm-cli\.js$/)
  const options = parseArgs(
    ['--dataset=D:\\fixtures & samples', '--output-dir=artifacts/automation/shell-safe-plan'],
    { projectRoot },
  )
  const stage = createPlan(options).stages[0]
  assert.equal(stage.command, process.execPath)
  assert.ok(stage.args.includes(`--dataset=${options.dataset}`))
  assert.ok(stage.args.some((argument) => argument.includes('&')))
})

test('media preparation updates global latest only for strict benchmark-root children', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-preparation-latest-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const benchmarkRoot = path.join(root, 'artifacts', 'benchmark', 'media-preparation-pipeline')
  const benchmarkRun = path.join(benchmarkRoot, 'run-1')
  const automationRun = path.join(root, 'artifacts', 'automation', 'run-1', 'media-preparation')
  const report = { generatedAt: '2026-08-24T00:00:00.000Z', gate: { passed: true } }
  const dependencies = { benchmarkRoot, projectRoot: root }

  fs.mkdirSync(automationRun, { recursive: true })
  const automationLatest = writeMediaPreparationLatestPointer(
    { outDir: automationRun },
    report,
    path.join(automationRun, 'report.json'),
    path.join(automationRun, 'report.md'),
    dependencies,
  )
  assert.equal(automationLatest, null)
  assert.equal(fs.existsSync(path.join(benchmarkRoot, 'latest.json')), false)

  fs.mkdirSync(benchmarkRun, { recursive: true })
  const benchmarkLatest = writeMediaPreparationLatestPointer(
    { outDir: benchmarkRun },
    report,
    path.join(benchmarkRun, 'report.json'),
    path.join(benchmarkRun, 'report.md'),
    dependencies,
  )
  assert.equal(benchmarkLatest, path.join(benchmarkRoot, 'latest.json'))
  assert.equal(JSON.parse(fs.readFileSync(benchmarkLatest, 'utf8')).reportDirectory, 'run-1')

  assert.equal(
    writeMediaPreparationLatestPointer(
      { outDir: benchmarkRoot },
      report,
      path.join(benchmarkRoot, 'report.json'),
      path.join(benchmarkRoot, 'report.md'),
      dependencies,
    ),
    null,
  )
})

test('dataset validation is read-only and refuses overlap with generated artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-dataset-'))
  try {
    const dataset = path.join(root, 'dataset')
    const automationRoot = path.join(root, 'artifacts', 'automation')
    fs.mkdirSync(dataset)
    fs.writeFileSync(path.join(dataset, 'sample.jpg'), 'sample')
    const snapshot = inspectDataset(dataset)
    assert.equal(snapshot.realPath, fs.realpathSync(dataset))
    assert.doesNotThrow(() =>
      validateRunPaths(snapshot, path.join(automationRoot, 'run'), automationRoot),
    )
    assert.throws(
      () => validateRunPaths(snapshot, path.join(dataset, 'generated'), automationRoot),
      /escaped|overlap/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('benchmark output boundary resolves junctions before accepting a run directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-junction-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataset = path.join(root, 'dataset')
  const automationRoot = path.join(root, 'artifacts', 'automation')
  const external = path.join(root, 'external')
  const linkedRun = path.join(automationRoot, 'linked-run')
  fs.mkdirSync(dataset)
  fs.mkdirSync(automationRoot, { recursive: true })
  fs.mkdirSync(external)
  try {
    fs.symlinkSync(external, linkedRun, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`junction creation unavailable: ${error.message}`)
    return
  }
  assert.throws(
    () => validateRunPaths(inspectDataset(dataset), linkedRun, automationRoot),
    /escaped/,
  )
})

test('bounded capture preserves complete small output and bounded head/tail for large output', () => {
  const small = createBoundedCapture(64)
  small.push('complete output')
  assert.deepEqual(small.snapshot(), {
    text: 'complete output',
    totalBytes: 15,
    capturedBytes: 15,
    truncated: false,
  })

  const large = createBoundedCapture(64)
  large.push('A'.repeat(40))
  large.push('B'.repeat(80))
  const snapshot = large.snapshot()
  assert.equal(snapshot.totalBytes, 120)
  assert.equal(snapshot.capturedBytes, 64)
  assert.equal(snapshot.truncated, true)
  assert.ok(Buffer.byteLength(snapshot.text, 'utf8') <= 64)
  assert.match(snapshot.text, /^A+/)
  assert.match(snapshot.text, /B+$/)
  assert.match(snapshot.text, /84 byte\(s\) omitted/)
})

test('stage runner records duration, nonzero exit and bounded stdout/stderr', async () => {
  const result = await runStage(
    {
      id: 'child-fixture',
      label: 'Child fixture',
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write('A'.repeat(200)); process.stderr.write('bounded-error'); process.exitCode = 7",
      ],
      displayCommand: ['node', '-e', '<fixture>'],
      timeoutMs: 10_000,
    },
    { captureLimitBytes: 64 },
  )
  assert.equal(result.exitCode, 7)
  assert.ok(result.durationMs >= 0)
  assert.equal(result.stdout.totalBytes, 200)
  assert.equal(result.stdout.capturedBytes, 64)
  assert.ok(Buffer.byteLength(result.stdout.text, 'utf8') <= 64)
  assert.equal(result.stdout.truncated, true)
  assert.equal(result.stderr.text, 'bounded-error')
  assert.equal(result.stderr.truncated, false)
})

test('metric extraction handles A/B reports, combined baselines and RSS summaries', () => {
  const current = extractBenchmarkMetrics({
    imageReport: createImageReport(),
    mediaReport: createMediaReport(),
    imageAnalysis: null,
    scopes: ['image', 'media'],
  })
  assert.equal(current['image.libraryReadyMs.p50'].value, 105)
  assert.equal(current['image.totalMs.p95'].value, 155)
  assert.equal(current['image.mainPeakRssMiB.p95'].value, 570)
  assert.equal(current['media.libraryReadyMs.p50'].value, 205)
  assert.equal(current['media.childPeakAggregateRssMiBApprox.p95'].value, 950)

  const baseline = extractBaselineMetrics(createCombinedBaseline('D:\\fixed'), ['image'])
  assert.equal(baseline['image.libraryReadyMs.p95'].value, 120)
  assert.equal(baseline['image.totalMs.p50'].value, 140)
  assert.equal(baseline['image.mainPeakRssMiB.p50'].value, 500)
})

test('GPU diagnosis separates environmental headroom pressure from workload growth', () => {
  const gpuRun = (baselineUsedMiB, peakUsedMiB, peakDeltaUsedMiB) => ({
    resources: {
      gpu: {
        baselineUsedMiB,
        peakUsedMiB,
        peakDeltaUsedMiB,
        totalMiB: 4096,
      },
    },
  })
  const report = {
    gate: {
      passed: false,
      failures: ['GPU peak used memory exceeded 75%'],
      budgets: {
        gpuAbsoluteDeltaMiB: 768,
        gpuGrowthVersusSerialMiB: 256,
        gpuDeviceUsageRatio: 0.75,
      },
    },
    runs: {
      serial: [gpuRun(2601, 3159, 558), gpuRun(2573, 3225, 652), gpuRun(2571, 3227, 656)],
      overlap: [gpuRun(2581, 3136, 555), gpuRun(2581, 3253, 672), gpuRun(2571, 3245, 674)],
    },
  }
  const diagnosis = diagnoseGpuHeadroom(report)
  assert.equal(diagnosis.classification, 'environment-headroom-limited')
  assert.equal(diagnosis.environmentContentionLikely, true)
  assert.equal(diagnosis.observed.baselineUsedMiBP50, 2581)
  assert.equal(diagnosis.observed.workloadDeltaMiBMax, 674)
  assert.equal(diagnosis.observed.peakUsedMiBMax, 3253)
  assert.equal(diagnosis.budgets.allowedPeakUsedMiB, 3072)
  assert.equal(diagnosis.observed.additionalHeadroomNeededMiB, 181)
  assert.equal(diagnosis.checks.absoluteDeltaExceeded, false)
  assert.equal(diagnosis.checks.growthExceeded, false)
  assert.equal(diagnosis.checks.deviceUsageExceeded, true)

  report.runs.overlap[2].resources.gpu.peakDeltaUsedMiB = 900
  assert.equal(diagnoseGpuHeadroom(report).classification, 'workload-delta-budget-exceeded')
  assert.equal(diagnoseGpuHeadroom(null).observed.additionalHeadroomNeededMiB, null)
})

test('baseline comparison fails regressions and treats every missing field as skipped/incomplete', () => {
  const current = extractBenchmarkMetrics({
    imageReport: createImageReport(),
    mediaReport: null,
    imageAnalysis: null,
    scopes: ['image'],
  })
  const baseline = extractBaselineMetrics(createCombinedBaseline('D:\\fixed'), ['image'])
  const passing = compareMetrics(current, baseline, 10)
  assert.equal(passing.status, 'passed')
  assert.equal(passing.failed, 0)
  assert.equal(passing.skipped, 0)

  current['image.libraryReadyMs.p50'].value = 125
  const failed = compareMetrics(current, baseline, 10)
  assert.equal(failed.status, 'failed')
  assert.equal(
    failed.results.find((result) => result.id === 'image.libraryReadyMs.p50').status,
    'failed',
  )

  baseline['image.mainPeakRssMiB.p95'] = {
    ...baseline['image.mainPeakRssMiB.p95'],
    value: null,
    available: false,
  }
  current['image.libraryReadyMs.p50'].value = 105
  const incomplete = compareMetrics(current, baseline, 10)
  assert.equal(incomplete.status, 'incomplete')
  assert.equal(incomplete.skipped, 1)
})

test('dataset or sample context mismatch prevents a baseline from being reported as passed', () => {
  const issues = baselineContextIssues(
    {
      config: {
        datasetRealPath: 'D:\\different',
        imageSample: 1000,
        backend: 'cpu',
      },
    },
    { imageSample: 16 },
    { realPath: 'D:\\fixed' },
  )
  assert.equal(issues.length, 3)
  const metrics = extractBaselineMetrics(createCombinedBaseline('D:\\fixed'), ['image'])
  const comparison = compareMetrics(metrics, metrics, 10, { contextIssues: issues })
  assert.equal(comparison.status, 'incomplete')
  assert.equal(comparison.compared, 0)
  assert.ok(comparison.results.every((result) => result.status === 'skipped'))
})

test('HTML renderer escapes paths and distinguishes skipped comparisons', () => {
  const html = renderHtml({
    status: 'incomplete',
    generatedAt: '2026-08-24T00:00:00.000Z',
    config: { mode: 'quick', dataset: '<unsafe&path>' },
    stages: [
      {
        id: 'stage',
        label: 'Stage <one>',
        durationMs: 1,
        exitCode: 0,
        stdout: { truncated: false },
        stderr: { truncated: false },
      },
    ],
    comparison: {
      status: 'incomplete',
      results: [
        {
          label: 'RSS',
          unit: 'MiB',
          baseline: null,
          current: 10,
          changePercent: null,
          status: 'skipped',
          reason: 'baseline <missing>',
        },
      ],
    },
    failures: ['missing <metric>'],
  })
  assert.match(html, /&lt;unsafe&amp;path&gt;/)
  assert.match(html, /baseline &lt;missing&gt;/)
  assert.doesNotMatch(html, /<unsafe&path>/)
  assert.equal(escapeHtml('"<&'), '&quot;&lt;&amp;')
})

test('--plan validates the fixed input but creates no output directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-plan-'))
  const outputDirectory = path.join(
    projectRoot,
    'artifacts',
    'automation',
    `plan-no-write-${process.pid}-${Date.now()}`,
  )
  try {
    const dataset = path.join(root, 'dataset')
    fs.mkdirSync(dataset)
    fs.writeFileSync(path.join(dataset, 'sample.jpg'), 'sample')
    const result = spawnSync(
      process.execPath,
      [
        path.join(projectRoot, 'scripts', 'run-automation-benchmark.cjs'),
        '--plan',
        `--dataset=${dataset}`,
        `--output-dir=${outputDirectory}`,
      ],
      { cwd: projectRoot, encoding: 'utf8', windowsHide: true },
    )
    assert.equal(result.status, 0, result.stderr)
    const plan = JSON.parse(result.stdout)
    assert.equal(plan.writesPlanned, false)
    assert.equal(plan.datasetValidation.readable, true)
    assert.equal(fs.existsSync(outputDirectory), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('orchestration writes bounded stage logs plus JSON/HTML and passes only a complete baseline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-integration-'))
  try {
    const dataset = path.join(root, 'dataset')
    const automationRoot = path.join(root, 'artifacts', 'automation')
    const outputDirectory = path.join(automationRoot, 'run')
    fs.mkdirSync(dataset)
    fs.writeFileSync(path.join(dataset, 'sample.jpg'), 'sample')
    const baselinePath = path.join(root, 'baseline.json')
    fs.writeFileSync(baselinePath, JSON.stringify(createCombinedBaseline(fs.realpathSync(dataset))))
    const options = parseArgs(
      [
        `--dataset=${dataset}`,
        `--baseline=${baselinePath}`,
        `--output-dir=${outputDirectory}`,
        '--quick',
      ],
      { projectRoot: root, automationRoot },
    )
    const stageRunner = async (stage) => {
      fs.mkdirSync(stage.outputDirectory, { recursive: true })
      if (stage.id === 'image-preparation-ab') {
        fs.writeFileSync(
          path.join(stage.outputDirectory, 'report.json'),
          JSON.stringify(createImageReport()),
        )
      }
      if (stage.id === 'image-preparation-analysis') {
        fs.writeFileSync(
          path.join(stage.outputDirectory, 'stage-analysis.json'),
          JSON.stringify({ schemaVersion: 1, runs: [] }),
        )
      }
      return successfulStageResult()
    }
    const result = await runAutomationBenchmark(options, {
      stageRunner,
      environment: { node: process.version, fixture: true },
      npm: { command: 'node', prefixArgs: ['npm-cli'], display: 'npm' },
    })
    assert.equal(result.report.ok, true)
    assert.equal(result.report.status, 'passed')
    assert.equal(result.report.comparison.status, 'passed')
    assert.equal(result.report.safety.datasetReadOnlyVerified, true)
    assert.equal(result.report.stages.length, 2)
    assert.ok(fs.existsSync(result.jsonPath))
    assert.ok(fs.existsSync(result.htmlPath))
    assert.ok(fs.existsSync(path.join(outputDirectory, 'events.ndjson')))
    assert.ok(fs.existsSync(path.join(outputDirectory, 'logs', '01-image-preparation-ab.log')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('orchestration continues to independent analysis after an A/B gate failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-continue-'))
  try {
    const dataset = path.join(root, 'dataset')
    const automationRoot = path.join(root, 'artifacts', 'automation')
    const outputDirectory = path.join(automationRoot, 'run')
    fs.mkdirSync(dataset)
    fs.writeFileSync(path.join(dataset, 'sample.jpg'), 'sample')
    const options = parseArgs(
      [`--dataset=${dataset}`, `--output-dir=${outputDirectory}`, '--quick'],
      { projectRoot: root, automationRoot },
    )
    const visited = []
    const result = await runAutomationBenchmark(options, {
      stageRunner: async (stage) => {
        visited.push(stage.id)
        fs.mkdirSync(stage.outputDirectory, { recursive: true })
        if (stage.id === 'image-preparation-ab') {
          fs.writeFileSync(
            path.join(stage.outputDirectory, 'report.json'),
            JSON.stringify(createImageReport({ gate: { passed: false, failures: ['fixture'] } })),
          )
          return { ...successfulStageResult(), exitCode: 1 }
        }
        fs.writeFileSync(
          path.join(stage.outputDirectory, 'stage-analysis.json'),
          JSON.stringify({ schemaVersion: 1, runs: [] }),
        )
        return successfulStageResult()
      },
      environment: { fixture: true },
      npm: { command: 'node', prefixArgs: ['npm-cli'], display: 'npm' },
    })
    assert.deepEqual(visited, ['image-preparation-ab', 'image-preparation-analysis'])
    assert.equal(result.report.ok, false)
    assert.equal(result.report.stages.length, 2)
    assert.equal(result.report.reports.imageAnalysis, 'image-preparation/stage-analysis.json')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
