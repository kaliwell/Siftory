const assert = require('node:assert/strict')
const test = require('node:test')
const {
  createSoakSamplerPlan,
  assertRecentSoakSample,
  validateSoakSampleCoverage,
} = require('../scripts/workspace-performance-soak-policy.cjs')

test('two-hour and maximum-length soaks cannot exhaust their sample budget early', () => {
  for (const minutes of [0.05, 30, 120, 180]) {
    const plan = createSoakSamplerPlan(minutes)
    assert.equal(plan.intervalMs, 500)
    assert.ok((plan.maximumSamples - 1) * plan.intervalMs >= (minutes + 5) * 60000)
    assert.ok(plan.maximumSamples <= 1000000)
  }
  assert.throws(() => createSoakSamplerPlan(NaN))
  assert.throws(() => createSoakSamplerPlan(181))
})

test('a dead sampler cannot satisfy live health checks with an old sample', () => {
  const now = Date.UTC(2026, 10, 7, 0)
  const sample = (delta) => ({ sampledAt: new Date(now + delta).toISOString() })
  assert.equal(assertRecentSoakSample(sample(-500), now).sampledAt, sample(-500).sampledAt)
  assert.throws(() => assertRecentSoakSample(sample(-19000), now), /stale/)
  assert.throws(() => assertRecentSoakSample(sample(19000), now), /stale/)
  assert.throws(() => assertRecentSoakSample({}, now), /timestamp/)
})

test('coverage rejects missing tails and interior gaps, even when exit was clean', () => {
  const start = Date.UTC(2026, 10, 7, 0)
  const samples = Array.from({ length: 145 }, (_, i) => ({
    sampledAt: new Date(start + i * 5000).toISOString(),
  }))
  assert.equal(validateSoakSampleCoverage(samples, start, start + 720000).valid, true)
  assert.throws(
    () => validateSoakSampleCoverage(samples.slice(0, 120), start, start + 720000),
    /complete active run/,
  )
  assert.throws(
    () =>
      validateSoakSampleCoverage(
        samples.filter((_, i) => i < 50 || i > 60),
        start,
        start + 720000,
      ),
    /gap/,
  )
})
