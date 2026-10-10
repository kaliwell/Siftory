#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  createFixedWindowsSystemEnvironment,
  resolveFixedHardwareSystemTools,
} = require('./fixed-hardware-system-tools.cjs')

const MAX_OUTPUT_BYTES = 1024 * 1024

function option(argv, name, fallback = '') {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function parseArgs(argv, projectRoot = path.resolve(__dirname, '..')) {
  const samples = Number(option(argv, 'samples', '10'))
  const intervalMs = Number(option(argv, 'interval-ms', '1000'))
  if (!Number.isInteger(samples) || samples < 1 || samples > 60) {
    throw new Error('--samples must be an integer between 1 and 60')
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 500 || intervalMs > 5000) {
    throw new Error('--interval-ms must be an integer between 500 and 5000')
  }
  const allowedRoot = path.join(projectRoot, 'artifacts', 'benchmark', 'runtime-memory')
  const outputDir = path.resolve(option(argv, 'output-dir', path.join(allowedRoot, 'security')))
  const relative = path.relative(allowedRoot, outputDir)
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('--output-dir must stay under artifacts/benchmark/runtime-memory')
  }
  return { intervalMs, outputDir, samples }
}

function decodeSecurityCenterState(value) {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0xffffff) {
    return { raw: null, protection: 'unknown', signatures: 'unknown' }
  }
  const hex = numeric.toString(16).padStart(6, '0')
  const state = Number.parseInt(hex.slice(2, 4), 16)
  const signature = Number.parseInt(hex.slice(4, 6), 16)
  return {
    raw: numeric,
    protection: state === 0x10 ? 'enabled' : state === 0x00 ? 'disabled' : 'unknown',
    signatures: signature === 0x00 ? 'up-to-date' : signature === 0x10 ? 'out-of-date' : 'unknown',
  }
}

function querySecurityEnvironment(tools, environment) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$products=@(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue | Select-Object displayName,productState,timestamp)",
    "$processes=@(Get-CimInstance Win32_Process -Property ProcessId,Name,ExecutablePath,WorkingSetSize,PrivatePageCount | Where-Object {$_.Name -match '(?i)(360|qh|zhudongfangyu)' } | ForEach-Object {$version=$null;try{if($_.ExecutablePath){$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($_.ExecutablePath).FileVersion}}catch{};[pscustomobject]@{pid=[int]$_.ProcessId;name=[string]$_.Name;version=$version;workingSetBytes=[uint64]$_.WorkingSetSize;privateBytes=[uint64]$_.PrivatePageCount}})",
    String.raw`$services=@(Get-CimInstance Win32_Service -Property Name,DisplayName,State,StartMode,PathName | Where-Object {($_.Name -match '(?i)(360|qh|zhudongfangyu)') -or ($_.DisplayName -match '(?i)(360|qh|zhudongfangyu)')} | ForEach-Object {$version=$null;try{$match=[regex]::Match([string]$_.PathName,'(?i)^(?:"([^"]+\.exe)"|([^\s]+\.exe))');$binary=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value};if($binary){$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($binary).FileVersion}}catch{};[pscustomobject]@{Name=$_.Name;DisplayName=$_.DisplayName;State=$_.State;StartMode=$_.StartMode;Version=$version}})`,
    "[pscustomobject]@{sampledAt=[DateTime]::UtcNow.ToString('o');products=$products;processes=$processes;services=$services}|ConvertTo-Json -Depth 5 -Compress",
  ].join(';')
  const result = spawnSync(
    tools.powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      windowsHide: true,
      encoding: 'utf8',
      env: environment,
      timeout: 15_000,
      maxBuffer: MAX_OUTPUT_BYTES,
    },
  )
  if (result.status !== 0) throw new Error('Security environment query failed')
  return JSON.parse(result.stdout)
}

function normalizeArray(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function summarizeSecuritySamples(samples) {
  if (!Array.isArray(samples) || samples.length < 1) throw new Error('Security samples are missing')
  const productMap = new Map()
  const processMap = new Map()
  const serviceMap = new Map()
  for (const sample of samples) {
    for (const product of normalizeArray(sample.products)) {
      if (typeof product.displayName !== 'string') continue
      productMap.set(product.displayName, {
        displayName: product.displayName.slice(0, 128),
        state: decodeSecurityCenterState(product.productState),
        timestamp: typeof product.timestamp === 'string' ? product.timestamp.slice(0, 128) : null,
      })
    }
    for (const process of normalizeArray(sample.processes)) {
      if (!Number.isInteger(process.pid) || typeof process.name !== 'string') continue
      const key = `${process.pid}:${process.name}`
      const current = processMap.get(key) || {
        pid: process.pid,
        name: process.name.slice(0, 128),
        version: typeof process.version === 'string' ? process.version.slice(0, 128) : null,
        samples: 0,
        peakWorkingSetBytes: 0,
        peakPrivateBytes: 0,
      }
      current.samples += 1
      current.peakWorkingSetBytes = Math.max(current.peakWorkingSetBytes, Number(process.workingSetBytes) || 0)
      current.peakPrivateBytes = Math.max(current.peakPrivateBytes, Number(process.privateBytes) || 0)
      processMap.set(key, current)
    }
    for (const service of normalizeArray(sample.services)) {
      if (typeof service.Name !== 'string') continue
      serviceMap.set(service.Name, {
        name: service.Name.slice(0, 128),
        displayName: typeof service.DisplayName === 'string' ? service.DisplayName.slice(0, 128) : null,
        state: typeof service.State === 'string' ? service.State.slice(0, 32) : 'unknown',
        startMode: typeof service.StartMode === 'string' ? service.StartMode.slice(0, 32) : 'unknown',
        version: typeof service.Version === 'string' ? service.Version.slice(0, 128) : null,
      })
    }
  }
  const products = [...productMap.values()]
  const has360 = products.some((product) => /360/.test(product.displayName))
  const enabled360 = products.some(
    (product) => /360/.test(product.displayName) && product.state.protection === 'enabled',
  )
  return {
    schema: 'siftory-runtime-memory-security-environment/v1',
    status: has360 && enabled360 ? 'passed' : has360 ? 'incomplete' : 'not-detected',
    startedAt: samples[0].sampledAt,
    completedAt: samples.at(-1).sampledAt,
    sampleCount: samples.length,
    products,
    processes: [...processMap.values()].sort((left, right) => left.name.localeCompare(right.name)),
    services: [...serviceMap.values()].sort((left, right) => left.name.localeCompare(right.name)),
  }
}

async function run(options) {
  const tools = resolveFixedHardwareSystemTools()
  const environment = createFixedWindowsSystemEnvironment({
    systemRoot: tools.systemRoot,
    comSpec: tools.comSpec,
  })
  const samples = []
  for (let index = 0; index < options.samples; index += 1) {
    samples.push(querySecurityEnvironment(tools, environment))
    if (index + 1 < options.samples) {
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs))
    }
  }
  const report = summarizeSecuritySamples(samples)
  const serialized = JSON.stringify(report, null, 2)
  if (/[A-Za-z]:\\/.test(serialized)) throw new Error('Security report leaked an absolute path')
  fs.mkdirSync(options.outputDir, { recursive: true })
  const target = path.join(
    options.outputDir,
    `security-environment-${report.completedAt.replace(/[:.]/g, '-')}.json`,
  )
  fs.writeFileSync(target, `${serialized}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ ...report, reportFile: path.basename(target) })}\n`)
  if (report.status !== 'passed') process.exitCode = 1
}

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  decodeSecurityCenterState,
  parseArgs,
  summarizeSecuritySamples,
}
