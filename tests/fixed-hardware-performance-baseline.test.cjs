'use strict'

const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  REQUIRED_RUNS,
  cleanupRoundEnvironment,
  createRoundEnvironment,
  compareAcceptedBaselineEvidence,
  evaluateBaseline,
  finalizeActiveBenchmarkProcesses,
  fingerprint,
  installSignalCleanup,
  listSystemProcesses,
  markSandboxProcessTreeUnconfirmed,
  parseArgs,
  parseWmicProcessRows,
  publishLifecycleBarrierFile,
  relativeManagedArtifactPath,
  requiresAcceptedBaselinePreflight,
  runAcceptedBaselineAdmissionPreflight,
  runMain,
  runMeasuredRound,
  runPromotionPreflight,
  terminateProcessTreeAndConfirm,
  validateOrchestratorStartupEnvironment,
  waitForLifecycleReady,
  withFailClosedManagedRunWorkspace,
} = require('../scripts/run-fixed-hardware-performance-baseline.cjs')
const {
  publishLifecycleBarrierFile: publishBenchmarkLifecycleBarrierFile,
  readLifecycleBarrierFile,
} = require('./image-search-simple-e2e-benchmark.cjs')

const FORMAL_SAMPLE = 1000
const TIMELINE_MAX_BYTES = 8 * 1024 * 1024
const TIMELINE_MAX_EVENTS = 50_000

function repeatedHash(character) {
  return character.repeat(64)
}

function fixedConfig(sample = FORMAL_SAMPLE) {
  return {
    sample,
    runs: REQUIRED_RUNS,
    pipeline: 'overlap',
    backend: 'gpu',
    jobs: 2,
    batchSize: 4,
    requestedScanWorkers: 2,
    tensorPrefetch: false,
    deferThumbnails: true,
    verifyWarm: true,
    stageMetrics: true,
    timelineMaxBytes: TIMELINE_MAX_BYTES,
    timelineMaxEvents: TIMELINE_MAX_EVENTS,
  }
}

function roundTimes(round) {
  const parentStart = Date.parse('2026-08-25T00:00:00.000Z') + (round - 1) * 60_000
  const parentFinish = parentStart + 30_000
  return {
    parentStartedAt: new Date(parentStart).toISOString(),
    childStartedAt: new Date(parentStart + 100).toISOString(),
    childFinishedAt: new Date(parentFinish - 100).toISOString(),
    parentFinishedAt: new Date(parentFinish).toISOString(),
  }
}

function roundIdentity(round) {
  return {
    nonce: `fixed_round_nonce_${String(round).padStart(4, '0')}`,
    tempDirectoryId: `fixed-round-temp-${round}`,
    reportSha256: repeatedHash(String(round)),
  }
}

function fakeRun(round, overrides = {}) {
  const sample = overrides.sample ?? FORMAL_SAMPLE
  const ready = overrides.ready ?? 100_000 + round * 500
  const main = overrides.main ?? 700 + round
  const child = overrides.child ?? 2_100 + round * 5
  const times = roundTimes(round)
  const identity = roundIdentity(round)
  return {
    schemaVersion: 1,
    ok: true,
    config: {
      imageCount: sample,
      sourceImageCount: sample,
      pipeline: 'overlap',
      backend: 'gpu',
      jobs: 2,
      batchSize: 4,
      requestedScanWorkers: 2,
      tensorPrefetch: false,
      deferThumbnails: true,
      verifyWarm: true,
      stageMetrics: true,
      timelineMaxBytes: TIMELINE_MAX_BYTES,
      timelineMaxEvents: TIMELINE_MAX_EVENTS,
    },
    phases: { libraryReadyMs: ready, totalMs: ready + 10_000 },
    scan: {
      digest: { count: sample, sha256: repeatedHash('a') },
      progress: { scanWorkerCount: 2 },
    },
    embeddingDigests: {
      dino: { count: sample, stableSha256: repeatedHash('b') },
      clip: { count: sample, stableSha256: repeatedHash('c') },
    },
    vectorIndex: { status: { built: true, count: sample, dim: 768 } },
    pipeline: { result: { commitFeedDropped: 0 } },
    providerEvidence: {
      dino: {
        schemaVersion: 1,
        model: 'dino',
        requestedBackends: ['gpu'],
        selectedProviders: ['dml'],
        fallbackDetected: false,
        reports: 2,
        reasons: ['session-created'],
      },
      clip: {
        schemaVersion: 1,
        model: 'clip',
        requestedBackends: ['gpu'],
        selectedProviders: ['dml'],
        fallbackDetected: false,
        reports: 2,
        reasons: ['session-created'],
      },
    },
    warmVerification: { ok: true },
    execution: {
      runNonce: identity.nonce,
      tempDirectoryId: identity.tempDirectoryId,
      startedAt: times.childStartedAt,
      finishedAt: times.childFinishedAt,
      durationMs: 29_800,
    },
    safety: {
      sourceDatasetReadOnly: true,
      isolatedUserData: true,
      sourceUnchanged: true,
      noBenchmarkChildProcessesAtStop: true,
      sourceSnapshot: { count: sample },
      tempDirectoryId: identity.tempDirectoryId,
    },
    resources: {
      sampling: {
        errors: 0,
        failureCode: null,
        samples: 10,
        sampleCount: 10,
        observedChildProcesses: 3,
        observedChildEvidence: {
          lifecycleTracked: 3,
          samplerObserved: 3,
          lifecycleAccounted: true,
        },
      },
      processes: {
        spawned: 3,
        observedChildProcesses: 3,
        activeAtStop: 0,
        noResidualAtStop: true,
        lifecycleAccounted: true,
      },
      memory: {
        mainPeakRssMiB: main,
        childPeakAggregateRssMiBApprox: child,
        systemMinFreeMiB: overrides.free ?? 900 - round * 10,
      },
      gpu: { deviceCount: 1, totalMiB: 12_288, peakDeltaUsedMiB: 512 + round },
    },
    timeline: {
      eventsWritten: 8,
      bytesWritten: 1024,
      maxBytes: TIMELINE_MAX_BYTES,
      maxEvents: TIMELINE_MAX_EVENTS,
      truncated: false,
      terminalEventWritten: true,
    },
  }
}

function fakeRoundProof(round) {
  const times = roundTimes(round)
  const identity = roundIdentity(round)
  return {
    runNonce: identity.nonce,
    startedAt: times.parentStartedAt,
    finishedAt: times.parentFinishedAt,
    reportBytes: 4096 + round,
    reportSha256: identity.reportSha256,
    timelineBytes: 1024,
    timelineSha256: repeatedHash(String(9 - round)),
    timeline: {
      bytes: 1024,
      sha256: repeatedHash(String(9 - round)),
      events: 8,
      truncated: false,
    },
    timedOut: false,
    termination: null,
    sandbox: {
      environmentPolicy: 'minimal-allowlist-v1',
      networkModelFetchDisabled: true,
      nodeOptionsCleared: true,
      nodeInheritedOverridesDropped: true,
      systemFontsDisabled: true,
      performanceOverridesCleared: true,
      fixedHarnessOverrides: { scanWorkers: 2 },
    },
  }
}

function evaluationInput(overrides = {}) {
  const config = fixedConfig()
  const hardware = {
    id: 'hardware-a',
    totalMemoryBytes: 16 * 1024 * 1024 * 1024,
    gpus: [{ uuid: 'gpu-a' }],
  }
  return {
    runs: [fakeRun(1), fakeRun(2), fakeRun(3)],
    roundProofs: [fakeRoundProof(1), fakeRoundProof(2), fakeRoundProof(3)],
    config,
    hardware,
    hardwareBeforeId: hardware.id,
    hardwareAfterId: hardware.id,
    datasetUnchanged: true,
    datasetIdentity: 'dataset-a',
    sourceUnchanged: true,
    userDataUnchanged: true,
    evidenceStabilityFailures: [],
    acceptedEvidenceFailures: [],
    mode: 'establish',
    baseline: null,
    baselinePath: null,
    ...overrides,
  }
}

function acceptedBaseline(input, controlLimits) {
  return {
    schemaVersion: 1,
    kind: 'fixed-hardware-first-build-baseline',
    hardware: { id: input.hardware.id },
    dataset: { identity: input.datasetIdentity },
    config: input.config,
    controlLimits,
  }
}

function cleanNodeStartupEnvironment(environment = process.env) {
  const forbidden = new Set([
    'node_options',
    'node_path',
    'node_compile_cache',
    'node_v8_coverage',
    'node_debug',
    'node_debug_native',
    'node_redirect_warnings',
    'node_icu_data',
    'node_extra_ca_certs',
  ])
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !forbidden.has(key.toLowerCase())),
  )
}

test('formal runs require 1000 samples while diagnostic runs allow a smaller sample', () => {
  const projectRoot = path.resolve('C:/tmp/siftory-test-root')
  const baselineRoot = path.join(projectRoot, 'artifacts', 'benchmark', 'fixed')
  const dependencies = {
    projectRoot,
    baselineRoot,
    now: new Date('2026-08-25T00:00:00.000Z'),
  }

  assert.throws(
    () => parseArgs(['--sample=999', '--establish'], dependencies),
    /Formal establish\/compare runs require --sample=1000/,
  )
  assert.throws(
    () => parseArgs(['--sample=4'], dependencies),
    /Formal establish\/compare runs require --sample=1000/,
  )
  for (const argument of ['--backend=cpu', '--jobs=1', '--batch-size=1']) {
    assert.throws(
      () => parseArgs(['--establish', argument], dependencies),
      /Formal establish\/compare runs require --backend=gpu --jobs=2 --batch-size=4/,
      argument,
    )
    assert.throws(
      () => parseArgs([argument], dependencies),
      /Formal establish\/compare runs require --backend=gpu --jobs=2 --batch-size=4/,
      argument,
    )
  }

  const diagnostic = parseArgs(
    ['--sample=4', '--backend=cpu', '--jobs=1', '--batch-size=1', '--diagnostic'],
    dependencies,
  )
  assert.equal(diagnostic.sample, 4)
  assert.equal(diagnostic.runs, 3)
  assert.equal(diagnostic.mode, 'diagnostic')
  assert.equal(diagnostic.backend, 'cpu')
  assert.equal(diagnostic.jobs, 1)
  assert.equal(diagnostic.batchSize, 1)
  assert.match(diagnostic.outputDirectory, /fixed[\\/]2026-08-25_00-00-00-000$/)

  const promotion = parseArgs(['--promote'], dependencies)
  assert.equal(promotion.mode, 'promote')
  assert.equal(promotion.promote, true)
  assert.throws(() => parseArgs(['--promote', '--establish'], dependencies), /mutually exclusive/)

  assert.throws(
    () => parseArgs(['--runs=2'], { projectRoot, baselineRoot }),
    /Unknown fixed-hardware baseline argument/,
  )
  assert.throws(
    () => parseArgs(['--output-dir=C:/tmp/escape'], { projectRoot, baselineRoot }),
    /must be a child/,
  )

  for (const relativeOutput of [
    'latest.json',
    path.join('LATEST.JSON', 'nested'),
    '.fixed-hardware-baseline.lock',
    path.join('.fixed-hardware-baseline-internal', 'nested'),
  ]) {
    const outputDirectory = path.join(baselineRoot, relativeOutput)
    assert.throws(
      () =>
        parseArgs(['--sample=4', '--diagnostic', '--output-dir=' + outputDirectory], dependencies),
      /conflicts with a managed baseline internal name/,
      relativeOutput,
    )
  }
})

test('promotion preflight binds the immutable GPU baseline to the formal evaluation', async () => {
  const snapshot = { kind: 'snapshot' }
  const calls = []
  const result = await runPromotionPreflight(
    { projectRoot: process.cwd() },
    {
      resolveAcceptedGpuBaseline(options) {
        calls.push(['resolve', options.projectRoot])
        return { schema: 'siftory-accepted-gpu-baseline/v1', usedMiB: 1060 }
      },
      async collectRuntimeMemoryPreflight(options) {
        calls.push(['collect', options.cwd])
        return snapshot
      },
      evaluateRuntimeMemoryPreflight(value, options) {
        calls.push(['evaluate', value, options])
        return { status: 'passed', formal: true }
      },
    },
  )
  assert.equal(result.snapshot, snapshot)
  assert.equal(result.gpuBaseline.usedMiB, 1060)
  assert.deepEqual(calls.at(-1), ['evaluate', snapshot, { formal: true, gpuBaselineUsedMiB: 1060 }])
})

test('compare and promote reject resource pressure before evidence capture and still preflight every round', async () => {
  const snapshot = { kind: 'admission-snapshot' }
  const calls = []
  const result = await runAcceptedBaselineAdmissionPreflight(
    { projectRoot: process.cwd() },
    {
      resolveAcceptedGpuBaseline(options) {
        calls.push(['resolve', options.projectRoot])
        return { schema: 'siftory-accepted-gpu-baseline/v1', usedMiB: 1060 }
      },
      async collectRuntimeMemoryPreflight(options) {
        calls.push(['collect', options])
        return snapshot
      },
      evaluateRuntimeMemoryPreflight(value, options) {
        calls.push(['evaluate', value, options])
        return { status: 'failed', formal: false, failures: ['free physical memory is below 4 GiB'] }
      },
    },
  )
  assert.equal(result.evaluation.status, 'failed')
  assert.deepEqual(calls[1], [
    'collect',
    { cwd: process.cwd(), durationMs: 0, intervalMs: 1_000 },
  ])
  assert.deepEqual(calls[2], [
    'evaluate',
    snapshot,
    { formal: false, gpuBaselineUsedMiB: 1060 },
  ])
  assert.equal(requiresAcceptedBaselinePreflight('compare'), true)
  assert.equal(requiresAcceptedBaselinePreflight('promote'), true)
  assert.equal(requiresAcceptedBaselinePreflight('establish'), false)
  assert.equal(requiresAcceptedBaselinePreflight('diagnostic'), false)

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'run-fixed-hardware-performance-baseline.cjs'),
    'utf8',
  )
  assert.ok(source.indexOf("'[fixed-baseline] admission preflight started\\n'") >= 0)
  assert.ok(
    source.indexOf("'[fixed-baseline] admission preflight started\\n'") <
      source.indexOf("'[fixed-baseline] freezing dataset/runtime evidence\\n'"),
  )
  assert.match(
    source,
    /if \(requiresAcceptedBaselinePreflight\(options\.mode\)\) \{[\s\S]*?formal preflight [\s\S]*?runPromotionPreflight/,
  )
})

test('formal child report keeps aggregate embedding proofs without raw vector duplication', () => {
  const childSource = fs.readFileSync(
    path.join(__dirname, 'image-search-simple-e2e-benchmark.cjs'),
    'utf8',
  )
  assert.match(childSource, /report\.embeddingDigests\s*=\s*\{/)
  assert.doesNotMatch(childSource, /report\.embeddingComparison\s*=/)
  assert.doesNotMatch(childSource, /vector:\s*entry\.vector/)
})

test('first establish treats the empty accepted-baseline envelope as no prior evidence', () => {
  assert.deepEqual(
    compareAcceptedBaselineEvidence(
      {
        mode: 'establish',
        pointer: null,
        reportPath: null,
        report: null,
      },
      { schemaVersion: 1 },
    ),
    { ok: true, failures: [], implementation: null },
  )
})

test('generated round artifact declarations are relative to the managed baseline root', () => {
  const managedRoot = path.resolve('artifacts', 'benchmark', 'fixed-hardware-first-build')
  const roundPath = path.join(managedRoot, 'baseline-20260826-final', 'round-1.json')
  assert.equal(
    relativeManagedArtifactPath(managedRoot, roundPath),
    'baseline-20260826-final/round-1.json',
  )
  assert.throws(
    () => relativeManagedArtifactPath(managedRoot, path.resolve('outside', 'round-1.json')),
    /must remain inside the managed baseline root/,
  )
})

test('orchestrator startup rejects ambient Node controls before parsing any mode', async () => {
  for (const [key, canonicalKey] of [
    ['node_options', 'NODE_OPTIONS'],
    ['NoDe_PaTh', 'NODE_PATH'],
    ['NODE_COMPILE_CACHE', 'NODE_COMPILE_CACHE'],
    ['node_v8_coverage', 'NODE_V8_COVERAGE'],
    ['NoDe_DeBuG', 'NODE_DEBUG'],
    ['node_debug_native', 'NODE_DEBUG_NATIVE'],
    ['NODE_REDIRECT_WARNINGS', 'NODE_REDIRECT_WARNINGS'],
    ['node_icu_data', 'NODE_ICU_DATA'],
    ['NoDe_ExTrA_Ca_CeRtS', 'NODE_EXTRA_CA_CERTS'],
  ]) {
    assert.throws(
      () =>
        validateOrchestratorStartupEnvironment({
          environment: { [key]: 'untrusted' },
          execArgv: [],
        }),
      new RegExp(canonicalKey),
      key,
    )
  }
  assert.equal(
    validateOrchestratorStartupEnvironment({
      environment: {
        node_options: '',
        NODE_PATH: '',
        node_compile_cache: '',
        NODE_V8_COVERAGE: '',
        NODE_DEBUG: '',
        node_debug_native: '',
        NODE_REDIRECT_WARNINGS: '',
        node_icu_data: '',
        NODE_EXTRA_CA_CERTS: '',
      },
      execArgv: [],
    }),
    true,
  )
  assert.throws(
    () => validateOrchestratorStartupEnvironment({ environment: {}, execArgv: ['--inspect=0'] }),
    /empty process\.execArgv/,
  )
  await assert.rejects(
    runMain({
      argv: ['--not-a-real-option'],
      environment: { nOdE_pAtH: 'C:\\untrusted-modules' },
      execArgv: [],
    }),
    /NODE_PATH/,
  )
})

test('formal plan reports the immutable GPU execution tuple without writing artifacts', async (t) => {
  const dataset = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-plan-dataset-'))
  t.after(() => fs.rmSync(dataset, { recursive: true, force: true }))
  const managedParent = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-plan-managed-'))
  t.after(() => fs.rmSync(managedParent, { recursive: true, force: true }))
  const baselineRoot = path.join(managedParent, 'fixed-hardware-first-build')
  const outputDirectory = path.join(baselineRoot, `plan-test-${process.pid}-${Date.now()}`)
  const writes = []
  const originalWrite = process.stdout.write
  process.stdout.write = (value) => {
    writes.push(String(value))
    return true
  }
  try {
    await runMain({
      argv: ['--plan', '--establish', `--dataset=${dataset}`, `--output-dir=${outputDirectory}`],
      baselineRoot,
      environment: cleanNodeStartupEnvironment(),
      execArgv: [],
    })
  } finally {
    process.stdout.write = originalWrite
  }
  const plan = JSON.parse(writes.join(''))
  assert.equal(plan.ok, true)
  assert.equal(plan.mode, 'establish')
  assert.equal(plan.writesArtifacts, false)
  assert.equal(plan.config.sample, 1000)
  assert.equal(plan.config.backend, 'gpu')
  assert.equal(plan.config.jobs, 2)
  assert.equal(plan.config.batchSize, 4)
  assert.equal(fs.existsSync(outputDirectory), false)
})

test('CLI plan fails closed before output when NODE_OPTIONS is inherited', (t) => {
  const dataset = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-plan-polluted-dataset-'))
  t.after(() => fs.rmSync(dataset, { recursive: true, force: true }))
  const script = path.resolve(
    __dirname,
    '..',
    'scripts',
    'run-fixed-hardware-performance-baseline.cjs',
  )
  const outputDirectory = path.resolve(
    __dirname,
    '..',
    'artifacts',
    'benchmark',
    'fixed-hardware-first-build',
    `polluted-plan-test-${process.pid}-${Date.now()}`,
  )
  const result = spawnSync(
    process.execPath,
    [script, '--plan', '--establish', `--dataset=${dataset}`, `--output-dir=${outputDirectory}`],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 30_000,
      env: { ...cleanNodeStartupEnvironment(), NoDe_OpTiOnS: '--no-warnings' },
    },
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /NODE_OPTIONS/)
  assert.equal(result.stdout, '')
  assert.equal(fs.existsSync(outputDirectory), false)
})

test('round environment uses a short exclusive temp sandbox and cleans only that sandbox', () => {
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-baseline-parent-'))
  try {
    const roundEnvironment = createRoundEnvironment(
      {
        outputDirectory: path.join(tempParent, 'intentionally-long-artifact-output'),
        sandboxTempRoot: tempParent,
        baseEnvironment: {
          SAFE_VALUE: 'retained',
          Path: 'C:\\untrusted-path',
          path: 'C:\\second-untrusted-path',
          pathext: '.UNTRUSTED',
          systemroot: 'C:\\untrusted-windows',
          windir: 'C:\\untrusted-windows',
          comspec: 'C:\\untrusted\\cmd.exe',
          psmodulepath: 'C:\\untrusted-modules',
          node_options: '--require=C:\\untrusted\\hook.cjs',
          node_path: 'C:\\untrusted-node-modules',
          Node_Compile_Cache: 'C:\\untrusted-node-cache',
          Node_Disable_Compile_Cache: '0',
          node_v8_coverage: 'C:\\untrusted-coverage',
          node_debug: 'module',
          node_debug_native: 'http',
          node_redirect_warnings: 'C:\\untrusted-warnings.log',
          node_icu_data: 'C:\\untrusted-icu',
          node_extra_ca_certs: 'C:\\untrusted-ca.pem',
          disable_system_fonts_load: '0',
          VIPS_CONCURRENCY: '99',
          ORT_NUM_THREADS: '99',
          ONNX_RUNTIME_LOG_LEVEL: 'verbose',
          OPENBLAS_NUM_THREADS: '99',
          MKL_NUM_THREADS: '99',
          OMP_WAIT_POLICY: 'active',
          CUDA_VISIBLE_DEVICES: '0',
          CUDA_MODULE_LOADING: 'lazy',
          CUDNN_LOGLEVEL_DBG: '3',
          CUBLAS_WORKSPACE_CONFIG: ':4096:8',
          NAPI_RS_NATIVE_LIBRARY_PATH: 'C:\\untrusted\\canvas.node',
          NAPI_RS_FORCE_WASI: '1',
          REASONIX_NATIVE_SCAN_WORKERS: '99',
        },
        platform: 'win32',
        fixedWindowsEnvironment: {
          SystemRoot: 'C:\\Windows',
          WINDIR: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          PATH: 'C:\\Windows\\System32;C:\\Windows',
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
          PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
          ProgramFiles: 'C:\\Program Files',
          ProgramW6432: 'C:\\Program Files',
        },
      },
      1,
    )
    assert.equal(path.dirname(roundEnvironment.rootPath), fs.realpathSync(tempParent))
    assert.match(path.basename(roundEnvironment.rootPath), /^siftory-fixed-baseline-r1-/)
    assert.equal(roundEnvironment.proof.rootScope, 'exclusive-os-temp')
    assert.equal(roundEnvironment.proof.rootPathOmitted, true)
    assert.equal(roundEnvironment.proof.variables.temp, 'temp')
    assert.equal(fs.existsSync(roundEnvironment.rootPath), true)
    assert.equal(roundEnvironment.environment.SAFE_VALUE, undefined)
    assert.equal(roundEnvironment.proof.environmentPolicy, 'minimal-allowlist-v1')
    assert.ok(roundEnvironment.proof.droppedInheritedKeys.includes('SAFE_VALUE'))
    for (const key of [
      'VIPS_CONCURRENCY',
      'ORT_NUM_THREADS',
      'ONNX_RUNTIME_LOG_LEVEL',
      'OPENBLAS_NUM_THREADS',
      'MKL_NUM_THREADS',
      'OMP_WAIT_POLICY',
      'CUDA_VISIBLE_DEVICES',
      'CUDA_MODULE_LOADING',
      'CUDNN_LOGLEVEL_DBG',
      'CUBLAS_WORKSPACE_CONFIG',
      'NAPI_RS_NATIVE_LIBRARY_PATH',
      'NAPI_RS_FORCE_WASI',
      'REASONIX_NATIVE_SCAN_WORKERS',
    ]) {
      assert.equal(roundEnvironment.environment[key], undefined, key)
      assert.ok(roundEnvironment.proof.clearedPerformanceOverrides.includes(key), key)
    }
    assert.deepEqual(roundEnvironment.proof.performanceOverrideFamilies, [
      'application-native-embedding',
      'libvips',
      'onnxruntime',
      'blas-mkl-openmp',
      'cuda-cudnn-cublas',
      'napi-rs-canvas-loader',
    ])
    assert.equal(roundEnvironment.proof.effectiveEnvironment.NAPI_RS_NATIVE_LIBRARY_PATH, null)
    assert.equal(roundEnvironment.proof.effectiveEnvironment.NAPI_RS_FORCE_WASI, null)
    for (const key of [
      'PATH',
      'PATHEXT',
      'SystemRoot',
      'WINDIR',
      'ComSpec',
      'PSModulePath',
      'ProgramFiles',
      'ProgramW6432',
    ]) {
      assert.equal(
        Object.keys(roundEnvironment.environment).filter(
          (candidate) => candidate.toLowerCase() === key.toLowerCase(),
        ).length,
        1,
        key,
      )
      assert.equal(
        roundEnvironment.proof.effectiveEnvironment[key],
        roundEnvironment.environment[key],
        key,
      )
    }
    for (const key of ['NODE_PATH', 'NODE_COMPILE_CACHE']) {
      assert.equal(
        Object.keys(roundEnvironment.environment).some(
          (candidate) => candidate.toLowerCase() === key.toLowerCase(),
        ),
        false,
        key,
      )
    }
    for (const key of [
      'NODE_V8_COVERAGE',
      'NODE_DEBUG',
      'NODE_DEBUG_NATIVE',
      'NODE_REDIRECT_WARNINGS',
      'NODE_ICU_DATA',
      'NODE_EXTRA_CA_CERTS',
    ]) {
      assert.equal(
        Object.keys(roundEnvironment.environment).some(
          (candidate) => candidate.toLowerCase() === key.toLowerCase(),
        ),
        false,
        key,
      )
      assert.equal(roundEnvironment.proof.effectiveEnvironment[key], null, key)
    }
    assert.equal(roundEnvironment.environment.NODE_OPTIONS, '')
    assert.equal(roundEnvironment.environment.NODE_DISABLE_COMPILE_CACHE, '1')
    assert.equal(roundEnvironment.environment.DISABLE_SYSTEM_FONTS_LOAD, '1')
    assert.equal(roundEnvironment.proof.systemFontsDisabled, true)
    assert.equal(roundEnvironment.proof.effectiveEnvironment.DISABLE_SYSTEM_FONTS_LOAD, '1')
    for (const key of ['NODE_OPTIONS', 'NODE_DISABLE_COMPILE_CACHE', 'DISABLE_SYSTEM_FONTS_LOAD']) {
      assert.equal(
        Object.keys(roundEnvironment.environment).filter(
          (candidate) => candidate.toLowerCase() === key.toLowerCase(),
        ).length,
        1,
        key,
      )
    }

    cleanupRoundEnvironment(roundEnvironment)
    assert.equal(fs.existsSync(roundEnvironment.rootPath), false)
    assert.throws(
      () => cleanupRoundEnvironment({ rootPath: tempParent, tempParent }),
      /outside its temporary parent/,
    )
  } finally {
    fs.rmdirSync(tempParent)
  }
})

test('sandbox cleanup stays fail-closed until process-tree shutdown is confirmed', () => {
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-baseline-blocked-'))
  try {
    const roundEnvironment = createRoundEnvironment(
      { sandboxTempRoot: tempParent, baseEnvironment: {} },
      1,
    )
    markSandboxProcessTreeUnconfirmed(roundEnvironment)
    assert.throws(
      () => cleanupRoundEnvironment(roundEnvironment),
      /process tree is not confirmed stopped/,
    )
    assert.equal(fs.existsSync(roundEnvironment.rootPath), true)

    cleanupRoundEnvironment(roundEnvironment, { processTreeConfirmed: true })
    assert.equal(fs.existsSync(roundEnvironment.rootPath), false)
  } finally {
    fs.rmdirSync(tempParent)
  }
})

test('round sandbox initialization failure removes its exact registered mkdtemp', () => {
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-'))
  const failingEnvironment = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('fixture environment assembly failed')
      },
    },
  )
  try {
    assert.throws(
      () =>
        createRoundEnvironment(
          { sandboxTempRoot: tempParent, baseEnvironment: failingEnvironment },
          1,
        ),
      /fixture environment assembly failed/,
    )
    assert.deepEqual(fs.readdirSync(tempParent), [])
  } finally {
    fs.rmdirSync(tempParent)
  }
})

test('WMIC value-list parsing is strict and accepts native CR-CR-LF output', () => {
  const text =
    'ParentProcessId=0\r\r\nProcessId=4\r\r\n\r\r\n' +
    'ParentProcessId=4\r\r\nProcessId=4200\r\r\n\r\r\n'
  assert.deepEqual(parseWmicProcessRows(text), [
    { parentPid: 0, pid: 4 },
    { parentPid: 4, pid: 4200 },
  ])
  for (const malformed of [
    '',
    'ParentProcessId=4\r\r\n',
    'ParentProcessId=4\r\r\nProcessId=abc\r\r\n',
    'ParentProcessId=4\r\r\nProcessId=5\r\r\nUnexpected=1\r\r\n',
    'ParentProcessId=4\r\r\nProcessId=5\r\r\n\r\r\nParentProcessId=6\r\r\nProcessId=5\r\r\n',
  ]) {
    assert.throws(() => parseWmicProcessRows(malformed), /WMIC process table/)
  }
})

test('Windows process inspection uses the absolute WMIC path and exact controlled environment', () => {
  const systemEnvironment = Object.freeze({
    SystemRoot: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATH: 'C:\\Windows\\System32',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    ProgramFiles: 'C:\\Program Files',
    ProgramW6432: 'C:\\Program Files',
  })
  const rows = listSystemProcesses({
    platform: 'win32',
    systemTools: {
      systemRoot: 'C:\\Windows',
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
      wmic: 'C:\\Windows\\System32\\Wbem\\WMIC.exe',
    },
    systemEnvironment,
    spawnSyncFn(command, args, options) {
      assert.equal(command, 'C:\\Windows\\System32\\Wbem\\WMIC.exe')
      assert.equal(path.win32.isAbsolute(command), true)
      assert.deepEqual(args, ['process', 'get', 'ParentProcessId,ProcessId', '/VALUE'])
      assert.equal(options.shell, false)
      assert.equal(options.env, systemEnvironment)
      return {
        status: 0,
        stdout: 'ParentProcessId=0\r\r\nProcessId=4\r\r\n',
      }
    },
  })
  assert.deepEqual(rows, [{ parentPid: 0, pid: 4 }])
})

test('process-tree termination confirms a successful full-tree disappearance', async () => {
  const child = new EventEmitter()
  child.pid = 4100
  let processTableReads = 0
  let taskkillCalls = 0

  const evidence = await terminateProcessTreeAndConfirm(child, {
    platform: 'win32',
    timeoutMs: 100,
    pollIntervalMs: 10,
    listProcesses() {
      processTableReads += 1
      return processTableReads === 1
        ? [
            { pid: 4100, parentPid: 1 },
            { pid: 4101, parentPid: 4100 },
          ]
        : []
    },
    spawnSyncFn(command, args, options) {
      taskkillCalls += 1
      assert.equal(path.win32.basename(command).toLowerCase(), 'taskkill.exe')
      assert.equal(path.win32.isAbsolute(command), true)
      assert.deepEqual(args, ['/pid', '4100', '/T', '/F'])
      assert.equal(options.shell, false)
      return { status: 0, signal: null }
    },
  })

  assert.equal(evidence.safeToCleanup, true)
  assert.equal(evidence.confirmedBy, 'process-tree-absent')
  assert.equal(evidence.observedProcessCount, 2)
  assert.equal(evidence.remainingProcessCount, 0)
  assert.equal(evidence.termination.succeeded, true)
  assert.equal(taskkillCalls, 1)
})

test('process-tree termination reports residual descendants and fails closed', async () => {
  const child = new EventEmitter()
  child.pid = 4200
  const evidence = await terminateProcessTreeAndConfirm(child, {
    platform: 'win32',
    timeoutMs: 30,
    pollIntervalMs: 10,
    listProcesses() {
      return [
        { pid: 4200, parentPid: 1 },
        { pid: 4201, parentPid: 4200 },
      ]
    },
    spawnSyncFn() {
      return { status: 1, signal: null }
    },
  })

  assert.equal(evidence.safeToCleanup, false)
  assert.equal(evidence.confirmedBy, null)
  assert.equal(evidence.remainingProcessCount, 2)
  assert.equal(evidence.termination.succeeded, false)
})

test('parent close does not hide a still-running observed descendant', async () => {
  const child = new EventEmitter()
  child.pid = 4250
  let processTableReads = 0
  const evidence = await terminateProcessTreeAndConfirm(child, {
    platform: 'win32',
    timeoutMs: 30,
    pollIntervalMs: 10,
    listProcesses() {
      processTableReads += 1
      return processTableReads === 1
        ? [
            { pid: 4250, parentPid: 1 },
            { pid: 4251, parentPid: 4250 },
          ]
        : [{ pid: 4251, parentPid: 1 }]
    },
    spawnSyncFn() {
      child.emit('close', 1, null)
      return { status: 0, signal: null }
    },
  })

  assert.equal(evidence.parentCloseReceived, true)
  assert.equal(evidence.descendantCaptureComplete, true)
  assert.equal(evidence.safeToCleanup, false)
  assert.equal(evidence.remainingProcessCount, 1)
})

test('parent close is safe only after the captured whole tree disappears', async () => {
  const child = new EventEmitter()
  child.pid = 4260
  let processTableReads = 0
  const evidence = await terminateProcessTreeAndConfirm(child, {
    platform: 'win32',
    timeoutMs: 100,
    pollIntervalMs: 10,
    listProcesses() {
      processTableReads += 1
      return processTableReads === 1
        ? [
            { pid: 4260, parentPid: 1 },
            { pid: 4261, parentPid: 4260 },
          ]
        : []
    },
    spawnSyncFn() {
      child.emit('close', 0, null)
      return { status: 0, signal: null }
    },
  })

  assert.equal(evidence.parentCloseReceived, true)
  assert.equal(evidence.safeToCleanup, true)
  assert.equal(evidence.confirmedBy, 'close-and-process-tree-absent')
  assert.equal(evidence.remainingProcessCount, 0)
})

test('parent close remains fail-closed when descendant process-table verification fails', async () => {
  const child = new EventEmitter()
  child.pid = 4270
  let processTableReads = 0
  const evidence = await terminateProcessTreeAndConfirm(child, {
    platform: 'win32',
    timeoutMs: 30,
    pollIntervalMs: 10,
    listProcesses() {
      processTableReads += 1
      if (processTableReads === 1) {
        return [
          { pid: 4270, parentPid: 1 },
          { pid: 4271, parentPid: 4270 },
        ]
      }
      throw new Error('fixture process table unavailable')
    },
    spawnSyncFn() {
      child.emit('close', 0, null)
      return { status: 0, signal: null }
    },
  })

  assert.equal(evidence.parentCloseReceived, true)
  assert.equal(evidence.safeToCleanup, false)
  assert.equal(evidence.remainingProcessCount, 2)
  assert.match(evidence.queryError, /process table unavailable/)
})

test('successful managed workspace callback releases its lock', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sbw-'))
  const managedRoot = path.join(fixtureRoot, 'm')
  const dataset = path.join(fixtureRoot, 'd')
  const outputDirectory = path.join(managedRoot, 'r')
  fs.mkdirSync(managedRoot)
  fs.mkdirSync(dataset)
  try {
    const result = await withFailClosedManagedRunWorkspace(
      { managedRoot, dataset, outputDirectory, token: 'success-token' },
      async (workspace) => {
        assert.equal(workspace.outputDirectory, fs.realpathSync(outputDirectory))
        return 'completed'
      },
    )
    assert.equal(result, 'completed')
    assert.equal(fs.existsSync(path.join(managedRoot, '.fixed-hardware-baseline.lock')), false)
    assert.equal(fs.existsSync(outputDirectory), true)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('synchronous child spawn failure cleans the exact sandbox and preserves the original error', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'))
  const managedRoot = path.join(fixtureRoot, 'm')
  const dataset = path.join(fixtureRoot, 'd')
  const sandboxTempRoot = path.join(fixtureRoot, 's')
  const outputDirectory = path.join(managedRoot, 'r')
  fs.mkdirSync(managedRoot)
  fs.mkdirSync(dataset)
  fs.mkdirSync(sandboxTempRoot)
  try {
    await assert.rejects(
      withFailClosedManagedRunWorkspace(
        { managedRoot, dataset, outputDirectory, token: 'spawn-failure-token' },
        async (workspace) =>
          runMeasuredRound(
            {
              projectRoot: fixtureRoot,
              dataset,
              outputDirectory: workspace.outputDirectory,
              sandboxTempRoot,
              baseEnvironment: {},
              sample: 4,
              backend: 'cpu',
              jobs: 1,
              batchSize: 1,
              timeoutMs: 60_000,
              runtime: {
                spawn() {
                  throw new Error('fixture synchronous spawn failure')
                },
              },
            },
            1,
          ),
      ),
      /fixture synchronous spawn failure/,
    )
    assert.deepEqual(fs.readdirSync(sandboxTempRoot), [])
    assert.equal(fs.existsSync(path.join(managedRoot, '.fixed-hardware-baseline.lock')), false)
    assert.equal(fs.existsSync(outputDirectory), true)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('lifecycle barriers publish complete files atomically across the real process boundary', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-'))
  const readyPath = path.join(fixtureRoot, 'lifecycle-ready.json')
  const releasePath = path.join(fixtureRoot, 'lifecycle-release.json')
  const stagingSignalPath = path.join(fixtureRoot, 'ready-staging-complete.txt')
  const benchmarkModule = path.join(__dirname, 'image-search-simple-e2e-benchmark.cjs')
  const runNonce = 'fixed_atomic_barrier_0123456789'
  const childSource = String.raw`
    const fs = require('node:fs')
    const [benchmarkModule, readyPath, releasePath, signalPath, runNonce, parentPid] = process.argv.slice(1)
    const originalLinkSync = fs.linkSync
    let delayed = false
    fs.linkSync = (source, target) => {
      if (!delayed && target === readyPath) {
        delayed = true
        fs.writeFileSync(signalPath, 'staging-complete', { flag: 'wx' })
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
      }
      return originalLinkSync(source, target)
    }
    const { waitForLifecycleRelease } = require(benchmarkModule)
    waitForLifecycleRelease({
      readyPath,
      releasePath,
      runNonce,
      benchmarkPid: process.pid,
      orchestratorPid: Number(parentPid),
      timeoutMs: 5000,
    }).catch((error) => {
      console.error(error && (error.stack || error.message) || String(error))
      process.exitCode = 1
    })
  `
  let child
  try {
    child = spawn(
      process.execPath,
      [
        '-e',
        childSource,
        benchmarkModule,
        readyPath,
        releasePath,
        stagingSignalPath,
        runNonce,
        String(process.pid),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    const closePromise = new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const readyPromise = waitForLifecycleReady({
      readyPath,
      earliestMs: Date.now() - 1_000,
      expected: {
        runNonce,
        benchmarkPid: child.pid,
        orchestratorPid: process.pid,
      },
      timeoutMs: 5_000,
      child,
    })

    const signalDeadline = Date.now() + 5_000
    while (!fs.existsSync(stagingSignalPath) && Date.now() < signalDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(fs.existsSync(stagingSignalPath), true)
    assert.equal(fs.existsSync(readyPath), false)
    const readyStaging = fs
      .readdirSync(fixtureRoot)
      .find((name) => name.startsWith('lifecycle-ready.json.staged-'))
    assert.ok(readyStaging)
    assert.ok(fs.statSync(path.join(fixtureRoot, readyStaging)).size > 0)

    await readyPromise
    assert.ok(fs.statSync(readyPath).size > 0)
    publishLifecycleBarrierFile(releasePath, {
      schemaVersion: 1,
      phase: 'release-after-parent-tree-capture',
      runNonce,
      benchmarkPid: child.pid,
      orchestratorPid: process.pid,
    })
    const closed = await closePromise
    assert.deepEqual(closed, { code: 0, signal: null }, stderr)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('lifecycle barrier publication and child reads fail closed on malformed state', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-'))
  const expected = {
    runNonce: 'fixed_barrier_validation_0123456789',
    benchmarkPid: 1234,
    orchestratorPid: 5678,
  }
  try {
    const validPath = path.join(fixtureRoot, 'valid.json')
    publishBenchmarkLifecycleBarrierFile(validPath, {
      schemaVersion: 1,
      phase: 'release-after-parent-tree-capture',
      ...expected,
    })
    assert.equal(readLifecycleBarrierFile(validPath, expected).runNonce, expected.runNonce)

    const occupiedPath = path.join(fixtureRoot, 'occupied.json')
    fs.writeFileSync(occupiedPath, 'occupied')
    assert.throws(
      () => publishBenchmarkLifecycleBarrierFile(occupiedPath, expected),
      /publication target must be new/,
    )

    const emptyPath = path.join(fixtureRoot, 'empty.json')
    fs.writeFileSync(emptyPath, '')
    assert.throws(() => readLifecycleBarrierFile(emptyPath, expected), /barrier is empty/i)

    const oversizedPath = path.join(fixtureRoot, 'oversized.json')
    fs.writeFileSync(oversizedPath, 'x'.repeat(4 * 1024 + 1))
    assert.throws(
      () => readLifecycleBarrierFile(oversizedPath, expected),
      /exceeded its bounded size/,
    )

    const wrongNoncePath = path.join(fixtureRoot, 'wrong-nonce.json')
    fs.writeFileSync(
      wrongNoncePath,
      JSON.stringify({ schemaVersion: 1, ...expected, runNonce: 'wrong_nonce_0123456789' }),
    )
    assert.throws(
      () => readLifecycleBarrierFile(wrongNoncePath, expected),
      /provenance does not match/,
    )
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('successful round verifies lifecycle evidence before sandbox cleanup and lock release', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-'))
  const managedRoot = path.join(fixtureRoot, 'm')
  const dataset = path.join(fixtureRoot, 'd')
  const sandboxTempRoot = path.join(fixtureRoot, 's')
  const outputDirectory = path.join(managedRoot, 'r')
  fs.mkdirSync(managedRoot)
  fs.mkdirSync(dataset)
  fs.mkdirSync(sandboxTempRoot)
  let benchmarkAlive = true
  let releaseObserved = false
  let capturedWhileParentAlive = false
  try {
    const result = await withFailClosedManagedRunWorkspace(
      { managedRoot, dataset, outputDirectory, token: 'round-success-token' },
      async (workspace) =>
        runMeasuredRound(
          {
            projectRoot: fixtureRoot,
            dataset,
            outputDirectory: workspace.outputDirectory,
            sandboxTempRoot,
            baseEnvironment: {},
            sample: 4,
            backend: 'cpu',
            jobs: 1,
            batchSize: 1,
            timeoutMs: 60_000,
            runtime: {
              spawn(_command, args) {
                const child = new EventEmitter()
                child.pid = 4280
                child.stdout = new EventEmitter()
                child.stderr = new EventEmitter()
                const valueFor = (prefix) =>
                  args.find((value) => value.startsWith(prefix)).slice(prefix.length)
                const reportPath = valueFor('--json-out=')
                const timelinePath = valueFor('--timeline-out=')
                const runNonce = valueFor('--run-nonce=')
                const readyPath = valueFor('--lifecycle-ready=')
                const releasePath = valueFor('--lifecycle-release=')
                const orchestratorPid = Number(valueFor('--lifecycle-parent-pid='))
                queueMicrotask(() => {
                  fs.writeFileSync(
                    reportPath,
                    JSON.stringify({
                      schemaVersion: 1,
                      ok: true,
                      safety: { noBenchmarkChildProcessesAtStop: true },
                      resources: {
                        processes: {
                          activeAtStop: 0,
                          noResidualAtStop: true,
                          lifecycleAccounted: true,
                          observedChildProcesses: 1,
                        },
                        sampling: {
                          observedChildEvidence: {
                            lifecycleAccounted: true,
                            lifecycleTracked: 1,
                          },
                        },
                      },
                    }),
                  )
                  fs.writeFileSync(
                    timelinePath,
                    JSON.stringify({ schemaVersion: 1, runNonce, event: 'benchmark-end' }) + '\n',
                  )
                  fs.writeFileSync(
                    readyPath,
                    JSON.stringify({
                      schemaVersion: 1,
                      phase: 'ready-for-parent-tree-capture',
                      runNonce,
                      benchmarkPid: child.pid,
                      orchestratorPid,
                    }) + '\n',
                    { flag: 'wx' },
                  )
                  const watcher = fs.watch(path.dirname(releasePath), (_event, name) => {
                    if (String(name) !== path.basename(releasePath)) return
                    watcher.close()
                    releaseObserved = true
                    benchmarkAlive = false
                    child.emit('close', 0, null)
                  })
                })
                return child
              },
              setTimeout() {
                return { fixtureTimer: true }
              },
              clearTimeout() {},
              processTreeOptions: {
                platform: 'win32',
                listProcesses() {
                  if (!benchmarkAlive) return []
                  assert.equal(releaseObserved, false)
                  capturedWhileParentAlive = true
                  return [
                    { pid: 4280, parentPid: 1 },
                    { pid: 4281, parentPid: 4280 },
                  ]
                },
                spawnSyncFn() {
                  throw new Error('taskkill must not run on a successful close')
                },
              },
            },
          },
          1,
        ),
    )
    assert.equal(result.report.ok, true)
    assert.equal(capturedWhileParentAlive, true)
    assert.equal(releaseObserved, true)
    assert.equal(result.orchestration.lifecycleCapture.capturedProcessCount, 2)
    assert.equal(result.orchestration.termination.descendantCaptureComplete, true)
    assert.equal(result.orchestration.termination.observedProcessCount, 2)
    assert.match(result.orchestration.timelineSha256, /^[a-f0-9]{64}$/)
    assert.equal(result.orchestration.timeline.sha256, result.orchestration.timelineSha256)
    assert.deepEqual(fs.readdirSync(sandboxTempRoot), [])
    assert.equal(fs.existsSync(path.join(managedRoot, '.fixed-hardware-baseline.lock')), false)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('ordinary nonzero close waits for captured-tree confirmation before cleanup', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sbn-'))
  const managedRoot = path.join(fixtureRoot, 'm')
  const dataset = path.join(fixtureRoot, 'd')
  const sandboxTempRoot = path.join(fixtureRoot, 's')
  const outputDirectory = path.join(managedRoot, 'r')
  fs.mkdirSync(managedRoot)
  fs.mkdirSync(dataset)
  fs.mkdirSync(sandboxTempRoot)
  let processTableReads = 0
  try {
    await assert.rejects(
      withFailClosedManagedRunWorkspace(
        { managedRoot, dataset, outputDirectory, token: 'nonzero-token' },
        async (workspace) =>
          runMeasuredRound(
            {
              projectRoot: fixtureRoot,
              dataset,
              outputDirectory: workspace.outputDirectory,
              sandboxTempRoot,
              baseEnvironment: {},
              sample: 4,
              backend: 'cpu',
              jobs: 1,
              batchSize: 1,
              timeoutMs: 60_000,
              runtime: {
                spawn() {
                  const child = new EventEmitter()
                  child.pid = 4290
                  child.stdout = new EventEmitter()
                  child.stderr = new EventEmitter()
                  queueMicrotask(() => child.emit('close', 7, null))
                  return child
                },
                setTimeout() {
                  return { fixtureTimer: true }
                },
                clearTimeout() {},
                processTreeConfirmTimeoutMs: 100,
                processTreeOptions: {
                  platform: 'win32',
                  listProcesses() {
                    processTableReads += 1
                    if (processTableReads === 1) {
                      return [
                        { pid: 4290, parentPid: 1 },
                        { pid: 4291, parentPid: 4290 },
                      ]
                    }
                    assert.equal(fs.readdirSync(sandboxTempRoot).length, 1)
                    return []
                  },
                  spawnSyncFn() {
                    throw new Error('taskkill must not run after the parent close was received')
                  },
                },
              },
            },
            1,
          ),
      ),
      /failed after an abnormal child close/,
    )
    assert.ok(processTableReads >= 2)
    assert.deepEqual(fs.readdirSync(sandboxTempRoot), [])
    assert.equal(fs.existsSync(path.join(managedRoot, '.fixed-hardware-baseline.lock')), false)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('signal shutdown uses the same captured-tree confirmation path', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sbg-'))
  const managedRoot = path.join(fixtureRoot, 'm')
  const dataset = path.join(fixtureRoot, 'd')
  const sandboxTempRoot = path.join(fixtureRoot, 's')
  const outputDirectory = path.join(managedRoot, 'r')
  fs.mkdirSync(managedRoot)
  fs.mkdirSync(dataset)
  fs.mkdirSync(sandboxTempRoot)
  const signalCleanup = installSignalCleanup()
  let processTableReads = 0
  try {
    await assert.rejects(
      withFailClosedManagedRunWorkspace(
        { managedRoot, dataset, outputDirectory, token: 'signal-token' },
        async (workspace) =>
          runMeasuredRound(
            {
              projectRoot: fixtureRoot,
              dataset,
              outputDirectory: workspace.outputDirectory,
              sandboxTempRoot,
              baseEnvironment: {},
              sample: 4,
              backend: 'cpu',
              jobs: 1,
              batchSize: 1,
              timeoutMs: 60_000,
              runtime: {
                spawn() {
                  const child = new EventEmitter()
                  child.pid = 4295
                  child.stdout = new EventEmitter()
                  child.stderr = new EventEmitter()
                  queueMicrotask(() => signalCleanup.handle('SIGTERM'))
                  return child
                },
                setTimeout() {
                  return { fixtureTimer: true }
                },
                clearTimeout() {},
                processTreeConfirmTimeoutMs: 100,
                processTreeOptions: {
                  platform: 'win32',
                  listProcesses() {
                    processTableReads += 1
                    return processTableReads === 1
                      ? [
                          { pid: 4295, parentPid: 1 },
                          { pid: 4296, parentPid: 4295 },
                        ]
                      : []
                  },
                  spawnSyncFn() {
                    return { status: 0, signal: null }
                  },
                },
              },
            },
            1,
          ),
      ),
      /failed after the SIGTERM shutdown signal/,
    )
    assert.ok(processTableReads >= 2)
    assert.deepEqual(fs.readdirSync(sandboxTempRoot), [])
    assert.equal(fs.existsSync(path.join(managedRoot, '.fixed-hardware-baseline.lock')), false)
  } finally {
    signalCleanup.dispose()
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('timeout close race retains lock and sandbox until the captured descendant tree disappears', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sbl-'))
  const managedRoot = path.join(fixtureRoot, 'm')
  const dataset = path.join(fixtureRoot, 'd')
  const sandboxTempRoot = path.join(fixtureRoot, 's')
  const outputDirectory = path.join(managedRoot, 'r')
  fs.mkdirSync(managedRoot)
  fs.mkdirSync(dataset)
  fs.mkdirSync(sandboxTempRoot)
  let child
  let closeEmitted = false
  let descendantAlive = true
  let processTableReads = 0
  try {
    await assert.rejects(
      withFailClosedManagedRunWorkspace(
        { managedRoot, dataset, outputDirectory, token: 'test-token' },
        async (workspace) => {
          await runMeasuredRound(
            {
              projectRoot: fixtureRoot,
              dataset,
              outputDirectory: workspace.outputDirectory,
              sandboxTempRoot,
              baseEnvironment: {},
              sample: 4,
              backend: 'cpu',
              jobs: 1,
              batchSize: 1,
              timeoutMs: 60_000,
              runtime: {
                spawn() {
                  child = new EventEmitter()
                  child.pid = 4300
                  child.stdout = new EventEmitter()
                  child.stderr = new EventEmitter()
                  return child
                },
                setTimeout(callback) {
                  queueMicrotask(callback)
                  return { fixtureTimer: true }
                },
                clearTimeout() {},
                processTreeConfirmTimeoutMs: 30,
                processTreeOptions: {
                  platform: 'win32',
                  pollIntervalMs: 10,
                  listProcesses() {
                    processTableReads += 1
                    if (processTableReads === 1) {
                      return [
                        { pid: 4300, parentPid: 1 },
                        { pid: 4301, parentPid: 4300 },
                      ]
                    }
                    if (closeEmitted) {
                      assert.equal(fs.readdirSync(sandboxTempRoot).length, 1)
                    }
                    return descendantAlive ? [{ pid: 4301, parentPid: 1 }] : []
                  },
                  spawnSyncFn() {
                    queueMicrotask(() => {
                      closeEmitted = true
                      child.emit('close', 1, null)
                    })
                    return { status: 0, signal: null }
                  },
                },
              },
            },
            1,
          )
        },
      ),
      (error) => error?.code === 'PROCESS_TREE_UNCONFIRMED',
    )
    assert.equal(fs.existsSync(path.join(managedRoot, '.fixed-hardware-baseline.lock')), true)
    assert.equal(fs.existsSync(outputDirectory), true)
    assert.equal(fs.readdirSync(sandboxTempRoot).length, 1)
    assert.equal(closeEmitted, true)

    descendantAlive = false
    const finalization = await finalizeActiveBenchmarkProcesses({
      timeoutMs: 100,
      processTreeOptions: {
        platform: 'win32',
        pollIntervalMs: 10,
        listProcesses() {
          return []
        },
        spawnSyncFn() {
          return { status: 1, signal: null }
        },
      },
    })
    assert.equal(finalization.ok, true, finalization.failures.join('\n'))
    assert.deepEqual(fs.readdirSync(sandboxTempRoot), [])
    assert.equal(fs.existsSync(path.join(managedRoot, '.fixed-hardware-baseline.lock')), true)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('code-zero report verification keeps lock, output, and sandbox when tree queries fail', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sbq-'))
  const managedRoot = path.join(fixtureRoot, 'm')
  const dataset = path.join(fixtureRoot, 'd')
  const sandboxTempRoot = path.join(fixtureRoot, 's')
  const outputDirectory = path.join(managedRoot, 'r')
  fs.mkdirSync(managedRoot)
  fs.mkdirSync(dataset)
  fs.mkdirSync(sandboxTempRoot)
  let benchmarkAlive = true
  try {
    await assert.rejects(
      withFailClosedManagedRunWorkspace(
        { managedRoot, dataset, outputDirectory, token: 'query-failure-token' },
        async (workspace) =>
          runMeasuredRound(
            {
              projectRoot: fixtureRoot,
              dataset,
              outputDirectory: workspace.outputDirectory,
              sandboxTempRoot,
              baseEnvironment: {},
              sample: 4,
              backend: 'cpu',
              jobs: 1,
              batchSize: 1,
              timeoutMs: 60_000,
              runtime: {
                spawn(_command, args) {
                  const child = new EventEmitter()
                  child.pid = 4310
                  child.stdout = new EventEmitter()
                  child.stderr = new EventEmitter()
                  const valueFor = (prefix) =>
                    args.find((value) => value.startsWith(prefix)).slice(prefix.length)
                  const reportPath = valueFor('--json-out=')
                  const timelinePath = valueFor('--timeline-out=')
                  const runNonce = valueFor('--run-nonce=')
                  const readyPath = valueFor('--lifecycle-ready=')
                  const releasePath = valueFor('--lifecycle-release=')
                  const orchestratorPid = Number(valueFor('--lifecycle-parent-pid='))
                  queueMicrotask(() => {
                    fs.writeFileSync(
                      reportPath,
                      JSON.stringify({
                        schemaVersion: 1,
                        ok: true,
                        safety: { noBenchmarkChildProcessesAtStop: true },
                        resources: {
                          processes: {
                            activeAtStop: 0,
                            noResidualAtStop: true,
                            lifecycleAccounted: true,
                            observedChildProcesses: 1,
                          },
                          sampling: {
                            observedChildEvidence: {
                              lifecycleAccounted: true,
                              lifecycleTracked: 1,
                            },
                          },
                        },
                      }),
                    )
                    fs.writeFileSync(
                      timelinePath,
                      JSON.stringify({ schemaVersion: 1, runNonce, event: 'benchmark-end' }) + '\n',
                    )
                    fs.writeFileSync(
                      readyPath,
                      JSON.stringify({
                        schemaVersion: 1,
                        phase: 'ready-for-parent-tree-capture',
                        runNonce,
                        benchmarkPid: child.pid,
                        orchestratorPid,
                      }) + '\n',
                      { flag: 'wx' },
                    )
                    const watcher = fs.watch(path.dirname(releasePath), (_event, name) => {
                      if (String(name) !== path.basename(releasePath)) return
                      watcher.close()
                      benchmarkAlive = false
                      child.emit('close', 0, null)
                    })
                  })
                  return child
                },
                setTimeout() {
                  return { fixtureTimer: true }
                },
                clearTimeout() {},
                processTreeConfirmTimeoutMs: 30,
                processTreeOptions: {
                  platform: 'win32',
                  pollIntervalMs: 10,
                  listProcesses() {
                    if (!benchmarkAlive) throw new Error('fixture WMIC query unavailable')
                    return [
                      { pid: 4310, parentPid: 1 },
                      { pid: 4311, parentPid: 4310 },
                    ]
                  },
                  spawnSyncFn() {
                    throw new Error('taskkill must not run after a code-zero close')
                  },
                },
              },
            },
            1,
          ),
      ),
      (error) =>
        error?.code === 'PROCESS_TREE_UNCONFIRMED' &&
        /successful child close/.test(error.message) &&
        /WMIC query unavailable/.test(error.processTreeEvidence?.queryError || ''),
    )
    assert.equal(fs.existsSync(path.join(managedRoot, '.fixed-hardware-baseline.lock')), true)
    assert.ok(fs.readdirSync(outputDirectory).length >= 4)
    assert.equal(fs.readdirSync(sandboxTempRoot).length, 1)

    const finalization = await finalizeActiveBenchmarkProcesses({
      timeoutMs: 100,
      processTreeOptions: {
        platform: 'win32',
        listProcesses() {
          return []
        },
        spawnSyncFn() {
          return { status: 1, signal: null }
        },
      },
    })
    assert.equal(finalization.ok, true, finalization.failures.join('\n'))
    assert.deepEqual(fs.readdirSync(sandboxTempRoot), [])
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('hardware and dataset fingerprints are canonical', () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }))
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }))
})

test('three complete isolated runs establish first-build and memory control limits', () => {
  const result = evaluateBaseline(evaluationInput())
  assert.equal(result.ok, true, result.failures.join('\n'))
  assert.equal(result.metrics.libraryReadyMs.samples, 3)
  assert.equal(result.metrics.combinedPeakRssMiBApprox.samples, 3)
  assert.equal(result.comparison.status, 'established')
  assert.ok(result.controlLimits.libraryReadyP95Ms > result.metrics.libraryReadyMs.p95)
  assert.ok(
    result.controlLimits.combinedPeakRssP95MiB > result.metrics.combinedPeakRssMiBApprox.p95,
  )
})

test('baseline rejects repeated nonce, report hash, or temporary directory identity', () => {
  const cases = [
    {
      label: 'execution nonce',
      mutate(input) {
        input.roundProofs[2].runNonce = input.roundProofs[1].runNonce
        input.runs[2].execution.runNonce = input.roundProofs[1].runNonce
      },
    },
    {
      label: 'round report',
      mutate(input) {
        input.roundProofs[2].reportSha256 = input.roundProofs[1].reportSha256
      },
    },
    {
      label: 'round timeline',
      mutate(input) {
        input.roundProofs[2].timelineSha256 = input.roundProofs[1].timelineSha256
        input.roundProofs[2].timeline.sha256 = input.roundProofs[1].timelineSha256
      },
    },
    {
      label: 'temporary directory',
      mutate(input) {
        input.runs[2].execution.tempDirectoryId = input.runs[1].execution.tempDirectoryId
        input.runs[2].safety.tempDirectoryId = input.runs[1].execution.tempDirectoryId
      },
    },
  ]

  for (const fixture of cases) {
    const input = evaluationInput()
    fixture.mutate(input)
    const result = evaluateBaseline(input)
    assert.equal(result.ok, false, fixture.label)
    assert.match(
      result.failures.join('\n'),
      new RegExp(`${fixture.label} must be unique across all three rounds`),
    )
  }
})

test('baseline fails closed on zero sampling and zero-filled main or child memory', () => {
  const input = evaluationInput()
  input.runs[0].resources.sampling.samples = 0
  input.runs[0].resources.sampling.sampleCount = 0
  input.runs[1].resources.memory.mainPeakRssMiB = 0
  input.runs[2].resources.memory.childPeakAggregateRssMiBApprox = 0

  const result = evaluateBaseline(input)
  const failures = result.failures.join('\n')
  assert.equal(result.ok, false)
  assert.match(failures, /resource sample count is missing/)
  assert.match(failures, /main-process peak RSS must be observed, not zero-filled/)
  assert.match(failures, /child-process peak RSS must be observed, not zero-filled/)
})

test('compare fails closed when accepted controls are missing or incomplete', () => {
  const missing = evaluateBaseline(evaluationInput({ mode: 'compare' }))
  assert.equal(missing.ok, false)
  assert.equal(missing.comparison.status, 'missing-control')
  assert.match(missing.failures.join('\n'), /requires an immutable accepted baseline/)

  const established = evaluateBaseline(evaluationInput())
  assert.equal(established.ok, true, established.failures.join('\n'))
  const input = evaluationInput({ mode: 'compare' })
  const controls = { ...established.controlLimits }
  delete controls.childPeakAggregateRssP95MiB
  input.baseline = acceptedBaseline(input, controls)
  input.baselinePath = 'accepted.json'

  const result = evaluateBaseline(input)
  assert.equal(result.ok, false)
  assert.equal(result.comparison.status, 'regressed')
  assert.match(
    result.failures.join('\n'),
    /control line field is missing or invalid: childPeakAggregateRssP95MiB/,
  )
})

test('baseline rejects real user data, source corpus, and frozen evidence changes', () => {
  const input = evaluationInput({
    datasetUnchanged: false,
    sourceUnchanged: false,
    userDataUnchanged: false,
    evidenceStabilityFailures: [
      'environment fingerprint differs from the frozen pre-run evidence',
      'implementation revision differs from the frozen pre-run evidence',
    ],
  })
  input.runs[1].safety.sourceUnchanged = false

  const result = evaluateBaseline(input)
  const failures = result.failures.join('\n')
  assert.equal(result.ok, false)
  assert.match(failures, /round 2: source corpus changed/)
  assert.match(failures, /dataset root metadata changed during the baseline/)
  assert.match(failures, /measured source changed during the baseline/)
  assert.match(failures, /real user application data changed during the baseline/)
  assert.match(failures, /environment fingerprint differs/)
  assert.match(failures, /implementation revision differs/)
})

test('formal baseline rejects missing, CPU, mixed, or fallback provider evidence', () => {
  const cases = [
    {
      label: 'missing',
      mutate(value) {
        delete value.providerEvidence.dino
      },
      pattern: /DINO provider telemetry is missing/,
    },
    {
      label: 'cpu',
      mutate(value) {
        value.providerEvidence.clip.selectedProviders = ['cpu']
      },
      pattern: /CLIP effective provider was not exclusively DirectML/,
    },
    {
      label: 'mixed',
      mutate(value) {
        value.providerEvidence.dino.selectedProviders = ['dml', 'cpu']
      },
      pattern: /DINO effective provider was not exclusively DirectML/,
    },
    {
      label: 'fallback',
      mutate(value) {
        value.providerEvidence.clip.fallbackDetected = true
      },
      pattern: /CLIP provider fallback was detected/,
    },
  ]
  for (const fixture of cases) {
    const input = evaluationInput()
    fixture.mutate(input.runs[0])
    const result = evaluateBaseline(input)
    assert.equal(result.ok, false, fixture.label)
    assert.match(result.failures.join('\n'), fixture.pattern, fixture.label)
  }

  const diagnostic = evaluationInput({ mode: 'diagnostic' })
  for (const run of diagnostic.runs) delete run.providerEvidence
  const diagnosticResult = evaluateBaseline(diagnostic)
  assert.equal(diagnosticResult.ok, true, diagnosticResult.failures.join('\n'))
  assert.equal(diagnosticResult.comparison.status, 'diagnostic')
})

test('comparison rejects a first-build time regression without changing accepted limits', () => {
  const established = evaluateBaseline(evaluationInput())
  assert.equal(established.ok, true, established.failures.join('\n'))
  const input = evaluationInput({ mode: 'compare' })
  const controlLimits = structuredClone(established.controlLimits)
  input.baseline = acceptedBaseline(input, controlLimits)
  input.baselinePath = 'accepted.json'
  input.runs = [
    fakeRun(1, { ready: 150_000 }),
    fakeRun(2, { ready: 151_000 }),
    fakeRun(3, { ready: 152_000 }),
  ]

  const result = evaluateBaseline(input)
  assert.equal(result.ok, false)
  assert.equal(result.comparison.status, 'regressed')
  assert.match(result.failures.join('\n'), /library-ready P95 exceeded/)
  assert.deepEqual(input.baseline.controlLimits, controlLimits)
})

test('invalid lifecycle barrier quarantines lock, output, and sandbox even after tree termination', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sbb-'))
  const managedRoot = path.join(fixtureRoot, 'm')
  const dataset = path.join(fixtureRoot, 'd')
  const sandboxTempRoot = path.join(fixtureRoot, 's')
  const outputDirectory = path.join(managedRoot, 'r')
  fs.mkdirSync(managedRoot)
  fs.mkdirSync(dataset)
  fs.mkdirSync(sandboxTempRoot)
  let child
  let processTableReads = 0
  try {
    await assert.rejects(
      withFailClosedManagedRunWorkspace(
        { managedRoot, dataset, outputDirectory, token: 'barrier-failure-token' },
        async (workspace) =>
          runMeasuredRound(
            {
              projectRoot: fixtureRoot,
              dataset,
              outputDirectory: workspace.outputDirectory,
              sandboxTempRoot,
              baseEnvironment: {},
              sample: 4,
              backend: 'cpu',
              jobs: 1,
              batchSize: 1,
              timeoutMs: 60_000,
              runtime: {
                spawn(_command, args) {
                  child = new EventEmitter()
                  child.pid = 4320
                  child.stdout = new EventEmitter()
                  child.stderr = new EventEmitter()
                  const readyPath = args
                    .find((value) => value.startsWith('--lifecycle-ready='))
                    .slice('--lifecycle-ready='.length)
                  queueMicrotask(() => {
                    fs.writeFileSync(
                      readyPath,
                      JSON.stringify({
                        schemaVersion: 1,
                        phase: 'ready-for-parent-tree-capture',
                        runNonce: 'wrong_nonce_0123456789',
                        benchmarkPid: child.pid,
                        orchestratorPid: process.pid,
                      }) + '\n',
                      { flag: 'wx' },
                    )
                  })
                  return child
                },
                setTimeout() {
                  return { fixtureTimer: true }
                },
                clearTimeout() {},
                processTreeConfirmTimeoutMs: 100,
                processTreeOptions: {
                  platform: 'win32',
                  pollIntervalMs: 10,
                  listProcesses() {
                    processTableReads += 1
                    return processTableReads === 1
                      ? [
                          { pid: 4320, parentPid: 1 },
                          { pid: 4321, parentPid: 4320 },
                        ]
                      : []
                  },
                  spawnSyncFn() {
                    queueMicrotask(() => child.emit('close', 1, null))
                    return { status: 0, signal: null }
                  },
                },
              },
            },
            1,
          ),
      ),
      (error) =>
        error?.code === 'PROCESS_TREE_UNCONFIRMED' &&
        /lifecycle capture barrier/.test(error.message) &&
        /provenance does not match/.test(error.message),
    )
    assert.equal(fs.existsSync(path.join(managedRoot, '.fixed-hardware-baseline.lock')), true)
    assert.ok(fs.readdirSync(outputDirectory).length >= 2)
    assert.equal(fs.readdirSync(sandboxTempRoot).length, 1)

    const finalization = await finalizeActiveBenchmarkProcesses({
      timeoutMs: 100,
      processTreeOptions: {
        platform: 'win32',
        listProcesses() {
          return []
        },
        spawnSyncFn() {
          return { status: 1, signal: null }
        },
      },
    })
    assert.equal(finalization.ok, false)
    assert.match(finalization.failures.join('\n'), /remains quarantined/)
    assert.equal(fs.readdirSync(sandboxTempRoot).length, 1)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
