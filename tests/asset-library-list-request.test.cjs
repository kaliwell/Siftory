const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const { normalizeAssetLibraryListRequest } = loadTsModule(
  'electron/assetLibraryListRequest.ts',
)

test('asset list request applies stable pagination and sort defaults', () => {
  assert.deepEqual(normalizeAssetLibraryListRequest(), {
    offset: 0,
    limit: 80,
    sort: 'updated_desc',
  })
  assert.deepEqual(
    normalizeAssetLibraryListRequest({
      offset: Number.POSITIVE_INFINITY,
      limit: Number.NaN,
      sort: 'invalid',
    }),
    {
      offset: 0,
      limit: 80,
      sort: 'updated_desc',
    },
  )
})

test('asset list request clamps pagination and preserves supported filters', () => {
  assert.deepEqual(
    normalizeAssetLibraryListRequest({
      offset: 4.9,
      limit: 999,
      sort: 'name_asc',
      query: 'cat',
      categoryId: 7,
      tagId: 9,
      unclassified: true,
      archivedOnly: true,
      source: 'manual',
      kind: 'video_frame',
      modifiedAfter: 1000.8,
      modifiedBefore: 2000.9,
      minRating: 9,
      favoriteOnly: true,
    }),
    {
      offset: 4,
      limit: 200,
      sort: 'name_asc',
      query: 'cat',
      categoryId: 7,
      tagId: 9,
      unclassified: true,
      archivedOnly: true,
      source: 'manual',
      kind: 'video_frame',
      modifiedAfter: 1000,
      modifiedBefore: 2000,
      minRating: 5,
      favoriteOnly: true,
    },
  )
  assert.equal(normalizeAssetLibraryListRequest({ offset: -3, limit: -5 }).offset, 0)
  assert.equal(normalizeAssetLibraryListRequest({ offset: -3, limit: -5 }).limit, 1)
})

test('asset list request drops empty and malformed optional filters', () => {
  assert.deepEqual(
    normalizeAssetLibraryListRequest({
      limit: 0,
      query: '',
      categoryId: 1.5,
      tagId: Number.NaN,
      unclassified: false,
      archivedOnly: false,
      source: 'remote',
      kind: 'audio',
      modifiedAfter: Number.NaN,
      modifiedBefore: Number.POSITIVE_INFINITY,
      minRating: Number.NaN,
      favoriteOnly: false,
    }),
    {
      offset: 0,
      limit: 80,
      sort: 'updated_desc',
    },
  )
})
