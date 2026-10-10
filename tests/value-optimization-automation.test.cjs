const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const currentDecisions = require('../legal/license-decisions.json')
const packageJson = require('../package.json')
const runtimeManifest = require('../resources/runtime-manifest.json')
const { CUDA_APPROVAL_CONFIG } = require('../scripts/check-cuda-approval.cjs')
const {
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
  runCudaProbe,
  recallEvidenceContractFingerprint,
  summarizeRecallReport,
  summarizeRecallSnapshot,
} = require('../scripts/run-value-optimization-todo.cjs')
const {
  acquireObservationLock,
  nextOptimizationRunAt,
  nextObservationRunAt,
  parseArgs: parseObservationSchedulerArgs,
  processExists,
  readVectorCompletion,
  summarizeScheduledResults,
} = require('../scripts/schedule-value-observations.cjs')
const { parseValueTaskRows } = require('../scripts/next-value-optimization-task.cjs')

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-value-auto-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function approvedCudaContext(t, runProcess) {
  const root = makeRoot(t)
  const decisions = structuredClone(currentDecisions)
  fs.mkdirSync(path.join(root, 'legal'), { recursive: true })
  fs.writeFileSync(path.join(root, 'legal', 'FINAL-EULA.txt'), 'fixture final project license')
  fs.writeFileSync(path.join(root, 'legal', 'UPSTREAM-NOTICES.txt'), 'fixture notices')
  Object.assign(decisions.project, {
    status: 'approved',
    releaseMode: 'proprietary',
    licenseExpression: packageJson.license,
    licenseFile: 'legal/FINAL-EULA.txt',
    approvedBy: 'fixture-authorized-reviewer',
    approvedAt: '2026-08-09T00:00:00.000Z',
    evidence: ['fixture-project-approval-record'],
  })
  for (const config of CUDA_APPROVAL_CONFIG) {
    Object.assign(decisions.components[config.id], {
      status: 'approved',
      resolution: config.resolution,
      permittedProfiles: ['online', 'offline'],
      approvedBy: 'fixture-authorized-reviewer',
      approvedAt: '2026-08-09T00:00:00.000Z',
      evidence: ['fixture-component-approval-record'],
      licenseFiles: ['legal/UPSTREAM-NOTICES.txt'],
      approvalScope: {
        distributionChannels: ['fixture-private-channel'],
        territories: ['fixture-territory'],
        exportEndUseConfirmed: true,
        noticesIncludedConfirmed: true,
        agreementAcceptedConfirmed: true,
        applicationOnlyAccessConfirmed: true,
        materialAdditionalFunctionalityConfirmed: true,
        agreementAcceptanceReference: 'fixture-agreement-reference',
        authorityToLicenseConfirmed: true,
      },
    })
  }
  decisions.components['floating-clock-cuda-embedding-worker'].licenseFiles = [
    'legal/FINAL-EULA.txt',
  ]
  return {
    projectRoot: root,
    manifest: structuredClone(runtimeManifest),
    decisions,
    packageJson,
    nowMs: Date.parse('2026-08-09T12:00:00.000Z'),
    runProcess,
  }
}

test('automation CLI fixes the safe task allowlist and keeps dry-run explicit', () => {
  const parsed = parseArgs([
    '--dry-run',
    '--task=VAL-003',
    '--user-data=fixture-user-data',
    '--state=fixture-state.json',
  ])
  assert.equal(parsed.dryRun, true)
  assert.deepEqual(parsed.taskIds, ['VAL-003'])
  assert.equal(path.basename(parsed.statePath), 'fixture-state.json')
  assert.throws(() => parseArgs(['--task=VAL-001']), /no safe automation/)
  assert.deepEqual([...AUTOMATED_TASK_IDS].sort(), ['VAL-003', 'VAL-005', 'VAL-008', 'VAL-011'])
})

test('observation cycles require three passing windows at least 24 hours apart', () => {
  const start = Date.parse('2026-08-08T00:00:00.000Z')
  let cycles = []
  let result = acceptObservationCycle(
    cycles,
    { recordedAt: new Date(start).toISOString(), gatePassed: true },
    start,
  )
  assert.equal(result.accepted, true)
  cycles = result.cycles
  result = acceptObservationCycle(
    cycles,
    { recordedAt: new Date(start + 1000).toISOString(), gatePassed: true },
    start + 1000,
  )
  assert.equal(result.accepted, false)
  for (let index = 1; index < REQUIRED_OBSERVATION_CYCLES; index++) {
    const now = start + index * MIN_OBSERVATION_INTERVAL_MS
    result = acceptObservationCycle(
      cycles,
      { recordedAt: new Date(now).toISOString(), gatePassed: true },
      now,
    )
    assert.equal(result.accepted, true)
    cycles = result.cycles
  }
  assert.equal(observationStatus(cycles, start).completionReady, true)
})

test('failed recall evidence is never accepted as a maintenance cycle', () => {
  const now = Date.parse('2026-08-08T00:00:00.000Z')
  const result = acceptObservationCycle(
    [],
    { recordedAt: new Date(now).toISOString(), gatePassed: false },
    now,
  )
  assert.equal(result.accepted, false)
  assert.deepEqual(result.cycles, [])
})

test('observation evidence is invalidated when the gate contract or vector snapshot changes', () => {
  const contract = 'a'.repeat(64)
  const snapshot = 'b'.repeat(64)
  const cycle = {
    recordedAt: '2026-08-08T00:00:00.000Z',
    gatePassed: true,
    evidenceContract: contract,
    snapshotFingerprint: snapshot,
  }
  assert.deepEqual(compatibleObservationCycles([cycle], contract, snapshot), [cycle])
  assert.deepEqual(compatibleObservationCycles([cycle], 'c'.repeat(64), snapshot), [])
  assert.deepEqual(compatibleObservationCycles([cycle], contract, 'd'.repeat(64)), [])
  assert.equal(RECALL_EVIDENCE_CONTRACT_VERSION, 2)
  assert.match(recallEvidenceContractFingerprint(), /^[a-f0-9]{64}$/)
})

test('a passing cycle on a new snapshot restarts the 24-hour sequence immediately', () => {
  const now = Date.parse('2026-08-08T00:00:01.000Z')
  const old = {
    recordedAt: new Date(now - 1000).toISOString(),
    gatePassed: true,
    evidenceContract: 'a'.repeat(64),
    snapshotFingerprint: 'b'.repeat(64),
  }
  const next = {
    recordedAt: new Date(now).toISOString(),
    gatePassed: true,
    evidenceContract: 'a'.repeat(64),
    snapshotFingerprint: 'c'.repeat(64),
  }
  const result = acceptObservationCycle([old], next, now)
  assert.equal(result.accepted, true)
  assert.deepEqual(result.cycles, [next])
  assert.equal(result.status.acceptedCycles, 1)
})

test('observation scheduler follows the authoritative due time and retry delay', () => {
  const parsed = parseObservationSchedulerArgs(['--user-data=fixture-user-data', '--retry-ms=20'])
  assert.equal(path.basename(parsed.userDataPath), 'fixture-user-data')
  assert.equal(parsed.retryMs, 1000)
  assert.equal(parsed.approvalPollMs, 60 * 60 * 1000)
  assert.equal(path.basename(parsed.vectorStatePath), 'vector-coverage-repair-state.json')
  assert.deepEqual(
    parsed.vectorStatePaths.map((item) => path.basename(item)),
    ['vector-coverage-repair-state.json', 'vector-rebuild-state.json'],
  )

  const now = Date.parse('2026-08-09T00:00:00.000Z')
  const dueAt = now + MIN_OBSERVATION_INTERVAL_MS
  assert.equal(
    nextObservationRunAt({ due: false, dueAt: new Date(dueAt).toISOString() }, now, 60 * 60 * 1000),
    dueAt,
  )
  assert.equal(nextObservationRunAt({ due: true }, now, 5000), now + 5000)
  assert.equal(nextObservationRunAt({ completionReady: true }, now, 5000), undefined)
  assert.equal(
    nextOptimizationRunAt(
      [
        { id: 'VAL-003', due: false, dueAt: new Date(dueAt).toISOString() },
        { id: 'VAL-011', completionReady: false },
      ],
      now,
      5000,
      60 * 60 * 1000,
    ),
    now + 60 * 60 * 1000,
  )
  assert.equal(
    nextOptimizationRunAt(
      [
        { id: 'VAL-003', completionReady: true },
        { id: 'VAL-011', completionReady: true },
      ],
      now,
      5000,
      60 * 60 * 1000,
    ),
    undefined,
  )
  assert.equal(
    nextOptimizationRunAt([{ id: 'VAL-011', completionReady: false }], now, 5000, 60 * 60 * 1000),
    now + 60 * 60 * 1000,
  )
})

test('scheduled summary exposes the CUDA post-approval verification phase', () => {
  const summary = summarizeScheduledResults({
    generatedAt: '2026-08-09T12:00:00.000Z',
    results: [
      {
        id: 'VAL-011',
        technicalReady: true,
        completionReady: false,
        approval: [{ complete: true }, { complete: false }],
        projectApproval: { complete: true },
        postApprovalVerification: { status: 'waiting-for-prerequisites' },
      },
    ],
  })
  assert.deepEqual(summary.results[0], {
    id: 'VAL-011',
    technicalReady: true,
    completionReady: false,
    incompleteComponents: 1,
    projectApprovalComplete: true,
    postApprovalVerification: 'waiting-for-prerequisites',
  })
})

test('one-shot observation accepts either bounded coverage repair or legacy rebuild', async (t) => {
  const root = makeRoot(t)
  const failed = path.join(root, 'vector-rebuild-state.json')
  const completed = path.join(root, 'vector-coverage-repair-state.json')
  fs.writeFileSync(failed, JSON.stringify({ phase: 'error', error: 'old full scan failed' }))
  fs.writeFileSync(completed, JSON.stringify({ phase: 'completed', completedAt: 'now' }))
  const result = await readVectorCompletion({
    vectorStatePaths: [completed, failed],
  })
  assert.equal(result.completed.phase, 'completed')
  assert.equal(result.completed.stateFile, completed)
  assert.deepEqual(
    result.phases.map((item) => item.phase),
    ['completed', 'error'],
  )
})

test('one-shot observation exits cleanly when vector work is not complete', async (t) => {
  const root = makeRoot(t)
  const failed = path.join(root, 'vector-rebuild-state.json')
  const missing = path.join(root, 'vector-coverage-repair-state.json')
  fs.writeFileSync(failed, JSON.stringify({ phase: 'error' }))
  const result = await readVectorCompletion({ vectorStatePaths: [missing, failed] })
  assert.equal(result.completed, undefined)
  assert.deepEqual(
    result.phases.map((item) => item.phase),
    ['unavailable', 'error'],
  )
})

test('observation scheduler lock rejects a live duplicate and recovers a dead owner', (t) => {
  const root = makeRoot(t)
  const lockPath = path.join(root, 'value-observations.lock')
  const release = acquireObservationLock(lockPath)
  assert.equal(processExists(process.pid), true)
  assert.throws(() => acquireObservationLock(lockPath), /already running/)
  release()
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647 }))
  const releaseRecovered = acquireObservationLock(lockPath)
  assert.equal(fs.existsSync(lockPath), true)
  assert.equal(
    fs.readdirSync(root).some((name) => name.startsWith('value-observations.lock.stale-')),
    true,
  )
  releaseRecovered()
})

test('recall report summary requires both model gates', () => {
  const summary = summarizeRecallReport(
    JSON.stringify({
      generatedAt: '2026-08-08T00:00:00.000Z',
      reports: [
        { modelName: 'clip_vit_base_patch32', gatePassed: true, queryCount: 32, topK: 10 },
        { modelName: 'dinov2_vitb14', gatePassed: true, queryCount: 32, topK: 10 },
      ],
    }),
  )
  assert.equal(summary.gatePassed, true)
  assert.equal(summary.reports.length, 2)
})

test('snapshot summary binds both model generations into one stable fingerprint', () => {
  const reports = [
    {
      modelName: 'clip_vit_base_patch32',
      ready: true,
      snapshotFingerprint: 'a'.repeat(64),
    },
    { modelName: 'dinov2_vitb14', ready: true, snapshotFingerprint: 'b'.repeat(64) },
  ]
  const first = summarizeRecallSnapshot(JSON.stringify({ snapshotOnly: true, reports }))
  const second = summarizeRecallSnapshot(
    JSON.stringify({ snapshotOnly: true, reports: [...reports].reverse() }),
  )
  assert.equal(first.ready, true)
  assert.match(first.snapshotFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(second.snapshotFingerprint, first.snapshotFingerprint)
  assert.equal(
    summarizeRecallSnapshot(JSON.stringify({ snapshotOnly: true, reports: reports.slice(0, 1) }))
      .ready,
    false,
  )
})

test('CUDA probe reads real pending decisions instead of treating them as absent', async () => {
  const result = await runCudaProbe()
  assert.equal(result.technicalReady, true)
  assert.equal(result.defaultBundled, false)
  assert.equal(result.approval.length, 4)
  assert.ok(result.approval.every((item) => item.status === 'pending'))
  assert.ok(result.approval.every((item) => item.complete === false && item.reasons.length > 0))
  assert.equal(result.projectApproval.complete, false)
  assert.ok(result.waitingFor.some((item) => item.includes('project license decision')))
  assert.equal(result.postApprovalVerification.status, 'waiting-for-prerequisites')
  assert.equal(result.postApprovalVerification.ran, false)
  assert.equal(result.completionReady, false)
})

test('CUDA probe runs the bounded technical regression only after real approvals pass', async (t) => {
  const calls = []
  const context = approvedCudaContext(t, async (command, args, options) => {
    calls.push({ command, args, options })
    return { exitCode: 0, stdout: 'tests passed', stderr: '' }
  })
  const result = await runCudaProbe(context)
  assert.equal(result.technicalReady, true)
  assert.equal(result.projectApproval.complete, true)
  assert.ok(result.approval.every((item) => item.complete))
  assert.equal(result.postApprovalVerification.status, 'passed')
  assert.equal(result.postApprovalVerification.ran, true)
  assert.equal(result.completionReady, true)
  assert.equal(result.automaticMutation, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, process.execPath)
  assert.equal(calls[0].args[0], '--test')
  assert.deepEqual(
    calls[0].args
      .slice(1)
      .map((filePath) => path.relative(context.projectRoot, filePath).replaceAll('\\', '/')),
    CUDA_POST_APPROVAL_TEST_FILES,
  )
  assert.equal(calls[0].options.timeoutMs, 15 * 60 * 1000)
})

test('CUDA approval cannot complete when the post-approval technical regression fails', async (t) => {
  const result = await runCudaProbe(
    approvedCudaContext(t, async () => ({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'fixture regression',
    })),
  )
  assert.equal(result.technicalReady, true)
  assert.equal(result.postApprovalVerification.status, 'failed')
  assert.equal(result.completionReady, false)
  assert.deepEqual(result.waitingFor, ['post-approval CUDA technical verification must pass'])
})

test('repository dry-run reports unfinished work and probes every unfinished allowlisted task', async (t) => {
  const root = makeRoot(t)
  const statePath = path.join(root, 'state.json')
  const options = parseArgs(['--dry-run'])
  const tasks = parseValueTaskRows(fs.readFileSync(options.planPath, 'utf8'))
  const unfinished = tasks.filter((task) => task.status !== 'verified')
  const allowlisted = unfinished.filter((task) => AUTOMATED_TASK_IDS.has(task.id))
  const report = await runAutomation({
    ...options,
    statePath,
    reportPath: path.join(root, 'report.json'),
  })
  assert.equal(report.counts.remaining, unfinished.length)
  assert.equal(report.counts.probed, allowlisted.length)
  assert.equal(report.safety.deletesUserData, false)
  assert.equal(report.safety.acceptsLicenses, false)
  assert.equal(report.safety.changesTaskStatus, false)
  assert.equal(fs.existsSync(statePath), false)
  assert.deepEqual(
    report.results.map((result) => result.id).sort(),
    allowlisted.map((task) => task.id).sort(),
  )
})
