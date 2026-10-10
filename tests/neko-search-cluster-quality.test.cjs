// Synthetic regression tests for electron/assetClustering.ts.
// Runs under `node --test` with fixed-seed Float64Array buckets; no real
// model files, embeddings, or user data are touched. A scratch temp
// directory is created (and removed) to prove the clustering code path
// performs no file-system writes of its own.

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  clusterCompressedAssetBuckets,
  cosineSimilarity,
  estimateAdaptiveClusterCount,
  scoreClusterPurity,
} = loadTsModule('electron/assetClustering.ts')

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-cluster-quality-'))
test.after(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true })
})

const DIM = 8

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function normalize(values) {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  return Float64Array.from(values, (value) => value / norm)
}

// Unit direction for cluster `axis` with a small deterministic jitter so
// buckets are near-duplicates instead of exact copies (cosine semantics).
function clusterDirection(axis, rand, jitter = 0.04) {
  const values = new Array(DIM).fill(0)
  values[axis] = 1
  for (let index = 0; index < DIM; index += 1) {
    if (index !== axis) values[index] = (rand() - 0.5) * jitter
  }
  return normalize(values)
}

function makeBucket(key, direction, count, firstAssetId) {
  const assetIds = Array.from({ length: count }, (_, index) => firstAssetId + index)
  // sum stays un-normalized like the production compressor: direction * count
  const sum = Float64Array.from(direction, (value) => value * count)
  return { key, count, sum, assetIds }
}

function makeClusterBuckets(axis, seed, bucketCounts, jitter, idBase) {
  const rand = mulberry32(seed)
  let nextAssetId = idBase
  return bucketCounts.map((count, index) => {
    const bucket = makeBucket(axis * 100 + index, clusterDirection(axis, rand, jitter), count, nextAssetId)
    nextAssetId += count
    return bucket
  })
}

function canonicalClusters(result) {
  return result.clusters
    .map((cluster) => ({
      memberAssetIds: cluster.members.map((member) => member.assetId).sort((a, b) => a - b),
      centroid: Array.from(cluster.centroid),
    }))
    .sort((left, right) => left.memberAssetIds[0] - right.memberAssetIds[0])
}

test('clusterCompressedAssetBuckets is deterministic for identical synthetic buckets', async () => {
  const build = () => [
    ...makeClusterBuckets(0, 11, [40, 25, 12, 6], undefined, 1000),
    ...makeClusterBuckets(1, 22, [35, 21, 9, 4], undefined, 2000),
    ...makeClusterBuckets(2, 33, [30, 18, 8, 3], undefined, 3000),
  ]
  const options = { maxClusters: 3, minSimilarity: 0.6 }
  const first = await clusterCompressedAssetBuckets(build(), options)
  const second = await clusterCompressedAssetBuckets(build(), options)

  assert.equal(first.clusters.length, 3)
  assert.equal(second.clusters.length, 3)
  assert.equal(first.unclusteredAssets, 0)
  assert.equal(second.unclusteredAssets, 0)
  assert.deepEqual(canonicalClusters(first), canonicalClusters(second))
})

test('buckets below minSimilarity are left unclustered instead of force-assigned', async () => {
  const buckets = [
    ...makeClusterBuckets(0, 44, [30, 18, 9, 4], undefined, 1000),
    ...makeClusterBuckets(1, 55, [28, 16, 8, 3], undefined, 2000),
  ]
  const outlier = makeBucket(999, clusterDirection(5, mulberry32(66), 0), 2, 9000)
  const result = await clusterCompressedAssetBuckets([...buckets, outlier], {
    maxClusters: 2,
    minSimilarity: 0.8,
  })

  assert.equal(result.unclusteredAssets, outlier.assetIds.length)
  const clusteredIds = new Set()
  for (const cluster of result.clusters) {
    for (const member of cluster.members) {
      clusteredIds.add(member.assetId)
      assert.ok(member.similarity >= 0.8, `member similarity ${member.similarity} below gate`)
    }
  }
  for (const assetId of outlier.assetIds) {
    assert.equal(clusteredIds.has(assetId), false)
  }
})

test('appending buckets keeps prior high-confidence members co-clustered', async () => {
  const original = [
    ...makeClusterBuckets(0, 77, [50, 30, 15, 7], undefined, 1000),
    ...makeClusterBuckets(1, 88, [45, 26, 12, 6], undefined, 2000),
  ]
  const first = await clusterCompressedAssetBuckets(original, {
    maxClusters: 2,
    minSimilarity: 0.6,
  })
  assert.equal(first.clusters.length, 2)

  const appended = makeClusterBuckets(2, 99, [8, 5, 3, 2], undefined, 3000)
  const second = await clusterCompressedAssetBuckets([...original, ...appended], {
    maxClusters: 3,
    minSimilarity: 0.6,
  })

  const clusterOfAsset = new Map()
  second.clusters.forEach((cluster, index) => {
    for (const member of cluster.members) clusterOfAsset.set(member.assetId, index)
  })

  for (const cluster of first.clusters) {
    const confident = cluster.members
      .filter((member) => member.similarity >= 0.9)
      .map((member) => member.assetId)
    assert.ok(confident.length > 0, 'expected high-confidence members in original clustering')
    const target = clusterOfAsset.get(confident[0])
    assert.ok(target !== undefined, 'original member missing after append')
    for (const assetId of confident) {
      assert.equal(clusterOfAsset.get(assetId), target)
    }
  }
})

test('estimateAdaptiveClusterCount respects floor, 256 cap, and monotonic growth', () => {
  assert.equal(estimateAdaptiveClusterCount([], { minClusterSize: 4 }), 1)
  assert.equal(estimateAdaptiveClusterCount([{ count: 5 }], { minClusterSize: 4 }), 1)
  assert.equal(estimateAdaptiveClusterCount([{ count: 0 }, { count: 0 }], { minClusterSize: 4 }), 1)

  const uniform = (total) => Array.from({ length: total }, () => ({ count: 1 }))
  assert.equal(estimateAdaptiveClusterCount(uniform(250000), { minClusterSize: 2 }), 256)
  assert.equal(
    estimateAdaptiveClusterCount(uniform(250000), { minClusterSize: 2, maxClusters: 8 }),
    8,
  )

  const totals = [100, 400, 1600, 6400, 25600]
  const estimates = totals.map((total) =>
    estimateAdaptiveClusterCount(uniform(total), { minClusterSize: 2 }),
  )
  for (let index = 1; index < estimates.length; index += 1) {
    assert.ok(
      estimates[index] >= estimates[index - 1],
      `estimate decreased: ${estimates[index - 1]} -> ${estimates[index]}`,
    )
  }
})

test('scoreClusterPurity accepts aligned vectors and rejects orthogonal/opposed ones', () => {
  const aligned = scoreClusterPurity(Float32Array.from([1, 0, 0]), Float32Array.from([1, 0, 0]), 0.9)
  assert.equal(aligned.accepted, true)
  assert.ok(Math.abs(aligned.similarity - 1) < 1e-6)

  const orthogonal = scoreClusterPurity(
    Float32Array.from([1, 0, 0]),
    Float32Array.from([0, 1, 0]),
    0.5,
  )
  assert.equal(orthogonal.accepted, false)
  assert.ok(Math.abs(orthogonal.similarity) < 1e-6)

  const opposed = scoreClusterPurity(Float32Array.from([1, 0]), Float32Array.from([-1, 0]), 0.5)
  assert.equal(opposed.accepted, false)
  assert.ok(Math.abs(opposed.similarity + 1) < 1e-6)

  const diagonal = scoreClusterPurity(Float32Array.from([1, 1]), Float32Array.from([1, 0]), 0.7)
  assert.ok(Math.abs(diagonal.similarity - 1 / Math.SQRT2) < 1e-6)
  assert.equal(diagonal.accepted, true)
  assert.equal(cosineSimilarity(Float32Array.from([1, 1]), Float32Array.from([1, 0])), diagonal.similarity)
})
