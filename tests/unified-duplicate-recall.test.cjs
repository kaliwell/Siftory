const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const { recallDuplicateGroupHits } = loadTsModule('electron/unifiedDuplicateRecall.ts')

function asset(id, path, extra = {}) {
  return { id, path, missing: false, archived: false, ...extra }
}

test('persisted exact and near groups recall active peers and deduplicate strongest path', () => {
  const assets = new Map([
    [1, asset(1, 'D:\\library\\query.jpg')],
    [2, asset(2, 'D:\\library\\copy.jpg')],
    [3, asset(3, 'D:\\library\\near.jpg')],
    [4, asset(4, 'D:\\library\\missing.jpg', { missing: true })],
  ])
  const hits = recallDuplicateGroupHits({
    referenceAssetId: 1,
    groups: [
      { id: 10, algorithm: 'duplicate_near', status: 'suggested', avgSimilarity: 0.82 },
      { id: 11, algorithm: 'duplicate_exact', status: 'confirmed', avgSimilarity: 1 },
      { id: 12, algorithm: 'duplicate_exact', status: 'ignored', avgSimilarity: 1 },
    ],
    members: [
      { clusterGroupId: 10, assetId: 1, similarity: 1 },
      { clusterGroupId: 10, assetId: 2, similarity: 0.84 },
      { clusterGroupId: 10, assetId: 3, similarity: 0.91 },
      { clusterGroupId: 11, assetId: 1, similarity: 1 },
      { clusterGroupId: 11, assetId: 2, similarity: 1 },
      { clusterGroupId: 11, assetId: 4, similarity: 1 },
      { clusterGroupId: 12, assetId: 1, similarity: 1 },
      { clusterGroupId: 12, assetId: 3, similarity: 1 },
    ],
    getAssetById: (id) => assets.get(id),
  })
  assert.deepEqual(hits, [
    { displayPath: 'D:\\library\\copy.jpg', score: 1 },
    { displayPath: 'D:\\library\\near.jpg', score: 0.91 },
  ])
})

test('reference outside persisted duplicate groups has no duplicate recall', () => {
  assert.deepEqual(
    recallDuplicateGroupHits({
      referenceAssetId: 99,
      groups: [{ id: 10, algorithm: 'duplicate_exact', status: 'confirmed' }],
      members: [{ clusterGroupId: 10, assetId: 1, similarity: 1 }],
      getAssetById: () => undefined,
    }),
    [],
  )
})
