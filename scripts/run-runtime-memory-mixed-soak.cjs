#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const SCHEMA = 'siftory-runtime-memory-mixed-soak/v1'
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const EMBEDDED_PATH_PATTERN =
  /(?:[a-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:users|home|root|tmp|var|etc|mnt|volumes)\/)[^\r\n"']*/gi
const SECRET_PATTERN =
  /\b(password|passphrase|token|secret|private[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi

function redactDiagnostic(value) {
  return String(value || '')
    .replaceAll('\u0000', '')
    .replace(SECRET_PATTERN, '$1=[redacted]')
    .replace(EMBEDDED_PATH_PATTERN, '[path]')
}

function option(argv, name, fallback = '') {
  return argv.find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function parseArgs(argv, projectRoot = path.resolve(__dirname, '..')) {
  const known = new Set(['--plan'])
  for (const entry of argv) {
    if (known.has(entry)) continue
    if (!/^--(?:duration-min|output-dir)=/.test(entry)) {
      throw new Error(`Unknown mixed soak argument: ${entry}`)
    }
  }
  const durationMin = Number(option(argv, 'duration-min', '120'))
  if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > 8 * 60) {
    throw new Error('--duration-min must be an integer between 1 and 480')
  }
  const allowedRoot = path.join(projectRoot, 'artifacts', 'benchmark', 'runtime-memory')
  const outputDir = path.resolve(option(argv, 'output-dir', path.join(allowedRoot, 'mixed-soak')))
  const relative = path.relative(allowedRoot, outputDir)
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('--output-dir must stay under artifacts/benchmark/runtime-memory')
  }
  return { durationMin, outputDir, plan: argv.includes('--plan'), projectRoot }
}

function buildActionPlan(projectRoot, outputDir, batch) {
  const at = (...parts) => path.join(projectRoot, ...parts)
  const modelOutput = path.join(outputDir, `batch-${String(batch).padStart(6, '0')}-model`)
  return [
    {
      id: 'search',
      units: 6,
      timeoutMs: 30 * 60 * 1000,
      args: [at('tests', 'vector-ann-real-benchmark.cjs'), '6'],
    },
    {
      id: 'uiChurn',
      units: 2,
      timeoutMs: 10 * 60 * 1000,
      args: [
        at('tests', 'electron-ui-smoke.cjs'),
        '--churn-cycles=2',
        `--artifact-parent=${path.join(outputDir, 'ui-smoke')}`,
      ],
    },
    {
      id: 'cancelRecovery',
      units: 1,
      timeoutMs: 5 * 60 * 1000,
      args: [
        '--test',
        at('tests', 'unified-task-scheduler.test.cjs'),
        at('tests', 'image-search-shutdown.test.cjs'),
      ],
    },
    {
      id: 'playbackModel',
      units: 1,
      timeoutMs: 30 * 60 * 1000,
      args: [
        at('scripts', 'run-runtime-memory-model-session.cjs'),
        '--repetitions=1',
        `--output-dir=${modelOutput}`,
      ],
    },
  ]
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || '').trim())
  } catch {
    return null
  }
}

function validateAction(id, execution) {
  if (execution.timedOut) return { ok: false, code: 'timeout' }
  if (execution.truncated) return { ok: false, code: 'output-bound-exceeded' }
  if (execution.exitCode !== 0) return { ok: false, code: 'nonzero-exit' }
  if (id === 'cancelRecovery') return { ok: true }
  const report = parseJson(execution.stdout)
  if (!report) return { ok: false, code: 'missing-json' }
  if (id === 'search') {
    return report.gate?.passed === true && report.safety?.sourceFilesUnchanged === true
      ? { ok: true }
      : { ok: false, code: 'search-gate' }
  }
  if (id === 'uiChurn') {
    const churn = report.snapshot?.lifecycleChurnCheck
    return report.ok === true && churn?.completedCycles === 2 && churn?.finalPanelPresent === true
      ? { ok: true }
      : { ok: false, code: 'ui-lifecycle-gate' }
  }
  if (id === 'playbackModel') {
    return report.status === 'passed' &&
      report.completedCycles === 8 &&
      report.safety?.sourceFilesUnchanged === true
      ? { ok: true }
      : { ok: false, code: 'model-lifecycle-gate' }
  }
  return { ok: false, code: 'unknown-action' }
}

function boundedCollector() {
  const chunks = []
  let bytes = 0
  let truncated = false
  return {
    append(chunk) {
      if (truncated) return
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      const available = MAX_CAPTURE_BYTES - bytes
      if (value.length > available) {
        chunks.push(value.subarray(0, Math.max(0, available)))
        bytes = MAX_CAPTURE_BYTES
        truncated = true
      } else {
        chunks.push(value)
        bytes += value.length
      }
    },
    result() {
      return { text: Buffer.concat(chunks).toString('utf8'), truncated }
    },
  }
}

async function executeAction(action, options = {}) {
  const executable = options.executable || process.execPath
  const cwd = options.cwd || process.cwd()
  const stdout = boundedCollector()
  const stderr = boundedCollector()
  const child = spawn(executable, action.args, {
    cwd,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => stdout.append(chunk))
  child.stderr.on('data', (chunk) => stderr.append(chunk))
  let timedOut = false
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, action.timeoutMs)
    child.once('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  const out = stdout.result()
  const err = stderr.result()
  return {
    exitCode,
    stdout: out.text,
    stderr: err.text,
    timedOut,
    truncated: out.truncated || err.truncated,
  }
}

function workloadSummary(counts) {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  const expected = { search: 0.6, uiChurn: 0.2, cancelRecovery: 0.1, playbackModel: 0.1 }
  return Object.fromEntries(
    Object.entries(expected).map(([id, targetShare]) => [
      id,
      {
        completedUnits: counts[id] || 0,
        share: total > 0 ? (counts[id] || 0) / total : 0,
        targetShare,
      },
    ]),
  )
}

async function runMixedSoak(options, dependencies = {}) {
  fs.mkdirSync(options.outputDir, { recursive: true })
  const runRoot = fs.mkdtempSync(path.join(options.outputDir, 'run-'))
  const actionLogRoot = path.join(runRoot, 'actions')
  fs.mkdirSync(actionLogRoot)
  const execute = dependencies.executeAction || executeAction
  const now = dependencies.now || Date.now
  const startedAtMs = now()
  const deadline = startedAtMs + options.durationMin * 60 * 1000
  const counts = { search: 0, uiChurn: 0, cancelRecovery: 0, playbackModel: 0 }
  const actionRecords = []
  const failures = []
  let completedBatches = 0

  do {
    const batch = completedBatches + 1
    let batchPassed = true
    for (const action of buildActionPlan(options.projectRoot, runRoot, batch)) {
      const actionStartedAt = now()
      const execution = await execute(action, {
        cwd: options.projectRoot,
        executable: process.execPath,
      })
      const validation = validateAction(action.id, execution)
      const logBase = `batch-${String(batch).padStart(6, '0')}-${action.id}`
      const stdoutLog = redactDiagnostic(execution.stdout)
      const stderrLog = redactDiagnostic(execution.stderr)
      fs.writeFileSync(path.join(actionLogRoot, `${logBase}.stdout.txt`), stdoutLog, {
        encoding: 'utf8',
        flag: 'wx',
      })
      fs.writeFileSync(path.join(actionLogRoot, `${logBase}.stderr.txt`), stderrLog, {
        encoding: 'utf8',
        flag: 'wx',
      })
      actionRecords.push({
        batch,
        id: action.id,
        units: action.units,
        durationMs: Math.max(0, now() - actionStartedAt),
        status: validation.ok ? 'passed' : 'failed',
        stdoutBytes: Buffer.byteLength(stdoutLog),
        stderrBytes: Buffer.byteLength(stderrLog),
        stdoutSha256: crypto.createHash('sha256').update(stdoutLog).digest('hex'),
        stderrSha256: crypto.createHash('sha256').update(stderrLog).digest('hex'),
        ...(validation.ok ? {} : { code: validation.code }),
      })
      if (!validation.ok) {
        failures.push({ batch, id: action.id, code: validation.code })
        batchPassed = false
        break
      }
      counts[action.id] += action.units
    }
    if (!batchPassed) break
    completedBatches += 1
  } while (now() < deadline)

  const completedCycles = Object.values(counts).reduce((sum, value) => sum + value, 0)
  const actualDurationMs = Math.max(0, now() - startedAtMs)
  const workload = workloadSummary(counts)
  const exactShares = Object.values(workload).every(
    (entry) => Math.abs(entry.share - entry.targetShare) < Number.EPSILON,
  )
  const status =
    failures.length === 0 &&
    completedBatches > 0 &&
    actualDurationMs >= options.durationMin * 60 * 1000 &&
    exactShares
      ? 'passed'
      : 'failed'
  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status,
    targetDurationMs: options.durationMin * 60 * 1000,
    actualDurationMs,
    completedBatches,
    completedCycles,
    workload,
    failures,
    safety: {
      artifactBoundaryMaintained: true,
      sourceFilesUnchanged: failures.every(
        (failure) => !['search-gate', 'model-lifecycle-gate'].includes(failure.code),
      ),
    },
    actionDigest: crypto
      .createHash('sha256')
      .update(JSON.stringify(actionRecords))
      .digest('hex'),
    actions: actionRecords,
  }
  const reportPath = path.join(runRoot, 'report.json')
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}

if (require.main === module) {
  Promise.resolve()
    .then(async () => {
      const options = parseArgs(process.argv.slice(2))
      if (options.plan) {
        const plan = {
          schema: SCHEMA,
          status: 'planned',
          durationMin: options.durationMin,
          workload: workloadSummary({ search: 6, uiChurn: 2, cancelRecovery: 1, playbackModel: 1 }),
        }
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
        return
      }
      const report = await runMixedSoak(options)
      process.stdout.write(`${JSON.stringify(report)}\n`)
      if (report.status !== 'passed') process.exitCode = 1
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}

module.exports = {
  buildActionPlan,
  parseArgs,
  runMixedSoak,
  validateAction,
  workloadSummary,
  redactDiagnostic,
}
