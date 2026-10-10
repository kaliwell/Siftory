const assert = require('node:assert/strict')
const test = require('node:test')
const { percentile, summarizeRounds } = require('../scripts/run-video-semantic-llama-soak.cjs')

test('soak summary requires every round and reports bounded aggregate evidence', () => {
  const rounds = [10, 20, 30, 40, 50, 60].map((latencyMs, index) => ({
    latencyMs,
    parsed: index !== 5,
    ok: index !== 5,
    gpuBefore: { usedMiB: 1_000 + index },
    gpuAfter: { usedMiB: 2_000 + index },
  }))
  assert.deepEqual(summarizeRounds(rounds), {
    attempted: 6,
    passed: 5,
    failed: 1,
    strictJson: 5,
    averageLatencyMs: 35,
    p95LatencyMs: 60,
    maximumGpuUsedMiB: 2_005,
  })
})

test('percentile is deterministic for empty, singleton, and unsorted inputs', () => {
  assert.equal(percentile([], 0.95), 0)
  assert.equal(percentile([12], 0.95), 12)
  assert.equal(percentile([50, 10, 40, 20, 30], 0.5), 30)
})

test('soak summary supports the eight-profile acceptance matrix', () => {
  const rounds = Array.from({ length: 8 }, (_, index) => ({
    profileId: `profile-${index}`,
    latencyMs: 100 + index,
    parsed: true,
    ok: true,
  }))
  assert.equal(summarizeRounds(rounds).attempted, 8)
  assert.equal(summarizeRounds(rounds).strictJson, 8)
})
