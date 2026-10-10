const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  FORMAL_QUIET_WINDOW_MS,
  evaluatePairedPreflightGroup,
  evaluateRuntimeMemoryPreflight,
  irrecoverablePreflightFailures,
  pairedOrderForRound,
  parsePowerSetting,
  resolveCliGpuBaseline,
  resolveAcceptedGpuBaseline,
} = require('../scripts/runtime-memory-preflight.cjs')

function acceptedGpuFixture(t, usedValues = [1036, 1060, 1048]) {
  const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-gpu-baseline-'))
  t.after(() => fs.rmSync(managedRoot, { recursive: true, force: true }))
  const rounds = usedValues.map((usedMiB, index) => {
    const reportFile = `round-${index + 1}.json`
    const bytes = Buffer.from(
      `${JSON.stringify({
        resources: { gpu: { baselineUsedMiB: usedMiB, totalMiB: 4096, deviceCount: 1 } },
      })}\n`,
    )
    fs.writeFileSync(path.join(managedRoot, reportFile), bytes)
    return {
      reportFile,
      reportBytes: bytes.length,
      reportSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    }
  })
  return {
    managedRoot,
    rounds,
    resolveBaseline() {
      return {
        pointer: {
          acceptedAt: '2026-08-26T00:00:00.000Z',
          reportFile: 'accepted/report.json',
        },
        report: { rounds },
        reportSha256: 'a'.repeat(64),
      }
    },
  }
}

function passingSnapshot() {
  return {
    power: { onAc: true, processorMaxAcPercent: 100, processorBoostMode: 2 },
    memory: {
      freePhysicalMemoryBytes: 5 * 1024 ** 3,
      committedBytes: 8 * 1024 ** 3,
      commitLimitBytes: 16 * 1024 ** 3,
    },
    residualProductProcesses: 0,
    gpu: { usedMiB: 500 },
    quietWindow: {
      durationMs: FORMAL_QUIET_WINDOW_MS,
      cpuP95Percent: 8,
      diskP95Percent: 5,
      gpuP95Percent: 2,
    },
  }
}

test('runtime memory preflight fixes the paired order to AB/BA/AB', () => {
  assert.deepEqual([0, 1, 2].map(pairedOrderForRound), [
    ['A', 'B'],
    ['B', 'A'],
    ['A', 'B'],
  ])
  assert.throws(() => pairedOrderForRound(3), /must be 0, 1, or 2/)
})

test('formal CLI preflight binds accepted GPU evidence and rejects arbitrary overrides', () => {
  const accepted = { schema: 'siftory-accepted-gpu-baseline/v1', usedMiB: 1060 }
  const dependencies = {
    projectRoot: process.cwd(),
    resolveAcceptedGpuBaseline: () => accepted,
  }
  assert.equal(
    resolveCliGpuBaseline(
      { durationMs: FORMAL_QUIET_WINDOW_MS, gpuBaselineUsedMiB: null },
      dependencies,
    ),
    accepted,
  )
  assert.throws(
    () =>
      resolveCliGpuBaseline(
        { durationMs: FORMAL_QUIET_WINDOW_MS, gpuBaselineUsedMiB: 700 },
        dependencies,
      ),
    /does not match accepted/,
  )
  assert.deepEqual(
    resolveCliGpuBaseline({ durationMs: 30_000, gpuBaselineUsedMiB: 700 }, dependencies),
    { schema: 'siftory-diagnostic-gpu-baseline/v1', usedMiB: 700 },
  )
})

test('formal GPU preflight derives its limit from three immutable accepted rounds', (t) => {
  const fixture = acceptedGpuFixture(t)
  const result = resolveAcceptedGpuBaseline(fixture)
  assert.deepEqual(result, {
    schema: 'siftory-accepted-gpu-baseline/v1',
    usedMiB: 1060,
    minimumUsedMiB: 1036,
    maximumUsedMiB: 1060,
    totalMiB: 4096,
    deviceCount: 1,
    rounds: 3,
    acceptedAt: '2026-08-26T00:00:00.000Z',
    reportFile: 'accepted/report.json',
    reportSha256: 'a'.repeat(64),
  })
})

test('formal GPU baseline fails closed on changed bytes, unstable spread, or path escape', (t) => {
  const changed = acceptedGpuFixture(t)
  fs.writeFileSync(
    path.join(changed.managedRoot, changed.rounds[1].reportFile),
    `${JSON.stringify({
      resources: { gpu: { baselineUsedMiB: 999, totalMiB: 4096, deviceCount: 1 } },
    })}\n`,
  )
  assert.throws(() => resolveAcceptedGpuBaseline(changed), /identity changed/)

  const spread = acceptedGpuFixture(t, [100, 101, 400])
  assert.throws(() => resolveAcceptedGpuBaseline(spread), /spread exceeds/)

  const escaped = acceptedGpuFixture(t)
  escaped.rounds[0].reportFile = '..\\outside.json'
  assert.throws(() => resolveAcceptedGpuBaseline(escaped), /escaped/)
})

test('runtime memory preflight passes only a complete quiet AC snapshot', () => {
  const result = evaluateRuntimeMemoryPreflight(passingSnapshot(), { gpuBaselineUsedMiB: 400 })
  assert.equal(result.status, 'passed')
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.incomplete, [])
})

test('runtime memory preflight fails pressure and marks missing evidence incomplete', () => {
  const pressured = passingSnapshot()
  pressured.power.onAc = false
  pressured.memory.freePhysicalMemoryBytes = 3 * 1024 ** 3
  pressured.memory.committedBytes = 13 * 1024 ** 3
  pressured.residualProductProcesses = 1
  pressured.gpu.usedMiB = 700
  pressured.quietWindow.cpuP95Percent = 30
  const failed = evaluateRuntimeMemoryPreflight(pressured, { gpuBaselineUsedMiB: 400 })
  assert.equal(failed.status, 'failed')
  assert.ok(failed.failures.length >= 6)

  const missing = passingSnapshot()
  delete missing.gpu
  missing.quietWindow.durationMs = 1_000
  const incomplete = evaluateRuntimeMemoryPreflight(missing, {})
  assert.equal(incomplete.status, 'incomplete')
  assert.ok(incomplete.incomplete.includes('accepted GPU baseline is unavailable'))
  assert.ok(incomplete.incomplete.includes('formal quiet window is shorter than 10 minutes'))
})

test('preflight aborts early only for failures that cannot recover within the same window', () => {
  const sample = {
    onAc: true,
    freePhysicalMemoryBytes: 8 * 1024 ** 3,
    committedBytes: 8 * 1024 ** 3,
    commitLimitBytes: 32 * 1024 ** 3,
    residualProductProcesses: 0,
  }
  assert.deepEqual(irrecoverablePreflightFailures(sample), [])
  assert.deepEqual(
    irrecoverablePreflightFailures({
      ...sample,
      onAc: false,
      freePhysicalMemoryBytes: 3 * 1024 ** 3,
      committedBytes: 25 * 1024 ** 3,
      residualProductProcesses: 1,
    }),
    [
      'AC power is unavailable',
      'free physical memory is below 4 GiB',
      'commit ratio exceeded 75%',
      'residual product processes were detected',
    ],
  )
})

test('one polluted paired round invalidates and reruns the whole three-round group', () => {
  const rounds = [0, 1, 2].map((index) => ({
    order: pairedOrderForRound(index),
    preflight: { status: index === 1 ? 'failed' : 'passed' },
  }))
  assert.deepEqual(evaluatePairedPreflightGroup(rounds), {
    status: 'invalid',
    rerunWholeGroup: true,
    failures: ['round 2 preflight is failed'],
  })
})

test('localized powercfg parsing uses the final AC setting value', () => {
  const output = `\nGUID: abc\nPossible: 0x00000000\nPossible: 0x00000064\nCurrent AC: 0x00000064\nCurrent DC: 0x00000032\n`
  assert.equal(parsePowerSetting(output), 100)
  assert.equal(parsePowerSetting('missing'), null)
})
