const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  buildValueTodoSnapshot,
  parseValueTaskRows,
} = require('../scripts/next-value-optimization-task.cjs')

const ROOT = path.resolve(__dirname, '..')
const PLAN_PATH = path.join(ROOT, 'docs', 'current', '2026-08-17-productization-auto-todo.md')

test('productization TODO is complete, ordered, and machine readable', () => {
  const tasks = parseValueTaskRows(fs.readFileSync(PLAN_PATH, 'utf8'))
  const snapshot = buildValueTodoSnapshot(tasks)

  assert.equal(snapshot.ok, true, snapshot.errors.join('\n'))
  assert.equal(tasks.length, 23)
  assert.deepEqual(
    tasks.map((task) => task.id),
    [
      ...Array.from({ length: 20 }, (_, index) => `VAL-${401 + index}`),
      'VAL-423',
      'VAL-421',
      'VAL-422',
    ],
  )
  assert.equal(tasks.find((task) => task.id === 'VAL-401').status, 'verified')
  assert.equal(snapshot.selected, null)
  assert.equal(snapshot.counts.verified, 20)
  assert.equal(snapshot.counts.ready, 0)
})

test('automatic items have no external blockers and real-world gates cannot auto-run', () => {
  const tasks = parseValueTaskRows(fs.readFileSync(PLAN_PATH, 'utf8'))
  const automatic = tasks.filter((task) => task.mode === 'auto')
  const external = tasks.filter((task) => task.mode === 'approval')

  assert.ok(automatic.length >= 20)
  assert.ok(automatic.every((task) => task.externalBlockers.length === 0))
  assert.deepEqual(
    external.map((task) => task.id),
    ['VAL-423', 'VAL-421', 'VAL-422'],
  )
  assert.ok(external.every((task) => task.status === 'blocked'))
  assert.ok(external.every((task) => task.externalBlockers.length > 0))
})

test('package scripts expose selection, structure validation, and focused tests', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

  assert.match(packageJson.scripts['todo:productization-next'], /productization-auto-todo\.md$/)
  assert.match(packageJson.scripts['todo:productization-check'], /--check$/)
  assert.match(packageJson.scripts['test:productization'], /productization-todo\.test\.cjs/)
  assert.match(packageJson.scripts['test:productization'], /product-readiness\.test\.cjs/)
})
