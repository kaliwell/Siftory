#!/usr/bin/env node

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { benchmarkTimeoutBudgetMs } = require('./run-automation-benchmark.cjs')

const projectRoot = path.resolve(__dirname, '..')
const PRODUCTION_AUTOMATION_ROOT = path.join(projectRoot, 'artifacts', 'automation')
const DEFAULT_DATASET = process.env.SOURCE_AUDIT_DIR || '<SOURCE_AUDIT_DIR>'
const MAX_STAGE_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_LINE_CHARS = 64 * 1024
const MINUTE_MS = 60 * 1000
const BENCHMARK_PARENT_GRACE_MS = 5 * MINUTE_MS

function optionValue(argument, prefix) {
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : undefined
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    mode: 'quick',
    datasetPath: path.resolve(DEFAULT_DATASET),
    sourcePath: '',
    baselinePath: '',
    outputDir: '',
    plan: false,
    json: false,
    redactPaths: true,
    skipBenchmark: false,
    skipSourceAudit: false,
    skipQuality: false,
    allowNetwork: false,
    allowGeneratedClean: false,
  }
  let sawMode = false
  for (const argument of argv) {
    const datasetPath = optionValue(argument, '--dataset=')
    const sourcePath = optionValue(argument, '--source=')
    const baselinePath = optionValue(argument, '--baseline=')
    const outputDir = optionValue(argument, '--output-dir=')
    if (argument === '--quick' || argument === '--full') {
      if (sawMode) throw new Error('Specify only one of --quick or --full')
      options.mode = argument.slice(2)
      sawMode = true
    } else if (argument === '--plan') options.plan = true
    else if (argument === '--json') options.json = true
    else if (argument === '--include-paths') options.redactPaths = false
    else if (argument === '--skip-benchmark') options.skipBenchmark = true
    else if (argument === '--skip-source-audit') options.skipSourceAudit = true
    else if (argument === '--skip-quality') options.skipQuality = true
    else if (argument === '--allow-network') options.allowNetwork = true
    else if (argument === '--allow-generated-clean') options.allowGeneratedClean = true
    else if (datasetPath !== undefined) options.datasetPath = path.resolve(datasetPath)
    else if (sourcePath !== undefined) options.sourcePath = path.resolve(sourcePath)
    else if (baselinePath !== undefined) options.baselinePath = path.resolve(baselinePath)
    else if (outputDir !== undefined) options.outputDir = path.resolve(outputDir)
    else throw new Error(`Unknown nightly automation argument: ${argument}`)
  }
  if (!options.sourcePath) options.sourcePath = options.datasetPath
  return options
}

function defaultOutputDir(now = new Date(), automationRoot = PRODUCTION_AUTOMATION_ROOT) {
  return path.join(path.resolve(automationRoot), 'nightly', now.toISOString().replace(/[:.]/g, '-'))
}

function isStrictlyWithin(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath))
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function isWithin(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath))
  return relative === '' || isStrictlyWithin(parentPath, candidatePath)
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
  return path.resolve(fs.realpathSync(ancestor), ...suffix)
}

function resolveNpmInvocation(env = process.env, platform = process.platform) {
  if (env.npm_execpath) {
    return { command: process.execPath, prefixArgs: [env.npm_execpath] }
  }
  const bundledCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  )
  if (fs.existsSync(bundledCli)) {
    return { command: process.execPath, prefixArgs: [bundledCli] }
  }
  if (platform === 'win32') {
    return {
      command: env.ComSpec || 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c', 'npm.cmd'],
    }
  }
  return { command: 'npm', prefixArgs: [] }
}

function npmCommand(script, extraArgs = []) {
  const npm = resolveNpmInvocation()
  return {
    command: npm.command,
    args: [...npm.prefixArgs, 'run', script, ...(extraArgs.length ? ['--', ...extraArgs] : [])],
  }
}

function nodeCommand(script, args = []) {
  return { command: process.execPath, args: [path.join(projectRoot, script), ...args] }
}

function createPlan(options, exists = fs.existsSync, automationRoot = PRODUCTION_AUTOMATION_ROOT) {
  const resolvedAutomationRoot = path.resolve(automationRoot)
  const outputDir = path.resolve(
    options.outputDir || defaultOutputDir(new Date(), resolvedAutomationRoot),
  )
  const canonicalAutomationRoot = canonicalPathForWrite(resolvedAutomationRoot)
  const canonicalOutputDir = canonicalPathForWrite(outputDir)
  if (!isStrictlyWithin(canonicalAutomationRoot, canonicalOutputDir)) {
    throw new Error(
      `Nightly output directory must be a strict child of the automation root: ${resolvedAutomationRoot}`,
    )
  }
  if (
    path.resolve(resolvedAutomationRoot) === path.resolve(PRODUCTION_AUTOMATION_ROOT) &&
    !isStrictlyWithin(
      canonicalPathForWrite(path.join(projectRoot, 'artifacts')),
      canonicalAutomationRoot,
    )
  ) {
    throw new Error('Production automation root resolves outside the project artifact directory')
  }
  const canonicalDataset = fs.existsSync(options.datasetPath)
    ? fs.realpathSync(options.datasetPath)
    : path.resolve(options.datasetPath)
  const canonicalSource = fs.existsSync(options.sourcePath)
    ? fs.realpathSync(options.sourcePath)
    : path.resolve(options.sourcePath)
  if (
    isWithin(canonicalDataset, canonicalOutputDir) ||
    isWithin(canonicalSource, canonicalOutputDir)
  ) {
    throw new Error('Nightly artifacts must be outside the dataset and audited source')
  }
  const full = options.mode === 'full'
  const datasetExists = exists(options.datasetPath)
  const sourceExists = exists(options.sourcePath)
  const baselineExists = options.baselinePath ? exists(options.baselinePath) : false
  const stages = []

  if (full) {
    stages.push({
      id: 'quality',
      label: 'Full CI verification',
      required: true,
      timeoutMs: 30 * MINUTE_MS,
      skipReason: options.skipQuality
        ? 'Explicitly skipped by --skip-quality'
        : !options.allowNetwork || !options.allowGeneratedClean
          ? 'Full quality requires explicit --allow-network and --allow-generated-clean'
          : undefined,
      ...npmCommand('ci:verify'),
    })
  }
  stages.push({
    id: 'health',
    label: 'Read-only runtime health report',
    required: true,
    timeoutMs: full ? 25 * MINUTE_MS : 15 * MINUTE_MS,
    ...nodeCommand('scripts/run-automation-health.cjs', [
      ...(full ? ['--full'] : []),
      `--output-dir=${path.join(outputDir, 'health')}`,
      '--json',
    ]),
    reportContract: {
      kind: 'health',
      path: path.join(outputDir, 'health', 'automation-health.json'),
    },
  })
  stages.push({
    id: 'model-safety',
    label: 'Model verification and safe repair plan',
    required: true,
    timeoutMs: full ? 25 * MINUTE_MS : 15 * MINUTE_MS,
    ...nodeCommand('scripts/run-model-repair-orchestrator.cjs', [
      full ? '--full' : '--quick',
      '--json',
      `--output=${path.join(outputDir, 'model-repair.json')}`,
    ]),
    reportContract: {
      kind: 'model',
      path: path.join(outputDir, 'model-repair.json'),
    },
  })
  stages.push({
    id: 'benchmark',
    label: 'Fixed-dataset preparation regression',
    required: full,
    timeoutMs: benchmarkTimeoutBudgetMs(options.mode) + BENCHMARK_PARENT_GRACE_MS,
    skipReason: options.skipBenchmark
      ? 'Explicitly skipped by --skip-benchmark'
      : !datasetExists
        ? `Dataset is unavailable: ${options.datasetPath}`
        : options.baselinePath && !baselineExists
          ? `Baseline is unavailable: ${options.baselinePath}`
          : undefined,
    ...nodeCommand('scripts/run-automation-benchmark.cjs', [
      full ? '--full' : '--quick',
      `--dataset=${options.datasetPath}`,
      `--output-dir=${path.join(outputDir, 'benchmark')}`,
      ...(options.baselinePath ? [`--baseline=${options.baselinePath}`] : []),
    ]),
    reportContract: {
      kind: 'benchmark',
      path: path.join(outputDir, 'benchmark', 'report.json'),
    },
  })
  stages.push({
    id: 'source-audit',
    label: 'Read-only source-derived data audit',
    required: full,
    timeoutMs: 15 * MINUTE_MS,
    skipReason: options.skipSourceAudit
      ? 'Explicitly skipped by --skip-source-audit'
      : sourceExists
        ? undefined
        : `Audit source is unavailable: ${options.sourcePath}`,
    ...nodeCommand('scripts/audit-source-derived-data.cjs', [
      `--source=${options.sourcePath}`,
      `--output=${path.join(outputDir, 'source-audit.json')}`,
      '--redact-paths',
    ]),
    reportContract: {
      kind: 'source-audit',
      path: path.join(outputDir, 'source-audit.json'),
    },
  })
  stages.push({
    id: 'media-player',
    label: 'Controlled media player smoke',
    required: true,
    timeoutMs: 10 * MINUTE_MS,
    ...npmCommand('smoke:media-player'),
  })
  if (full) {
    stages.push(
      {
        id: 'ui-locales',
        label: 'Chinese and English UI smoke',
        required: true,
        timeoutMs: 20 * MINUTE_MS,
        ...npmCommand('smoke:ui:locales'),
      },
      {
        id: 'ui-themes',
        label: 'Theme matrix UI smoke',
        required: true,
        timeoutMs: 20 * MINUTE_MS,
        ...npmCommand('smoke:ui:themes'),
      },
    )
  }
  return {
    schemaVersion: 1,
    kind: 'nightly-automation-plan',
    mode: options.mode,
    readOnlySources: true,
    capabilities: {
      sourceMutation: false,
      productDataDeletion: false,
      modelDownload: false,
      licenseAcceptance: false,
      network: full && options.allowNetwork,
      generatedBuildCleanup: full && options.allowGeneratedClean,
    },
    automationRoot: resolvedAutomationRoot,
    outputDir,
    datasetPath: options.datasetPath,
    sourcePath: options.sourcePath,
    baselinePath: options.baselinePath || null,
    datasetExists,
    sourceExists,
    baselineExists,
    stages,
    timeoutBudgetMs: stages.reduce((total, stage) => total + stage.timeoutMs, 0),
  }
}

function createBoundedCapture(
  maxBytes = MAX_STAGE_OUTPUT_BYTES,
  maxLineChars = MAX_OUTPUT_LINE_CHARS,
) {
  if (!Number.isInteger(maxBytes) || maxBytes < 64) {
    throw new Error('maxBytes must be an integer of at least 64')
  }
  let text = ''
  let pending = ''
  let truncated = false
  let discardUntilNewline = false
  const tailWithinBytes = (value, byteLimit) => {
    if (Buffer.byteLength(value, 'utf8') <= byteLimit) return value
    const buffer = Buffer.from(value)
    let bounded = buffer
      .subarray(Math.max(0, buffer.length - byteLimit))
      .toString('utf8')
      .replace(/^\uFFFD+/, '')
    while (Buffer.byteLength(bounded, 'utf8') > byteLimit) bounded = bounded.slice(1)
    return bounded
  }
  const appendLine = (line) => {
    if (line.length > maxLineChars) truncated = true
    const bounded =
      line.length > maxLineChars
        ? `${line.slice(0, maxLineChars)}\n[automation: line truncated]\n`
        : `${line}\n`
    const combined = text + bounded
    text = tailWithinBytes(combined, maxBytes)
    if (text !== combined) truncated = true
  }
  return {
    push(chunk) {
      pending += String(chunk)
      while (true) {
        const newline = pending.indexOf('\n')
        if (newline === -1) break
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (discardUntilNewline) {
          discardUntilNewline = false
          continue
        }
        appendLine(line)
      }
      if (pending.length > maxLineChars) {
        appendLine(pending.slice(0, maxLineChars + 1))
        pending = ''
        discardUntilNewline = true
        truncated = true
      }
    },
    finish() {
      if (pending && !discardUntilNewline) appendLine(pending)
      if (truncated) {
        const marker = '[automation: output truncated to bounded tail]\n'
        const bodyBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
        text = `${marker}${tailWithinBytes(text, bodyBudget)}`
        while (Buffer.byteLength(text, 'utf8') > maxBytes) text = text.slice(0, -1)
      }
      return { text, truncated }
    },
  }
}

function runStage(stage, options = {}) {
  return new Promise((resolve) => {
    const startedAt = new Date()
    const startedMs = Date.now()
    const stdout = createBoundedCapture()
    const stderr = createBoundedCapture()
    const child = spawn(stage.command, stage.args, {
      cwd: projectRoot,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, stage.timeoutMs)
    const finish = (exitCode, signal, error) => {
      clearTimeout(timer)
      const stdoutResult = stdout.finish()
      const stderrResult = stderr.finish()
      resolve({
        id: stage.id,
        label: stage.label,
        required: stage.required,
        status: exitCode === 0 && !error && !timedOut ? 'passed' : 'failed',
        exitCode,
        signal,
        timedOut,
        error,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        outputTruncated: stdoutResult.truncated || stderrResult.truncated,
      })
    }
    child.once('error', (error) => finish(null, null, error.message))
    child.once('exit', (exitCode, signal) => finish(exitCode, signal))
  })
}

function readStageReport(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function classifyStageResult(stage, result, readReport = readStageReport) {
  if (result.status !== 'passed' || !stage.reportContract) return result
  let report
  try {
    report = readReport(stage.reportContract.path)
  } catch (error) {
    return {
      ...result,
      status: 'incomplete',
      semanticDetail: `Required ${stage.reportContract.kind} report is unavailable or invalid`,
      reportError: error instanceof Error ? error.message : String(error),
    }
  }
  const withReport = (status, semanticDetail) => ({
    ...result,
    status,
    reportedStatus: report.status || null,
    semanticDetail,
  })
  if (stage.reportContract.kind === 'health' || stage.reportContract.kind === 'model') {
    return report.ok === true
      ? withReport('passed', 'Report confirms all required checks passed')
      : withReport('failed', 'Report contains one or more failed required checks')
  }
  if (stage.reportContract.kind === 'benchmark') {
    const comparisonStatus = report.comparison?.status
    if (comparisonStatus === 'passed' && report.ok === true) {
      return withReport('passed', 'Comparable approved baseline stayed within regression limits')
    }
    if (comparisonStatus === 'failed') {
      return withReport('failed', 'One or more comparable performance metrics regressed')
    }
    if (comparisonStatus === 'not-requested' || comparisonStatus === 'incomplete') {
      return withReport(
        'incomplete',
        comparisonStatus === 'not-requested'
          ? 'Benchmark observation completed without an approved comparison baseline'
          : 'Benchmark comparison is incomplete',
      )
    }
    return withReport(
      report.ok === true ? 'incomplete' : 'failed',
      'Benchmark report did not provide a conclusive comparable-baseline result',
    )
  }
  if (stage.reportContract.kind === 'source-audit') {
    if (report.status === 'passed') {
      return withReport('passed', 'Native and preview evidence completed')
    }
    if (report.status === 'partial') {
      return withReport('partial', 'Source audit completed with partial native evidence')
    }
    return withReport('failed', 'Source audit report did not pass')
  }
  return withReport('incomplete', 'Unknown report contract')
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function renderHtml(report) {
  const rows = report.stages
    .map(
      (stage) =>
        `<tr><td>${escapeHtml(stage.id)}</td><td>${escapeHtml(stage.status)}</td>` +
        `<td>${stage.required ? 'yes' : 'no'}</td><td>${stage.durationMs}</td>` +
        `<td>${escapeHtml(stage.skipReason || stage.semanticDetail || stage.error || '')}</td></tr>`,
    )
    .join('')
  return (
    '<!doctype html><meta charset="utf-8"><title>Nightly automation</title>' +
    '<style>body{font:14px system-ui;margin:24px;background:#111;color:#eee}' +
    'table{border-collapse:collapse;width:100%}td,th{border:1px solid #555;padding:6px;text-align:left}' +
    '.passed{color:#63d471}.failed{color:#ff6b6b}.partial,.incomplete,.running{color:#f4c95d}</style>' +
    `<h1>Nightly automation: <span class="${escapeHtml(report.status)}">${escapeHtml(
      report.status,
    )}</span></h1>` +
    `<p>Mode: ${escapeHtml(report.mode)}; generated: ${escapeHtml(report.generatedAt)}</p>` +
    '<table><thead><tr><th>Stage</th><th>Status</th><th>Required</th><th>ms</th><th>Detail</th>' +
    `</tr></thead><tbody>${rows}</tbody></table>`
  )
}

function replaceCaseInsensitive(value, source, replacement) {
  if (!source) return value
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return value.replace(new RegExp(escaped, 'gi'), replacement)
}

function redactText(value, plan) {
  const replacements = [
    [plan.datasetPath, '<DATASET>'],
    [plan.sourcePath, '<SOURCE>'],
    [plan.baselinePath, '<BASELINE>'],
    [projectRoot, '<PROJECT_ROOT>'],
    [path.resolve(process.env.USERPROFILE || ''), '<USER_PROFILE>'],
  ]
    .filter(([source]) => typeof source === 'string' && source.length > 0)
    .sort((left, right) => right[0].length - left[0].length)
  return replacements.reduce(
    (current, [source, replacement]) => replaceCaseInsensitive(current, source, replacement),
    String(value),
  )
}

async function writeFileAtomic(filePath, contents) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.partial`
  try {
    await fsp.writeFile(temporaryPath, contents, { flag: 'wx' })
    await fsp.rename(temporaryPath, filePath)
  } finally {
    await fsp.rm(temporaryPath, { force: true })
  }
}

function buildNightlyReport(plan, results, startedAt, complete) {
  const requiredFailures = results.filter((stage) => stage.required && stage.status !== 'passed')
  const optionalIncomplete = results.filter((stage) => !stage.required && stage.status !== 'passed')
  const status = !complete
    ? 'running'
    : requiredFailures.length
      ? 'failed'
      : optionalIncomplete.length
        ? 'partial'
        : 'passed'
  const statusCount = (value) => results.filter((stage) => stage.status === value).length
  const artifactDirectory = path
    .relative(plan.automationRoot, plan.outputDir)
    .split(path.sep)
    .join('/')
  return {
    schemaVersion: 1,
    kind: 'nightly-automation-report',
    mode: plan.mode,
    status,
    complete,
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    datasetPath: plan.datasetPath,
    sourcePath: plan.sourcePath,
    baselinePath: plan.baselinePath,
    readOnlySources: true,
    timeoutBudgetMs: plan.timeoutBudgetMs,
    summary: {
      total: plan.stages.length,
      completed: results.length,
      passed: statusCount('passed'),
      failed: statusCount('failed'),
      partial: statusCount('partial'),
      incomplete: statusCount('incomplete'),
      skipped: statusCount('skipped'),
      requiredFailures: requiredFailures.length,
    },
    artifacts: {
      directory: artifactDirectory,
      json: `${artifactDirectory}/nightly-report.json`,
      html: `${artifactDirectory}/nightly-report.html`,
    },
    stages: results,
  }
}

function redactReport(report, plan, enabled) {
  return enabled ? JSON.parse(redactText(JSON.stringify(report), plan)) : structuredClone(report)
}

async function persistNightlyCheckpoint(plan, options, results, startedAt, complete) {
  const report = buildNightlyReport(plan, results, startedAt, complete)
  const persisted = redactReport(report, plan, options.redactPaths)
  for (const stage of persisted.stages) {
    const logs = {}
    if (stage.stdout) {
      const fileName = `${stage.id}.stdout.log`
      await writeFileAtomic(path.join(plan.outputDir, fileName), stage.stdout)
      logs.stdout = fileName
      delete stage.stdout
    }
    if (stage.stderr) {
      const fileName = `${stage.id}.stderr.log`
      await writeFileAtomic(path.join(plan.outputDir, fileName), stage.stderr)
      logs.stderr = fileName
      delete stage.stderr
    }
    if (Object.keys(logs).length > 0) stage.logs = logs
  }
  persisted.checkpoint = {
    complete,
    completedStages: results.length,
    updatedAt: new Date().toISOString(),
  }
  const jsonPath = path.join(plan.outputDir, 'nightly-report.json')
  const htmlPath = path.join(plan.outputDir, 'nightly-report.html')
  await writeFileAtomic(jsonPath, `${JSON.stringify(persisted, null, 2)}\n`)
  await writeFileAtomic(htmlPath, renderHtml(persisted))
  return persisted
}

async function runNightly(options, dependencies = {}) {
  const plan = createPlan(
    options,
    dependencies.exists || fs.existsSync,
    dependencies.automationRoot || PRODUCTION_AUTOMATION_ROOT,
  )
  if (options.plan) {
    return options.redactPaths
      ? JSON.parse(redactText(JSON.stringify(plan), plan))
      : structuredClone(plan)
  }
  await fsp.mkdir(plan.outputDir, { recursive: true })
  if (!isStrictlyWithin(fs.realpathSync(plan.automationRoot), fs.realpathSync(plan.outputDir))) {
    throw new Error('Nightly output directory escaped the automation root after creation')
  }
  const executeStage = dependencies.runStage || runStage
  const classify = dependencies.classifyStageResult || classifyStageResult
  const results = []
  const startedAt = new Date()
  await persistNightlyCheckpoint(plan, options, results, startedAt, false)
  for (const stage of plan.stages) {
    if (stage.skipReason) {
      results.push({
        id: stage.id,
        label: stage.label,
        required: stage.required,
        status: 'skipped',
        skipReason: stage.skipReason,
        durationMs: 0,
      })
      await persistNightlyCheckpoint(plan, options, results, startedAt, false)
      continue
    }
    process.stdout.write(`[nightly] start ${stage.id}: ${stage.label}\n`)
    let rawResult
    try {
      rawResult = await executeStage(stage)
    } catch (error) {
      rawResult = {
        id: stage.id,
        label: stage.label,
        required: stage.required,
        status: 'failed',
        exitCode: null,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
        stdout: '',
        stderr: '',
      }
    }
    const result = await classify(stage, rawResult)
    results.push(result)
    process.stdout.write(`[nightly] ${result.status} ${stage.id} (${result.durationMs} ms)\n`)
    await persistNightlyCheckpoint(plan, options, results, startedAt, false)
  }
  return persistNightlyCheckpoint(plan, options, results, startedAt, true)
}

async function main() {
  try {
    const options = parseArgs()
    const report = await runNightly(options)
    if (options.plan || options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else if (!options.plan) {
      process.stdout.write(
        `[nightly] ${report.status}: ${report.summary.passed}/${report.summary.total} passed; ` +
          `report=${report.artifacts.json}\n`,
      )
    }
    if (!options.plan && report.status === 'failed') process.exitCode = 1
  } catch (error) {
    process.stderr.write(`[nightly] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) void main()

module.exports = {
  PRODUCTION_AUTOMATION_ROOT,
  buildNightlyReport,
  canonicalPathForWrite,
  classifyStageResult,
  createBoundedCapture,
  createPlan,
  defaultOutputDir,
  isStrictlyWithin,
  isWithin,
  parseArgs,
  persistNightlyCheckpoint,
  redactText,
  resolveNpmInvocation,
  renderHtml,
  runNightly,
  runStage,
  writeFileAtomic,
}
