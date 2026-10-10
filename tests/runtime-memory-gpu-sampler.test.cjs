const assert = require('node:assert/strict')
const test = require('node:test')
const {
  parseNvidiaMemorySample,
  startNvidiaGpuSampler,
  summarizeGpuLifecycle,
  summarizeGpuSamples,
} = require('../scripts/runtime-memory-gpu-sampler.cjs')

test('NVIDIA runtime memory parser aggregates multiple adapters without paths', () => {
  const sample = parseNvidiaMemorySample('120, 8192, 10\n30, 4096, 25\n', '2026-01-01T00:00:00Z')
  assert.deepEqual(sample, {
    sampledAt: '2026-01-01T00:00:00Z',
    usedMiB: 150,
    totalMiB: 12_288,
    utilizationPercent: 25,
    deviceCount: 2,
  })
  assert.throws(() => parseNvidiaMemorySample('not supported'), /no valid devices/)
})

test('GPU lifecycle compares matching profile peaks and post-dispose valleys', () => {
  const windows = []
  const samples = []
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const startedAt = new Date(repetition * 10_000).toISOString()
    const completedAt = new Date(repetition * 10_000 + 2_000).toISOString()
    windows.push({ startedAt, completedAt, profileId: 'general', repetition })
    samples.push(
      {
        sampledAt: new Date(repetition * 10_000 + 500).toISOString(),
        usedMiB: 500 + repetition,
      },
      {
        sampledAt: new Date(repetition * 10_000 + 1_500).toISOString(),
        usedMiB: 100 + repetition,
      },
    )
  }
  const summary = summarizeGpuLifecycle(samples, windows)
  assert.equal(summary.status, 'passed')
  assert.equal(summary.gate.passed, true)
  assert.equal(summary.gate.maxPeakGrowthMiB, 2)
})

test('GPU summary reports baseline, peak delta, final, and utilization', () => {
  const samples = [
    { sampledAt: 'a', usedMiB: 100, totalMiB: 8192, utilizationPercent: 1, deviceCount: 1 },
    { sampledAt: 'b', usedMiB: 350, totalMiB: 8192, utilizationPercent: 70, deviceCount: 1 },
    { sampledAt: 'c', usedMiB: 150, totalMiB: 8192, utilizationPercent: 3, deviceCount: 1 },
  ]
  assert.deepEqual(summarizeGpuSamples(samples), {
    status: 'passed',
    sampleCount: 3,
    startedAt: 'a',
    completedAt: 'c',
    deviceCount: 1,
    totalMiB: 8192,
    baselineUsedMiB: 100,
    peakUsedMiB: 350,
    peakDeltaMiB: 250,
    finalUsedMiB: 150,
    maximumUtilizationPercent: 70,
  })
})

test('GPU sampler keeps sampling failures bounded after a valid baseline', async () => {
  let calls = 0
  const sampler = await startNvidiaGpuSampler({
    intervalMs: 500,
    async query() {
      calls += 1
      if (calls === 2) throw new Error('transient')
      return {
        sampledAt: new Date(calls).toISOString(),
        usedMiB: 100 + calls,
        totalMiB: 8192,
        utilizationPercent: calls,
        deviceCount: 1,
      }
    },
  })
  const summary = await sampler.stop()
  assert.equal(summary.status, 'passed')
  assert.equal(summary.sampleCount, 1)
})
