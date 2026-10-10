'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  createFixedWindowsSystemEnvironment,
  resolveFixedHardwareSystemTools,
} = require('./fixed-hardware-system-tools.cjs')
const {
  readStableJsonFile,
  resolveAcceptedBaseline,
} = require('./fixed-hardware-baseline-ledger.cjs')

const GIB = 1024 ** 3
const FORMAL_QUIET_WINDOW_MS = 10 * 60 * 1000
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000
const GPU_BASELINE_TOLERANCE_MIB = 256
const MAX_CAPTURE_BYTES = 1024 * 1024
const MAX_ACCEPTED_GPU_ROUND_BYTES = 8 * 1024 * 1024

function nearestRank(values, ratio) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

function pairedOrderForRound(roundIndex) {
  if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex > 2) {
    throw new Error('Runtime memory paired round must be 0, 1, or 2')
  }
  return roundIndex === 1 ? ['B', 'A'] : ['A', 'B']
}

function resolveAcceptedGpuBaseline(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, '..'))
  const managedRoot = path.resolve(
    options.managedRoot ||
      path.join(projectRoot, 'artifacts', 'benchmark', 'fixed-hardware-first-build'),
  )
  const resolveBaseline = options.resolveBaseline || resolveAcceptedBaseline
  const readStable = options.readStable || readStableJsonFile
  const accepted = resolveBaseline({ managedRoot, mode: 'compare' })
  const rounds = accepted?.report?.rounds
  if (!Array.isArray(rounds) || rounds.length !== 3) {
    throw new Error('Accepted GPU baseline requires exactly three validated rounds')
  }
  const observations = rounds.map((round, index) => {
    if (typeof round?.reportFile !== 'string' || path.isAbsolute(round.reportFile)) {
      throw new Error(`Accepted GPU baseline round ${index + 1} report path is invalid`)
    }
    const reportPath = path.resolve(managedRoot, round.reportFile)
    const relative = path.relative(managedRoot, reportPath)
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Accepted GPU baseline round ${index + 1} escaped the managed root`)
    }
    const captured = readStable(reportPath, {
      label: `accepted GPU baseline round ${index + 1}`,
      maxBytes: MAX_ACCEPTED_GPU_ROUND_BYTES,
    })
    if (captured.sha256 !== round.reportSha256 || captured.bytes.length !== round.reportBytes) {
      throw new Error(`Accepted GPU baseline round ${index + 1} identity changed`)
    }
    const gpu = captured.value?.resources?.gpu
    for (const [field, value] of [
      ['baselineUsedMiB', gpu?.baselineUsedMiB],
      ['totalMiB', gpu?.totalMiB],
      ['deviceCount', gpu?.deviceCount],
    ]) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Accepted GPU baseline round ${index + 1} ${field} is invalid`)
      }
    }
    return {
      usedMiB: Number(gpu.baselineUsedMiB),
      totalMiB: Number(gpu.totalMiB),
      deviceCount: Number(gpu.deviceCount),
    }
  })
  const usedValues = observations.map((item) => item.usedMiB)
  const totalValues = new Set(observations.map((item) => item.totalMiB))
  const deviceCounts = new Set(observations.map((item) => item.deviceCount))
  const minimumUsedMiB = Math.min(...usedValues)
  const maximumUsedMiB = Math.max(...usedValues)
  if (totalValues.size !== 1 || deviceCounts.size !== 1) {
    throw new Error('Accepted GPU baseline hardware changed across rounds')
  }
  if (maximumUsedMiB - minimumUsedMiB > GPU_BASELINE_TOLERANCE_MIB) {
    throw new Error('Accepted GPU baseline spread exceeds 256 MiB')
  }
  return {
    schema: 'siftory-accepted-gpu-baseline/v1',
    usedMiB: maximumUsedMiB,
    minimumUsedMiB,
    maximumUsedMiB,
    totalMiB: observations[0].totalMiB,
    deviceCount: observations[0].deviceCount,
    rounds: observations.length,
    acceptedAt: accepted.pointer?.acceptedAt || null,
    reportFile: accepted.pointer?.reportFile || null,
    reportSha256: accepted.reportSha256 || accepted.pointer?.reportSha256 || null,
  }
}

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return false
  return Number.isFinite(Number(value)) && Number(value) >= 0
}

function evaluateRuntimeMemoryPreflight(snapshot, options = {}) {
  const formal = options.formal !== false
  const failures = []
  const incomplete = []
  const quietDurationMs = Number(snapshot?.quietWindow?.durationMs)
  const freeMemoryBytes = Number(snapshot?.memory?.freePhysicalMemoryBytes)
  const committedBytes = Number(snapshot?.memory?.committedBytes)
  const commitLimitBytes = Number(snapshot?.memory?.commitLimitBytes)
  const commitRatio = commitLimitBytes > 0 ? committedBytes / commitLimitBytes : null
  const gpuBaselineUsedMiB = finiteNonNegative(options.gpuBaselineUsedMiB)
    ? Number(options.gpuBaselineUsedMiB)
    : null
  const gpuInitialUsedMiB = Number(snapshot?.gpu?.usedMiB)

  if (snapshot?.power?.onAc !== true) failures.push('system is not on AC power')
  if (!finiteNonNegative(snapshot?.power?.processorMaxAcPercent)) {
    incomplete.push('processor maximum AC performance is unavailable')
  } else if (Number(snapshot.power.processorMaxAcPercent) < 100) {
    failures.push('processor maximum AC performance is below 100%')
  }
  if (!finiteNonNegative(snapshot?.power?.processorBoostMode)) {
    incomplete.push('processor boost mode is unavailable')
  } else if (Number(snapshot.power.processorBoostMode) < 1) {
    failures.push('processor boost mode is disabled')
  }
  if (!finiteNonNegative(freeMemoryBytes)) {
    incomplete.push('free physical memory is unavailable')
  } else if (freeMemoryBytes < 4 * GIB) {
    failures.push('free physical memory is below 4 GiB')
  }
  if (
    !finiteNonNegative(committedBytes) ||
    !finiteNonNegative(commitLimitBytes) ||
    commitLimitBytes <= 0 ||
    commitRatio === null
  ) {
    incomplete.push('system commit telemetry is unavailable')
  } else if (commitRatio > 0.75) {
    failures.push('system commit exceeds 75%')
  }
  if (
    !Number.isInteger(snapshot?.residualProductProcesses) ||
    snapshot.residualProductProcesses < 0
  ) {
    incomplete.push('residual product process count is unavailable')
  } else if (snapshot.residualProductProcesses > 0) {
    failures.push('residual Siftory processes are running')
  }
  if (!finiteNonNegative(gpuBaselineUsedMiB)) {
    incomplete.push('accepted GPU baseline is unavailable')
  }
  if (!finiteNonNegative(gpuInitialUsedMiB)) {
    incomplete.push('initial GPU usage is unavailable')
  } else if (
    finiteNonNegative(gpuBaselineUsedMiB) &&
    gpuInitialUsedMiB > gpuBaselineUsedMiB + GPU_BASELINE_TOLERANCE_MIB
  ) {
    failures.push('initial GPU usage exceeds the accepted baseline by more than 256 MiB')
  }

  if (!finiteNonNegative(quietDurationMs)) {
    incomplete.push('quiet-window duration is unavailable')
  } else if (formal && quietDurationMs < FORMAL_QUIET_WINDOW_MS) {
    incomplete.push('formal quiet window is shorter than 10 minutes')
  }
  for (const [label, value, limit] of [
    ['CPU', snapshot?.quietWindow?.cpuP95Percent, 20],
    ['disk', snapshot?.quietWindow?.diskP95Percent, 20],
    ['GPU', snapshot?.quietWindow?.gpuP95Percent, 10],
  ]) {
    if (!finiteNonNegative(value)) incomplete.push(`${label} quiet-window telemetry is unavailable`)
    else if (Number(value) > limit)
      failures.push(`${label} was not quiet during the preflight window`)
  }

  const status = failures.length > 0 ? 'failed' : incomplete.length > 0 ? 'incomplete' : 'passed'
  return {
    schemaVersion: 1,
    kind: 'runtime-memory-preflight-evaluation',
    status,
    formal,
    failures,
    incomplete,
    controls: {
      quietWindowMs: FORMAL_QUIET_WINDOW_MS,
      minimumFreeMemoryBytes: 4 * GIB,
      maximumCommitRatio: 0.75,
      gpuBaselineToleranceMiB: GPU_BASELINE_TOLERANCE_MIB,
      cpuQuietP95Percent: 20,
      diskQuietP95Percent: 20,
      gpuQuietP95Percent: 10,
    },
    observed: {
      freePhysicalMemoryBytes: finiteNonNegative(freeMemoryBytes) ? freeMemoryBytes : null,
      commitRatio,
      gpuInitialUsedMiB: finiteNonNegative(gpuInitialUsedMiB) ? gpuInitialUsedMiB : null,
      gpuBaselineUsedMiB: finiteNonNegative(gpuBaselineUsedMiB) ? gpuBaselineUsedMiB : null,
    },
  }
}

function evaluatePairedPreflightGroup(rounds) {
  if (!Array.isArray(rounds) || rounds.length !== 3) {
    return {
      status: 'incomplete',
      rerunWholeGroup: true,
      failures: ['exactly three paired preflight rounds are required'],
    }
  }
  const failures = []
  rounds.forEach((round, index) => {
    const expectedOrder = pairedOrderForRound(index)
    if (JSON.stringify(round?.order) !== JSON.stringify(expectedOrder)) {
      failures.push(`round ${index + 1} order differs from ${expectedOrder.join('')}`)
    }
    if (round?.preflight?.status !== 'passed') {
      failures.push(`round ${index + 1} preflight is ${round?.preflight?.status || 'missing'}`)
    }
  })
  return {
    status: failures.length === 0 ? 'passed' : 'invalid',
    rerunWholeGroup: failures.length > 0,
    failures,
  }
}

function parsePowerSetting(output) {
  const matches = [...String(output || '').matchAll(/0x([0-9a-f]{8})/gi)]
  if (matches.length < 2) return null
  return Number.parseInt(matches[matches.length - 2][1], 16)
}

function runBounded(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: options.timeoutMs || 15_000,
    maxBuffer: MAX_CAPTURE_BYTES,
    env: options.environment,
  })
  if (result.error || result.status !== 0) {
    throw new Error('Runtime memory preflight system query failed', {
      cause: result.error || new Error(`exit ${result.status}`),
    })
  }
  if (Buffer.byteLength(result.stdout || '', 'utf8') > MAX_CAPTURE_BYTES) {
    throw new Error('Runtime memory preflight system query exceeded its output bound')
  }
  return result.stdout
}

function collectWindowsSample(options) {
  const tools = options.systemTools
  const environment = options.systemEnvironment
  const script = [
    "$ErrorActionPreference='Stop'",
    '$os=Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory,TotalVisibleMemorySize',
    '$mem=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -Property CommittedBytes,CommitLimit',
    '$cpu=@(Get-CimInstance Win32_Processor -Property LoadPercentage)',
    "$disk=@(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Property Name,PercentDiskTime | Where-Object {$_.Name -eq '_Total'})",
    "$products=@(Get-CimInstance Win32_Process -Property ProcessId,Name,CommandLine,CreationDate | Where-Object {($_.Name -match '^(Siftory|floating-clock-electron)\\.exe$') -or (($_.Name -eq 'electron.exe') -and ($_.CommandLine -match '(siftory-desktop|floating-clock-electron(?:\\.asar|[/\\\\]dist-electron[/\\\\]main))'))})",
    '$battery=@(Get-CimInstance Win32_Battery -Property BatteryStatus -ErrorAction SilentlyContinue)',
    '$onAc=if($battery.Count -eq 0){$true}else{@($battery | Where-Object {$_.BatteryStatus -in 2,3,6,7,8,9,11}).Count -gt 0}',
    "[pscustomobject]@{sampledAt=[DateTime]::UtcNow.ToString('o');freePhysicalMemoryBytes=[uint64]$os.FreePhysicalMemory*1024;totalPhysicalMemoryBytes=[uint64]$os.TotalVisibleMemorySize*1024;committedBytes=[uint64]$mem.CommittedBytes;commitLimitBytes=[uint64]$mem.CommitLimit;cpuPercent=[double](($cpu|Measure-Object LoadPercentage -Average).Average);diskPercent=[double](($disk|Measure-Object PercentDiskTime -Maximum).Maximum);onAc=[bool]$onAc;residualProductProcesses=$products.Count} | ConvertTo-Json -Compress",
  ].join(';')
  const raw = runBounded(
    tools.powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { cwd: options.cwd, environment },
  )
  return JSON.parse(raw)
}

function collectNvidiaSample(options) {
  try {
    const output = runBounded(
      options.systemTools.nvidiaSmi,
      ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits'],
      { cwd: options.cwd, environment: options.systemEnvironment },
    )
    const rows = output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(',').map((part) => Number(part.trim())))
      .filter((row) => row.length >= 2 && row.every(Number.isFinite))
    if (rows.length === 0) return null
    return {
      usedMiB: rows.reduce((sum, row) => sum + row[0], 0),
      utilizationPercent: Math.max(...rows.map((row) => row[1])),
      deviceCount: rows.length,
    }
  } catch {
    return null
  }
}

function resolvePowerCfg(systemTools) {
  const candidate = path.win32.join(systemTools.systemRoot, 'System32', 'powercfg.exe')
  const entry = fs.lstatSync(candidate)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('Trusted powercfg is unavailable')
  const real = fs.realpathSync.native(candidate)
  if (real.toLowerCase() !== candidate.toLowerCase()) {
    throw new Error('Trusted powercfg identity changed')
  }
  return real
}

function collectPowerPolicy(options) {
  const powercfg = resolvePowerCfg(options.systemTools)
  const query = (setting) =>
    runBounded(powercfg, ['/QH', 'SCHEME_CURRENT', 'SUB_PROCESSOR', setting], {
      cwd: options.cwd,
      environment: options.systemEnvironment,
    })
  return {
    processorMaxAcPercent: parsePowerSetting(query('PROCTHROTTLEMAX')),
    processorBoostMode: parsePowerSetting(query('PERFBOOSTMODE')),
  }
}

function irrecoverablePreflightFailures(sample) {
  const failures = []
  if (sample?.onAc !== true) failures.push('AC power is unavailable')
  if (Number(sample?.freePhysicalMemoryBytes) < 4 * GIB) {
    failures.push('free physical memory is below 4 GiB')
  }
  const commitRatio = Number(sample?.committedBytes) / Number(sample?.commitLimitBytes)
  if (Number.isFinite(commitRatio) && commitRatio > 0.75) {
    failures.push('commit ratio exceeded 75%')
  }
  if (Number(sample?.residualProductProcesses) > 0) {
    failures.push('residual product processes were detected')
  }
  return failures
}

async function collectRuntimeMemoryPreflight(options = {}) {
  if (process.platform !== 'win32')
    throw new Error('Runtime memory formal preflight requires Windows')
  const systemTools = options.systemTools || resolveFixedHardwareSystemTools()
  const systemEnvironment =
    options.systemEnvironment ||
    createFixedWindowsSystemEnvironment({
      systemRoot: systemTools.systemRoot,
      comSpec: systemTools.comSpec,
    })
  const durationMs = Math.max(0, Number(options.durationMs ?? FORMAL_QUIET_WINDOW_MS))
  const intervalMs = Math.max(
    1_000,
    Math.min(30_000, Number(options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS)),
  )
  const startedAt = Date.now()
  const samples = []
  const gpus = []
  let earlyTermination = null
  do {
    const sample = collectWindowsSample({
      systemTools,
      systemEnvironment,
      cwd: options.cwd || process.cwd(),
    })
    samples.push(sample)
    const gpu = collectNvidiaSample({
      systemTools,
      systemEnvironment,
      cwd: options.cwd || process.cwd(),
    })
    if (gpu) gpus.push(gpu)
    const irrecoverable = irrecoverablePreflightFailures(sample)
    if (options.abortOnIrrecoverableFailure !== false && irrecoverable.length > 0) {
      earlyTermination = { reason: 'irrecoverable-formal-gate', failures: irrecoverable }
      break
    }
    const remaining = durationMs - (Date.now() - startedAt)
    if (remaining > 0)
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)))
  } while (Date.now() - startedAt < durationMs)
  const latest = samples.at(-1)
  const powerPolicy = collectPowerPolicy({
    systemTools,
    systemEnvironment,
    cwd: options.cwd || process.cwd(),
  })
  return {
    schemaVersion: 1,
    kind: 'runtime-memory-preflight-snapshot',
    sampledAt: new Date().toISOString(),
    power: { onAc: samples.every((sample) => sample.onAc === true), ...powerPolicy },
    memory: {
      freePhysicalMemoryBytes: Math.min(...samples.map((sample) => sample.freePhysicalMemoryBytes)),
      totalPhysicalMemoryBytes: latest.totalPhysicalMemoryBytes,
      committedBytes: Math.max(...samples.map((sample) => sample.committedBytes)),
      commitLimitBytes: Math.min(...samples.map((sample) => sample.commitLimitBytes)),
    },
    residualProductProcesses: Math.max(...samples.map((sample) => sample.residualProductProcesses)),
    gpu:
      gpus.length > 0
        ? {
            usedMiB: Math.max(...gpus.map((gpu) => gpu.usedMiB)),
            deviceCount: Math.max(...gpus.map((gpu) => gpu.deviceCount)),
          }
        : null,
    quietWindow: {
      durationMs: Date.now() - startedAt,
      samples: samples.length,
      intervalMs,
      cpuP95Percent: nearestRank(
        samples.map((sample) => sample.cpuPercent),
        0.95,
      ),
      diskP95Percent: nearestRank(
        samples.map((sample) => sample.diskPercent),
        0.95,
      ),
      gpuP95Percent: nearestRank(
        gpus.map((gpu) => gpu.utilizationPercent),
        0.95,
      ),
      earlyTermination,
    },
  }
}

function parseCliArgs(argv) {
  const value = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const known = new Set(['--plan', '--help', '-h'])
  for (const arg of argv) {
    if (known.has(arg) || /^--(?:duration-seconds|interval-ms|gpu-baseline-mib)=/.test(arg))
      continue
    throw new Error(`Unknown runtime memory preflight argument: ${arg}`)
  }
  const parsed = {
    plan: argv.includes('--plan'),
    help: argv.includes('--help') || argv.includes('-h'),
    durationMs:
      value('duration-seconds') === undefined
        ? FORMAL_QUIET_WINDOW_MS
        : Number(value('duration-seconds')) * 1000,
    intervalMs:
      value('interval-ms') === undefined
        ? DEFAULT_SAMPLE_INTERVAL_MS
        : Number(value('interval-ms')),
    gpuBaselineUsedMiB:
      value('gpu-baseline-mib') === undefined ? null : Number(value('gpu-baseline-mib')),
  }
  if (!finiteNonNegative(parsed.durationMs)) {
    throw new Error('Runtime memory preflight duration must be a non-negative number')
  }
  if (!finiteNonNegative(parsed.intervalMs) || parsed.intervalMs === 0) {
    throw new Error('Runtime memory preflight interval must be a positive number')
  }
  if (parsed.gpuBaselineUsedMiB !== null && !finiteNonNegative(parsed.gpuBaselineUsedMiB)) {
    throw new Error('Runtime memory preflight GPU baseline must be a non-negative number')
  }
  return parsed
}

function resolveCliGpuBaseline(options, dependencies = {}) {
  const formal = options.durationMs >= FORMAL_QUIET_WINDOW_MS
  if (!formal) {
    return options.gpuBaselineUsedMiB === null
      ? null
      : {
          schema: 'siftory-diagnostic-gpu-baseline/v1',
          usedMiB: options.gpuBaselineUsedMiB,
        }
  }
  const resolve = dependencies.resolveAcceptedGpuBaseline || resolveAcceptedGpuBaseline
  const accepted = resolve({ projectRoot: dependencies.projectRoot || process.cwd() })
  if (options.gpuBaselineUsedMiB !== null && options.gpuBaselineUsedMiB !== accepted.usedMiB) {
    throw new Error(
      `Formal GPU baseline override ${options.gpuBaselineUsedMiB} MiB does not match accepted ${accepted.usedMiB} MiB`,
    )
  }
  return accepted
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/runtime-memory-preflight.cjs [--plan] [--gpu-baseline-mib=N]\nFormal runs automatically bind the immutable accepted GPU baseline; an explicit value is diagnostic-only unless it exactly matches.\n',
    )
    return
  }
  if (options.plan) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, writesArtifacts: false, formalQuietWindowMs: FORMAL_QUIET_WINDOW_MS, gpuBaselineSource: 'immutable fixed-hardware accepted pointer', pairedOrder: [0, 1, 2].map(pairedOrderForRound) }, null, 2)}\n`,
    )
    return
  }
  const gpuBaseline = resolveCliGpuBaseline(options)
  const snapshot = await collectRuntimeMemoryPreflight(options)
  const evaluation = evaluateRuntimeMemoryPreflight(snapshot, {
    formal: options.durationMs >= FORMAL_QUIET_WINDOW_MS,
    gpuBaselineUsedMiB: gpuBaseline?.usedMiB ?? null,
  })
  process.stdout.write(`${JSON.stringify({ snapshot, gpuBaseline, evaluation }, null, 2)}\n`)
  if (evaluation.status !== 'passed') process.exitCode = 1
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = {
  FORMAL_QUIET_WINDOW_MS,
  GPU_BASELINE_TOLERANCE_MIB,
  collectRuntimeMemoryPreflight,
  evaluatePairedPreflightGroup,
  evaluateRuntimeMemoryPreflight,
  irrecoverablePreflightFailures,
  nearestRank,
  pairedOrderForRound,
  parsePowerSetting,
  resolveCliGpuBaseline,
  resolveAcceptedGpuBaseline,
}
