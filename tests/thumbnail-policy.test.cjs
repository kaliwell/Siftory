const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { bucketThumbnailDimension, classifyThumbnailSource } = loadTsModule(
  'shared/thumbnailPolicy.ts',
)

test('thumbnail dimensions share 64, 128, and 256 pixel cache buckets', () => {
  assert.equal(bucketThumbnailDimension(24), 64)
  assert.equal(bucketThumbnailDimension(48), 64)
  assert.equal(bucketThumbnailDimension(80), 128)
  assert.equal(bucketThumbnailDimension(128), 128)
  assert.equal(bucketThumbnailDimension(160), 256)
  assert.equal(bucketThumbnailDimension(512), 256)
})

test('thumbnail source classification uses the stricter byte or pixel tier', () => {
  assert.equal(
    classifyThumbnailSource({ fileBytes: 500_000, width: 1_000, height: 1_000 }).tier,
    'small',
  )
  assert.equal(
    classifyThumbnailSource({ fileBytes: 500_000, width: 5_184, height: 3_888 }).tier,
    'large',
  )
  assert.equal(
    classifyThumbnailSource({ fileBytes: 12 * 1024 * 1024, width: 2_000, height: 2_000 }).tier,
    'large',
  )
})

test('thumbnail source classification rejects decompression-bomb dimensions', () => {
  const policy = classifyThumbnailSource({
    fileBytes: 1_000_000,
    width: 20_000,
    height: 20_000,
  })
  assert.equal(policy.tier, 'unsafe')
  assert.equal(policy.safeToDecode, false)
})
