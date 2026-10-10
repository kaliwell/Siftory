// Unit tests for cluster recalc inheritance (路线图 23 阶段 B 纯函数):
// computeClusterInheritance — Jaccard ≥ 0.5 identity/name/status inheritance.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const { computeClusterInheritance } = loadTsModule('electron/assetClusterInheritance.ts')

const group = (id, status = 'suggested', lineageKey, name = `G${id}`) => ({
  id,
  name,
  algorithm: 'compressed_kmeans',
  status,
  assetCount: 0,
  avgSimilarity: 0,
  representativeAssetId: 0,
  ...(lineageKey ? { lineageKey } : {}),
  createdAt: 1,
  updatedAt: 1,
})

test('inherits identity when Jaccard ≥ 0.5', () => {
  const old = [group(7, 'confirmed', 'lg-7', 'My Group')]
  const memberSets = new Map([[7, new Set([1, 2, 3, 4])]])
  // new cluster shares 3/5 with old group 7 → jaccard 3/5 = 0.6
  const result = computeClusterInheritance(old, memberSets, [[1, 2, 3, 5]])
  assert.equal(result.size, 1)
  const inherit = result.get(0)
  assert.equal(inherit.fromGroupId, 7)
  assert.equal(inherit.lineageKey, 'lg-7')
  assert.equal(inherit.status, 'confirmed')
  assert.equal(inherit.name, 'My Group') // confirmed → name inherited
})

test('below-threshold matches do not inherit', () => {
  const old = [group(7)]
  const memberSets = new Map([[7, new Set([1, 2, 3, 4, 5, 6, 7, 8])]])
  // shares 3/9 ≈ 0.33
  const result = computeClusterInheritance(old, memberSets, [[1, 2, 3, 9, 10, 11]])
  assert.equal(result.size, 0)
})

test('suggested old groups keep generated names (no name field)', () => {
  const old = [group(7, 'suggested', 'lg-7')]
  const memberSets = new Map([[7, new Set([1, 2, 3])]])
  const result = computeClusterInheritance(old, memberSets, [[1, 2, 3]])
  assert.equal(result.get(0).name, undefined)
  assert.equal(result.get(0).status, 'suggested')
})

test('missing lineageKey falls back to lg-<id>', () => {
  const old = [group(42)]
  const memberSets = new Map([[42, new Set([1, 2])]])
  const result = computeClusterInheritance(old, memberSets, [[1, 2]])
  assert.equal(result.get(0).lineageKey, 'lg-42')
})

test('each old group is consumed at most once', () => {
  const old = [group(7)]
  const memberSets = new Map([[7, new Set([1, 2, 3, 4])]])
  // two new clusters both overlap group 7; the better (first) match wins
  const result = computeClusterInheritance(old, memberSets, [
    [1, 2, 3, 4],
    [1, 2, 3, 9],
  ])
  assert.equal(result.size, 1)
  assert.equal(result.get(0).fromGroupId, 7)
  assert.equal(result.has(1), false)
})

test('empty inputs yield no inheritance', () => {
  assert.equal(computeClusterInheritance([], new Map(), []).size, 0)
  const old = [group(7)]
  assert.equal(computeClusterInheritance(old, new Map(), [[1, 2]]).size, 0)
})
