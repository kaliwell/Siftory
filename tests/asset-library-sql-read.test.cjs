const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  getAssetLibraryShadowDatabase,
  getAssetLibraryStats,
  initAssetLibraryService,
  listAssetCategories,
  listAssetClusters,
  listAssetLibraryAssets,
  listAssetMetadataDeletions,
  listAssetSuggestions,
  listAssetTags,
} = loadTsModule('electron/assetLibraryService.ts')

function fixtureFiles(dir) {
  const assetDir = path.join(dir, 'asset-library')
  fs.mkdirSync(assetDir, { recursive: true })
  const asset = (id, missing = false) => ({
    id,
    path: `D:/fixture-assets/asset-${id}.jpg`,
    kind: 'image',
    source: 'manual',
    width: 1,
    height: 1,
    fileSize: 1,
    modifiedTime: id,
    missing,
    createdAt: id,
    updatedAt: id,
  })
  const files = {
    'assets.jsonl': [asset(1), asset(2), asset(3), asset(4), asset(5, true)],
    'state.json': null,
    'categories.jsonl': [
      {
        id: 1,
        name: '风景',
        description: '',
        parentId: null,
        color: '#ff0000',
        icon: 'mountain',
        sortOrder: 0,
        referenceThreshold: 0.5,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 2,
        name: '人物',
        description: 'people',
        parentId: 1,
        color: '#00ff00',
        icon: 'person',
        sortOrder: 1,
        createdAt: 2,
        updatedAt: 2,
      },
    ],
    'tags.jsonl': [
      { id: 1, name: 'alpha', color: '#111111', createdAt: 1, updatedAt: 1 },
      { id: 2, name: 'beta', color: '#222222', createdAt: 2, updatedAt: 2 },
    ],
    'asset_categories.jsonl': [
      {
        id: 1,
        assetId: 1,
        categoryId: 1,
        confidence: 1,
        source: 'manual',
        status: 'confirmed',
        confirmedByUser: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 2,
        assetId: 2,
        categoryId: 1,
        confidence: 0.9,
        source: 'cluster',
        status: 'suggested',
        confirmedByUser: false,
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 3,
        assetId: 5,
        categoryId: 2,
        confidence: 1,
        source: 'manual',
        status: 'confirmed',
        confirmedByUser: true,
        createdAt: 3,
        updatedAt: 3,
      },
    ],
    'asset_tags.jsonl': [
      {
        id: 1,
        assetId: 1,
        tagId: 1,
        confidence: 1,
        source: 'manual',
        status: 'confirmed',
        confirmedByUser: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 2,
        assetId: 3,
        tagId: 2,
        suggestionId: 2,
        confidence: 0.8,
        source: 'text_label',
        status: 'confirmed',
        confirmedByUser: false,
        createdAt: 2,
        updatedAt: 2,
      },
    ],
    'category_references.jsonl': [{ id: 1, categoryId: 1, assetId: 1, weight: 1.5, createdAt: 1 }],
    'suggestions.jsonl': [
      {
        id: 1,
        assetId: 2,
        categoryId: 1,
        confidence: 0.9,
        source: 'reference_image',
        status: 'suggested',
        evidenceAssetIds: [1],
        createdAt: 1,
        updatedAt: 3,
      },
      {
        id: 2,
        assetId: 3,
        tagId: 2,
        confidence: 0.7,
        source: 'text_label',
        status: 'low_confidence',
        evidenceAssetIds: [],
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 3,
        assetId: 5,
        categoryId: 2,
        confidence: 0.95,
        source: 'reference_image',
        status: 'suggested',
        evidenceAssetIds: [],
        createdAt: 3,
        updatedAt: 1,
      },
      {
        id: 4,
        assetId: 1,
        categoryId: 1,
        confidence: 0.4,
        source: 'reference_image',
        status: 'rejected',
        evidenceAssetIds: [],
        createdAt: 4,
        updatedAt: 4,
      },
    ],
    'cluster_groups.jsonl': [
      {
        id: 1,
        name: 'G1',
        algorithm: 'compressed_kmeans',
        status: 'suggested',
        assetCount: 3,
        avgSimilarity: 0.9,
        representativeAssetId: 1,
        labels: ['x'],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 2,
        name: 'G2',
        algorithm: 'semantic_zero_shot',
        status: 'suggested',
        assetCount: 2,
        avgSimilarity: 0.8,
        representativeAssetId: 2,
        createdAt: 2,
        updatedAt: 2,
      },
    ],
    'cluster_group_assets.jsonl': [
      { id: 1, clusterGroupId: 1, assetId: 1, similarity: 1.0, createdAt: 1 },
      { id: 2, clusterGroupId: 1, assetId: 2, similarity: 0.75, createdAt: 2 },
      { id: 3, clusterGroupId: 1, assetId: 3, similarity: 0.5, createdAt: 3 },
      { id: 4, clusterGroupId: 2, assetId: 2, similarity: 0.5, createdAt: 4 },
      { id: 5, clusterGroupId: 2, assetId: 4, similarity: 0.25, createdAt: 5 },
      // Missing asset 5 has the highest similarity but must not affect the
      // active cluster summary or preview.
      { id: 6, clusterGroupId: 2, assetId: 5, similarity: 0.99, createdAt: 6 },
    ],
    'metadata_deletion_trash.jsonl': [
      {
        id: 1,
        kind: 'category',
        name: 'old-cat',
        category: {
          id: 9,
          name: 'old-cat',
          description: '',
          parentId: null,
          color: '#000000',
          icon: 'x',
          sortOrder: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        categoryAssignments: [
          {
            id: 7,
            assetId: 1,
            categoryId: 9,
            confidence: 1,
            source: 'manual',
            status: 'confirmed',
            confirmedByUser: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        tagAssignments: [],
        references: [],
        suggestions: [],
        deletedAt: 100,
      },
      {
        id: 2,
        kind: 'tag',
        name: 'old-tag',
        tag: { id: 8, name: 'old-tag', color: '#000000', createdAt: 1, updatedAt: 1 },
        categoryAssignments: [],
        tagAssignments: [],
        references: [],
        suggestions: [],
        deletedAt: 50,
        restoredAt: 60,
      },
    ],
  }
  for (const [name, records] of Object.entries(files)) {
    if (name === 'state.json') {
      fs.writeFileSync(path.join(assetDir, name), '{"nextId":6}', 'utf8')
      continue
    }
    fs.writeFileSync(
      path.join(assetDir, name),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    )
  }
}

// IPC responses cross a JSON boundary anyway; normalize both sides so that
// undefined-valued keys never affect the comparison.
const json = (value) => JSON.parse(JSON.stringify(value))

async function collectOutputs(mode) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asset-library-sql-read-'))
  try {
    fixtureFiles(dir)
    initAssetLibraryService(dir, { storageMode: mode })
    const outputs = {
      stats: await getAssetLibraryStats(),
      byCategory: await listAssetLibraryAssets({ categoryId: 1 }),
      byTag: await listAssetLibraryAssets({ tagId: 2 }),
      unclassified: await listAssetLibraryAssets({ unclassified: true }),
      page: await listAssetLibraryAssets({ limit: 2, offset: 1 }),
      categories: listAssetCategories(),
      tags: listAssetTags(),
      deletionsAll: listAssetMetadataDeletions({}),
      deletionsPending: listAssetMetadataDeletions({ status: 'pending' }),
      deletionsRestored: listAssetMetadataDeletions({ status: 'restored' }),
      suggestionsAll: await listAssetSuggestions({}),
      suggestionsStatus: await listAssetSuggestions({ status: 'suggested' }),
      suggestionsSource: await listAssetSuggestions({ source: 'text_label' }),
      suggestionsPage: await listAssetSuggestions({ limit: 1, offset: 1 }),
      clusters: await listAssetClusters(),
    }
    const shadow = getAssetLibraryShadowDatabase()
    if (shadow) {
      outputs.helperPairs = shadow.categoryAssignmentPairRows()
      outputs.helperReviewed = shadow.reviewedSuggestionPairRows('reference_image', 'category')
      outputs.helperAggregates = shadow.clusterMemberAggregates()
      outputs.helperActiveAggregates = shadow.clusterMemberAggregates([5])
      outputs.helperTopMembers = shadow.clusterTopMembers(1, 8)
      outputs.helperFormalCount = shadow.formalAssignedAssetCount([5])
      outputs.helperReferenceCount = shadow.activeReferenceCount([5])
      outputs.helperEntityCounts = shadow.categoryAndTagCounts()
    }
    return outputs
  } finally {
    try {
      getAssetLibraryShadowDatabase()?.close()
    } catch {
      // best effort cleanup
    }
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

test('SQL read path matches the legacy JSONL read path item by item', async () => {
  const legacy = await collectOutputs('jsonl')
  const sql = await collectOutputs('sqlite')

  const compared = [
    'stats',
    'byCategory',
    'byTag',
    'unclassified',
    'page',
    'categories',
    'tags',
    'deletionsAll',
    'deletionsPending',
    'deletionsRestored',
    'suggestionsAll',
    'suggestionsStatus',
    'suggestionsSource',
    'suggestionsPage',
    'clusters',
  ]
  for (const key of compared) {
    assert.deepEqual(json(sql[key]), json(legacy[key]), `read result mismatch: ${key}`)
  }

  // §4 item 7 helpers: pair sets, aggregates and top members equal the
  // fixture-derived expectations used by the legacy getAll() loops.
  assert.deepEqual(
    json(sql.helperPairs),
    json([
      { assetId: 1, categoryId: 1 },
      { assetId: 2, categoryId: 1 },
      { assetId: 5, categoryId: 2 },
    ]),
  )
  assert.deepEqual(json(sql.helperReviewed), json([{ assetId: 1, targetId: 1 }]))
  assert.deepEqual(
    json(sql.helperAggregates),
    json([
      { clusterGroupId: 1, count: 3, similarityTotal: 2.25 },
      { clusterGroupId: 2, count: 3, similarityTotal: 1.74 },
    ]),
  )
  assert.deepEqual(
    json(sql.helperActiveAggregates),
    json([
      { clusterGroupId: 1, count: 3, similarityTotal: 2.25 },
      { clusterGroupId: 2, count: 2, similarityTotal: 0.75 },
    ]),
  )
  assert.deepEqual(
    json(sql.helperTopMembers),
    json([
      { assetId: 1, similarity: 1.0 },
      { assetId: 2, similarity: 0.75 },
      { assetId: 3, similarity: 0.5 },
    ]),
  )
  assert.equal(sql.helperFormalCount, 1)
  assert.equal(sql.helperReferenceCount, 1)
  assert.deepEqual(sql.helperEntityCounts, { categories: 2, tags: 2 })
  // sanity: the fixture actually exercised both data paths
  assert.equal(legacy.stats.classifiedAssets, 1)
  assert.equal(legacy.byCategory.total, 1)
  assert.equal(legacy.suggestionsAll.total, 3)
  assert.ok(sql.helperPairs)
})
