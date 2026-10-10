#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const AUTOMATION_ROOT = path.join(PROJECT_ROOT, 'artifacts', 'automation')
const DEFAULT_DATASET = process.env.SOURCE_AUDIT_DIR || '<SOURCE_AUDIT_DIR>'
const DEFAULT_THRESHOLD_PERCENT = 10
const MAX_CAPTURE_BYTES = 128 * 1024
const QUICK_IMAGE_SAMPLE = 16
const FULL_IMAGE_SAMPLE = 1000
const PAIRED_RUNS = 3
const MINUTE_MS = 60 * 1000
const BENCHMARK_STAGE_TIMEOUTS_MS = Object.freeze({
  quick: Object.freeze({
    imagePreparation: 40 * MINUTE_MS,
    imageAnalysis: 5 * MINUTE_MS,
  }),
  full: Object.freeze({
    imagePreparation: 100 * MINUTE_MS,
    imageAnalysis: 5 * MINUTE_MS,
    mediaPreparation: 65 * MINUTE_MS,
  }),
})

const METRIC_DEFINITIONS = Object.freeze([
  {
    suffix: 'libraryReadyMs.p50',
    label: 'Library ready P50',
    unit: 'ms',
    summary: 'libraryReady',
    statistic: 'p50',
    required: true,
  },
  {
    suffix: 'libraryReadyMs.p95',
    label: 'Library ready P95',
    unit: 'ms',
    summary: 'libraryReady',
    statistic: 'p95',
    required: true,
  },
  {
    suffix: 'totalMs.p50',
    label: 'Total duration P50',
    unit: 'ms',
    summary: 'total',
    statistic: 'p50',
    required: true,
  },
  {
    suffix: 'totalMs.p95',
    label: 'Total duration P95',
    unit: 'ms',
    summary: 'total',
    statistic: 'p95',
    required: true,
  },
  {
    suffix: 'mainPeakRssMiB.p50',
    label: 'Main peak RSS P50',
    unit: 'MiB',
    summary: 'mainRss',
    statistic: 'p50',
    required: false,
  },
  {
    suffix: 'mainPeakRssMiB.p95',
    label: 'Main peak RSS P95',
    unit: 'MiB',
    summary: 'mainRss',
    statistic: 'p95',
    required: false,
  },
  {
    suffix: 'childPeakAggregateRssMiBApprox.p50',
    label: 'Child aggregate peak RSS P50',
    unit: 'MiB',
    summary: 'childRss',
    statistic: 'p50',
    required: false,
  },
  {
    suffix: 'childPeakAggregateRssMiBApprox.p95',
    label: 'Child aggregate peak RSS P95',
    unit: 'MiB',
    summary: 'childRss',
    statistic: 'p95',
    required: false,
  },
])

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function optionValue(argv, name) {
  const prefix = `--${name}=`
  const matches = argv.filter((value) => value.startsWith(prefix))
  if (matches.length > 1) throw new Error(`--${name} may be specified only once`)
  return matches.length === 1 ? matches[0].slice(prefix.length) : undefined
}

function normalizeForComparison(filePath) {
  const normalized = path.resolve(filePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathInside(root, candidate, { allowEqual = true } = {}) {
  const rootPath = normalizeForComparison(root)
  const candidatePath = normalizeForComparison(candidate)
  const relative = path.relative(rootPath, candidatePath)
  if (relative === '') return allowEqual
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function canonicalPathForWrite(candidatePath) {
  let ancestor = path.resolve(candidatePath)
  const suffix = []
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw new Error(`No existing ancestor for path: ${candidatePath}`)
    suffix.unshift(path.basename(ancestor))
    ancestor = parent
  }
  const canonicalAncestor = fs.realpathSync(ancestor)
  return path.resolve(canonicalAncestor, ...suffix)
}

function parseArgs(argv, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT)
  const automationRoot = path.resolve(
    options.automationRoot || path.join(projectRoot, 'artifacts', 'automation'),
  )
  const knownFlags = new Set(['--plan', '--quick', '--full', '--help', '-h'])
  const knownOptions = new Set(['dataset', 'baseline', 'output-dir', 'threshold-percent'])
  for (const argument of argv) {
    if (knownFlags.has(argument)) continue
    const match = argument.match(/^--([^=]+)=/)
    if (!match || !knownOptions.has(match[1])) {
      throw new Error(`Unknown automation benchmark argument: ${argument}`)
    }
  }
  if (argv.includes('--quick') && argv.includes('--full')) {
    throw new Error('--quick and --full are mutually exclusive')
  }
  const mode = argv.includes('--full') ? 'full' : 'quick'
  const datasetValue = optionValue(argv, 'dataset')
  const baselineValue = optionValue(argv, 'baseline')
  const outputValue = optionValue(argv, 'output-dir')
  const thresholdValue = optionValue(argv, 'threshold-percent')
  const thresholdPercent =
    thresholdValue === undefined ? DEFAULT_THRESHOLD_PERCENT : Number(thresholdValue)
  if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100) {
    throw new Error('--threshold-percent must be a finite number between 0 and 100')
  }
  const outputDirectory = outputValue
    ? path.resolve(projectRoot, outputValue)
    : path.join(automationRoot, timestampId(options.now || new Date()))
  if (!isPathInside(automationRoot, outputDirectory, { allowEqual: false })) {
    throw new Error(`--output-dir must be a child of ${automationRoot}`)
  }
  return {
    projectRoot,
    automationRoot,
    dataset: path.resolve(projectRoot, datasetValue || DEFAULT_DATASET),
    baseline: baselineValue ? path.resolve(projectRoot, baselineValue) : null,
    outputDirectory,
    thresholdPercent,
    mode,
    plan: argv.includes('--plan'),
    help: argv.includes('--help') || argv.includes('-h'),
    imageSample: mode === 'full' ? FULL_IMAGE_SAMPLE : QUICK_IMAGE_SAMPLE,
    pairedRuns: PAIRED_RUNS,
  }
}

function inspectDataset(datasetPath) {
  const resolved = path.resolve(datasetPath)
  let stat
  try {
    fs.accessSync(resolved, fs.constants.R_OK)
    stat = fs.statSync(resolved)
  } catch (error) {
    throw new Error(`Dataset is not readable: ${resolved}`, { cause: error })
  }
  if (!stat.isDirectory()) throw new Error(`Dataset must be a directory: ${resolved}`)
  const realPath = fs.realpathSync.native
    ? fs.realpathSync.native(resolved)
    : fs.realpathSync(resolved)
  return {
    path: resolved,
    realPath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    mode: stat.mode,
  }
}

function datasetSnapshotsEqual(before, after) {
  return (
    normalizeForComparison(before.realPath) === normalizeForComparison(after.realPath) &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  )
}

function validateRunPaths(dataset, outputDirectory, automationRoot) {
  const canonicalAutomationRoot = canonicalPathForWrite(automationRoot)
  const canonicalOutputDirectory = canonicalPathForWrite(outputDirectory)
  if (!isPathInside(canonicalAutomationRoot, canonicalOutputDirectory, { allowEqual: false })) {
    throw new Error('Automation output escaped artifacts/automation')
  }
  if (
    isPathInside(dataset.realPath, canonicalOutputDirectory) ||
    isPathInside(canonicalOutputDirectory, dataset.realPath)
  ) {
    throw new Error('Dataset and output directory must not overlap')
  }
}

function resolveNpmInvocation(env = process.env) {
  if (env.npm_execpath) {
    return { command: process.execPath, prefixArgs: [env.npm_execpath], display: 'npm' }
  }
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...String(env.Path || env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((entry) => path.join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
  ]
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate))
  if (npmCli) {
    return { command: process.execPath, prefixArgs: [npmCli], display: 'npm' }
  }
  if (process.platform === 'win32') {
    throw new Error('Unable to locate npm-cli.js for safe Windows benchmark execution')
  }
  return {
    command: 'npm',
    prefixArgs: [],
    display: 'npm',
  }
}

function createPlan(options, dependencies = {}) {
  const npm = dependencies.npm || resolveNpmInvocation(dependencies.env)
  const timeouts = BENCHMARK_STAGE_TIMEOUTS_MS[options.mode]
  const imageDirectory = path.join(options.outputDirectory, 'image-preparation')
  const mediaDirectory = path.join(options.outputDirectory, 'media-preparation')
  const npmStage = (id, label, packageScript, stageArgs, timeoutMs, outputDirectory) => ({
    id,
    label,
    packageScript,
    command: npm.command,
    args: [...npm.prefixArgs, 'run', packageScript, '--', ...stageArgs],
    displayCommand: [npm.display, 'run', packageScript, '--', ...stageArgs],
    timeoutMs,
    outputDirectory,
  })
  const stages = [
    npmStage(
      'image-preparation-ab',
      'Image Search preparation A/B',
      'benchmark:image-search:preparation:ab',
      [
        `--dataset=${options.dataset}`,
        `--sample=${options.imageSample}`,
        `--runs=${options.pairedRuns}`,
        `--out-dir=${imageDirectory}`,
        '--skip-analysis',
      ],
      timeouts.imagePreparation,
      imageDirectory,
    ),
    npmStage(
      'image-preparation-analysis',
      'Image Search detailed stage analysis',
      'benchmark:image-search:preparation:analyze',
      [`--dir=${imageDirectory}`],
      timeouts.imageAnalysis,
      imageDirectory,
    ),
  ]
  if (options.mode === 'full') {
    stages.push(
      npmStage(
        'media-preparation-ab',
        'Media Search preparation A/B',
        'benchmark:media-search:preparation:ab',
        [`--runs=${options.pairedRuns}`, `--out-dir=${mediaDirectory}`],
        timeouts.mediaPreparation,
        mediaDirectory,
      ),
    )
  }
  return {
    schemaVersion: 1,
    kind: 'siftory-automation-benchmark-plan',
    mode: options.mode,
    dataset: options.dataset,
    baseline: options.baseline,
    outputDirectory: options.outputDirectory,
    thresholdPercent: options.thresholdPercent,
    readOnlyDataset: true,
    stages,
    timeoutBudgetMs: stages.reduce((total, stage) => total + stage.timeoutMs, 0),
  }
}

function benchmarkTimeoutBudgetMs(mode) {
  const timeouts = BENCHMARK_STAGE_TIMEOUTS_MS[mode]
  if (!timeouts) throw new Error(`Unknown benchmark mode: ${mode}`)
  return Object.values(timeouts).reduce((total, timeoutMs) => total + timeoutMs, 0)
}

function createBoundedCapture(limitBytes = MAX_CAPTURE_BYTES) {
  if (!Number.isInteger(limitBytes) || limitBytes < 64) {
    throw new Error('capture limit must be an integer of at least 64 bytes')
  }
  const headBytes = Math.floor(limitBytes / 4)
  const tailBytes = limitBytes - headBytes
  let complete = Buffer.alloc(0)
  let head = Buffer.alloc(0)
  let tail = Buffer.alloc(0)
  let totalBytes = 0
  let truncated = false
  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      totalBytes += buffer.length
      if (!truncated) {
        const combined = Buffer.concat([complete, buffer])
        if (combined.length <= limitBytes) {
          complete = combined
          return
        }
        truncated = true
        head = combined.subarray(0, headBytes)
        tail = combined.subarray(combined.length - tailBytes)
        complete = Buffer.alloc(0)
        return
      }
      tail = Buffer.concat([tail, buffer])
      if (tail.length > tailBytes) tail = tail.subarray(tail.length - tailBytes)
    },
    snapshot() {
      if (!truncated) {
        return {
          text: complete.toString('utf8'),
          totalBytes,
          capturedBytes: complete.length,
          truncated: false,
        }
      }
      let payloadBudget = limitBytes
      let marker = Buffer.alloc(0)
      for (let index = 0; index < 3; index += 1) {
        const headBudget = Math.floor(payloadBudget / 4)
        const tailBudget = payloadBudget - headBudget
        const omittedBytes = Math.max(0, totalBytes - headBudget - tailBudget)
        marker = Buffer.from(`\n... ${omittedBytes} byte(s) omitted ...\n`)
        payloadBudget = Math.max(0, limitBytes - marker.length)
      }
      const headBudget = Math.floor(payloadBudget / 4)
      const tailBudget = payloadBudget - headBudget
      const headText = head
        .subarray(0, headBudget)
        .toString('utf8')
        .replace(/\uFFFD+$/, '')
      const tailText = tail
        .subarray(Math.max(0, tail.length - tailBudget))
        .toString('utf8')
        .replace(/^\uFFFD+/, '')
      let text = `${headText}${marker.toString('utf8')}${tailText}`
      while (Buffer.byteLength(text, 'utf8') > limitBytes) text = text.slice(0, -1)
      return {
        text,
        totalBytes,
        capturedBytes: Buffer.byteLength(text, 'utf8'),
        truncated: true,
      }
    },
  }
}

function runStage(stage, options = {}) {
  const spawnImpl = options.spawnImpl || spawn
  const now = options.now || (() => Date.now())
  const stdout = createBoundedCapture(options.captureLimitBytes || MAX_CAPTURE_BYTES)
  const stderr = createBoundedCapture(options.captureLimitBytes || MAX_CAPTURE_BYTES)
  const startedAtMs = now()
  return new Promise((resolve) => {
    let child
    let completed = false
    let timedOut = false
    let timer = null
    const finish = (exitCode, signal, error) => {
      if (completed) return
      completed = true
      if (timer) clearTimeout(timer)
      const finishedAtMs = now()
      resolve({
        id: stage.id,
        label: stage.label,
        command: stage.displayCommand || [stage.command, ...(stage.args || [])],
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
        exitCode: Number.isInteger(exitCode) ? exitCode : error ? 1 : null,
        signal: signal || null,
        timedOut,
        error: error ? String(error.message || error) : null,
        stdout: stdout.snapshot(),
        stderr: stderr.snapshot(),
      })
    }
    try {
      child = spawnImpl(stage.command, stage.args || [], {
        cwd: options.cwd || PROJECT_ROOT,
        env: options.env || process.env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish(1, null, error)
      return
    }
    child.stdout?.on('data', (chunk) => stdout.push(chunk))
    child.stderr?.on('data', (chunk) => stderr.push(chunk))
    child.once('error', (error) => finish(1, null, error))
    child.once('close', (code, signal) => finish(code, signal, null))
    timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, stage.timeoutMs)
    timer.unref?.()
  })
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporaryPath, content, { flag: 'wx' })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function appendEvent(filePath, event) {
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8')
}

function renderStageLog(stage) {
  const output = (name, value) =>
    `${name} (${value.totalBytes} byte(s), ${value.truncated ? 'truncated' : 'complete'}):\n${value.text}`
  return [
    `Stage: ${stage.id} - ${stage.label}`,
    `Command: ${stage.command.join(' ')}`,
    `Started: ${stage.startedAt}`,
    `Finished: ${stage.finishedAt}`,
    `Duration: ${stage.durationMs} ms`,
    `Exit code: ${stage.exitCode}`,
    `Signal: ${stage.signal || '-'}`,
    `Timed out: ${stage.timedOut}`,
    `Error: ${stage.error || '-'}`,
    '',
    output('STDOUT', stage.stdout),
    '',
    output('STDERR', stage.stderr),
    '',
  ].join('\n')
}

function writeStageArtifacts(outputDirectory, index, stage) {
  const prefix = `${String(index + 1).padStart(2, '0')}-${stage.id}`
  const jsonPath = path.join(outputDirectory, 'logs', `${prefix}.json`)
  const logPath = path.join(outputDirectory, 'logs', `${prefix}.log`)
  writeJsonAtomic(jsonPath, stage)
  writeFileAtomic(logPath, renderStageLog(stage))
  return { jsonPath, logPath }
}

function percentile(values, ratio) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

function summarize(values) {
  const finite = values.map(Number).filter(Number.isFinite)
  return {
    samples: finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: finite.length > 0 ? Math.max(...finite) : null,
  }
}

function roundMetric(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null
}

function subtractMetrics(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) ? left - right : null
}

function divideMetrics(numerator, denominator) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? numerator / denominator
    : null
}

function gpuMetricSummary(runs, key) {
  const values = runs.map((run) => Number(run?.resources?.gpu?.[key])).filter(Number.isFinite)
  const summary = summarize(values)
  return {
    ...summary,
    min: values.length > 0 ? Math.min(...values) : null,
  }
}

function diagnoseGpuHeadroom(imageReport) {
  const serialRuns = Array.isArray(imageReport?.runs?.serial) ? imageReport.runs.serial : []
  const overlapRuns = Array.isArray(imageReport?.runs?.overlap) ? imageReport.runs.overlap : []
  const allRuns = [...serialRuns, ...overlapRuns]
  const deviceTotals = gpuMetricSummary(allRuns, 'totalMiB')
  const serial = {
    baselineUsedMiB: gpuMetricSummary(serialRuns, 'baselineUsedMiB'),
    peakUsedMiB: gpuMetricSummary(serialRuns, 'peakUsedMiB'),
    peakDeltaUsedMiB: gpuMetricSummary(serialRuns, 'peakDeltaUsedMiB'),
  }
  const overlap = {
    baselineUsedMiB: gpuMetricSummary(overlapRuns, 'baselineUsedMiB'),
    peakUsedMiB: gpuMetricSummary(overlapRuns, 'peakUsedMiB'),
    peakDeltaUsedMiB: gpuMetricSummary(overlapRuns, 'peakDeltaUsedMiB'),
  }
  const budgets = imageReport?.gate?.budgets || {}
  const absoluteDeltaBudgetMiB = Number(budgets.gpuAbsoluteDeltaMiB)
  const growthBudgetMiB = Number(budgets.gpuGrowthVersusSerialMiB)
  const deviceUsageBudgetRatio = Number(budgets.gpuDeviceUsageRatio)
  const capacityMiB = deviceTotals.min
  const baselineUsedMiB = overlap.baselineUsedMiB.p50
  const peakUsedMiB = overlap.peakUsedMiB.max
  const peakDeltaUsedMiB = overlap.peakDeltaUsedMiB.max
  const deltaGrowthMiB =
    Number.isFinite(overlap.peakDeltaUsedMiB.p95) && Number.isFinite(serial.peakDeltaUsedMiB.p95)
      ? overlap.peakDeltaUsedMiB.p95 - serial.peakDeltaUsedMiB.p95
      : null
  const allowedPeakUsedMiB =
    Number.isFinite(capacityMiB) && Number.isFinite(deviceUsageBudgetRatio)
      ? capacityMiB * deviceUsageBudgetRatio
      : null
  const gpuFailures = Array.isArray(imageReport?.gate?.failures)
    ? imageReport.gate.failures.filter((failure) => /GPU/i.test(String(failure)))
    : []
  const available =
    overlapRuns.length > 0 &&
    Number.isFinite(capacityMiB) &&
    Number.isFinite(baselineUsedMiB) &&
    Number.isFinite(peakUsedMiB) &&
    Number.isFinite(peakDeltaUsedMiB)
  const absoluteDeltaExceeded =
    available &&
    Number.isFinite(absoluteDeltaBudgetMiB) &&
    peakDeltaUsedMiB > absoluteDeltaBudgetMiB
  const growthExceeded =
    available &&
    Number.isFinite(growthBudgetMiB) &&
    Number.isFinite(deltaGrowthMiB) &&
    deltaGrowthMiB > growthBudgetMiB
  const deviceUsageExceeded =
    available && Number.isFinite(allowedPeakUsedMiB) && peakUsedMiB > allowedPeakUsedMiB

  let classification = 'unavailable'
  let summary = 'GPU samples are unavailable; no headroom attribution was made.'
  let recommendation = 'Run the paired benchmark on a GPU-enabled host with telemetry enabled.'
  if (available) {
    if (absoluteDeltaExceeded) {
      classification = 'workload-delta-budget-exceeded'
      summary = 'The measured workload GPU-memory delta exceeded its fixed budget.'
      recommendation = 'Profile model and tensor residency before accepting this result.'
    } else if (growthExceeded) {
      classification = 'overlap-growth-budget-exceeded'
      summary = 'Overlap scheduling increased GPU-memory delta beyond the serial-growth budget.'
      recommendation = 'Reduce overlap residency or tighten joint scheduling before release.'
    } else if (deviceUsageExceeded) {
      classification = 'environment-headroom-limited'
      summary =
        'The task delta stayed within budget, but baseline GPU usage left too little device headroom.'
      recommendation =
        'Repeat on the same fixed hardware after closing unrelated GPU workloads; do not relax the gate.'
    } else if (gpuFailures.length > 0) {
      classification = 'gpu-gate-failed'
      summary = 'A GPU gate failed, but the available telemetry does not isolate one budget cause.'
      recommendation = 'Inspect the paired raw GPU samples before accepting the run.'
    } else {
      classification = 'within-budget'
      summary = 'Baseline usage, workload delta, and peak device usage stayed within fixed budgets.'
      recommendation = 'No GPU-headroom action is required for this run.'
    }
  }

  return {
    available,
    classification,
    environmentContentionLikely: classification === 'environment-headroom-limited',
    summary,
    recommendation,
    gateFailures: gpuFailures,
    budgets: {
      absoluteDeltaMiB: Number.isFinite(absoluteDeltaBudgetMiB) ? absoluteDeltaBudgetMiB : null,
      growthVersusSerialMiB: Number.isFinite(growthBudgetMiB) ? growthBudgetMiB : null,
      deviceUsageRatio: Number.isFinite(deviceUsageBudgetRatio) ? deviceUsageBudgetRatio : null,
      allowedPeakUsedMiB: roundMetric(allowedPeakUsedMiB),
    },
    observed: {
      capacityMiB: roundMetric(capacityMiB),
      baselineUsedMiBP50: roundMetric(baselineUsedMiB),
      baselineUsageRatioP50: roundMetric(divideMetrics(baselineUsedMiB, capacityMiB), 4),
      availableHeadroomAtBaselineP50MiB: roundMetric(
        subtractMetrics(allowedPeakUsedMiB, baselineUsedMiB),
      ),
      peakUsedMiBMax: roundMetric(peakUsedMiB),
      peakUsageRatioMax: roundMetric(divideMetrics(peakUsedMiB, capacityMiB), 4),
      additionalHeadroomNeededMiB: roundMetric(
        Number.isFinite(peakUsedMiB) && Number.isFinite(allowedPeakUsedMiB)
          ? Math.max(0, peakUsedMiB - allowedPeakUsedMiB)
          : null,
      ),
      workloadDeltaMiBMax: roundMetric(peakDeltaUsedMiB),
      workloadDeltaMiBP95: roundMetric(overlap.peakDeltaUsedMiB.p95),
      serialDeltaMiBP95: roundMetric(serial.peakDeltaUsedMiB.p95),
      overlapGrowthVersusSerialMiB: roundMetric(deltaGrowthMiB),
    },
    checks: {
      absoluteDeltaExceeded,
      growthExceeded,
      deviceUsageExceeded,
    },
    samples: {
      serial,
      overlap,
    },
  }
}

function finiteSummary(value) {
  if (!value || typeof value !== 'object') return null
  const p50 = Number(value.p50)
  const p95 = Number(value.p95)
  if (!Number.isFinite(p50) && !Number.isFinite(p95)) return null
  return {
    samples: Number.isFinite(Number(value.samples)) ? Number(value.samples) : null,
    p50: Number.isFinite(p50) ? p50 : null,
    p95: Number.isFinite(p95) ? p95 : null,
    max: Number.isFinite(Number(value.max)) ? Number(value.max) : null,
  }
}

function runsForReport(report) {
  if (Array.isArray(report?.runs?.overlap)) return report.runs.overlap
  if (Array.isArray(report?.runs)) {
    return report.runs.filter((run) => run?.pipeline === 'overlap' && run?.diagnostic !== true)
  }
  return []
}

function phaseSummary(report, scope, phase) {
  return (
    finiteSummary(report?.[scope]?.phases?.[phase]) ||
    finiteSummary(report?.performance?.phases?.[phase]?.overlap) ||
    (phase === 'libraryReadyMs'
      ? finiteSummary(report?.performance?.libraryReadyMs?.overlap)
      : null) ||
    (() => {
      const runs = runsForReport(report)
      if (runs.length === 0) return null
      return summarize(
        runs.map((run) =>
          phase === 'libraryReadyMs'
            ? (run?.phases?.libraryReadyMs ?? run?.readyMs)
            : (run?.phases?.[phase] ?? run?.totalMs),
        ),
      )
    })()
  )
}

function resourceSummary(report, scope, key, nestedPath) {
  const direct =
    finiteSummary(report?.[scope]?.resources?.[key]) ||
    finiteSummary(report?.performance?.resources?.[key]?.overlap)
  if (direct) return direct
  const runs = runsForReport(report)
  if (runs.length === 0) return null
  return summarize(
    runs.map((run) => {
      const nested = nestedPath.reduce((value, part) => value?.[part], run?.resources)
      if (nested !== undefined) return nested
      const flattened = key.split('.').at(-1)
      return run?.resources?.[flattened]
    }),
  )
}

function emptyMetric(scope, definition) {
  return {
    id: `${scope}.${definition.suffix}`,
    scope,
    label: `${scope === 'image' ? 'Image' : 'Media'} ${definition.label}`,
    unit: definition.unit,
    statistic: definition.statistic,
    required: definition.required,
    value: null,
    available: false,
    source: 'missing',
  }
}

function extractScopeMetrics(scope, report) {
  const summaries = {
    libraryReady: phaseSummary(report, scope, 'libraryReadyMs'),
    total: phaseSummary(report, scope, 'totalMs'),
    mainRss: resourceSummary(report, scope, 'memory.mainPeakRssMiB', ['memory', 'mainPeakRssMiB']),
    childRss: resourceSummary(report, scope, 'memory.childPeakAggregateRssMiBApprox', [
      'memory',
      'childPeakAggregateRssMiBApprox',
    ]),
  }
  return Object.fromEntries(
    METRIC_DEFINITIONS.map((definition) => {
      const metric = emptyMetric(scope, definition)
      const summary = summaries[definition.summary]
      const value = Number(summary?.[definition.statistic])
      if (Number.isFinite(value)) {
        metric.value = value
        metric.available = true
        metric.source = definition.summary
      }
      return [metric.id, metric]
    }),
  )
}

function extractBenchmarkMetrics({ imageReport, mediaReport, imageAnalysis, scopes }) {
  const metrics = {}
  for (const scope of scopes) {
    const primary = scope === 'image' ? imageReport : mediaReport
    const fallback = scope === 'image' ? imageAnalysis : null
    const extracted = extractScopeMetrics(scope, primary || fallback || {})
    Object.assign(metrics, extracted)
    if (primary && fallback) {
      const fallbackMetrics = extractScopeMetrics(scope, fallback)
      for (const [id, metric] of Object.entries(metrics)) {
        if (!metric.available && fallbackMetrics[id]?.available) metrics[id] = fallbackMetrics[id]
      }
    }
  }
  return metrics
}

function detectRawScope(report) {
  if (report?.config?.sample !== undefined || report?.safety?.realLibraryWritten !== undefined) {
    return 'image'
  }
  if (
    report?.config?.fixtureCfrSeconds !== undefined ||
    report?.runs?.overlap?.some((run) => run?.counts?.total !== undefined)
  ) {
    return 'media'
  }
  if (Array.isArray(report?.runs) && report.runs.some((run) => run?.imageCount !== undefined)) {
    return 'image'
  }
  return null
}

function extractBaselineMetrics(report, scopes) {
  const metrics = Object.fromEntries(
    scopes.flatMap((scope) =>
      METRIC_DEFINITIONS.map((definition) => {
        const metric = emptyMetric(scope, definition)
        return [metric.id, metric]
      }),
    ),
  )
  if (report?.kind === 'siftory-automation-benchmark' && report.metrics) {
    for (const [id, target] of Object.entries(metrics)) {
      const source = report.metrics[id]
      const value = Number(typeof source === 'number' ? source : source?.value)
      if (Number.isFinite(value)) {
        metrics[id] = { ...target, value, available: true, source: `baseline.metrics.${id}` }
      }
    }
    return metrics
  }
  if (report?.image || report?.media) {
    for (const scope of scopes) {
      if (report[scope]) Object.assign(metrics, extractScopeMetrics(scope, report))
    }
    return metrics
  }
  const detectedScope = detectRawScope(report)
  if (detectedScope && scopes.includes(detectedScope)) {
    Object.assign(metrics, extractScopeMetrics(detectedScope, report))
  }
  return metrics
}

function normalizedDatasetPath(value) {
  return typeof value === 'string' && value.trim() ? normalizeForComparison(value) : null
}

function baselineContextIssues(baselineReport, options, dataset) {
  const issues = []
  const baselineDataset =
    baselineReport?.config?.datasetRealPath ||
    baselineReport?.config?.dataset ||
    baselineReport?.dataset?.realPath
  if (
    normalizedDatasetPath(baselineDataset) &&
    normalizedDatasetPath(baselineDataset) !== normalizedDatasetPath(dataset.realPath)
  ) {
    issues.push('baseline dataset path differs from the current fixed dataset')
  }
  const baselineSample = Number(
    baselineReport?.config?.imageSample ?? baselineReport?.config?.sample,
  )
  if (Number.isFinite(baselineSample) && baselineSample !== options.imageSample) {
    issues.push(
      `baseline image sample ${baselineSample} differs from current ${options.imageSample}`,
    )
  }
  for (const [key, expected] of [
    ['backend', 'gpu'],
    ['jobs', 2],
    ['batchSize', 4],
  ]) {
    const actual = baselineReport?.config?.[key]
    if (actual !== undefined && String(actual) !== String(expected)) {
      issues.push(`baseline ${key}=${actual} differs from current ${expected}`)
    }
  }
  return issues
}

function compareMetrics(current, baseline, thresholdPercent, options = {}) {
  const contextIssues = options.contextIssues || []
  const ids = [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort()
  const results = ids.map((id) => {
    const currentMetric = current[id]
    const baselineMetric = baseline[id]
    const base = {
      id,
      label: currentMetric?.label || baselineMetric?.label || id,
      unit: currentMetric?.unit || baselineMetric?.unit || '',
      current: currentMetric?.available ? currentMetric.value : null,
      baseline: baselineMetric?.available ? baselineMetric.value : null,
      thresholdPercent,
      changePercent: null,
      status: 'skipped',
      reason: null,
    }
    if (contextIssues.length > 0) {
      base.reason = `context mismatch: ${contextIssues.join('; ')}`
      return base
    }
    if (!currentMetric?.available) {
      base.reason = 'current metric is missing'
      return base
    }
    if (!baselineMetric?.available) {
      base.reason = 'baseline metric is missing'
      return base
    }
    if (!(baselineMetric.value > 0)) {
      base.reason = 'baseline metric is not positive'
      return base
    }
    base.changePercent = Number(
      (((currentMetric.value - baselineMetric.value) / baselineMetric.value) * 100).toFixed(3),
    )
    base.status = base.changePercent <= thresholdPercent ? 'passed' : 'failed'
    return base
  })
  const failed = results.filter((result) => result.status === 'failed').length
  const skipped = results.filter((result) => result.status === 'skipped').length
  const compared = results.filter((result) => result.status !== 'skipped').length
  return {
    status: failed > 0 ? 'failed' : skipped > 0 || compared === 0 ? 'incomplete' : 'passed',
    thresholdPercent,
    compared,
    failed,
    skipped,
    contextIssues,
    results,
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read JSON report: ${filePath}`, { cause: error })
  }
}

function readJsonIfPresent(filePath) {
  return fs.existsSync(filePath) ? readJson(filePath) : null
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function displayValue(value, unit) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)} ${unit}` : '-'
}

function renderHtml(report) {
  const stageRows = report.stages
    .map(
      (stage) =>
        `<tr><td>${escapeHtml(stage.id)}</td><td>${escapeHtml(stage.label)}</td><td>${stage.durationMs}</td><td>${stage.exitCode}</td><td>${stage.stdout.truncated || stage.stderr.truncated ? 'yes' : 'no'}</td></tr>`,
    )
    .join('')
  const comparisonRows = (report.comparison.results || [])
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.label)}</td><td>${displayValue(item.baseline, item.unit)}</td><td>${displayValue(item.current, item.unit)}</td><td>${item.changePercent === null ? '-' : `${item.changePercent.toFixed(3)}%`}</td><td class="${escapeHtml(item.status)}">${escapeHtml(item.status)}</td><td>${escapeHtml(item.reason || '')}</td></tr>`,
    )
    .join('')
  const failures = report.failures.length
    ? `<ul>${report.failures.map((failure) => `<li>${escapeHtml(failure)}</li>`).join('')}</ul>`
    : '<p>None.</p>'
  const gpu = report.diagnostics?.gpuHeadroom
  const gpuDiagnostics = gpu
    ? `<h2>GPU headroom diagnosis</h2>
  <p><strong>Classification:</strong> ${escapeHtml(gpu.classification)}</p>
  <p>${escapeHtml(gpu.summary)} ${escapeHtml(gpu.recommendation)}</p>
  <table><thead><tr><th>Baseline P50</th><th>Workload delta max</th><th>Peak max</th><th>Allowed peak</th><th>Extra headroom needed</th></tr></thead><tbody><tr><td>${displayValue(gpu.observed?.baselineUsedMiBP50, 'MiB')}</td><td>${displayValue(gpu.observed?.workloadDeltaMiBMax, 'MiB')}</td><td>${displayValue(gpu.observed?.peakUsedMiBMax, 'MiB')}</td><td>${displayValue(gpu.budgets?.allowedPeakUsedMiB, 'MiB')}</td><td>${displayValue(gpu.observed?.additionalHeadroomNeededMiB, 'MiB')}</td></tr></tbody></table>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Siftory automation benchmark</title>
  <style>
    body { font: 14px/1.45 system-ui, sans-serif; margin: 24px; color: #172033; background: #f7f9fc; }
    h1, h2 { color: #0e1930; } code { word-break: break-all; }
    table { width: 100%; border-collapse: collapse; background: white; margin: 12px 0 24px; }
    th, td { border: 1px solid #d8deea; padding: 7px 9px; text-align: left; }
    th { background: #edf2fa; } .passed { color: #08752f; } .failed { color: #b42318; }
    .skipped, .incomplete { color: #8a5b00; }
  </style>
</head>
<body>
  <h1>Siftory automation benchmark</h1>
  <p><strong>Status:</strong> ${escapeHtml(report.status)}; <strong>regression:</strong> ${escapeHtml(report.comparison.status)}</p>
  <p><strong>Mode:</strong> ${escapeHtml(report.config.mode)}; <strong>dataset:</strong> <code>${escapeHtml(report.config.dataset)}</code></p>
  <p><strong>Generated:</strong> ${escapeHtml(report.generatedAt)}</p>
  <h2>Stages</h2>
  <table><thead><tr><th>ID</th><th>Stage</th><th>Duration ms</th><th>Exit</th><th>Capture truncated</th></tr></thead><tbody>${stageRows}</tbody></table>
  <h2>Baseline comparison</h2>
  <table><thead><tr><th>Metric</th><th>Baseline</th><th>Current</th><th>Change</th><th>Status</th><th>Reason</th></tr></thead><tbody>${comparisonRows || '<tr><td colspan="6">No baseline requested.</td></tr>'}</tbody></table>
  ${gpuDiagnostics}
  <h2>Failures</h2>${failures}
</body>
</html>
`
}

function createEnvironment() {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  })
  return {
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    node: process.version,
    cpuModel: os.cpus()[0]?.model || 'unknown',
    logicalProcessors: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    commit: git.status === 0 ? String(git.stdout || '').trim() : null,
  }
}

function ensureNewOutputDirectory(outputDirectory) {
  if (fs.existsSync(outputDirectory) && fs.readdirSync(outputDirectory).length > 0) {
    throw new Error(`Output directory must be empty: ${outputDirectory}`)
  }
  fs.mkdirSync(path.join(outputDirectory, 'logs'), { recursive: true })
}

function normalizeStageResult(stage, value) {
  const emptyCapture = { text: '', totalBytes: 0, capturedBytes: 0, truncated: false }
  return {
    id: stage.id,
    label: stage.label,
    command: stage.displayCommand,
    startedAt: value?.startedAt || new Date().toISOString(),
    finishedAt: value?.finishedAt || new Date().toISOString(),
    durationMs: Math.max(0, Number(value?.durationMs) || 0),
    exitCode: Number.isInteger(value?.exitCode) ? value.exitCode : 1,
    signal: value?.signal || null,
    timedOut: value?.timedOut === true,
    error: value?.error || null,
    stdout: value?.stdout || emptyCapture,
    stderr: value?.stderr || emptyCapture,
  }
}

async function runAutomationBenchmark(options, dependencies = {}) {
  const datasetBefore = inspectDataset(options.dataset)
  validateRunPaths(datasetBefore, options.outputDirectory, options.automationRoot)
  const baselineReport = options.baseline ? readJson(options.baseline) : null
  ensureNewOutputDirectory(options.outputDirectory)
  validateRunPaths(datasetBefore, options.outputDirectory, options.automationRoot)
  const eventPath = path.join(options.outputDirectory, 'events.ndjson')
  const plan = createPlan(options, dependencies)
  const stageRunner =
    dependencies.stageRunner ||
    ((stage) =>
      runStage(stage, {
        cwd: options.projectRoot,
        env: dependencies.env || process.env,
      }))
  const stages = []
  const failures = []
  appendEvent(eventPath, {
    type: 'benchmark-start',
    at: new Date().toISOString(),
    mode: options.mode,
    dataset: datasetBefore.realPath,
  })
  for (const [index, plannedStage] of plan.stages.entries()) {
    process.stderr.write(
      `[automation-benchmark] stage ${index + 1}/${plan.stages.length}: ${plannedStage.id}\n`,
    )
    appendEvent(eventPath, {
      type: 'stage-start',
      at: new Date().toISOString(),
      id: plannedStage.id,
      command: plannedStage.displayCommand,
    })
    let result
    try {
      result = normalizeStageResult(plannedStage, await stageRunner(plannedStage, { index, plan }))
    } catch (error) {
      result = normalizeStageResult(plannedStage, {
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const logs = writeStageArtifacts(options.outputDirectory, index, result)
    result.logs = {
      json: path.relative(options.outputDirectory, logs.jsonPath).split(path.sep).join('/'),
      text: path.relative(options.outputDirectory, logs.logPath).split(path.sep).join('/'),
    }
    stages.push(result)
    appendEvent(eventPath, {
      type: 'stage-end',
      at: result.finishedAt,
      id: result.id,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    })
    if (result.exitCode !== 0) {
      failures.push(`stage ${result.id} failed with exit code ${result.exitCode}`)
    }
  }

  const imageDirectory = path.join(options.outputDirectory, 'image-preparation')
  const mediaDirectory = path.join(options.outputDirectory, 'media-preparation')
  const imageReportPath = path.join(imageDirectory, 'report.json')
  const imageAnalysisPath = path.join(imageDirectory, 'stage-analysis.json')
  const mediaReportPath = path.join(mediaDirectory, 'report.json')
  const imageReport = readJsonIfPresent(imageReportPath)
  const imageAnalysis = readJsonIfPresent(imageAnalysisPath)
  const mediaReport = options.mode === 'full' ? readJsonIfPresent(mediaReportPath) : null
  if (!imageReport) failures.push('image preparation report is missing')
  if (!imageAnalysis) failures.push('image stage analysis report is missing')
  if (options.mode === 'full' && !mediaReport) failures.push('media preparation report is missing')
  if (imageReport?.gate?.passed === false) failures.push('image preparation benchmark gate failed')
  if (mediaReport?.gate?.passed === false) failures.push('media preparation benchmark gate failed')
  const gpuHeadroom = diagnoseGpuHeadroom(imageReport)

  const scopes = options.mode === 'full' ? ['image', 'media'] : ['image']
  const metrics = extractBenchmarkMetrics({
    imageReport,
    imageAnalysis,
    mediaReport,
    scopes,
  })
  for (const metric of Object.values(metrics)) {
    if (metric.required && !metric.available)
      failures.push(`required metric is missing: ${metric.id}`)
  }
  const baselineMetrics = baselineReport ? extractBaselineMetrics(baselineReport, scopes) : {}
  const comparison = baselineReport
    ? compareMetrics(metrics, baselineMetrics, options.thresholdPercent, {
        contextIssues: baselineContextIssues(baselineReport, options, datasetBefore),
      })
    : {
        status: 'not-requested',
        thresholdPercent: options.thresholdPercent,
        compared: 0,
        failed: 0,
        skipped: 0,
        contextIssues: [],
        results: [],
      }
  if (comparison.status === 'failed') failures.push('one or more performance metrics regressed')
  if (comparison.status === 'incomplete') {
    failures.push('baseline comparison is incomplete; skipped metrics are not treated as passed')
  }

  const datasetAfter = inspectDataset(options.dataset)
  const rootMetadataUnchanged = datasetSnapshotsEqual(datasetBefore, datasetAfter)
  const imageReadOnly =
    imageReport?.safety?.sourceFilesUnchanged === true &&
    imageReport?.safety?.isolatedUserData === true &&
    imageReport?.safety?.realLibraryWritten === false
  const mediaReadOnly =
    options.mode !== 'full' ||
    (mediaReport?.safety?.sourceFilesUnchanged === true &&
      mediaReport?.safety?.isolatedUserData === true)
  const datasetReadOnlyVerified = rootMetadataUnchanged && imageReadOnly && mediaReadOnly
  if (!datasetReadOnlyVerified) failures.push('read-only dataset evidence is missing or changed')

  const ok = failures.length === 0
  const report = {
    schemaVersion: 1,
    kind: 'siftory-automation-benchmark',
    generatedAt: new Date().toISOString(),
    ok,
    status: ok
      ? baselineReport
        ? 'passed'
        : 'completed-without-baseline'
      : comparison.status === 'incomplete'
        ? 'incomplete'
        : 'failed',
    config: {
      mode: options.mode,
      dataset: options.dataset,
      datasetRealPath: datasetBefore.realPath,
      outputDirectory: options.outputDirectory,
      baseline: options.baseline,
      thresholdPercent: options.thresholdPercent,
      imageSample: options.imageSample,
      pairedRuns: options.pairedRuns,
      backend: 'gpu',
      jobs: 2,
      batchSize: 4,
    },
    environment: dependencies.environment || createEnvironment(),
    safety: {
      datasetOpenedReadOnly: true,
      outputIsolatedToAutomationRoot: true,
      rootMetadataUnchanged,
      imageReportReadOnlyEvidence: imageReadOnly,
      mediaReportReadOnlyEvidence: mediaReadOnly,
      datasetReadOnlyVerified,
      before: datasetBefore,
      after: datasetAfter,
    },
    stages,
    reports: {
      image: imageReport
        ? path.relative(options.outputDirectory, imageReportPath).split(path.sep).join('/')
        : null,
      imageAnalysis: imageAnalysis
        ? path.relative(options.outputDirectory, imageAnalysisPath).split(path.sep).join('/')
        : null,
      media: mediaReport
        ? path.relative(options.outputDirectory, mediaReportPath).split(path.sep).join('/')
        : null,
      events: 'events.ndjson',
    },
    metrics,
    comparison,
    diagnostics: {
      gpuHeadroom,
    },
    failures: [...new Set(failures)],
  }
  const jsonPath = path.join(options.outputDirectory, 'report.json')
  const htmlPath = path.join(options.outputDirectory, 'report.html')
  writeJsonAtomic(jsonPath, report)
  writeFileAtomic(htmlPath, renderHtml(report))
  appendEvent(eventPath, {
    type: 'benchmark-end',
    at: report.generatedAt,
    ok: report.ok,
    status: report.status,
    comparison: report.comparison.status,
  })
  return { report, jsonPath, htmlPath, eventPath }
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/run-automation-benchmark.cjs [--quick|--full] [options]

Options:
  --dataset=<dir>              Read-only image dataset (default: ${DEFAULT_DATASET})
  --plan                       Validate inputs and print the execution plan without writing
  --baseline=<report.json>     Previous automation, preparation, or combined baseline
  --output-dir=<dir>           Child directory of artifacts/automation
  --threshold-percent=<0..100> Maximum allowed regression (default: 10)
  --quick                      Image preparation A/B + detailed analysis (default)
  --full                       Quick stages plus Media Search preparation A/B
`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return printHelp()
  const dataset = inspectDataset(options.dataset)
  validateRunPaths(dataset, options.outputDirectory, options.automationRoot)
  if (options.baseline) readJson(options.baseline)
  const plan = createPlan(options)
  if (options.plan) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...plan,
          datasetValidation: {
            readable: true,
            directory: true,
            realPath: dataset.realPath,
          },
          writesPlanned: false,
        },
        null,
        2,
      )}\n`,
    )
    return
  }
  const result = await runAutomationBenchmark(options)
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: result.report.ok,
        status: result.report.status,
        regressionStatus: result.report.comparison.status,
        outputDirectory: options.outputDirectory,
        json: result.jsonPath,
        html: result.htmlPath,
        stageCount: result.report.stages.length,
        gpuClassification: result.report.diagnostics.gpuHeadroom.classification,
        failures: result.report.failures,
      },
      null,
      2,
    )}\n`,
  )
  if (!result.report.ok) process.exitCode = 1
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = {
  AUTOMATION_ROOT,
  BENCHMARK_STAGE_TIMEOUTS_MS,
  DEFAULT_DATASET,
  DEFAULT_THRESHOLD_PERCENT,
  MAX_CAPTURE_BYTES,
  METRIC_DEFINITIONS,
  baselineContextIssues,
  benchmarkTimeoutBudgetMs,
  canonicalPathForWrite,
  compareMetrics,
  createBoundedCapture,
  createPlan,
  datasetSnapshotsEqual,
  diagnoseGpuHeadroom,
  escapeHtml,
  extractBaselineMetrics,
  extractBenchmarkMetrics,
  inspectDataset,
  isPathInside,
  parseArgs,
  renderHtml,
  resolveNpmInvocation,
  runAutomationBenchmark,
  runStage,
  summarize,
  validateRunPaths,
  writeStageArtifacts,
}
