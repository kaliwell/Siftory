const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const {
  createFixedWindowsSystemEnvironment,
  resolveFixedHardwareSystemTools,
} = require('../scripts/fixed-hardware-system-tools.cjs')

const { loadTsModule } = require('./guard-utils.cjs')
const {
  assertFileSnapshotUnchanged,
  redactPaths,
  safeRemoveTempRoot,
  snapshotFiles,
  startResourceMonitor,
  writeJson,
} = require('./search-library-preparation-benchmark-utils.cjs')

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'])
const projectRoot = path.resolve(__dirname, '..')
const RUN_NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/
const DEFAULT_TIMELINE_MAX_BYTES = 8 * 1024 * 1024
const MIN_TIMELINE_MAX_BYTES = 4 * 1024
const MAX_TIMELINE_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMELINE_MAX_EVENTS = 20_000
const MIN_TIMELINE_MAX_EVENTS = 16
const MAX_TIMELINE_MAX_EVENTS = 100_000
const LIFECYCLE_BARRIER_MAX_BYTES = 4 * 1024
const DEFAULT_LIFECYCLE_BARRIER_TIMEOUT_MS = 30_000

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function singleOption(argv, name) {
  const prefix = `--${name}=`
  const values = argv
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length))
  if (values.length > 1) throw new Error(`Use --${name} at most once`)
  return values[0]
}

function boundedIntegerOption(argv, name, fallback, minimum, maximum) {
  const raw = singleOption(argv, name)
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be an integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function runNonceOption(argv) {
  const supplied = singleOption(argv, 'run-nonce')
  const nonce = supplied === undefined ? crypto.randomUUID() : supplied
  if (!RUN_NONCE_PATTERN.test(nonce)) {
    throw new Error('--run-nonce must be 16-128 URL-safe ASCII characters')
  }
  return nonce
}

function parseArgs(argv) {
  const positional = argv.filter((value) => !value.startsWith('--'))
  const sample = Number(option(argv, 'sample', '0')) || 0
  const requestedBatchSize = Number(option(argv, 'batch-size', '4'))
  const requestedScanWorkers = option(argv, 'scan-workers', '')
  return {
    dataset: positional[0] ? path.resolve(positional[0]) : '',
    addonPath: path.resolve(
      option(
        argv,
        'addon',
        path.join(projectRoot, 'native', 'build-node', 'Release', 'fast_scanner.node'),
      ),
    ),
    childrenDir: path.resolve(
      option(argv, 'children-dir', path.join(projectRoot, 'dist-electron')),
    ),
    appRoot: path.resolve(option(argv, 'app-root', projectRoot)),
    sample: Math.max(0, Math.min(1000, sample)),
    jobs: Math.max(1, Math.min(2, Number(option(argv, 'jobs', '2')) || 2)),
    batchSize:
      requestedBatchSize === 0
        ? 0
        : Math.max(1, Math.min(16, Number.isFinite(requestedBatchSize) ? requestedBatchSize : 4)),
    backend: option(argv, 'backend', 'gpu'),
    pipeline: option(argv, 'pipeline', 'serial'),
    scanWorkers: requestedScanWorkers === '' ? null : Number(requestedScanWorkers),
    timeoutMs: Math.max(60_000, Number(option(argv, 'timeout-ms', '1800000')) || 1_800_000),
    keepTemp: argv.includes('--keep-temp'),
    deferThumbnails: argv.includes('--defer-thumbnails'),
    verifyWarm: argv.includes('--verify-warm'),
    compact: argv.includes('--compact'),
    stageMetrics: argv.includes('--stage-metrics'),
    tensorPrefetch: option(argv, 'tensor-prefetch', '0') === '1',
    dinoFusedShadow: option(argv, 'dino-fused-shadow', '0') === '1',
    runNonce: runNonceOption(argv),
    jsonOut: option(argv, 'json-out', ''),
    timelineOut: option(argv, 'timeline-out', ''),
    lifecycleReady: singleOption(argv, 'lifecycle-ready') || '',
    lifecycleRelease: singleOption(argv, 'lifecycle-release') || '',
    lifecycleParentPid: boundedIntegerOption(argv, 'lifecycle-parent-pid', 0, 0, 2 ** 31 - 1),
    lifecycleTimeoutMs: boundedIntegerOption(
      argv,
      'lifecycle-timeout-ms',
      DEFAULT_LIFECYCLE_BARRIER_TIMEOUT_MS,
      1_000,
      120_000,
    ),
    timelineMaxBytes: boundedIntegerOption(
      argv,
      'timeline-max-bytes',
      DEFAULT_TIMELINE_MAX_BYTES,
      MIN_TIMELINE_MAX_BYTES,
      MAX_TIMELINE_MAX_BYTES,
    ),
    timelineMaxEvents: boundedIntegerOption(
      argv,
      'timeline-max-events',
      DEFAULT_TIMELINE_MAX_EVENTS,
      MIN_TIMELINE_MAX_EVENTS,
      MAX_TIMELINE_MAX_EVENTS,
    ),
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

function sameStableLifecycleFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function readStableLifecycleBarrier(filePath) {
  const pathEntryBefore = fs.lstatSync(filePath)
  if (pathEntryBefore.isSymbolicLink() || !pathEntryBefore.isFile()) {
    throw new Error('Lifecycle barrier must be a regular non-link file')
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY)
  try {
    const descriptorBefore = fs.fstatSync(descriptor)
    if (!descriptorBefore.isFile() || !sameStableLifecycleFile(pathEntryBefore, descriptorBefore)) {
      throw new Error('Lifecycle barrier changed while it was opened')
    }
    if (descriptorBefore.size <= 0) throw new Error('Lifecycle barrier is empty')
    if (descriptorBefore.size > LIFECYCLE_BARRIER_MAX_BYTES) {
      throw new Error('Lifecycle barrier exceeded its bounded size')
    }
    const buffer = Buffer.allocUnsafe(descriptorBefore.size)
    let offset = 0
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (bytesRead <= 0) throw new Error('Lifecycle barrier ended before its declared size')
      offset += bytesRead
    }
    const trailing = Buffer.allocUnsafe(1)
    if (fs.readSync(descriptor, trailing, 0, 1, offset) !== 0) {
      throw new Error('Lifecycle barrier grew beyond its declared size')
    }
    const descriptorAfter = fs.fstatSync(descriptor)
    const pathEntryAfter = fs.lstatSync(filePath)
    if (
      pathEntryAfter.isSymbolicLink() ||
      !pathEntryAfter.isFile() ||
      !sameStableLifecycleFile(descriptorBefore, descriptorAfter) ||
      !sameStableLifecycleFile(descriptorAfter, pathEntryAfter)
    ) {
      throw new Error('Lifecycle barrier changed during its bounded read')
    }
    return buffer
  } finally {
    fs.closeSync(descriptor)
  }
}

function publishLifecycleBarrierFile(filePath, value) {
  const serialized = JSON.stringify(value) + '\n'
  const byteLength = Buffer.byteLength(serialized, 'utf8')
  if (byteLength <= 0 || byteLength > LIFECYCLE_BARRIER_MAX_BYTES) {
    throw new Error('Lifecycle barrier payload exceeded its bounded size')
  }
  if (fs.existsSync(filePath)) {
    throw new Error('Lifecycle barrier publication target must be new')
  }
  const stagingPath = filePath + '.staged-' + process.pid
  const descriptor = fs.openSync(stagingPath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, serialized, { encoding: 'utf8' })
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  const stagingEntry = fs.lstatSync(stagingPath)
  if (stagingEntry.isSymbolicLink() || !stagingEntry.isFile() || stagingEntry.size !== byteLength) {
    throw new Error('Lifecycle barrier staging file is invalid')
  }
  fs.linkSync(stagingPath, filePath)
  const linkedStagingEntry = fs.lstatSync(stagingPath)
  const publishedEntry = fs.lstatSync(filePath)
  if (
    publishedEntry.isSymbolicLink() ||
    !publishedEntry.isFile() ||
    !sameStableLifecycleFile(linkedStagingEntry, publishedEntry)
  ) {
    throw new Error('Lifecycle barrier publication is not bound to its staged file')
  }
  return { stagingPath, byteLength }
}

function readLifecycleBarrierFile(filePath, expected) {
  const value = JSON.parse(readStableLifecycleBarrier(filePath).toString('utf8'))
  if (
    value?.schemaVersion !== 1 ||
    value?.runNonce !== expected.runNonce ||
    value?.benchmarkPid !== expected.benchmarkPid ||
    value?.orchestratorPid !== expected.orchestratorPid
  ) {
    throw new Error('Lifecycle barrier provenance does not match this execution')
  }
  return value
}

function validateLifecycleBarrierOptions(options) {
  const enabled = Boolean(options.lifecycleReady || options.lifecycleRelease)
  if (!enabled) return null
  if (!options.lifecycleReady || !options.lifecycleRelease) {
    throw new Error('Lifecycle ready and release paths must be provided together')
  }
  if (!Number.isInteger(options.lifecycleParentPid) || options.lifecycleParentPid <= 0) {
    throw new Error('Lifecycle parent PID is required')
  }
  if (options.lifecycleParentPid !== process.ppid) {
    throw new Error('Lifecycle parent PID does not match the benchmark parent')
  }
  const tempRoot = fs.realpathSync(process.env.TEMP || os.tmpdir())
  const readyParent = fs.realpathSync(path.dirname(options.lifecycleReady))
  const releaseParent = fs.realpathSync(path.dirname(options.lifecycleRelease))
  if (
    !path.isAbsolute(options.lifecycleReady) ||
    !path.isAbsolute(options.lifecycleRelease) ||
    readyParent !== tempRoot ||
    releaseParent !== tempRoot ||
    path.basename(options.lifecycleReady) !== 'lifecycle-ready.json' ||
    path.basename(options.lifecycleRelease) !== 'lifecycle-release.json'
  ) {
    throw new Error('Lifecycle barrier paths must use the managed round TEMP directory')
  }
  for (const filePath of [options.lifecycleReady, options.lifecycleRelease]) {
    if (fs.existsSync(filePath)) throw new Error('Lifecycle barrier path must be new')
  }
  return {
    readyPath: options.lifecycleReady,
    releasePath: options.lifecycleRelease,
    runNonce: options.runNonce,
    benchmarkPid: process.pid,
    orchestratorPid: options.lifecycleParentPid,
    timeoutMs: options.lifecycleTimeoutMs,
  }
}

function waitForLifecycleRelease(barrier) {
  if (!barrier) return Promise.resolve(null)
  publishLifecycleBarrierFile(barrier.readyPath, {
    schemaVersion: 1,
    phase: 'ready-for-parent-tree-capture',
    runNonce: barrier.runNonce,
    benchmarkPid: barrier.benchmarkPid,
    orchestratorPid: barrier.orchestratorPid,
  })
  return new Promise((resolve, reject) => {
    let settled = false
    let watcher
    let timer
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      callback()
    }
    const inspect = () => {
      if (!fs.existsSync(barrier.releasePath)) return
      try {
        const release = readLifecycleBarrierFile(barrier.releasePath, barrier)
        if (release.phase !== 'release-after-parent-tree-capture') {
          throw new Error('Lifecycle release phase is invalid')
        }
        finish(() => resolve(release))
      } catch (error) {
        finish(() => reject(error))
      }
    }
    watcher = fs.watch(path.dirname(barrier.releasePath), (event, name) => {
      if (!name || String(name) === path.basename(barrier.releasePath)) inspect()
    })
    watcher.on('error', (error) => finish(() => reject(error)))
    timer = setTimeout(
      () => finish(() => reject(new Error('Lifecycle release barrier timed out'))),
      barrier.timeoutMs,
    )
    inspect()
  })
}

function printHelp() {
  process.stdout.write(`Usage:
  node tests/image-search-simple-e2e-benchmark.cjs <image-directory> [options]

Options:
  --sample=<count>       Copy a deterministic subset into the isolated temp root
  --backend=cpu|gpu      Embedding backend (default: gpu)
  --pipeline=serial|overlap  Preparation path to measure (default: serial)
  --jobs=1|2             Maximum embedding workers (default: 2)
  --batch-size=0..16     0 selects the adaptive batch policy (default: 4)
  --scan-workers=0|2..8  Native scan workers; 0 selects production auto policy
  --defer-thumbnails     Build Native thumbnails after the searchable milestone
  --verify-warm          Run a second unchanged overlap pass and require zero inference
  --run-nonce=<token>    Optional 16-128 character unique execution token (generated if omitted)
  --json-out=<file>      Write the full de-identified report to this file
  --timeline-out=<file>  Append de-identified stage/progress events as NDJSON
  --timeline-max-bytes=<count>   Timeline limit: 4096..67108864 (default: 8388608)
  --timeline-max-events=<count>  Timeline limit: 16..100000 (default: 20000)
  --stage-metrics        Collect aggregate Native/DINO/CLIP/persistence stage timings
  --tensor-prefetch=0|1  Enable the bounded CLIP next-tensor candidate (default: 0)
  --dino-fused-shadow=0|1  Enable the diagnostic-only fused DINO resize (default: 0)
  --compact              Print only the compact summary
  --keep-temp            Keep this run's validated temp root for debugging
`)
}

function createTimelineLogger(filePath, context, limits = {}) {
  const maxBytes =
    limits.maxBytes === undefined ? DEFAULT_TIMELINE_MAX_BYTES : Number(limits.maxBytes)
  const maxEvents =
    limits.maxEvents === undefined ? DEFAULT_TIMELINE_MAX_EVENTS : Number(limits.maxEvents)
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < MIN_TIMELINE_MAX_BYTES ||
    maxBytes > MAX_TIMELINE_MAX_BYTES
  ) {
    throw new Error(
      `Timeline maxBytes must be between ${MIN_TIMELINE_MAX_BYTES} and ${MAX_TIMELINE_MAX_BYTES}`,
    )
  }
  if (
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < MIN_TIMELINE_MAX_EVENTS ||
    maxEvents > MAX_TIMELINE_MAX_EVENTS
  ) {
    throw new Error(
      `Timeline maxEvents must be between ${MIN_TIMELINE_MAX_EVENTS} and ${MAX_TIMELINE_MAX_EVENTS}`,
    )
  }
  let bytesWritten = 0
  let eventsWritten = 0
  let truncated = false
  let truncationReason = null
  let terminalEventWritten = false
  const snapshot = () => ({
    enabled: Boolean(filePath),
    maxBytes,
    maxEvents,
    bytesWritten,
    eventsWritten,
    truncated,
    truncationReason,
    terminalEventWritten,
  })
  if (!filePath) return { enabled: false, write: () => false, snapshot }
  const resolved = path.resolve(filePath)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, '', 'utf8')
  const startedAt = performance.now()
  const terminalReserveBytes = Math.min(1_024, Math.floor(maxBytes / 4))

  const append = (line) => {
    fs.appendFileSync(resolved, line, 'utf8')
    bytesWritten += Buffer.byteLength(line)
    eventsWritten += 1
  }

  const writeTruncation = (reason, attemptedEvent, attemptedBytes) => {
    if (truncated) return false
    truncated = true
    truncationReason = reason
    const row = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      atMs: Number((performance.now() - startedAt).toFixed(2)),
      event: 'timeline-truncated',
      terminal: true,
      reason,
      attemptedEvent: String(attemptedEvent || 'unknown').slice(0, 80),
      attemptedBytes,
      maxBytes,
      maxEvents,
      eventsBeforeTruncation: eventsWritten,
      bytesBeforeTruncation: bytesWritten,
      runNonce: context.runNonce,
    }
    const line = `${JSON.stringify(row)}\n`
    if (eventsWritten < maxEvents && bytesWritten + Buffer.byteLength(line) <= maxBytes) {
      append(line)
      terminalEventWritten = true
    }
    return false
  }

  return {
    enabled: true,
    write(event, details = {}) {
      if (truncated) return false
      const memory = process.memoryUsage()
      const line = `${JSON.stringify({
        ...context,
        ...details,
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        atMs: Number((performance.now() - startedAt).toFixed(2)),
        event,
        mainRssMiB: Number((memory.rss / 1024 / 1024).toFixed(2)),
        systemFreeMiB: Number((os.freemem() / 1024 / 1024).toFixed(2)),
      })}\n`
      const lineBytes = Buffer.byteLength(line)
      if (eventsWritten >= maxEvents - 1) {
        return writeTruncation('max-events', event, lineBytes)
      }
      if (bytesWritten + lineBytes > maxBytes - terminalReserveBytes) {
        return writeTruncation('max-bytes', event, lineBytes)
      }
      append(line)
      return true
    },
    snapshot,
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function startBenchmarkChildTracker(childProcessModule = childProcess, options = {}) {
  const delegatedSpawn = childProcessModule.spawn
  const active = new Map()
  const released = new Set()
  const observedByCommand = new Map()
  let observedChildProcesses = 0
  let exitEvents = 0
  let errorEvents = 0
  let installed = true

  const trackedSpawn = function trackedBenchmarkSpawn(command, args, spawnOptions) {
    const child = delegatedSpawn.call(childProcessModule, command, args, spawnOptions)
    const label = path.basename(String(command || '').trim()) || 'unknown'
    if (Number.isInteger(child.pid)) {
      const childId = observedChildProcesses
      observedChildProcesses += 1
      observedByCommand.set(label, (observedByCommand.get(label) || 0) + 1)
      active.set(childId, { child, label })
      child.once('exit', () => {
        exitEvents += 1
        if (active.delete(childId)) released.add(childId)
      })
      child.once('error', () => {
        errorEvents += 1
      })
    }
    return child
  }
  childProcessModule.spawn = trackedSpawn

  const liveRows = () => {
    for (const [childId, row] of active) {
      if (row.child.exitCode !== null || row.child.signalCode !== null) {
        active.delete(childId)
        released.add(childId)
      }
    }
    return [...active.values()]
  }

  const boundedTimeout = (value, fallback) => {
    const numeric = Number(value)
    return Math.max(0, Math.min(10_000, Number.isFinite(numeric) ? numeric : fallback))
  }

  const restore = () => {
    if (!installed) return
    installed = false
    if (childProcessModule.spawn === trackedSpawn) childProcessModule.spawn = delegatedSpawn
  }

  const stopEvidence = async (settleTimeoutMs = 2_000) => {
    const boundedSettleTimeoutMs = boundedTimeout(settleTimeoutMs, 2_000)
    const startedAt = performance.now()
    while (liveRows().length > 0 && performance.now() - startedAt < boundedSettleTimeoutMs) {
      await delay(25)
    }
    const remaining = liveRows()
    const activeByCommand = {}
    for (const { label } of remaining) activeByCommand[label] = (activeByCommand[label] || 0) + 1
    const activeAtStop = remaining.length
    const releasedChildProcesses = released.size
    return {
      observedChildProcesses,
      releasedChildProcesses,
      activeAtStop,
      noResidualAtStop: activeAtStop === 0,
      lifecycleAccounted: observedChildProcesses === releasedChildProcesses + activeAtStop,
      exitEvents,
      errorEvents,
      settleTimeoutMs: boundedSettleTimeoutMs,
      settleWaitMs: Number((performance.now() - startedAt).toFixed(2)),
      observedByCommand: Object.fromEntries(
        [...observedByCommand.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      activeByCommand: Object.fromEntries(
        Object.entries(activeByCommand).sort(([left], [right]) => left.localeCompare(right)),
      ),
    }
  }

  const terminateAll = async (cleanupTimeoutMs = 10_000) => {
    const timeoutMs = boundedTimeout(cleanupTimeoutMs, 10_000)
    const startedAt = performance.now()
    const deadline = startedAt + timeoutMs
    const activeBeforeCleanup = liveRows().length
    const releasedBeforeCleanup = released.size
    const terminationRequests = []
    for (const row of liveRows()) {
      if (row.child.exitCode !== null || row.child.signalCode !== null) continue
      if ((options.platform || process.platform) === 'win32') {
        const systemTools = options.systemTools || resolveFixedHardwareSystemTools()
        const systemEnvironment =
          options.systemEnvironment ||
          createFixedWindowsSystemEnvironment({
            systemRoot: systemTools.systemRoot,
            comSpec: systemTools.comSpec,
          })
        const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()))
        const result = childProcessModule.spawnSync(
          systemTools.taskkill,
          ['/pid', String(row.child.pid), '/T', '/F'],
          {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
            timeout: remainingMs,
            env: systemEnvironment,
          },
        )
        terminationRequests.push({
          command: row.label,
          method: 'taskkill-tree',
          accepted: result.status === 0,
          status: Number.isInteger(result.status) ? result.status : null,
          signal: result.signal || null,
          errorCode: result.error?.code || null,
        })
      } else {
        let accepted = false
        let errorCode = null
        try {
          accepted = row.child.kill('SIGKILL')
        } catch (error) {
          errorCode = error?.code || 'kill-error'
        }
        terminationRequests.push({
          command: row.label,
          method: 'kill',
          accepted,
          status: null,
          signal: 'SIGKILL',
          errorCode,
        })
      }
      if (performance.now() >= deadline) break
    }
    while (liveRows().length > 0 && performance.now() < deadline) await delay(25)
    const remaining = liveRows()
    const activeByCommand = {}
    for (const { label } of remaining) activeByCommand[label] = (activeByCommand[label] || 0) + 1
    return {
      timeoutMs,
      cleanupWaitMs: Number((performance.now() - startedAt).toFixed(2)),
      activeBeforeCleanup,
      terminationRequestCount: terminationRequests.length,
      terminationRequests,
      releasedDuringCleanup: released.size - releasedBeforeCleanup,
      activeAfterCleanup: remaining.length,
      noResidualAfterCleanup: remaining.length === 0,
      lifecycleAccounted: observedChildProcesses === released.size + remaining.length,
      activeByCommand: Object.fromEntries(
        Object.entries(activeByCommand).sort(([left], [right]) => left.localeCompare(right)),
      ),
    }
  }

  const cleanup = async (cleanupTimeoutMs = 10_000) => {
    restore()
    return {
      spawnRestored: childProcessModule.spawn !== trackedSpawn,
      ...(await terminateAll(cleanupTimeoutMs)),
    }
  }

  return { cleanup, restore, stopEvidence, terminateAll }
}

function embeddingTerminalWork(progress) {
  return Math.max(
    Number(progress?.stageMetrics?.items) || 0,
    (Number(progress?.completed) || 0) + (Number(progress?.failed) || 0),
  )
}

function representativeEmbeddingTerminal(previous, current) {
  if (!previous || embeddingTerminalWork(current) > embeddingTerminalWork(previous)) {
    return {
      ...current,
      ...(current.stageMetrics ? { stageMetrics: { ...current.stageMetrics } } : {}),
    }
  }
  return previous
}

function collectImages(root) {
  const images = []
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift()
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(target)
      else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        images.push(target)
      }
    }
  }
  return images
}

function createSampleDataset(sourceRoot, images, sample, tempRoot) {
  if (sample <= 0 || sample >= images.length) return { root: sourceRoot, count: images.length }
  const root = path.join(tempRoot, 'sample-images')
  fs.mkdirSync(root)
  for (const [index, source] of images.slice(0, sample).entries()) {
    const destination = path.join(
      root,
      `${String(index).padStart(4, '0')}-${path.basename(source)}`,
    )
    fs.copyFileSync(source, destination)
  }
  return { root, count: sample }
}

function waitForNativeScan(addon, timeoutMs, samples = [], onSample = () => undefined) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let lastRecordedAt = 0
    const record = (progress, now, force = false) => {
      if (!force && now - lastRecordedAt < 1_000) return
      lastRecordedAt = now
      const sample = {
        atMs: now - startedAt,
        state: String(progress.state || 'unknown'),
        indexedCount: Number(progress.indexedCount) || 0,
        pendingCount: Number(progress.scanQueuePending) || 0,
        activeWorkers: Number(progress.scanActiveWorkers) || 0,
        failedCount: Number(progress.failedCount) || 0,
        skippedCount: Number(progress.skippedCount) || 0,
        totalBytes: Number(progress.totalBytes) || 0,
      }
      const previous = samples.at(-1)
      if (
        force &&
        previous?.state === sample.state &&
        previous.indexedCount === sample.indexedCount &&
        previous.pendingCount === sample.pendingCount &&
        previous.activeWorkers === sample.activeWorkers &&
        previous.failedCount === sample.failedCount &&
        previous.skippedCount === sample.skippedCount &&
        previous.totalBytes === sample.totalBytes
      ) {
        return
      }
      samples.push(sample)
      onSample(sample)
    }
    const timer = setInterval(() => {
      const progress = addon.getScanProgress()
      const now = Date.now()
      record(progress, now)
      if (progress.state === 'error') {
        record(progress, now, true)
        clearInterval(timer)
        reject(new Error(progress.lastError || progress.error || 'Native scan failed'))
      } else if (progress.state === 'idle') {
        record(progress, now, true)
        clearInterval(timer)
        resolve(progress)
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Native scan timed out after ${timeoutMs}ms`))
      }
    }, 20)
  })
}

function waitForNativeThumbnailRebuild(addon, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const progress = addon.getNativeThumbnailRebuildProgress()
      if (progress.state === 'done') {
        clearInterval(timer)
        resolve(progress)
      } else if (progress.state === 'error') {
        clearInterval(timer)
        reject(new Error(progress.error || 'Native thumbnail rebuild failed'))
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Native thumbnail rebuild timed out after ${timeoutMs}ms`))
      }
    }, 50)
  })
}

function normalizedRelativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function nativeDigest(addon, datasetRoot) {
  const snapshot = addon.snapshotIndexRecords()
  assert.equal(snapshot.ok, true)
  const rows = snapshot.records
    .map(
      (record) =>
        `${normalizedRelativePath(datasetRoot, record.path)}\u001f${record.diffHash64}\u001f${record.dctHash64}`,
    )
    .sort()
    .join('\n')
  return {
    count: snapshot.recordCount,
    sha256: crypto.createHash('sha256').update(rows).digest('hex'),
  }
}

function createElectronMock(userDataPath, appRoot) {
  return {
    app: {
      isPackaged: false,
      getPath: (name) => (name === 'userData' ? userDataPath : userDataPath),
      getAppPath: () => appRoot,
    },
  }
}

function waitForEmbedding(embeddingService, timeoutMs, samples, onSample = () => undefined) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let lastRecordedAt = 0
    const record = (progress, now, force = false) => {
      if (!force && now - lastRecordedAt < 1_000) return
      lastRecordedAt = now
      const sample = {
        atMs: now - startedAt,
        state: String(progress.state || 'unknown'),
        total: Number(progress.total) || 0,
        completed: Number(progress.completed) || 0,
        failed: Number(progress.failed) || 0,
        skipped: Number(progress.skipped) || 0,
        pending: Number(progress.pending) || 0,
        running: Number(progress.running) || 0,
        itemsPerSecond: Number(progress.itemsPerSecond) || 0,
        message:
          typeof progress.currentPath === 'string' && path.isAbsolute(progress.currentPath)
            ? path.basename(progress.currentPath)
            : progress.currentPath,
      }
      const previous = samples.at(-1)
      if (
        force &&
        previous?.state === sample.state &&
        previous.total === sample.total &&
        previous.completed === sample.completed &&
        previous.failed === sample.failed &&
        previous.skipped === sample.skipped &&
        previous.pending === sample.pending &&
        previous.running === sample.running
      ) {
        return
      }
      samples.push(sample)
      onSample(sample)
    }
    const timer = setInterval(() => {
      const progress = embeddingService.getEmbeddingProgress()
      const now = Date.now()
      record(progress, now)
      if (progress.state === 'done') {
        record(progress, now, true)
        clearInterval(timer)
        resolve(progress)
      } else if (progress.state === 'error') {
        record(progress, now, true)
        clearInterval(timer)
        reject(new Error(progress.error || 'Embedding build failed'))
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Embedding build timed out after ${timeoutMs}ms`))
      }
    }, 100)
  })
}

async function runEmbeddingPhase(embeddingService, request, timeoutMs, onSample = () => undefined) {
  const samples = []
  const phaseStartedAt = performance.now()
  const started = await embeddingService.startEmbeddingBuild(request)
  const preparationMs = performance.now() - phaseStartedAt
  assert.equal(started.ok, true, JSON.stringify(started))
  const inferenceStartedAt = performance.now()
  const progress = await waitForEmbedding(embeddingService, timeoutMs, samples, onSample)
  const inferencePersistenceMs = performance.now() - inferenceStartedAt
  assert.equal(progress.failed, 0)
  assert.equal(progress.completed + progress.skipped, progress.total)
  return {
    totalMs: Number((performance.now() - phaseStartedAt).toFixed(2)),
    preparationMs: Number(preparationMs.toFixed(2)),
    inferencePersistenceMs: Number(inferencePersistenceMs.toFixed(2)),
    progress,
    progressSamples: samples,
  }
}

function embeddingDigest(entries, datasetRoot) {
  const exactRows = []
  const stableRows = []
  for (const entry of entries) {
    const key = normalizedRelativePath(datasetRoot, entry.imageId)
    exactRows.push(`${key}\u001f${entry.vector.join(',')}`)
    stableRows.push(`${key}\u001f${entry.vector.map((value) => value.toFixed(4)).join(',')}`)
  }
  return {
    count: entries.length,
    sha256: crypto.createHash('sha256').update(exactRows.sort().join('\n')).digest('hex'),
    stableSha256: crypto.createHash('sha256').update(stableRows.sort().join('\n')).digest('hex'),
    stableDecimalPlaces: 4,
  }
}

function directoryBytes(root) {
  let bytes = 0
  let files = 0
  const queue = fs.existsSync(root) ? [root] : []
  while (queue.length > 0) {
    const directory = queue.shift()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(target)
      else if (entry.isFile()) {
        files++
        bytes += fs.statSync(target).size
      }
    }
  }
  return { files, bytes }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return null
  }
  const lifecycleBarrier = validateLifecycleBarrierOptions(options)
  const executionStartedAt = new Date()
  const executionStartedMonotonic = performance.now()
  if (
    !options.dataset ||
    !fs.existsSync(options.dataset) ||
    !fs.statSync(options.dataset).isDirectory()
  ) {
    throw new Error('Pass an existing image dataset directory')
  }
  if (!['cpu', 'gpu'].includes(options.backend)) throw new Error('Use --backend=cpu or gpu')
  if (!['serial', 'overlap'].includes(options.pipeline)) {
    throw new Error('Use --pipeline=serial or overlap')
  }
  if (
    options.scanWorkers !== null &&
    options.scanWorkers !== 0 &&
    (!Number.isInteger(options.scanWorkers) || options.scanWorkers < 2 || options.scanWorkers > 8)
  ) {
    throw new Error('Use --scan-workers=0 or an integer from 2 to 8')
  }
  if (!fs.existsSync(options.addonPath))
    throw new Error(`Native addon missing: ${options.addonPath}`)
  for (const child of [
    'embeddingPreparationChild.js',
    'dinoEmbeddingChild.js',
    'clipEmbeddingChild.js',
  ]) {
    if (!fs.existsSync(path.join(options.childrenDir, child))) {
      throw new Error(`Compiled child missing: ${path.join(options.childrenDir, child)}`)
    }
  }
  const timeline = createTimelineLogger(
    options.timelineOut,
    {
      runNonce: options.runNonce,
      pipeline: options.pipeline,
      backend: options.backend,
      tensorPrefetch: options.tensorPrefetch,
      dinoFusedShadow: options.dinoFusedShadow,
    },
    {
      maxBytes: options.timelineMaxBytes,
      maxEvents: options.timelineMaxEvents,
    },
  )
  const harness = {}
  timeline.write('benchmark-start', {
    stage: 'harness',
    sampleRequested: options.sample,
    jobs: options.jobs,
    batchSize: options.batchSize,
    requestedScanWorkers: options.scanWorkers,
    tensorPrefetch: options.tensorPrefetch,
    dinoFusedShadow: options.dinoFusedShadow,
  })
  let harnessStartedAt = performance.now()
  const allImages = collectImages(options.dataset)
  harness.corpusDiscoveryMs = Number((performance.now() - harnessStartedAt).toFixed(2))
  timeline.write('stage-end', {
    stage: 'corpus-discovery',
    durationMs: harness.corpusDiscoveryMs,
    supportedImages: allImages.length,
  })
  if (allImages.length === 0) throw new Error('Dataset contains no supported images')
  const sourceImages =
    options.sample > 0 && options.sample < allImages.length
      ? allImages.slice(0, options.sample)
      : allImages
  harnessStartedAt = performance.now()
  const sourceSnapshotBefore = snapshotFiles(sourceImages)
  harness.sourceSnapshotMs = Number((performance.now() - harnessStartedAt).toFixed(2))
  timeline.write('stage-end', {
    stage: 'source-snapshot',
    durationMs: harness.sourceSnapshotMs,
    files: sourceSnapshotBefore.count,
    bytes: sourceSnapshotBefore.totalBytes,
  })
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-simple-e2e-'))
  const tempDirectoryId = path.basename(tempRoot)
  harnessStartedAt = performance.now()
  const sampleDataset = createSampleDataset(options.dataset, allImages, options.sample, tempRoot)
  harness.isolatedCorpusCopyMs = Number((performance.now() - harnessStartedAt).toFixed(2))
  timeline.write('stage-end', {
    stage: 'isolated-corpus-copy',
    durationMs: harness.isolatedCorpusCopyMs,
    copied: sampleDataset.root !== options.dataset,
    images: sampleDataset.count,
  })
  const imageCount = sampleDataset.count
  const appDataRoot = path.join(tempRoot, 'appdata')
  const userDataPath = path.join(appDataRoot, 'floating-clock-electron')
  const thumbnailDir = path.join(userDataPath, 'thumbcache')
  const hashIndexDir = path.join(userDataPath, 'image-search-index')
  fs.mkdirSync(thumbnailDir, { recursive: true })
  fs.mkdirSync(hashIndexDir, { recursive: true })

  const originalAppData = process.env.APPDATA
  const originalEmbeddingStageMetrics = process.env.REASONIX_EMBEDDING_STAGE_METRICS
  const originalEmbeddingTensorPrefetch = process.env.REASONIX_EMBEDDING_TENSOR_PREFETCH
  const originalDinoFusedShadow = process.env.REASONIX_DINO_FUSED_SHADOW
  const originalNativeStageMetrics = process.env.REASONIX_NATIVE_STAGE_METRICS
  const originalNativeScanWorkers = process.env.REASONIX_NATIVE_SCAN_WORKERS
  const originalNativeParityFields = process.env.REASONIX_NATIVE_PARITY_FIELDS
  const originalResourcesPath = process.resourcesPath
  const originalLoad = Module._load
  process.env.APPDATA = appDataRoot
  process.env.REASONIX_EMBEDDING_TENSOR_PREFETCH = options.tensorPrefetch ? '1' : '0'
  process.env.REASONIX_DINO_FUSED_SHADOW = options.dinoFusedShadow ? '1' : '0'
  if (options.stageMetrics) {
    process.env.REASONIX_EMBEDDING_STAGE_METRICS = '1'
    process.env.REASONIX_NATIVE_STAGE_METRICS = '1'
    process.env.REASONIX_NATIVE_PARITY_FIELDS = '1'
  } else {
    delete process.env.REASONIX_EMBEDDING_STAGE_METRICS
    delete process.env.REASONIX_NATIVE_STAGE_METRICS
    delete process.env.REASONIX_NATIVE_PARITY_FIELDS
  }
  if (options.scanWorkers === 0) delete process.env.REASONIX_NATIVE_SCAN_WORKERS
  else if (options.scanWorkers !== null) {
    process.env.REASONIX_NATIVE_SCAN_WORKERS = String(options.scanWorkers)
  }
  process.resourcesPath = options.childrenDir
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return createElectronMock(userDataPath, options.appRoot)
    return originalLoad.call(this, request, parent, isMain)
  }

  const addon = require(options.addonPath)
  let embeddingService
  let resourceMonitor
  let benchmarkChildTracker
  let stopEmbeddingObserver
  const report = {
    schemaVersion: 1,
    generatedAt: executionStartedAt.toISOString(),
    execution: {
      runNonce: options.runNonce,
      startedAt: executionStartedAt.toISOString(),
      finishedAt: null,
      durationMs: null,
      tempDirectoryId,
    },
    safety: {
      sourceDatasetReadOnly: true,
      isolatedUserData: true,
      tempDirectoryId,
      sourceSnapshot: sourceSnapshotBefore,
    },
    config: {
      imageCount,
      sourceImageCount: allImages.length,
      backend: options.backend,
      pipeline: options.pipeline,
      jobs: options.jobs,
      batchSize: options.batchSize,
      requestedScanWorkers: options.scanWorkers,
      tensorPrefetch: options.tensorPrefetch,
      dinoFusedShadow: options.dinoFusedShadow,
      nativeVersion: addon.getNativeVersion(),
      deferThumbnails: options.deferThumbnails,
      verifyWarm: options.verifyWarm,
      stageMetrics: options.stageMetrics,
      timelineMaxBytes: options.timelineMaxBytes,
      timelineMaxEvents: options.timelineMaxEvents,
    },
    harness,
    timeline: {
      enabled: timeline.enabled,
      format: timeline.enabled ? 'ndjson' : null,
      progressIntervalMs: 1_000,
      pathsAndFilenamesOmitted: true,
      ...timeline.snapshot(),
    },
    phases: {},
  }
  try {
    timeline.write('stage-start', { stage: 'resource-monitor' })
    resourceMonitor = await startResourceMonitor()
    benchmarkChildTracker = startBenchmarkChildTracker()
    const totalStartedAt = performance.now()
    assert.equal(addon.clearIndex().ok, true)
    const configured = addon.configureScanThumbnails(thumbnailDir, !options.deferThumbnails, 6)
    assert.equal(configured.ok, true)

    const modelService = loadTsModule('electron/modelService.ts')
    const vectorDb = loadTsModule('electron/vectorDatabaseService.ts')
    embeddingService = loadTsModule('electron/embeddingService.ts')
    const vectorIndex = loadTsModule('electron/vectorIndexService.ts')

    const serviceInitStartedAt = performance.now()
    timeline.write('stage-start', { stage: 'service-init' })
    modelService.initModelService(userDataPath)
    vectorDb.initVectorDatabase(userDataPath)
    report.phases.serviceInitMs = Number((performance.now() - serviceInitStartedAt).toFixed(2))
    timeline.write('stage-end', {
      stage: 'service-init',
      durationMs: report.phases.serviceInitMs,
    })

    const statuses = {}
    for (const modelName of ['dinov2_vitb14', 'clip_vit_base_patch32']) {
      const statusStartedAt = performance.now()
      const status = modelService.getModelStatus(modelName)
      statuses[modelName] = {
        state: status.state,
        version: status.version,
        prepareMs: Number((performance.now() - statusStartedAt).toFixed(2)),
      }
      assert.equal(status.state, 'downloaded', JSON.stringify(status))
    }
    report.models = statuses

    let warmVerificationRun
    if (options.pipeline === 'serial') {
      const scanStartedAt = performance.now()
      timeline.write('stage-start', { stage: 'native-scan' })
      const started = addon.scanDirectory(sampleDataset.root, 'update')
      assert.equal(started.ok, true)
      const scanProgressSamples = []
      const scanProgress = await waitForNativeScan(
        addon,
        options.timeoutMs,
        scanProgressSamples,
        (sample) => timeline.write('stage-progress', { stage: 'native-scan', ...sample }),
      )
      report.phases.imageScanMs = Number((performance.now() - scanStartedAt).toFixed(2))
      timeline.write('stage-end', {
        stage: 'native-scan',
        durationMs: report.phases.imageScanMs,
        indexedCount: Number(scanProgress.indexedCount) || 0,
        backend: String(scanProgress.backend || 'unknown'),
        fallbackCode: String(scanProgress.fallbackCode || ''),
      })

      const saveStartedAt = performance.now()
      timeline.write('stage-start', { stage: 'hash-index-save' })
      const saved = addon.saveIndexToManifest(hashIndexDir)
      assert.equal(saved.ok, true, JSON.stringify(saved))
      report.phases.hashIndexSaveMs = Number((performance.now() - saveStartedAt).toFixed(2))
      timeline.write('stage-end', {
        stage: 'hash-index-save',
        durationMs: report.phases.hashIndexSaveMs,
      })

      const baseRequest = {
        embeddingType: 'global',
        scanPaths: [sampleDataset.root],
        backend: options.backend,
        maxConcurrentEmbeddings: options.jobs,
        batchSize: options.batchSize,
      }
      timeline.write('stage-start', { stage: 'dino' })
      const dino = await runEmbeddingPhase(
        embeddingService,
        { ...baseRequest, modelName: 'dinov2_vitb14' },
        options.timeoutMs,
        (sample) =>
          timeline.write('stage-progress', {
            stage: 'dino',
            state: sample.state,
            total: sample.total,
            completed: sample.completed,
            failed: sample.failed,
            skipped: sample.skipped,
            pending: sample.pending,
            running: sample.running,
            itemsPerSecond: sample.itemsPerSecond,
          }),
      )
      report.phases.dinoPreparationMs = dino.preparationMs
      report.phases.dinoInferencePersistenceMs = dino.inferencePersistenceMs
      report.dino = dino
      timeline.write('stage-end', {
        stage: 'dino',
        durationMs: dino.totalMs,
        completed: Number(dino.progress.completed) || 0,
        failed: Number(dino.progress.failed) || 0,
        itemsPerSecond: Number(dino.progress.itemsPerSecond) || 0,
        stageMetrics: dino.progress.stageMetrics,
      })

      timeline.write('stage-start', { stage: 'clip' })
      const clip = await runEmbeddingPhase(
        embeddingService,
        { ...baseRequest, modelName: 'clip_vit_base_patch32' },
        options.timeoutMs,
        (sample) =>
          timeline.write('stage-progress', {
            stage: 'clip',
            state: sample.state,
            total: sample.total,
            completed: sample.completed,
            failed: sample.failed,
            skipped: sample.skipped,
            pending: sample.pending,
            running: sample.running,
            itemsPerSecond: sample.itemsPerSecond,
          }),
      )
      report.phases.clipPreparationMs = clip.preparationMs
      report.phases.clipInferencePersistenceMs = clip.inferencePersistenceMs
      report.clip = clip
      timeline.write('stage-end', {
        stage: 'clip',
        durationMs: clip.totalMs,
        completed: Number(clip.progress.completed) || 0,
        failed: Number(clip.progress.failed) || 0,
        itemsPerSecond: Number(clip.progress.itemsPerSecond) || 0,
        stageMetrics: clip.progress.stageMetrics,
      })

      const vectorIndexStartedAt = performance.now()
      timeline.write('stage-start', { stage: 'vector-index' })
      const built = await vectorIndex.buildVectorIndex('dinov2_vitb14')
      report.phases.vectorIndexBuildMs = Number(
        (performance.now() - vectorIndexStartedAt).toFixed(2),
      )
      assert.equal(built.ok, true, JSON.stringify(built))
      timeline.write('stage-end', {
        stage: 'vector-index',
        durationMs: report.phases.vectorIndexBuildMs,
      })
      report.vectorIndex = { result: built, status: vectorIndex.getVectorIndexStatus() }
      report.scan = {
        progress: scanProgress,
        progressSamples: scanProgressSamples,
        digest: nativeDigest(addon, sampleDataset.root),
      }
    } else {
      const { createImagePreparationPipeline } = loadTsModule(
        'electron/imagePreparationPipeline.ts',
      )
      const pipelineStartedAt = performance.now()
      const embeddingStartedAt = {}
      const embeddingFinishedAt = {}
      const embeddingPreparationMs = { dinov2_vitb14: 0, clip_vit_base_patch32: 0 }
      const embeddingTerminal = {}
      const embeddingProgressSamples = { dinov2_vitb14: [], clip_vit_base_patch32: [] }
      const embeddingLastRecordedAt = {}
      const embeddingRuns = []
      const scanProgressSamples = []
      let activeModel = null
      let activeEmbeddingRun = null
      let captureDetailedSamples = true
      let captureScanSamples = true
      const observeEmbedding = (progress) => {
        if (!activeModel) return
        const now = performance.now()
        if (
          captureDetailedSamples &&
          (now - (embeddingLastRecordedAt[activeModel] || 0) >= 1_000 ||
            progress.state === 'done' ||
            progress.state === 'error')
        ) {
          embeddingLastRecordedAt[activeModel] = now
          const sample = {
            atMs: Number((now - (embeddingStartedAt[activeModel] || now)).toFixed(2)),
            run: activeEmbeddingRun?.sequence || 0,
            state: String(progress.state || 'unknown'),
            total: Number(progress.total) || 0,
            completed: Number(progress.completed) || 0,
            failed: Number(progress.failed) || 0,
            skipped: Number(progress.skipped) || 0,
            pending: Number(progress.pending) || 0,
            running: Number(progress.running) || 0,
            itemsPerSecond: Number(progress.itemsPerSecond) || 0,
          }
          const previous = embeddingProgressSamples[activeModel].at(-1)
          const duplicate =
            previous?.run === sample.run &&
            previous.state === sample.state &&
            previous.total === sample.total &&
            previous.completed === sample.completed &&
            previous.failed === sample.failed &&
            previous.skipped === sample.skipped &&
            previous.pending === sample.pending &&
            previous.running === sample.running
          if (!duplicate) {
            embeddingProgressSamples[activeModel].push(sample)
            timeline.write('stage-progress', {
              stage: activeModel === 'dinov2_vitb14' ? 'dino' : 'clip',
              ...sample,
            })
          }
        }
        if (progress.state !== 'done' && progress.state !== 'error') return
        if (captureDetailedSamples) {
          embeddingFinishedAt[activeModel] = performance.now()
          embeddingTerminal[activeModel] = representativeEmbeddingTerminal(
            embeddingTerminal[activeModel],
            progress,
          )
        }
        if (activeEmbeddingRun) {
          activeEmbeddingRun.finishedAtMs = Number(
            (performance.now() - pipelineStartedAt).toFixed(2),
          )
          activeEmbeddingRun.terminal = { ...progress }
        }
      }
      stopEmbeddingObserver = embeddingService.onEmbeddingProgress(observeEmbedding)
      const nativeScanStatus = () => {
        const progress = addon.getScanProgress()
        return {
          ...progress,
          state:
            progress.state === 'scanning'
              ? 'scanning'
              : progress.state === 'error'
                ? 'error'
                : 'idle',
          indexedCount: Number(progress.indexedCount) || 0,
          pendingCount: Number(progress.scanQueuePending) || 0,
        }
      }
      let scanLastRecordedAt = Number.NEGATIVE_INFINITY
      let scanLastState = ''
      const observeScan = (progress, force = false) => {
        if (!captureScanSamples) return
        const now = performance.now()
        const stateChanged = progress.state !== scanLastState
        scanLastState = progress.state
        if (!force && !stateChanged && now - scanLastRecordedAt < 1_000) return
        scanLastRecordedAt = now
        const sample = {
          atMs: Number((now - pipelineStartedAt).toFixed(2)),
          state: String(progress.state || 'unknown'),
          indexedCount: Number(progress.indexedCount) || 0,
          pendingCount: Number(progress.pendingCount) || 0,
          activeWorkers: Number(progress.scanActiveWorkers) || 0,
          failedCount: Number(progress.failedCount) || 0,
          skippedCount: Number(progress.skippedCount) || 0,
          totalBytes: Number(progress.totalBytes) || 0,
        }
        scanProgressSamples.push(sample)
        timeline.write('stage-progress', { stage: 'native-scan', ...sample })
      }
      const startEmbedding = async (request) => {
        activeModel = request.modelName
        activeEmbeddingRun = {
          sequence: embeddingRuns.length + 1,
          modelName: request.modelName,
          streaming: Boolean(request.streamSessionId),
          initialInputs: request.imageIds?.length || 0,
          scanRoots: request.scanPaths?.length || 0,
          startedAtMs: Number((performance.now() - pipelineStartedAt).toFixed(2)),
        }
        embeddingRuns.push(activeEmbeddingRun)
        embeddingStartedAt[activeModel] ??= performance.now()
        const startedAt = performance.now()
        const result = await embeddingService.startEmbeddingBuild(request)
        embeddingPreparationMs[activeModel] += performance.now() - startedAt
        return result
      }
      const buildVectorIndex = async (modelName) => {
        const startedAt = performance.now()
        const result = await vectorIndex.buildVectorIndex(modelName)
        const durationMs = Number((performance.now() - startedAt).toFixed(2))
        if (report.phases.vectorIndexBuildMs === undefined) {
          report.phases.vectorIndexBuildMs = durationMs
        } else report.phases.warmVectorIndexBuildMs = durationMs
        return result
      }
      const pipelineProgress = []
      let lastPipelineTimelineAt = Number.NEGATIVE_INFINITY
      let lastPipelinePhase = ''
      const pipeline = createImagePreparationPipeline({
        configureCommitFeed: (enabled, maxEntries) =>
          addon.configureScanCommitFeed(enabled, maxEntries),
        drainCommitFeed: (limit) => addon.drainScanCommittedPaths(limit),
        startScan: (request) => {
          const started = addon.scanDirectory(
            request.paths.join('\x1f'),
            request.scanMode || 'update',
          )
          assert.equal(started.ok, true, JSON.stringify(started))
          const status = nativeScanStatus()
          observeScan(status, true)
          return status
        },
        getScanStatus: nativeScanStatus,
        onScanStatus: (listener) => {
          const timer = setInterval(() => {
            const status = nativeScanStatus()
            observeScan(status)
            listener(status)
          }, 20)
          return () => clearInterval(timer)
        },
        scanLifecycleComplete: () => {
          const state = addon.getScanProgress().state
          return state === 'idle' || state === 'error'
        },
        waitScanPersistence: async () => {
          const startedAt = performance.now()
          const saved = addon.saveIndexToManifest(hashIndexDir)
          assert.equal(saved.ok, true, JSON.stringify(saved))
          const durationMs = Number((performance.now() - startedAt).toFixed(2))
          if (report.phases.hashIndexSaveMs === undefined)
            report.phases.hashIndexSaveMs = durationMs
          else report.phases.warmHashIndexSaveMs = durationMs
        },
        stopScan: async () => {
          addon.stopScan()
          return nativeScanStatus()
        },
        getCatalogRevision: () => JSON.stringify(addon.getIndexMode()),
        getModelStatus: (modelName) => modelService.getModelStatus(modelName),
        downloadModel: (modelName) => modelService.downloadModel(modelName),
        cancelDownload: () => modelService.cancelDownload(),
        startEmbedding,
        getEmbeddingProgress: () => embeddingService.getEmbeddingProgress(),
        onEmbeddingProgress: (listener) => embeddingService.onEmbeddingProgress(listener),
        cancelQueuedEmbedding: () => false,
        stopEmbedding: () => embeddingService.stopEmbeddingBuild(),
        isStreamingEmbeddingReady: (sessionId) =>
          embeddingService.isStreamingEmbeddingBuildReady(sessionId),
        appendStreamingEmbeddingInputs: (sessionId, imagePaths, appendOptions) =>
          embeddingService.appendStreamingEmbeddingInputs(sessionId, imagePaths, appendOptions),
        closeStreamingEmbedding: (sessionId) =>
          embeddingService.closeStreamingEmbeddingBuild(sessionId),
        scaleStreamingEmbedding: (sessionId, concurrency) =>
          embeddingService.scaleStreamingEmbeddingBuild(sessionId, concurrency),
        invalidateCommittedInputs: async (paths) => {
          vectorDb.removeImageDataBatch(paths)
          await vectorDb.flushVectorDatabaseWrites()
        },
        buildVectorIndex,
      })
      timeline.write('stage-start', { stage: 'overlap-pipeline' })
      const pipelineResult = await pipeline({
        paths: [sampleDataset.root],
        backend: options.backend,
        maxConcurrentEmbeddings: options.jobs,
        batchSize: options.batchSize,
        onProgress: (progress) => {
          const snapshot = {
            ...progress,
            atMs: Number((performance.now() - pipelineStartedAt).toFixed(2)),
          }
          pipelineProgress.push(snapshot)
          const phaseChanged = snapshot.phase !== lastPipelinePhase
          if (
            phaseChanged ||
            snapshot.atMs - lastPipelineTimelineAt >= 1_000 ||
            snapshot.vectorIndexComplete
          ) {
            lastPipelineTimelineAt = snapshot.atMs
            lastPipelinePhase = snapshot.phase
            timeline.write('pipeline-progress', {
              stage: snapshot.phase,
              percentage: snapshot.percentage,
              scanIndexed: snapshot.scanIndexed,
              committedImages: snapshot.committedImages,
              invalidatedImages: snapshot.invalidatedImages,
              commitFeedDropped: snapshot.commitFeedDropped,
              scanComplete: snapshot.scanComplete,
              dinoEmbeddingComplete: snapshot.dinoEmbeddingComplete,
              clipEmbeddingComplete: snapshot.clipEmbeddingComplete,
              vectorIndexComplete: snapshot.vectorIndexComplete,
            })
          }
        },
      })
      captureDetailedSamples = false
      captureScanSamples = false
      timeline.write('stage-end', {
        stage: 'overlap-pipeline',
        durationMs: Number(pipelineResult.timings.totalMs.toFixed(2)),
        scanReadyMs: Number(pipelineResult.timings.scanReadyMs.toFixed(2)),
        dinoReadyMs: Number(pipelineResult.timings.dinoReadyMs.toFixed(2)),
        clipReadyMs: Number(pipelineResult.timings.clipReadyMs.toFixed(2)),
        vectorIndexMs: Number(pipelineResult.timings.vectorIndexMs.toFixed(2)),
      })
      report.pipeline = { result: pipelineResult, progress: pipelineProgress }
      report.phases.imageScanMs = Number(pipelineResult.timings.scanReadyMs.toFixed(2))
      for (const [field, modelName] of [
        ['dino', 'dinov2_vitb14'],
        ['clip', 'clip_vit_base_patch32'],
      ]) {
        const preparationMs = Number(embeddingPreparationMs[modelName].toFixed(2))
        const totalMs = Number(
          (
            (embeddingFinishedAt[modelName] || performance.now()) - embeddingStartedAt[modelName]
          ).toFixed(2),
        )
        report.phases[`${field}PreparationMs`] = preparationMs
        report.phases[`${field}InferencePersistenceMs`] = Number(
          Math.max(0, totalMs - preparationMs).toFixed(2),
        )
        report[field] = {
          totalMs,
          preparationMs,
          inferencePersistenceMs: report.phases[`${field}InferencePersistenceMs`],
          progress: embeddingTerminal[modelName],
          progressSamples: embeddingProgressSamples[modelName].map((sample) => ({ ...sample })),
        }
        timeline.write('stage-attribution', {
          stage: field,
          stageMetrics: embeddingTerminal[modelName]?.stageMetrics,
        })
      }
      report.vectorIndex = {
        result: { ok: true },
        status: vectorIndex.getVectorIndexStatus(),
      }
      report.scan = {
        progress: nativeScanStatus(),
        progressSamples: scanProgressSamples.map((sample) => ({ ...sample })),
        digest: nativeDigest(addon, sampleDataset.root),
      }
      if (options.verifyWarm) {
        warmVerificationRun = async () => {
          const runStart = embeddingRuns.length
          const startedAt = performance.now()
          const progress = []
          timeline.write('stage-start', { stage: 'warm-verification' })
          const warmResult = await pipeline({
            paths: [sampleDataset.root],
            backend: options.backend,
            maxConcurrentEmbeddings: options.jobs,
            batchSize: options.batchSize,
            onProgress: (snapshot) => progress.push({ ...snapshot }),
          })
          const starts = embeddingRuns.slice(runStart)
          assert.equal(warmResult.committedImages, 0)
          assert.equal(warmResult.invalidatedImages, 0)
          assert.equal(starts.length, 2)
          assert.ok(starts.every((run) => !run.streaming))
          for (const modelName of ['dinov2_vitb14', 'clip_vit_base_patch32']) {
            const run = starts.find((item) => item.modelName === modelName)
            assert.ok(run, `${modelName} warm verification did not start`)
            assert.equal(run.terminal?.completed, 0)
            assert.equal(run.terminal?.failed, 0)
            assert.equal(run.terminal?.skipped, imageCount)
          }
          const result = {
            ok: true,
            durationMs: Number((performance.now() - startedAt).toFixed(2)),
            committedImages: warmResult.committedImages,
            invalidatedImages: warmResult.invalidatedImages,
            commitFeedDropped: warmResult.commitFeedDropped,
            embeddingRuns: starts,
            ready: progress.at(-1)?.vectorIndexComplete === true,
          }
          timeline.write('stage-end', {
            stage: 'warm-verification',
            durationMs: result.durationMs,
            committedImages: result.committedImages,
            invalidatedImages: result.invalidatedImages,
            commitFeedDropped: result.commitFeedDropped,
          })
          return result
        }
      }
    }
    assert.equal(report.scan.digest.count, imageCount)
    report.providerEvidence = {
      dino: report.dino?.progress?.providerTelemetry || null,
      clip: report.clip?.progress?.providerTelemetry || null,
    }
    report.phases.libraryReadyMs = Number((performance.now() - totalStartedAt).toFixed(2))
    report.phases.workflowReadySignalMs = report.phases.libraryReadyMs
    report.milestones = {
      searchableServiceMs: report.phases.libraryReadyMs,
      workflowReadySignalMs: report.phases.workflowReadySignalMs,
      rendererPaintMeasured: false,
    }
    timeline.write('milestone', {
      stage: 'library-ready',
      durationMs: report.phases.libraryReadyMs,
      images: imageCount,
    })
    if (warmVerificationRun) report.warmVerification = await warmVerificationRun()

    let backgroundThumbnailPromise
    let backgroundTimelineStartedAt = 0
    if (options.deferThumbnails) {
      const backgroundStartedAt = performance.now()
      backgroundTimelineStartedAt = backgroundStartedAt
      timeline.write('stage-start', { stage: 'background-thumbnails' })
      const backgroundStarted = addon.startNativeThumbnailRebuild(
        sampleDataset.root,
        thumbnailDir,
        6,
        options.jobs,
        false,
      )
      assert.equal(backgroundStarted.ok, true, JSON.stringify(backgroundStarted))
      report.phases.backgroundThumbnailStartMs = Number(
        (performance.now() - backgroundStartedAt).toFixed(2),
      )
      backgroundThumbnailPromise = waitForNativeThumbnailRebuild(addon, options.timeoutMs)
    }

    const verificationStartedAt = performance.now()
    timeline.write('stage-start', { stage: 'verification' })
    const dinoEntries = vectorDb.getEmbeddingsByModel('dinov2_vitb14', 'global')
    const clipEntries = vectorDb.getEmbeddingsByModel('clip_vit_base_patch32', 'global')
    report.embeddingDigests = {
      dino: embeddingDigest(dinoEntries, sampleDataset.root),
      clip: embeddingDigest(clipEntries, sampleDataset.root),
    }
    assert.equal(report.embeddingDigests.dino.count, imageCount)
    assert.equal(report.embeddingDigests.clip.count, imageCount)
    report.phases.verificationMs = Number((performance.now() - verificationStartedAt).toFixed(2))
    timeline.write('stage-end', {
      stage: 'verification',
      durationMs: report.phases.verificationMs,
      dino: report.embeddingDigests.dino.count,
      clip: report.embeddingDigests.clip.count,
    })
    report.storage = {
      userData: directoryBytes(userDataPath),
      thumbnails: directoryBytes(thumbnailDir),
      vectorDb: directoryBytes(path.join(userDataPath, 'vector-db')),
    }
    if (backgroundThumbnailPromise) {
      const backgroundStartedAt = performance.now()
      report.backgroundThumbnails = await backgroundThumbnailPromise
      report.phases.backgroundThumbnailDrainMs = Number(
        (performance.now() - backgroundStartedAt).toFixed(2),
      )
      assert.equal(report.backgroundThumbnails.completed, imageCount)
      assert.equal(report.backgroundThumbnails.failed, 0)
      report.storage.thumbnails = directoryBytes(thumbnailDir)
      timeline.write('stage-end', {
        stage: 'background-thumbnails',
        durationMs: Number((performance.now() - backgroundTimelineStartedAt).toFixed(2)),
        completed: report.backgroundThumbnails.completed,
        failed: report.backgroundThumbnails.failed,
      })
    }
    report.phases.totalMs = Number((performance.now() - totalStartedAt).toFixed(2))
    const childStopEvidence = await benchmarkChildTracker.stopEvidence()
    benchmarkChildTracker.restore()
    benchmarkChildTracker = null
    report.resources = await resourceMonitor.stop()
    resourceMonitor = null
    report.resources.processes = {
      ...report.resources.processes,
      ...childStopEvidence,
    }
    report.resources.sampling.sampleCount = report.resources.sampling.samples
    report.resources.sampling.activeAtStop = childStopEvidence.activeAtStop
    report.resources.sampling.observedChildEvidence = {
      lifecycleTracked: childStopEvidence.observedChildProcesses,
      samplerObserved: report.resources.sampling.observedChildProcesses,
      lifecycleAccounted: childStopEvidence.lifecycleAccounted,
    }
    assert.equal(
      childStopEvidence.lifecycleAccounted,
      true,
      'Benchmark child-process lifecycle evidence is incomplete',
    )
    assert.equal(
      childStopEvidence.activeAtStop,
      0,
      `Benchmark child processes remain active at resource stop: ${JSON.stringify(childStopEvidence.activeByCommand)}`,
    )
    timeline.write('stage-end', {
      stage: 'resource-monitor',
      samples: report.resources.sampling.samples,
      errors: report.resources.sampling.errors,
      gpuScope: report.resources.sampling.gpuScope,
    })
    const sourceSnapshotAfter = snapshotFiles(sourceImages)
    assertFileSnapshotUnchanged(sourceSnapshotBefore, sourceSnapshotAfter)
    report.safety.sourceUnchanged = true
    report.safety.noBenchmarkChildProcessesAtStop = childStopEvidence.noResidualAtStop
    report.ok = true
    timeline.write('benchmark-end', {
      stage: 'complete',
      ok: true,
      libraryReadyMs: report.phases.libraryReadyMs,
      totalMs: report.phases.totalMs,
    })
    const executionFinishedAt = new Date()
    report.execution.finishedAt = executionFinishedAt.toISOString()
    report.execution.durationMs = Number((performance.now() - executionStartedMonotonic).toFixed(2))
    report.timeline = {
      ...report.timeline,
      ...timeline.snapshot(),
    }
    const summary = {
      ok: report.ok,
      execution: report.execution,
      imageCount,
      phases: report.phases,
      resources: report.resources,
      scan: report.scan.digest,
      providerEvidence: report.providerEvidence,
      scanWorkers: report.scan.progress.scanWorkerCount,
      scanThumbnails: report.scan.progress.thumbnailCompleted,
      backgroundThumbnails: report.backgroundThumbnails
        ? {
            total: report.backgroundThumbnails.total,
            completed: report.backgroundThumbnails.completed,
            failed: report.backgroundThumbnails.failed,
            workers: report.backgroundThumbnails.workers,
          }
        : undefined,
      dino: report.embeddingDigests.dino,
      clip: report.embeddingDigests.clip,
      embeddingRuntime: {
        requestedBatchSize: options.batchSize,
        dino: {
          effectiveBatchSize: report.dino.progress.effectiveBatchSize,
          batchMode: report.dino.progress.batchMode,
          batchReason: report.dino.progress.batchReason,
          availableMemoryMb: report.dino.progress.availableMemoryMb,
          availableVideoMemoryMb: report.dino.progress.availableVideoMemoryMb,
          stageMetrics: report.dino.progress.stageMetrics,
        },
        clip: {
          effectiveBatchSize: report.clip.progress.effectiveBatchSize,
          batchMode: report.clip.progress.batchMode,
          batchReason: report.clip.progress.batchReason,
          availableMemoryMb: report.clip.progress.availableMemoryMb,
          availableVideoMemoryMb: report.clip.progress.availableVideoMemoryMb,
          stageMetrics: report.clip.progress.stageMetrics,
        },
      },
      vectorIndex: report.vectorIndex.status,
      storage: report.storage,
      safety: {
        sourceDatasetReadOnly: true,
        isolatedUserData: true,
        sourceUnchanged: true,
        tempDirectoryId,
        noBenchmarkChildProcessesAtStop: childStopEvidence.noResidualAtStop,
        sourceSnapshot: sourceSnapshotBefore,
      },
    }
    const publicReport = redactPaths(report, [
      [sampleDataset.root, '<sample-corpus>'],
      [options.dataset, '<source-corpus>'],
      [tempRoot, '<isolated-temp>'],
      [options.appRoot, '<app-root>'],
    ])
    if (options.jsonOut) writeJson(options.jsonOut, publicReport)
    if (options.compact) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    else {
      process.stdout.write(`${JSON.stringify(publicReport, null, 2)}\n`)
      process.stderr.write(`[simple-e2e-summary] ${JSON.stringify(summary)}\n`)
    }
  } finally {
    const cleanupTracker = benchmarkChildTracker
    cleanupTracker?.restore()
    let childCleanupFailure
    if (cleanupTracker) {
      try {
        const cleanupEvidence = await cleanupTracker.cleanup(10_000)
        if (!cleanupEvidence.spawnRestored || !cleanupEvidence.noResidualAfterCleanup) {
          childCleanupFailure = new Error(
            `Benchmark child cleanup left active processes: ${JSON.stringify(cleanupEvidence.activeByCommand)}`,
          )
        }
      } catch (error) {
        childCleanupFailure = error
      }
    }
    stopEmbeddingObserver?.()
    if (embeddingService) {
      const state = embeddingService.getEmbeddingProgress?.().state
      if (['queued', 'running', 'paused', 'stopping'].includes(state)) {
        embeddingService.stopEmbeddingBuild?.()
      }
    }
    benchmarkChildTracker?.restore()
    if (resourceMonitor) {
      await resourceMonitor.stop().catch(() => undefined)
    }
    addon.stopScan()
    addon.stopNativeThumbnailRebuild?.()
    addon.clearIndex()
    Module._load = originalLoad
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    if (originalEmbeddingStageMetrics === undefined)
      delete process.env.REASONIX_EMBEDDING_STAGE_METRICS
    else process.env.REASONIX_EMBEDDING_STAGE_METRICS = originalEmbeddingStageMetrics
    if (originalEmbeddingTensorPrefetch === undefined)
      delete process.env.REASONIX_EMBEDDING_TENSOR_PREFETCH
    else process.env.REASONIX_EMBEDDING_TENSOR_PREFETCH = originalEmbeddingTensorPrefetch
    if (originalDinoFusedShadow === undefined) delete process.env.REASONIX_DINO_FUSED_SHADOW
    else process.env.REASONIX_DINO_FUSED_SHADOW = originalDinoFusedShadow
    if (originalNativeStageMetrics === undefined) delete process.env.REASONIX_NATIVE_STAGE_METRICS
    else process.env.REASONIX_NATIVE_STAGE_METRICS = originalNativeStageMetrics
    if (originalNativeScanWorkers === undefined) delete process.env.REASONIX_NATIVE_SCAN_WORKERS
    else process.env.REASONIX_NATIVE_SCAN_WORKERS = originalNativeScanWorkers
    if (originalNativeParityFields === undefined) delete process.env.REASONIX_NATIVE_PARITY_FIELDS
    else process.env.REASONIX_NATIVE_PARITY_FIELDS = originalNativeParityFields
    process.resourcesPath = originalResourcesPath
    if (options.keepTemp) process.stderr.write(`Kept temporary output: ${tempRoot}\n`)
    else safeRemoveTempRoot(tempRoot, 'floating-clock-simple-e2e-')
    if (childCleanupFailure) {
      const message =
        childCleanupFailure instanceof Error
          ? childCleanupFailure.message
          : String(childCleanupFailure)
      process.stderr.write(`[benchmark-child-cleanup] ${message.slice(0, 2_000)}\n`)
      process.exitCode = 1
    }
  }
  if (process.exitCode && lifecycleBarrier) {
    throw new Error('Benchmark cannot enter the lifecycle barrier after cleanup failure')
  }
  await waitForLifecycleRelease(lifecycleBarrier)
  return options
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = {
  createTimelineLogger,
  parseArgs,
  publishLifecycleBarrierFile,
  readLifecycleBarrierFile,
  startBenchmarkChildTracker,
  validateLifecycleBarrierOptions,
  waitForLifecycleRelease,
}
