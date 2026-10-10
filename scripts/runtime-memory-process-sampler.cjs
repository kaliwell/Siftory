'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const {
  createFixedWindowsSystemEnvironment,
  resolveFixedHardwareSystemTools,
} = require('./fixed-hardware-system-tools.cjs')

const MAX_JSONL_BYTES = 256 * 1024 * 1024
const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024
const VALID_ROLES = new Set([
  'main',
  'renderer',
  'gpu',
  'utility',
  'worker',
  'model-child',
  'other-child',
])

function normalizeIntervalMs(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 250
  return Math.max(100, Math.min(500, Math.round(parsed)))
}

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return fallback
  return Math.min(parsed, maximum)
}

function assertAbsoluteFile(filePath, label) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error(`${label} must be an absolute path`)
  }
  const directory = path.dirname(filePath)
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${label} parent directory must already exist`)
  }
  return path.resolve(filePath)
}

function validateProcessRecord(record, rootIdentity) {
  if (!record || typeof record !== 'object') throw new Error('Sampler process record is invalid')
  if (!Number.isInteger(record.pid) || record.pid < 1) throw new Error('Sampler PID is invalid')
  if (!Number.isInteger(record.ppid) || record.ppid < 0) throw new Error('Sampler PPID is invalid')
  if (typeof record.identity !== 'string' || !record.identity.startsWith(`${record.pid}@`)) {
    throw new Error('Sampler process identity is invalid')
  }
  if (!Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error('Sampler process creation time is invalid')
  }
  if (!VALID_ROLES.has(record.role)) throw new Error('Sampler process role is invalid')
  if (record.role === 'main' && record.identity !== rootIdentity) {
    throw new Error('Sampler main-process identity differs from the root')
  }
  for (const field of [
    'workingSetBytes',
    'privateBytes',
    'commitBytes',
    'pageFaults',
    'threadCount',
    'handleCount',
    'cpuKernelMs',
    'cpuUserMs',
  ]) {
    if (!Number.isFinite(Number(record[field])) || Number(record[field]) < 0) {
      throw new Error(`Sampler process ${field} is invalid`)
    }
  }
  for (const forbidden of ['commandLine', 'executablePath', 'path', 'cwd']) {
    if (Object.hasOwn(record, forbidden)) throw new Error(`Sampler leaked ${forbidden}`)
  }
}

function validateRuntimeMemorySample(sample) {
  if (sample?.schema !== 'siftory-runtime-memory-sample/v1') {
    throw new Error('Runtime memory sample schema is invalid')
  }
  if (!Number.isInteger(sample.sequence) || sample.sequence < 0) {
    throw new Error('Runtime memory sample sequence is invalid')
  }
  if (!Number.isFinite(Date.parse(sample.sampledAt))) {
    throw new Error('Runtime memory sample timestamp is invalid')
  }
  if (normalizeIntervalMs(sample.intervalMs) !== sample.intervalMs) {
    throw new Error('Runtime memory sample interval is outside 100-500 ms')
  }
  if (!Array.isArray(sample.processes) || sample.processes.length < 1) {
    throw new Error('Runtime memory sample has no process tree')
  }
  for (const processRecord of sample.processes) {
    validateProcessRecord(processRecord, sample.rootIdentity)
  }
  const identities = sample.processes.map((record) => record.identity)
  if (new Set(identities).size !== identities.length) {
    throw new Error('Runtime memory sample contains a duplicate process identity')
  }
  const root = sample.processes.find((record) => record.identity === sample.rootIdentity)
  if (!root || root.role !== 'main') throw new Error('Runtime memory sample root is missing')
  for (const field of ['freePhysicalMemoryBytes', 'totalPhysicalMemoryBytes']) {
    if (!Number.isFinite(Number(sample.system?.[field])) || Number(sample.system[field]) <= 0) {
      throw new Error(`Runtime memory system ${field} is invalid`)
    }
  }
  for (const field of ['workingSetBytes', 'privateBytes', 'commitBytes']) {
    if (!Number.isFinite(Number(sample.aggregate?.[field])) || Number(sample.aggregate[field]) < 0) {
      throw new Error(`Runtime memory aggregate ${field} is invalid`)
    }
  }
  if (sample.aggregate?.processCount !== sample.processes.length) {
    throw new Error('Runtime memory aggregate process count differs')
  }
  return sample
}

function readRuntimeMemorySamples(outputFile, options = {}) {
  const maximumBytes = boundedPositiveInteger(options.maximumBytes, MAX_JSONL_BYTES, MAX_JSONL_BYTES)
  const entry = fs.statSync(outputFile)
  if (!entry.isFile() || entry.size < 1 || entry.size > maximumBytes) {
    throw new Error('Runtime memory sampler output size is invalid')
  }
  const content = fs.readFileSync(outputFile, 'utf8')
  const lines = content.split(/\r?\n/).filter(Boolean)
  if (lines.length < 1) throw new Error('Runtime memory sampler produced no samples')
  return lines.map((line, index) => {
    if (Buffer.byteLength(line, 'utf8') > MAX_JSONL_LINE_BYTES) {
      throw new Error(`Runtime memory sampler line ${index + 1} is too large`)
    }
    return validateRuntimeMemorySample(JSON.parse(line))
  })
}

function waitForFile(filePath, child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (fs.existsSync(filePath)) {
        clearInterval(timer)
        resolve()
      } else if (child.exitCode !== null) {
        clearInterval(timer)
        reject(new Error(`Runtime memory sampler exited before ready (${child.exitCode})`))
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer)
        reject(new Error('Runtime memory sampler readiness timed out'))
      }
    }, 25)
    timer.unref?.()
  })
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

async function startRuntimeMemorySampler(options) {
  if (process.platform !== 'win32' && !options?.systemTools) {
    throw new Error('Runtime memory process sampling currently requires Windows')
  }
  const rootPid = Number(options?.rootPid)
  if (!Number.isInteger(rootPid) || rootPid < 1) throw new Error('Sampler root PID is invalid')
  const outputFile = assertAbsoluteFile(options.outputFile, 'Sampler output file')
  const stopFile = assertAbsoluteFile(options.stopFile, 'Sampler stop file')
  const readyFile = assertAbsoluteFile(options.readyFile, 'Sampler ready file')
  for (const target of [outputFile, stopFile, readyFile, `${outputFile}.error`]) {
    if (fs.existsSync(target)) throw new Error('Sampler target already exists')
  }
  const intervalMs = normalizeIntervalMs(options.intervalMs)
  const maximumBytes = boundedPositiveInteger(options.maximumBytes, MAX_JSONL_BYTES, 1024 ** 3)
  const maximumSamples = boundedPositiveInteger(options.maximumSamples, 200_000, 1_000_000)
  const systemTools = options.systemTools || resolveFixedHardwareSystemTools()
  const systemEnvironment =
    options.systemEnvironment ||
    createFixedWindowsSystemEnvironment({
      systemRoot: systemTools.systemRoot,
      comSpec: systemTools.comSpec,
    })
  const scriptPath = path.join(__dirname, 'runtime-memory-process-sampler.ps1')
  const child = spawn(
    systemTools.powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-RootPid',
      String(rootPid),
      '-OutputFile',
      outputFile,
      '-StopFile',
      stopFile,
      '-ReadyFile',
      readyFile,
      '-IntervalMs',
      String(intervalMs),
      '-MaxOutputBytes',
      String(maximumBytes),
      '-MaxSamples',
      String(maximumSamples),
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false,
      env: systemEnvironment,
    },
  )
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-64 * 1024)
  })
  try {
    await waitForFile(readyFile, child, boundedPositiveInteger(options.readyTimeoutMs, 15_000, 60_000))
  } catch (error) {
    if (child.exitCode === null) child.kill()
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}${stderr.trim() ? `: ${stderr.trim()}` : ''}`, { cause: error })
  }
  let stopped = false
  return {
    intervalMs,
    outputFile,
    rootIdentity: fs.readFileSync(readyFile, 'utf8').trim(),
    async stop() {
      if (stopped) throw new Error('Runtime memory sampler is already stopped')
      stopped = true
      fs.writeFileSync(stopFile, 'stop', 'utf8')
      const cleanExit = await waitForExit(
        child,
        boundedPositiveInteger(options.stopTimeoutMs, 15_000, 60_000),
      )
      if (!cleanExit) {
        child.kill()
        throw new Error('Runtime memory sampler did not stop within the bounded timeout')
      }
      if (child.exitCode !== 0) {
        throw new Error(`Runtime memory sampler failed (${child.exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
      }
      return readRuntimeMemorySamples(outputFile, { maximumBytes })
    },
  }
}

module.exports = {
  MAX_JSONL_BYTES,
  MAX_JSONL_LINE_BYTES,
  VALID_ROLES,
  normalizeIntervalMs,
  readRuntimeMemorySamples,
  startRuntimeMemorySampler,
  validateRuntimeMemorySample,
}
