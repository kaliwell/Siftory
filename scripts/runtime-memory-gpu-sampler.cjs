'use strict'

const { execFile } = require('node:child_process')
const {
  createFixedWindowsSystemEnvironment,
  resolveFixedHardwareSystemTools,
} = require('./fixed-hardware-system-tools.cjs')

const MAX_OUTPUT_BYTES = 64 * 1024

function parseNvidiaMemorySample(output, sampledAt = new Date().toISOString()) {
  const rows = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(',').map((part) => Number(part.trim())))
    .filter((row) => row.length >= 3 && row.every(Number.isFinite))
  if (rows.length < 1) throw new Error('NVIDIA GPU sampler returned no valid devices')
  return {
    sampledAt,
    usedMiB: rows.reduce((sum, row) => sum + row[0], 0),
    totalMiB: rows.reduce((sum, row) => sum + row[1], 0),
    utilizationPercent: Math.max(...rows.map((row) => row[2])),
    deviceCount: rows.length,
  }
}

function runNvidiaQuery(tools, environment) {
  return new Promise((resolve, reject) => {
    execFile(
      tools.nvidiaSmi,
      [
        '--query-gpu=memory.used,memory.total,utilization.gpu',
        '--format=csv,noheader,nounits',
      ],
      {
        windowsHide: true,
        timeout: 2_000,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        env: environment,
      },
      (error, stdout) => {
        if (error) reject(error)
        else {
          try {
            resolve(parseNvidiaMemorySample(stdout))
          } catch (parseError) {
            reject(parseError)
          }
        }
      },
    )
  })
}

function summarizeGpuSamples(samples) {
  if (!Array.isArray(samples) || samples.length < 1) {
    throw new Error('GPU sampler produced no samples')
  }
  const baseline = samples[0]
  const peakUsedMiB = Math.max(...samples.map((sample) => sample.usedMiB))
  return {
    status: 'passed',
    sampleCount: samples.length,
    startedAt: baseline.sampledAt,
    completedAt: samples.at(-1).sampledAt,
    deviceCount: Math.max(...samples.map((sample) => sample.deviceCount)),
    totalMiB: Math.min(...samples.map((sample) => sample.totalMiB)),
    baselineUsedMiB: baseline.usedMiB,
    peakUsedMiB,
    peakDeltaMiB: peakUsedMiB - baseline.usedMiB,
    finalUsedMiB: samples.at(-1).usedMiB,
    maximumUtilizationPercent: Math.max(...samples.map((sample) => sample.utilizationPercent)),
  }
}

function summarizeGpuLifecycle(samples, windows) {
  if (!Array.isArray(windows) || windows.length < 1) return undefined
  const rows = []
  for (const window of windows) {
    const startedAtMs = Date.parse(window?.startedAt)
    const completedAtMs = Date.parse(window?.completedAt)
    const selected = samples.filter((sample) => {
      const sampledAtMs = Date.parse(sample.sampledAt)
      return sampledAtMs >= startedAtMs && sampledAtMs <= completedAtMs
    })
    if (selected.length < 1) return { status: 'incomplete', error: 'GPU lifecycle window lacks samples' }
    rows.push({
      profileId: typeof window.profileId === 'string' ? window.profileId : 'default',
      repetition: Number(window.repetition) || 1,
      sampleCount: selected.length,
      peakUsedMiB: Math.max(...selected.map((sample) => sample.usedMiB)),
      endingUsedMiB: Math.min(
        ...selected.slice(-Math.min(2, selected.length)).map((sample) => sample.usedMiB),
      ),
    })
  }
  const byProfile = new Map()
  for (const row of rows) {
    const group = byProfile.get(row.profileId) || []
    group.push(row)
    byProfile.set(row.profileId, group)
  }
  let minimumRepetitions = Number.POSITIVE_INFINITY
  let maxPeakGrowthMiB = Number.NEGATIVE_INFINITY
  let maxEndingGrowthMiB = Number.NEGATIVE_INFINITY
  for (const group of byProfile.values()) {
    group.sort((left, right) => left.repetition - right.repetition)
    minimumRepetitions = Math.min(minimumRepetitions, group.length)
    maxPeakGrowthMiB = Math.max(
      maxPeakGrowthMiB,
      group.at(-1).peakUsedMiB - group[0].peakUsedMiB,
    )
    maxEndingGrowthMiB = Math.max(
      maxEndingGrowthMiB,
      group.at(-1).endingUsedMiB - group[0].endingUsedMiB,
    )
  }
  const enoughRepetitions = minimumRepetitions >= 3
  return {
    status: enoughRepetitions ? 'passed' : 'incomplete',
    rows,
    gate: {
      passed:
        enoughRepetitions && maxPeakGrowthMiB <= 256 && maxEndingGrowthMiB <= 128,
      minimumRepetitions,
      maxPeakGrowthMiB,
      maxEndingGrowthMiB,
      peakGrowthLimitMiB: 256,
      endingGrowthLimitMiB: 128,
    },
  }
}

async function startNvidiaGpuSampler(options = {}) {
  const intervalMs = Math.max(500, Math.min(5_000, Number(options.intervalMs) || 1_000))
  const tools = options.systemTools || resolveFixedHardwareSystemTools()
  const environment =
    options.systemEnvironment ||
    createFixedWindowsSystemEnvironment({
      systemRoot: tools.systemRoot,
      comSpec: tools.comSpec,
    })
  const query = options.query || (() => runNvidiaQuery(tools, environment))
  const samples = [await query()]
  let stopped = false
  let active = null
  const timer = setInterval(() => {
    if (active || stopped) return
    active = Promise.resolve(query())
      .then((sample) => samples.push(sample))
      .catch(() => undefined)
      .finally(() => {
        active = null
      })
  }, intervalMs)
  timer.unref?.()
  return {
    async stop(lifecycleWindows) {
      if (stopped) throw new Error('GPU sampler is already stopped')
      stopped = true
      clearInterval(timer)
      if (active) await active
      try {
        samples.push(await query())
      } catch {
        // The first sample is authoritative for availability; a final probe race is non-fatal.
      }
      const summary = summarizeGpuSamples(samples)
      const lifecycle = summarizeGpuLifecycle(samples, lifecycleWindows)
      return lifecycle ? { ...summary, lifecycle } : summary
    },
  }
}

module.exports = {
  parseNvidiaMemorySample,
  startNvidiaGpuSampler,
  summarizeGpuLifecycle,
  summarizeGpuSamples,
}
