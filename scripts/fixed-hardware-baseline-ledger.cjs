const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { compareEvidence } = require('./fixed-hardware-baseline-evidence.cjs')
const { validateRound } = require('./fixed-hardware-round-validator.cjs')

const LOCK_FILE_NAME = '.fixed-hardware-baseline.lock'
const ACCEPTED_POINTER_FILE_NAME = 'latest.json'
const ACCEPTED_POINTER_KIND = 'fixed-hardware-accepted-baseline-pointer'
const ACCEPTED_REPORT_KIND = 'fixed-hardware-first-build-baseline'
const ACCEPTED_EVIDENCE_KIND = 'fixed-hardware-baseline-evidence'
const MAX_ACCEPTED_POINTER_BYTES = 64 * 1024
const MAX_ACCEPTED_REPORT_BYTES = 32 * 1024 * 1024
const FORMAL_SAMPLE = 1000
const FORMAL_RUNS = 3
const FORMAL_PIPELINE = 'overlap'
const FORMAL_SCAN_WORKERS = 2
const FORMAL_TIMELINE_MAX_BYTES = 8 * 1024 * 1024
const FORMAL_TIMELINE_MAX_EVENTS = 50_000
const READY_SPREAD_BUDGET_PERCENT = 15
const TIME_REGRESSION_BUDGET_PERCENT = 10
const MEMORY_REGRESSION_BUDGET_PERCENT = 15
const MIN_SYSTEM_FREE_MIB = 256
const GIB = 1024 ** 3
const FORMAL_QUIET_WINDOW_MS = 10 * 60 * 1000
const REQUIRED_CONTROL_LIMIT_FIELDS = Object.freeze([
  'libraryReadyP95Ms',
  'mainPeakRssP95MiB',
  'childPeakAggregateRssP95MiB',
  'combinedPeakRssP95MiB',
  'systemMinFreeFloorMiB',
  'readySpreadPercent',
])
const PROMOTION_UPPER_LIMIT_FIELDS = Object.freeze([
  'libraryReadyP95Ms',
  'mainPeakRssP95MiB',
  'childPeakAggregateRssP95MiB',
  'combinedPeakRssP95MiB',
  'readySpreadPercent',
])

function ledgerError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  return error
}

function normalizeForComparison(filePath) {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(left, right) {
  return normalizeForComparison(left) === normalizeForComparison(right)
}

function isPathInside(root, candidate, { allowEqual = true } = {}) {
  const relative = path.relative(normalizeForComparison(root), normalizeForComparison(candidate))
  if (relative === '') return allowEqual
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function realpath(filePath) {
  return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath)
}

function canonicalExistingDirectory(directoryPath, label) {
  const resolved = path.resolve(directoryPath)
  let stat
  try {
    stat = fs.statSync(resolved)
  } catch (error) {
    throw ledgerError(
      'DIRECTORY_REQUIRED',
      `${label} must be an existing directory: ${resolved}`,
      error,
    )
  }
  if (!stat.isDirectory()) {
    throw ledgerError('DIRECTORY_REQUIRED', `${label} must be an existing directory: ${resolved}`)
  }
  return realpath(resolved)
}

function canonicalExistingFile(filePath, label) {
  const resolved = path.resolve(filePath)
  let entry
  let stat
  try {
    entry = fs.lstatSync(resolved)
    stat = fs.statSync(resolved)
  } catch (error) {
    throw ledgerError('FILE_REQUIRED', `${label} must be an existing file: ${resolved}`, error)
  }
  if (entry.isSymbolicLink() || !stat.isFile()) {
    throw ledgerError('FILE_REQUIRED', `${label} must be a regular, non-symlink file: ${resolved}`)
  }
  return realpath(resolved)
}

function pathEntryExists(filePath) {
  try {
    fs.lstatSync(filePath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function canonicalPathForCreate(candidatePath) {
  const resolved = path.resolve(candidatePath)
  let ancestor = resolved
  const suffix = []
  while (!pathEntryExists(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) {
      throw ledgerError('CANONICAL_PATH_FAILED', `No existing ancestor for path: ${resolved}`)
    }
    suffix.unshift(path.basename(ancestor))
    ancestor = parent
  }
  let canonicalAncestor
  try {
    canonicalAncestor = realpath(ancestor)
  } catch (error) {
    throw ledgerError('CANONICAL_PATH_FAILED', `Unable to canonicalize path: ${resolved}`, error)
  }
  return path.resolve(canonicalAncestor, ...suffix)
}

function validateManagedRunPaths({ managedRoot, dataset, outputDirectory }) {
  const canonicalRoot = canonicalExistingDirectory(managedRoot, 'managed root')
  const canonicalDataset = canonicalExistingDirectory(dataset, 'dataset')
  const canonicalOutput = canonicalPathForCreate(outputDirectory)

  if (!isPathInside(canonicalRoot, canonicalOutput, { allowEqual: false })) {
    throw ledgerError(
      'OUTPUT_ESCAPED_ROOT',
      `Output directory must remain inside the canonical managed root: ${canonicalRoot}`,
    )
  }
  if (
    isPathInside(canonicalDataset, canonicalOutput) ||
    isPathInside(canonicalOutput, canonicalDataset)
  ) {
    throw ledgerError('DATASET_OUTPUT_OVERLAP', 'Dataset and output directory must not overlap')
  }
  const canonicalParent = canonicalPathForCreate(path.dirname(canonicalOutput))
  if (!samePath(canonicalParent, path.dirname(canonicalOutput))) {
    throw ledgerError('OUTPUT_PARENT_CHANGED', 'Output parent changed during canonical validation')
  }
  if (!fs.statSync(canonicalParent).isDirectory()) {
    throw ledgerError('OUTPUT_PARENT_REQUIRED', `Output parent must exist: ${canonicalParent}`)
  }

  return {
    managedRoot: canonicalRoot,
    dataset: canonicalDataset,
    outputDirectory: canonicalOutput,
  }
}

function acquireLedgerLock(managedRoot, options = {}) {
  const canonicalRoot = canonicalExistingDirectory(managedRoot, 'managed root')
  const lockPath = path.join(canonicalRoot, LOCK_FILE_NAME)
  const token = options.token || crypto.randomUUID()
  const createdAt = (
    options.now instanceof Date ? options.now : new Date(options.now || Date.now())
  ).toISOString()
  let descriptor
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw ledgerError(
        'LOCK_CONFLICT',
        `Another fixed-hardware baseline owns the lock: ${lockPath}`,
        error,
      )
    }
    throw ledgerError('LOCK_CREATE_FAILED', `Unable to create baseline lock: ${lockPath}`, error)
  }

  const lockRecord = { schemaVersion: 1, token, pid: process.pid, createdAt }
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(lockRecord)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
  } catch (error) {
    try {
      fs.closeSync(descriptor)
    } catch {
      // Preserve the write failure.
    }
    try {
      fs.unlinkSync(lockPath)
    } catch {
      // A failed lock write still fails closed if cleanup is unavailable.
    }
    throw ledgerError(
      'LOCK_CREATE_FAILED',
      `Unable to initialize baseline lock: ${lockPath}`,
      error,
    )
  }
  fs.closeSync(descriptor)

  let released = false
  return {
    lockPath,
    token,
    release() {
      if (released) return false
      released = true
      let current
      try {
        current = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT') return false
        throw ledgerError(
          'LOCK_RELEASE_FAILED',
          `Unable to verify baseline lock: ${lockPath}`,
          error,
        )
      }
      if (current?.token !== token) {
        throw ledgerError('LOCK_OWNERSHIP_LOST', `Baseline lock ownership changed: ${lockPath}`)
      }
      fs.unlinkSync(lockPath)
      return true
    },
  }
}

function acquireManagedRunWorkspace(options) {
  const paths = validateManagedRunPaths(options)
  const lock = acquireLedgerLock(paths.managedRoot, options)
  let outputCreated = false
  try {
    if (pathEntryExists(paths.outputDirectory)) {
      throw ledgerError(
        'OUTPUT_NOT_FRESH',
        `Output directory must be new: ${paths.outputDirectory}`,
      )
    }
    try {
      fs.mkdirSync(paths.outputDirectory, { recursive: false })
      outputCreated = true
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw ledgerError(
          'OUTPUT_NOT_FRESH',
          `Output directory must be new: ${paths.outputDirectory}`,
          error,
        )
      }
      throw ledgerError(
        'OUTPUT_CREATE_FAILED',
        `Unable to exclusively create output directory: ${paths.outputDirectory}`,
        error,
      )
    }
    const createdOutput = canonicalExistingDirectory(
      paths.outputDirectory,
      'created output directory',
    )
    if (!samePath(createdOutput, paths.outputDirectory)) {
      throw ledgerError(
        'OUTPUT_PATH_CHANGED',
        'Created output directory changed canonical location',
      )
    }
    return {
      ...paths,
      lockPath: lock.lockPath,
      release: lock.release,
    }
  } catch (error) {
    if (outputCreated) {
      try {
        fs.rmdirSync(paths.outputDirectory)
      } catch {
        // Only remove the new directory when it is still empty.
      }
    }
    try {
      lock.release()
    } catch {
      // Preserve the workspace creation failure.
    }
    throw error
  }
}

async function withManagedRunWorkspace(options, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const workspace = acquireManagedRunWorkspace(options)
  try {
    return await callback(workspace)
  } finally {
    workspace.release()
  }
}

function pointerPathForRoot(canonicalRoot) {
  return path.join(canonicalRoot, ACCEPTED_POINTER_FILE_NAME)
}

function validateMode(mode) {
  if (mode !== 'establish' && mode !== 'compare') {
    throw ledgerError('INVALID_MODE', 'Baseline ledger mode must be establish or compare')
  }
}

const STABLE_STAT_FIELDS = Object.freeze(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'])

function sameStableStat(left, right) {
  return STABLE_STAT_FIELDS.every((field) => left?.[field] === right?.[field])
}

function assertStableRegularFile(stat, filePath, label) {
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw ledgerError('FILE_REQUIRED', `${label} must be a regular, non-symlink file: ${filePath}`)
  }
}

function assertFileSizeWithinLimit(stat, filePath, label, maxBytes) {
  if (stat.size > BigInt(maxBytes)) {
    throw ledgerError('FILE_TOO_LARGE', `${label} exceeds the ${maxBytes}-byte limit: ${filePath}`)
  }
}

function lstatBigInt(filePath, label, changedDuringRead = false) {
  try {
    return fs.lstatSync(filePath, { bigint: true })
  } catch (error) {
    throw ledgerError(
      changedDuringRead ? 'FILE_CHANGED_DURING_READ' : 'FILE_REQUIRED',
      changedDuringRead
        ? `${label} changed or disappeared during read: ${filePath}`
        : `${label} must be an existing file: ${filePath}`,
      error,
    )
  }
}

function readStableFileBytes(filePath, options = {}) {
  const resolved = path.resolve(filePath)
  const label = options.label || 'JSON file'
  const maxBytes = options.maxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('maxBytes must be a positive safe integer')
  }

  const pathBefore = lstatBigInt(resolved, label)
  assertStableRegularFile(pathBefore, resolved, label)
  assertFileSizeWithinLimit(pathBefore, resolved, label, maxBytes)

  let descriptor
  try {
    descriptor = fs.openSync(resolved, 'r')
  } catch (error) {
    throw ledgerError('FILE_READ_FAILED', `Unable to open ${label}: ${resolved}`, error)
  }

  let bytes
  try {
    const descriptorBefore = fs.fstatSync(descriptor, { bigint: true })
    assertStableRegularFile(descriptorBefore, resolved, label)
    assertFileSizeWithinLimit(descriptorBefore, resolved, label, maxBytes)
    if (!sameStableStat(pathBefore, descriptorBefore)) {
      throw ledgerError(
        'FILE_CHANGED_DURING_READ',
        `${label} changed between path validation and open: ${resolved}`,
      )
    }

    const expectedBytes = Number(descriptorBefore.size)
    bytes = Buffer.allocUnsafe(expectedBytes)
    let bytesRead = 0
    while (bytesRead < expectedBytes) {
      const count = fs.readSync(descriptor, bytes, bytesRead, expectedBytes - bytesRead, bytesRead)
      if (count === 0) break
      bytesRead += count
    }

    if (typeof options.afterRead === 'function') {
      options.afterRead({ filePath: resolved, bytesRead, expectedBytes })
    }

    const descriptorAfter = fs.fstatSync(descriptor, { bigint: true })
    const pathAfter = lstatBigInt(resolved, label, true)
    assertStableRegularFile(descriptorAfter, resolved, label)
    assertStableRegularFile(pathAfter, resolved, label)
    if (
      !sameStableStat(descriptorBefore, descriptorAfter) ||
      !sameStableStat(descriptorBefore, pathAfter)
    ) {
      throw ledgerError(
        'FILE_CHANGED_DURING_READ',
        `${label} metadata changed during read: ${resolved}`,
      )
    }
    if (bytesRead !== expectedBytes) {
      throw ledgerError(
        'FILE_READ_SIZE_MISMATCH',
        `${label} returned ${bytesRead} bytes, expected ${expectedBytes}: ${resolved}`,
      )
    }
  } finally {
    fs.closeSync(descriptor)
  }

  return {
    bytes,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }
}

function readStableJsonFile(filePath, options = {}) {
  const captured = readStableFileBytes(filePath, options)
  const resolved = path.resolve(filePath)
  const label = options.label || 'JSON file'
  let value
  try {
    value = JSON.parse(captured.bytes.toString('utf8'))
  } catch (error) {
    throw ledgerError('INVALID_JSON', `Unable to parse ${label}: ${resolved}`, error)
  }
  return { ...captured, value }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  )
}

function sameJsonValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
}

function validatePositiveControlLimits(controlLimits, label, failures) {
  if (!controlLimits || typeof controlLimits !== 'object' || Array.isArray(controlLimits)) {
    failures.push(`${label} must be an object`)
    return
  }
  for (const field of REQUIRED_CONTROL_LIMIT_FIELDS) {
    if (!Number.isFinite(controlLimits[field]) || controlLimits[field] <= 0) {
      failures.push(`${label}.${field} must be a positive finite number`)
    }
  }
}

function rounded(value) {
  return Number(Number(value).toFixed(2))
}

function summarizeValues(values) {
  const sorted = values.slice().sort((left, right) => left - right)
  const percentile = (ratio) => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null
  return {
    samples: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  }
}

function expectedFormalConfig() {
  return {
    sample: FORMAL_SAMPLE,
    runs: FORMAL_RUNS,
    pipeline: FORMAL_PIPELINE,
    backend: 'gpu',
    jobs: 2,
    batchSize: 4,
    requestedScanWorkers: FORMAL_SCAN_WORKERS,
    tensorPrefetch: false,
    deferThumbnails: true,
    verifyWarm: true,
    stageMetrics: true,
    timelineMaxBytes: FORMAL_TIMELINE_MAX_BYTES,
    timelineMaxEvents: FORMAL_TIMELINE_MAX_EVENTS,
  }
}

function validateFormalConfig(config, failures) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    failures.push('report config must be an object')
    return
  }
  if (!sameJsonValue(config, expectedFormalConfig())) {
    failures.push('report config does not match the complete formal benchmark configuration')
  }
}

function validateDeepEvidence(evidence, failures) {
  let result
  try {
    result = compareEvidence(evidence, evidence, { implementationMode: 'stable' })
  } catch (error) {
    failures.push(`report evidence validation failed: ${error.message}`)
    return
  }
  if (!result.ok) {
    failures.push(...result.failures.map((failure) => `report evidence: ${failure}`))
  }
}

function validateHardwareBinding(hardware, environment, failures) {
  if (
    typeof hardware?.platform !== 'string' ||
    typeof hardware?.release !== 'string' ||
    typeof hardware?.architecture !== 'string' ||
    typeof hardware?.cpuModel !== 'string' ||
    !Number.isSafeInteger(hardware?.logicalProcessors) ||
    hardware.logicalProcessors < 1 ||
    !Number.isSafeInteger(hardware?.totalMemoryBytes) ||
    hardware.totalMemoryBytes < 1 ||
    !Array.isArray(hardware?.controllers) ||
    hardware.controllers.length < 1 ||
    hardware.controllers.some(
      (controller) =>
        typeof controller?.name !== 'string' ||
        !controller.name ||
        typeof controller?.driverVersion !== 'string' ||
        !controller.driverVersion ||
        typeof controller?.deviceId !== 'string' ||
        !controller.deviceId ||
        typeof controller?.adapterCompatibility !== 'string' ||
        !controller.adapterCompatibility,
    ) ||
    !Array.isArray(hardware?.gpus) ||
    hardware.gpus.length < 1 ||
    hardware.gpus.some(
      (gpu) =>
        typeof gpu?.uuid !== 'string' ||
        !gpu.uuid ||
        typeof gpu?.name !== 'string' ||
        !gpu.name ||
        !Number.isFinite(gpu?.memoryTotalMiB) ||
        gpu.memoryTotalMiB <= 0 ||
        typeof gpu?.driverVersion !== 'string' ||
        !gpu.driverVersion ||
        typeof gpu?.busId !== 'string' ||
        !gpu.busId,
    )
  ) {
    failures.push('report hardware fingerprint is incomplete')
    return
  }
  const withoutId = { ...hardware }
  delete withoutId.id
  const expectedId = crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(withoutId)))
    .digest('hex')
  if (hardware.id !== expectedId) failures.push('report hardware identity is invalid')
  if (
    hardware.platform !== environment?.os?.platform ||
    hardware.release !== environment?.os?.release ||
    hardware.architecture !== environment?.os?.arch
  ) {
    failures.push('report hardware OS identity differs from environment evidence')
  }
  if (
    hardware.cpuModel !== environment?.hardwareSnapshot?.cpuModel ||
    hardware.logicalProcessors !== environment?.hardwareSnapshot?.logicalProcessors ||
    hardware.totalMemoryBytes !== environment?.hardwareSnapshot?.totalMemoryBytes
  ) {
    failures.push('report CPU or memory identity differs from environment evidence')
  }
  const controllers = (environment?.gpu?.devices || [])
    .map((device) => ({
      name: device.name,
      driverVersion: device.driverVersion,
      deviceId: device.deviceId,
      adapterCompatibility: device.adapterCompatibility,
    }))
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
  const reportControllers = hardware.controllers
    .map((controller) => ({
      name: controller.name,
      driverVersion: controller.driverVersion,
      deviceId: controller.deviceId,
      adapterCompatibility: controller.adapterCompatibility,
    }))
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
  if (!sameJsonValue(reportControllers, controllers)) {
    failures.push('report hardware display-controller identity differs from environment evidence')
  }
  const nvidia = (environment?.gpu?.nvidiaDevices || [])
    .map((device) => ({
      uuid: device.uuid,
      name: device.name,
      memoryTotalMiB: device.memoryTotalMiB,
      driverVersion: device.driverVersion,
      busId: device.busId,
    }))
    .sort((left, right) => stableValue(left).uuid.localeCompare(stableValue(right).uuid))
  const reportGpus = hardware.gpus
    .map((gpu) => ({
      uuid: gpu.uuid,
      name: gpu.name,
      memoryTotalMiB: gpu.memoryTotalMiB,
      driverVersion: gpu.driverVersion,
      busId: gpu.busId,
    }))
    .sort((left, right) => left.uuid.localeCompare(right.uuid))
  if (!sameJsonValue(reportGpus, nvidia)) {
    failures.push('report hardware GPU identity differs from environment evidence')
  }
}

function canonicalRoundArtifact(context, declaredPath, expectedName, label) {
  if (!context?.canonicalRoot || !context?.reportPath) {
    throw ledgerError('INVALID_BASELINE_REPORT', `${label} validation context is missing`)
  }
  if (
    typeof declaredPath !== 'string' ||
    !declaredPath ||
    path.isAbsolute(declaredPath) ||
    declaredPath.includes('\\') ||
    declaredPath.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw ledgerError('INVALID_BASELINE_REPORT', `${label} path is unsafe`)
  }
  const expected = path.join(path.dirname(context.reportPath), expectedName)
  const canonical = canonicalExistingFile(expected, label)
  if (
    !isPathInside(context.canonicalRoot, canonical, { allowEqual: false }) ||
    !samePath(path.dirname(canonical), path.dirname(context.reportPath))
  ) {
    throw ledgerError('BASELINE_ESCAPED_ROOT', `${label} must be a sibling of the accepted report`)
  }
  const relative = path.relative(context.canonicalRoot, canonical).split(path.sep).join('/')
  if (declaredPath !== relative) {
    throw ledgerError('INVALID_BASELINE_REPORT', `${label} declaration does not bind its file`)
  }
  return canonical
}

function directMlProviderFailures(value, model, label) {
  const failures = []
  if (
    value?.schemaVersion !== 1 ||
    value?.model !== model ||
    !Number.isInteger(value?.reports) ||
    value.reports < 1 ||
    value.reports > 1024 ||
    !sameJsonValue(value?.requestedBackends, ['gpu']) ||
    !sameJsonValue(value?.selectedProviders, ['dml']) ||
    value?.fallbackDetected !== false ||
    !Array.isArray(value?.reasons) ||
    value.reasons.length < 1 ||
    value.reasons.length > 16 ||
    value.reasons.some(
      (reason) => typeof reason !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(reason),
    )
  ) {
    failures.push(`${label} ${model.toUpperCase()} effective provider is not exclusively DirectML`)
  }
  return failures
}

function inspectBoundTimeline(filePath, runNonce, failures, label) {
  let captured
  try {
    captured = readStableFileBytes(filePath, {
      label,
      maxBytes: FORMAL_TIMELINE_MAX_BYTES,
    })
  } catch (error) {
    failures.push(`${label} could not be read safely: ${error.message}`)
    return null
  }
  const lines = captured.bytes.toString('utf8').split(/\r?\n/).filter(Boolean)
  if (lines.length < 1 || lines.length > FORMAL_TIMELINE_MAX_EVENTS) {
    failures.push(`${label} event count is outside the fixed bounds`)
    return null
  }
  const events = []
  for (const [index, line] of lines.entries()) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      failures.push(`${label} line ${index + 1} is not valid JSON`)
      return null
    }
    if (event?.schemaVersion !== 1 || event?.runNonce !== runNonce) {
      failures.push(`${label} event provenance differs from its round`)
      return null
    }
    events.push(event)
  }
  const terminal = events.at(-1)
  const truncated = terminal?.event === 'timeline-truncated'
  if (
    (truncated && terminal?.terminal !== true) ||
    (!truncated &&
      (terminal?.event !== 'benchmark-end' ||
        terminal?.stage !== 'complete' ||
        terminal?.ok !== true ||
        terminal?.pipeline !== FORMAL_PIPELINE ||
        terminal?.backend !== 'gpu' ||
        terminal?.tensorPrefetch !== false))
  ) {
    failures.push(`${label} terminal event is invalid`)
  }
  return {
    bytes: captured.bytes.length,
    sha256: captured.sha256,
    events: events.length,
    terminal,
    truncated,
  }
}

function validateBoundRoundArtifact(round, index, context, failures) {
  const label = `round ${index + 1}`
  let reportPath
  let timelinePath
  try {
    reportPath = canonicalRoundArtifact(
      context,
      round?.reportFile,
      `round-${index + 1}.json`,
      `${label} report`,
    )
    timelinePath = canonicalRoundArtifact(
      context,
      round?.timelineFile,
      `round-${index + 1}.timeline.ndjson`,
      `${label} timeline`,
    )
  } catch (error) {
    failures.push(error.message)
    return null
  }
  let captured
  try {
    captured = readStableJsonFile(reportPath, {
      label: `${label} report`,
      maxBytes: MAX_ACCEPTED_REPORT_BYTES,
    })
  } catch (error) {
    failures.push(`${label} report could not be read safely: ${error.message}`)
    return null
  }
  if (captured.sha256 !== round.reportSha256) {
    failures.push(`${label} report bytes do not match reportSha256`)
  }
  if (round?.reportBytes !== captured.bytes.length) {
    failures.push(`${label} reportBytes differs from the stable report file`)
  }
  const run = captured.value
  const expectedRoundConfig = {
    imageCount: FORMAL_SAMPLE,
    backend: 'gpu',
    pipeline: FORMAL_PIPELINE,
    jobs: 2,
    batchSize: 4,
    requestedScanWorkers: FORMAL_SCAN_WORKERS,
    tensorPrefetch: false,
    deferThumbnails: true,
    verifyWarm: true,
    stageMetrics: true,
    timelineMaxBytes: FORMAL_TIMELINE_MAX_BYTES,
    timelineMaxEvents: FORMAL_TIMELINE_MAX_EVENTS,
  }
  if (run?.schemaVersion !== 1 || run?.ok !== true) failures.push(`${label} report did not pass`)
  for (const [key, expected] of Object.entries(expectedRoundConfig)) {
    if (run?.config?.[key] !== expected) failures.push(`${label} report config differs: ${key}`)
  }
  if (
    !Number.isInteger(run?.config?.sourceImageCount) ||
    run.config.sourceImageCount < FORMAL_SAMPLE
  ) {
    failures.push(`${label} source image count is incomplete`)
  }
  if (
    run?.execution?.runNonce !== round.runNonce ||
    run?.execution?.tempDirectoryId !== round.tempDirectoryId ||
    run?.execution?.startedAt !== round.startedAt ||
    run?.execution?.finishedAt !== round.finishedAt
  ) {
    failures.push(`${label} execution identity or timestamps differ from its report`)
  }
  const bindings = [
    ['libraryReadyMs', run?.phases?.libraryReadyMs],
    ['totalMs', run?.phases?.totalMs],
    ['mainPeakRssMiB', run?.resources?.memory?.mainPeakRssMiB],
    ['childPeakAggregateRssMiBApprox', run?.resources?.memory?.childPeakAggregateRssMiBApprox],
    ['systemMinFreeMiB', run?.resources?.memory?.systemMinFreeMiB],
    ['nativeDigest', run?.scan?.digest?.sha256],
    ['dinoDigest', run?.embeddingDigests?.dino?.stableSha256],
    ['clipDigest', run?.embeddingDigests?.clip?.stableSha256],
  ]
  for (const [field, actual] of bindings) {
    if (round?.[field] !== actual) failures.push(`${label} ${field} differs from its report`)
  }
  const rawGpuPeakDelta = run?.resources?.gpu?.peakDeltaUsedMiB ?? null
  if (round?.gpuPeakDeltaUsedMiB !== rawGpuPeakDelta) {
    failures.push(`${label} gpuPeakDeltaUsedMiB differs from its report`)
  }
  if (
    run?.safety?.sourceDatasetReadOnly !== true ||
    run?.safety?.isolatedUserData !== true ||
    run?.safety?.sourceUnchanged !== true ||
    run?.safety?.noBenchmarkChildProcessesAtStop !== true ||
    run?.scan?.digest?.count !== FORMAL_SAMPLE ||
    run?.scan?.progress?.scanWorkerCount !== FORMAL_SCAN_WORKERS ||
    run?.vectorIndex?.status?.built !== true ||
    run?.vectorIndex?.status?.count !== FORMAL_SAMPLE ||
    run?.embeddingDigests?.dino?.count !== FORMAL_SAMPLE ||
    run?.embeddingDigests?.clip?.count !== FORMAL_SAMPLE ||
    run?.pipeline?.result?.commitFeedDropped !== 0 ||
    run?.warmVerification?.ok !== true ||
    run?.resources?.sampling?.errors !== 0 ||
    run?.resources?.sampling?.failureCode ||
    !Number.isInteger(run?.resources?.sampling?.samples) ||
    run.resources.sampling.samples < 1 ||
    !Number.isInteger(run?.resources?.sampling?.observedChildProcesses) ||
    run.resources.sampling.observedChildProcesses < 1 ||
    !Number.isInteger(run?.resources?.processes?.spawned) ||
    run.resources.processes.spawned < 1 ||
    !Number.isInteger(run?.resources?.processes?.observedChildProcesses) ||
    run.resources.processes.observedChildProcesses < 1 ||
    run.resources.processes.releasedChildProcesses !==
      run.resources.processes.observedChildProcesses ||
    run?.resources?.processes?.activeAtStop !== 0 ||
    run?.resources?.processes?.noResidualAtStop !== true ||
    run?.resources?.processes?.lifecycleAccounted !== true ||
    run?.resources?.processes?.errorEvents !== 0 ||
    run?.resources?.sampling?.observedChildEvidence?.lifecycleTracked !==
      run.resources.processes.observedChildProcesses ||
    run?.resources?.sampling?.observedChildEvidence?.samplerObserved !==
      run.resources.sampling.observedChildProcesses ||
    run?.resources?.sampling?.observedChildEvidence?.lifecycleAccounted !== true ||
    !Number.isFinite(run?.resources?.gpu?.deviceCount) ||
    run.resources.gpu.deviceCount < 1 ||
    !Number.isFinite(run?.resources?.gpu?.totalMiB) ||
    run.resources.gpu.totalMiB <= 0
  ) {
    failures.push(`${label} report safety, completeness, or lifecycle proof is invalid`)
  }
  for (const model of ['dino', 'clip']) {
    failures.push(...directMlProviderFailures(run?.providerEvidence?.[model], model, label))
  }
  if (!sameJsonValue(round?.effectiveProviders, run?.providerEvidence)) {
    failures.push(`${label} effective provider summary differs from its report`)
  }
  const timeline = inspectBoundTimeline(timelinePath, round.runNonce, failures, `${label} timeline`)
  if (
    timeline &&
    (round?.timelineSha256 !== timeline.sha256 ||
      round?.timelineBytes !== timeline.bytes ||
      !sameJsonValue(round?.timeline, timeline) ||
      run?.timeline?.bytesWritten !== timeline.bytes ||
      run?.timeline?.eventsWritten !== timeline.events ||
      run?.timeline?.truncated !== timeline.truncated)
  ) {
    failures.push(`${label} timeline summary differs from its file or report`)
  }
  const sandbox = round?.sandbox
  if (
    sandbox?.schemaVersion !== 1 ||
    !new RegExp(`^siftory-fixed-baseline-r${index + 1}-[A-Za-z0-9]{6}$`).test(
      sandbox?.rootId || '',
    ) ||
    sandbox?.environmentPolicy !== 'minimal-allowlist-v1' ||
    sandbox?.rootScope !== 'exclusive-os-temp' ||
    sandbox?.rootPathOmitted !== true ||
    sandbox?.networkModelFetchDisabled !== true ||
    sandbox?.nodeOptionsCleared !== true ||
    sandbox?.nodeInheritedOverridesDropped !== true ||
    sandbox?.nodeCompileCacheDisabled !== true ||
    sandbox?.systemFontsDisabled !== true ||
    sandbox?.performanceOverridesCleared !== true ||
    sandbox?.fixedHarnessOverrides?.scanWorkers !== FORMAL_SCAN_WORKERS ||
    sandbox?.fixedHarnessOverrides?.stageMetrics !== true ||
    sandbox?.fixedHarnessOverrides?.tensorPrefetch !== false ||
    sandbox?.effectiveEnvironment?.NODE_OPTIONS !== '' ||
    sandbox?.effectiveEnvironment?.NODE_PATH !== null ||
    sandbox?.effectiveEnvironment?.NODE_COMPILE_CACHE !== null ||
    sandbox?.effectiveEnvironment?.NODE_DISABLE_COMPILE_CACHE !== '1' ||
    sandbox?.effectiveEnvironment?.DISABLE_SYSTEM_FONTS_LOAD !== '1' ||
    sandbox?.effectiveEnvironment?.NODE_V8_COVERAGE !== null ||
    sandbox?.effectiveEnvironment?.NODE_DEBUG !== null ||
    sandbox?.effectiveEnvironment?.NODE_DEBUG_NATIVE !== null ||
    sandbox?.effectiveEnvironment?.NODE_REDIRECT_WARNINGS !== null ||
    sandbox?.effectiveEnvironment?.NODE_ICU_DATA !== null ||
    sandbox?.effectiveEnvironment?.NODE_EXTRA_CA_CERTS !== null
  ) {
    failures.push(`${label} sandbox proof is incomplete`)
  }
  try {
    const sharedProof = {
      ...round,
      startedAt: round?.parentStartedAt,
      finishedAt: round?.parentFinishedAt,
    }
    const previous = index > 0 ? context?.rounds?.[index - 1] : null
    const previousProof = previous
      ? {
          ...previous,
          startedAt: previous?.parentStartedAt,
          finishedAt: previous?.parentFinishedAt,
        }
      : null
    const sharedFailures = validateRound(
      run,
      sharedProof,
      expectedFormalConfig(),
      index,
      previousProof,
      'establish',
    )
    failures.push(...sharedFailures.map((failure) => `${label} shared validator: ${failure}`))
  } catch (error) {
    failures.push(`${label} shared formal validator failed: ${error.message}`)
  }
  return run
}

function validateRoundProofs(rounds, failures, context) {
  if (!Array.isArray(rounds) || rounds.length !== FORMAL_RUNS) {
    failures.push(`report must contain exactly ${FORMAL_RUNS} round proofs`)
    return null
  }

  const nonces = []
  const tempDirectoryIds = []
  const sandboxRootIds = []
  const reportDigests = []
  const digestGroups = { nativeDigest: [], dinoDigest: [], clipDigest: [] }
  const values = {
    libraryReadyMs: [],
    mainPeakRssMiB: [],
    childPeakAggregateRssMiBApprox: [],
    combinedPeakRssMiBApprox: [],
    systemMinFreeMiB: [],
  }
  for (const [index, round] of rounds.entries()) {
    const label = `round ${index + 1}`
    validateBoundRoundArtifact(round, index, { ...context, rounds }, failures)
    if (round?.round !== index + 1) failures.push(`${label} ordinal is invalid`)
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(round?.runNonce || '')) {
      failures.push(`${label} execution nonce is invalid`)
    }
    if (
      typeof round?.tempDirectoryId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{7,255}$/.test(round.tempDirectoryId)
    ) {
      failures.push(`${label} temporary directory identity is invalid`)
    }
    if (!/^[a-f0-9]{64}$/.test(round?.reportSha256 || '')) {
      failures.push(`${label} report SHA-256 is invalid`)
    }
    nonces.push(round?.runNonce)
    tempDirectoryIds.push(round?.tempDirectoryId)
    sandboxRootIds.push(round?.sandbox?.rootId)
    reportDigests.push(round?.reportSha256)

    const startedAt = Date.parse(round?.startedAt)
    const finishedAt = Date.parse(round?.finishedAt)
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || startedAt > finishedAt) {
      failures.push(`${label} timestamps are invalid`)
    }
    const parentStartedAt = Date.parse(round?.parentStartedAt)
    const parentFinishedAt = Date.parse(round?.parentFinishedAt)
    if (
      !Number.isFinite(parentStartedAt) ||
      !Number.isFinite(parentFinishedAt) ||
      parentStartedAt > parentFinishedAt ||
      (index > 0 && parentStartedAt < Date.parse(rounds[index - 1]?.parentFinishedAt))
    ) {
      failures.push(
        `${label} parent orchestration timestamps are missing, invalid, or nonconsecutive`,
      )
    }

    for (const field of Object.keys(values)) {
      const value = round?.[field]
      if (!Number.isFinite(value) || value <= 0) failures.push(`${label} ${field} is invalid`)
      else values[field].push(value)
    }
    if (
      Number.isFinite(round?.mainPeakRssMiB) &&
      Number.isFinite(round?.childPeakAggregateRssMiBApprox) &&
      round?.combinedPeakRssMiBApprox !==
        rounded(round.mainPeakRssMiB + round.childPeakAggregateRssMiBApprox)
    ) {
      failures.push(`${label} combined memory does not match main plus child memory`)
    }
    if (
      Number.isFinite(round?.libraryReadyMs) &&
      (!Number.isFinite(round?.totalMs) || round.totalMs < round.libraryReadyMs)
    ) {
      failures.push(`${label} total time is invalid`)
    }
    for (const field of Object.keys(digestGroups)) {
      const digest = round?.[field]
      if (!/^[a-f0-9]{64}$/.test(digest || '')) failures.push(`${label} ${field} is invalid`)
      digestGroups[field].push(digest)
    }
  }

  for (const [label, identities] of [
    ['execution nonce', nonces],
    ['temporary directory', tempDirectoryIds],
    ['outer sandbox directory', sandboxRootIds],
    ['round report SHA-256', reportDigests],
  ]) {
    if (new Set(identities).size !== FORMAL_RUNS) {
      failures.push(`${label} must be unique across all three rounds`)
    }
  }
  for (const [label, digests] of Object.entries(digestGroups)) {
    if (new Set(digests).size !== 1) failures.push(`${label} must match across all three rounds`)
  }
  if (Object.values(values).some((items) => items.length !== FORMAL_RUNS)) return null

  const metrics = {
    libraryReadyMs: summarizeValues(values.libraryReadyMs),
    mainPeakRssMiB: summarizeValues(values.mainPeakRssMiB),
    childPeakAggregateRssMiBApprox: summarizeValues(values.childPeakAggregateRssMiBApprox),
    combinedPeakRssMiBApprox: summarizeValues(values.combinedPeakRssMiBApprox),
    systemMinFreeMiB: summarizeValues(values.systemMinFreeMiB),
  }
  metrics.libraryReadyMs.spreadPercent = Number(
    (
      ((metrics.libraryReadyMs.max - metrics.libraryReadyMs.min) / metrics.libraryReadyMs.p50) *
      100
    ).toFixed(2),
  )
  return metrics
}

function controlLimitsForMetrics(metrics) {
  return {
    libraryReadyP95Ms: rounded(
      metrics.libraryReadyMs.p95 * (1 + TIME_REGRESSION_BUDGET_PERCENT / 100),
    ),
    mainPeakRssP95MiB: rounded(
      metrics.mainPeakRssMiB.p95 +
        Math.max(64, (metrics.mainPeakRssMiB.p95 * MEMORY_REGRESSION_BUDGET_PERCENT) / 100),
    ),
    childPeakAggregateRssP95MiB: rounded(
      metrics.childPeakAggregateRssMiBApprox.p95 +
        Math.max(
          128,
          (metrics.childPeakAggregateRssMiBApprox.p95 * MEMORY_REGRESSION_BUDGET_PERCENT) / 100,
        ),
    ),
    combinedPeakRssP95MiB: rounded(
      metrics.combinedPeakRssMiBApprox.p95 +
        Math.max(
          192,
          (metrics.combinedPeakRssMiBApprox.p95 * MEMORY_REGRESSION_BUDGET_PERCENT) / 100,
        ),
    ),
    systemMinFreeFloorMiB: rounded(
      Math.max(MIN_SYSTEM_FREE_MIB, metrics.systemMinFreeMiB.min * 0.75),
    ),
    readySpreadPercent: READY_SPREAD_BUDGET_PERCENT,
  }
}

function validatePromotionAgainstPrevious(report, metrics, previous, previousPath, failures) {
  if (report?.comparison?.status !== 'passed' || report?.comparison?.failures?.length !== 0) {
    failures.push('promotion comparison must have passed without failures')
  }
  if (!samePath(report?.comparison?.baseline || '', previousPath)) {
    failures.push('promotion comparison baseline must match the previous accepted report')
  }
  if (!sameJsonValue(report?.config, previous?.config)) {
    failures.push('promotion config must match the previous accepted report')
  }
  if (report?.hardware?.id !== previous?.hardware?.id) {
    failures.push('promotion hardware must match the previous accepted report')
  }
  if (report?.dataset?.identity !== previous?.dataset?.identity) {
    failures.push('promotion dataset must match the previous accepted report')
  }
  const previousLimits = previous?.controlLimits || {}
  for (const field of PROMOTION_UPPER_LIMIT_FIELDS) {
    if (Number(report?.controlLimits?.[field]) > Number(previousLimits[field])) {
      failures.push(`promotion cannot loosen upper control limit: ${field}`)
    }
  }
  if (
    Number(report?.controlLimits?.systemMinFreeFloorMiB) <
    Number(previousLimits.systemMinFreeFloorMiB)
  ) {
    failures.push('promotion cannot loosen lower control limit: systemMinFreeFloorMiB')
  }
  const comparisons = [
    ['libraryReadyP95Ms', metrics?.libraryReadyMs?.p95],
    ['mainPeakRssP95MiB', metrics?.mainPeakRssMiB?.p95],
    ['childPeakAggregateRssP95MiB', metrics?.childPeakAggregateRssMiBApprox?.p95],
    ['combinedPeakRssP95MiB', metrics?.combinedPeakRssMiBApprox?.p95],
    ['readySpreadPercent', metrics?.libraryReadyMs?.spreadPercent],
  ]
  for (const [field, value] of comparisons) {
    if (!Number.isFinite(value) || value > Number(previousLimits[field])) {
      failures.push(`promotion metric exceeds previous control limit: ${field}`)
    }
  }
  if (
    !Number.isFinite(metrics?.systemMinFreeMiB?.min) ||
    metrics.systemMinFreeMiB.min < Number(previousLimits.systemMinFreeFloorMiB)
  ) {
    failures.push('promotion metric is below previous control limit: systemMinFreeFloorMiB')
  }
}

function validatePromotionPreflights(report, promotion, failures) {
  if (!Array.isArray(report?.formalPreflights) || report.formalPreflights.length !== FORMAL_RUNS) {
    failures.push(`promotion must contain exactly ${FORMAL_RUNS} formal preflights`)
    return
  }
  for (const [index, entry] of report.formalPreflights.entries()) {
    const label = `promotion preflight ${index + 1}`
    const snapshot = entry?.snapshot
    const baseline = entry?.gpuBaseline
    const evaluation = entry?.evaluation
    const commitRatio =
      Number(snapshot?.memory?.committedBytes) / Number(snapshot?.memory?.commitLimitBytes)
    const observedGpuMiB = Number(snapshot?.gpu?.usedMiB)
    if (entry?.round !== index + 1) failures.push(`${label} ordinal is invalid`)
    if (
      baseline?.schema !== 'siftory-accepted-gpu-baseline/v1' ||
      baseline?.reportSha256 !== promotion?.previousReportSha256 ||
      baseline?.rounds !== FORMAL_RUNS ||
      !Number.isFinite(Number(baseline?.usedMiB))
    ) {
      failures.push(`${label} accepted GPU baseline proof is invalid`)
    }
    if (
      snapshot?.power?.onAc !== true ||
      Number(snapshot?.memory?.freePhysicalMemoryBytes) < 4 * GIB ||
      !Number.isFinite(commitRatio) ||
      commitRatio > 0.75 ||
      snapshot?.residualProductProcesses !== 0 ||
      Number(snapshot?.quietWindow?.durationMs) < FORMAL_QUIET_WINDOW_MS ||
      Number(snapshot?.quietWindow?.cpuP95Percent) > 20 ||
      Number(snapshot?.quietWindow?.diskP95Percent) > 20 ||
      Number(snapshot?.quietWindow?.gpuP95Percent) > 10 ||
      !Number.isFinite(observedGpuMiB) ||
      observedGpuMiB > Number(baseline?.usedMiB) + 256
    ) {
      failures.push(`${label} snapshot does not satisfy the formal environment gate`)
    }
    if (
      evaluation?.status !== 'passed' ||
      evaluation?.formal !== true ||
      !Array.isArray(evaluation?.failures) ||
      evaluation.failures.length !== 0 ||
      !Array.isArray(evaluation?.incomplete) ||
      evaluation.incomplete.length !== 0 ||
      evaluation?.controls?.quietWindowMs !== FORMAL_QUIET_WINDOW_MS ||
      Number(evaluation?.observed?.freePhysicalMemoryBytes) !==
        Number(snapshot?.memory?.freePhysicalMemoryBytes) ||
      Number(evaluation?.observed?.commitRatio) !== commitRatio ||
      Number(evaluation?.observed?.gpuInitialUsedMiB) !== observedGpuMiB ||
      Number(evaluation?.observed?.gpuBaselineUsedMiB) !== Number(baseline?.usedMiB)
    ) {
      failures.push(`${label} evaluation is missing, inconsistent, or not passing`)
    }
  }
}

function validateFormalAcceptedReport(report, context) {
  const failures = []
  if (report?.schemaVersion !== 1 || report?.kind !== ACCEPTED_REPORT_KIND) {
    failures.push('report must use the supported schema and kind')
  }
  if (report?.ok !== true || report?.status !== 'passed') {
    failures.push('report must have passed')
  }
  if (!['establish', 'promote'].includes(report?.mode)) {
    failures.push('report mode must be establish or promote')
  }
  if (!Array.isArray(report?.failures) || report.failures.length !== 0) {
    failures.push('report failures must be an empty array')
  }

  const config = report?.config
  validateFormalConfig(config, failures)

  validatePositiveControlLimits(report?.controlLimits, 'report controlLimits', failures)
  const evidence = report?.evidence
  if (evidence?.schemaVersion !== 1 || evidence?.kind !== ACCEPTED_EVIDENCE_KIND) {
    failures.push('report evidence must use the supported schema and kind')
  }
  if (!sameJsonValue(evidence?.config, config)) {
    failures.push('report and evidence config must be identical')
  }
  validatePositiveControlLimits(evidence?.controlLimits, 'evidence controlLimits', failures)
  if (!sameJsonValue(evidence?.controlLimits, report?.controlLimits)) {
    failures.push('report and evidence controlLimits must be identical')
  }
  validateDeepEvidence(evidence, failures)
  validateHardwareBinding(report?.hardware, evidence?.environment, failures)

  if (
    report?.dataset?.identity !== evidence?.dataset?.identity ||
    report?.dataset?.contentManifestSha256 !== evidence?.dataset?.identity ||
    report?.dataset?.selectedImageCount !== evidence?.dataset?.selectedImageCount ||
    report?.dataset?.selectedImageCount !== config?.sample
  ) {
    failures.push('report dataset fields must be bound to the validated evidence and config')
  }
  if (report?.software?.after?.identity !== evidence?.implementation?.identity) {
    failures.push('report software revision must be bound to the validated evidence')
  }

  const expectedMetrics = validateRoundProofs(report?.rounds, failures, context)
  if (expectedMetrics && !sameJsonValue(report?.metrics, expectedMetrics)) {
    failures.push('report metrics must be derived from the three round proofs')
  }
  if (
    expectedMetrics &&
    !sameJsonValue(report?.controlLimits, controlLimitsForMetrics(expectedMetrics))
  ) {
    failures.push('report controlLimits must be derived from the bound round metrics')
  }

  if (report?.dataset?.unchanged !== true) {
    failures.push('dataset must be proven unchanged')
  }
  if (report?.safety?.realLibraryWritten !== false) {
    failures.push('real user library must not be written')
  }
  if (report?.safety?.noBenchmarkChildrenAtEnd !== true) {
    failures.push('benchmark child processes must be stopped')
  }

  const userDataProof = report?.safety?.realUserDataProof
  if (
    userDataProof?.ok !== true ||
    userDataProof?.changed !== false ||
    userDataProof?.fail !== false ||
    !/^[a-f0-9]{64}$/.test(userDataProof?.beforeIdentity || '') ||
    userDataProof.beforeIdentity !== userDataProof.afterIdentity
  ) {
    failures.push('real user-data proof must be complete and unchanged')
  }

  if (report?.mode === 'promote') {
    const depth = Number(context?.promotionDepth) || 0
    if (depth >= 32) {
      failures.push('promotion history exceeds the maximum depth')
    } else {
      const promotion = report?.promotion
      if (
        promotion?.schemaVersion !== 1 ||
        typeof promotion.previousReportFile !== 'string' ||
        promotion.previousReportFile.trim() === '' ||
        path.isAbsolute(promotion.previousReportFile) ||
        !/^[a-f0-9]{64}$/.test(promotion.previousReportSha256 || '') ||
        !Number.isFinite(Date.parse(promotion.previousAcceptedAt))
      ) {
        failures.push('promotion provenance is missing or invalid')
      } else {
        validatePromotionPreflights(report, promotion, failures)
        const previousCandidate = path.resolve(context.canonicalRoot, promotion.previousReportFile)
        if (
          !isPathInside(context.canonicalRoot, previousCandidate, { allowEqual: false }) ||
          samePath(previousCandidate, context.reportPath)
        ) {
          failures.push('promotion previous report escaped the managed root or formed a cycle')
        } else {
          try {
            const previous = readAcceptedReport(context.canonicalRoot, previousCandidate, {
              expectedSha256: promotion.previousReportSha256,
              promotionDepth: depth + 1,
            })
            validatePromotionAgainstPrevious(
              report,
              expectedMetrics,
              previous.report,
              previous.reportPath,
              failures,
            )
          } catch (error) {
            failures.push(`promotion previous report is invalid: ${error.message}`)
          }
        }
      }
    }
  }

  if (failures.length > 0) {
    throw ledgerError(
      'INVALID_BASELINE_REPORT',
      `Accepted baseline report is not a formal passing establish/promote report: ${failures.join('; ')}`,
    )
  }
  return report
}

function readAcceptedReport(canonicalRoot, reportPath, options = {}) {
  const canonicalReport = canonicalExistingFile(reportPath, 'accepted baseline report')
  if (!isPathInside(canonicalRoot, canonicalReport, { allowEqual: false })) {
    throw ledgerError(
      'BASELINE_ESCAPED_ROOT',
      'Accepted baseline report must remain inside the managed root',
    )
  }
  const contents = readStableJsonFile(canonicalReport, {
    label: 'accepted baseline report',
    maxBytes: MAX_ACCEPTED_REPORT_BYTES,
  })
  if (options.expectedSha256 && contents.sha256 !== options.expectedSha256) {
    throw ledgerError(
      'ACCEPTED_REPORT_HASH_MISMATCH',
      'Accepted baseline report bytes do not match the committed pointer digest',
    )
  }
  const report = contents.value
  validateFormalAcceptedReport(report, {
    canonicalRoot,
    reportPath: canonicalReport,
    promotionDepth: options.promotionDepth || 0,
  })
  return { reportPath: canonicalReport, report, reportSha256: contents.sha256 }
}

function readAcceptedPointer(canonicalRoot, pointerPath) {
  const canonicalPointer = canonicalExistingFile(pointerPath, 'accepted baseline pointer')
  if (!samePath(canonicalPointer, pointerPath)) {
    throw ledgerError(
      'INVALID_ACCEPTED_POINTER',
      'Accepted baseline pointer must not traverse a link',
    )
  }
  const pointer = readStableJsonFile(canonicalPointer, {
    label: 'accepted baseline pointer',
    maxBytes: MAX_ACCEPTED_POINTER_BYTES,
  }).value
  if (
    pointer?.schemaVersion !== 1 ||
    pointer?.kind !== ACCEPTED_POINTER_KIND ||
    typeof pointer.reportFile !== 'string' ||
    pointer.reportFile.trim() === '' ||
    path.isAbsolute(pointer.reportFile) ||
    !/^[a-f0-9]{64}$/.test(pointer.reportSha256 || '')
  ) {
    throw ledgerError('INVALID_ACCEPTED_POINTER', 'Accepted baseline pointer schema is invalid')
  }
  const reportCandidate = path.resolve(canonicalRoot, pointer.reportFile)
  const accepted = readAcceptedReport(canonicalRoot, reportCandidate, {
    expectedSha256: pointer.reportSha256,
  })
  if (accepted.report.mode === 'promote') {
    const previous = pointer.previous
    if (
      !Number.isInteger(pointer.sequence) ||
      pointer.sequence < 2 ||
      !Number.isFinite(Date.parse(previous?.acceptedAt)) ||
      typeof previous?.reportFile !== 'string' ||
      path.isAbsolute(previous.reportFile) ||
      !/^[a-f0-9]{64}$/.test(previous?.reportSha256 || '') ||
      previous.acceptedAt !== accepted.report.promotion?.previousAcceptedAt ||
      previous.reportFile !== accepted.report.promotion?.previousReportFile ||
      previous.reportSha256 !== accepted.report.promotion?.previousReportSha256
    ) {
      throw ledgerError(
        'INVALID_ACCEPTED_POINTER',
        'Promoted pointer does not bind the previous accepted report chain',
      )
    }
  } else if (pointer.sequence !== undefined || pointer.previous !== undefined) {
    throw ledgerError(
      'INVALID_ACCEPTED_POINTER',
      'Initial accepted pointer cannot contain promotion history',
    )
  }
  return { pointer, pointerPath: canonicalPointer, ...accepted }
}

function resolveAcceptedBaseline({ managedRoot, mode }) {
  validateMode(mode)
  const canonicalRoot = canonicalExistingDirectory(managedRoot, 'managed root')
  const pointerPath = pointerPathForRoot(canonicalRoot)
  if (mode === 'establish') {
    if (pathEntryExists(pointerPath)) {
      throw ledgerError(
        'ACCEPTED_POINTER_EXISTS',
        `Accepted baseline already exists: ${pointerPath}`,
      )
    }
    return {
      mode,
      managedRoot: canonicalRoot,
      pointerPath,
      pointer: null,
      reportPath: null,
      report: null,
    }
  }
  if (!pathEntryExists(pointerPath)) {
    throw ledgerError(
      'ACCEPTED_BASELINE_REQUIRED',
      `Compare mode requires an accepted baseline: ${pointerPath}`,
    )
  }
  return { mode, managedRoot: canonicalRoot, ...readAcceptedPointer(canonicalRoot, pointerPath) }
}

function commitAcceptedBaseline({ managedRoot, mode, reportPath, now }) {
  validateMode(mode)
  if (mode !== 'establish') {
    throw ledgerError(
      'COMPARE_IS_READ_ONLY',
      'Compare mode cannot create or update the accepted baseline pointer',
    )
  }
  const canonicalRoot = canonicalExistingDirectory(managedRoot, 'managed root')
  const pointerPath = pointerPathForRoot(canonicalRoot)
  if (pathEntryExists(pointerPath)) {
    throw ledgerError('ACCEPTED_POINTER_EXISTS', `Accepted baseline already exists: ${pointerPath}`)
  }
  const accepted = readAcceptedReport(canonicalRoot, reportPath)
  const acceptedAt = (now instanceof Date ? now : new Date(now || Date.now())).toISOString()
  const pointer = {
    schemaVersion: 1,
    kind: ACCEPTED_POINTER_KIND,
    acceptedAt,
    reportFile: path.relative(canonicalRoot, accepted.reportPath).split(path.sep).join('/'),
    reportSha256: accepted.reportSha256,
  }
  let descriptor
  try {
    descriptor = fs.openSync(pointerPath, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw ledgerError(
        'ACCEPTED_POINTER_EXISTS',
        `Accepted baseline already exists: ${pointerPath}`,
        error,
      )
    }
    throw ledgerError(
      'ACCEPTED_POINTER_WRITE_FAILED',
      `Unable to create accepted pointer: ${pointerPath}`,
      error,
    )
  }
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
  } catch (error) {
    try {
      fs.closeSync(descriptor)
    } catch {
      // Preserve the pointer write failure.
    }
    try {
      fs.unlinkSync(pointerPath)
    } catch {
      // A partial pointer remains fail-closed if cleanup is unavailable.
    }
    throw ledgerError(
      'ACCEPTED_POINTER_WRITE_FAILED',
      `Unable to write accepted pointer: ${pointerPath}`,
      error,
    )
  }
  fs.closeSync(descriptor)
  return { mode, managedRoot: canonicalRoot, pointerPath, pointer, ...accepted }
}

function commitPromotedBaseline({ managedRoot, reportPath, expectedPreviousReportSha256, now }) {
  const canonicalRoot = canonicalExistingDirectory(managedRoot, 'managed root')
  const pointerPath = pointerPathForRoot(canonicalRoot)
  if (!pathEntryExists(pointerPath)) {
    throw ledgerError('ACCEPTED_BASELINE_REQUIRED', 'Promotion requires an accepted baseline')
  }
  const previous = readAcceptedPointer(canonicalRoot, pointerPath)
  if (
    !/^[a-f0-9]{64}$/.test(expectedPreviousReportSha256 || '') ||
    previous.reportSha256 !== expectedPreviousReportSha256
  ) {
    throw ledgerError(
      'PROMOTION_BASELINE_CHANGED',
      'Accepted baseline changed after the promotion candidate was measured',
    )
  }
  const candidate = readAcceptedReport(canonicalRoot, reportPath)
  if (candidate.report.mode !== 'promote') {
    throw ledgerError('INVALID_PROMOTION_REPORT', 'Promotion requires a formal promote report')
  }
  const promotion = candidate.report.promotion
  if (
    promotion.previousReportSha256 !== previous.reportSha256 ||
    promotion.previousReportFile !== previous.pointer.reportFile ||
    promotion.previousAcceptedAt !== previous.pointer.acceptedAt
  ) {
    throw ledgerError(
      'PROMOTION_BASELINE_CHANGED',
      'Promotion provenance does not match the currently accepted pointer',
    )
  }
  const acceptedAt = (now instanceof Date ? now : new Date(now || Date.now())).toISOString()
  const pointer = {
    schemaVersion: 1,
    kind: ACCEPTED_POINTER_KIND,
    sequence: Number(previous.pointer.sequence || 1) + 1,
    acceptedAt,
    reportFile: path.relative(canonicalRoot, candidate.reportPath).split(path.sep).join('/'),
    reportSha256: candidate.reportSha256,
    previous: {
      acceptedAt: previous.pointer.acceptedAt,
      reportFile: previous.pointer.reportFile,
      reportSha256: previous.reportSha256,
    },
  }
  const temporaryPath = path.join(
    canonicalRoot,
    `.${ACCEPTED_POINTER_FILE_NAME}.${process.pid}.${crypto.randomUUID()}.partial`,
  )
  let descriptor
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporaryPath, pointerPath)
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Preserve the original promotion error.
      }
    }
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
      // The partial file remains outside the accepted pointer name and is never resolved.
    }
    throw ledgerError(
      'ACCEPTED_POINTER_WRITE_FAILED',
      `Unable to atomically promote accepted pointer: ${pointerPath}`,
      error,
    )
  }
  return {
    mode: 'promote',
    managedRoot: canonicalRoot,
    pointerPath,
    pointer,
    previous,
    ...candidate,
  }
}

module.exports = {
  ACCEPTED_POINTER_FILE_NAME,
  ACCEPTED_POINTER_KIND,
  ACCEPTED_REPORT_KIND,
  ACCEPTED_EVIDENCE_KIND,
  LOCK_FILE_NAME,
  MAX_ACCEPTED_POINTER_BYTES,
  MAX_ACCEPTED_REPORT_BYTES,
  REQUIRED_CONTROL_LIMIT_FIELDS,
  acquireLedgerLock,
  acquireManagedRunWorkspace,
  canonicalPathForCreate,
  commitAcceptedBaseline,
  commitPromotedBaseline,
  isPathInside,
  readStableJsonFile,
  resolveAcceptedBaseline,
  validateManagedRunPaths,
  withManagedRunWorkspace,
}
