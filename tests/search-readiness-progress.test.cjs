const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')
const { searchReadinessProgress } = loadTsModule('src/services/searchReadinessProgress.ts')
const idle = { state: 'idle', percent: 0, stepPercent: 0, stepIndex: 0, totalSteps: 4 }

test('collapsed readiness uses real workflow progress and keeps uncertain stages indeterminate', () => {
  assert.deepEqual(
    searchReadinessProgress({ ...idle, state: 'running', percent: 43 }, undefined, 'idle'),
    { state: 'running', percent: 43, indeterminate: false },
  )
  assert.equal(
    searchReadinessProgress(
      { ...idle, state: 'running', percent: 43, indeterminate: true },
      undefined,
      'scanning',
    ).indeterminate,
    true,
  )
  for (const state of ['scanning', 'indexing', 'queued', 'paused'])
    assert.equal(searchReadinessProgress(idle, undefined, state).indeterminate, true)
})
test('background embeddings supersede stale completed workflows', () => {
  const embedding = { state: 'running', total: 100, completed: 30, failed: 5, skipped: 5 }
  assert.deepEqual(
    searchReadinessProgress({ ...idle, state: 'done', percent: 100 }, embedding, 'idle'),
    { state: 'running', percent: 40, indeterminate: false },
  )
})
test('idle, terminal, error and invalid percentages never fabricate active progress', () => {
  assert.deepEqual(searchReadinessProgress(idle, undefined, 'idle'), {
    state: 'idle',
    percent: 0,
    indeterminate: false,
  })
  assert.equal(searchReadinessProgress({ ...idle, state: 'done' }, undefined, 'idle').percent, 100)
  assert.equal(
    searchReadinessProgress({ ...idle, state: 'done', percent: 100 }, undefined, 'error').state,
    'error',
  )
  assert.equal(
    searchReadinessProgress({ ...idle, state: 'cancelled', percent: 25 }, undefined, 'idle').state,
    'cancelled',
  )
  for (const percent of [NaN, Infinity, -1])
    assert.equal(searchReadinessProgress({ ...idle, percent }, undefined, 'idle').percent, 0)
  assert.equal(searchReadinessProgress({ ...idle, percent: 120 }, undefined, 'idle').percent, 100)
})
