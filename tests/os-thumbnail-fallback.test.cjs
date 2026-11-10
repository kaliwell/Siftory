const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

// Stub electron before loading the fallback module: the real package exports a
// binary path under plain Node, so the provider must be injected explicitly.
const state = { mode: 'ok', calls: [] }
const electronModulePath = require.resolve('electron')
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: {
    nativeImage: {
      async createThumbnailFromPath(filePath, size) {
        state.calls.push({ filePath, size })
        if (state.mode === 'throw') throw new Error('Thumbnail provider unavailable')
        if (state.mode === 'empty') return { isEmpty: () => true }
        return {
          isEmpty: () => false,
          getSize: () => ({ width: size.width, height: size.height }),
        }
      },
    },
  },
}

const { createOsThumbnail } = loadTsModule('electron/osThumbnailFallback.ts')

test.beforeEach(() => {
  state.mode = 'ok'
  state.calls = []
})

test('OS thumbnail fallback requests the bounded preview size for the file', async () => {
  const image = await createOsThumbnail('C:\\media\\sample.bmp', 256)
  assert.ok(image, 'decoded image is returned')
  assert.equal(image.isEmpty(), false)
  assert.deepEqual(state.calls, [
    { filePath: 'C:\\media\\sample.bmp', size: { width: 256, height: 256 } },
  ])
})

test('an empty provider result keeps the preview error path', async () => {
  state.mode = 'empty'
  assert.equal(await createOsThumbnail('C:\\media\\sample.bmp', 128), null)
})

test('a rejected provider lookup never fails the thumbnail batch', async () => {
  state.mode = 'throw'
  assert.equal(await createOsThumbnail('C:\\media\\sample.bmp', 256), null)
  // The helper stays usable for later files in the same batch.
  state.mode = 'ok'
  const image = await createOsThumbnail('C:\\media\\retry.bmp', 256)
  assert.ok(image)
  assert.equal(state.calls.at(-1).filePath, 'C:\\media\\retry.bmp')
})
