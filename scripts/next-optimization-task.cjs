const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_PLAN_PATH = path.join(
  __dirname,
  '..',
  'docs',
  'current',
  '2026-07-28-project-optimization-plan.md',
)

const COMPLETE_STATUS = '已验证'
const DEFERRED_STATUS = '暂缓'
const BLOCKED_STATUS = '阻塞'
const PENDING_STATUSES = new Set(['待做', '进行中', '已实现待验证'])
const TASK_ID_PATTERN = '[A-Z][A-Z0-9]*-\\d+'

function parseTaskRows(markdown) {
  const tasks = []

  for (const line of markdown.split(/\r?\n/)) {
    if (!new RegExp(`^\\|\\s*\\d+\\s*\\|\\s*${TASK_ID_PATTERN}\\s*\\|`).test(line)) continue
    const columns = line
      .split('|')
      .slice(1, -1)
      .map((value) => value.trim())
    if (columns.length !== 7) continue

    const [order, id, priority, title, dependencyText, branchText, status] = columns
    const explicitExternalDependencies = [...dependencyText.matchAll(/外部[:：]\s*([^；|]+)/g)].map(
      (match) => match[1].trim(),
    )
    const requiredDependencyText = dependencyText
      .replace(new RegExp(`可与\\s*${TASK_ID_PATTERN}\\s*联动`, 'g'), '')
      .replace(/外部[:：]\s*[^；|]+/g, '')
    const dependencies = requiredDependencyText.match(new RegExp(TASK_ID_PATTERN, 'g')) ?? []
    const priorityMilestone = dependencyText.match(/^P\d+\s*(?:发布链稳定|完成)$/)?.[0]
    tasks.push({
      order: Number(order),
      id,
      priority,
      title,
      dependencies,
      milestoneDependencies: priorityMilestone ? [priorityMilestone] : [],
      externalDependencies:
        explicitExternalDependencies.length > 0
          ? explicitExternalDependencies
          : dependencies.length === 0 && dependencyText !== '无' && !priorityMilestone
            ? [dependencyText]
            : [],
      branch: branchText.replaceAll('`', ''),
      status,
    })
  }

  return tasks.sort((left, right) => left.order - right.order)
}

function selectReadyTasks(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return tasks.filter(
    (task) =>
      PENDING_STATUSES.has(task.status) &&
      task.externalDependencies.length === 0 &&
      task.milestoneDependencies.every((milestone) => {
        const priority = milestone.match(/^P\d+/)?.[0]
        return tasks
          .filter((candidate) => candidate.priority === priority)
          .every((candidate) => candidate.status === COMPLETE_STATUS)
      }) &&
      task.dependencies.every((dependency) => byId.get(dependency)?.status === COMPLETE_STATUS),
  )
}

function buildTodoSnapshot(tasks) {
  const ready = selectReadyTasks(tasks)
  const pending = tasks.filter((task) => PENDING_STATUSES.has(task.status))
  const blocked = [
    ...pending.filter((task) => !ready.includes(task)),
    ...tasks.filter((task) => task.status === BLOCKED_STATUS),
  ]

  return {
    ok: tasks.length > 0,
    generatedAt: new Date().toISOString(),
    selected: ready[0] ?? null,
    ready,
    blocked: blocked.map((task) => ({
      ...task,
      waitingFor: task.dependencies
        .filter(
          (dependency) =>
            !tasks.some(
              (candidate) => candidate.id === dependency && candidate.status === COMPLETE_STATUS,
            ),
        )
        .concat(
          task.milestoneDependencies.flatMap((milestone) => {
            const priority = milestone.match(/^P\d+/)?.[0]
            return tasks
              .filter(
                (candidate) =>
                  candidate.priority === priority && candidate.status !== COMPLETE_STATUS,
              )
              .map((candidate) => candidate.id)
          }),
        )
        .concat(task.externalDependencies),
    })),
    counts: {
      total: tasks.length,
      completed: tasks.filter((task) => task.status === COMPLETE_STATUS).length,
      deferred: tasks.filter((task) => task.status === DEFERRED_STATUS).length,
      pending: pending.length,
      ready: ready.length,
      blocked: blocked.length,
    },
  }
}

function main() {
  const planPath = path.resolve(process.argv[2] || DEFAULT_PLAN_PATH)
  const tasks = parseTaskRows(fs.readFileSync(planPath, 'utf8'))
  const snapshot = buildTodoSnapshot(tasks)
  process.stdout.write(`${JSON.stringify({ planPath, ...snapshot }, null, 2)}\n`)
  if (!snapshot.ok) process.exitCode = 1
}

if (require.main === module) main()

module.exports = {
  buildTodoSnapshot,
  parseTaskRows,
  selectReadyTasks,
}
