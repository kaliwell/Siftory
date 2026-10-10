const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  buildValueTodoSnapshot,
  parseValueTaskRows,
} = require('../scripts/next-value-optimization-task.cjs')
const health = require('../scripts/run-automation-health.cjs')
const modelRepair = require('../scripts/run-model-repair-orchestrator.cjs')
const benchmark = require('../scripts/run-automation-benchmark.cjs')
const sourceAudit = require('../scripts/audit-source-derived-data.cjs')
const nightly = require('../scripts/run-nightly-automation.cjs')

const repoRoot = path.resolve(__dirname, '..')
const todoPath = path.join(
  repoRoot,
  'docs',
  'current',
  '2026-08-24-runtime-health-performance-auto-todo.md',
)

test('runtime operations TODO is machine-readable with only external observations blocked', () => {
  const todo = fs.readFileSync(todoPath, 'utf8')
  const tasks = parseValueTaskRows(todo)
  const snapshot = buildValueTodoSnapshot(tasks)
  assert.equal(snapshot.ok, true, snapshot.errors.join('\n'))
  assert.deepEqual(
    tasks.map((task) => task.id),
    [
      'VAL-701',
      'VAL-702',
      'VAL-703',
      'VAL-704',
      'VAL-705',
      'VAL-706',
      'VAL-707',
      'VAL-708',
      'VAL-709',
    ],
  )
  assert.deepEqual(
    tasks.slice(0, 8).map((task) => task.status),
    Array(8).fill('verified'),
  )
  assert.equal(snapshot.selected, null)
  assert.deepEqual(
    snapshot.blocked.map((task) => task.id),
    ['VAL-709'],
  )
  assert.equal(snapshot.counts.verified, 8)
  assert.equal(snapshot.counts.active, 0)
  assert.match(todo, /`npm\.cmd run verify` 已完整执行并以 exit 0 结束/)
  assert.match(
    todo,
    /真实最终 source audit[^\n]+pxhere-readonly-20260824-final\.json[^\n]+`passed`/,
  )
  assert.match(
    todo,
    /真实最终 quick benchmark[^\n]+pxhere-quick-20260824-final\/report\.json[^\n]+`failed`/,
  )
  assert.match(todo, /Library Ready P95 相对基线增加 10\.674%/)
  assert.match(todo, /不是获批的稳定基线/)
  assert.match(todo, /`VAL-708` 更新为 `verified`/)
  assert.match(todo, /baseline-20260826-final-accepted\/report\.json/)
  assert.match(todo, /`blocked=\[VAL-709\]`/)
  assert.match(todo, /`VAL-709`[^\n]+保持 `blocked`/)
})

test('runtime operation task ids are unique across current machine-readable plans', () => {
  const currentRoot = path.join(repoRoot, 'docs', 'current')
  const allIds = fs
    .readdirSync(currentRoot)
    .filter((name) => name.endsWith('.md'))
    .flatMap((name) =>
      parseValueTaskRows(fs.readFileSync(path.join(currentRoot, name), 'utf8')).map(
        (task) => task.id,
      ),
    )
  for (let id = 701; id <= 709; id += 1) {
    const candidate = `VAL-${id}`
    assert.equal(allIds.filter((value) => value === candidate).length, 1, `${candidate} duplicated`)
  }
})

test('package scripts expose each operation and keep focused tests reachable from npm test', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts
  assert.match(scripts['todo:operations-next'], /runtime-health-performance-auto-todo\.md$/)
  assert.match(scripts['todo:operations-check'], /--check$/)
  assert.match(scripts['todo:operations-auto'], /test:operations-automation/)
  assert.match(scripts['todo:operations-auto'], /automation:health/)
  assert.match(scripts['todo:operations-auto'], /automation:model-repair -- --plan/)
  assert.match(scripts['todo:operations-auto'], /automation:benchmark -- --plan/)
  assert.match(scripts['todo:operations-auto'], /automation:data-audit/)
  assert.match(scripts['todo:operations-auto'], /automation:nightly -- --plan/)
  assert.equal(scripts['automation:health'], 'node scripts/run-automation-health.cjs')
  assert.equal(scripts['automation:model-repair'], 'node scripts/run-model-repair-orchestrator.cjs')
  assert.equal(scripts['automation:benchmark'], 'node scripts/run-automation-benchmark.cjs')
  assert.equal(scripts['automation:data-audit'], 'node scripts/audit-source-derived-data.cjs')
  assert.equal(scripts['automation:nightly'], 'node scripts/run-nightly-automation.cjs')
  assert.match(scripts.test, /test:operations-automation/)
  for (const file of [
    'automation-health.test.cjs',
    'model-repair-orchestrator.test.cjs',
    'automation-benchmark.test.cjs',
    'source-derived-data-audit.test.cjs',
    'nightly-automation.test.cjs',
  ]) {
    assert.match(scripts['test:operations-automation'], new RegExp(file.replace('.', '\\.')))
  }
})

test('health, model, benchmark and source audit defaults are fail-closed and non-destructive', () => {
  assert.equal(health.DEFAULT_OUTPUT_DIR, path.join(repoRoot, 'artifacts', 'automation', 'health'))
  const healthPlan = health.createPlan({
    full: false,
    platform: 'linux',
    env: {},
  })
  assert.deepEqual(healthPlan.scope, {
    readOnlyChecks: true,
    network: false,
    install: false,
    delete: false,
  })

  const modelOptions = modelRepair.parseArgs([], { APPDATA: 'C:\\AppData' }, repoRoot)
  assert.equal(modelOptions.execute, false)
  assert.equal(modelOptions.allowDownload, false)
  assert.ok(modelRepair.createDetectionStages(modelOptions).every((stage) => stage.readOnly))
  assert.throws(
    () =>
      modelRepair.parseArgs(
        ['--execute', '--repair=local-user-models'],
        { APPDATA: 'C:\\AppData' },
        repoRoot,
      ),
    /--allow-download/,
  )

  const benchmarkOptions = benchmark.parseArgs(
    ['--plan', '--dataset=D:\\fixtures', '--output-dir=artifacts/automation/contract'],
    { projectRoot: repoRoot },
  )
  assert.equal(benchmark.createPlan(benchmarkOptions).readOnlyDataset, true)
  assert.equal(benchmarkOptions.plan, true)

  const auditOptions = sourceAudit.parseArgs(['--source=D:\\fixtures', '--plan'])
  assert.equal(auditOptions.plan, true)
  const auditSource = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'audit-source-derived-data.cjs'),
    'utf8',
  )
  assert.doesNotMatch(auditSource, /argument === ['"]--execute['"]/)
  assert.match(auditSource, /confirmationTokenPersisted: false/)
})

test('nightly workflow is scheduled, self-hosted, redacted and never opts into product mutation', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'nightly-automation.yml'),
    'utf8',
  )
  assert.match(workflow, /schedule:/)
  assert.match(workflow, /cron: '30 12 \* \* \*'/)
  assert.match(workflow, /runs-on: \[self-hosted, Windows, X64, floating-clock-models\]/)
  assert.match(workflow, /npm\.cmd run automation:nightly/)
  assert.match(workflow, /actions\/upload-artifact@v4/)
  assert.match(workflow, /retention-days: 14/)
  assert.match(workflow, /if-no-files-found: error/)
  assert.match(workflow, /SIFTORY_AUTOMATION_BASELINE/)
  assert.match(workflow, /--allow-network/)
  assert.match(workflow, /--allow-generated-clean/)
  assert.doesNotMatch(workflow, /--execute|--allow-download|accept-.*license|release:gate/)

  const plan = nightly.createPlan(
    {
      mode: 'full',
      datasetPath: 'D:\\fixtures',
      sourcePath: 'D:\\fixtures',
      outputDir: path.join(repoRoot, 'artifacts', 'automation', 'contract-nightly'),
      plan: true,
      json: true,
      redactPaths: true,
      skipBenchmark: false,
      skipSourceAudit: false,
      skipQuality: false,
      allowNetwork: true,
      allowGeneratedClean: true,
    },
    () => true,
  )
  assert.equal(plan.readOnlySources, true)
  assert.ok(plan.stages.every((stage) => !stage.args.includes('--execute')))
  assert.ok(plan.stages.every((stage) => !stage.args.includes('--allow-download')))
  assert.deepEqual(
    plan.stages.map((stage) => stage.id),
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
  const workflowTimeoutMinutes = Number(workflow.match(/timeout-minutes:\s*(\d+)/)?.[1])
  assert.ok(Number.isFinite(workflowTimeoutMinutes))
  assert.ok(workflowTimeoutMinutes * 60 * 1000 > plan.timeoutBudgetMs)
  const benchmarkStage = plan.stages.find((stage) => stage.id === 'benchmark')
  const benchmarkPlan = benchmark.createPlan(
    {
      mode: 'full',
      dataset: 'D:\\fixtures',
      outputDirectory: path.join(repoRoot, 'artifacts', 'automation', 'contract-benchmark'),
      imageSample: 1000,
      pairedRuns: 3,
      baseline: null,
      thresholdPercent: 10,
    },
    { npm: { command: 'node', prefixArgs: [], display: 'npm' } },
  )
  assert.ok(benchmarkStage.timeoutMs > benchmarkPlan.timeoutBudgetMs)
})
