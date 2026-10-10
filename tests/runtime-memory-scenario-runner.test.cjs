const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  SCENARIO_IDS,
  parseArgs,
  planScenarioMatrix,
  runScenarioMatrix,
  summarizeLifecycleWindows,
  summarizeMemorySamples,
  validateEvidence,
} = require('../scripts/run-runtime-memory-benchmark.cjs')

const sampledMemory = Object.freeze({ status: 'passed', sampleCount: 2 })

test('runtime memory plan covers every required scenario without writing artifacts', () => {
  const options = parseArgs(['--plan'], { projectRoot: process.cwd() })
  const plan = planScenarioMatrix(options, {
    nodeExecutable: 'node',
    npmExecutable: 'npm',
  })
  assert.equal(plan.writesArtifacts, false)
  assert.deepEqual(
    plan.scenarios.map((scenario) => scenario.id),
    SCENARIO_IDS,
  )
  assert.equal(
    plan.scenarios.find((scenario) => scenario.id === 'video-single').status,
    'incomplete',
  )
  assert.equal(
    plan.scenarios.find((scenario) => scenario.id === 'video-folder').status,
    'incomplete',
  )
  assert.equal(
    plan.scenarios.find((scenario) => scenario.id === 'thumbnail-matrix').status,
    'incomplete',
  )
  assert.equal(
    plan.scenarios.find((scenario) => scenario.id === 'dino-fused-shadow').status,
    'incomplete',
  )
})

test('lifecycle window gate compares matching profile repetitions instead of sawtooth slope', () => {
  const windows = []
  const samples = []
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const base = repetition * 10_000
    windows.push({
      startedAt: new Date(base).toISOString(),
      completedAt: new Date(base + 2_000).toISOString(),
      profileId: 'general',
      repetition,
    })
    samples.push(
      {
        sampledAt: new Date(base + 500).toISOString(),
        aggregate: { privateBytes: 1_000_000_000 + repetition, workingSetBytes: 900_000_000 },
      },
      {
        sampledAt: new Date(base + 1_500).toISOString(),
        aggregate: { privateBytes: 100_000_000 + repetition, workingSetBytes: 90_000_000 },
      },
    )
  }
  const summary = summarizeLifecycleWindows(samples, windows)
  assert.equal(summary.status, 'passed')
  assert.equal(summary.gate.passed, true)
  assert.equal(summary.gate.maxPeakPrivateGrowthBytes, 2)
})

test('runtime memory scenario matrix continues after failure and preserves three statuses', async () => {
  const options = parseArgs(['--scenario=cold-start,cancel', '--runs=1'], {
    projectRoot: process.cwd(),
  })
  let calls = 0
  const report = await runScenarioMatrix(options, {
    nodeExecutable: 'node',
    npmExecutable: 'npm',
    async executeCommand() {
      calls += 1
      return {
        exitCode: calls === 1 ? 2 : 0,
        durationMs: 10,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        memory: sampledMemory,
      }
    },
  })
  assert.equal(calls, 2)
  assert.equal(report.status, 'failed')
  assert.deepEqual(report.summary, { total: 2, passed: 1, failed: 1, incomplete: 0 })
  assert.deepEqual(
    report.results.map((result) => result.status),
    ['failed', 'passed'],
  )
})

test('formal matrix refuses heavy work when the accepted GPU baseline is missing', async () => {
  const options = parseArgs(['--formal', '--scenario=cold-start', '--runs=2'], {
    projectRoot: process.cwd(),
  })
  let executions = 0
  let collections = 0
  const report = await runScenarioMatrix(options, {
    resolveAcceptedGpuBaseline() {
      throw new Error('pointer missing')
    },
    async collectRuntimeMemoryPreflight() {
      collections += 1
      return {}
    },
    async executeCommand() {
      executions += 1
      throw new Error('must not execute')
    },
  })
  assert.equal(collections, 0)
  assert.equal(executions, 0)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.formalPreflights.length, 1)
  assert.equal(report.results.length, 2)
  assert.match(report.results[0].incomplete.join('\n'), /GPU baseline/)
})

test('one polluted formal preflight invalidates the whole group without starting scenarios', async () => {
  const options = parseArgs(['--formal', '--scenario=cold-start', '--runs=3'], {
    projectRoot: process.cwd(),
  })
  let executions = 0
  let collections = 0
  const report = await runScenarioMatrix(options, {
    resolveAcceptedGpuBaseline() {
      return { usedMiB: 700, reportSha256: 'a'.repeat(64) }
    },
    async collectRuntimeMemoryPreflight() {
      collections += 1
      return { sample: true }
    },
    evaluateRuntimeMemoryPreflight() {
      return { status: 'failed', failures: ['GPU was not quiet'], incomplete: [] }
    },
    async executeCommand() {
      executions += 1
      throw new Error('must not execute')
    },
  })
  assert.equal(collections, 1)
  assert.equal(executions, 0)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.results.length, 3)
  assert.ok(report.results.every((result) => result.status === 'incomplete'))
  assert.match(report.results[2].incomplete.join('\n'), /whole formal group/)
})

test('formal matrix preflights every clean round before executing it', async () => {
  const options = parseArgs(['--formal', '--scenario=cold-start', '--runs=3'], {
    projectRoot: process.cwd(),
  })
  let executions = 0
  let collections = 0
  const report = await runScenarioMatrix(options, {
    resolveAcceptedGpuBaseline() {
      return { usedMiB: 700, reportSha256: 'a'.repeat(64) }
    },
    async collectRuntimeMemoryPreflight() {
      collections += 1
      return { round: collections }
    },
    evaluateRuntimeMemoryPreflight() {
      return { status: 'passed', failures: [], incomplete: [] }
    },
    async executeCommand() {
      executions += 1
      return {
        exitCode: 0,
        durationMs: 10,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        memory: sampledMemory,
      }
    },
  })
  assert.equal(collections, 3)
  assert.equal(executions, 3)
  assert.equal(report.status, 'passed')
  assert.equal(report.formalPreflights.length, 3)
})

test('formal multi-scenario runs isolate preflight and invalidation per scenario group', async () => {
  const options = parseArgs(['--formal', '--scenario=cold-start,cancel', '--runs=2'], {
    projectRoot: process.cwd(),
  })
  let collections = 0
  let executions = 0
  const report = await runScenarioMatrix(options, {
    resolveAcceptedGpuBaseline() {
      return { usedMiB: 700, reportSha256: 'a'.repeat(64) }
    },
    async collectRuntimeMemoryPreflight() {
      collections += 1
      return { sequence: collections }
    },
    evaluateRuntimeMemoryPreflight(snapshot) {
      return snapshot.sequence === 1
        ? { status: 'failed', failures: ['first scenario polluted'], incomplete: [] }
        : { status: 'passed', failures: [], incomplete: [] }
    },
    async executeCommand() {
      executions += 1
      return {
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        memory: sampledMemory,
      }
    },
  })
  assert.equal(collections, 3)
  assert.equal(executions, 2)
  assert.deepEqual(
    report.results.map(({ id, status }) => [id, status]),
    [
      ['cold-start', 'incomplete'],
      ['cold-start', 'incomplete'],
      ['cancel', 'passed'],
      ['cancel', 'passed'],
    ],
  )
  assert.deepEqual(
    report.formalPreflights.map(({ scenarioId, round }) => [scenarioId, round]),
    [
      ['cold-start', 1],
      ['cancel', 1],
      ['cancel', 2],
    ],
  )
})

test('missing JSON fields are incomplete and a failed quality gate is failed', () => {
  const base = {
    exitCode: 0,
    durationMs: 1,
    stderr: '',
    timedOut: false,
    truncated: false,
  }
  assert.equal(
    validateEvidence('image-search-json', { ...base, stdout: JSON.stringify({ samples: 2 }) })
      .status,
    'incomplete',
  )
  const complete = {
    samples: 2,
    prewarm: { wallMs: 1 },
    exactP95Ms: 2,
    annP95Ms: 1,
    safety: { sourceFilesUnchanged: true },
    gate: { passed: false },
  }
  assert.equal(
    validateEvidence('image-search-json', { ...base, stdout: JSON.stringify(complete) }).status,
    'failed',
  )
})

test('search soak counts only fully validated attempts toward requested cycles', async () => {
  const options = parseArgs(['--scenario=search-soak', '--cycles=100'], {
    projectRoot: process.cwd(),
  })
  const report = await runScenarioMatrix(options, {
    nodeExecutable: 'node',
    npmExecutable: 'npm',
    async executeCommand() {
      return {
        exitCode: 0,
        durationMs: 5,
        stderr: '',
        timedOut: false,
        truncated: false,
        stdout: JSON.stringify({
          status: 'passed',
          requestedCycles: 100,
          completedCycles: 100,
          prewarmMs: 1,
          searchP95Ms: 1,
          stableResultDigests: true,
          safety: { sourceFilesUnchanged: true },
        }),
        memory: sampledMemory,
      }
    },
  })
  if (report.results[0]?.status === 'incomplete') {
    assert.match(report.results[0].incomplete?.[0] || '', /DINO|ANN/)
    return
  }
  assert.equal(report.results[0].status, 'passed')
  assert.equal(report.results[0].completedCycles, 100)
  assert.equal(report.results[0].attempts.length, 1)
})

test('runtime memory CLI rejects unknown scenarios and invalid counts', () => {
  assert.throws(() => parseArgs(['--scenario=unknown']), /Unknown runtime memory scenario/)
  assert.throws(() => parseArgs(['--runs=0']), /--runs/)
  assert.throws(() => parseArgs(['--cycles=10001']), /--cycles/)
  assert.throws(() => parseArgs(['--duration-min=481']), /--duration-min/)
})

test('formal matrix defaults to the full 10k thumbnail sample gate', () => {
  assert.equal(parseArgs(['--formal', '--scenario=thumbnail-matrix']).thumbnailSamples, 10_000)
  assert.equal(parseArgs(['--scenario=thumbnail-matrix']).thumbnailSamples, 8)
})

test('thumbnail matrix evidence requires exact 1/2/8 GPU variants and source safety', () => {
  const execution = {
    exitCode: 0,
    durationMs: 1,
    stderr: '',
    timedOut: false,
    truncated: false,
  }
  const report = {
    schema: 'siftory-runtime-memory-thumbnail-matrix/v1',
    status: 'passed',
    samples: 10_000,
    variants: [1, 2, 8].map((requestedJobs) => ({
      requestedJobs,
      status: 'passed',
      requestedSamples: 10_000,
      effectiveGpuJobs: requestedJobs,
      effectiveGpuLanes: Math.min(requestedJobs, 2),
      gpuCompleted: 10_000,
      cpuCompleted: 0,
      fallbackCount: 0,
      sourceUnchanged: true,
    })),
    safety: { sourceUnchanged: true, artifactBoundaryMaintained: true },
  }
  const definition = { requestedSamples: 10_000 }
  assert.equal(
    validateEvidence(
      'thumbnail-matrix-json',
      { ...execution, stdout: JSON.stringify(report) },
      definition,
    ).status,
    'passed',
  )
  report.variants[2].cpuCompleted = 1
  assert.equal(
    validateEvidence(
      'thumbnail-matrix-json',
      { ...execution, stdout: JSON.stringify(report) },
      definition,
    ).status,
    'failed',
  )
})

test('DINO fused evidence requires the exact 1000-image three-round parity matrix', () => {
  const execution = {
    exitCode: 0,
    durationMs: 1,
    stderr: '',
    timedOut: false,
    truncated: false,
  }
  const digest = 'a'.repeat(64)
  const report = {
    schema: 'siftory-dino-fused-shadow-matrix/v1',
    status: 'passed',
    config: { sample: 1_000, runs: 3 },
    parity: { scanDigest: digest, dinoDigest: digest, clipDigest: digest },
    rounds: [
      { round: 1, mode: 'baseline' },
      { round: 1, mode: 'candidate' },
      { round: 2, mode: 'candidate' },
      { round: 2, mode: 'baseline' },
      { round: 3, mode: 'baseline' },
      { round: 3, mode: 'candidate' },
    ],
    safety: {
      sourceReadOnly: true,
      isolatedUserData: true,
      noBenchmarkChildProcessesAtStop: true,
    },
    gate: { passed: true },
  }
  const definition = { requestedSamples: 1_000, requestedMatrixRuns: 3 }
  assert.equal(
    validateEvidence(
      'dino-fused-shadow-json',
      { ...execution, stdout: JSON.stringify(report) },
      definition,
    ).status,
    'passed',
  )
  report.config.sample = 999
  assert.equal(
    validateEvidence(
      'dino-fused-shadow-json',
      { ...execution, stdout: JSON.stringify(report) },
      definition,
    ).status,
    'incomplete',
  )
})

test('formal DINO evidence requires three accepted AB/BA/AB preflights', () => {
  const digest = 'a'.repeat(64)
  const report = {
    schema: 'siftory-dino-fused-shadow-matrix/v1',
    status: 'passed',
    formal: true,
    config: { sample: 1_000, runs: 3 },
    parity: { scanDigest: digest, dinoDigest: digest, clipDigest: digest },
    rounds: [
      { round: 1, mode: 'baseline' },
      { round: 1, mode: 'candidate' },
      { round: 2, mode: 'candidate' },
      { round: 2, mode: 'baseline' },
      { round: 3, mode: 'baseline' },
      { round: 3, mode: 'candidate' },
    ],
    formalPreflights: [
      { round: 1, order: ['A', 'B'] },
      { round: 2, order: ['B', 'A'] },
      { round: 3, order: ['A', 'B'] },
    ].map((entry) => ({
      ...entry,
      evaluation: { status: 'passed' },
      gpuBaseline: {
        schema: 'siftory-accepted-gpu-baseline/v1',
        reportSha256: digest,
      },
    })),
    safety: {
      sourceReadOnly: true,
      isolatedUserData: true,
      noBenchmarkChildProcessesAtStop: true,
    },
    gate: { passed: true },
  }
  const execution = {
    exitCode: 0,
    durationMs: 1,
    stderr: '',
    timedOut: false,
    truncated: false,
    stdout: JSON.stringify(report),
  }
  const definition = {
    requestedSamples: 1_000,
    requestedMatrixRuns: 3,
    formalExpected: true,
  }
  assert.equal(validateEvidence('dino-fused-shadow-json', execution, definition).status, 'passed')
  report.formalPreflights[1].evaluation.status = 'failed'
  execution.stdout = JSON.stringify(report)
  assert.equal(validateEvidence('dino-fused-shadow-json', execution, definition).status, 'failed')
})

test('formal DINO scenario delegates all paired preflights to its child matrix', async (context) => {
  const dataset = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-dino-formal-'))
  context.after(() => fs.rmSync(dataset, { force: true, recursive: true }))
  const digest = 'a'.repeat(64)
  const evidence = {
    schema: 'siftory-dino-fused-shadow-matrix/v1',
    status: 'passed',
    formal: true,
    config: { sample: 1_000, runs: 3 },
    parity: { scanDigest: digest, dinoDigest: digest, clipDigest: digest },
    rounds: [
      [1, 'baseline'],
      [1, 'candidate'],
      [2, 'candidate'],
      [2, 'baseline'],
      [3, 'baseline'],
      [3, 'candidate'],
    ].map(([round, mode]) => ({ round, mode })),
    formalPreflights: [
      [1, ['A', 'B']],
      [2, ['B', 'A']],
      [3, ['A', 'B']],
    ].map(([round, order]) => ({
      round,
      order,
      evaluation: { status: 'passed' },
      gpuBaseline: {
        schema: 'siftory-accepted-gpu-baseline/v1',
        reportSha256: digest,
      },
    })),
    safety: {
      sourceReadOnly: true,
      isolatedUserData: true,
      noBenchmarkChildProcessesAtStop: true,
    },
    gate: { passed: true },
  }
  const options = parseArgs(
    ['--formal', '--scenario=dino-fused-shadow', '--runs=1', `--dataset=${dataset}`],
    { projectRoot: process.cwd() },
  )
  let outerPreflights = 0
  const report = await runScenarioMatrix(options, {
    async collectRuntimeMemoryPreflight() {
      outerPreflights += 1
      throw new Error('outer preflight must not run')
    },
    async executeCommand() {
      return {
        exitCode: 0,
        durationMs: 1,
        stdout: JSON.stringify(evidence),
        stderr: '',
        timedOut: false,
        truncated: false,
        memory: { status: 'passed', gpu: { status: 'passed' } },
      }
    },
  })
  assert.equal(outerPreflights, 0)
  assert.equal(report.status, 'passed')
  assert.equal(report.formalPreflights.length, 3)
  assert.ok(report.formalPreflights.every((entry) => entry.scenarioId === 'dino-fused-shadow'))
})

test('explicit incomplete JSON remains incomplete even when the runner exits nonzero', () => {
  const result = validateEvidence('dino-fused-shadow-json', {
    exitCode: 2,
    durationMs: 1,
    stderr: '',
    timedOut: false,
    truncated: false,
    stdout: JSON.stringify({ status: 'incomplete', reason: 'free RAM below gate' }),
  })
  assert.equal(result.status, 'incomplete')
  assert.match(result.incomplete[0], /free RAM/)
  assert.equal(result.evidence.status, 'incomplete')
})

test('runtime memory output is absolute and confined to the managed artifact root', () => {
  const options = parseArgs([
    '--scenario=ui-churn',
    '--output-dir=artifacts/benchmark/runtime-memory/custom',
  ])
  assert.equal(path.isAbsolute(options.outputDir), true)
  assert.match(
    options.outputDir.replaceAll('\\', '/'),
    /artifacts\/benchmark\/runtime-memory\/custom$/,
  )
  assert.throws(
    () => parseArgs(['--scenario=ui-churn', '--output-dir=../outside']),
    /must stay under/,
  )
})

test('UI churn evidence requires every requested lifecycle and the final panel', () => {
  const base = {
    exitCode: 0,
    durationMs: 1,
    stderr: '',
    timedOut: false,
    truncated: false,
  }
  const report = {
    ok: true,
    snapshot: {
      lifecycleChurnCheck: {
        requestedCycles: 600,
        completedCycles: 600,
        finalPanelPresent: true,
        rendererMetrics: {
          delta: { documents: 0, jsEventListeners: 0, nodes: 0, usedHeapBytes: 0 },
        },
      },
    },
  }
  const result = validateEvidence('ui-churn-json', {
    ...base,
    stdout: JSON.stringify(report),
  })
  assert.equal(result.status, 'passed')
  assert.equal(result.completedUnits, 600)
  report.snapshot.lifecycleChurnCheck.completedCycles = 599
  assert.equal(
    validateEvidence('ui-churn-json', { ...base, stdout: JSON.stringify(report) }).status,
    'failed',
  )
})

test('memory summary keeps bounded aggregates and relative raw evidence paths', () => {
  const sample = (sequence, privateBytes, role) => ({
    schema: 'siftory-runtime-memory-sample/v1',
    sequence,
    sampledAt: new Date(sequence * 250).toISOString(),
    intervalMs: 250,
    aggregate: {
      workingSetBytes: privateBytes + 10,
      privateBytes,
      commitBytes: privateBytes + 20,
      processCount: 1,
    },
    system: { freePhysicalMemoryBytes: 1_000 - privateBytes },
    processes: [{ role, privateBytes }],
  })
  const summary = summarizeMemorySamples(
    [sample(1, 100, 'main'), sample(2, 200, 'renderer')],
    'C:\\evidence\\ui\\process-tree.jsonl',
    'C:\\evidence',
  )
  assert.equal(summary.peak.privateBytes, 200)
  assert.equal(summary.minimumFreePhysicalMemoryBytes, 800)
  assert.equal(summary.rolePeakPrivateBytes.renderer, 200)
  assert.equal(summary.rawSamples, 'ui/process-tree.jsonl')
})
