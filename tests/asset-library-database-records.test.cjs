const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { TABLE_SPECS, canonicalJson, hashNormalizedRecords } = loadTsModule(
  'electron/assetLibraryDatabaseRecords.ts',
)
const { SCHEMA_DDL, SCHEMA_VERSION } = loadTsModule('electron/assetLibraryDatabaseSchema.ts')

test('extracted asset-library schema and table registry preserve the SQLite contract', () => {
  assert.equal(SCHEMA_VERSION, 2)
  assert.equal(
    crypto.createHash('sha256').update(SCHEMA_DDL).digest('hex'),
    '93e9dd08032a25f5f5b7709d10ef49d2ec38a064a7c8810e7df65744feaea819',
  )
  assert.deepEqual(
    TABLE_SPECS.map(({ name, file }) => [name, file]),
    [
      ['categories', 'categories.jsonl'],
      ['tags', 'tags.jsonl'],
      ['category_references', 'category_references.jsonl'],
      ['asset_categories', 'asset_categories.jsonl'],
      ['asset_tags', 'asset_tags.jsonl'],
      ['suggestions', 'suggestions.jsonl'],
      ['cluster_groups', 'cluster_groups.jsonl'],
      ['cluster_members', 'cluster_group_assets.jsonl'],
      ['metadata_deletion_trash', 'metadata_deletion_trash.jsonl'],
    ],
  )
})

test('canonical JSON and sampled hashes remain independent of object and record order', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, x: undefined }, b: [3, null] }),
    '{"a":{"y":2},"b":[3,null],"z":1}',
  )

  const records = [
    { id: 2, nested: { z: 3, a: 1 }, name: 'beta' },
    { name: 'alpha', id: 1, tags: ['b', 'a'] },
  ]
  const reordered = [
    { tags: ['b', 'a'], id: 1, name: 'alpha' },
    { name: 'beta', nested: { a: 1, z: 3 }, id: 2 },
  ]
  const expected = '16b4a23a0f436a2174719ad6b5ea87bdc92cd80084c7c744fab247e42cbf73bf'
  assert.equal(hashNormalizedRecords(records), expected)
  assert.equal(hashNormalizedRecords(reordered), expected)
})

test('category JSON, SQLite row and bind mappings keep identical defaults and field order', () => {
  const categories = TABLE_SPECS.find(({ name }) => name === 'categories')
  assert.ok(categories)

  const normalized = {
    id: 7,
    name: 'product',
    description: '',
    parentId: null,
    color: '#123456',
    icon: 'box',
    sortOrder: 3,
    referenceThreshold: 0.75,
    sourceClusterGroupId: null,
    createdAt: 10,
    updatedAt: 20,
  }
  assert.deepEqual(
    categories.fromJson({
      id: 7,
      name: 'product',
      color: '#123456',
      icon: 'box',
      sortOrder: 3,
      referenceThreshold: 0.75,
      createdAt: 10,
      updatedAt: 20,
    }),
    normalized,
  )
  assert.deepEqual(
    categories.fromRow({
      id: 7,
      name: 'product',
      description: '',
      parent_id: null,
      color: '#123456',
      icon: 'box',
      sort_order: 3,
      reference_threshold: 0.75,
      source_cluster_group_id: null,
      created_at: 10,
      updated_at: 20,
    }),
    normalized,
  )
  assert.deepEqual(categories.toValues(normalized), [
    7,
    'product',
    '',
    null,
    '#123456',
    'box',
    3,
    0.75,
    null,
    10,
    20,
  ])
})
