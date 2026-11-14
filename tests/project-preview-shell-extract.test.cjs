const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')
const { extractShellThumbnail } = loadTsModule('electron/projectPreviewShellExtract.ts')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-extract-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'artwork.psd')
  fs.writeFileSync(source, 'synthetic-source')
  return source
}
function image(bitmap, png = Buffer.from('same-png-bytes')) {
  return {
    isEmpty: () => false,
    resize(size) {
      assert.deepEqual(size, { width: 64, height: 64 })
      return this
    },
    toBitmap: () => Buffer.from(bitmap),
    toPNG: () => png,
  }
}

test('Shell isolation preserves thumbnail size, icon comparison and output bytes', async (t) => {
  const source = fixture(t),
    steps = []
  const png = Buffer.from('unchanged-thumbnail-encoding')
  const result = await extractShellThumbnail(source, {
    step: (step) => steps.push(step),
    thumbnail: async (file, size) => {
      assert.equal(file, source)
      assert.deepEqual(size, { width: 1024, height: 1024 })
      return image([0, 0, 0, 255], png)
    },
    icon: async () => image([255, 255, 255, 255]),
  })
  assert.deepEqual(result.bytes, png)
  assert.equal(result.outcome, 'ready')
  assert.deepEqual(steps, ['stat', 'thumbnail', 'icon', 'compare', 'encode'])
  for (const value of Object.values(result.durations))
    assert.ok(Number.isFinite(value) && value >= 0)
})

test('generic file icons are still rejected instead of indexed as artwork', async (t) => {
  const source = fixture(t)
  const result = await extractShellThumbnail(source, {
    thumbnail: async () => image([10, 20, 30, 255]),
    icon: async () => image([10, 20, 30, 255]),
  })
  assert.equal(result.bytes, null)
  assert.equal(result.outcome, 'icon-only')
  assert.equal(result.durations.encode, undefined)
})

test('missing files and unavailable native previews remain bounded failures', async (t) => {
  const source = fixture(t)
  let nativeCalls = 0
  const api = {
    thumbnail: async () => {
      nativeCalls++
      return { isEmpty: () => true }
    },
    icon: async () => {
      throw Error('must not fetch an icon')
    },
  }
  assert.equal((await extractShellThumbnail(source + '.missing', api)).bytes, null)
  assert.equal(nativeCalls, 0)
  const result = await extractShellThumbnail(source, api)
  assert.equal(result.bytes, null)
  assert.equal(result.outcome, 'unavailable')
  assert.equal(nativeCalls, 1)
})
