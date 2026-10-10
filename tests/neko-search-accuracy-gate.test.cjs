const test = require('node:test')
const assert = require('node:assert/strict')

const { evaluateGate } = require('./neko-search-accuracy-benchmark.cjs')

function gateFixture() {
  const stable = {
    precisionAt20: 1,
    precisionAt50: 1,
    recallAt50: 0.64,
    ndcgAt20: 1,
    rejectIntrusionAt20: 0,
  }
  return {
    baseline: {
      primaryVariant: 'hybrid',
      variants: { hybrid: stable, hybrid_feedback: stable },
      comparability: { annotationFingerprint: 'annotations', activeSetFingerprint: 'assets' },
      latency: { scanP95Ms: 10_000 },
    },
    current: {
      variants: { hybrid: stable, hybrid_feedback: stable },
      comparability: { annotationFingerprint: 'annotations', activeSetFingerprint: 'assets' },
      latency: {
        scanMs: { p95: 10_000 },
        applicationCold: { totalMs: { samples: 3 } },
        warmPathIndex: { totalMs: { samples: 3 } },
      },
      cluster: { available: true, purityMedianWeighted: 0.9 },
    },
  }
}

test('trend-only feedback regressions do not fail the primary hybrid gate', () => {
  const { baseline, current } = gateFixture()
  current.variants.hybrid_feedback = {
    precisionAt20: 0,
    precisionAt50: 0,
    recallAt50: 0,
    ndcgAt20: 0,
    rejectIntrusionAt20: 1,
  }
  assert.deepEqual(evaluateGate(current, baseline).failures, [])
})

test('primary hybrid regressions and active-set drift remain release blockers', () => {
  const { baseline, current } = gateFixture()
  current.variants.hybrid = { ...current.variants.hybrid, precisionAt20: 0.5 }
  current.comparability.activeSetFingerprint = 'changed-assets'
  const { failures } = evaluateGate(current, baseline)
  assert.equal(
    failures.some((failure) => failure.includes('Active asset set differs')),
    true,
  )
  assert.equal(
    failures.some((failure) => failure.includes('[hybrid] Precision@20')),
    true,
  )
})

test('a gate run fails closed when its primary variant is unavailable', () => {
  const { baseline, current } = gateFixture()
  delete current.variants.hybrid
  assert.deepEqual(evaluateGate(current, baseline).failures, [
    'Primary gate variant is unavailable: hybrid',
  ])
})
