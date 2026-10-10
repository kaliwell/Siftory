import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'

const KIB = 1024
const MIB = 1024 * 1024
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024
const PROBE_TIMEOUT_MS = 4_000

export interface ElectronProcessMetricLike {
  pid: number
  type?: string
  cpu?: {
    percentCPUUsage?: number
  }
  memory?: {
    workingSetSize?: number
    privateBytes?: number
  }
}

export interface ElectronProcessMemoryAggregate {
  processCount: number
  cpuPercent: number
  workingSetBytes: number
  privateBytes?: number
  privateMetricCount: number
  gpuProcessCount: number
}

export interface RuntimeProcessTreeMemory {
  processCount: number
  workingSetBytes: number
  privateBytes: number
}

export interface RuntimeGpuMemory {
  deviceCount: number
  usedBytes: number
  totalBytes: number
  utilizationPercent: number
}

export interface RuntimeResourceMetrics {
  electron: ElectronProcessMemoryAggregate
  processTree?: RuntimeProcessTreeMemory
  gpu?: RuntimeGpuMemory
}

function nonNegative(value: unknown): number | undefined {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined
}

export function aggregateElectronProcessMemory(
  metrics: ElectronProcessMetricLike[],
): ElectronProcessMemoryAggregate {
  let workingSetBytes = 0
  let privateBytes = 0
  let privateMetricCount = 0
  let gpuProcessCount = 0
  let cpuPercent = 0
  for (const metric of metrics) {
    const workingSetKiB = nonNegative(metric.memory?.workingSetSize)
    const privateKiB = nonNegative(metric.memory?.privateBytes)
    if (workingSetKiB !== undefined) workingSetBytes += workingSetKiB * KIB
    if (privateKiB !== undefined) {
      privateBytes += privateKiB * KIB
      privateMetricCount += 1
    }
    if (metric.type === 'GPU') gpuProcessCount += 1
    cpuPercent += nonNegative(metric.cpu?.percentCPUUsage) ?? 0
  }
  return {
    processCount: metrics.length,
    cpuPercent: Math.min(100, cpuPercent),
    workingSetBytes,
    ...(privateMetricCount > 0 ? { privateBytes } : {}),
    privateMetricCount,
    gpuProcessCount,
  }
}

export function parseProcessTreeMemory(raw: string): RuntimeProcessTreeMemory | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const processCount = nonNegative(parsed.processCount)
    const workingSetBytes = nonNegative(parsed.workingSetBytes)
    const privateBytes = nonNegative(parsed.privateBytes)
    if (
      processCount === undefined ||
      !Number.isInteger(processCount) ||
      processCount < 1 ||
      workingSetBytes === undefined ||
      privateBytes === undefined
    ) {
      return undefined
    }
    return { processCount, workingSetBytes, privateBytes }
  } catch {
    return undefined
  }
}

export function parseNvidiaGpuMemory(raw: string): RuntimeGpuMemory | undefined {
  const rows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(',').map((part) => Number(part.trim())))
    .filter(
      (row) =>
        row.length === 3 &&
        row.every((value) => Number.isFinite(value) && value >= 0) &&
        row[0] <= row[1],
    )
  if (rows.length === 0) return undefined
  return {
    deviceCount: rows.length,
    usedBytes: rows.reduce((sum, row) => sum + row[0] * MIB, 0),
    totalBytes: rows.reduce((sum, row) => sum + row[1] * MIB, 0),
    utilizationPercent: Math.max(...rows.map((row) => Math.min(100, row[2]))),
  }
}

function trustedWindowsTool(fileName: string): string | undefined {
  if (process.platform !== 'win32') return undefined
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return undefined
  const candidate = path.win32.join(systemRoot, 'System32', fileName)
  try {
    const entry = fs.lstatSync(candidate)
    if (!entry.isFile() || entry.isSymbolicLink()) return undefined
    const real = fs.realpathSync.native(candidate)
    return real.toLowerCase() === candidate.toLowerCase() ? real : undefined
  } catch {
    return undefined
  }
}

function execFileBounded(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        encoding: 'utf8',
      },
      (error, stdout) => resolve(error ? undefined : stdout),
    )
  })
}

export async function probeWindowsProcessTreeMemory(
  rootPid = process.pid,
): Promise<RuntimeProcessTreeMemory | undefined> {
  const powershell = trustedWindowsTool('WindowsPowerShell\\v1.0\\powershell.exe')
  if (!powershell || !Number.isInteger(rootPid) || rootPid < 1) return undefined
  const script = [
    "$ErrorActionPreference='Stop'",
    '$root=[uint32]' + String(rootPid),
    '$rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount)',
    '$ids=New-Object System.Collections.Generic.HashSet[uint32]',
    '[void]$ids.Add($root)',
    '$changed=$true',
    'while($changed){$changed=$false;foreach($row in $rows){if($ids.Contains([uint32]$row.ParentProcessId)-and !$ids.Contains([uint32]$row.ProcessId)){[void]$ids.Add([uint32]$row.ProcessId);$changed=$true}}}',
    '$selected=@($rows|Where-Object {$ids.Contains([uint32]$_.ProcessId)})',
    '[pscustomobject]@{processCount=$selected.Count;workingSetBytes=[uint64](($selected|Measure-Object WorkingSetSize -Sum).Sum);privateBytes=[uint64](($selected|Measure-Object PrivatePageCount -Sum).Sum)}|ConvertTo-Json -Compress',
  ].join(';')
  const raw = await execFileBounded(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ])
  return raw ? parseProcessTreeMemory(raw) : undefined
}

export async function probeNvidiaGpuMemory(): Promise<RuntimeGpuMemory | undefined> {
  const nvidiaSmi = trustedWindowsTool('nvidia-smi.exe')
  if (!nvidiaSmi) return undefined
  const raw = await execFileBounded(nvidiaSmi, [
    '--query-gpu=memory.used,memory.total,utilization.gpu',
    '--format=csv,noheader,nounits',
  ])
  return raw ? parseNvidiaGpuMemory(raw) : undefined
}

export async function collectRuntimeResourceMetrics(
  appMetrics: ElectronProcessMetricLike[],
  dependencies: {
    processTreeProbe?: () => Promise<RuntimeProcessTreeMemory | undefined>
    gpuProbe?: () => Promise<RuntimeGpuMemory | undefined>
  } = {},
): Promise<RuntimeResourceMetrics> {
  const processTreeProbe = dependencies.processTreeProbe || probeWindowsProcessTreeMemory
  const gpuProbe = dependencies.gpuProbe || probeNvidiaGpuMemory
  const [processTree, gpu] = await Promise.all([processTreeProbe(), gpuProbe()])
  return {
    electron: aggregateElectronProcessMemory(appMetrics),
    ...(processTree ? { processTree } : {}),
    ...(gpu ? { gpu } : {}),
  }
}
