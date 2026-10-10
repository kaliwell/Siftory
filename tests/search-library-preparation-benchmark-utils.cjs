const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const {
  createFixedWindowsSystemEnvironment,
  resolveFixedHardwareSystemTools,
} = require('../scripts/fixed-hardware-system-tools.cjs')

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function mib(bytes) {
  return round(Number(bytes || 0) / 1024 / 1024)
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function snapshotFiles(filePaths) {
  let totalBytes = 0
  const rows = filePaths
    .map((filePath) => {
      const resolved = path.resolve(filePath)
      const stat = fs.statSync(resolved)
      totalBytes += stat.size
      return `${resolved.toLowerCase()}\u001f${stat.size}\u001f${stat.mtimeMs}`
    })
    .sort()
  return {
    count: rows.length,
    totalBytes,
    sha256: sha256Text(rows.join('\n')),
  }
}

function assertFileSnapshotUnchanged(before, after) {
  assert.deepEqual(after, before, 'Benchmark source files changed while preparing the library')
}

function writeJson(filePath, value) {
  const resolved = path.resolve(filePath)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.rmSync(resolved, { force: true })
  fs.renameSync(temporary, resolved)
}

function redactPaths(value, replacements) {
  const entries = replacements
    .filter(([target]) => typeof target === 'string' && target.length > 0)
    .map(([target, replacement]) => [
      new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
      replacement,
    ])
    .sort((left, right) => String(right[0]).length - String(left[0]).length)
  return JSON.parse(
    JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue !== 'string') return nestedValue
      return entries.reduce(
        (text, [pattern, replacement]) => text.replace(pattern, replacement),
        nestedValue,
      )
    }),
  )
}

function safeRemoveTempRoot(tempRoot, allowedPrefix) {
  const resolved = path.resolve(tempRoot)
  const tempDirectory = path.resolve(os.tmpdir())
  if (
    path.dirname(resolved).toLowerCase() !== tempDirectory.toLowerCase() ||
    !path.basename(resolved).startsWith(allowedPrefix)
  ) {
    throw new Error(`Refusing to remove unverified benchmark temp directory: ${resolved}`)
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}

function commandLabel(command) {
  const text = String(command || '').trim()
  return path.basename(text) || 'unknown'
}

function parseJson(text) {
  const normalized = String(text || '')
    .replace(/^\uFEFF/, '')
    .trim()
  return normalized ? JSON.parse(normalized) : null
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForFile(filePath, processHandle, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) return true
    if (processHandle && processHandle.exitCode !== null) return false
    await delay(25)
  }
  return false
}

function waitForProcessExit(processHandle, timeoutMs) {
  if (!processHandle || processHandle.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      processHandle.kill()
      resolve(false)
    }, timeoutMs)
    processHandle.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function startResourceMonitor(options = {}) {
  const intervalMs = Math.max(50, Math.min(1000, Number(options.intervalMs) || 100))
  const originalSpawn = childProcess.spawn
  const originalSpawnSync = childProcess.spawnSync
  const activePids = new Set()
  const spawnedByCommand = {}
  let spawned = 0
  let peakActive = 0
  let stopped = false
  let samplerRoot = ''
  let pidFile = ''
  let stopFile = ''
  let outputFile = ''
  let samplerProcess = null
  let samplerStderr = ''
  let samplerCheckpointDirectory = ''
  let samplerErrorFile = ''

  if (process.platform === 'win32') {
    const systemTools = options.systemTools || resolveFixedHardwareSystemTools()
    const systemEnvironment =
      options.systemEnvironment ||
      createFixedWindowsSystemEnvironment({
        systemRoot: systemTools.systemRoot,
        comSpec: systemTools.comSpec,
      })
    samplerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-resource-sampler-'))
    pidFile = path.join(samplerRoot, 'pids.txt')
    stopFile = path.join(samplerRoot, 'stop')
    outputFile = path.join(samplerRoot, 'result.json')
    samplerCheckpointDirectory = `${outputFile}.checkpoints`
    samplerErrorFile = `${outputFile}.error`
    const readyFile = path.join(samplerRoot, 'ready')
    fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8')
    samplerProcess = originalSpawn.call(
      childProcess,
      systemTools.powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'search-library-resource-sampler.ps1'),
        '-RootPid',
        String(process.pid),
        '-PidFile',
        pidFile,
        '-StopFile',
        stopFile,
        '-ReadyFile',
        readyFile,
        '-OutputFile',
        outputFile,
        '-IntervalMs',
        String(intervalMs),
        '-NvidiaSmiPath',
        systemTools.nvidiaSmi,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false,
        env: systemEnvironment,
      },
    )
    samplerProcess.stderr?.setEncoding('utf8')
    samplerProcess.stderr?.on('data', (chunk) => {
      samplerStderr += chunk
      if (samplerStderr.length > 64 * 1024) samplerStderr = samplerStderr.slice(-64 * 1024)
    })
    const ready = await waitForFile(readyFile, samplerProcess, 10_000)
    if (!ready) {
      await waitForProcessExit(samplerProcess, 1_000)
      safeRemoveTempRoot(samplerRoot, 'siftory-resource-sampler-')
      throw new Error(`Resource sampler failed to start: ${samplerStderr.trim() || 'timeout'}`)
    }
  }

  const startedAt = performance.now()
  const mainCpuStarted = process.cpuUsage()
  const resourceStarted = process.resourceUsage()
  let mainMemory = process.memoryUsage()
  let mainPeakRssBytes = mainMemory.rss
  let mainPeakHeapUsedBytes = mainMemory.heapUsed
  let mainPeakHeapTotalBytes = mainMemory.heapTotal
  let mainPeakExternalBytes = mainMemory.external
  let mainPeakArrayBuffersBytes = mainMemory.arrayBuffers
  let systemMinFreeBytes = os.freemem()
  const memoryTimer = setInterval(() => {
    mainMemory = process.memoryUsage()
    mainPeakRssBytes = Math.max(mainPeakRssBytes, mainMemory.rss)
    mainPeakHeapUsedBytes = Math.max(mainPeakHeapUsedBytes, mainMemory.heapUsed)
    mainPeakHeapTotalBytes = Math.max(mainPeakHeapTotalBytes, mainMemory.heapTotal)
    mainPeakExternalBytes = Math.max(mainPeakExternalBytes, mainMemory.external)
    mainPeakArrayBuffersBytes = Math.max(mainPeakArrayBuffersBytes, mainMemory.arrayBuffers)
    systemMinFreeBytes = Math.min(systemMinFreeBytes, os.freemem())
  }, 100)

  function recordSpawn(command) {
    const label = commandLabel(command)
    spawned += 1
    spawnedByCommand[label] = (spawnedByCommand[label] || 0) + 1
  }

  const trackedSpawn = function trackedSpawn(command, args, spawnOptions) {
    const child = originalSpawn.call(childProcess, command, args, spawnOptions)
    recordSpawn(command)
    if (Number.isInteger(child.pid)) {
      activePids.add(child.pid)
      peakActive = Math.max(peakActive, activePids.size)
      if (pidFile) fs.appendFileSync(pidFile, `${child.pid}\n`, 'utf8')
    }
    const release = () => {
      if (Number.isInteger(child.pid)) activePids.delete(child.pid)
    }
    child.once('exit', release)
    child.once('error', release)
    return child
  }
  const trackedSpawnSync = function trackedSpawnSync(command, args, spawnOptions) {
    recordSpawn(command)
    peakActive = Math.max(peakActive, activePids.size + 1)
    return originalSpawnSync.call(childProcess, command, args, spawnOptions)
  }
  childProcess.spawn = trackedSpawn
  childProcess.spawnSync = trackedSpawnSync

  return {
    async stop() {
      if (stopped) throw new Error('Resource monitor already stopped')
      stopped = true
      childProcess.spawn = originalSpawn
      childProcess.spawnSync = originalSpawnSync
      clearInterval(memoryTimer)
      mainMemory = process.memoryUsage()
      mainPeakRssBytes = Math.max(mainPeakRssBytes, mainMemory.rss)
      mainPeakHeapUsedBytes = Math.max(mainPeakHeapUsedBytes, mainMemory.heapUsed)
      mainPeakHeapTotalBytes = Math.max(mainPeakHeapTotalBytes, mainMemory.heapTotal)
      mainPeakExternalBytes = Math.max(mainPeakExternalBytes, mainMemory.external)
      mainPeakArrayBuffersBytes = Math.max(mainPeakArrayBuffersBytes, mainMemory.arrayBuffers)
      systemMinFreeBytes = Math.min(systemMinFreeBytes, os.freemem())
      const wallMs = performance.now() - startedAt
      const mainCpu = process.cpuUsage(mainCpuStarted)
      const resourceEnded = process.resourceUsage()

      let sampled = null
      let samplerFailureCode = ''
      let samplerFailureDetail = null
      let checkpointRecovered = false
      if (samplerProcess) {
        fs.writeFileSync(stopFile, 'stop', 'utf8')
        const stoppedCleanly = await waitForProcessExit(samplerProcess, 5_000)
        if (fs.existsSync(outputFile)) {
          sampled = parseJson(fs.readFileSync(outputFile, 'utf8'))
        }
        if (!sampled && fs.existsSync(samplerCheckpointDirectory)) {
          const checkpoints = fs
            .readdirSync(samplerCheckpointDirectory)
            .filter((name) => /^\d{12}\.json$/.test(name))
            .sort()
            .reverse()
          for (const checkpoint of checkpoints) {
            try {
              sampled = parseJson(
                fs.readFileSync(path.join(samplerCheckpointDirectory, checkpoint), 'utf8'),
              )
              if (sampled) {
                checkpointRecovered = true
                break
              }
            } catch {
              // Try the preceding immutable checkpoint.
            }
          }
        }
        if (fs.existsSync(samplerErrorFile)) {
          samplerFailureDetail = parseJson(fs.readFileSync(samplerErrorFile, 'utf8'))
        }
        if (samplerProcess.exitCode !== 0 || !sampled) {
          samplerFailureCode = stoppedCleanly
            ? `no-output-exit-${samplerProcess.exitCode ?? 'unknown'}`
            : 'stop-timeout'
        }
        safeRemoveTempRoot(samplerRoot, 'siftory-resource-sampler-')
      }

      const childCpuMsApprox = Number(sampled?.cpu?.childMsApprox) || 0
      const mainCpuMs = (mainCpu.user + mainCpu.system) / 1_000
      const logicalProcessors = Math.max(1, os.cpus().length)
      return {
        sampling: {
          intervalMs,
          samples: Number(sampled?.sampling?.samples) || 0,
          errors:
            (Number(sampled?.sampling?.errors) || 0) +
            (samplerProcess && samplerFailureCode ? 1 : 0),
          failureCode: samplerFailureCode || null,
          failureDetail: samplerFailureDetail,
          checkpointRecovered,
          processRaceSkips: Number(sampled?.sampling?.processRaceSkips) || 0,
          observedChildProcesses: Number(sampled?.sampling?.observedChildProcesses) || 0,
          childMetricsApproximate: true,
          childScope: 'direct child processes spawned during the measured interval',
          gpuScope: sampled?.gpu
            ? 'all NVIDIA devices (global, not process-attributed)'
            : 'unavailable',
        },
        wallMs: round(wallMs),
        cpu: {
          logicalProcessors,
          mainUserMs: round(mainCpu.user / 1_000),
          mainSystemMs: round(mainCpu.system / 1_000),
          childMsApprox: round(childCpuMsApprox),
          logicalCapacityPercentApprox: round(
            ((mainCpuMs + childCpuMsApprox) / Math.max(1, wallMs * logicalProcessors)) * 100,
          ),
        },
        memory: {
          mainPeakRssMiB: mib(
            Math.max(mainPeakRssBytes, Number(sampled?.memory?.mainPeakRssBytes) || 0),
          ),
          mainPeakHeapUsedMiB: mib(mainPeakHeapUsedBytes),
          mainPeakHeapTotalMiB: mib(mainPeakHeapTotalBytes),
          mainPeakExternalMiB: mib(mainPeakExternalBytes),
          mainPeakArrayBuffersMiB: mib(mainPeakArrayBuffersBytes),
          childPeakAggregateRssMiBApprox: mib(
            Number(sampled?.memory?.childPeakAggregateRssBytesApprox) || 0,
          ),
          childLargestPeakRssMiBApprox: mib(
            Number(sampled?.memory?.childLargestPeakRssBytesApprox) || 0,
          ),
          systemMinFreeMiB: mib(systemMinFreeBytes),
        },
        gpu: sampled?.gpu || null,
        io: {
          mainReadBytesApprox: sampled ? Number(sampled.io?.mainReadBytesApprox) || 0 : null,
          mainWriteBytesApprox: sampled ? Number(sampled.io?.mainWriteBytesApprox) || 0 : null,
          childReadBytesApprox: sampled ? Number(sampled.io?.childReadBytesApprox) || 0 : null,
          childWriteBytesApprox: sampled ? Number(sampled.io?.childWriteBytesApprox) || 0 : null,
          mainFsReadOperations: Math.max(0, resourceEnded.fsRead - resourceStarted.fsRead),
          mainFsWriteOperations: Math.max(0, resourceEnded.fsWrite - resourceStarted.fsWrite),
        },
        processes: {
          spawned,
          peakActive,
          byCommand: Object.fromEntries(
            Object.entries(spawnedByCommand).sort(([left], [right]) => left.localeCompare(right)),
          ),
        },
      }
    },
  }
}

module.exports = {
  assertFileSnapshotUnchanged,
  redactPaths,
  round,
  safeRemoveTempRoot,
  sha256Text,
  snapshotFiles,
  startResourceMonitor,
  writeJson,
}
