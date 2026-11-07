'use strict'

const { normalizeIntervalMs } = require('./runtime-memory-process-sampler.cjs')
const MAX_SAMPLE_GAP_MS = 15000

function createSoakSamplerPlan(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0.05 || minutes > 180) {
    throw new Error('Soak minutes must be 0.05..180')
  }
  const intervalMs = normalizeIntervalMs(1000)
  // Cover the active run plus setup/final source verification, using the sampler's
  // actual bounded interval rather than the originally requested interval.
  const maximumSamples = Math.ceil((minutes * 60000 + 5 * 60000) / intervalMs) + 1
  return { intervalMs, maximumSamples }
}

function assertRecentSoakSample(sample, now = Date.now()) {
  const at = Date.parse(sample?.sampledAt)
  if (!Number.isFinite(at) || now - at > MAX_SAMPLE_GAP_MS || at - now > 5000) {
    throw new Error('Memory sample is stale or has an invalid timestamp; acceptance stopped')
  }
  return sample
}

function validateSoakSampleCoverage(samples, startedAt, endedAt) {
  if (!samples.length || !Number.isFinite(startedAt) || !(endedAt > startedAt)) {
    throw new Error('Memory sampling coverage cannot be established')
  }
  const times = samples.map((sample) => Date.parse(sample.sampledAt))
  if (
    times.some((at) => !Number.isFinite(at)) ||
    times[0] > startedAt + MAX_SAMPLE_GAP_MS ||
    times.at(-1) < endedAt - MAX_SAMPLE_GAP_MS
  ) {
    throw new Error('Memory samples do not cover the complete active run')
  }
  let maximumGapMs = 0
  for (let index = 1; index < times.length; index++) {
    const gap = times[index] - times[index - 1]
    if (gap < 0 || gap > MAX_SAMPLE_GAP_MS) {
      throw new Error('Memory sampling contains a gap or clock discontinuity')
    }
    maximumGapMs = Math.max(maximumGapMs, gap)
  }
  return {
    valid: true,
    samples: samples.length,
    firstAt: samples[0].sampledAt,
    lastAt: samples.at(-1).sampledAt,
    maximumGapMs,
    allowedGapMs: MAX_SAMPLE_GAP_MS,
  }
}

module.exports = { createSoakSamplerPlan, assertRecentSoakSample, validateSoakSampleCoverage }
