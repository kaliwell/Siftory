const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_PLAN_PATH = path.join(
  __dirname,
  '..',
  'docs',
  'current',
  '2026-08-07-value-ranked-optimization-todo.md',
)

const TASK_ID_PATTERN = /^VAL-\d{3}$/
const MODES = new Set(['auto', 'approval', 'observation', 'triggered'])
const STATUSES = new Set(['pending', 'in_progress', 'implemented', 'verified', 'blocked', 'deferred'])
const ACTIVE_STATUSES = new Set(['pending', 'in_progress', 'implemented'])
const RESUME_ORDER = new Map([
  ['implemented', 0],
  ['in_progress', 1],
  ['pending', 2],
])

function splitList(value) {
  if (!value || value === '-') return []
  return value
    .split(/[,;；、]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseValueTaskRows(markdown) {
  const tasks = []
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\|\s*\d+\s*\|\s*VAL-\d{3}\s*\|/.test(line)) continue
    const columns = line
      .split('|')
      .slice(1, -1)
      .map((value) => value.trim())
    if (columns.length !== 10) continue
    const [rank, id, value, mode, dependencyText, blockerText, branch, status, validation, title] =
      columns
    tasks.push({
      rank: Number(rank),
      id,
      value: Number(value),
      mode,
      dependencies: splitList(dependencyText),
      externalBlockers: splitList(blockerText),
      branch: branch.replaceAll('`', ''),
      status,
      validation: validation.replaceAll('`', ''),
      title,
    })
  }
  return tasks.sort((left, right) => left.rank - right.rank)
}

function validateValueTasks(tasks) {
  const errors = []
  const ids = new Set()
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index]
    if (task.rank !== index + 1) errors.push(`${task.id}: rank must be ${index + 1}`)
    if (!TASK_ID_PATTERN.test(task.id)) errors.push(`${task.id}: invalid id`)
    if (ids.has(task.id)) errors.push(`${task.id}: duplicate id`)
    ids.add(task.id)
    if (!Number.isInteger(task.value) || task.value < 1 || task.value > 100) {
      errors.push(`${task.id}: value must be an integer from 1 to 100`)
    }
    if (index > 0 && tasks[index - 1].value < task.value) {
      errors.push(`${task.id}: tasks must be sorted by descending value`)
    }
    if (!MODES.has(task.mode)) errors.push(`${task.id}: invalid mode ${task.mode}`)
    if (!STATUSES.has(task.status)) errors.push(`${task.id}: invalid status ${task.status}`)
    if (!task.branch) errors.push(`${task.id}: branch is required`)
    if (!task.validation) errors.push(`${task.id}: validation is required`)
  }

  const byId = new Map(tasks.map((task) => [task.id, task]))
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency)) errors.push(`${task.id}: unknown dependency ${dependency}`)
      if (dependency === task.id) errors.push(`${task.id}: self dependency`)
    }
  }

  const visiting = new Set()
  const visited = new Set()
  function visit(id) {
    if (visiting.has(id)) {
      errors.push(`${id}: dependency cycle`)
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependencies || []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks) visit(task.id)
  return [...new Set(errors)]
}

function taskWaitingFor(task, byId) {
  const waitingFor = task.dependencies.filter(
    (dependency) => byId.get(dependency)?.status !== 'verified',
  )
  waitingFor.push(...task.externalBlockers)
  if (task.mode !== 'auto') waitingFor.push(`mode:${task.mode}`)
  return waitingFor
}

function selectReadyValueTasks(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return tasks
    .filter(
      (task) =>
        task.mode === 'auto' &&
        ACTIVE_STATUSES.has(task.status) &&
        taskWaitingFor(task, byId).length === 0,
    )
    .sort(
      (left, right) =>
        RESUME_ORDER.get(left.status) - RESUME_ORDER.get(right.status) ||
        right.value - left.value ||
        left.rank - right.rank,
    )
}

function buildValueTodoSnapshot(tasks) {
  const errors = validateValueTasks(tasks)
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const ready = errors.length === 0 ? selectReadyValueTasks(tasks) : []
  const unfinished = tasks.filter((task) => task.status !== 'verified')
  const blocked = unfinished
    .filter((task) => !ready.includes(task) && task.status !== 'deferred')
    .map((task) => ({ ...task, waitingFor: taskWaitingFor(task, byId) }))
  return {
    ok: tasks.length > 0 && errors.length === 0,
    generatedAt: new Date().toISOString(),
    errors,
    selected: ready[0] || null,
    ready,
    blocked,
    counts: {
      total: tasks.length,
      verified: tasks.filter((task) => task.status === 'verified').length,
      deferred: tasks.filter((task) => task.status === 'deferred').length,
      active: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
      ready: ready.length,
      blocked: blocked.length,
    },
  }
}

function main() {
  const argumentsWithoutFlags = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
  const planPath = path.resolve(argumentsWithoutFlags[0] || DEFAULT_PLAN_PATH)
  const tasks = parseValueTaskRows(fs.readFileSync(planPath, 'utf8'))
  const snapshot = buildValueTodoSnapshot(tasks)
  if (process.argv.includes('--check')) {
    if (snapshot.ok) process.stdout.write(`[value-todo] passed: ${tasks.length} task(s)\n`)
    else process.stderr.write(`${snapshot.errors.join('\n') || 'No value-ranked tasks found'}\n`)
  } else {
    process.stdout.write(`${JSON.stringify({ planPath, ...snapshot }, null, 2)}\n`)
  }
  if (!snapshot.ok) process.exitCode = 1
}

if (require.main === module) main()

module.exports = {
  buildValueTodoSnapshot,
  parseValueTaskRows,
  selectReadyValueTasks,
  validateValueTasks,
}
