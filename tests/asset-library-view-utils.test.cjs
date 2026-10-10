const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  assetFileExtension,
  assetFileName,
  buildAssetCategoryRows,
  formatAssetLibraryBytes,
  formatAssetLibraryDuration,
  formatAssetLibraryNumber,
} = loadTsModule('src/components/assetLibrary/assetLibraryViewUtils.ts')

test('asset library formatters handle finite values and display boundaries', () => {
  assert.equal(formatAssetLibraryNumber(Number.NaN), '0')
  assert.equal(formatAssetLibraryDuration(undefined), '-')
  assert.equal(formatAssetLibraryDuration(65_000), '1m 5s')
  assert.equal(formatAssetLibraryDuration(3_660_000), '1h 1m')
  assert.equal(formatAssetLibraryBytes(0), '0 B')
  assert.equal(formatAssetLibraryBytes(1536), '1.5 KB')
})

test('asset library file labels support Windows and POSIX paths', () => {
  assert.equal(assetFileName('C:\\images\\Cat.JPG'), 'Cat.JPG')
  assert.equal(assetFileName('/images/dog.png'), 'dog.png')
  assert.equal(assetFileExtension('C:\\images\\Cat.JPG'), '.jpg')
  assert.equal(assetFileExtension('README'), '.readme')
})

test('category rows preserve hierarchy, ordering, and orphan visibility', () => {
  const rows = buildAssetCategoryRows([
    { id: 3, name: 'Child B', parentId: 1, color: '', sortOrder: 2 },
    { id: 4, name: 'Orphan', parentId: 99, color: '', sortOrder: 0 },
    { id: 2, name: 'Child A', parentId: 1, color: '', sortOrder: 1 },
    { id: 1, name: 'Root', parentId: null, color: '', sortOrder: 0 },
  ])

  assert.deepEqual(
    rows.map(({ category, depth }) => [category.id, depth]),
    [
      [1, 0],
      [2, 1],
      [3, 1],
      [4, 0],
    ],
  )
})
