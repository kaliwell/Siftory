#!/usr/bin/env node

const FORBIDDEN_ORCHESTRATOR_NODE_ENVIRONMENT_KEYS = Object.freeze([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_COMPILE_CACHE',
  'NODE_V8_COVERAGE',
  'NODE_DEBUG',
  'NODE_DEBUG_NATIVE',
  'NODE_REDIRECT_WARNINGS',
  'NODE_ICU_DATA',
  'NODE_EXTRA_CA_CERTS',
])

function validateOrchestratorStartupEnvironment(options = {}) {
  const environment = options.environment ?? process.env
  const execArgv = options.execArgv ?? process.execArgv
  if (!environment || typeof environment !== 'object') {
    throw new Error('Fixed-hardware baseline requires an inspectable startup environment')
  }
  const forbiddenByLowerCase = new Map(
    FORBIDDEN_ORCHESTRATOR_NODE_ENVIRONMENT_KEYS.map((key) => [key.toLowerCase(), key]),
  )
  const inheritedControls = new Set()
  for (const [key, value] of Object.entries(environment)) {
    const canonicalKey = forbiddenByLowerCase.get(String(key).toLowerCase())
    if (canonicalKey && value !== undefined && value !== null && String(value).length > 0) {
      inheritedControls.add(canonicalKey)
    }
  }
  if (inheritedControls.size > 0) {
    throw new Error(
      'Fixed-hardware baseline refuses inherited Node startup controls: ' +
        [...inheritedControls].sort().join(', '),
    )
  }
  if (!Array.isArray(execArgv) || execArgv.length > 0) {
    throw new Error('Fixed-hardware baseline requires an empty process.execArgv')
  }
  return true
}

// Run this before loading even the local harness modules. Node preloads have already run at this
// point, so a contaminated process cannot be made trustworthy; it may only fail closed.
if (require.main === module) {
  validateOrchestratorStartupEnvironment()
}

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const {
  ACCEPTED_POINTER_FILE_NAME,
  LOCK_FILE_NAME,
  acquireManagedRunWorkspace,
  canonicalPathForCreate,
  commitAcceptedBaseline,
  commitPromotedBaseline,
  isPathInside,
  resolveAcceptedBaseline,
} = require('./fixed-hardware-baseline-ledger.cjs')
const {
  collectRuntimeMemoryPreflight,
  evaluateRuntimeMemoryPreflight,
  resolveAcceptedGpuBaseline,
} = require('./runtime-memory-preflight.cjs')
const {
  buildEvidence,
  compareEvidence,
  parseNvidiaSmiDevices,
  parseWmicVideoControllers,
  validateControlLimits,
  verifyDatasetManifest,
} = require('./fixed-hardware-baseline-evidence.cjs')
const {
  compareCompactUserDataSnapshots,
  validateCompactUserDataSnapshot,
} = require('./fixed-hardware-user-data-proof.cjs')
const {
  createFixedWindowsSystemEnvironment,
  resolveFixedHardwareSystemTools,
} = require('./fixed-hardware-system-tools.cjs')
const {
  FIXED_SCAN_WORKERS,
  TIMELINE_MAX_BYTES,
  TIMELINE_MAX_EVENTS,
  TIMESTAMP_TOLERANCE_MS,
  positiveFinite,
  validateRound,
} = require('./fixed-hardware-round-validator.cjs')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const BASELINE_ROOT = path.join(
  PROJECT_ROOT,
  'artifacts',
  'benchmark',
  'fixed-hardware-first-build',
)
const DEFAULT_DATASET = process.env.SOURCE_AUDIT_DIR || '<SOURCE_AUDIT_DIR>'
const REQUIRED_RUNS = 3
const DEFAULT_SAMPLE = 1000
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const READY_SPREAD_BUDGET_PERCENT = 15
const TIME_REGRESSION_BUDGET_PERCENT = 10
const MEMORY_REGRESSION_BUDGET_PERCENT = 15
const MIN_SYSTEM_FREE_MIB = 256
const MAX_CAPTURE_BYTES = 128 * 1024
const MAX_REPORT_BYTES = 32 * 1024 * 1024
const USER_DATA_PROOF_TIMEOUT_MS = 10 * 60 * 1000
const MAX_USER_DATA_PROOF_OUTPUT_BYTES = 128 * 1024
const ROUND_SANDBOX_PREFIX = 'siftory-fixed-baseline-'
const MAX_WINDOWS_SANDBOX_ROOT_CHARS = 100
const PROCESS_TREE_CONFIRM_TIMEOUT_MS = 10_000
const PROCESS_TREE_POLL_INTERVAL_MS = 100
const MAX_PROCESS_TABLE_ROWS = 131_072
const MAX_PROCESS_TABLE_BYTES = 16 * 1024 * 1024
const LIFECYCLE_BARRIER_MAX_BYTES = 4 * 1024
const LIFECYCLE_READY_TIMEOUT_MS = 30 * 60 * 1000
const MANAGED_ROOT_RESERVED_PREFIXES = Object.freeze([
  ACCEPTED_POINTER_FILE_NAME.toLowerCase(),
  '.fixed-hardware-baseline',
])
const PERFORMANCE_OVERRIDE_PATTERNS = Object.freeze([
  /^(?:REASONIX_(?:NATIVE|EMBEDDING)_|IMAGESEARCH_VERBOSE_|FLOATING_CLOCK_NATIVE_)/i,
  /^FLOATING_CLOCK_(?:DISABLE_VECTOR_ANN|CUDA_)/i,
  /^(?:VIPS_|ORT_|ONNX_|ONNXRUNTIME_)/i,
  /^(?:OPENBLAS_|GOTO_|BLIS_|MKL_|OMP_|KMP_|VECLIB_|NUMEXPR_|TBB_)/i,
  /^(?:CUDA_|CUDNN_|CUBLAS_|CUPTI_)/i,
  /^NVIDIA_TF32_OVERRIDE$/i,
  /^NAPI_RS_(?:NATIVE_LIBRARY_PATH|FORCE_WASI)$/i,
])
const ACTIVE_CHILDREN = new Set()
const ACTIVE_CHILD_SANDBOXES = new Map()
const ACTIVE_PROCESS_TRACKERS = new Map()
const ACTIVE_TERMINATORS = new Map()
const ACTIVE_SANDBOXES = new Map()
const BLOCKED_SANDBOXES = new Set()
const QUARANTINED_SANDBOXES = new Set()
const FIXED_SYSTEM_TOOLS = process.platform === 'win32' ? resolveFixedHardwareSystemTools() : null
const FIXED_WINDOWS_ENVIRONMENT = FIXED_SYSTEM_TOOLS
  ? createFixedWindowsSystemEnvironment({
      systemRoot: FIXED_SYSTEM_TOOLS.systemRoot,
      comSpec: FIXED_SYSTEM_TOOLS.comSpec,
    })
  : null

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function optionValue(argv, name) {
  const prefix = '--' + name + '='
  const matches = argv.filter((value) => value.startsWith(prefix))
  if (matches.length > 1) throw new Error('--' + name + ' may be specified only once')
  return matches.length ? matches[0].slice(prefix.length) : undefined
}

function finiteNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(label + ' must be a finite number')
  return number
}

function parseArgs(argv, dependencies = {}) {
  const projectRoot = path.resolve(dependencies.projectRoot || PROJECT_ROOT)
  const baselineRoot = path.resolve(
    dependencies.baselineRoot ||
      path.join(projectRoot, 'artifacts', 'benchmark', 'fixed-hardware-first-build'),
  )
  const knownFlags = new Set(['--plan', '--establish', '--promote', '--diagnostic', '--help', '-h'])
  const knownOptions = new Set([
    'dataset',
    'output-dir',
    'sample',
    'backend',
    'jobs',
    'batch-size',
    'timeout-ms',
  ])
  for (const argument of argv) {
    if (knownFlags.has(argument)) continue
    const match = argument.match(/^--([^=]+)=/)
    if (!match || !knownOptions.has(match[1])) {
      throw new Error('Unknown fixed-hardware baseline argument: ' + argument)
    }
  }
  const sample = Math.trunc(finiteNumber(optionValue(argv, 'sample') || DEFAULT_SAMPLE, '--sample'))
  const jobs = Math.trunc(finiteNumber(optionValue(argv, 'jobs') || 2, '--jobs'))
  const batchSize = Math.trunc(finiteNumber(optionValue(argv, 'batch-size') || 4, '--batch-size'))
  const timeoutMs = Math.trunc(
    finiteNumber(optionValue(argv, 'timeout-ms') || DEFAULT_TIMEOUT_MS, '--timeout-ms'),
  )
  if (sample < 4 || sample > 1000) throw new Error('--sample must be between 4 and 1000')
  if (jobs < 1 || jobs > 2) throw new Error('--jobs must be 1 or 2')
  if (batchSize < 1 || batchSize > 16) throw new Error('--batch-size must be between 1 and 16')
  if (timeoutMs < 60_000) throw new Error('--timeout-ms must be at least 60000')
  const backend = optionValue(argv, 'backend') || 'gpu'
  if (!['cpu', 'gpu'].includes(backend)) throw new Error('--backend must be cpu or gpu')
  const establish = argv.includes('--establish')
  const promote = argv.includes('--promote')
  const diagnostic = argv.includes('--diagnostic')
  if ([establish, promote, diagnostic].filter(Boolean).length > 1) {
    throw new Error('--establish, --promote, and --diagnostic are mutually exclusive')
  }
  if (!diagnostic && sample !== DEFAULT_SAMPLE) {
    throw new Error(
      'Formal establish/compare runs require --sample=1000 (including promote); use --diagnostic for smaller samples',
    )
  }
  if (!diagnostic && (backend !== 'gpu' || jobs !== 2 || batchSize !== 4)) {
    throw new Error(
      'Formal establish/compare runs require --backend=gpu --jobs=2 --batch-size=4 (including promote); ' +
        'use --diagnostic for configuration experiments',
    )
  }
  const outputValue = optionValue(argv, 'output-dir')
  const outputDirectory = outputValue
    ? path.resolve(projectRoot, outputValue)
    : path.join(baselineRoot, timestampId(dependencies.now || new Date()))
  if (!isPathInside(baselineRoot, outputDirectory, { allowEqual: false })) {
    throw new Error('--output-dir must be a child of ' + baselineRoot)
  }
  const relativeOutput = path.relative(baselineRoot, outputDirectory)
  const topLevelOutputName = relativeOutput
    .split(path.sep)[0]
    .replace(/[. ]+$/g, '')
    .toLowerCase()
  if (
    topLevelOutputName === LOCK_FILE_NAME.toLowerCase() ||
    MANAGED_ROOT_RESERVED_PREFIXES.some((prefix) => topLevelOutputName.startsWith(prefix))
  ) {
    throw new Error('--output-dir conflicts with a managed baseline internal name')
  }
  return {
    projectRoot,
    baselineRoot,
    dataset: path.resolve(projectRoot, optionValue(argv, 'dataset') || DEFAULT_DATASET),
    outputDirectory,
    sample,
    runs: REQUIRED_RUNS,
    backend,
    jobs,
    batchSize,
    timeoutMs,
    establish,
    promote,
    diagnostic,
    mode: diagnostic ? 'diagnostic' : establish ? 'establish' : promote ? 'promote' : 'compare',
    plan: argv.includes('--plan'),
    help: argv.includes('--help') || argv.includes('-h'),
  }
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function fingerprint(value) {
  return sha256(JSON.stringify(stableValue(value)))
}

function queryNvidiaGpus() {
  if (!FIXED_SYSTEM_TOOLS) return []
  const result = spawnSync(
    FIXED_SYSTEM_TOOLS.nvidiaSmi,
    [
      '--query-gpu=name,driver_version,uuid,pci.bus_id,memory.total',
      '--format=csv,noheader,nounits',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      shell: false,
      env: FIXED_WINDOWS_ENVIRONMENT,
    },
  )
  if (result.status !== 0) return []
  return parseNvidiaSmiDevices(result.stdout).sort((left, right) =>
    String(left.uuid).localeCompare(String(right.uuid)),
  )
}

function queryDisplayControllers() {
  if (!FIXED_SYSTEM_TOOLS) return []
  const result = spawnSync(
    FIXED_SYSTEM_TOOLS.wmic,
    [
      'path',
      'Win32_VideoController',
      'get',
      'Name,DriverVersion,PNPDeviceID,AdapterCompatibility',
      '/format:list',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      shell: false,
      env: FIXED_WINDOWS_ENVIRONMENT,
    },
  )
  if (result.status !== 0) return []
  return parseWmicVideoControllers(result.stdout).sort((left, right) =>
    String(left.deviceId).localeCompare(String(right.deviceId)),
  )
}

function collectHardware() {
  const cpus = os.cpus()
  const hardware = {
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    cpuModel: cpus[0]?.model || 'unknown',
    logicalProcessors: cpus.length,
    totalMemoryBytes: os.totalmem(),
    controllers: queryDisplayControllers(),
    gpus: queryNvidiaGpus(),
  }
  return { ...hardware, id: fingerprint(hardware) }
}

async function runPromotionPreflight(options, dependencies = {}) {
  const resolveGpuBaseline = dependencies.resolveAcceptedGpuBaseline || resolveAcceptedGpuBaseline
  const collect = dependencies.collectRuntimeMemoryPreflight || collectRuntimeMemoryPreflight
  const evaluate = dependencies.evaluateRuntimeMemoryPreflight || evaluateRuntimeMemoryPreflight
  const gpuBaseline = resolveGpuBaseline({ projectRoot: options.projectRoot })
  const snapshot = await collect({ cwd: options.projectRoot })
  const evaluation = evaluate(snapshot, {
    formal: true,
    gpuBaselineUsedMiB: gpuBaseline.usedMiB,
  })
  return { snapshot, gpuBaseline, evaluation }
}

function requiresAcceptedBaselinePreflight(mode) {
  return mode === 'compare' || mode === 'promote'
}

async function runAcceptedBaselineAdmissionPreflight(options, dependencies = {}) {
  const resolveGpuBaseline = dependencies.resolveAcceptedGpuBaseline || resolveAcceptedGpuBaseline
  const collect = dependencies.collectRuntimeMemoryPreflight || collectRuntimeMemoryPreflight
  const evaluate = dependencies.evaluateRuntimeMemoryPreflight || evaluateRuntimeMemoryPreflight
  const gpuBaseline = resolveGpuBaseline({ projectRoot: options.projectRoot })
  const snapshot = await collect({
    cwd: options.projectRoot,
    durationMs: 0,
    intervalMs: 1_000,
  })
  const evaluation = evaluate(snapshot, {
    formal: false,
    gpuBaselineUsedMiB: gpuBaseline.usedMiB,
  })
  return { snapshot, gpuBaseline, evaluation }
}

function preflightIssues(preflight) {
  return [
    ...(preflight.evaluation.failures || []),
    ...(preflight.evaluation.incomplete || []),
  ].join('; ')
}

function walkRelevantFiles(root, relativeDirectory, output) {
  const directory = path.join(root, relativeDirectory)
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) {
      if (
        !['node_modules', 'artifacts', 'dist', 'dist-electron', 'release', '.git'].includes(
          entry.name,
        )
      ) {
        walkRelevantFiles(root, relativePath, output)
      }
      continue
    }
    if (!entry.isFile()) continue
    if (/\.(?:ts|tsx|js|cjs|mjs|cc|cpp|c|h|hpp|gyp|json|ps1)$/i.test(entry.name)) {
      output.push(relativePath)
    }
  }
}

function collectSoftwareFingerprint(projectRoot) {
  const files = []
  for (const directory of ['electron', 'native', 'scripts', 'shared', 'src', 'tests']) {
    walkRelevantFiles(projectRoot, directory, files)
  }
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.mjs']) {
    if (fs.existsSync(path.join(projectRoot, file))) files.push(file)
  }
  files.sort((left, right) => left.localeCompare(right))
  const hash = crypto.createHash('sha256')
  for (const file of files) {
    hash.update(file.split(path.sep).join('/'))
    hash.update('\0')
    hash.update(fs.readFileSync(path.join(projectRoot, file)))
    hash.update('\0')
  }
  return { algorithm: 'sha256', digest: hash.digest('hex'), fileCount: files.length }
}

function getGitMetadata(projectRoot) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  const dirty = spawnSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    head: String(head.stdout || '').trim() || 'unknown',
    dirty: Boolean(String(dirty.stdout || '').trim()),
  }
}

function realUserDataRoots(environment = process.env) {
  const roots = []
  const add = (base, name) => {
    if (typeof base === 'string' && base.trim()) roots.push(path.resolve(base, name))
  }
  for (const name of ['floating-clock-electron', 'Siftory', 'siftory-desktop']) {
    add(environment.APPDATA, name)
    add(environment.LOCALAPPDATA, name)
  }
  if (roots.length === 0) throw new Error('APPDATA or LOCALAPPDATA is required for user-data proof')
  return [...new Set(roots.map((root) => root.toLowerCase()))].map((normalized) =>
    roots.find((root) => root.toLowerCase() === normalized),
  )
}

function snapshotUserDataRootsIsolated(rootPaths, projectRoot) {
  const worker = path.join(projectRoot, 'scripts', 'fixed-hardware-user-data-proof-worker.cjs')
  const result = spawnSync(process.execPath, [worker, JSON.stringify(rootPaths)], {
    cwd: projectRoot,
    env: createControlledNodeSpawnEnvironment(process.env),
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: USER_DATA_PROOF_TIMEOUT_MS,
    maxBuffer: MAX_USER_DATA_PROOF_OUTPUT_BYTES,
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      'Isolated user-data proof failed: ' +
        (result.error?.message ||
          String(result.stderr || '').slice(-8_000) ||
          String(result.status ?? result.signal)),
    )
  }
  if (Buffer.byteLength(result.stdout || '', 'utf8') > MAX_USER_DATA_PROOF_OUTPUT_BYTES) {
    throw new Error('Isolated user-data proof exceeded its output limit')
  }
  const snapshot = JSON.parse(result.stdout)
  validateCompactUserDataSnapshot(snapshot)
  return snapshot
}

function appendBounded(current, chunk) {
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  const combined = current.length ? Buffer.concat([current, next]) : Buffer.from(next)
  return combined.length > MAX_CAPTURE_BYTES
    ? combined.subarray(combined.length - MAX_CAPTURE_BYTES)
    : combined
}

function writeBoundedLog(filePath, captured, truncated) {
  const prefix = truncated
    ? Buffer.from('[truncated: retained the final ' + MAX_CAPTURE_BYTES + ' bytes]\n')
    : Buffer.alloc(0)
  fs.writeFileSync(filePath, Buffer.concat([prefix, captured]), { flag: 'wx' })
}

function boundedProcessTreeTimeout(value, fallback = PROCESS_TREE_CONFIRM_TIMEOUT_MS) {
  const numeric = Number(value)
  return Math.max(
    0,
    Math.min(PROCESS_TREE_CONFIRM_TIMEOUT_MS, Number.isFinite(numeric) ? numeric : fallback),
  )
}

function normalizeProcessRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_PROCESS_TABLE_ROWS) {
    throw new Error('Process table exceeded its bounded row count')
  }
  const normalized = []
  const seen = new Set()
  for (const row of rows) {
    const pid = Number(row?.pid)
    const parentPid = Number(row?.parentPid)
    if (!Number.isInteger(pid) || pid < 0 || !Number.isInteger(parentPid) || parentPid < 0) {
      throw new Error('Process table returned an invalid PID row')
    }
    if (seen.has(pid)) continue
    seen.add(pid)
    normalized.push({ pid, parentPid })
  }
  return normalized
}

function parseProcessRows(text, windowsCsv) {
  const rows = []
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const parts = windowsCsv ? line.split(',') : line.split(/\s+/)
    const pair = parts.slice(-2)
    if (pair.length !== 2 || !pair.every((value) => /^\d+$/.test(value.trim()))) continue
    rows.push({ parentPid: Number(pair[0]), pid: Number(pair[1]) })
  }
  return normalizeProcessRows(rows)
}

function parseWmicProcessRows(text) {
  const blocks = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\r\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
  if (blocks.length < 1 || blocks.length > MAX_PROCESS_TABLE_ROWS) {
    throw new Error('WMIC process table returned an invalid bounded row count')
  }
  const rows = blocks.map((block) => {
    const values = new Map()
    for (const line of block.split(/\r?\n/).map((value) => value.trim())) {
      const match = line.match(/^([A-Za-z]+)=(.*)$/)
      if (!match || values.has(match[1])) {
        throw new Error('WMIC process table returned an invalid value row')
      }
      values.set(match[1], match[2])
    }
    if (
      values.size !== 2 ||
      !/^\d+$/.test(values.get('ParentProcessId') || '') ||
      !/^\d+$/.test(values.get('ProcessId') || '')
    ) {
      throw new Error('WMIC process table returned an invalid row')
    }
    return {
      parentPid: Number(values.get('ParentProcessId')),
      pid: Number(values.get('ProcessId')),
    }
  })
  if (new Set(rows.map((row) => row.pid)).size !== rows.length) {
    throw new Error('WMIC process table returned a duplicate PID')
  }
  return normalizeProcessRows(rows)
}

function listSystemProcesses(options = {}) {
  if (typeof options.listProcesses === 'function') {
    return normalizeProcessRows(options.listProcesses())
  }
  const platform = options.platform || process.platform
  const spawnSyncFn = options.spawnSyncFn || spawnSync
  const timeout = Math.max(1, boundedProcessTreeTimeout(options.timeoutMs, 2_000))
  let result
  if (platform === 'win32') {
    const systemTools = options.systemTools || FIXED_SYSTEM_TOOLS
    if (!systemTools?.wmic) throw new Error('Trusted WMIC path is unavailable')
    result = spawnSyncFn(
      systemTools.wmic,
      ['process', 'get', 'ParentProcessId,ProcessId', '/VALUE'],
      {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout,
        maxBuffer: MAX_PROCESS_TABLE_BYTES,
        env:
          options.systemEnvironment ||
          createFixedWindowsSystemEnvironment({
            systemRoot: systemTools.systemRoot,
            comSpec: systemTools.comSpec,
          }),
      },
    )
  } else {
    result = spawnSyncFn('ps', ['-e', '-o', 'ppid=,pid='], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout,
      maxBuffer: MAX_PROCESS_TABLE_BYTES,
    })
  }
  if (result.error || result.status !== 0) {
    throw new Error(
      'Unable to inspect the process table: ' +
        (result.error?.message || String(result.status ?? result.signal)),
    )
  }
  if (Buffer.byteLength(result.stdout || '', 'utf8') > MAX_PROCESS_TABLE_BYTES) {
    throw new Error('Process table exceeded its bounded output size')
  }
  return platform === 'win32'
    ? parseWmicProcessRows(result.stdout)
    : parseProcessRows(result.stdout)
}

function inspectProcessTree(rootPid, observedPids, options = {}) {
  const rows = listSystemProcesses(options)
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const treePids = new Set([rootPid])
  for (const pid of observedPids) {
    if (byPid.has(pid)) treePids.add(pid)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!treePids.has(row.pid) && treePids.has(row.parentPid)) {
        treePids.add(row.pid)
        changed = true
      }
    }
  }
  const alivePids = [...treePids].filter((pid) => byPid.has(pid))
  for (const pid of alivePids) observedPids.add(pid)
  return { alivePids, observedPids }
}

function terminateProcessTree(child, options = {}) {
  if (!child?.pid) {
    return { attempted: false, succeeded: false, status: null, signal: null, errorCode: 'no-pid' }
  }
  const platform = options.platform || process.platform
  if (platform === 'win32') {
    const systemTools = options.systemTools || FIXED_SYSTEM_TOOLS
    if (!systemTools?.taskkill) throw new Error('Trusted taskkill path is unavailable')
    const result = (options.spawnSyncFn || spawnSync)(
      systemTools.taskkill,
      ['/pid', String(child.pid), '/T', '/F'],
      {
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
        timeout: Math.max(1, boundedProcessTreeTimeout(options.timeoutMs)),
        env:
          options.systemEnvironment ||
          createFixedWindowsSystemEnvironment({
            systemRoot: systemTools.systemRoot,
            comSpec: systemTools.comSpec,
          }),
      },
    )
    return {
      attempted: true,
      succeeded: !result.error && result.status === 0,
      status: Number.isInteger(result.status) ? result.status : null,
      signal: result.signal || null,
      errorCode: result.error?.code || null,
    }
  }
  let succeeded = false
  let errorCode = null
  try {
    succeeded = child.kill('SIGKILL')
  } catch (error) {
    errorCode = error?.code || 'kill-error'
  }
  return {
    attempted: true,
    succeeded,
    status: succeeded ? 0 : 1,
    signal: 'SIGKILL',
    errorCode,
  }
}

function processDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function terminateProcessTreeAndConfirm(child, options = {}) {
  const timeoutMs = boundedProcessTreeTimeout(options.timeoutMs)
  const pollIntervalMs = Math.max(
    10,
    Math.min(1_000, Number(options.pollIntervalMs) || PROCESS_TREE_POLL_INTERVAL_MS),
  )
  const now = options.now || (() => Date.now())
  const delay = options.delay || processDelay
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  const tracker =
    options.tracker?.observedPids instanceof Set
      ? options.tracker
      : { observedPids: new Set(), captureComplete: false }
  const observedPids = tracker.observedPids
  if (Number.isInteger(child?.pid)) observedPids.add(child.pid)
  let closeReceived = options.closeReceived?.() === true
  let lastAliveCount = observedPids.size
  let queryError = null
  let captureError = null
  const onClose = () => {
    closeReceived = true
  }
  child?.once?.('close', onClose)
  try {
    if (Number.isInteger(child?.pid)) {
      try {
        const initial = inspectProcessTree(child.pid, observedPids, {
          ...options,
          timeoutMs: Math.max(1, deadline - now()),
        })
        lastAliveCount = initial.alivePids.length
        if (!tracker.captureComplete) {
          if (initial.alivePids.includes(child.pid)) {
            tracker.captureComplete = true
          } else {
            captureError = new Error(
              'Benchmark parent disappeared before its descendant tree could be captured',
            )
          }
        }
      } catch (error) {
        queryError = error
        if (!tracker.captureComplete) captureError = error
      }
    } else {
      captureError = new Error('Benchmark child PID is unavailable for descendant capture')
    }
    const termination = closeReceived
      ? { attempted: false, succeeded: true, status: null, signal: null, errorCode: null }
      : terminateProcessTree(child, {
          ...options,
          timeoutMs: Math.max(1, deadline - now()),
        })
    for (;;) {
      closeReceived ||= options.closeReceived?.() === true
      if (Number.isInteger(child?.pid) && now() <= deadline) {
        try {
          const state = inspectProcessTree(child.pid, observedPids, {
            ...options,
            timeoutMs: Math.max(1, deadline - now()),
          })
          queryError = null
          lastAliveCount = state.alivePids.length
          if (tracker.captureComplete && lastAliveCount === 0) {
            return {
              safeToCleanup: true,
              confirmedBy: closeReceived ? 'close-and-process-tree-absent' : 'process-tree-absent',
              parentCloseReceived: closeReceived,
              descendantCaptureComplete: true,
              timeoutMs,
              waitMs: Math.max(0, now() - startedAt),
              observedProcessCount: observedPids.size,
              remainingProcessCount: 0,
              termination,
              queryError: null,
            }
          }
        } catch (error) {
          queryError = error
        }
      }
      if (now() >= deadline) break
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - now())))
    }
    return {
      safeToCleanup: false,
      confirmedBy: null,
      timeoutMs,
      waitMs: Math.max(0, now() - startedAt),
      observedProcessCount: observedPids.size,
      remainingProcessCount: lastAliveCount,
      termination,
      parentCloseReceived: closeReceived,
      descendantCaptureComplete: tracker.captureComplete === true,
      queryError: (captureError || queryError)?.message || null,
    }
  } finally {
    child?.removeListener?.('close', onClose)
  }
}

function isPerformanceOverrideKey(key) {
  return PERFORMANCE_OVERRIDE_PATTERNS.some((pattern) => pattern.test(key))
}

function deleteEnvironmentKey(environment, key, caseInsensitive) {
  const expected = caseInsensitive ? key.toLowerCase() : key
  for (const candidate of Object.keys(environment)) {
    const actual = caseInsensitive ? candidate.toLowerCase() : candidate
    if (actual === expected) delete environment[candidate]
  }
}

function setEnvironmentKey(environment, key, value, caseInsensitive) {
  deleteEnvironmentKey(environment, key, caseInsensitive)
  environment[key] = value
}

function createControlledNodeSpawnEnvironment(baseEnvironment, options = {}) {
  const platform = options.platform || process.platform
  const caseInsensitiveEnvironment = platform === 'win32'
  const environment = {}
  setEnvironmentKey(environment, 'NODE_OPTIONS', '', caseInsensitiveEnvironment)
  setEnvironmentKey(environment, 'NODE_DISABLE_COMPILE_CACHE', '1', caseInsensitiveEnvironment)
  if (platform === 'win32') {
    const fixedWindowsEnvironment =
      options.fixedWindowsEnvironment ||
      FIXED_WINDOWS_ENVIRONMENT ||
      createFixedWindowsSystemEnvironment()
    for (const [key, value] of Object.entries(fixedWindowsEnvironment)) {
      setEnvironmentKey(environment, key, value, true)
    }
  }
  return environment
}

function createRoundEnvironment(options, round) {
  const tempParent = fs.realpathSync(options.sandboxTempRoot || os.tmpdir())
  const roundRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(tempParent, ROUND_SANDBOX_PREFIX + 'r' + round + '-')),
  )
  const relativeRoot = path.relative(tempParent, roundRoot)
  if (
    !relativeRoot ||
    relativeRoot.startsWith('..' + path.sep) ||
    path.isAbsolute(relativeRoot) ||
    !path.basename(roundRoot).startsWith(ROUND_SANDBOX_PREFIX)
  ) {
    throw new Error('Round sandbox escaped its exclusive temporary parent')
  }
  if (process.platform === 'win32' && roundRoot.length > MAX_WINDOWS_SANDBOX_ROOT_CHARS) {
    fs.rmdirSync(roundRoot)
    throw new Error(
      'Round sandbox path is too long for Native/SQLite child paths: ' + roundRoot.length,
    )
  }
  ACTIVE_SANDBOXES.set(roundRoot, tempParent)
  try {
    const directories = {
      appData: path.join(roundRoot, 'appdata'),
      localAppData: path.join(roundRoot, 'localappdata'),
      profile: path.join(roundRoot, 'profile'),
      hfHome: path.join(roundRoot, 'huggingface'),
      transformersCache: path.join(roundRoot, 'transformers-cache'),
      temp: path.join(roundRoot, 'temp'),
    }
    for (const directory of Object.values(directories))
      fs.mkdirSync(directory, { recursive: false })
    const inheritedEnvironment = options.baseEnvironment ?? process.env
    const droppedInheritedKeys = Object.keys(inheritedEnvironment).sort((left, right) =>
      left.localeCompare(right),
    )
    const environment = {}
    const platform = options.platform || process.platform
    const caseInsensitiveEnvironment = platform === 'win32'
    const controlledEnvironment = {
      APPDATA: directories.appData,
      LOCALAPPDATA: directories.localAppData,
      HOME: directories.profile,
      USERPROFILE: directories.profile,
      HF_HOME: directories.hfHome,
      TRANSFORMERS_CACHE: directories.transformersCache,
      XDG_CACHE_HOME: directories.hfHome,
      TEMP: directories.temp,
      TMP: directories.temp,
      NODE_OPTIONS: '',
      NODE_DISABLE_COMPILE_CACHE: '1',
      DISABLE_SYSTEM_FONTS_LOAD: '1',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      UV_THREADPOOL_SIZE: '4',
    }
    for (const [key, value] of Object.entries(controlledEnvironment)) {
      setEnvironmentKey(environment, key, value, caseInsensitiveEnvironment)
    }
    if (platform === 'win32') {
      const fixedWindowsEnvironment =
        options.fixedWindowsEnvironment ||
        FIXED_WINDOWS_ENVIRONMENT ||
        createFixedWindowsSystemEnvironment()
      for (const [key, value] of Object.entries(fixedWindowsEnvironment)) {
        setEnvironmentKey(environment, key, value, true)
      }
    }
    const clearedPerformanceOverrides = droppedInheritedKeys.filter(isPerformanceOverrideKey)
    return {
      environment,
      rootPath: roundRoot,
      tempParent,
      proof: {
        schemaVersion: 1,
        environmentPolicy: 'minimal-allowlist-v1',
        droppedInheritedKeys,
        rootId: path.basename(roundRoot),
        rootScope: 'exclusive-os-temp',
        rootPathOmitted: true,
        rootPathLength: roundRoot.length,
        variables: Object.fromEntries(
          Object.entries(directories).map(([key, value]) => [
            key,
            path.relative(roundRoot, value).split(path.sep).join('/'),
          ]),
        ),
        networkModelFetchDisabled: true,
        nodeOptionsCleared: true,
        nodePathCleared: true,
        nodeCompileCacheCleared: true,
        nodeCompileCacheDisabled: true,
        nodeInheritedOverridesDropped: true,
        systemFontsDisabled: true,
        windowsCommandResolutionControlled: platform === 'win32',
        performanceOverridesCleared: true,
        clearedPerformanceOverrides,
        performanceOverrideFamilies: [
          'application-native-embedding',
          'libvips',
          'onnxruntime',
          'blas-mkl-openmp',
          'cuda-cudnn-cublas',
          'napi-rs-canvas-loader',
        ],
        effectiveEnvironment: {
          NODE_OPTIONS: '',
          NODE_PATH: null,
          NODE_COMPILE_CACHE: null,
          NODE_DISABLE_COMPILE_CACHE: '1',
          NODE_V8_COVERAGE: null,
          NODE_DEBUG: null,
          NODE_DEBUG_NATIVE: null,
          NODE_REDIRECT_WARNINGS: null,
          NODE_ICU_DATA: null,
          NODE_EXTRA_CA_CERTS: null,
          DISABLE_SYSTEM_FONTS_LOAD: '1',
          UV_THREADPOOL_SIZE: '4',
          REASONIX_NATIVE_SCAN_WORKERS: null,
          REASONIX_NATIVE_THUMB_SCAN_WORKERS: null,
          REASONIX_NATIVE_THUMB_FILL_WORKERS: null,
          REASONIX_NATIVE_THUMB_QUEUE_CAPACITY: null,
          IMAGESEARCH_VERBOSE_LOG: null,
          IMAGESEARCH_VERBOSE_PATHS: null,
          VIPS_CONCURRENCY: null,
          ORT_NUM_THREADS: null,
          ONNXRUNTIME_THREAD_SPINNING: null,
          OPENBLAS_NUM_THREADS: null,
          MKL_NUM_THREADS: null,
          OMP_NUM_THREADS: null,
          CUDA_VISIBLE_DEVICES: null,
          CUDA_MODULE_LOADING: null,
          CUDNN_LOGLEVEL_DBG: null,
          CUBLAS_WORKSPACE_CONFIG: null,
          NAPI_RS_NATIVE_LIBRARY_PATH: null,
          NAPI_RS_FORCE_WASI: null,
          PATH: platform === 'win32' ? environment.PATH : null,
          PATHEXT: platform === 'win32' ? environment.PATHEXT : null,
          SystemRoot: platform === 'win32' ? environment.SystemRoot : null,
          WINDIR: platform === 'win32' ? environment.WINDIR : null,
          ComSpec: platform === 'win32' ? environment.ComSpec : null,
          PSModulePath: platform === 'win32' ? environment.PSModulePath : null,
          ProgramFiles: platform === 'win32' ? environment.ProgramFiles : null,
          ProgramW6432: platform === 'win32' ? environment.ProgramW6432 : null,
        },
        fixedHarnessOverrides: {
          scanWorkers: FIXED_SCAN_WORKERS,
          stageMetrics: true,
          tensorPrefetch: false,
        },
      },
    }
  } catch (error) {
    try {
      cleanupRoundEnvironment({ rootPath: roundRoot, tempParent }, { processTreeConfirmed: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Round sandbox initialization and exact cleanup both failed',
        { cause: cleanupError },
      )
    }
    throw error
  }
}

function markSandboxProcessTreeUnconfirmed(roundEnvironment) {
  const roundRoot = roundEnvironment?.rootPath
  if (typeof roundRoot !== 'string' || !ACTIVE_SANDBOXES.has(roundRoot)) {
    throw new Error('Cannot retain an unknown round sandbox')
  }
  BLOCKED_SANDBOXES.add(roundRoot)
}

function cleanupRoundEnvironment(roundEnvironment, options = {}) {
  const roundRoot = roundEnvironment?.rootPath
  const tempParent = roundEnvironment?.tempParent
  if (typeof roundRoot !== 'string' || typeof tempParent !== 'string') {
    throw new Error('Round sandbox cleanup requires its exact root and parent')
  }
  const processTreeConfirmed = options.processTreeConfirmed === true
  if (QUARANTINED_SANDBOXES.has(roundRoot)) {
    throw new Error('Round sandbox is quarantined after a lifecycle barrier failure')
  }
  if (BLOCKED_SANDBOXES.has(roundRoot) && !processTreeConfirmed) {
    throw new Error('Round sandbox is retained because its process tree is not confirmed stopped')
  }
  if (!fs.existsSync(roundRoot)) {
    ACTIVE_SANDBOXES.delete(roundRoot)
    BLOCKED_SANDBOXES.delete(roundRoot)
    return
  }
  const parentRealPath = fs.realpathSync(tempParent)
  const entry = fs.lstatSync(roundRoot)
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('Round sandbox cleanup target must be a regular directory')
  }
  const rootRealPath = fs.realpathSync(roundRoot)
  const relativeRoot = path.relative(parentRealPath, rootRealPath)
  if (
    !relativeRoot ||
    relativeRoot.startsWith('..' + path.sep) ||
    path.isAbsolute(relativeRoot) ||
    !path.basename(rootRealPath).startsWith(ROUND_SANDBOX_PREFIX)
  ) {
    throw new Error('Refusing to clean a round sandbox outside its temporary parent')
  }
  fs.rmSync(rootRealPath, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 })
  ACTIVE_SANDBOXES.delete(roundRoot)
  BLOCKED_SANDBOXES.delete(roundRoot)
}

function sameStableFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function readStableFreshRegularFile(filePath, label, earliestMs, maxBytes) {
  const pathEntryBefore = fs.lstatSync(filePath)
  if (pathEntryBefore.isSymbolicLink() || !pathEntryBefore.isFile()) {
    throw new Error(label + ' must be a regular non-link file')
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY)
  try {
    const descriptorBefore = fs.fstatSync(descriptor)
    if (!descriptorBefore.isFile() || !sameStableFile(pathEntryBefore, descriptorBefore)) {
      throw new Error(label + ' changed while it was opened')
    }
    if (descriptorBefore.size <= 0) {
      throw new Error(label + ' is empty')
    }
    if (descriptorBefore.size > maxBytes) {
      throw new Error(label + ' exceeds its bounded size')
    }
    if (descriptorBefore.mtimeMs + TIMESTAMP_TOLERANCE_MS < earliestMs) {
      throw new Error(label + ' predates this round')
    }
    const buffer = Buffer.allocUnsafe(descriptorBefore.size)
    let offset = 0
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (bytesRead <= 0) throw new Error(label + ' ended before its declared size')
      offset += bytesRead
    }
    const trailing = Buffer.allocUnsafe(1)
    if (fs.readSync(descriptor, trailing, 0, 1, offset) !== 0) {
      throw new Error(label + ' grew beyond its declared size')
    }
    const descriptorAfter = fs.fstatSync(descriptor)
    const pathEntryAfter = fs.lstatSync(filePath)
    if (
      pathEntryAfter.isSymbolicLink() ||
      !pathEntryAfter.isFile() ||
      !sameStableFile(descriptorBefore, descriptorAfter) ||
      !sameStableFile(descriptorAfter, pathEntryAfter)
    ) {
      throw new Error(label + ' changed during its bounded read')
    }
    return {
      entry: descriptorAfter,
      buffer,
      sha256: sha256(buffer),
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

function publishLifecycleBarrierFile(filePath, value) {
  const serialized = JSON.stringify(value) + '\n'
  const byteLength = Buffer.byteLength(serialized, 'utf8')
  if (byteLength <= 0 || byteLength > LIFECYCLE_BARRIER_MAX_BYTES) {
    throw new Error('Lifecycle barrier payload exceeds its bounded size')
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

  // linkSync publishes a fully written inode without ever exposing a partial final file and,
  // unlike rename on POSIX, fails if another process preoccupied the final path. Keep the
  // staging hard link until the managed round sandbox is removed so its unlink cannot race the
  // reader's ctime-based stable-file check.
  fs.linkSync(stagingPath, filePath)
  const linkedStagingEntry = fs.lstatSync(stagingPath)
  const publishedEntry = fs.lstatSync(filePath)
  if (
    publishedEntry.isSymbolicLink() ||
    !publishedEntry.isFile() ||
    !sameStableFile(linkedStagingEntry, publishedEntry)
  ) {
    throw new Error('Lifecycle barrier publication is not bound to its staged file')
  }
  return { stagingPath, byteLength }
}

function lifecycleBarrierPaths(roundEnvironment) {
  const tempRoot = path.join(roundEnvironment.rootPath, 'temp')
  const readyPath = path.join(tempRoot, 'lifecycle-ready.json')
  const releasePath = path.join(tempRoot, 'lifecycle-release.json')
  for (const filePath of [readyPath, releasePath]) {
    if (fs.existsSync(filePath)) throw new Error('Lifecycle barrier path must be new')
  }
  return { readyPath, releasePath }
}

function readLifecycleReadyFile(filePath, expected, earliestMs) {
  const captured = readStableFreshRegularFile(
    filePath,
    'lifecycle ready barrier',
    earliestMs,
    LIFECYCLE_BARRIER_MAX_BYTES,
  )
  const value = JSON.parse(captured.buffer.toString('utf8'))
  if (
    value?.schemaVersion !== 1 ||
    value?.phase !== 'ready-for-parent-tree-capture' ||
    value?.runNonce !== expected.runNonce ||
    value?.benchmarkPid !== expected.benchmarkPid ||
    value?.orchestratorPid !== expected.orchestratorPid
  ) {
    throw new Error('Lifecycle ready barrier provenance does not match this round')
  }
  return value
}

function waitForLifecycleReady(options) {
  const timeoutMs = Math.max(
    1,
    Math.min(LIFECYCLE_READY_TIMEOUT_MS, Number(options.timeoutMs) || LIFECYCLE_READY_TIMEOUT_MS),
  )
  return new Promise((resolve, reject) => {
    let settled = false
    let watcher
    let timer
    const abortSignal = options.signal
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      options.child?.removeListener?.('close', onClose)
      abortSignal?.removeEventListener?.('abort', onAbort)
      callback()
    }
    const onClose = () =>
      finish(() => reject(new Error('Benchmark parent closed before lifecycle ready barrier')))
    const onAbort = () =>
      finish(() => reject(new Error('Lifecycle ready barrier cancelled after round settlement')))
    if (abortSignal?.aborted) {
      onAbort()
      return
    }
    const inspect = () => {
      if (!fs.existsSync(options.readyPath)) return
      try {
        const ready = readLifecycleReadyFile(
          options.readyPath,
          options.expected,
          options.earliestMs,
        )
        finish(() => resolve(ready))
      } catch (error) {
        finish(() => reject(error))
      }
    }
    watcher = fs.watch(path.dirname(options.readyPath), (event, name) => {
      if (!name || String(name) === path.basename(options.readyPath)) inspect()
    })
    watcher.on('error', (error) => finish(() => reject(error)))
    options.child?.once?.('close', onClose)
    abortSignal?.addEventListener?.('abort', onAbort, { once: true })
    timer = setTimeout(
      () => finish(() => reject(new Error('Lifecycle ready barrier timed out'))),
      timeoutMs,
    )
    inspect()
  })
}

async function captureLifecycleProcessTreeAndRelease(child, tracker, barrier, options = {}) {
  await waitForLifecycleReady({
    readyPath: barrier.readyPath,
    earliestMs: barrier.earliestMs,
    expected: barrier.expected,
    timeoutMs: barrier.timeoutMs,
    child,
    signal: barrier.signal,
  })
  if (!Number.isInteger(child?.pid) || tracker?.observedPids?.has(child.pid) !== true) {
    throw new Error('Lifecycle capture has no registered benchmark PID')
  }
  const captured = inspectProcessTree(child.pid, tracker.observedPids, options)
  if (!captured.alivePids.includes(child.pid)) {
    throw new Error('Benchmark parent exited before lifecycle tree capture')
  }
  tracker.captureComplete = true
  publishLifecycleBarrierFile(barrier.releasePath, {
    schemaVersion: 1,
    phase: 'release-after-parent-tree-capture',
    ...barrier.expected,
    observedProcessCount: tracker.observedPids.size,
  })
  return { capturedProcessCount: tracker.observedPids.size }
}

function inspectTimeline(filePath, expectedNonce, earliestMs) {
  const captured = readStableFreshRegularFile(
    filePath,
    'round timeline',
    earliestMs,
    TIMELINE_MAX_BYTES,
  )
  const buffer = captured.buffer
  const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean)
  if (lines.length === 0 || lines.length > TIMELINE_MAX_EVENTS) {
    throw new Error('Timeline must contain a bounded non-empty event sequence')
  }
  const events = lines.map((line, index) => {
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      throw new Error('Timeline line ' + (index + 1) + ' is not valid JSON', { cause: error })
    }
    if (event?.schemaVersion !== 1 || event?.runNonce !== expectedNonce) {
      throw new Error('Timeline provenance differs from its parent round')
    }
    return event
  })
  const terminal = events.at(-1)
  const truncated = terminal.event === 'timeline-truncated'
  if (truncated && terminal.terminal !== true) {
    throw new Error('Truncated timeline is missing its terminal marker')
  }
  if (!truncated && terminal.event !== 'benchmark-end') {
    throw new Error('Complete timeline is missing benchmark-end')
  }
  return {
    bytes: buffer.length,
    sha256: captured.sha256,
    events: events.length,
    terminal,
    truncated,
  }
}

function noResidualLifecycleFailures(report) {
  const failures = []
  const processes = report?.resources?.processes
  const sampling = report?.resources?.sampling
  if (report?.ok !== true) failures.push('report did not complete successfully')
  if (report?.safety?.noBenchmarkChildProcessesAtStop !== true) {
    failures.push('benchmark child processes were not confirmed stopped')
  }
  if (processes?.activeAtStop !== 0 || processes?.noResidualAtStop !== true) {
    failures.push('child lifecycle retained active processes at stop')
  }
  if (processes?.lifecycleAccounted !== true) {
    failures.push('child lifecycle accounting is incomplete')
  }
  if (
    !Number.isInteger(processes?.observedChildProcesses) ||
    processes.observedChildProcesses <= 0
  ) {
    failures.push('child lifecycle observed no benchmark descendants')
  }
  if (sampling?.observedChildEvidence?.lifecycleAccounted !== true) {
    failures.push('resource sampler did not corroborate child lifecycle shutdown')
  }
  if (sampling?.observedChildEvidence?.lifecycleTracked !== processes?.observedChildProcesses) {
    failures.push('resource and lifecycle child counts differ')
  }
  return failures
}

function runMeasuredRound(options, round) {
  return new Promise((resolve, reject) => {
    const runtime = options.runtime || {}
    const spawnChild = runtime.spawn || spawn
    const scheduleTimeout = runtime.setTimeout || setTimeout
    const cancelTimeout = runtime.clearTimeout || clearTimeout
    const runner = path.join(options.projectRoot, 'tests', 'image-search-simple-e2e-benchmark.cjs')
    const reportPath = path.join(options.outputDirectory, 'round-' + round + '.json')
    const timelinePath = path.join(options.outputDirectory, 'round-' + round + '.timeline.ndjson')
    const stdoutPath = path.join(options.outputDirectory, 'round-' + round + '.stdout.log')
    const stderrPath = path.join(options.outputDirectory, 'round-' + round + '.stderr.log')
    for (const artifact of [reportPath, timelinePath, stdoutPath, stderrPath]) {
      if (fs.existsSync(artifact)) throw new Error('Round artifact must be new: ' + artifact)
    }
    const runNonce = 'fixed_round_' + round + '_' + crypto.randomUUID().replaceAll('-', '')
    const roundEnvironment = createRoundEnvironment(options, round)
    const lifecycleBarrier = lifecycleBarrierPaths(roundEnvironment)
    const startedAt = new Date()
    let child
    try {
      child = spawnChild(
        process.execPath,
        [
          runner,
          options.dataset,
          '--pipeline=overlap',
          '--sample=' + options.sample,
          '--backend=' + options.backend,
          '--jobs=' + options.jobs,
          '--batch-size=' + options.batchSize,
          '--scan-workers=' + FIXED_SCAN_WORKERS,
          '--timeout-ms=' + options.timeoutMs,
          '--json-out=' + reportPath,
          '--timeline-out=' + timelinePath,
          '--stage-metrics',
          '--defer-thumbnails',
          '--verify-warm',
          '--compact',
          '--run-nonce=' + runNonce,
          '--timeline-max-bytes=' + TIMELINE_MAX_BYTES,
          '--timeline-max-events=' + TIMELINE_MAX_EVENTS,
          '--lifecycle-ready=' + lifecycleBarrier.readyPath,
          '--lifecycle-release=' + lifecycleBarrier.releasePath,
          '--lifecycle-parent-pid=' + process.pid,
          '--lifecycle-timeout-ms=' + PROCESS_TREE_CONFIRM_TIMEOUT_MS,
        ],
        {
          cwd: options.projectRoot,
          env: roundEnvironment.environment,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
    } catch (error) {
      try {
        cleanupRoundEnvironment(roundEnvironment, { processTreeConfirmed: true })
      } catch (cleanupError) {
        reject(
          new AggregateError(
            [error, cleanupError],
            'Benchmark spawn and exact sandbox cleanup both failed',
            { cause: cleanupError },
          ),
        )
        return
      }
      reject(error)
      return
    }
    ACTIVE_CHILDREN.add(child)
    ACTIVE_CHILD_SANDBOXES.set(child, roundEnvironment)
    ACTIVE_PROCESS_TRACKERS.set(child, {
      observedPids: new Set(Number.isInteger(child.pid) ? [child.pid] : []),
      captureComplete: false,
    })
    let stdoutTail = Buffer.alloc(0)
    let stderrTail = Buffer.alloc(0)
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let closeReceived = false
    let closeCode = null
    let termination = null
    let terminationPromise = null
    let spawnError = null
    let logsWritten = false
    let settled = false
    let lifecycleCapture = null
    const lifecycleAbortController = new AbortController()
    const settle = (callback) => {
      if (settled) return
      settled = true
      lifecycleAbortController.abort()
      callback()
    }
    const finishLogs = () => {
      if (logsWritten) return
      logsWritten = true
      writeBoundedLog(stdoutPath, stdoutTail, stdoutBytes > MAX_CAPTURE_BYTES)
      writeBoundedLog(stderrPath, stderrTail, stderrBytes > MAX_CAPTURE_BYTES)
    }
    const retainUnconfirmedProcessTree = (reason, evidence, cause) => {
      try {
        markSandboxProcessTreeUnconfirmed(roundEnvironment)
      } catch (error) {
        cause ||= error
      }
      const failure = new Error(
        'baseline round ' +
          round +
          ' failed closed after ' +
          reason +
          ': the benchmark process tree could not be confirmed stopped' +
          (evidence
            ? '; taskkill status=' +
              String(evidence.termination?.status) +
              '; remaining processes=' +
              String(evidence.remainingProcessCount)
            : '') +
          (cause ? '; confirmation error=' + String(cause.message || cause).slice(0, 2_000) : '') +
          '\n' +
          stderrTail.subarray(Math.max(0, stderrTail.length - 12_000)).toString('utf8'),
      )
      failure.code = 'PROCESS_TREE_UNCONFIRMED'
      failure.preserveManagedWorkspace = true
      failure.processTreeEvidence = evidence || null
      return failure
    }
    const retainBarrierFailure = (reason, evidence, cause) => {
      QUARANTINED_SANDBOXES.add(roundEnvironment.rootPath)
      return retainUnconfirmedProcessTree(reason, evidence, cause)
    }
    const beginForcedTermination = (reason) => {
      if (terminationPromise) return terminationPromise
      terminationPromise = terminateProcessTreeAndConfirm(child, {
        ...(runtime.processTreeOptions || {}),
        tracker: ACTIVE_PROCESS_TRACKERS.get(child),
        timeoutMs:
          runtime.processTreeConfirmTimeoutMs === undefined
            ? PROCESS_TREE_CONFIRM_TIMEOUT_MS
            : runtime.processTreeConfirmTimeoutMs,
        closeReceived: () => closeReceived,
      })
        .then((evidence) => {
          termination = evidence
          if (settled) return evidence
          finishLogs()
          if (!evidence.safeToCleanup) {
            settle(() => reject(retainUnconfirmedProcessTree(reason, evidence)))
            return evidence
          }
          ACTIVE_CHILDREN.delete(child)
          ACTIVE_CHILD_SANDBOXES.delete(child)
          ACTIVE_PROCESS_TRACKERS.delete(child)
          ACTIVE_TERMINATORS.delete(child)
          let sandboxCleanupError = null
          try {
            cleanupRoundEnvironment(roundEnvironment, { processTreeConfirmed: true })
          } catch (error) {
            sandboxCleanupError = error
          }
          settle(() => {
            const failure = new Error(
              'baseline round ' +
                round +
                ' failed after ' +
                reason +
                '; process tree confirmed stopped by ' +
                evidence.confirmedBy +
                (sandboxCleanupError ? '; sandbox cleanup: ' + sandboxCleanupError.message : '') +
                '\n' +
                stderrTail.subarray(Math.max(0, stderrTail.length - 12_000)).toString('utf8'),
            )
            reject(failure)
          })
          return evidence
        })
        .catch((error) => {
          if (settled) return null
          finishLogs()
          settle(() => reject(retainUnconfirmedProcessTree(reason, null, error)))
          return null
        })
      return terminationPromise
    }
    ACTIVE_TERMINATORS.set(child, beginForcedTermination)
    const tracker = ACTIVE_PROCESS_TRACKERS.get(child)
    const capturePromise = captureLifecycleProcessTreeAndRelease(
      child,
      tracker,
      {
        ...lifecycleBarrier,
        earliestMs: startedAt.getTime(),
        timeoutMs:
          runtime.lifecycleReadyTimeoutMs === undefined
            ? Math.min(LIFECYCLE_READY_TIMEOUT_MS, options.timeoutMs + 30_000)
            : runtime.lifecycleReadyTimeoutMs,
        expected: {
          runNonce,
          benchmarkPid: child.pid,
          orchestratorPid: process.pid,
        },
        signal: lifecycleAbortController.signal,
      },
      runtime.processTreeOptions || {},
    )
      .then((result) => {
        lifecycleCapture = result
        return result
      })
      .catch(async (error) => {
        if (settled) return null
        if (closeReceived && (spawnError || timedOut || closeCode !== 0)) return null
        if (!terminationPromise) {
          terminationPromise = terminateProcessTreeAndConfirm(child, {
            ...(runtime.processTreeOptions || {}),
            tracker,
            timeoutMs:
              runtime.processTreeConfirmTimeoutMs === undefined
                ? PROCESS_TREE_CONFIRM_TIMEOUT_MS
                : runtime.processTreeConfirmTimeoutMs,
            closeReceived: () => closeReceived,
          })
        }
        let evidence = null
        let confirmationError = error
        try {
          evidence = await terminationPromise
        } catch (treeError) {
          confirmationError = new AggregateError([error, treeError], 'Lifecycle barrier failed')
        }
        termination = evidence
        finishLogs()
        settle(() =>
          reject(
            retainBarrierFailure('the lifecycle capture barrier', evidence, confirmationError),
          ),
        )
        return null
      })
    const timer = scheduleTimeout(() => {
      timedOut = true
      void beginForcedTermination('the absolute timeout')
    }, options.timeoutMs + 30_000)
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      stdoutTail = appendBounded(stdoutTail, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      stderrTail = appendBounded(stderrTail, chunk)
    })
    child.once('error', (error) => {
      spawnError = error
      void beginForcedTermination('a child-process error')
    })
    child.once('close', (code, signal) => {
      closeReceived = true
      closeCode = code
      cancelTimeout(timer)
      finishLogs()
      if (terminationPromise) return
      if (spawnError || code !== 0 || timedOut) {
        void beginForcedTermination(
          spawnError
            ? 'a child-process error followed by close'
            : timedOut
              ? 'the absolute timeout followed by close'
              : 'an abnormal child close (' + String(code ?? signal) + ')',
        )
        return
      }
      if (!tracker.captureComplete || !lifecycleCapture) {
        void capturePromise
        return
      }
      let reportEntry
      let reportBuffer
      let report
      try {
        if (!fs.existsSync(reportPath)) {
          throw new Error('baseline round ' + round + ' did not write its report')
        }
        const capturedReport = readStableFreshRegularFile(
          reportPath,
          'round ' + round + ' report',
          startedAt.getTime(),
          MAX_REPORT_BYTES,
        )
        reportEntry = capturedReport.entry
        reportBuffer = capturedReport.buffer
        report = JSON.parse(reportBuffer.toString('utf8'))
        const lifecycleFailures = noResidualLifecycleFailures(report)
        if (lifecycleFailures.length > 0) {
          throw new Error('No-residual lifecycle proof failed: ' + lifecycleFailures.join('; '))
        }
      } catch (error) {
        settle(() =>
          reject(
            retainUnconfirmedProcessTree(
              'a successful close without verified no-residual lifecycle evidence',
              null,
              error,
            ),
          ),
        )
        return
      }

      let timeline = null
      let artifactError = null
      try {
        timeline = inspectTimeline(timelinePath, runNonce, startedAt.getTime())
      } catch (error) {
        artifactError = error
      }
      if (artifactError) {
        settle(() =>
          reject(retainUnconfirmedProcessTree('invalid round artifacts', null, artifactError)),
        )
        return
      }
      terminationPromise = terminateProcessTreeAndConfirm(child, {
        ...(runtime.processTreeOptions || {}),
        tracker,
        timeoutMs:
          runtime.processTreeConfirmTimeoutMs === undefined
            ? PROCESS_TREE_CONFIRM_TIMEOUT_MS
            : runtime.processTreeConfirmTimeoutMs,
        closeReceived: () => closeReceived,
      })
      void terminationPromise
        .then((evidence) => {
          termination = evidence
          if (!evidence.safeToCleanup) {
            settle(() => reject(retainUnconfirmedProcessTree('a successful child close', evidence)))
            return
          }
          ACTIVE_CHILDREN.delete(child)
          ACTIVE_CHILD_SANDBOXES.delete(child)
          ACTIVE_PROCESS_TRACKERS.delete(child)
          ACTIVE_TERMINATORS.delete(child)
          let sandboxCleanupError = null
          try {
            cleanupRoundEnvironment(roundEnvironment, { processTreeConfirmed: true })
          } catch (error) {
            sandboxCleanupError = error
          }
          if (sandboxCleanupError) {
            settle(() => reject(sandboxCleanupError))
            return
          }
          settle(() =>
            resolve({
              round,
              reportPath,
              timelinePath,
              stdoutPath,
              stderrPath,
              report,
              orchestration: {
                runNonce,
                startedAt: startedAt.toISOString(),
                finishedAt: new Date().toISOString(),
                reportBytes: reportEntry.size,
                reportSha256: sha256(reportBuffer),
                timelineBytes: timeline.bytes,
                timelineSha256: timeline.sha256,
                timeline,
                timedOut,
                termination,
                lifecycleCapture,
                sandbox: roundEnvironment.proof,
              },
            }),
          )
        })
        .catch((error) => {
          settle(() =>
            reject(retainUnconfirmedProcessTree('successful-close tree confirmation', null, error)),
          )
        })
    })
  })
}

function valueAt(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => current?.[key], value)
}

function metricValues(runs, dottedPath) {
  return runs.map((run) => Number(valueAt(run, dottedPath))).filter(Number.isFinite)
}

function summarizeValues(values) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  const percentile = (ratio) =>
    sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] : null
  return {
    samples: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted.at(-1) : null,
  }
}

function spreadPercent(summary) {
  if (!summary || !Number.isFinite(summary.p50) || summary.p50 <= 0) return null
  return Number((((summary.max - summary.min) / summary.p50) * 100).toFixed(2))
}

function rounded(value) {
  return Number(Number(value).toFixed(2))
}

function buildControlLimits(metrics) {
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

function baselineCompatibilityIssues(baseline, context) {
  const issues = []
  if (baseline?.schemaVersion !== 1 || baseline?.kind !== 'fixed-hardware-first-build-baseline') {
    issues.push('baseline schema or kind is unsupported')
    return issues
  }
  if (baseline.hardware?.id !== context.hardware.id) issues.push('hardware fingerprint differs')
  if (baseline.dataset?.identity !== context.datasetIdentity)
    issues.push('dataset identity differs')
  for (const key of ['sample', 'runs', 'backend', 'jobs', 'batchSize', 'pipeline']) {
    if (baseline.config?.[key] !== context.config[key])
      issues.push('baseline config differs: ' + key)
  }
  return issues
}

function compareAcceptedBaselineEvidence(accepted, evidenceAfter) {
  if (!accepted?.report) return { ok: true, failures: [], implementation: null }
  return compareEvidence(accepted.report.evidence, evidenceAfter, {
    implementationMode: 'track',
  })
}

function evaluateBaseline(input) {
  const failures = []
  const warnings = []
  const runs = input.runs
  const roundProofs = input.roundProofs
  const config = input.config
  if (!Array.isArray(runs) || runs.length !== REQUIRED_RUNS) {
    failures.push('exactly three consecutive candidate runs are required')
  }
  if (!Array.isArray(roundProofs) || roundProofs.length !== REQUIRED_RUNS) {
    failures.push('exactly three independent round proofs are required')
  }
  for (const [index, run] of (runs || []).entries()) {
    failures.push(
      ...validateRound(
        run,
        roundProofs?.[index],
        config,
        index,
        roundProofs?.[index - 1],
        input.mode,
      ),
    )
  }
  for (const [label, values] of [
    ['execution nonce', (roundProofs || []).map((proof) => proof?.runNonce)],
    ['temporary directory', (runs || []).map((run) => run?.execution?.tempDirectoryId)],
    ['round report', (roundProofs || []).map((proof) => proof?.reportSha256)],
    ['round timeline', (roundProofs || []).map((proof) => proof?.timelineSha256)],
  ]) {
    const present = values.filter(Boolean)
    if (present.length !== REQUIRED_RUNS || new Set(present).size !== REQUIRED_RUNS) {
      failures.push(label + ' must be unique across all three rounds')
    }
  }
  const ready = summarizeValues(metricValues(runs || [], 'phases.libraryReadyMs'))
  const main = summarizeValues(metricValues(runs || [], 'resources.memory.mainPeakRssMiB'))
  const child = summarizeValues(
    metricValues(runs || [], 'resources.memory.childPeakAggregateRssMiBApprox'),
  )
  const free = summarizeValues(metricValues(runs || [], 'resources.memory.systemMinFreeMiB'))
  const combinedValues = (runs || [])
    .map(
      (run) =>
        Number(run.resources?.memory?.mainPeakRssMiB) +
        Number(run.resources?.memory?.childPeakAggregateRssMiBApprox),
    )
    .filter(Number.isFinite)
  const combined = summarizeValues(combinedValues)
  const requiredSummaries = [ready, main, child, free, combined]
  if (requiredSummaries.some((summary) => summary.samples !== REQUIRED_RUNS)) {
    failures.push('time or memory telemetry is missing from one or more rounds')
  }
  if (!positiveFinite(main.min))
    failures.push('main-process peak RSS must be observed, not zero-filled')
  if (!positiveFinite(child.min))
    failures.push('child-process peak RSS must be observed, not zero-filled')
  if (!positiveFinite(free.min))
    failures.push('system free memory must be observed, not zero-filled')
  const readySpread = spreadPercent(ready)
  if (readySpread === null || readySpread > READY_SPREAD_BUDGET_PERCENT) {
    failures.push('first-build ready spread exceeds ' + READY_SPREAD_BUDGET_PERCENT + '%')
  }
  const totalMemoryMiB = input.hardware.totalMemoryBytes / 1024 / 1024
  const absoluteBudgets = {
    mainPeakRssMiB: Math.min(2048, totalMemoryMiB * 0.15),
    childPeakAggregateRssMiBApprox: totalMemoryMiB * 0.3,
    combinedPeakRssMiBApprox: totalMemoryMiB * 0.35,
    systemMinFreeMiB: MIN_SYSTEM_FREE_MIB,
  }
  if (main.max > absoluteBudgets.mainPeakRssMiB)
    failures.push('main peak RSS exceeded fixed-machine budget')
  if (child.max > absoluteBudgets.childPeakAggregateRssMiBApprox) {
    failures.push('child aggregate peak RSS exceeded fixed-machine budget')
  }
  if (combined.max > absoluteBudgets.combinedPeakRssMiBApprox) {
    failures.push('combined peak RSS exceeded fixed-machine budget')
  }
  if (free.min < absoluteBudgets.systemMinFreeMiB)
    failures.push('system free memory fell below 256 MiB')
  const digestKinds = [
    ['Native', 'scan.digest.sha256'],
    ['DINO', 'embeddingDigests.dino.stableSha256'],
    ['CLIP', 'embeddingDigests.clip.stableSha256'],
  ]
  for (const [label, dottedPath] of digestKinds) {
    const values = (runs || []).map((run) => valueAt(run, dottedPath))
    if (
      values.length !== REQUIRED_RUNS ||
      values.some((value) => !/^[a-f0-9]{64}$/i.test(value || '')) ||
      new Set(values).size !== 1
    ) {
      failures.push(label + ' digest is missing or differs across the three rounds')
    }
  }
  if (!input.datasetUnchanged) {
    failures.push(
      'source corpus was not read-only: dataset root metadata changed during the baseline',
    )
  }
  if (input.hardwareBeforeId !== input.hardwareAfterId)
    failures.push('hardware fingerprint changed')
  if (!input.sourceUnchanged) failures.push('measured source changed during the baseline')
  if (!input.userDataUnchanged)
    failures.push('real user application data changed during the baseline')
  failures.push(...(input.evidenceStabilityFailures || []))
  if (input.hardware.gpus.length === 0 && config.backend === 'gpu') {
    failures.push('GPU backend requested but no fixed GPU fingerprint was available')
  }
  const metrics = {
    libraryReadyMs: { ...ready, spreadPercent: readySpread },
    mainPeakRssMiB: main,
    childPeakAggregateRssMiBApprox: child,
    combinedPeakRssMiBApprox: combined,
    systemMinFreeMiB: free,
  }
  const controlLimits = buildControlLimits(metrics)
  let comparison = {
    status: input.mode === 'diagnostic' ? 'diagnostic' : 'established',
    baseline: null,
    failures: [],
  }
  if (input.baseline) {
    const compatibility = baselineCompatibilityIssues(input.baseline, {
      hardware: input.hardware,
      datasetIdentity: input.datasetIdentity,
      config,
    })
    const regressionFailures = [...compatibility]
    const limits = input.baseline.controlLimits || {}
    regressionFailures.push(...validateControlLimits(limits))
    regressionFailures.push(...(input.acceptedEvidenceFailures || []))
    const comparisons = [
      ['library-ready P95', ready.p95, limits.libraryReadyP95Ms],
      ['main peak RSS P95', main.p95, limits.mainPeakRssP95MiB],
      ['child aggregate peak RSS P95', child.p95, limits.childPeakAggregateRssP95MiB],
      ['combined peak RSS P95', combined.p95, limits.combinedPeakRssP95MiB],
    ]
    for (const [label, current, limit] of comparisons) {
      if (!Number.isFinite(Number(limit)))
        regressionFailures.push(label + ' baseline limit is missing')
      else if (current > Number(limit))
        regressionFailures.push(label + ' exceeded its baseline limit')
    }
    if (!Number.isFinite(Number(limits.systemMinFreeFloorMiB))) {
      regressionFailures.push('system free memory baseline floor is missing')
    } else if (free.min < limits.systemMinFreeFloorMiB) {
      regressionFailures.push('system free memory fell below its baseline floor')
    }
    failures.push(...regressionFailures)
    comparison = {
      status: regressionFailures.length ? 'regressed' : 'passed',
      baseline: input.baselinePath,
      failures: regressionFailures,
    }
  } else if (input.mode === 'compare') {
    failures.push('compare mode requires an immutable accepted baseline')
    comparison = {
      status: 'missing-control',
      baseline: null,
      failures: ['compare mode requires an immutable accepted baseline'],
    }
  } else if (input.mode === 'establish') {
    warnings.push(
      'This run establishes the first control limits; future runs compare against them.',
    )
  } else {
    warnings.push('Diagnostic runs never establish or update the accepted performance baseline.')
  }
  return {
    ok: failures.length === 0,
    failures,
    warnings,
    metrics,
    absoluteBudgets: Object.fromEntries(
      Object.entries(absoluteBudgets).map(([key, value]) => [key, rounded(value)]),
    ),
    controlLimits,
    comparison,
  }
}

function fixedConfig(options) {
  return {
    sample: options.sample,
    runs: REQUIRED_RUNS,
    pipeline: 'overlap',
    backend: options.backend,
    jobs: options.jobs,
    batchSize: options.batchSize,
    requestedScanWorkers: FIXED_SCAN_WORKERS,
    tensorPrefetch: false,
    deferThumbnails: true,
    verifyWarm: true,
    stageMetrics: true,
    timelineMaxBytes: TIMELINE_MAX_BYTES,
    timelineMaxEvents: TIMELINE_MAX_EVENTS,
  }
}

function ensureManagedRoot(options) {
  const projectRoot = fs.realpathSync(options.projectRoot)
  const candidate = canonicalPathForCreate(options.baselineRoot)
  if (!isPathInside(projectRoot, candidate, { allowEqual: false })) {
    throw new Error('Managed baseline root must remain inside the repository')
  }
  if (!fs.existsSync(options.baselineRoot)) fs.mkdirSync(options.baselineRoot, { recursive: true })
  const managedRoot = fs.realpathSync(options.baselineRoot)
  if (!isPathInside(projectRoot, managedRoot, { allowEqual: false })) {
    throw new Error('Canonical managed baseline root escaped the repository')
  }
  return managedRoot
}

function writeJsonExclusive(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  })
}

function relativeManagedArtifactPath(managedRoot, artifactPath) {
  const relative = path.relative(managedRoot, artifactPath)
  if (
    !relative ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Round artifact must remain inside the managed baseline root')
  }
  return relative.split(path.sep).join('/')
}

async function withFailClosedManagedRunWorkspace(options, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const workspace = acquireManagedRunWorkspace(options)
  let callbackResult
  let callbackError = null
  try {
    callbackResult = await callback(workspace)
  } catch (error) {
    callbackError = error
  }
  const preserveWorkspace =
    callbackError?.preserveManagedWorkspace === true ||
    ACTIVE_CHILDREN.size > 0 ||
    BLOCKED_SANDBOXES.size > 0
  if (preserveWorkspace) {
    process.stderr.write(
      '[fixed-baseline] retained the managed workspace lock because process shutdown is unconfirmed\n',
    )
    if (callbackError) throw callbackError
    const failure = new Error(
      'Managed workspace cannot be released while benchmark shutdown is unconfirmed',
    )
    failure.code = 'PROCESS_TREE_UNCONFIRMED'
    failure.preserveManagedWorkspace = true
    throw failure
  }
  workspace.release()
  if (callbackError) throw callbackError
  return callbackResult
}

async function finalizeActiveBenchmarkProcesses(options = {}) {
  const failures = []
  for (const child of [...ACTIVE_CHILDREN]) {
    const roundEnvironment = ACTIVE_CHILD_SANDBOXES.get(child)
    try {
      const evidence = await terminateProcessTreeAndConfirm(child, {
        ...(options.processTreeOptions || {}),
        tracker: ACTIVE_PROCESS_TRACKERS.get(child),
        timeoutMs: options.timeoutMs ?? PROCESS_TREE_CONFIRM_TIMEOUT_MS,
      })
      if (!evidence.safeToCleanup) {
        if (roundEnvironment) markSandboxProcessTreeUnconfirmed(roundEnvironment)
        failures.push('process shutdown remained unconfirmed; sandbox retained')
        continue
      }
      ACTIVE_CHILDREN.delete(child)
      ACTIVE_CHILD_SANDBOXES.delete(child)
      ACTIVE_PROCESS_TRACKERS.delete(child)
      ACTIVE_TERMINATORS.delete(child)
      if (roundEnvironment) {
        if (QUARANTINED_SANDBOXES.has(roundEnvironment.rootPath)) {
          failures.push('lifecycle barrier failure sandbox remains quarantined')
        } else {
          cleanupRoundEnvironment(roundEnvironment, { processTreeConfirmed: true })
        }
      }
    } catch (error) {
      if (roundEnvironment) {
        try {
          markSandboxProcessTreeUnconfirmed(roundEnvironment)
        } catch {
          // Preserve the original shutdown failure and retain every known sandbox.
        }
      }
      failures.push(
        'process shutdown confirmation failed: ' +
          String(error instanceof Error ? error.message : error).slice(0, 2_000),
      )
    }
  }
  return { ok: failures.length === 0, failures }
}

function installSignalCleanup() {
  let receivedSignal = null
  const handlers = new Map()
  const handle = (signal) => {
    receivedSignal = signal
    for (const child of [...ACTIVE_CHILDREN]) {
      const terminateAndConfirm = ACTIVE_TERMINATORS.get(child)
      if (terminateAndConfirm) {
        void terminateAndConfirm('the ' + signal + ' shutdown signal')
      } else {
        terminateProcessTree(child)
      }
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => handle(signal)
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  return {
    get receivedSignal() {
      return receivedSignal
    },
    handle,
    dispose() {
      for (const [signal, handler] of handlers) process.off(signal, handler)
    },
  }
}

function stabilityControl(evidence) {
  return {
    ...evidence,
    controlLimits: {
      libraryReadyP95Ms: 1,
      mainPeakRssP95MiB: 1,
      childPeakAggregateRssP95MiB: 1,
      combinedPeakRssP95MiB: 1,
      systemMinFreeFloorMiB: 0,
    },
  }
}

function renderMarkdown(report) {
  const metrics = report.metrics
  const rows = report.rounds
    .map(
      (round) =>
        '| ' +
        round.round +
        ' | ' +
        round.libraryReadyMs +
        ' | ' +
        round.mainPeakRssMiB +
        ' | ' +
        round.childPeakAggregateRssMiBApprox +
        ' | ' +
        round.combinedPeakRssMiBApprox +
        ' | ' +
        round.systemMinFreeMiB +
        ' |',
    )
    .join('\n')
  return [
    '# 固定硬件首次建库三轮性能基线',
    '',
    '- 生成时间：' + report.generatedAt,
    '- 固定硬件：`' + report.hardware.id + '`',
    '- 素材：' + report.config.sample + ' 张；连续运行：' + report.config.runs + ' 次',
    '- 门禁：**' + (report.ok ? '通过' : '失败') + '**',
    '- 模式：' + report.mode + ' / ' + report.comparison.status,
    '',
    '| 轮次 | 首次 Ready ms | 主进程 RSS MiB | 子进程 RSS MiB | 合计 RSS MiB | 系统最低空闲 MiB |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    rows,
    '',
    '## 汇总与控制线',
    '',
    '- 首次 Ready P50/P95：' +
      metrics.libraryReadyMs.p50 +
      ' / ' +
      metrics.libraryReadyMs.p95 +
      ' ms',
    '- 首次 Ready 三轮极差：' + metrics.libraryReadyMs.spreadPercent + '%',
    '- 合计 RSS P50/P95：' +
      metrics.combinedPeakRssMiBApprox.p50 +
      ' / ' +
      metrics.combinedPeakRssMiBApprox.p95 +
      ' MiB',
    '- 后续 Ready P95 上限：' + report.controlLimits.libraryReadyP95Ms + ' ms',
    '- 后续合计 RSS P95 上限：' + report.controlLimits.combinedPeakRssP95MiB + ' MiB',
    '',
    '## 失败项',
    '',
    report.failures.length ? report.failures.map((item) => '- ' + item).join('\n') : '- 无',
    '',
    '## 解释边界',
    '',
    '- 只有三次观测，因此 P95 等于三次中的最大值。',
    '- 这是连续、隔离用户目录的首次建库，不等同于重启机器后的冷启动。',
    '- 子进程 RSS 只覆盖直接子进程且为近似值；合计峰值采用保守相加。',
    '- GPU 指标是设备全局指标，不按本进程归因。',
    '- Ready 表示后端素材库可搜索，不表示渲染器首屏完成。',
    '',
    '每轮 JSON、有界 stdout/stderr 与 NDJSON 时间线保存在同一目录；素材目录只读，真实用户数据由前后元数据快照证明未变化。',
    '',
  ].join('\n')
}

function printHelp() {
  process.stdout.write(
    [
      'Usage:',
      '  node scripts/run-fixed-hardware-performance-baseline.cjs [options]',
      '',
      'Runs exactly three consecutive, isolated first-build measurements.',
      '',
      'Options:',
      '  --dataset=<dir>       Read-only fixed corpus',
      '  --sample=4..1000      Deterministic sample; formal mode requires 1000',
      '  --backend=cpu|gpu     Diagnostic override; formal mode requires gpu',
      '  --jobs=1|2            Diagnostic override; formal mode requires 2',
      '  --batch-size=1..16    Diagnostic override; formal mode requires 4',
      '  --timeout-ms=<n>      Per-round timeout (default: 900000)',
      '  --output-dir=<dir>    Child of the managed fixed baseline root',
      '  --establish           Create the one-time immutable accepted baseline',
      '  --promote             Atomically accept a passing, non-looser three-round comparison',
      '  --diagnostic          Run a non-promotable smaller-sample diagnostic',
      '                       (default mode compares with immutable latest.json)',
      '  --plan                Validate and print the plan without writing artifacts',
      '',
    ].join('\n'),
  )
}

async function runMain(dependencies = {}) {
  validateOrchestratorStartupEnvironment({
    environment: dependencies.environment ?? process.env,
    execArgv: dependencies.execArgv ?? process.execArgv,
  })
  const options = parseArgs(dependencies.argv ?? process.argv.slice(2), dependencies)
  if (options.help) return printHelp()
  const datasetEntry = fs.lstatSync(options.dataset)
  if (datasetEntry.isSymbolicLink() || !datasetEntry.isDirectory()) {
    throw new Error('Dataset must be a regular, non-symlink directory')
  }
  const datasetRealPath = fs.realpathSync(options.dataset)
  const hardwareBefore = collectHardware()
  if (options.plan) {
    let acceptedReport = null
    if (options.mode !== 'diagnostic' && fs.existsSync(options.baselineRoot)) {
      acceptedReport = resolveAcceptedBaseline({
        managedRoot: options.baselineRoot,
        mode: options.mode === 'promote' ? 'compare' : options.mode,
      }).reportPath
    } else if (['compare', 'promote'].includes(options.mode)) {
      throw new Error('Compare/promote mode requires an existing managed baseline root')
    }
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          mode: options.mode,
          dataset: datasetRealPath,
          outputDirectory: options.outputDirectory,
          hardware: hardwareBefore,
          acceptedReport,
          config: fixedConfig(options),
          evidenceCaptureDeferred: true,
          formalPreflight: requiresAcceptedBaselinePreflight(options.mode)
            ? {
                admissionBeforeWorkspace: true,
                requiredBeforeEveryRound: true,
                quietWindowMs: 600_000,
                gpuBaselineSource: 'immutable fixed-hardware accepted pointer',
              }
            : null,
          writesArtifacts: false,
        },
        null,
        2,
      ) + '\n',
    )
    return
  }
  if (['compare', 'promote'].includes(options.mode) && !fs.existsSync(options.baselineRoot)) {
    throw new Error('Compare/promote mode requires an existing immutable accepted baseline')
  }
  const managedRoot = ensureManagedRoot(options)
  const accepted =
    options.mode === 'diagnostic'
      ? null
      : resolveAcceptedBaseline({
          managedRoot,
          mode: options.mode === 'promote' ? 'compare' : options.mode,
        })
  let admissionPreflight = null
  if (requiresAcceptedBaselinePreflight(options.mode)) {
    process.stderr.write('[fixed-baseline] admission preflight started\n')
    admissionPreflight = await runAcceptedBaselineAdmissionPreflight(options, dependencies)
    if (admissionPreflight.evaluation.status !== 'passed') {
      throw new Error('Admission preflight failed before evidence capture: ' + preflightIssues(admissionPreflight))
    }
  }
  const signalCleanup = installSignalCleanup()
  try {
    await withFailClosedManagedRunWorkspace(
      {
        managedRoot,
        dataset: options.dataset,
        outputDirectory: options.outputDirectory,
      },
      async (workspace) => {
        options.outputDirectory = workspace.outputDirectory
        const config = fixedConfig(options)
        const evidenceOptions = {
          repoRoot: options.projectRoot,
          datasetRoot: options.dataset,
          modelsRoot: path.join(options.projectRoot, 'ai-models'),
          config,
        }
        process.stderr.write('[fixed-baseline] freezing dataset/runtime evidence\n')
        const sourceBefore = collectSoftwareFingerprint(options.projectRoot)
        const evidenceBefore = await buildEvidence(evidenceOptions)
        const userDataRoots = realUserDataRoots()
        const userDataBefore = snapshotUserDataRootsIsolated(userDataRoots, options.projectRoot)
        writeJsonExclusive(
          path.join(workspace.outputDirectory, 'evidence-before.json'),
          evidenceBefore,
        )
        writeJsonExclusive(
          path.join(workspace.outputDirectory, 'user-data-before.json'),
          userDataBefore,
        )

        const measured = []
        const formalPreflights = []
        for (let round = 1; round <= REQUIRED_RUNS; round += 1) {
          if (signalCleanup.receivedSignal)
            throw new Error('Interrupted by ' + signalCleanup.receivedSignal)
          if (requiresAcceptedBaselinePreflight(options.mode)) {
            process.stderr.write(
              '[fixed-baseline] formal preflight ' + round + '/' + REQUIRED_RUNS + ' started\n',
            )
            const preflight = await runPromotionPreflight(options, dependencies)
            formalPreflights.push({ round, ...preflight })
            if (preflight.evaluation.status !== 'passed') {
              throw new Error(
                'Formal preflight failed for ' +
                  options.mode +
                  ' round ' +
                  round +
                  ': ' +
                  preflightIssues(preflight),
              )
            }
          }
          process.stderr.write(
            '[fixed-baseline] round ' + round + '/' + REQUIRED_RUNS + ' started\n',
          )
          const result = await runMeasuredRound(options, round)
          measured.push(result)
          if (ACTIVE_CHILDREN.size !== 0)
            throw new Error('Benchmark process remained after round ' + round)
          process.stderr.write(
            '[fixed-baseline] round ' + round + '/' + REQUIRED_RUNS + ' completed\n',
          )
        }

        await verifyDatasetManifest(options.dataset, evidenceBefore.dataset)
        const evidenceAfter = await buildEvidence(evidenceOptions)
        const userDataAfter = snapshotUserDataRootsIsolated(userDataRoots, options.projectRoot)
        const userDataComparison = compareCompactUserDataSnapshots(userDataBefore, userDataAfter)
        writeJsonExclusive(
          path.join(workspace.outputDirectory, 'evidence-after.json'),
          evidenceAfter,
        )
        writeJsonExclusive(
          path.join(workspace.outputDirectory, 'user-data-after.json'),
          userDataAfter,
        )

        const stability = compareEvidence(stabilityControl(evidenceBefore), evidenceAfter, {
          implementationMode: 'stable',
        })
        const acceptedEvidence = compareAcceptedBaselineEvidence(accepted, evidenceAfter)
        const hardwareAfter = collectHardware()
        const sourceAfter = collectSoftwareFingerprint(options.projectRoot)
        const runs = measured.map((item) => item.report)
        const evaluation = evaluateBaseline({
          mode: options.mode,
          runs,
          roundProofs: measured.map((item) => item.orchestration),
          config,
          hardware: hardwareAfter,
          hardwareBeforeId: hardwareBefore.id,
          hardwareAfterId: hardwareAfter.id,
          datasetUnchanged: evidenceBefore.dataset.identity === evidenceAfter.dataset.identity,
          datasetIdentity: evidenceAfter.dataset.identity,
          sourceUnchanged: sourceBefore.digest === sourceAfter.digest,
          userDataUnchanged: userDataComparison.ok === true,
          evidenceStabilityFailures: stability.failures,
          acceptedEvidenceFailures: acceptedEvidence.failures,
          baseline: accepted?.report || null,
          baselinePath: accepted?.reportPath || null,
        })
        const reportEvidence = { ...evidenceAfter, controlLimits: evaluation.controlLimits }
        const report = {
          schemaVersion: 1,
          kind: 'fixed-hardware-first-build-baseline',
          generatedAt: new Date().toISOString(),
          mode: options.mode,
          ok: evaluation.ok,
          status: evaluation.ok ? 'passed' : 'failed',
          config,
          hardware: hardwareAfter,
          evidence: reportEvidence,
          implementationComparison: acceptedEvidence.implementation,
          software: {
            sourceBefore,
            sourceAfter,
            before: evidenceBefore.implementation,
            after: evidenceAfter.implementation,
            git: getGitMetadata(options.projectRoot),
          },
          dataset: {
            path: datasetRealPath,
            identity: evidenceAfter.dataset.identity,
            unchanged: evidenceBefore.dataset.identity === evidenceAfter.dataset.identity,
            selectedImageCount: evidenceAfter.dataset.selectedImageCount,
            contentManifestSha256: evidenceAfter.dataset.identity,
          },
          metrics: evaluation.metrics,
          absoluteBudgets: evaluation.absoluteBudgets,
          controlLimits: evaluation.controlLimits,
          comparison: evaluation.comparison,
          warnings: evaluation.warnings,
          failures: evaluation.failures,
          ...(requiresAcceptedBaselinePreflight(options.mode)
            ? { admissionPreflight, formalPreflights }
            : {}),
          ...(options.mode === 'promote'
            ? {
                promotion: {
                  schemaVersion: 1,
                  previousAcceptedAt: accepted.pointer.acceptedAt,
                  previousReportFile: accepted.pointer.reportFile,
                  previousReportSha256: accepted.reportSha256,
                },
              }
            : {}),
          safety: {
            sourceFilesUnchanged: runs.every((run) => run.safety?.sourceUnchanged === true),
            isolatedUserData: runs.every((run) => run.safety?.isolatedUserData === true),
            realLibraryWritten:
              userDataComparison.changed === true || userDataComparison.fail === true,
            realUserDataProof: userDataComparison,
            noBenchmarkChildrenAtEnd: ACTIVE_CHILDREN.size === 0,
            boundedLogs: true,
            boundedTimelines: runs.every((run) => run.timeline?.bytesWritten <= TIMELINE_MAX_BYTES),
          },
          rounds: runs.map((run, index) => ({
            round: index + 1,
            runNonce: run.execution.runNonce,
            tempDirectoryId: run.execution.tempDirectoryId,
            startedAt: run.execution.startedAt,
            finishedAt: run.execution.finishedAt,
            parentStartedAt: measured[index].orchestration.startedAt,
            parentFinishedAt: measured[index].orchestration.finishedAt,
            libraryReadyMs: run.phases.libraryReadyMs,
            totalMs: run.phases.totalMs,
            mainPeakRssMiB: run.resources.memory.mainPeakRssMiB,
            childPeakAggregateRssMiBApprox: run.resources.memory.childPeakAggregateRssMiBApprox,
            combinedPeakRssMiBApprox: rounded(
              run.resources.memory.mainPeakRssMiB +
                run.resources.memory.childPeakAggregateRssMiBApprox,
            ),
            systemMinFreeMiB: run.resources.memory.systemMinFreeMiB,
            gpuPeakDeltaUsedMiB: run.resources.gpu?.peakDeltaUsedMiB ?? null,
            nativeDigest: run.scan.digest.sha256,
            dinoDigest: run.embeddingDigests.dino.stableSha256,
            clipDigest: run.embeddingDigests.clip.stableSha256,
            effectiveProviders: run.providerEvidence,
            reportSha256: measured[index].orchestration.reportSha256,
            reportBytes: measured[index].orchestration.reportBytes,
            reportFile: relativeManagedArtifactPath(managedRoot, measured[index].reportPath),
            timelineFile: relativeManagedArtifactPath(managedRoot, measured[index].timelinePath),
            timelineSha256: measured[index].orchestration.timelineSha256,
            timelineBytes: measured[index].orchestration.timelineBytes,
            timeline: measured[index].orchestration.timeline,
            sandbox: measured[index].orchestration.sandbox,
          })),
        }
        const reportPath = path.join(workspace.outputDirectory, 'report.json')
        const markdownPath = path.join(workspace.outputDirectory, 'report.md')
        writeJsonExclusive(reportPath, report)
        fs.writeFileSync(markdownPath, renderMarkdown(report), { encoding: 'utf8', flag: 'wx' })
        if (report.ok && options.mode === 'establish') {
          commitAcceptedBaseline({ managedRoot, mode: 'establish', reportPath })
        } else if (report.ok && options.mode === 'promote') {
          commitPromotedBaseline({
            managedRoot,
            reportPath,
            expectedPreviousReportSha256: accepted.reportSha256,
          })
        }
        process.stdout.write(
          JSON.stringify(
            {
              ok: report.ok,
              status: report.status,
              mode: report.comparison.status,
              outputDirectory: workspace.outputDirectory,
              acceptedBaselineUpdated: report.ok && ['establish', 'promote'].includes(options.mode),
              hardwareId: report.hardware.id,
              datasetIdentity: report.dataset.identity,
              environmentIdentity: report.evidence.environment.identity,
              implementationIdentity: report.evidence.implementation.identity,
              metrics: report.metrics,
              controlLimits: report.controlLimits,
              failures: report.failures,
            },
            null,
            2,
          ) + '\n',
        )
        if (!report.ok) process.exitCode = 1
      },
    )
  } finally {
    signalCleanup.dispose()
    const processFinalization = await finalizeActiveBenchmarkProcesses()
    for (const failure of processFinalization.failures) {
      process.stderr.write('[fixed-baseline] ' + failure + '\n')
    }
    if (!processFinalization.ok) {
      process.exitCode = 1
    }
    for (const [rootPath, tempParent] of [...ACTIVE_SANDBOXES]) {
      if (BLOCKED_SANDBOXES.has(rootPath)) {
        process.stderr.write('[fixed-baseline] unconfirmed process sandbox retained\n')
        process.exitCode = 1
        continue
      }
      try {
        cleanupRoundEnvironment({ rootPath, tempParent })
      } catch (error) {
        process.stderr.write(
          '[fixed-baseline] sandbox cleanup failed: ' +
            String(error instanceof Error ? error.message : error).slice(0, 2_000) +
            '\n',
        )
        process.exitCode = 1
      }
    }
  }
}

if (require.main === module) {
  runMain().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = {
  BASELINE_ROOT,
  REQUIRED_RUNS,
  baselineCompatibilityIssues,
  buildControlLimits,
  cleanupRoundEnvironment,
  collectHardware,
  collectSoftwareFingerprint,
  compareAcceptedBaselineEvidence,
  createControlledNodeSpawnEnvironment,
  createRoundEnvironment,
  evaluateBaseline,
  finalizeActiveBenchmarkProcesses,
  fingerprint,
  inspectProcessTree,
  installSignalCleanup,
  listSystemProcesses,
  markSandboxProcessTreeUnconfirmed,
  noResidualLifecycleFailures,
  parseArgs,
  parseWmicProcessRows,
  publishLifecycleBarrierFile,
  realUserDataRoots,
  relativeManagedArtifactPath,
  requiresAcceptedBaselinePreflight,
  runAcceptedBaselineAdmissionPreflight,
  runPromotionPreflight,
  runMain,
  runMeasuredRound,
  snapshotUserDataRootsIsolated,
  summarizeValues,
  spreadPercent,
  terminateProcessTree,
  terminateProcessTreeAndConfirm,
  validateRound,
  validateOrchestratorStartupEnvironment,
  waitForLifecycleReady,
  withFailClosedManagedRunWorkspace,
}
