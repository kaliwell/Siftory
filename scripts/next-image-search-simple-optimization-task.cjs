const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_PLAN = path.join(
  __dirname,
  '..',
  'docs',
  'current',
  '2026-08-08-image-search-simple-mode-optimization-todo.md',
)
const ACTIVE = new Set(['pending', 'in_progress', 'implemented'])
const VALID_MODES = new Set(['auto', 'observation', 'triggered'])
const VALID_STATUSES = new Set([
  'pending',
  'in_progress',
  'implemented',
  'verified',
  'blocked',
  'deferred',
])

function splitList(value) {
  if (!value || value === '-') return []
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function parseTasks(markdown) {
  const tasks = []
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\|\s*\d+\s*\|\s*SMP-\d{3}\s*\|/.test(line)) continue
    const columns = line.split('|').slice(1, -1).map((value) => value.trim())
    if (columns.length !== 8) continue
    const [rank, id, value, mode, dependencies, status, validation, task] = columns
    tasks.push({
      rank: Number(rank),
      id,
      value: Number(value),
      mode,
      dependencies: splitList(dependencies),
      status,
      validation,
      task,
    })
  }
  return tasks.sort((left, right) => left.rank - right.rank)
}

function validateTasks(tasks) {
  const errors = []
  const ids = new Set(tasks.map((task) => task.id))
  tasks.forEach((task, index) => {
    if (task.rank !== index + 1) errors.push(`${task.id}: rank must be ${index + 1}`)
    if (!Number.isInteger(task.value) || task.value < 1 || task.value > 100) {
      errors.push(`${task.id}: value must be an integer from 1 to 100`)
    }
    if (index > 0 && tasks[index - 1].value < task.value) {
      errors.push(`${task.id}: tasks must be sorted by descending value`)
    }
    if (!VALID_MODES.has(task.mode)) errors.push(`${task.id}: invalid mode ${task.mode}`)
    if (!VALID_STATUSES.has(task.status)) errors.push(`${task.id}: invalid status ${task.status}`)
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) errors.push(`${task.id}: unknown dependency ${dependency}`)
    }
  })
  return errors
}

function selectNext(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return (
    tasks
      .filter(
        (task) =>
          task.mode === 'auto' &&
          ACTIVE.has(task.status) &&
          task.dependencies.every((id) => byId.get(id)?.status === 'verified'),
      )
      .sort((left, right) => {
        const resume = { implemented: 0, in_progress: 1, pending: 2 }
        return resume[left.status] - resume[right.status] || right.value - left.value
      })[0] || null
  )
}

function snapshot(markdown) {
  const tasks = parseTasks(markdown)
  const errors = validateTasks(tasks)
  return {
    ok: tasks.length > 0 && errors.length === 0,
    errors,
    next: errors.length === 0 ? selectNext(tasks) : null,
    counts: {
      total: tasks.length,
      verified: tasks.filter((task) => task.status === 'verified').length,
      active: tasks.filter((task) => ACTIVE.has(task.status)).length,
      deferred: tasks.filter((task) => task.status === 'deferred').length,
    },
  }
}

function main() {
  const plan = path.resolve(
    process.argv.slice(2).find((value) => !value.startsWith('--')) || DEFAULT_PLAN,
  )
  const result = snapshot(fs.readFileSync(plan, 'utf8'))
  if (process.argv.includes('--check')) {
    if (result.ok) process.stdout.write(`[simple-mode-todo] passed: ${result.counts.total} task(s)\n`)
    else process.stderr.write(`${result.errors.join('\n') || 'No Simple mode tasks found'}\n`)
  } else {
    process.stdout.write(`${JSON.stringify({ plan, ...result }, null, 2)}\n`)
  }
  if (!result.ok) process.exitCode = 1
}

if (require.main === module) main()

module.exports = { parseTasks, selectNext, snapshot, validateTasks }
