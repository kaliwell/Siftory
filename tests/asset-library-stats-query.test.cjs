const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { computeAssetLibraryRelationStats } = loadTsModule(
  'electron/assetLibraryStatsQuery.ts',
)

test('relation stats deduplicate formal classifications and ignore inactive relations', () => {
  const activeIds = new Set([1, 2])
  const stats = computeAssetLibraryRelationStats({
    categoryAssignments: [
      { assetId: 1, status: 'confirmed' },
      { assetId: 1, status: 'manual_override' },
      { assetId: 2, status: 'suggested' },
      { assetId: 3, status: 'confirmed' },
    ],
    suggestions: [
      { assetId: 1, status: 'suggested' },
      { assetId: 2, status: 'low_confidence' },
      { assetId: 3, status: 'suggested' },
    ],
    clusterMembers: [
      { clusterGroupId: 10, assetId: 1 },
      { clusterGroupId: 11, assetId: 3 },
    ],
    clusters: [
      { id: 10, status: 'confirmed' },
      { id: 11, status: 'confirmed' },
      { id: 12, status: 'ignored' },
    ],
    referenceAssetIds: [1, 2, 3],
    categoryCount: 4,
    tagCount: 5,
    isActiveAssetId: (assetId) => activeIds.has(assetId),
  })

  assert.deepEqual(stats, {
    classifiedAssets: 1,
    suggestedCount: 1,
    lowConfidenceCount: 1,
    categoryCount: 4,
    tagCount: 5,
    clusterCount: 1,
    referenceCount: 2,
  })
})
