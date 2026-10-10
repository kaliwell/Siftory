const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { normalizeAssetSuggestionListRequest } = loadTsModule(
  'electron/assetSuggestionListRequest.ts',
)

test('suggestion list request applies bounded pagination defaults', () => {
  assert.deepEqual(normalizeAssetSuggestionListRequest(), {
    offset: 0,
    limit: 80,
  })
  assert.deepEqual(
    normalizeAssetSuggestionListRequest({
      offset: Number.POSITIVE_INFINITY,
      limit: Number.NaN,
    }),
    {
      offset: 0,
      limit: 80,
    },
  )
  assert.equal(normalizeAssetSuggestionListRequest({ offset: 4.9, limit: 999 }).offset, 4)
  assert.equal(normalizeAssetSuggestionListRequest({ offset: 4.9, limit: 999 }).limit, 200)
  assert.equal(normalizeAssetSuggestionListRequest({ offset: -3, limit: -5 }).limit, 1)
})

test('suggestion list request preserves concrete filters and drops all', () => {
  assert.deepEqual(
    normalizeAssetSuggestionListRequest({
      status: 'rejected',
      source: 'reference_image',
    }),
    {
      offset: 0,
      limit: 80,
      status: 'rejected',
      source: 'reference_image',
    },
  )
  assert.deepEqual(
    normalizeAssetSuggestionListRequest({
      status: 'all',
      source: 'all',
    }),
    {
      offset: 0,
      limit: 80,
    },
  )
})
