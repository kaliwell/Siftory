#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { loadTsModule } = require('../tests/guard-utils.cjs')
const { buildValueTodoSnapshot, parseValueTaskRows } = require('./next-value-optimization-task.cjs')
const { validateRuntimeManifest } = require('./validate-runtime-manifest.cjs')
const { inspectCudaApprovals } = require('./check-cuda-approval.cjs')

const projectRoot = path.resolve(__dirname, '..')
const defaultPlanPath = path.join(
  projectRoot,
  'docs',
  'current',
  '2026-08-07-value-ranked-optimization-todo.md',
)
const defaultStatePath = path.join(
  projectRoot,
  'artifacts',
  'value-optimization',
  'automation-state.json',
)
const defaultReportPath = path.join(projectRoot, 'artifacts', 'value-optimization', 'last-run.json')
const REQUIRED_OBSERVATION_CYCLES = 3
const MIN_OBSERVATION_INTERVAL_MS = 24 * 60 * 60 * 1000
const RECALL_EVIDENCE_CONTRACT_VERSION = 2
const AUTOMATED_TASK_IDS = new Set(['VAL-011', 'VAL-003', 'VAL-005', 'VAL-008'])
const CUDA_DECISION_IDS = [
  'microsoft-onnxruntime-gpu-windows-1-24-3',
  'nvidia-cuda-12-8-embedding-runtime',
  'nvidia-cudnn-9-19-1-cuda12-runtime',
  'floating-clock-cuda-embedding-worker',
]
const CUDA_POST_APPROVAL_TEST_FILES = [
  'tests/cuda-runtime-installer.test.cjs',
  'tests/cuda-embedding-worker.test.cjs',
  'tests/runtime-manifest.test.cjs',
  'tests/runtime-resource-fetch.test.cjs',
  'tests/package-profile.test.cjs',
]
const RECALL_EVIDENCE_FILES = [
  'electron/authoritativeVectorStore.ts',
  'electron/embeddingF16Cache.ts',
  'electron/embeddingVectorValidation.ts',
  'electron/vectorGenerationRecall.ts',
  'scripts/verify-vector-generation-recall.cjs',
]

function valueAfter(argument, prefix) {
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : undefined
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    planPath: defaultPlanPath,
    statePath: defaultStatePath,
    reportPath: defaultReportPath,
    userDataPath: path.join(process.env.APPDATA || '', 'floating-clock-electron'),
    taskIds: [],
  }
  for (const argument of argv) {
    const planPath = valueAfter(argument, '--plan=')
    const statePath = valueAfter(argument, '--state=')
    const reportPath = valueAfter(argument, '--report=')
    const userDataPath = valueAfter(argument, '--user-data=')
    const taskId = valueAfter(argument, '--task=')
    if (argument === '--dry-run') options.dryRun = true
    else if (planPath !== undefined) options.planPath = path.resolve(planPath)
    else if (statePath !== undefined) options.statePath = path.resolve(statePath)
    else if (reportPath !== undefined) options.reportPath = path.resolve(reportPath)
    else if (userDataPath !== undefined) options.userDataPath = path.resolve(userDataPath)
    else if (taskId !== undefined) options.taskIds.push(taskId)
    else throw new Error(`Unknown argument: ${argument}`)
  }
  for (const taskId of options.taskIds) {
    if (!AUTOMATED_TASK_IDS.has(taskId)) throw new Error(`Task ${taskId} has no safe automation`)
  }
  return options
}

function emptyState() {
  return { schemaVersion: 1, observationCycles: {} }
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(statePath, 'utf8'))
    if (parsed?.schemaVersion !== 1 || typeof parsed.observationCycles !== 'object') {
      throw new Error('unsupported state schema')
    }
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState()
    throw new Error(`Could not read automation state: ${error.message}`, { cause: error })
  }
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.partial`
  try {
    await fsp.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await fsp.rename(temporaryPath, filePath)
  } finally {
    await fsp.rm(temporaryPath, { force: true })
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function recallEvidenceContractFingerprint() {
  const hash = crypto.createHash('sha256')
  hash.update(`recall-evidence-contract:${RECALL_EVIDENCE_CONTRACT_VERSION}\n`)
  for (const relativePath of RECALL_EVIDENCE_FILES) {
    hash.update(`${relativePath}\0`)
    hash.update(fs.readFileSync(path.join(projectRoot, relativePath)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function compatibleObservationCycles(cycles, evidenceContract, snapshotFingerprint) {
  if (!Array.isArray(cycles) || !evidenceContract || !snapshotFingerprint) return []
  return cycles.filter(
    (cycle) =>
      cycle?.gatePassed === true &&
      cycle.evidenceContract === evidenceContract &&
      cycle.snapshotFingerprint === snapshotFingerprint,
  )
}

function observationStatus(cycles, nowMs) {
  const accepted = Array.isArray(cycles) ? cycles : []
  const lastAt = accepted.length > 0 ? Date.parse(accepted.at(-1).recordedAt) : Number.NaN
  const dueAt = Number.isFinite(lastAt) ? lastAt + MIN_OBSERVATION_INTERVAL_MS : nowMs
  return {
    acceptedCycles: accepted.length,
    requiredCycles: REQUIRED_OBSERVATION_CYCLES,
    completionReady: accepted.length >= REQUIRED_OBSERVATION_CYCLES,
    due: accepted.length < REQUIRED_OBSERVATION_CYCLES && nowMs >= dueAt,
    dueAt: new Date(dueAt).toISOString(),
  }
}

function acceptObservationCycle(cycles, cycle, nowMs) {
  let current = Array.isArray(cycles) ? [...cycles] : []
  if (cycle.evidenceContract && cycle.snapshotFingerprint) {
    current = compatibleObservationCycles(
      current,
      cycle.evidenceContract,
      cycle.snapshotFingerprint,
    )
  }
  const status = observationStatus(current, nowMs)
  if (!status.due || status.completionReady || cycle.gatePassed !== true) {
    return { cycles: current, accepted: false, status }
  }
  current.push(cycle)
  return {
    cycles: current.slice(-REQUIRED_OBSERVATION_CYCLES),
    accepted: true,
    status: observationStatus(current, nowMs),
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || projectRoot,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const maxBytes = options.maxBytes || 16 * 1024 * 1024
    const append = (current, chunk) => {
      if (Buffer.byteLength(current) >= maxBytes) return current
      return `${current}${chunk}`.slice(0, maxBytes)
    }
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    const timer = setTimeout(() => child.kill(), options.timeoutMs || 30 * 60 * 1000)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ exitCode: null, stdout, stderr, error: error.message })
    })
    child.on('exit', (exitCode, signal) => {
      clearTimeout(timer)
      resolve({ exitCode, signal, stdout, stderr })
    })
  })
}

function recallSnapshotFingerprint(reports) {
  if (
    reports.length !== 2 ||
    !reports.every(
      (report) =>
        typeof report.modelName === 'string' &&
        typeof report.snapshotFingerprint === 'string' &&
        report.snapshotFingerprint.length === 64,
    )
  ) {
    return undefined
  }
  return sha256(
    reports
      .map((report) => `${report.modelName}:${report.snapshotFingerprint}`)
      .sort()
      .join('\n'),
  )
}

function summarizeRecallReport(stdout) {
  const parsed = JSON.parse(stdout)
  const reports = Array.isArray(parsed.reports) ? parsed.reports : []
  const snapshotFingerprint = recallSnapshotFingerprint(reports)
  return {
    generatedAt: parsed.generatedAt,
    gatePassed: reports.length === 2 && reports.every((report) => report.gatePassed === true),
    snapshotFingerprint,
    reports: reports.map((report) => ({
      modelName: report.modelName,
      gatePassed: report.gatePassed === true,
      queryCount: report.queryCount,
      topK: report.topK,
      scoreEquivalentRecall: report.scoreEquivalentRecall,
      strictPathRecall: report.strictPathRecall,
      malformedRows: report.malformedRows,
      cacheVersion: report.cacheVersion,
      generation: report.generation,
      snapshotFingerprint: report.snapshotFingerprint,
    })),
  }
}

function summarizeRecallSnapshot(stdout) {
  const parsed = JSON.parse(stdout)
  const reports = Array.isArray(parsed.reports) ? parsed.reports : []
  const ready =
    parsed.snapshotOnly === true &&
    reports.length === 2 &&
    reports.every(
      (report) =>
        report.ready === true &&
        typeof report.modelName === 'string' &&
        typeof report.snapshotFingerprint === 'string' &&
        report.snapshotFingerprint.length === 64,
    )
  const snapshotFingerprint = ready ? recallSnapshotFingerprint(reports) : undefined
  return { ready, snapshotFingerprint, reports }
}

async function runCudaPostApprovalVerification(context = {}) {
  const runtimeProjectRoot = context.projectRoot || projectRoot
  const run = context.runProcess || runProcess
  const result = await run(
    process.execPath,
    [
      '--test',
      ...CUDA_POST_APPROVAL_TEST_FILES.map((relativePath) =>
        path.join(runtimeProjectRoot, relativePath),
      ),
    ],
    { cwd: runtimeProjectRoot, timeoutMs: 15 * 60 * 1000 },
  )
  const passed = result.exitCode === 0
  return {
    status: passed ? 'passed' : 'failed',
    ran: true,
    passed,
    exitCode: result.exitCode,
    signal: result.signal,
    error: result.error,
    testFiles: [...CUDA_POST_APPROVAL_TEST_FILES],
  }
}

async function runCudaProbe(context = {}) {
  const runtimeProjectRoot = context.projectRoot || projectRoot
  const manifestPath = path.join(runtimeProjectRoot, 'resources', 'runtime-manifest.json')
  const decisionsPath = path.join(runtimeProjectRoot, 'legal', 'license-decisions.json')
  const manifest = context.manifest || JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
  const validation = validateRuntimeManifest(manifest)
  const decisions = context.decisions || JSON.parse(await fsp.readFile(decisionsPath, 'utf8'))
  const approvalReport = inspectCudaApprovals({
    projectRoot: runtimeProjectRoot,
    decisions,
    packageJson: context.packageJson,
    nowMs: context.nowMs,
  })
  const approval = approvalReport.components
  const defaultBundled = manifest.components
    .filter((component) => CUDA_DECISION_IDS.includes(component.id))
    .some((component) => component.distribution?.defaultBundled === true)
  const implementationReady = validation.ok && !defaultBundled
  let postApprovalVerification = {
    status: approvalReport.ok && implementationReady ? 'pending' : 'waiting-for-prerequisites',
    ran: false,
    passed: false,
    testFiles: [...CUDA_POST_APPROVAL_TEST_FILES],
  }
  if (approvalReport.ok && implementationReady) {
    postApprovalVerification = await runCudaPostApprovalVerification({
      projectRoot: runtimeProjectRoot,
      runProcess: context.runProcess,
    })
  }
  const waitingFor = []
  waitingFor.push(...validation.errors.map((error) => `runtime manifest: ${error}`))
  if (defaultBundled) waitingFor.push('CUDA optional runtime must remain defaultBundled=false')
  waitingFor.push(
    ...approval.flatMap((item) => item.reasons.map((reason) => `${item.id}: ${reason}`)),
    ...approvalReport.project.reasons.map((reason) => `project license decision: ${reason}`),
  )
  if (approvalReport.ok && implementationReady && !postApprovalVerification.passed) {
    waitingFor.push('post-approval CUDA technical verification must pass')
  }
  return {
    action: 'license-gate',
    technicalReady: implementationReady,
    manifestErrors: validation.errors,
    defaultBundled,
    approval,
    projectApproval: approvalReport.project,
    postApprovalVerification,
    completionReady: implementationReady && approvalReport.ok && postApprovalVerification.passed,
    automaticMutation: false,
    waitingFor,
  }
}

async function runRecallProbe(context) {
  const evidenceContract = recallEvidenceContractFingerprint()
  const existingCycles = context.state.observationCycles['VAL-003'] || []
  const snapshotResult = await context.runProcess(
    process.execPath,
    [
      path.join(projectRoot, 'scripts', 'verify-vector-generation-recall.cjs'),
      context.userDataPath,
      '--snapshot-only',
    ],
    { timeoutMs: 2 * 60 * 1000 },
  )
  let snapshot
  try {
    snapshot = summarizeRecallSnapshot(snapshotResult.stdout)
    snapshot.ready = snapshotResult.exitCode === 0 && snapshot.ready
    if (!snapshot.ready) snapshot.snapshotFingerprint = undefined
  } catch (error) {
    snapshot = { ready: false, reports: [], parseError: error.message }
  }
  const cycles = compatibleObservationCycles(
    existingCycles,
    evidenceContract,
    snapshot.snapshotFingerprint,
  )
  const invalidatedCycles = Math.max(0, existingCycles.length - cycles.length)
  context.state.observationCycles['VAL-003'] = cycles
  const before = observationStatus(cycles, context.nowMs)
  if (before.completionReady || !before.due) {
    return {
      action: 'recall-observation',
      ...before,
      evidenceContract,
      snapshotFingerprint: snapshot.snapshotFingerprint,
      snapshotReady: snapshot.ready,
      invalidatedCycles,
      automaticMutation: false,
      waitingFor: before.completionReady ? [] : [`next observation window: ${before.dueAt}`],
    }
  }
  const result = await context.runProcess(
    process.execPath,
    [
      path.join(projectRoot, 'scripts', 'verify-vector-generation-recall.cjs'),
      context.userDataPath,
      '--queries=32',
      '--top-k=10',
    ],
    { timeoutMs: 30 * 60 * 1000 },
  )
  let summary
  try {
    summary = summarizeRecallReport(result.stdout)
  } catch (error) {
    summary = { gatePassed: false, reports: [], parseError: error.message }
  }
  const cycle = {
    recordedAt: new Date(context.nowMs).toISOString(),
    gatePassed: result.exitCode === 0 && summary.gatePassed === true,
    evidenceSha256: sha256(result.stdout),
    evidenceContract,
    snapshotFingerprint: summary.snapshotFingerprint || snapshot.snapshotFingerprint,
    reports: summary.reports,
  }
  const accepted = acceptObservationCycle(cycles, cycle, context.nowMs)
  context.state.observationCycles['VAL-003'] = accepted.cycles
  let migrationPreview
  if (!cycle.gatePassed && /unavailable or stale/.test(result.stderr)) {
    const previewResult = await context.runProcess(
      process.execPath,
      [path.join(projectRoot, 'scripts', 'migrate-vector-store.cjs'), context.userDataPath],
      { timeoutMs: 10 * 60 * 1000 },
    )
    try {
      const parsed = JSON.parse(previewResult.stdout)
      migrationPreview = {
        exitCode: previewResult.exitCode,
        models: parsed.models,
        sourceBytes: parsed.sourceBytes,
        estimatedBinaryBytes: parsed.estimatedBinaryBytes,
        executeCommand:
          'npm.cmd run vector-store:migrate -- "%APPDATA%\\floating-clock-electron" --execute',
      }
    } catch (error) {
      migrationPreview = {
        exitCode: previewResult.exitCode,
        error: error.message,
        stderrTail: previewResult.stderr.slice(-2000),
      }
    }
  }
  return {
    action: 'recall-observation',
    exitCode: result.exitCode,
    accepted: accepted.accepted,
    ...accepted.status,
    report: summary,
    evidenceContract,
    snapshotFingerprint: cycle.snapshotFingerprint,
    snapshotReady: snapshot.ready,
    invalidatedCycles,
    migrationPreview,
    stderrTail: result.stderr.slice(-2000),
    automaticMutation: false,
    waitingFor: accepted.status.completionReady
      ? []
      : cycle.gatePassed
        ? [`next observation window: ${accepted.status.dueAt}`]
        : ['passing recall observation'],
  }
}

async function runCleanupPreview(context) {
  const { previewStorageCleanup } = loadTsModule('electron/storageCleanupService.ts')
  const preview = await previewStorageCleanup(context.userDataPath)
  const items = preview.items.map((item) => ({
    id: item.id,
    cleanupRisk: item.cleanupRisk,
    estimatedBytes: item.estimatedBytes,
    fileCount: item.fileCount,
  }))
  return {
    action: 'cleanup-preview',
    estimatedBytes: preview.estimatedBytes,
    items,
    completionReady: preview.estimatedBytes === 0,
    automaticMutation: false,
    waitingFor:
      preview.estimatedBytes === 0
        ? []
        : ['fresh preview review and explicit user selection in Storage Management'],
  }
}

async function findFastScannerLoadSites() {
  const root = path.join(projectRoot, 'electron')
  const files = []
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift()
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(target)
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(target)
    }
  }
  const sites = []
  for (const filePath of files) {
    const source = await fsp.readFile(filePath, 'utf8')
    if (/fast_scanner\.node/.test(source)) {
      sites.push(path.relative(projectRoot, filePath).replaceAll('\\', '/'))
    }
  }
  return sites.sort()
}

async function runFastScannerTriggerProbe() {
  const loadSites = await findFastScannerLoadSites()
  const triggered = loadSites.length > 1
  return {
    action: 'trigger-detection',
    loadSites,
    triggered,
    completionReady: false,
    automaticMutation: false,
    waitingFor: triggered
      ? ['implementation of queued multi-env owner protocol']
      : ['second production FastScanner addon environment'],
  }
}

const PROBES = {
  'VAL-011': runCudaProbe,
  'VAL-003': runRecallProbe,
  'VAL-005': runCleanupPreview,
  'VAL-008': runFastScannerTriggerProbe,
}

function dryRunResult(task) {
  return {
    action:
      task.id === 'VAL-011'
        ? 'license-gate'
        : task.id === 'VAL-003'
          ? 'recall-observation'
          : task.id === 'VAL-005'
            ? 'cleanup-preview'
            : 'trigger-detection',
    planned: true,
    automaticMutation: false,
    waitingFor: task.externalBlockers,
  }
}

async function runAutomation(options, dependencies = {}) {
  const nowMs = dependencies.nowMs ?? Date.now()
  const markdown = await fsp.readFile(options.planPath, 'utf8')
  const tasks = parseValueTaskRows(markdown)
  const todo = buildValueTodoSnapshot(tasks)
  if (!todo.ok) throw new Error(`Invalid value TODO: ${todo.errors.join('; ')}`)
  const selected = tasks.filter(
    (task) =>
      task.status !== 'verified' &&
      AUTOMATED_TASK_IDS.has(task.id) &&
      (options.taskIds.length === 0 || options.taskIds.includes(task.id)),
  )
  const state = options.dryRun ? emptyState() : await readState(options.statePath)
  const context = {
    nowMs,
    state,
    userDataPath: options.userDataPath,
    runProcess: dependencies.runProcess || runProcess,
  }
  const results = []
  for (const task of selected) {
    try {
      const probe = options.dryRun ? dryRunResult(task) : await PROBES[task.id](context)
      results.push({
        id: task.id,
        mode: task.mode,
        status: task.status,
        value: task.value,
        ...probe,
      })
    } catch (error) {
      results.push({
        id: task.id,
        mode: task.mode,
        status: task.status,
        value: task.value,
        action: 'probe-error',
        completionReady: false,
        automaticMutation: false,
        waitingFor: ['successful safe probe'],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    dryRun: options.dryRun,
    safety: {
      deletesUserData: false,
      acceptsLicenses: false,
      changesTaskStatus: false,
      runsOnlyAllowlistedProbes: true,
    },
    counts: {
      remaining: tasks.filter((task) => task.status !== 'verified').length,
      probed: results.length,
      completionReady: results.filter((result) => result.completionReady).length,
      waiting: results.filter((result) => !result.completionReady).length,
      errors: results.filter((result) => result.error).length,
    },
    results,
  }
  if (!options.dryRun) {
    state.schemaVersion = 1
    state.updatedAt = report.generatedAt
    await writeJsonAtomic(options.statePath, state)
    await writeJsonAtomic(options.reportPath, report)
  }
  return report
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    const report = await runAutomation(options)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.counts.errors > 0) process.exitCode = 1
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  AUTOMATED_TASK_IDS,
  CUDA_POST_APPROVAL_TEST_FILES,
  MIN_OBSERVATION_INTERVAL_MS,
  RECALL_EVIDENCE_CONTRACT_VERSION,
  REQUIRED_OBSERVATION_CYCLES,
  acceptObservationCycle,
  compatibleObservationCycles,
  observationStatus,
  parseArgs,
  runAutomation,
  runCudaPostApprovalVerification,
  runCudaProbe,
  recallEvidenceContractFingerprint,
  summarizeRecallReport,
  summarizeRecallSnapshot,
}
