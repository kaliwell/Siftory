const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { cacheKey, purgeThumbnailCacheForSources } = loadTsModule('electron/thumbnailDiskCache.ts')

test('source thumbnail purge removes only matching cache keys and reports both phases', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-cache-source-purge-'))
  try {
    const userDataPath = path.join(root, 'user-data')
    const cacheDir = path.join(userDataPath, 'thumbcache')
    const source = {
      path: path.join(root, 'sources', 'matched-image.jpg'),
      mtimeMs: 1_700_000_000_123,
    }
    const unrelatedSource = {
      path: path.join(root, 'sources', 'unrelated-image.jpg'),
      mtimeMs: 1_700_000_100_456,
    }
    fs.mkdirSync(cacheDir, { recursive: true })

    const matchingKey = cacheKey(source.path, source.mtimeMs, 128)
    const matchingJpeg = path.join(cacheDir, `${matchingKey}.jpg`)
    const matchingThumb = path.join(cacheDir, `${matchingKey}.thumb`)
    const unrelatedCache = path.join(
      cacheDir,
      `${cacheKey(unrelatedSource.path, unrelatedSource.mtimeMs, 128)}.jpg`,
    )
    const unrelatedValidName = path.join(cacheDir, `${'a'.repeat(24)}.webp`)
    const unrelatedMetadata = path.join(cacheDir, 'keep-me.txt')
    fs.writeFileSync(matchingJpeg, 'matched-jpeg')
    fs.writeFileSync(matchingThumb, 'matched-thumb')
    fs.writeFileSync(unrelatedCache, 'unrelated-cache')
    fs.writeFileSync(unrelatedValidName, 'unrelated-valid-name')
    fs.writeFileSync(unrelatedMetadata, 'unrelated-metadata')

    const progress = []
    const result = await purgeThumbnailCacheForSources(userDataPath, [source], {
      concurrency: 2,
      onProgress: (event) => progress.push({ ...event }),
    })

    assert.equal(result.deletedFiles, 2)
    assert.equal(
      result.freedBytes,
      Buffer.byteLength('matched-jpeg') + Buffer.byteLength('matched-thumb'),
    )
    assert.deepEqual(result.warnings, [])
    assert.equal(fs.existsSync(matchingJpeg), false)
    assert.equal(fs.existsSync(matchingThumb), false)
    assert.equal(fs.readFileSync(unrelatedCache, 'utf8'), 'unrelated-cache')
    assert.equal(fs.readFileSync(unrelatedValidName, 'utf8'), 'unrelated-valid-name')
    assert.equal(fs.readFileSync(unrelatedMetadata, 'utf8'), 'unrelated-metadata')

    const matchingProgress = progress.filter((event) => event.phase === 'matching')
    const deletingProgress = progress.filter((event) => event.phase === 'deleting')
    assert.ok(matchingProgress.length > 0, 'matching progress must be reported')
    assert.ok(deletingProgress.length > 0, 'deleting progress must be reported')
    assert.deepEqual(matchingProgress.at(-1), { phase: 'matching', processed: 1, total: 1 })
    assert.deepEqual(deletingProgress.at(-1), { phase: 'deleting', processed: 2, total: 2 })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('source thumbnail purge rejects a cache-root symlink or Windows junction', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-cache-junction-'))
  try {
    const userDataPath = path.join(root, 'user-data')
    const outside = path.join(root, 'outside')
    const cacheDir = path.join(userDataPath, 'thumbcache')
    fs.mkdirSync(userDataPath)
    fs.mkdirSync(outside)
    try {
      fs.symlinkSync(outside, cacheDir, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`directory links are unavailable: ${error.code}`)
        return
      }
      throw error
    }
    const source = {
      path: path.join(root, 'source.jpg'),
      mtimeMs: 1_700_000_000_000,
    }
    const externalFile = path.join(outside, `${cacheKey(source.path, source.mtimeMs, 128)}.jpg`)
    fs.writeFileSync(externalFile, 'must-not-be-deleted')

    const result = await purgeThumbnailCacheForSources(userDataPath, [source])
    assert.equal(result.deletedFiles, 0)
    assert.equal(fs.readFileSync(externalFile, 'utf8'), 'must-not-be-deleted')
    assert.match(result.warnings.join('\n'), /blocked|linked|managed user-data root/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
