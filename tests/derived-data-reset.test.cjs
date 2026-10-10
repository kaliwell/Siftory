const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { previewProcessedImageData, clearProcessedImageData } = loadTsModule(
  'electron/derivedDataResetService.ts',
)

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-derived-data-reset-'))
}

function write(root, relativePath, bytes = 10) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.alloc(bytes, 1))
  return target
}

function fullFixture(root) {
  // targets
  write(root, 'image-search-index/segment.bin', 14)
  write(root, 'image-search-index/nested/part.bin', 16)
  write(root, 'thumbcache/a.jpg', 11)
  write(root, 'thumbcache/b.jpg', 7)
  write(root, 'vector-db/embeddings/dino.jsonl', 13)
  write(root, 'vector-db/embedding-cache/dino.f16', 12)
  write(root, 'image-search-scan.log', 5)
  write(root, 'image-search-scan.log.1', 9)
  // preserved non-targets
  write(root, 'models/x.bin', 100)
  write(root, 'media-search/frames/a.jpg', 101)
  write(root, 'config.json', 102)
  write(root, 'other.log', 103)
  return { totalFiles: 8, totalBytes: 14 + 16 + 11 + 7 + 13 + 12 + 5 + 9 }
}

function category(preview, id) {
  const found = preview.categories.find((entry) => entry.id === id)
  assert.ok(found, `expected category ${id} in preview`)
  return found
}

test('preview aggregates all four target categories and excludes non-targets', async () => {
  const root = fixture()
  const { totalFiles, totalBytes } = fullFixture(root)

  const preview = await previewProcessedImageData(root)

  assert.deepEqual(preview.categories.map((entry) => entry.id).sort(), [
    'image-search-index',
    'scan-logs',
    'thumbnails',
    'vector-db',
  ])
  assert.equal(category(preview, 'image-search-index').fileCount, 2)
  assert.equal(category(preview, 'image-search-index').estimatedBytes, 30)
  assert.equal(category(preview, 'thumbnails').fileCount, 2)
  assert.equal(category(preview, 'thumbnails').estimatedBytes, 18)
  assert.equal(category(preview, 'vector-db').fileCount, 2)
  assert.equal(category(preview, 'vector-db').estimatedBytes, 25)
  assert.equal(category(preview, 'scan-logs').fileCount, 2)
  assert.equal(category(preview, 'scan-logs').estimatedBytes, 14)
  assert.equal(preview.fileCount, totalFiles)
  assert.equal(preview.estimatedBytes, totalBytes)
  assert.equal(JSON.stringify(preview).includes('models'), false)
  assert.equal(JSON.stringify(preview).includes('media-search'), false)
  assert.equal(JSON.stringify(preview).includes('other.log'), false)
})

test('clear removes every target, preserves non-targets byte-for-byte, and reports totals', async () => {
  const root = fixture()
  const { totalFiles, totalBytes } = fullFixture(root)

  const result = await clearProcessedImageData(root)

  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.equal(result.freedBytes, totalBytes)
  assert.equal(result.deletedFiles, totalFiles)

  assert.equal(fs.existsSync(path.join(root, 'image-search-index', 'segment.bin')), false)
  assert.equal(fs.existsSync(path.join(root, 'image-search-index', 'nested', 'part.bin')), false)
  assert.equal(fs.existsSync(path.join(root, 'thumbcache', 'a.jpg')), false)
  assert.equal(fs.existsSync(path.join(root, 'thumbcache', 'b.jpg')), false)
  assert.equal(fs.existsSync(path.join(root, 'vector-db', 'embeddings', 'dino.jsonl')), false)
  assert.equal(fs.existsSync(path.join(root, 'vector-db', 'embedding-cache', 'dino.f16')), false)
  assert.equal(fs.existsSync(path.join(root, 'image-search-scan.log')), false)
  assert.equal(fs.existsSync(path.join(root, 'image-search-scan.log.1')), false)

  for (const [relativePath, bytes] of [
    ['models/x.bin', 100],
    ['media-search/frames/a.jpg', 101],
    ['config.json', 102],
    ['other.log', 103],
  ]) {
    const preserved = path.join(root, relativePath)
    assert.equal(fs.existsSync(preserved), true, `${relativePath} must survive`)
    assert.deepEqual(fs.readFileSync(preserved), Buffer.alloc(bytes, 1))
  }
})

test('clear on an empty userData directory is a successful no-op', async () => {
  const root = fixture()

  const result = await clearProcessedImageData(root)

  assert.equal(result.ok, true)
  assert.equal(result.deletedFiles, 0)
  assert.equal(result.freedBytes, 0)
  assert.deepEqual(result.errors, [])

  const preview = await previewProcessedImageData(root)
  assert.equal(preview.fileCount, 0)
  assert.equal(preview.estimatedBytes, 0)
})

test('preview handles a cache larger than the JavaScript argument limit', async () => {
  const root = fixture()
  const cache = path.join(root, 'thumbcache')
  fs.mkdirSync(cache, { recursive: true })
  const count = 130_000
  const originalReaddir = fs.promises.readdir
  const originalLstat = fs.promises.lstat
  fs.promises.readdir = async (target, ...args) => {
    if (target === cache) return Array.from({ length: count }, (_, index) => `thumb-${index}.jpg`)
    return originalReaddir.call(fs.promises, target, ...args)
  }
  fs.promises.lstat = async (target, ...args) => {
    if (path.dirname(target) === cache) {
      return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: 1 }
    }
    return originalLstat.call(fs.promises, target, ...args)
  }
  try {
    const preview = await previewProcessedImageData(root)
    assert.equal(preview.fileCount, count)
    assert.equal(preview.estimatedBytes, count)
  } finally {
    fs.promises.readdir = originalReaddir
    fs.promises.lstat = originalLstat
  }
})

test('clear never follows junctions or symlinks out of the userData directory', async () => {
  const root = fixture()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-derived-data-outside-'))
  const outsideDirFile = write(outside, 'keep-dir.bin', 21)
  const outsideLinkFile = write(outside, 'keep-file.bin', 22)

  fs.symlinkSync(outside, path.join(root, 'thumbcache'), 'junction')
  fs.mkdirSync(path.join(root, 'image-search-index'), { recursive: true })
  try {
    fs.symlinkSync(outsideLinkFile, path.join(root, 'image-search-index', 'linked.bin'))
  } catch {
    // file symlinks may require elevated privileges on Windows; the junction above still covers the escape check
  }

  await clearProcessedImageData(root)

  // links may be removed or skipped; only outside survival is asserted
  assert.equal(fs.existsSync(outsideDirFile), true)
  assert.equal(fs.existsSync(outsideLinkFile), true)
  assert.equal(fs.readFileSync(outsideDirFile).length, 21)
  assert.equal(fs.readFileSync(outsideLinkFile).length, 22)
  fs.rmSync(outside, { recursive: true, force: true })
})

test('preview counts a lone scan log without rotations as exactly one file', async () => {
  const root = fixture()
  write(root, 'image-search-scan.log', 42)

  const preview = await previewProcessedImageData(root)

  const scanLogs = category(preview, 'scan-logs')
  assert.equal(scanLogs.fileCount, 1)
  assert.equal(scanLogs.estimatedBytes, 42)
})
