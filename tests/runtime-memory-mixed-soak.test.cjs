'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const {
  buildActionPlan,
  parseArgs,
  redactDiagnostic,
  validateAction,
  workloadSummary,
} = require('../scripts/run-runtime-memory-mixed-soak.cjs')

const projectRoot = path.resolve(__dirname, '..')

test('mixed soak fixes the workload mix at 60/20/10/10', () => {
  const plan = buildActionPlan(projectRoot, path.join(projectRoot, 'artifacts', 'benchmark', 'runtime-memory', 'test'), 1)
  assert.deepEqual(
    plan.map(({ id, units }) => ({ id, units })),
    [
      { id: 'search', units: 6 },
      { id: 'uiChurn', units: 2 },
      { id: 'cancelRecovery', units: 1 },
      { id: 'playbackModel', units: 1 },
    ],
  )
  assert.deepEqual(workloadSummary({ search: 6, uiChurn: 2, cancelRecovery: 1, playbackModel: 1 }), {
    search: { completedUnits: 6, share: 0.6, targetShare: 0.6 },
    uiChurn: { completedUnits: 2, share: 0.2, targetShare: 0.2 },
    cancelRecovery: { completedUnits: 1, share: 0.1, targetShare: 0.1 },
    playbackModel: { completedUnits: 1, share: 0.1, targetShare: 0.1 },
  })
})

test('mixed soak output stays inside the managed runtime-memory artifact root', () => {
  assert.throws(
    () => parseArgs(['--output-dir=C:\\outside'], projectRoot),
    /must stay under/,
  )
  const parsed = parseArgs(['--duration-min=1', '--plan'], projectRoot)
  assert.equal(parsed.durationMin, 1)
  assert.equal(parsed.plan, true)
})

test('mixed soak validates every component gate fail closed', () => {
  const goodExecution = { exitCode: 0, timedOut: false, truncated: false }
  assert.equal(validateAction('cancelRecovery', goodExecution).ok, true)
  assert.equal(
    validateAction('search', {
      ...goodExecution,
      stdout: JSON.stringify({ gate: { passed: true }, safety: { sourceFilesUnchanged: true } }),
    }).ok,
    true,
  )
  assert.equal(
    validateAction('uiChurn', {
      ...goodExecution,
      stdout: JSON.stringify({
        ok: true,
        snapshot: { lifecycleChurnCheck: { completedCycles: 2, finalPanelPresent: true } },
      }),
    }).ok,
    true,
  )
  assert.equal(
    validateAction('playbackModel', {
      ...goodExecution,
      stdout: JSON.stringify({
        status: 'passed',
        completedCycles: 8,
        safety: { sourceFilesUnchanged: true },
      }),
    }).ok,
    true,
  )
  assert.deepEqual(validateAction('search', { ...goodExecution, stdout: '{}' }), {
    ok: false,
    code: 'search-gate',
  })
})

test('mixed soak child evidence is bounded upstream and redacted before persistence', () => {
  const value = redactDiagnostic(
    'password=hunter2 C:\\Users\\person\\private.onnx\n/tmp/private/runtime.log',
  )
  assert.doesNotMatch(value, /hunter2|C:\\Users|\/tmp\/private/)
  assert.match(value, /password=\[redacted\]/)
  assert.match(value, /\[path\]/)
})
