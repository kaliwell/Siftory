const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  buildValueTodoSnapshot,
  parseValueTaskRows,
  selectReadyValueTasks,
  validateValueTasks,
} = require('../scripts/next-value-optimization-task.cjs')

const HEADER = `
| Rank | ID | Value | Mode | Dependencies | External blockers | Branch | Status | Validation | Task |
| ---: | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
`

const PLAN = `${HEADER}
| 1 | VAL-001 | 100 | approval | - | maintenance approval | \`ops/real-data\` | blocked | recall gate | real data |
| 2 | VAL-002 | 96 | auto | - | - | \`perf/ann-load\` | pending | test:vector-ann | ANN load |
| 3 | VAL-003 | 92 | observation | VAL-001 | stable cycles | \`docs/jsonl-retirement\` | blocked | review | JSONL retirement |
| 4 | VAL-004 | 88 | auto | VAL-002 | - | \`feat/jobs-epoch\` | pending | test:vector-pipeline | jobs epoch |
| 5 | VAL-005 | 70 | auto | - | - | \`perf/finished\` | verified | test | finished |
| 6 | VAL-006 | 30 | triggered | - | second env | \`feat/multi-env\` | deferred | test:native | multi env |
`

test('value TODO parser validates ranking, modes, dependencies, and safety gates', () => {
  const tasks = parseValueTaskRows(PLAN)
  assert.equal(tasks.length, 6)
  assert.deepEqual(validateValueTasks(tasks), [])
  assert.deepEqual(tasks[2].dependencies, ['VAL-001'])
  assert.deepEqual(tasks[0].externalBlockers, ['maintenance approval'])
})

test('value TODO selector chooses the highest-value safe automatic task', () => {
  const tasks = parseValueTaskRows(PLAN)
  assert.deepEqual(
    selectReadyValueTasks(tasks).map((task) => task.id),
    ['VAL-002'],
  )
  const snapshot = buildValueTodoSnapshot(tasks)
  assert.equal(snapshot.selected.id, 'VAL-002')
  assert.deepEqual(snapshot.blocked.find((task) => task.id === 'VAL-001').waitingFor, [
    'maintenance approval',
    'mode:approval',
  ])
  assert.deepEqual(snapshot.blocked.find((task) => task.id === 'VAL-004').waitingFor, [
    'VAL-002',
  ])
})

test('value TODO selector resumes active work before claiming a new task', () => {
  const tasks = parseValueTaskRows(
    PLAN.replace('| pending | test:vector-pipeline | jobs epoch |', '| in_progress | test:vector-pipeline | jobs epoch |')
      .replace('VAL-002 | 96', 'VAL-002 | 89')
      .replace('VAL-004 | 88', 'VAL-004 | 90')
      .replace('| VAL-003 | 92', '| VAL-003 | 91'),
  )
  tasks.find((task) => task.id === 'VAL-004').dependencies = []
  assert.equal(selectReadyValueTasks(tasks)[0].id, 'VAL-004')
})

test('value TODO validation rejects score drift and dependency cycles', () => {
  const tasks = parseValueTaskRows(PLAN)
  tasks[1].value = 101
  tasks[1].dependencies = ['VAL-004']
  tasks[3].dependencies = ['VAL-002']
  const errors = validateValueTasks(tasks)
  assert.ok(errors.some((error) => error.includes('value must be')))
  assert.ok(errors.some((error) => error.includes('dependency cycle')))
})

test('repository value TODO stays machine-readable and only auto-selects safe work', () => {
  const planPath = path.resolve(
    __dirname,
    '..',
    'docs',
    'current',
    '2026-08-07-value-ranked-optimization-todo.md',
  )
  const snapshot = buildValueTodoSnapshot(parseValueTaskRows(fs.readFileSync(planPath, 'utf8')))
  assert.equal(snapshot.ok, true, snapshot.errors.join('\n'))
  assert.ok(snapshot.counts.total >= 8)
  if (snapshot.selected) {
    assert.equal(snapshot.selected.mode, 'auto')
    assert.deepEqual(snapshot.selected.externalBlockers, [])
  }
})
