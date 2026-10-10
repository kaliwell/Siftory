// ── Vector Pipeline Unit Tests ──────────────────────────────
// Tests pure functions: color similarity, shape similarity,
// overlay filtering, vector normalization.

const { describe, it } = require('node:test')
const assert = require('node:assert')

// ── Color similarity (standalone re-implementation for test) ─

function colorSimilarity(a, b) {
  if (a.length !== b.length) return 0
  let intersection = 0
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < a.length; i++) {
    intersection += Math.min(a[i], b[i])
    sumA += a[i]
    sumB += b[i]
  }
  const denom = Math.max(sumA, sumB) || 1
  return intersection / denom
}

// ── Shape similarity ────────────────────────────────────────

function shapeSimilarity(a, b) {
  const arDiff = Math.abs(a.aspectRatio - b.aspectRatio)
  const arScore = Math.max(0, 1 - arDiff / Math.max(a.aspectRatio, b.aspectRatio, 0.1))
  const areaDiff = Math.abs(a.objectAreaRatio - b.objectAreaRatio)
  const areaScore = Math.max(0, 1 - areaDiff)
  const edgeDiff = Math.abs(a.edgeDensity - b.edgeDensity)
  const edgeScore = Math.max(0, 1 - edgeDiff / Math.max(a.edgeDensity, b.edgeDensity, 0.01))
  return 0.5 * arScore + 0.3 * areaScore + 0.2 * edgeScore
}

// ── Weight normalization ────────────────────────────────────

function normalizeWeights(hasVector, hasHash, hasColor, hasShape) {
  let wVector = hasVector ? 0.45 : 0
  let wHash = hasHash ? 0.15 : 0
  let wColor = hasColor ? 0.2 : 0
  let wShape = hasShape ? 0.2 : 0
  const total = wVector + wHash + wColor + wShape
  if (total === 0) return { wVector: 1, wHash: 0, wColor: 0, wShape: 0 }
  return {
    wVector: wVector / total,
    wHash: wHash / total,
    wColor: wColor / total,
    wShape: wShape / total,
  }
}

// ── Vector normalization ────────────────────────────────────

function normalizeVector(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
  if (norm === 0) return vec
  return vec.map((v) => v / norm)
}

function cosineScore(a, b) {
  const len = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < len; i++) dot += a[i] * b[i]
  return (dot + 1) / 2 // [0, 2] → [0, 1]
}

// ── Tests ───────────────────────────────────────────────────

describe('Vector Pipeline', () => {
  describe('colorSimilarity', () => {
    it('returns 1 for identical histograms', () => {
      const h = [0.1, 0.2, 0.3, 0.4]
      assert.strictEqual(colorSimilarity(h, h), 1)
    })

    it('returns 0 for disjoint histograms', () => {
      const a = [1, 0, 0, 0]
      const b = [0, 1, 0, 0]
      assert.strictEqual(colorSimilarity(a, b), 0)
    })

    it('returns intermediate value for partial overlap', () => {
      const a = [0.5, 0.5, 0, 0]
      const b = [0.5, 0, 0.5, 0]
      const score = colorSimilarity(a, b)
      assert.ok(score > 0 && score < 1, `expected 0 < ${score} < 1`)
    })

    it('handles different length arrays gracefully', () => {
      assert.strictEqual(colorSimilarity([1, 2], [1, 2, 3]), 0)
    })
  })

  describe('shapeSimilarity', () => {
    it('returns 1 for identical shapes', () => {
      const s = { aspectRatio: 1.5, objectAreaRatio: 0.6, edgeDensity: 0.1 }
      assert.strictEqual(shapeSimilarity(s, s), 1)
    })

    it('returns lower score for different aspect ratios', () => {
      const a = { aspectRatio: 1.0, objectAreaRatio: 0.5, edgeDensity: 0.1 }
      const b = { aspectRatio: 2.0, objectAreaRatio: 0.5, edgeDensity: 0.1 }
      const score = shapeSimilarity(a, b)
      assert.ok(score < 0.9, `expected < 0.9, got ${score}`)
    })
  })

  describe('normalizeWeights', () => {
    it('sums to 1 with all features present', () => {
      const w = normalizeWeights(true, true, true, true)
      const sum = w.wVector + w.wHash + w.wColor + w.wShape
      assert.ok(Math.abs(sum - 1) < 0.001, `sum=${sum}`)
    })

    it('normalizes when only hash is present', () => {
      const w = normalizeWeights(false, true, false, false)
      assert.strictEqual(w.wHash, 1)
      assert.strictEqual(w.wVector, 0)
      assert.strictEqual(w.wColor, 0)
      assert.strictEqual(w.wShape, 0)
    })

    it('handles no features gracefully', () => {
      const w = normalizeWeights(false, false, false, false)
      assert.strictEqual(w.wVector, 1)
    })
  })

  describe('cosine similarity', () => {
    it('returns 1 for identical normalized vectors', () => {
      const v = normalizeVector([1, 2, 3, 4])
      assert.ok(Math.abs(cosineScore(v, v) - 1) < 0.001)
    })

    it('returns ~0.5 for orthogonal normalized vectors', () => {
      const a = normalizeVector([1, 0, 0, 0])
      const b = normalizeVector([0, 1, 0, 0])
      const s = cosineScore(a, b)
      assert.ok(Math.abs(s - 0.5) < 0.001, `expected 0.5, got ${s}`)
    })

    it('returns less than 0.5 for opposite vectors', () => {
      const a = normalizeVector([1, 0, 0, 0])
      const b = normalizeVector([-1, 0, 0, 0])
      const s = cosineScore(a, b)
      assert.ok(s < 0.001, `expected ~0, got ${s}`)
    })
  })
})
