const assert = require('node:assert/strict')
const test = require('node:test')

const {
  buildTodoSnapshot,
  parseTaskRows,
  selectReadyTasks,
} = require('../scripts/next-optimization-task.cjs')

const PLAN = `
| 顺序 | ID | 优先级 | 任务 | 依赖 | 建议分支 | 状态 |
| ---: | -- | ------ | ---- | ---- | -------- | ---- |
| 1 | REL-01 | P1 | first | 无 | \`task/first\` | 已验证 |
| 2 | REL-02 | P1 | second | REL-01 | \`task/second\` | 待做 |
| 3 | DSK-01 | P1 | parallel | 无 | \`fix/parallel\` | 待做 |
| 4 | REL-03 | P1 | blocked | REL-02、DSK-01 | \`task/blocked\` | 待做 |
| 5 | I18N-04 | P1 | numeric prefix | REL-03 | \`test/i18n\` | 待做 |
| 6 | SEC-01 | P2 | milestone | P1 发布链稳定 | \`fix/security\` | 待做 |
| 7 | ACC-01 | P1 | optional peer | DSK-01，可与 I18N-04 联动 | \`perf/accuracy\` | 待做 |
| 8 | ACC-02 | P1 | deferred manual data | 无 | \`test/manual\` | 暂缓 |
| 9 | GIT-01 | P2 | explicit blocker | 无 | \`chore/backup\` | 阻塞 |
`

test('optimization TODO parser reads the canonical task table', () => {
  const tasks = parseTaskRows(PLAN)
  assert.equal(tasks.length, 9)
  assert.deepEqual(tasks[3].dependencies, ['REL-02', 'DSK-01'])
  assert.equal(tasks[1].branch, 'task/second')
  assert.deepEqual(tasks[4].dependencies, ['REL-03'])
  assert.deepEqual(tasks[5].milestoneDependencies, ['P1 发布链稳定'])
  assert.deepEqual(tasks[6].dependencies, ['DSK-01'])
})

test('optimization TODO parser preserves explicit external blockers alongside task dependencies', () => {
  const tasks = parseTaskRows(`
| 顺序 | ID | 优先级 | 任务 | 依赖 | 建议分支 | 状态 |
| ---: | -- | ------ | ---- | ---- | -------- | ---- |
| 1 | BLD-01 | P1 | build | 无 | \`build/base\` | 已验证 |
| 2 | LIC-01 | P1 | license | BLD-01；外部：版权负责人批准最终 EULA | \`docs/license\` | 阻塞 |
`)
  assert.deepEqual(tasks[1].dependencies, ['BLD-01'])
  assert.deepEqual(tasks[1].externalDependencies, ['版权负责人批准最终 EULA'])
  assert.deepEqual(buildTodoSnapshot(tasks).blocked[0].waitingFor, ['版权负责人批准最终 EULA'])
})

test('optimization TODO selector returns dependency-ready tasks in plan order', () => {
  const ready = selectReadyTasks(parseTaskRows(PLAN))
  assert.deepEqual(
    ready.map((task) => task.id),
    ['REL-02', 'DSK-01'],
  )
})

test('optimization TODO snapshot explains blocked dependencies', () => {
  const snapshot = buildTodoSnapshot(parseTaskRows(PLAN))
  assert.equal(snapshot.selected.id, 'REL-02')
  assert.deepEqual(snapshot.blocked[0].waitingFor, ['REL-02', 'DSK-01'])
  assert.deepEqual(snapshot.blocked[2].waitingFor, [
    'REL-02',
    'DSK-01',
    'REL-03',
    'I18N-04',
    'ACC-01',
    'ACC-02',
  ])
  assert.equal(snapshot.blocked.at(-1).id, 'GIT-01')
  assert.deepEqual(snapshot.counts, {
    total: 9,
    completed: 1,
    deferred: 1,
    pending: 6,
    ready: 2,
    blocked: 5,
  })
})
