'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { startRuntimeMemorySampler } = require('./runtime-memory-process-sampler.cjs')
const { startNvidiaGpuSampler } = require('./runtime-memory-gpu-sampler.cjs')
const {
  collectRuntimeMemoryPreflight,
  evaluateRuntimeMemoryPreflight,
  resolveAcceptedGpuBaseline,
} = require('./runtime-memory-preflight.cjs')

const SCENARIO_IDS = Object.freeze([
  'cold-start',
  'image-search',
  'text-search',
  'video-single',
  'video-folder',
  'first-build',
  'cancel',
  'search-soak',
  'ui-churn',
  'model-session',
  'gpu-lifecycle',
  'thumbnail-matrix',
  'dino-fused-shadow',
  'mixed-soak',
])
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

function optionValue(argv, name) {
  return argv.find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3)
}

function parsePositiveInteger(raw, fallback, maximum, label) {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`)
  }
  return value
}

function parseArgs(argv, dependencies = {}) {
  const knownBoolean = new Set(['--plan', '--help', '-h', '--formal'])
  const knownValues = new Set([
    'scenario',
    'runs',
    'cycles',
    'timeout-ms',
    'dataset',
    'video-file',
    'video-folder',
    'output-dir',
    'duration-min',
    'thumbnail-samples',
    'thumbnail-jobs',
    'model-repetitions',
  ])
  for (const entry of argv) {
    if (knownBoolean.has(entry)) continue
    const match = /^--([^=]+)=/.exec(entry)
    if (!match || !knownValues.has(match[1])) {
      throw new Error(`Unknown runtime memory benchmark argument: ${entry}`)
    }
  }
  const requested = (optionValue(argv, 'scenario') || 'all')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const scenarios = requested.includes('all') ? [...SCENARIO_IDS] : [...new Set(requested)]
  const unknown = scenarios.filter((entry) => !SCENARIO_IDS.includes(entry))
  if (unknown.length > 0) throw new Error(`Unknown runtime memory scenario: ${unknown.join(', ')}`)
  const projectRoot = path.resolve(dependencies.projectRoot || path.resolve(__dirname, '..'))
  return {
    projectRoot,
    plan: argv.includes('--plan'),
    help: argv.includes('--help') || argv.includes('-h'),
    formal: argv.includes('--formal'),
    scenarios,
    runs: parsePositiveInteger(optionValue(argv, 'runs'), 1, 3, '--runs'),
    cycles: parsePositiveInteger(optionValue(argv, 'cycles'), 100, 10_000, '--cycles'),
    durationMin: parsePositiveInteger(
      optionValue(argv, 'duration-min'),
      120,
      8 * 60,
      '--duration-min',
    ),
    thumbnailSamples: parsePositiveInteger(
      optionValue(argv, 'thumbnail-samples'),
      argv.includes('--formal') ? 10_000 : 8,
      10_000,
      '--thumbnail-samples',
    ),
    thumbnailJobs: (() => {
      const value = parsePositiveInteger(
        optionValue(argv, 'thumbnail-jobs'),
        2,
        8,
        '--thumbnail-jobs',
      )
      if (![1, 2, 8].includes(value)) throw new Error('--thumbnail-jobs must be 1, 2, or 8')
      return value
    })(),
    modelRepetitions: parsePositiveInteger(
      optionValue(argv, 'model-repetitions'),
      3,
      3,
      '--model-repetitions',
    ),
    timeoutMs: parsePositiveInteger(
      optionValue(argv, 'timeout-ms'),
      DEFAULT_TIMEOUT_MS,
      8 * 60 * 60 * 1000,
      '--timeout-ms',
    ),
    dataset: optionValue(argv, 'dataset') || '',
    videoFile: optionValue(argv, 'video-file') || '',
    videoFolder: optionValue(argv, 'video-folder') || '',
    outputDir: (() => {
      const allowedRoot = path.join(projectRoot, 'artifacts', 'benchmark', 'runtime-memory')
      const resolved = path.resolve(optionValue(argv, 'output-dir') || allowedRoot)
      const relative = path.relative(allowedRoot, resolved)
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('--output-dir must stay under artifacts/benchmark/runtime-memory')
      }
      return resolved
    })(),
  }
}

function isRegularPath(candidate, expected) {
  if (!candidate) return false
  try {
    const entry = fs.lstatSync(path.resolve(candidate))
    if (entry.isSymbolicLink()) return false
    return expected === 'file' ? entry.isFile() : entry.isDirectory()
  } catch {
    return false
  }
}

function imageCacheReady(projectRoot) {
  const userData = path.join(process.env.APPDATA || '', 'floating-clock-electron')
  const cache = path.join(userData, 'vector-db', 'embedding-cache')
  return [
    path.join(cache, 'dinov2_vitb14__global.f16'),
    path.join(cache, 'dinov2_vitb14__global.f16.json'),
    path.join(cache, 'dinov2_vitb14__global.paths.jsonl'),
    path.join(projectRoot, 'dist-electron', 'vectorAnnWorker.js'),
  ].every((candidate) => isRegularPath(candidate, 'file'))
}

function textCacheReady(projectRoot) {
  const userData = path.join(process.env.APPDATA || '', 'floating-clock-electron')
  const cache = path.join(userData, 'vector-db', 'embedding-cache')
  return [
    path.join(cache, 'clip_vit_base_patch32__global.f16'),
    path.join(cache, 'clip_vit_base_patch32__global.f16.json'),
    path.join(cache, 'clip_vit_base_patch32__global.paths.jsonl'),
    path.join(userData, 'asset-library', 'assets.jsonl'),
    path.join(projectRoot, 'artifacts', 'neko-search-annotation', 'dataset.json'),
    path.join(projectRoot, 'artifacts', 'neko-search-annotation', 'judgments.json'),
    path.join(projectRoot, 'dist-electron', 'vectorAnnWorker.js'),
  ].every((candidate) => isRegularPath(candidate, 'file'))
}

function modelSessionReady() {
  const appRoot = path.join(process.env.APPDATA || '', 'floating-clock-electron')
  return [
    path.join(appRoot, 'runtimes', 'video-semantic-llama-cpp', 'installation-receipt.json'),
    path.join(
      appRoot,
      'media-search',
      'semantic',
      'benchmarks',
      'qwen3-vl-2b-profile-final',
      'full-plan.json',
    ),
    path.join(appRoot, 'media-search', 'manifests', 'video_frames.jsonl'),
  ].every((candidate) => isRegularPath(candidate, 'file'))
}

function scenarioDefinitions(options, dependencies = {}) {
  const node = dependencies.nodeExecutable || process.execPath
  const at = (...parts) => path.join(options.projectRoot, ...parts)
  const evidenceRunId =
    dependencies.evidenceRunId || `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
  const common = {
    cwd: options.projectRoot,
    timeoutMs: options.timeoutMs,
    captureGpu: true,
  }
  return [
    {
      ...common,
      id: 'cold-start',
      command: node,
      args: [
        at('tests', 'electron-ui-smoke.cjs'),
        `--artifact-parent=${path.join(options.outputDir, 'ui-smoke')}`,
      ],
      ready: true,
      requirement: 'renderer build and Electron UI smoke runtime',
      evidenceKind: 'process-exit',
      memoryRequired: true,
      outputDir: options.outputDir,
    },
    {
      ...common,
      id: 'image-search',
      command: node,
      args: [at('tests', 'vector-ann-real-benchmark.cjs'), '12'],
      ready: imageCacheReady(options.projectRoot),
      requirement: 'built ANN worker and existing read-only DINO F16 cache',
      evidenceKind: 'image-search-json',
      memoryRequired: true,
      outputDir: options.outputDir,
    },
    {
      ...common,
      id: 'text-search',
      command: node,
      args: [at('tests', 'neko-search-ann-benchmark.cjs'), '3'],
      ready: textCacheReady(options.projectRoot),
      requirement: 'built ANN worker, read-only CLIP cache, and fixed judged query corpus',
      evidenceKind: 'text-search-json',
      memoryRequired: true,
      outputDir: options.outputDir,
    },
    {
      ...common,
      id: 'video-single',
      command: node,
      args: [
        at('tests', 'media-search-library-preparation-benchmark.cjs'),
        options.videoFile,
        '--limit=1',
        '--compact',
      ],
      ready: isRegularPath(options.videoFile, 'file'),
      requirement: '--video-file must name one regular, non-symlink video file',
      evidenceKind: 'video-json',
      memoryRequired: true,
      outputDir: options.outputDir,
    },
    {
      ...common,
      id: 'video-folder',
      command: node,
      args: [
        at('tests', 'media-search-library-preparation-benchmark.cjs'),
        options.videoFolder,
        '--limit=3',
        '--compact',
      ],
      ready: isRegularPath(options.videoFolder, 'directory'),
      requirement: '--video-folder must name one regular, non-symlink directory',
      evidenceKind: 'video-json',
      memoryRequired: true,
      outputDir: options.outputDir,
    },
    {
      ...common,
      id: 'first-build',
      command: node,
      args: [
        at('scripts', 'run-fixed-hardware-performance-baseline.cjs'),
        `--dataset=${options.dataset}`,
        ...(options.formal ? [] : ['--diagnostic', '--sample=4']),
      ],
      ready: isRegularPath(options.dataset, 'directory'),
      requirement: '--dataset must name a regular, non-symlink read-only image corpus',
      evidenceKind: 'first-build-json',
      memoryRequired: true,
      outputDir: options.outputDir,
    },
    {
      ...common,
      id: 'cancel',
      command: node,
      args: [
        '--test',
        at('tests', 'unified-task-scheduler.test.cjs'),
        at('tests', 'image-search-shutdown.test.cjs'),
      ],
      ready: true,
      requirement: 'production cancellation and shutdown regression tests',
      evidenceKind: 'process-exit',
      memoryRequired: false,
      captureGpu: false,
      outputDir: options.outputDir,
    },
    {
      ...common,
      id: 'search-soak',
      command: node,
      args: [at('scripts', 'run-runtime-memory-search-soak.cjs'), `--cycles=${options.cycles}`],
      ready: imageCacheReady(options.projectRoot),
      requirement: 'built ANN worker and existing read-only DINO F16 cache',
      evidenceKind: 'search-soak-json',
      requestedCycles: options.cycles,
      memoryRequired: true,
      outputDir: options.outputDir,
    },
    {
      ...common,
      id: 'ui-churn',
      command: node,
      args: [
        at('tests', 'electron-ui-smoke.cjs'),
        `--churn-cycles=${options.cycles}`,
        `--artifact-parent=${path.join(options.outputDir, 'ui-smoke')}`,
      ],
      ready: true,
      requirement: 'renderer build and Electron UI lifecycle smoke runtime',
      evidenceKind: 'ui-churn-json',
      requestedCycles: options.cycles,
      memoryRequired: true,
      outputDir: options.outputDir,
    },
    {
      ...common,
      id: 'model-session',
      command: node,
      args: [
        at('scripts', 'run-runtime-memory-model-session.cjs'),
        `--repetitions=${options.modelRepetitions}`,
        `--output-dir=${path.join(options.outputDir, 'model-session')}`,
      ],
      ready: modelSessionReady(),
      requirement:
        'installed pinned llama.cpp runtime and fixed eight-profile frame corpus are required',
      evidenceKind: 'model-session-json',
      requestedCycles: options.modelRepetitions * 8,
      memoryRequired: true,
      gpuRequired: true,
      lifecyclePlateauRequired: true,
      gpuLifecyclePlateauRequired: true,
      outputDir: options.outputDir,
    },
    {
      ...common,
      id: 'gpu-lifecycle',
      command: node,
      args: [
        at('tests', 'electron-ui-smoke.cjs'),
        `--churn-cycles=${Math.min(options.cycles, 600)}`,
        `--thumbnail-source=${options.dataset}`,
        `--thumbnail-samples=${options.thumbnailSamples}`,
        `--artifact-parent=${path.join(options.outputDir, 'ui-smoke')}`,
      ],
      ready: isRegularPath(options.dataset, 'directory'),
      requirement:
        '--dataset must name a regular, non-symlink image corpus for thumbnail GPU evidence',
      evidenceKind: 'gpu-lifecycle-json',
      requestedCycles: Math.min(options.cycles, 600),
      memoryRequired: true,
      gpuRequired: true,
      env: {
        FLOATING_CLOCK_THUMBNAIL_GPU_SMOKE_JOBS: String(options.thumbnailJobs),
      },
      outputDir: options.outputDir,
    },
    {
      ...common,
      id: 'thumbnail-matrix',
      command: node,
      args: [
        at('scripts', 'run-runtime-memory-thumbnail-matrix.cjs'),
        `--dataset=${options.dataset}`,
        `--samples=${options.thumbnailSamples}`,
        '--cycles=1',
        `--timeout-ms=${options.timeoutMs}`,
        `--output-dir=${path.join(options.outputDir, 'thumbnail-matrix', evidenceRunId)}`,
      ],
      ready: isRegularPath(options.dataset, 'directory'),
      requirement:
        '--dataset must name a regular, non-symlink image corpus for the 1/2/8 thumbnail matrix',
      evidenceKind: 'thumbnail-matrix-json',
      requestedSamples: options.thumbnailSamples,
      memoryRequired: true,
      gpuRequired: true,
      outputDir: options.outputDir,
    },
    {
      ...common,
      id: 'dino-fused-shadow',
      command: node,
      args: [
        at('scripts', 'run-dino-fused-shadow-matrix.cjs'),
        `--dataset=${options.dataset}`,
        '--sample=1000',
        '--runs=3',
        ...(options.formal ? ['--formal'] : []),
        `--output-dir=${path.join(options.outputDir, 'dino-fused-shadow', evidenceRunId)}`,
      ],
      ready: isRegularPath(options.dataset, 'directory'),
      requirement:
        '--dataset must name a regular, non-symlink image corpus for the 1000-image DINO AB/BA/AB gate',
      evidenceKind: 'dino-fused-shadow-json',
      requestedSamples: 1_000,
      requestedMatrixRuns: 3,
      formalExpected: options.formal,
      selfManagedFormalPreflight: options.formal,
      memoryRequired: true,
      gpuRequired: true,
      timeoutMs: options.formal ? Math.max(options.timeoutMs, 90 * 60 * 1000) : options.timeoutMs,
      outputDir: options.outputDir,
    },
    {
      ...common,
      id: 'mixed-soak',
      command: node,
      args: [
        at('scripts', 'run-runtime-memory-mixed-soak.cjs'),
        `--duration-min=${options.durationMin}`,
        `--output-dir=${path.join(options.outputDir, 'mixed-soak')}`,
      ],
      timeoutMs: Math.max(options.timeoutMs, (options.durationMin + 30) * 60 * 1000),
      ready: fs.existsSync(at('scripts', 'run-runtime-memory-mixed-soak.cjs')),
      requirement:
        'mixed-soak runner, read-only search corpus, UI lifecycle fixture, and model/GPU fixtures',
      evidenceKind: 'mixed-soak-json',
      memoryRequired: true,
      outputDir: options.outputDir,
    },
  ].filter((definition) => options.scenarios.includes(definition.id))
}

function appendBounded(state, chunk) {
  if (state.truncated) return
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  const available = MAX_CAPTURE_BYTES - state.bytes
  if (value.length > available) {
    state.parts.push(value.subarray(0, Math.max(0, available)))
    state.bytes = MAX_CAPTURE_BYTES
    state.truncated = true
    return
  }
  state.parts.push(value)
  state.bytes += value.length
}

function outputText(state) {
  return Buffer.concat(state.parts).toString('utf8')
}

function linearSlopeBytesPerMinute(samples, field) {
  if (samples.length < 2) return null
  const origin = Date.parse(samples[0].sampledAt)
  const points = samples.map((sample) => ({
    x: (Date.parse(sample.sampledAt) - origin) / 60_000,
    y: Number(sample.aggregate[field]) || 0,
  }))
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length
  let numerator = 0
  let denominator = 0
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY)
    denominator += (point.x - meanX) ** 2
  }
  return denominator > 0 ? Math.round(numerator / denominator) : null
}

function summarizeLifecycleWindows(samples, windows) {
  if (!Array.isArray(windows) || windows.length < 1) return { status: 'not-requested' }
  const rows = []
  for (const window of windows) {
    const startedAtMs = Date.parse(window?.startedAt)
    const completedAtMs = Date.parse(window?.completedAt)
    if (
      !Number.isFinite(startedAtMs) ||
      !Number.isFinite(completedAtMs) ||
      completedAtMs <= startedAtMs
    ) {
      return { status: 'incomplete', error: 'invalid lifecycle window' }
    }
    const selected = samples.filter((sample) => {
      const sampledAtMs = Date.parse(sample.sampledAt)
      return sampledAtMs >= startedAtMs && sampledAtMs <= completedAtMs
    })
    if (selected.length < 2) {
      return { status: 'incomplete', error: 'lifecycle window lacks samples' }
    }
    const ending = selected.slice(-Math.min(4, selected.length))
    rows.push({
      profileId: typeof window.profileId === 'string' ? window.profileId : 'default',
      repetition: Number(window.repetition) || 1,
      sampleCount: selected.length,
      peakPrivateBytes: Math.max(
        ...selected.map((sample) => Number(sample.aggregate.privateBytes)),
      ),
      peakWorkingSetBytes: Math.max(
        ...selected.map((sample) => Number(sample.aggregate.workingSetBytes)),
      ),
      endingPrivateBytes: Math.min(
        ...ending.map((sample) => Number(sample.aggregate.privateBytes)),
      ),
      endingWorkingSetBytes: Math.min(
        ...ending.map((sample) => Number(sample.aggregate.workingSetBytes)),
      ),
    })
  }
  const byProfile = new Map()
  for (const row of rows) {
    const group = byProfile.get(row.profileId) || []
    group.push(row)
    byProfile.set(row.profileId, group)
  }
  let maxPeakPrivateGrowthBytes = Number.NEGATIVE_INFINITY
  let maxEndingPrivateGrowthBytes = Number.NEGATIVE_INFINITY
  let minimumRepetitions = Number.POSITIVE_INFINITY
  for (const group of byProfile.values()) {
    group.sort((left, right) => left.repetition - right.repetition)
    minimumRepetitions = Math.min(minimumRepetitions, group.length)
    maxPeakPrivateGrowthBytes = Math.max(
      maxPeakPrivateGrowthBytes,
      group.at(-1).peakPrivateBytes - group[0].peakPrivateBytes,
    )
    maxEndingPrivateGrowthBytes = Math.max(
      maxEndingPrivateGrowthBytes,
      group.at(-1).endingPrivateBytes - group[0].endingPrivateBytes,
    )
  }
  const enoughRepetitions = minimumRepetitions >= 3
  return {
    status: enoughRepetitions ? 'passed' : 'incomplete',
    rows,
    gate: {
      passed:
        enoughRepetitions &&
        maxPeakPrivateGrowthBytes <= 128 * 1024 * 1024 &&
        maxEndingPrivateGrowthBytes <= 64 * 1024 * 1024,
      minimumRepetitions,
      maxPeakPrivateGrowthBytes,
      maxEndingPrivateGrowthBytes,
      peakGrowthLimitBytes: 128 * 1024 * 1024,
      endingGrowthLimitBytes: 64 * 1024 * 1024,
    },
  }
}

function summarizeMemorySamples(samples, outputFile, outputDir) {
  const peak = {
    workingSetBytes: 0,
    privateBytes: 0,
    commitBytes: 0,
    processCount: 0,
  }
  const rolePeakPrivateBytes = {}
  let minimumFreePhysicalMemoryBytes = Number.POSITIVE_INFINITY
  for (const sample of samples) {
    for (const field of ['workingSetBytes', 'privateBytes', 'commitBytes', 'processCount']) {
      peak[field] = Math.max(peak[field], Number(sample.aggregate[field]) || 0)
    }
    minimumFreePhysicalMemoryBytes = Math.min(
      minimumFreePhysicalMemoryBytes,
      Number(sample.system.freePhysicalMemoryBytes),
    )
    const byRole = {}
    for (const processRecord of sample.processes) {
      byRole[processRecord.role] =
        (byRole[processRecord.role] || 0) + Number(processRecord.privateBytes || 0)
    }
    for (const [role, bytes] of Object.entries(byRole)) {
      rolePeakPrivateBytes[role] = Math.max(rolePeakPrivateBytes[role] || 0, bytes)
    }
  }
  const first = samples[0]
  const last = samples.at(-1)
  const lateSamples = samples.slice(Math.floor(samples.length / 3))
  return {
    status: 'passed',
    sampleCount: samples.length,
    intervalMs: first.intervalMs,
    startedAt: first.sampledAt,
    completedAt: last.sampledAt,
    rawSamples: path.relative(outputDir, outputFile).replaceAll('\\', '/'),
    peak,
    rolePeakPrivateBytes,
    minimumFreePhysicalMemoryBytes,
    final: last.aggregate,
    lateWindow: {
      sampleCount: lateSamples.length,
      workingSetSlopeBytesPerMinute: linearSlopeBytesPerMinute(lateSamples, 'workingSetBytes'),
      privateBytesSlopeBytesPerMinute: linearSlopeBytesPerMinute(lateSamples, 'privateBytes'),
      commitSlopeBytesPerMinute: linearSlopeBytesPerMinute(lateSamples, 'commitBytes'),
    },
  }
}

async function executeCommand(definition) {
  const stdout = { parts: [], bytes: 0, truncated: false }
  const stderr = { parts: [], bytes: 0, truncated: false }
  const startedAt = Date.now()
  const child = spawn(definition.command, definition.args, {
    cwd: definition.cwd,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(definition.env || {}) },
  })
  child.stdout.on('data', (chunk) => appendBounded(stdout, chunk))
  child.stderr.on('data', (chunk) => appendBounded(stderr, chunk))

  let gpuSampler = null
  let gpuSamplerError = ''
  if (definition.captureGpu) {
    try {
      gpuSampler = await startNvidiaGpuSampler({ intervalMs: 1_000 })
    } catch (error) {
      gpuSamplerError = error instanceof Error ? error.message : String(error)
    }
  }

  let sampler = null
  let samplerError = ''
  let stopFile = ''
  if (definition.memoryRequired) {
    try {
      fs.mkdirSync(definition.outputDir, { recursive: true })
      const sampleDirectory = fs.mkdtempSync(
        path.join(definition.outputDir, `${definition.id}-samples-`),
      )
      const outputFile = path.join(sampleDirectory, 'process-tree.jsonl')
      stopFile = path.join(sampleDirectory, 'stop')
      sampler = await startRuntimeMemorySampler({
        rootPid: child.pid,
        outputFile,
        stopFile,
        readyFile: path.join(sampleDirectory, 'ready'),
        intervalMs: 250,
      })
    } catch (error) {
      samplerError = error instanceof Error ? error.message : String(error)
    }
  }

  let timedOut = false
  const processResult = await new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, definition.timeoutMs)
    child.once('error', (error) => finish({ exitCode: null, spawnError: error.message }))
    child.once('exit', (exitCode) => {
      if (stopFile && !fs.existsSync(stopFile)) {
        try {
          fs.writeFileSync(stopFile, 'stop', 'utf8')
        } catch {
          // Sampler cleanup/read errors are preserved in the result below.
        }
      }
      finish({ exitCode, spawnError: '' })
    })
  })

  let memory = definition.memoryRequired
    ? { status: 'incomplete', error: samplerError || 'runtime memory sampler did not start' }
    : { status: 'not-required' }
  let processSamples = []
  if (sampler) {
    try {
      processSamples = await sampler.stop()
      memory = summarizeMemorySamples(processSamples, sampler.outputFile, definition.outputDir)
    } catch (error) {
      memory = {
        status: 'incomplete',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  const commandReport = parseJsonOutput(outputText(stdout))
  if (processSamples.length > 0 && Array.isArray(commandReport?.lifecycleWindows)) {
    memory.lifecycle = summarizeLifecycleWindows(processSamples, commandReport.lifecycleWindows)
  }
  let gpu = definition.captureGpu
    ? { status: 'incomplete', error: gpuSamplerError || 'GPU sampler did not start' }
    : { status: 'not-required' }
  if (gpuSampler) {
    try {
      gpu = await gpuSampler.stop(commandReport?.lifecycleWindows)
    } catch (error) {
      gpu = {
        status: 'incomplete',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  memory.gpu = gpu
  return {
    exitCode: processResult.exitCode,
    durationMs: Date.now() - startedAt,
    stdout: outputText(stdout),
    stderr: processResult.spawnError || outputText(stderr),
    timedOut,
    truncated: stdout.truncated || stderr.truncated,
    memory,
  }
}

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(String(stdout || '').trim())
  } catch {
    return null
  }
}

function hasFinite(object, pathParts) {
  let value = object
  for (const part of pathParts) value = value?.[part]
  return Number.isFinite(Number(value))
}

function validateEvidence(kind, execution, definition = {}) {
  if (execution.timedOut) return { status: 'failed', failures: ['scenario timed out'] }
  if (execution.truncated)
    return { status: 'incomplete', incomplete: ['scenario output exceeded its bound'] }
  const report = parseJsonOutput(execution.stdout)
  if (execution.exitCode !== 0) {
    if (report?.status === 'incomplete') {
      return {
        status: 'incomplete',
        evidence: report,
        incomplete: [
          typeof report.reason === 'string'
            ? report.reason
            : `scenario exited with ${execution.exitCode} and reported incomplete evidence`,
        ],
      }
    }
    return { status: 'failed', failures: [`scenario exited with ${execution.exitCode}`] }
  }
  if (kind === 'process-exit') return { status: 'passed', evidence: { exitCode: 0 } }
  if (!report) return { status: 'incomplete', incomplete: ['scenario JSON evidence is missing'] }
  const missing = []
  let gatePassed = true
  if (kind === 'image-search-json') {
    for (const field of [['samples'], ['prewarm', 'wallMs'], ['exactP95Ms'], ['annP95Ms']]) {
      if (!hasFinite(report, field)) missing.push(field.join('.'))
    }
    if (report.safety?.sourceFilesUnchanged !== true) missing.push('safety.sourceFilesUnchanged')
    gatePassed = report.gate?.passed === true
  } else if (kind === 'search-soak-json') {
    if (!['passed', 'failed'].includes(report.status)) missing.push('status')
    if (!hasFinite(report, ['requestedCycles'])) missing.push('requestedCycles')
    if (!hasFinite(report, ['completedCycles'])) missing.push('completedCycles')
    if (!hasFinite(report, ['prewarmMs'])) missing.push('prewarmMs')
    if (!hasFinite(report, ['searchP95Ms'])) missing.push('searchP95Ms')
    if (report.stableResultDigests !== true) missing.push('stableResultDigests')
    if (report.safety?.sourceFilesUnchanged !== true) missing.push('safety.sourceFilesUnchanged')
    gatePassed =
      report.status === 'passed' &&
      report.completedCycles === report.requestedCycles &&
      report.stableResultDigests === true &&
      report.safety?.sourceFilesUnchanged === true
  } else if (kind === 'text-search-json') {
    for (const field of [
      ['exact', 'p95Ms'],
      ['ann', 'p95Ms'],
      ['ann', 'prewarmMs'],
    ]) {
      if (!hasFinite(report, field)) missing.push(field.join('.'))
    }
    if (report.safety?.sourceFilesUnchanged !== true) missing.push('safety.sourceFilesUnchanged')
    gatePassed = report.gate?.passed === true
  } else if (kind === 'video-json') {
    if (report.ok !== true) missing.push('ok')
    if (!hasFinite(report, ['sourceVideoCount'])) missing.push('sourceVideoCount')
    if (!hasFinite(report, ['phases', 'libraryReadyMs'])) missing.push('phases.libraryReadyMs')
    if (report.safety?.sourceUnchanged !== true) missing.push('safety.sourceUnchanged')
  } else if (kind === 'first-build-json') {
    if (!['passed', 'failed'].includes(report.status)) missing.push('status')
    if (!Array.isArray(report.rounds) || report.rounds.length !== 3) missing.push('rounds[3]')
    gatePassed = report.status === 'passed'
  } else if (kind === 'ui-churn-json') {
    const churn = report.snapshot?.lifecycleChurnCheck
    const metrics = churn?.rendererMetrics
    if (report.ok !== true) missing.push('ok')
    if (!Number.isInteger(churn?.requestedCycles)) missing.push('requestedCycles')
    if (!Number.isInteger(churn?.completedCycles)) missing.push('completedCycles')
    if (churn?.finalPanelPresent !== true) missing.push('finalPanelPresent')
    for (const field of ['documents', 'jsEventListeners', 'nodes', 'usedHeapBytes']) {
      if (!Number.isFinite(Number(metrics?.delta?.[field]))) {
        missing.push(`rendererMetrics.delta.${field}`)
      }
    }
    gatePassed =
      report.ok === true &&
      churn?.completedCycles === churn?.requestedCycles &&
      churn?.requestedCycles > 0 &&
      metrics?.delta?.documents <= 1 &&
      metrics?.delta?.nodes <= 500 &&
      metrics?.delta?.jsEventListeners <= 50 &&
      metrics?.delta?.usedHeapBytes <= 64 * 1024 * 1024
  } else if (kind === 'gpu-lifecycle-json') {
    const churn = report.snapshot?.lifecycleChurnCheck
    const gpu = report.runtimeCheck?.thumbnailGpu
    if (report.ok !== true) missing.push('ok')
    if (!Number.isInteger(churn?.completedCycles)) missing.push('completedCycles')
    if (gpu?.attempted !== true) missing.push('thumbnailGpu.attempted')
    if (gpu?.completed !== true) missing.push('thumbnailGpu.completed')
    if (report.thumbnailSourceUnchanged !== true) missing.push('thumbnailSourceUnchanged')
    gatePassed =
      report.ok === true &&
      churn?.completedCycles === churn?.requestedCycles &&
      gpu?.completed === true &&
      report.thumbnailSourceUnchanged === true
  } else if (kind === 'thumbnail-matrix-json') {
    const expectedJobs = [1, 2, 8]
    const expectedSamples = Number(definition.requestedSamples)
    if (report.schema !== 'siftory-runtime-memory-thumbnail-matrix/v1') missing.push('schema')
    if (!['passed', 'failed'].includes(report.status)) missing.push('status')
    if (!Number.isInteger(report.samples)) missing.push('samples')
    if (!Array.isArray(report.variants) || report.variants.length !== expectedJobs.length) {
      missing.push('variants[3]')
    }
    if (report.safety?.sourceUnchanged !== true) missing.push('safety.sourceUnchanged')
    if (report.safety?.artifactBoundaryMaintained !== true) {
      missing.push('safety.artifactBoundaryMaintained')
    }
    const variants = Array.isArray(report.variants) ? report.variants : []
    const variantsPass =
      variants.length === expectedJobs.length &&
      variants.every(
        (variant, index) =>
          variant?.requestedJobs === expectedJobs[index] &&
          variant?.status === 'passed' &&
          variant?.requestedSamples === expectedSamples &&
          variant?.effectiveGpuJobs === variant.requestedJobs &&
          Number.isInteger(variant?.effectiveGpuLanes) &&
          variant.effectiveGpuLanes >= 1 &&
          variant.effectiveGpuLanes <= variant.requestedJobs &&
          variant?.gpuCompleted === expectedSamples &&
          variant?.cpuCompleted === 0 &&
          variant?.fallbackCount === 0 &&
          variant?.sourceUnchanged === true,
      )
    gatePassed =
      report.status === 'passed' &&
      report.samples === expectedSamples &&
      variantsPass &&
      report.safety?.sourceUnchanged === true &&
      report.safety?.artifactBoundaryMaintained === true
  } else if (kind === 'dino-fused-shadow-json') {
    const expectedSamples = Number(definition.requestedSamples)
    const expectedRuns = Number(definition.requestedMatrixRuns)
    if (report.schema !== 'siftory-dino-fused-shadow-matrix/v1') missing.push('schema')
    if (!['passed', 'failed'].includes(report.status)) missing.push('status')
    if (report.config?.sample !== expectedSamples) missing.push('config.sample')
    if (report.config?.runs !== expectedRuns) missing.push('config.runs')
    if (!Array.isArray(report.rounds) || report.rounds.length !== expectedRuns * 2) {
      missing.push(`rounds[${expectedRuns * 2}]`)
    }
    for (const field of ['scanDigest', 'dinoDigest', 'clipDigest']) {
      if (!/^[a-f0-9]{64}$/i.test(String(report.parity?.[field] || ''))) {
        missing.push(`parity.${field}`)
      }
    }
    if (report.safety?.sourceReadOnly !== true) missing.push('safety.sourceReadOnly')
    if (report.safety?.isolatedUserData !== true) missing.push('safety.isolatedUserData')
    if (report.safety?.noBenchmarkChildProcessesAtStop !== true) {
      missing.push('safety.noBenchmarkChildProcessesAtStop')
    }
    const expectedOrder = [
      [1, 'baseline'],
      [1, 'candidate'],
      [2, 'candidate'],
      [2, 'baseline'],
      [3, 'baseline'],
      [3, 'candidate'],
    ]
    const orderPass =
      Array.isArray(report.rounds) &&
      report.rounds.length === expectedOrder.length &&
      report.rounds.every(
        (round, index) =>
          round?.round === expectedOrder[index][0] && round?.mode === expectedOrder[index][1],
      )
    const formalPreflights = Array.isArray(report.formalPreflights) ? report.formalPreflights : []
    const formalPass =
      definition.formalExpected !== true ||
      (report.formal === true &&
        formalPreflights.length === expectedRuns &&
        formalPreflights.every(
          (preflight, index) =>
            preflight?.round === index + 1 &&
            JSON.stringify(preflight?.order) ===
              JSON.stringify(index === 1 ? ['B', 'A'] : ['A', 'B']) &&
            preflight?.evaluation?.status === 'passed' &&
            preflight?.gpuBaseline?.schema === 'siftory-accepted-gpu-baseline/v1' &&
            /^[a-f0-9]{64}$/i.test(preflight?.gpuBaseline?.reportSha256 || ''),
        ) &&
        new Set(formalPreflights.map((entry) => entry.gpuBaseline.reportSha256)).size === 1)
    gatePassed =
      report.status === 'passed' &&
      report.gate?.passed === true &&
      report.config?.sample === expectedSamples &&
      report.config?.runs === expectedRuns &&
      Array.isArray(report.rounds) &&
      report.rounds.length === expectedRuns * 2 &&
      orderPass &&
      formalPass &&
      report.safety?.sourceReadOnly === true &&
      report.safety?.isolatedUserData === true &&
      report.safety?.noBenchmarkChildProcessesAtStop === true
  } else if (kind === 'mixed-soak-json') {
    if (report.status !== 'passed') missing.push('status')
    if (!hasFinite(report, ['completedCycles'])) missing.push('completedCycles')
    if (!hasFinite(report, ['targetDurationMs'])) missing.push('targetDurationMs')
    if (!hasFinite(report, ['actualDurationMs'])) missing.push('actualDurationMs')
    if (report.safety?.sourceFilesUnchanged !== true) missing.push('safety.sourceFilesUnchanged')
    if (report.safety?.artifactBoundaryMaintained !== true) {
      missing.push('safety.artifactBoundaryMaintained')
    }
    const workload = report.workload || {}
    const sharesPass = [
      ['search', 0.6],
      ['uiChurn', 0.2],
      ['cancelRecovery', 0.1],
      ['playbackModel', 0.1],
    ].every(([id, share]) => Math.abs(Number(workload[id]?.share) - share) < Number.EPSILON)
    gatePassed =
      report.status === 'passed' &&
      report.completedCycles > 0 &&
      report.actualDurationMs >= report.targetDurationMs &&
      report.safety?.sourceFilesUnchanged === true &&
      report.safety?.artifactBoundaryMaintained === true &&
      sharesPass
  } else if (kind === 'model-session-json') {
    if (report.status !== 'passed') missing.push('status')
    if (report.profileCount !== 8) missing.push('profileCount')
    if (![1, 2, 3].includes(report.repetitions)) missing.push('repetitions')
    if (!hasFinite(report, ['completedCycles'])) missing.push('completedCycles')
    if (report.safety?.sourceFilesUnchanged !== true) missing.push('safety.sourceFilesUnchanged')
    gatePassed =
      report.status === 'passed' &&
      report.completedCycles === report.profileCount * report.repetitions &&
      report.safety?.sourceFilesUnchanged === true
  }
  if (missing.length > 0) {
    return { status: 'incomplete', incomplete: missing.map((field) => `missing ${field}`) }
  }
  if (!gatePassed) return { status: 'failed', failures: ['scenario quality gate failed'] }
  return {
    status: 'passed',
    evidence: report,
    completedUnits:
      kind === 'image-search-json'
        ? Number(report.samples)
        : kind === 'search-soak-json'
          ? Number(report.completedCycles)
          : kind === 'ui-churn-json' || kind === 'gpu-lifecycle-json'
            ? Number(report.snapshot.lifecycleChurnCheck.completedCycles)
            : kind === 'thumbnail-matrix-json'
              ? Number(report.samples) * 3
              : kind === 'dino-fused-shadow-json'
                ? Number(report.config.sample) * Number(report.config.runs) * 2
                : kind === 'mixed-soak-json'
                  ? Number(report.completedCycles)
                  : kind === 'model-session-json'
                    ? Number(report.completedCycles)
                    : 1,
  }
}

async function runScenario(definition, dependencies = {}) {
  if (!definition.ready) {
    return {
      id: definition.id,
      status: 'incomplete',
      incomplete: [definition.requirement],
      attempts: [],
    }
  }
  const execute = dependencies.executeCommand || executeCommand
  const attempts = []
  const repetitions = definition.repetitions || 1
  for (let index = 0; index < repetitions; index += 1) {
    try {
      const execution = await execute(definition, index)
      const validation = validateEvidence(definition.evidenceKind, execution, definition)
      const memoryIncomplete =
        (definition.memoryRequired && execution.memory?.status !== 'passed') ||
        (definition.gpuRequired && execution.memory?.gpu?.status !== 'passed') ||
        (definition.lifecyclePlateauRequired &&
          execution.memory?.lifecycle?.gate?.passed !== true) ||
        (definition.gpuLifecyclePlateauRequired &&
          execution.memory?.gpu?.lifecycle?.gate?.passed !== true)
      const status =
        validation.status === 'failed'
          ? 'failed'
          : memoryIncomplete
            ? 'incomplete'
            : validation.status
      attempts.push({
        index: index + 1,
        status,
        durationMs: execution.durationMs,
        exitCode: execution.exitCode,
        failures: validation.failures || [],
        incomplete: [
          ...(validation.incomplete || []),
          ...(memoryIncomplete
            ? [
                `memory sampling incomplete: ${
                  execution.memory?.error ||
                  execution.memory?.gpu?.error ||
                  execution.memory?.lifecycle?.error ||
                  execution.memory?.gpu?.lifecycle?.error ||
                  'missing evidence'
                }`,
              ]
            : []),
        ],
        memory: execution.memory,
        ...((definition.evidenceKind === 'search-soak-json' ||
          definition.evidenceKind === 'dino-fused-shadow-json') &&
        validation.evidence
          ? { evidence: validation.evidence }
          : {}),
        completedUnits: status === 'passed' ? validation.completedUnits || 1 : 0,
      })
    } catch (error) {
      attempts.push({
        index: index + 1,
        status: 'failed',
        durationMs: 0,
        exitCode: null,
        failures: [error instanceof Error ? error.message : String(error)],
        incomplete: [],
        completedUnits: 0,
      })
    }
  }
  const failed = attempts.some((attempt) => attempt.status === 'failed')
  const incomplete = attempts.some((attempt) => attempt.status === 'incomplete')
  const completedCycles = definition.requestedCycles
    ? attempts.reduce((sum, attempt) => sum + attempt.completedUnits, 0)
    : undefined
  if (definition.requestedCycles && completedCycles < definition.requestedCycles) {
    return {
      id: definition.id,
      status: failed ? 'failed' : 'incomplete',
      requestedCycles: definition.requestedCycles,
      completedCycles,
      attempts,
    }
  }
  return {
    id: definition.id,
    status: failed ? 'failed' : incomplete ? 'incomplete' : 'passed',
    ...(definition.requestedCycles
      ? { requestedCycles: definition.requestedCycles, completedCycles }
      : {}),
    attempts,
  }
}

async function runFormalPreflight(options, dependencies = {}) {
  const resolveGpuBaseline = dependencies.resolveAcceptedGpuBaseline || resolveAcceptedGpuBaseline
  let gpuBaseline
  try {
    gpuBaseline = resolveGpuBaseline({ projectRoot: options.projectRoot })
  } catch (error) {
    return {
      snapshot: null,
      gpuBaseline: null,
      evaluation: {
        status: 'incomplete',
        failures: [],
        incomplete: [
          `accepted GPU baseline is unavailable or invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      },
    }
  }
  const collect = dependencies.collectRuntimeMemoryPreflight || collectRuntimeMemoryPreflight
  const evaluate = dependencies.evaluateRuntimeMemoryPreflight || evaluateRuntimeMemoryPreflight
  try {
    const snapshot = await collect({ cwd: options.projectRoot })
    return {
      snapshot,
      gpuBaseline,
      evaluation: evaluate(snapshot, {
        formal: true,
        gpuBaselineUsedMiB: gpuBaseline.usedMiB,
      }),
    }
  } catch (error) {
    return {
      snapshot: null,
      gpuBaseline,
      evaluation: {
        status: 'incomplete',
        failures: [],
        incomplete: [
          `formal preflight collection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      },
    }
  }
}

async function runScenarioMatrix(options, dependencies = {}) {
  const definitions = scenarioDefinitions(options, dependencies)
  const results = []
  const formalPreflights = []
  if (options.formal) {
    for (const definition of definitions) {
      let invalidatedByPreflight = null
      for (let round = 0; round < options.runs; round += 1) {
        if (definition.selfManagedFormalPreflight) {
          const result = await runScenario(definition, dependencies)
          results.push({ round: round + 1, ...result })
          const childPreflights = result.attempts?.[0]?.evidence?.formalPreflights
          if (Array.isArray(childPreflights)) {
            formalPreflights.push(
              ...childPreflights.map((preflight) => ({
                scenarioId: definition.id,
                matrixRound: round + 1,
                ...preflight,
              })),
            )
          } else {
            formalPreflights.push({
              scenarioId: definition.id,
              matrixRound: round + 1,
              delegated: true,
              status: result.status,
            })
          }
          continue
        }
        if (!invalidatedByPreflight) {
          const preflight = await runFormalPreflight(options, dependencies)
          formalPreflights.push({ scenarioId: definition.id, round: round + 1, ...preflight })
          if (preflight.evaluation.status !== 'passed') {
            invalidatedByPreflight = `${definition.id} formal round ${round + 1} preflight is ${preflight.evaluation.status}: ${[
              ...(preflight.evaluation.failures || []),
              ...(preflight.evaluation.incomplete || []),
            ].join('; ')}`
          }
        }
        if (invalidatedByPreflight) {
          results.push({
            round: round + 1,
            id: definition.id,
            status: 'incomplete',
            incomplete: [
              invalidatedByPreflight,
              `the whole formal group for ${definition.id} must be rerun`,
            ],
            attempts: [],
          })
          continue
        }
        const result = await runScenario(definition, dependencies)
        results.push({ round: round + 1, ...result })
      }
    }
  } else {
    for (let round = 0; round < options.runs; round += 1) {
      for (const definition of definitions) {
        const result = await runScenario(definition, dependencies)
        results.push({
          round: round + 1,
          ...result,
        })
      }
    }
  }
  const failed = results.filter((result) => result.status === 'failed').length
  const incomplete = results.filter((result) => result.status === 'incomplete').length
  return {
    schema: 'siftory-runtime-memory-scenarios/v1',
    generatedAt: new Date().toISOString(),
    status: failed > 0 ? 'failed' : incomplete > 0 ? 'incomplete' : 'passed',
    formal: options.formal,
    ...(options.formal ? { formalPreflights } : {}),
    summary: {
      total: results.length,
      passed: results.length - failed - incomplete,
      failed,
      incomplete,
    },
    results,
  }
}

function planScenarioMatrix(options, dependencies = {}) {
  return {
    schema: 'siftory-runtime-memory-scenario-plan/v1',
    writesArtifacts: false,
    runs: options.runs,
    cycles: options.cycles,
    durationMin: options.durationMin,
    formal: options.formal,
    formalPreflight: options.formal
      ? {
          requiredBeforeEveryRound: true,
          quietWindowMs: 10 * 60 * 1000,
          groupScope: 'one scenario across all requested rounds',
          wholeScenarioGroupInvalidatedOnFailure: true,
          gpuBaselineSource: 'immutable fixed-hardware accepted pointer',
        }
      : null,
    thumbnailSamples: options.thumbnailSamples,
    thumbnailJobs: options.thumbnailJobs,
    modelRepetitions: options.modelRepetitions,
    scenarios: scenarioDefinitions(options, dependencies).map((definition) => ({
      id: definition.id,
      status: definition.ready ? 'ready' : 'incomplete',
      requirement: definition.requirement,
      repetitions: definition.repetitions || 1,
    })),
  }
}

function writeReport(outputDir, report) {
  const resolved = path.resolve(outputDir)
  fs.mkdirSync(resolved, { recursive: true })
  const name = `runtime-memory-${report.generatedAt.replace(/[:.]/g, '-')}.json`
  const target = path.join(resolved, name)
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  return target
}

function printHelp() {
  process.stdout.write(`Usage:
  npm.cmd run benchmark:memory -- --plan
  npm.cmd run benchmark:memory -- --scenario=image-search --runs=3
  npm.cmd run benchmark:memory -- --scenario=video-single --video-file=<file>
  npm.cmd run benchmark:memory -- --scenario=video-folder --video-folder=<folder>
  npm.cmd run benchmark:memory -- --scenario=first-build --dataset=<folder> [--formal]
  npm.cmd run benchmark:memory -- --formal --runs=3
  npm.cmd run benchmark:memory -- --scenario=search-soak --cycles=100
  npm.cmd run benchmark:memory -- --scenario=ui-churn --cycles=600
  npm.cmd run benchmark:memory -- --formal --scenario=thumbnail-matrix --runs=3 --dataset=<folder>
  npm.cmd run benchmark:memory -- --formal --scenario=dino-fused-shadow --runs=1 --dataset=<folder>
  npm.cmd run benchmark:memory -- --scenario=mixed-soak --duration-min=120
`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return printHelp()
  if (options.plan) {
    process.stdout.write(`${JSON.stringify(planScenarioMatrix(options), null, 2)}\n`)
    return
  }
  const report = await runScenarioMatrix(options)
  const reportFile = writeReport(options.outputDir, report)
  process.stdout.write(
    `${JSON.stringify({ ...report, reportFile: path.basename(reportFile) }, null, 2)}\n`,
  )
  if (report.status !== 'passed') process.exitCode = 1
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = {
  SCENARIO_IDS,
  parseArgs,
  planScenarioMatrix,
  runScenario,
  runFormalPreflight,
  runScenarioMatrix,
  scenarioDefinitions,
  summarizeLifecycleWindows,
  summarizeMemorySamples,
  validateEvidence,
}
