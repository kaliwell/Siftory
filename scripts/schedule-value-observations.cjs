#!/usr/bin/env node

const fsp = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')

const {
  parseArgs: parseAutomationArgs,
  runAutomation,
} = require('./run-value-optimization-todo.cjs')

const projectRoot = path.resolve(__dirname, '..')

function valueAfter(argument, prefix) {
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : undefined
}

function parseArgs(argv) {
  const userDataPath = path.join(process.env.APPDATA || '', 'floating-clock-electron')
  const valueAutomationPath = path.join(userDataPath, 'value-automation')
  const options = {
    userDataPath,
    vectorStatePaths: [
      path.join(valueAutomationPath, 'vector-coverage-repair-state.json'),
      path.join(valueAutomationPath, 'vector-rebuild-state.json'),
    ],
    automationStatePath: path.join(
      projectRoot,
      'artifacts',
      'value-optimization',
      'automation-state.json',
    ),
    reportPath: path.join(projectRoot, 'artifacts', 'value-optimization', 'last-run.json'),
    lockPath: path.join(valueAutomationPath, 'value-observations.lock'),
    retryMs: 60 * 60 * 1000,
    approvalPollMs: 60 * 60 * 1000,
  }
  let vectorStateExplicit = false
  let lockExplicit = false
  for (const argument of argv) {
    const userData = valueAfter(argument, '--user-data=')
    const vectorState = valueAfter(argument, '--vector-state=')
    const automationState = valueAfter(argument, '--automation-state=')
    const report = valueAfter(argument, '--report=')
    const lock = valueAfter(argument, '--lock=')
    const retryMs = valueAfter(argument, '--retry-ms=')
    const approvalPollMs = valueAfter(argument, '--approval-poll-ms=')
    if (userData !== undefined) options.userDataPath = path.resolve(userData)
    else if (vectorState !== undefined) {
      options.vectorStatePaths = [path.resolve(vectorState)]
      vectorStateExplicit = true
    } else if (automationState !== undefined) {
      options.automationStatePath = path.resolve(automationState)
    } else if (report !== undefined) options.reportPath = path.resolve(report)
    else if (lock !== undefined) {
      options.lockPath = path.resolve(lock)
      lockExplicit = true
    } else if (retryMs !== undefined) options.retryMs = Math.max(1000, Number(retryMs) || 0)
    else if (approvalPollMs !== undefined) {
      options.approvalPollMs = Math.max(60 * 1000, Number(approvalPollMs) || 0)
    } else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!vectorStateExplicit) {
    const automationPath = path.join(options.userDataPath, 'value-automation')
    options.vectorStatePaths = [
      path.join(automationPath, 'vector-coverage-repair-state.json'),
      path.join(automationPath, 'vector-rebuild-state.json'),
    ]
  }
  if (!lockExplicit) {
    options.lockPath = path.join(
      options.userDataPath,
      'value-automation',
      'value-observations.lock',
    )
  }
  options.vectorStatePath = options.vectorStatePaths[0]
  return options
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireObservationLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  if (fs.existsSync(lockPath)) {
    let ownerPid = 0
    try {
      ownerPid = Number(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid)
    } catch {
      /* An unreadable lock has no live owner evidence. */
    }
    if (processExists(ownerPid)) {
      throw new Error(`Value optimization scheduler is already running as PID ${ownerPid}`)
    }
    fs.renameSync(lockPath, `${lockPath}.stale-${Date.now()}`)
  }
  const descriptor = fs.openSync(lockPath, 'wx')
  try {
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    )
  } catch (error) {
    fs.closeSync(descriptor)
    try {
      fs.unlinkSync(lockPath)
    } catch {
      /* Preserve the original lock write failure. */
    }
    throw error
  }
  return () => {
    try {
      fs.closeSync(descriptor)
    } finally {
      try {
        fs.unlinkSync(lockPath)
      } catch {
        /* A stale lock is recovered only after its owner is proven absent. */
      }
    }
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function nextObservationRunAt(result, nowMs, retryMs) {
  if (result?.completionReady === true) return undefined
  const dueAt = Date.parse(result?.dueAt)
  if (result?.due === false && Number.isFinite(dueAt) && dueAt > nowMs) return dueAt
  return nowMs + retryMs
}

function nextOptimizationRunAt(results, nowMs, retryMs, approvalPollMs) {
  const recall = results.find((item) => item.id === 'VAL-003')
  const cuda = results.find((item) => item.id === 'VAL-011')
  const candidates = []
  if (recall && recall.completionReady !== true) {
    candidates.push(nextObservationRunAt(recall, nowMs, retryMs) ?? nowMs + retryMs)
  }
  if (cuda && cuda.completionReady !== true) candidates.push(nowMs + approvalPollMs)
  return candidates.length > 0 ? Math.min(...candidates) : undefined
}

function summarizeScheduledResults(report) {
  return {
    generatedAt: report.generatedAt,
    results: report.results.map((item) =>
      item.id === 'VAL-003'
        ? {
            id: item.id,
            acceptedCycles: item.acceptedCycles,
            requiredCycles: item.requiredCycles,
            completionReady: item.completionReady,
            dueAt: item.dueAt,
            snapshotFingerprint: item.snapshotFingerprint,
          }
        : {
            id: item.id,
            technicalReady: item.technicalReady,
            completionReady: item.completionReady,
            incompleteComponents: item.approval?.filter((entry) => !entry.complete).length,
            projectApprovalComplete: item.projectApproval?.complete === true,
            postApprovalVerification: item.postApprovalVerification?.status,
          },
    ),
  }
}

async function readVectorCompletion(options) {
  const states = await Promise.all(
    options.vectorStatePaths.map(async (filePath) => ({
      filePath,
      state: await readJson(filePath),
    })),
  )
  const completed = states.find(({ state }) => state?.phase === 'completed')
  return {
    completed: completed ? { ...completed.state, stateFile: completed.filePath } : undefined,
    phases: states.map(({ filePath, state }) => ({
      stateFile: filePath,
      phase: state?.phase || 'unavailable',
    })),
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const releaseLock = acquireObservationLock(options.lockPath)
  try {
    const vector = await readVectorCompletion(options)
    if (!vector.completed) {
      process.stdout.write(
        `${JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            status: 'skipped',
            reason: 'vector-rebuild-not-completed',
            vectorStates: vector.phases,
          },
          null,
          2,
        )}\n`,
      )
      return
    }
    const automationOptions = parseAutomationArgs([
      '--task=VAL-003',
      '--task=VAL-011',
      `--user-data=${options.userDataPath}`,
      `--state=${options.automationStatePath}`,
      `--report=${options.reportPath}`,
    ])
    const report = await runAutomation(automationOptions)
    const nextAt = nextOptimizationRunAt(
      report.results,
      Date.now(),
      options.retryMs,
      options.approvalPollMs,
    )
    process.stdout.write(
      `${JSON.stringify(
        {
          ...summarizeScheduledResults(report),
          status: report.results.every((item) => item.completionReady === true)
            ? 'completed'
            : 'waiting',
          recommendedNextRunAt: nextAt ? new Date(nextAt).toISOString() : undefined,
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    releaseLock()
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = {
  acquireObservationLock,
  main,
  nextOptimizationRunAt,
  nextObservationRunAt,
  parseArgs,
  processExists,
  readVectorCompletion,
  readJson,
  summarizeScheduledResults,
}
