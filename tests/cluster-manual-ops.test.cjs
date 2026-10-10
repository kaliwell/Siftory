// Integration tests for cluster manual operations + lineage (路线图 23 阶段 A):
// mergeAssetClusters / splitAssetCluster / moveAssetClusterMembers with
// lineage event recording, in the default sqlite storage mode.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  initAssetLibraryService,
  listAssetClusters,
  mergeAssetClusters,
  splitAssetCluster,
  moveAssetClusterMembers,
  listClusterLineage,
  getAssetLibraryShadowDatabase,
} = loadTsModule('electron/assetLibraryService.ts')

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-clock-cluster-ops-'))
  try {
    await run(dir)
  } finally {
    try {
      getAssetLibraryShadowDatabase()?.close()
    } catch {
      /* best effort */
    }
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const groupRecord = (id, name, count, avg, rep, status = 'suggested') => ({
  id,
  name,
  algorithm: 'compressed_kmeans',
  status,
  assetCount: count,
  avgSimilarity: avg,
  representativeAssetId: rep,
  createdAt: 1,
  updatedAt: 1,
})

const memberRecord = (id, clusterGroupId, assetId, similarity) => ({
  id,
  clusterGroupId,
  assetId,
  similarity,
  createdAt: 1,
})

async function seedLibrary(dir) {
  const libDir = path.join(dir, 'asset-library')
  await fs.mkdir(libDir, { recursive: true })
  const assets = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    path: path.join(libDir, `a${i + 1}.jpg`),
    width: 10,
    height: 10,
    fileSize: 10,
    modifiedTime: 1,
    diffHash64: '0'.repeat(16),
    dctHash64: '0'.repeat(16),
    kind: 'image',
    source: 'test',
    missing: false,
    createdAt: 1,
    updatedAt: 1,
  }))
  await fs.writeFile(
    path.join(libDir, 'assets.jsonl'),
    `${assets.map((r) => JSON.stringify(r)).join('\n')}\n`,
  )
  await fs.writeFile(path.join(libDir, 'state.json'), '{"nextId":7}')
  // group A (id 1): assets 1,2,3 confirmed; group B (id 2): assets 4,5 suggested
  await fs.writeFile(
    path.join(libDir, 'cluster_groups.jsonl'),
    `${[groupRecord(1, 'Group A', 3, 0.8, 1, 'confirmed'), groupRecord(2, 'Group B', 2, 0.55, 4)]
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`,
  )
  await fs.writeFile(
    path.join(libDir, 'cluster_group_assets.jsonl'),
    `${[
      memberRecord(1, 1, 1, 0.9),
      memberRecord(2, 1, 2, 0.8),
      memberRecord(3, 1, 3, 0.7),
      memberRecord(4, 2, 4, 0.6),
      memberRecord(5, 2, 5, 0.5),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`,
  )
}

async function groupById(list, id) {
  const clusters = await list
  return clusters.find((c) => c.group.id === id)
}

test('merge combines members, keeps confirmed status, records lineage', async () => {
  await withTempDir(async (dir) => {
    await seedLibrary(dir)
    initAssetLibraryService(dir)

    const result = await mergeAssetClusters([1, 2])
    assert.equal(result.ok, true, result.error)
    const merged = result.group
    assert.equal(merged.assetCount, 5)
    assert.equal(merged.origin, 'manual_merge')
    assert.equal(merged.status, 'confirmed') // not downgraded
    assert.equal(merged.representativeAssetId, 1) // largest group's rep
    assert.ok(merged.lineageKey)

    const clusters = await listAssetClusters()
    assert.equal(clusters.length, 1)
    assert.equal(clusters[0].group.id, merged.id)
    assert.equal(clusters[0].previewAssets.length, 5)

    const events = listClusterLineage({ groupId: merged.id })
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'merge')
    assert.deepEqual([...events[0].fromGroupIds].sort(), [1, 2])
    assert.equal(events[0].memberAssetIds.length, 5)
  })
})

test('split moves selected members into a new manual_split group', async () => {
  await withTempDir(async (dir) => {
    await seedLibrary(dir)
    initAssetLibraryService(dir)

    const result = await splitAssetCluster(1, [2, 3])
    assert.equal(result.ok, true, result.error)
    const splitGroup = result.group
    assert.equal(splitGroup.origin, 'manual_split')
    assert.equal(splitGroup.assetCount, 2)

    const clusters = await listAssetClusters()
    const original = await groupById(clusters, 1)
    assert.equal(original.group.assetCount, 1)
    assert.equal(original.group.origin, 'manual_edit')
    const created = clusters.find((c) => c.group.id === splitGroup.id)
    assert.ok(created)
    assert.deepEqual(created.previewAssets.map((p) => p.asset.id).sort(), [2, 3])

    const events = listClusterLineage({ groupId: splitGroup.id })
    assert.equal(events[0].event, 'split')
    assert.deepEqual(events[0].fromGroupIds, [1])
  })
})

test('move relocates members between groups and out of clustering', async () => {
  await withTempDir(async (dir) => {
    await seedLibrary(dir)
    initAssetLibraryService(dir)

    // move asset 3 from group 1 to group 2
    const moved = await moveAssetClusterMembers(1, 2, [3])
    assert.equal(moved.ok, true, moved.error)
    let clusters = await listAssetClusters()
    assert.equal((await groupById(clusters, 1)).group.assetCount, 2)
    assert.equal((await groupById(clusters, 2)).group.assetCount, 3)

    // move asset 5 out of clustering entirely
    const removed = await moveAssetClusterMembers(2, null, [5])
    assert.equal(removed.ok, true, removed.error)
    clusters = await listAssetClusters()
    assert.equal((await groupById(clusters, 2)).group.assetCount, 2)

    const events = listClusterLineage({ groupId: 2 })
    assert.equal(events.filter((e) => e.event === 'move').length, 2)
  })
})

test('manual operations validate inputs', async () => {
  await withTempDir(async (dir) => {
    await seedLibrary(dir)
    initAssetLibraryService(dir)

    assert.equal((await mergeAssetClusters([1])).ok, false)
    assert.equal((await mergeAssetClusters([1, 999])).ok, false)
    assert.equal((await splitAssetCluster(1, [99])).ok, false)
    assert.equal((await moveAssetClusterMembers(1, 1, [2])).ok, false)
    assert.equal((await moveAssetClusterMembers(1, 999, [2])).ok, false)
  })
})
