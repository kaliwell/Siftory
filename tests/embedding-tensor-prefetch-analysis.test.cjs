const assert = require('node:assert/strict')
const test = require('node:test')

const {
  analyzeEmbeddingTensorPrefetch,
  unwrapReport,
} = require('../scripts/analyze-embedding-tensor-prefetch-ab.cjs')

function entry({ elapsedMs, digest = 'same', prefetch = false, childPeak = 1000, minFree = 800 }) {
  return unwrapReport({
    ok: true,
    safety: { sourceUnchanged: true, sourceSnapshot: { sha256: 'source' } },
    runs: [
      {
        status: 'completed',
        elapsedMs,
        imagesPerSecond: 256000 / elapsedMs,
        digest,
        stageMetrics: { fallbackBatches: 0, tensorPrefetchBatches: prefetch ? 62 : 0 },
        resources: {
          sampling: { errors: 0 },
          memory: { childPeakAggregateRssMiBApprox: childPeak, systemMinFreeMiB: minFree },
          gpu: { peakUsedMiB: 2800 },
        },
      },
    ],
  })
}

test('tensor prefetch analyzer promotes only a three-run parity-preserving improvement', () => {
  const baseline = [40_000, 39_000, 41_000].map((elapsedMs) => entry({ elapsedMs }))
  const candidate = [36_000, 37_000, 35_000].map((elapsedMs) =>
    entry({ elapsedMs, prefetch: true, childPeak: 700, minFree: 1200 }),
  )
  const result = analyzeEmbeddingTensorPrefetch(baseline, candidate)
  assert.equal(result.decision, 'run-1000-final')
  assert.equal(result.improvementPercent, 10)
  assert.deepEqual(result.failures, [])
})

test('tensor prefetch analyzer rejects parity, fallback, resource, and weak-speed failures', () => {
  const baseline = [40_000, 39_000, 41_000].map((elapsedMs) => entry({ elapsedMs }))
  const candidate = [39_500, 39_500, 39_500].map((elapsedMs, index) =>
    entry({
      elapsedMs,
      digest: index === 0 ? 'different' : 'same',
      prefetch: true,
      childPeak: 1500,
      minFree: 32,
    }),
  )
  candidate[0].run.stageMetrics.fallbackBatches = 1
  const result = analyzeEmbeddingTensorPrefetch(baseline, candidate)
  assert.equal(result.decision, 'reject-and-defer')
  assert.ok(result.failures.includes('vector-digest-parity-failed'))
  assert.ok(result.failures.includes('candidate-fallback'))
  assert.ok(result.failures.includes('p50-improvement-below-5-percent'))
  assert.ok(result.failures.includes('child-rss-over-budget'))
  assert.ok(result.failures.includes('system-free-memory-below-64-mib'))
})
