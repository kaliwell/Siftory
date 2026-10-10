const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  activateFeedbackTargets,
  buildFeedbackSearchCenters,
  buildFeedbackTargetModel,
  buildFeedbackPrototypes,
  scoreAssetFeedback,
  scoreAssetFeedbackTarget,
} = loadTsModule('electron/assetFeedbackModel.ts')

function vector(path, values, weight = 1) {
  return { path, vector: Float32Array.from(values), weight }
}

function target(overrides = {}) {
  return {
    key: 'tag:1',
    kind: 'tag',
    id: 1,
    name: 'girl',
    positiveSampleCount: 2,
    negativeSampleCount: 1,
    positivePrototypes: [
      { path: 'positive-a.jpg', vector: Float32Array.from([1, 0, 0]) },
      { path: 'positive-b.jpg', vector: Float32Array.from([0, 1, 0]) },
    ],
    negativePrototypes: [{ path: 'negative.jpg', vector: Float32Array.from([0, 0, 1]) }],
    ...overrides,
  }
}

test('feedback targets activate only for reliable label matches', () => {
  const targets = [
    target(),
    target({ key: 'category:2', kind: 'category', id: 2, name: '海边场景' }),
  ]

  assert.deepEqual(
    activateFeedbackTargets('girl', targets).map((item) => [item.target.name, item.gate]),
    [['girl', 1]],
  )
  assert.deepEqual(
    activateFeedbackTargets('portrait of a girl', targets).map((item) => item.target.name),
    ['girl'],
  )
  assert.deepEqual(
    activateFeedbackTargets('girlfriend', targets).map((item) => item.target.name),
    [],
  )
  assert.deepEqual(
    activateFeedbackTargets('夏天海边场景照片', targets).map((item) => item.target.name),
    ['海边场景'],
  )
})

test('prototype builder retains distinct visual modes deterministically', () => {
  const samples = [
    vector('a.jpg', [1, 0]),
    vector('b.jpg', [0.99, 0.02]),
    vector('c.jpg', [-1, 0]),
    vector('d.jpg', [-0.99, -0.02]),
  ]
  const first = buildFeedbackPrototypes(samples, 2)
  const second = buildFeedbackPrototypes([...samples].reverse(), 2)

  assert.equal(first.length, 2)
  assert.deepEqual(
    first.map((item) => item.path),
    second.map((item) => item.path),
  )
  assert.ok(first.some((item) => item.vector[0] > 0.9))
  assert.ok(first.some((item) => item.vector[0] < -0.9))
})

test('target model requires positive embeddings and retains bounded reviewed samples', () => {
  const built = buildFeedbackTargetModel({
    key: 'category:7',
    kind: 'category',
    id: 7,
    name: 'Product',
    positiveSampleCount: 40,
    negativeSampleCount: 20,
    positiveVectors: Array.from({ length: 40 }, (_, index) =>
      vector(`positive-${index}.jpg`, [1, index / 100, 0]),
    ),
    negativeVectors: Array.from({ length: 20 }, (_, index) =>
      vector(`negative-${index}.jpg`, [0, index / 100, 1]),
    ),
  })

  assert.ok(built)
  assert.equal(built.positivePrototypes.length, 40)
  assert.equal(built.negativePrototypes.length, 20)
  assert.equal(
    buildFeedbackTargetModel({
      key: 'tag:9',
      kind: 'tag',
      id: 9,
      name: 'Empty',
      positiveSampleCount: 0,
      negativeSampleCount: 1,
      positiveVectors: [],
      negativeVectors: [vector('negative.jpg', [1, 0])],
    }),
    null,
  )
})

test('direct target scoring requires support and suppresses the nearest rejected sample', () => {
  const supported = Array.from({ length: 8 }, (_, index) => ({
    path: `supported-${index}.jpg`,
    vector: Float32Array.from([1, index / 100, 0]),
  }))
  const model = target({
    positiveSampleCount: 9,
    negativeSampleCount: 1,
    positivePrototypes: [
      ...supported,
      { path: 'positive-outlier.jpg', vector: Float32Array.from([0, 1, 0]) },
    ],
    negativePrototypes: [{ path: 'rejected.jpg', vector: Float32Array.from([0, 1, 0]) }],
  })

  const supportedMatch = scoreAssetFeedbackTarget(Float32Array.from([1, 0, 0]), model)
  const rejectedOutlier = scoreAssetFeedbackTarget(Float32Array.from([0, 1, 0]), model)
  assert.ok(supportedMatch.score > rejectedOutlier.score)
  assert.ok(rejectedOutlier.negativeScore > supportedMatch.negativeScore)
})

test('positive feedback raises and explicit target negatives suppress within bounds', () => {
  const context = {
    mode: 'auto',
    revision: 4,
    builtRevision: 4,
    stale: false,
    targets: [{ target: target(), gate: 1, reason: 'exact label match' }],
  }
  const positive = scoreAssetFeedback(Float32Array.from([1, 0, 0]), context, 0.7)
  const negative = scoreAssetFeedback(Float32Array.from([0, 0, 1]), context, 0.7)
  const unrelated = scoreAssetFeedback(Float32Array.from([0, -1, 0]), context, 0.7)

  assert.ok(positive.boost > 0)
  assert.ok(negative.boost < 0)
  assert.equal(unrelated.boost, 0)
  assert.ok(Math.abs(positive.boost) <= 0.12)
  assert.ok(Math.abs(negative.boost) <= 0.12)
  assert.equal(
    scoreAssetFeedback(Float32Array.from([1, 0, 0]), { ...context, mode: 'off' }, 0.7).boost,
    0,
  )
})

test('direct target search uses multiple positive modes and target-level negatives', () => {
  const model = target()
  const centers = buildFeedbackSearchCenters(model, 3)
  assert.ok(centers.length >= 2)
  assert.ok(centers.some((center) => center[0] > 0.9))
  assert.ok(centers.some((center) => center[1] > 0.9))

  const firstPositive = scoreAssetFeedbackTarget(Float32Array.from([1, 0, 0]), model)
  const secondPositive = scoreAssetFeedbackTarget(Float32Array.from([0, 1, 0]), model)
  const explicitNegative = scoreAssetFeedbackTarget(Float32Array.from([0, 0, 1]), model)
  assert.ok(firstPositive.score > explicitNegative.score)
  assert.ok(secondPositive.score > explicitNegative.score)
  assert.equal(firstPositive.positiveScore, 1)
  assert.equal(explicitNegative.negativeScore, 1)
})
