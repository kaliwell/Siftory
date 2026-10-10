// Unit tests for face alignment math (electron/faceAlign.ts).

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  ARCFACE_TEMPLATE,
  estimateSimilarity,
  invertAffine,
  applyAffine,
  cosineSimilarity,
  l2Normalize,
} = loadTsModule('electron/faceAlign.ts')

test('estimateSimilarity recovers a pure translation', () => {
  const src = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: 10 },
  ]
  const dst = src.map((p) => ({ x: p.x + 5, y: p.y - 3 }))
  const m = estimateSimilarity(src, dst)
  for (let i = 0; i < src.length; i++) {
    const p = applyAffine(m, src[i])
    assert.ok(Math.abs(p.x - dst[i].x) < 1e-9)
    assert.ok(Math.abs(p.y - dst[i].y) < 1e-9)
  }
})

test('estimateSimilarity recovers rotation + uniform scale + translation', () => {
  const theta = Math.PI / 6
  const s = 2.5
  const cos = Math.cos(theta) * s
  const sin = Math.sin(theta) * s
  const forward = { a: cos, b: -sin, c: sin, d: cos, tx: 7, ty: -11 }
  const src = [
    { x: 1, y: 2 },
    { x: -4, y: 5 },
    { x: 8, y: -3 },
    { x: 0, y: 0 },
    { x: 3, y: 3 },
  ]
  const dst = src.map((p) => applyAffine(forward, p))
  const m = estimateSimilarity(src, dst)
  for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty']) {
    assert.ok(Math.abs(m[key] - forward[key]) < 1e-9, `${key}: ${m[key]} vs ${forward[key]}`)
  }
})

test('invertAffine round-trips points', () => {
  const m = estimateSimilarity(
    [
      { x: 12, y: 30 },
      { x: 60, y: 28 },
      { x: 36, y: 55 },
      { x: 20, y: 80 },
      { x: 52, y: 79 },
    ],
    ARCFACE_TEMPLATE,
  )
  const inv = invertAffine(m)
  const p = { x: 33, y: 47 }
  const q = applyAffine(inv, applyAffine(m, p))
  assert.ok(Math.abs(q.x - p.x) < 1e-9)
  assert.ok(Math.abs(q.y - p.y) < 1e-9)
})

test('estimateSimilarity maps template onto itself as identity', () => {
  const m = estimateSimilarity(ARCFACE_TEMPLATE, ARCFACE_TEMPLATE)
  assert.ok(Math.abs(m.a - 1) < 1e-9 && Math.abs(m.d - 1) < 1e-9)
  assert.ok(Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9)
  assert.ok(Math.abs(m.tx) < 1e-9 && Math.abs(m.ty) < 1e-9)
})

test('estimateSimilarity rejects degenerate input', () => {
  assert.throws(() => estimateSimilarity([{ x: 1, y: 1 }], [{ x: 2, y: 2 }]))
  assert.throws(() =>
    estimateSimilarity(
      [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ],
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    ),
  )
})

test('cosineSimilarity basics', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9)
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9)
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9)
  assert.equal(cosineSimilarity([], []), 0)
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0)
})

test('l2Normalize produces unit vector and handles zero', () => {
  const v = l2Normalize([3, 4])
  assert.ok(Math.abs(v[0] - 0.6) < 1e-9 && Math.abs(v[1] - 0.8) < 1e-9)
  const z = l2Normalize([0, 0])
  assert.deepEqual(z, [0, 0])
})
