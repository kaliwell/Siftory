const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  createTimelineLogger,
  parseArgs,
  startBenchmarkChildTracker,
} = require('./image-search-simple-e2e-benchmark.cjs')

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', resolve))
}

test('single-run arguments provide one safe unique nonce and bounded timeline limits', () => {
  const first = parseArgs(['fixture'])
  const second = parseArgs(['fixture'])
  assert.match(first.runNonce, /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/)
  assert.notEqual(first.runNonce, second.runNonce)
  assert.equal(first.dinoFusedShadow, false)

  const supplied = 'round_01_nonce_0123456789'
  const parsed = parseArgs([
    'fixture',
    `--run-nonce=${supplied}`,
    '--timeline-max-bytes=4096',
    '--timeline-max-events=16',
    '--dino-fused-shadow=1',
  ])
  assert.equal(parsed.runNonce, supplied)
  assert.equal(parsed.timelineMaxBytes, 4096)
  assert.equal(parsed.timelineMaxEvents, 16)
  assert.equal(parsed.dinoFusedShadow, true)

  assert.throws(() => parseArgs(['fixture', '--run-nonce=short']), /16-128/)
  assert.throws(
    () => parseArgs(['fixture', `--run-nonce=${supplied}`, `--run-nonce=${supplied}x`]),
    /at most once/,
  )
  assert.throws(() => parseArgs(['fixture', '--timeline-max-bytes=4095']), /between/)
  assert.throws(() => parseArgs(['fixture', '--timeline-max-events=100001']), /between/)
})

test('timeline writes one terminal truncation row and stays within byte and event limits', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-timeline-contract-'))
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  const runNonce = 'timeline_nonce_0123456789'

  const bytePath = path.join(tempRoot, 'bytes.ndjson')
  const byteLogger = createTimelineLogger(
    bytePath,
    { runNonce },
    { maxBytes: 4096, maxEvents: 100 },
  )
  for (let index = 0; index < 100; index += 1) {
    byteLogger.write('progress', { index, payload: 'x'.repeat(900), event: 'spoofed' })
  }
  const byteSnapshot = byteLogger.snapshot()
  const byteRows = fs
    .readFileSync(bytePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
  assert.equal(byteSnapshot.truncated, true)
  assert.equal(byteSnapshot.truncationReason, 'max-bytes')
  assert.equal(byteSnapshot.terminalEventWritten, true)
  assert.ok(fs.statSync(bytePath).size <= 4096)
  assert.ok(byteRows.length <= 100)
  assert.equal(byteRows.at(-1).event, 'timeline-truncated')
  assert.equal(byteRows.at(-1).terminal, true)
  assert.equal(byteRows.filter((row) => row.event === 'timeline-truncated').length, 1)
  const bytesAfterTruncation = fs.statSync(bytePath).size
  byteLogger.write('ignored-after-truncation', { payload: 'y'.repeat(900) })
  assert.equal(fs.statSync(bytePath).size, bytesAfterTruncation)

  const eventPath = path.join(tempRoot, 'events.ndjson')
  const eventLogger = createTimelineLogger(
    eventPath,
    { runNonce },
    { maxBytes: 1024 * 1024, maxEvents: 16 },
  )
  for (let index = 0; index < 100; index += 1) eventLogger.write('progress', { index })
  const eventRows = fs.readFileSync(eventPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
  assert.equal(eventRows.length, 16)
  assert.equal(eventRows.at(-1).event, 'timeline-truncated')
  assert.equal(eventRows.at(-1).reason, 'max-events')
  assert.equal(eventLogger.snapshot().eventsWritten, 16)
})

test('child lifecycle evidence exposes active-at-stop and clears only after process exit', async (t) => {
  const tracker = startBenchmarkChildTracker(childProcess)
  let child
  t.after(async () => {
    tracker.restore()
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill()
      await waitForExit(child)
    }
  })

  child = childProcess.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  const activeEvidence = await tracker.stopEvidence(0)
  assert.equal(activeEvidence.observedChildProcesses, 1)
  assert.equal(activeEvidence.activeAtStop, 1)
  assert.equal(activeEvidence.noResidualAtStop, false)
  assert.equal(activeEvidence.lifecycleAccounted, true)

  child.kill()
  await waitForExit(child)
  const stoppedEvidence = await tracker.stopEvidence(500)
  assert.equal(stoppedEvidence.observedChildProcesses, 1)
  assert.equal(stoppedEvidence.releasedChildProcesses, 1)
  assert.equal(stoppedEvidence.activeAtStop, 0)
  assert.equal(stoppedEvidence.noResidualAtStop, true)
  assert.equal(stoppedEvidence.lifecycleAccounted, true)
})

test('bounded cleanup restores spawn and terminates a residual benchmark child', async (t) => {
  const originalSpawn = childProcess.spawn
  const tracker = startBenchmarkChildTracker(childProcess)
  let child
  t.after(async () => {
    tracker.restore()
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill()
      await waitForExit(child)
    }
  })

  child = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  assert.notEqual(childProcess.spawn, originalSpawn)
  assert.equal((await tracker.stopEvidence(0)).activeAtStop, 1)

  const cleanup = await tracker.cleanup(5_000)
  await waitForExit(child)
  assert.equal(childProcess.spawn, originalSpawn)
  assert.equal(cleanup.spawnRestored, true)
  assert.equal(cleanup.timeoutMs, 5_000)
  assert.equal(cleanup.activeBeforeCleanup, 1)
  assert.equal(cleanup.terminationRequestCount, 1)
  assert.equal(
    cleanup.terminationRequests[0].method,
    process.platform === 'win32' ? 'taskkill-tree' : 'kill',
  )
  assert.equal(cleanup.releasedDuringCleanup, 1)
  assert.equal(cleanup.activeAfterCleanup, 0)
  assert.equal(cleanup.noResidualAfterCleanup, true)
  assert.equal(cleanup.lifecycleAccounted, true)
})

test('Windows child cleanup launches only absolute taskkill with the supplied controlled env', async () => {
  const systemEnvironment = Object.freeze({
    SystemRoot: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATH: 'C:\\Windows\\System32',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
  })
  let worker
  let terminationCalls = 0
  const childProcessFixture = {
    spawn() {
      worker = new EventEmitter()
      worker.pid = 9876
      worker.exitCode = null
      worker.signalCode = null
      return worker
    },
    spawnSync(command, args, options) {
      terminationCalls += 1
      assert.equal(command, 'C:\\Windows\\System32\\taskkill.exe')
      assert.equal(path.win32.isAbsolute(command), true)
      assert.deepEqual(args, ['/pid', '9876', '/T', '/F'])
      assert.equal(options.shell, false)
      assert.equal(options.env, systemEnvironment)
      worker.exitCode = 0
      return { status: 0, signal: null }
    },
  }
  const tracker = startBenchmarkChildTracker(childProcessFixture, {
    platform: 'win32',
    systemTools: {
      systemRoot: 'C:\\Windows',
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
      taskkill: 'C:\\Windows\\System32\\taskkill.exe',
    },
    systemEnvironment,
  })
  childProcessFixture.spawn('C:\\application\\worker.exe', [], {})
  const cleanup = await tracker.cleanup(100)
  assert.equal(terminationCalls, 1)
  assert.equal(cleanup.spawnRestored, true)
  assert.equal(cleanup.noResidualAfterCleanup, true)
  assert.equal(cleanup.lifecycleAccounted, true)
})

test('PowerShell sampler records a computed stop snapshot contract', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'search-library-resource-sampler.ps1'),
    'utf8',
  )
  assert.match(source, /activeAtStop = \$activeAtStop/)
  assert.match(source, /observedChildProcessSamples = \$observedChildProcessSamples/)
  assert.match(source, /stopSnapshotTaken = \$stopSnapshotTaken/)
  assert.match(source, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$NvidiaSmiPath/)
  assert.match(source, /\$startInfo\.FileName = \$NvidiaSmiPath/)
  assert.doesNotMatch(source, /FileName\s*=\s*["']nvidia-smi(?:\.exe)?["']/i)
  const utilities = fs.readFileSync(
    path.join(__dirname, 'search-library-preparation-benchmark-utils.cjs'),
    'utf8',
  )
  assert.match(utilities, /systemTools\.powershell/)
  assert.match(utilities, /systemTools\.nvidiaSmi/)
  assert.match(utilities, /env:\s*systemEnvironment/)
  assert.doesNotMatch(utilities, /spawn\(\s*["']powershell(?:\.exe)?["']/i)
  assert.ok(
    source.indexOf('$activeAtStop = @(') < source.lastIndexOf('Write-ResourceResult $OutputFile'),
  )
})
