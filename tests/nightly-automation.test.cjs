const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  classifyStageResult,
  createBoundedCapture,
  createPlan,
  parseArgs,
  redactText,
  resolveNpmInvocation,
  runNightly,
} = require('../scripts/run-nightly-automation.cjs')
const { benchmarkTimeoutBudgetMs } = require('../scripts/run-automation-benchmark.cjs')

const passThroughClassification = (_stage, result) => result

function options(root, overrides = {}) {
  return {
    mode: 'quick',
    datasetPath: path.join(root, 'dataset'),
    sourcePath: path.join(root, 'dataset'),
    baselinePath: '',
    outputDir: path.join(root, 'automation', 'nightly-test'),
    plan: false,
    json: false,
    redactPaths: true,
    skipBenchmark: false,
    skipSourceAudit: false,
    skipQuality: false,
    allowNetwork: false,
    allowGeneratedClean: false,
    ...overrides,
  }
}

test('nightly arguments default to safe quick mode and path redaction', () => {
  const parsed = parseArgs([])
  assert.equal(parsed.mode, 'quick')
  assert.equal(parsed.redactPaths, true)
  assert.equal(parsed.sourcePath, parsed.datasetPath)
  assert.equal(parsed.allowNetwork, false)
  assert.equal(parsed.allowGeneratedClean, false)
  assert.throws(() => parseArgs(['--quick', '--full']), /only one/)
  assert.throws(() => parseArgs(['--execute']), /Unknown/)
})

test('quick and full plans expose different bounded gates', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-plan-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'dataset'))
  const automationRoot = path.join(root, 'automation')
  const quick = createPlan(options(root), fs.existsSync, automationRoot)
  assert.deepEqual(
    quick.stages.map((stage) => stage.id),
    ['health', 'model-safety', 'benchmark', 'source-audit', 'media-player'],
  )
  const full = createPlan(options(root, { mode: 'full' }), fs.existsSync, automationRoot)
  assert.deepEqual(
    full.stages.map((stage) => stage.id),
    [
      'quality',
      'health',
      'model-safety',
      'benchmark',
      'source-audit',
      'media-player',
      'ui-locales',
      'ui-themes',
    ],
  )
  assert.equal(full.stages.find((stage) => stage.id === 'benchmark').required, true)
  assert.match(full.stages.find((stage) => stage.id === 'quality').skipReason, /explicit/)
  const authorizedFull = createPlan(
    options(root, { mode: 'full', allowNetwork: true, allowGeneratedClean: true }),
    fs.existsSync,
    automationRoot,
  )
  assert.equal(authorizedFull.stages.find((stage) => stage.id === 'quality').skipReason, undefined)
  assert.deepEqual(authorizedFull.capabilities, {
    sourceMutation: false,
    productDataDeletion: false,
    modelDownload: false,
    licenseAcceptance: false,
    network: true,
    generatedBuildCleanup: true,
  })
  assert.ok(full.stages.every((stage) => stage.timeoutMs > 0))
  assert.equal(
    quick.stages.find((stage) => stage.id === 'benchmark').timeoutMs,
    benchmarkTimeoutBudgetMs('quick') + 5 * 60 * 1000,
  )
  assert.equal(
    full.stages.find((stage) => stage.id === 'benchmark').timeoutMs,
    benchmarkTimeoutBudgetMs('full') + 5 * 60 * 1000,
  )
  assert.ok(full.timeoutBudgetMs < 350 * 60 * 1000)
})

test('npm stages use the Node npm CLI on Windows instead of directly spawning npm.cmd', () => {
  const invocation = resolveNpmInvocation({}, 'win32')
  assert.notEqual(path.basename(invocation.command).toLowerCase(), 'npm.cmd')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-npm-plan-'))
  try {
    fs.mkdirSync(path.join(root, 'dataset'))
    const plan = createPlan(options(root), fs.existsSync, path.join(root, 'automation'))
    const mediaStage = plan.stages.find((stage) => stage.id === 'media-player')
    assert.notEqual(path.basename(mediaStage.command).toLowerCase(), 'npm.cmd')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('report contracts preserve incomplete benchmark and partial audit semantics', () => {
  const passedProcess = { status: 'passed', exitCode: 0, durationMs: 1 }
  const benchmarkStage = { reportContract: { kind: 'benchmark', path: 'fixture' } }
  assert.equal(
    classifyStageResult(benchmarkStage, passedProcess, () => ({
      ok: true,
      status: 'completed-without-baseline',
      comparison: { status: 'not-requested' },
    })).status,
    'incomplete',
  )
  assert.equal(
    classifyStageResult(
      { reportContract: { kind: 'source-audit', path: 'fixture' } },
      passedProcess,
      () => ({ status: 'partial' }),
    ).status,
    'partial',
  )
  assert.equal(
    classifyStageResult(
      { reportContract: { kind: 'health', path: 'fixture' } },
      passedProcess,
      () => ({ ok: false, status: 'failed' }),
    ).status,
    'failed',
  )
})

test('missing quick dataset becomes a diagnostic skip while full mode fails closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-missing-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const quick = await runNightly(options(root), {
    automationRoot: path.join(root, 'automation'),
    exists: () => false,
    classifyStageResult: passThroughClassification,
    runStage: async (stage) => ({
      id: stage.id,
      label: stage.label,
      required: stage.required,
      status: 'passed',
      exitCode: 0,
      durationMs: 1,
      stdout: '',
      stderr: '',
    }),
  })
  assert.equal(quick.status, 'partial')
  assert.equal(quick.summary.skipped, 2)

  const full = await runNightly(
    options(root, {
      mode: 'full',
      allowNetwork: true,
      allowGeneratedClean: true,
      outputDir: path.join(root, 'automation', 'full'),
    }),
    {
      automationRoot: path.join(root, 'automation'),
      exists: () => false,
      classifyStageResult: passThroughClassification,
      runStage: async (stage) => ({
        id: stage.id,
        label: stage.label,
        required: stage.required,
        status: 'passed',
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
      }),
    },
  )
  assert.equal(full.status, 'failed')
  assert.equal(full.summary.requiredFailures, 2)
})

test('nightly continues after a failed stage and preserves per-stage logs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-run-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'dataset'))
  const visited = []
  const report = await runNightly(options(root), {
    automationRoot: path.join(root, 'automation'),
    classifyStageResult: passThroughClassification,
    runStage: async (stage) => {
      visited.push(stage.id)
      const failed = stage.id === 'model-safety'
      return {
        id: stage.id,
        label: stage.label,
        required: stage.required,
        status: failed ? 'failed' : 'passed',
        exitCode: failed ? 1 : 0,
        durationMs: 2,
        stdout: `${root}\\stdout`,
        stderr: failed ? 'fixture failure' : '',
      }
    },
  })
  assert.deepEqual(visited, ['health', 'model-safety', 'benchmark', 'source-audit', 'media-player'])
  assert.equal(report.status, 'failed')
  assert.equal(report.summary.requiredFailures, 1)
  assert.equal(
    fs.existsSync(path.join(root, 'automation', 'nightly-test', 'health.stdout.log')),
    true,
  )
  const persisted = fs.readFileSync(
    path.join(root, 'automation', 'nightly-test', 'nightly-report.json'),
    'utf8',
  )
  assert.doesNotMatch(persisted, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  assert.doesNotMatch(
    JSON.stringify(report),
    new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  )
  assert.equal(report.complete, true)
  assert.equal(report.artifacts.json, 'nightly-test/nightly-report.json')
})

test('each completed stage is checkpointed before the next stage starts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-checkpoint-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'dataset'))
  const outputDir = path.join(root, 'automation', 'nightly-test')
  let calls = 0
  const report = await runNightly(options(root), {
    automationRoot: path.join(root, 'automation'),
    classifyStageResult: passThroughClassification,
    runStage: async (stage) => {
      calls += 1
      if (calls === 2) {
        const checkpoint = JSON.parse(
          fs.readFileSync(path.join(outputDir, 'nightly-report.json'), 'utf8'),
        )
        assert.equal(checkpoint.complete, false)
        assert.equal(checkpoint.summary.completed, 1)
        assert.equal(checkpoint.checkpoint.completedStages, 1)
      }
      return {
        id: stage.id,
        label: stage.label,
        required: stage.required,
        status: 'passed',
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
      }
    },
  })
  assert.equal(report.complete, true)
  assert.equal(report.checkpoint.completedStages, 5)
})

test('explicit full skips remain visible required failures', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-explicit-skips-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'dataset'))
  const fullOptions = options(root, {
    mode: 'full',
    skipQuality: true,
    allowNetwork: true,
    allowGeneratedClean: true,
    skipBenchmark: true,
    skipSourceAudit: true,
  })
  const plan = createPlan(fullOptions, () => true, path.join(root, 'automation'))
  assert.deepEqual(
    plan.stages.filter((stage) => stage.skipReason).map((stage) => stage.id),
    ['quality', 'benchmark', 'source-audit'],
  )
  const report = await runNightly(fullOptions, {
    automationRoot: path.join(root, 'automation'),
    exists: () => true,
    classifyStageResult: passThroughClassification,
    runStage: async (stage) => ({
      id: stage.id,
      label: stage.label,
      required: stage.required,
      status: 'passed',
      exitCode: 0,
      durationMs: 1,
      stdout: '',
      stderr: '',
    }),
  })
  assert.equal(report.status, 'failed')
  assert.equal(report.summary.requiredFailures, 3)
  assert.equal(report.summary.skipped, 3)
})

test('bounded capture truncates oversized lines and total output', () => {
  const capture = createBoundedCapture(120, 20)
  capture.push(`${'x'.repeat(200)}\nfirst\nsecond\nthird\n`)
  const result = capture.finish()
  assert.equal(result.truncated, true)
  assert.ok(Buffer.byteLength(result.text) <= 120)
  assert.match(result.text, /truncated/)
})

test('redaction replaces source and dataset paths before persistence', () => {
  const plan = {
    datasetPath: 'D:\\Private\\Dataset',
    sourcePath: 'D:\\Private',
  }
  const redacted = redactText('read D:\\Private\\Dataset\\a.jpg then D:\\Private\\other.mp4', plan)
  assert.equal(redacted, 'read <DATASET>\\a.jpg then <SOURCE>\\other.mp4')
})

test('nightly artifact directory cannot be placed inside source data', () => {
  const root = path.resolve('D:/nightly-boundary-fixture')
  const automationRoot = path.join(root, 'automation')
  const sourceRoot = path.join(automationRoot, 'source')
  assert.throws(
    () =>
      createPlan(
        options(root, {
          datasetPath: sourceRoot,
          sourcePath: sourceRoot,
          outputDir: path.join(sourceRoot, 'artifacts'),
        }),
        () => true,
        automationRoot,
      ),
    /outside the dataset/,
  )
})

test('production output boundary rejects external paths and cannot be widened by CLI', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-production-boundary-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.throws(() => createPlan(options(root), () => true), /automation root/)
  assert.throws(() => parseArgs(['--automation-root=D:\\unsafe']), /Unknown/)
})

test('injected automation root accepts only strict child output paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-injected-boundary-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const automationRoot = path.join(root, 'automation')

  assert.throws(
    () => createPlan(options(root, { outputDir: automationRoot }), () => true, automationRoot),
    /strict child/,
  )
  assert.throws(
    () =>
      createPlan(
        options(root, { outputDir: path.join(root, 'automation-escape', 'nightly') }),
        () => true,
        automationRoot,
      ),
    /strict child/,
  )
  assert.equal(
    createPlan(options(root), () => true, automationRoot).outputDir,
    path.join(automationRoot, 'nightly-test'),
  )
})

test('nightly output boundary resolves a pre-existing junction target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-junction-boundary-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const automationRoot = path.join(root, 'automation')
  const external = path.join(root, 'external')
  const linkedOutput = path.join(automationRoot, 'linked-output')
  fs.mkdirSync(path.join(root, 'dataset'))
  fs.mkdirSync(automationRoot)
  fs.mkdirSync(external)
  try {
    fs.symlinkSync(external, linkedOutput, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`junction creation unavailable: ${error.message}`)
    return
  }
  assert.throws(
    () => createPlan(options(root, { outputDir: linkedOutput }), () => true, automationRoot),
    /strict child/,
  )
})
