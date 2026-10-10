const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Standalone file on purpose: this scenario drives a real native scan and a
// stubbed-then-retried manifest save, so it runs in its own process with a
// clean service/addon state instead of sharing module state with the other
// executable image-search tests.
test('service executable: failed edit persist reports retry and lands via autosave (M4)', async (t) => {
  let addon
  try {
    addon = require('../native/build/Release/fast_scanner.node')
  } catch {
    t.skip('native addon not built')
    return
  }
  const { loadTsModule } = require('./guard-utils.cjs')
  const svc = loadTsModule('electron/imageSearchService.ts')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdata-retry-'))
  const emptyScanDir = path.join(tmp, 'empty-scan')
  fs.mkdirSync(emptyScanDir, { recursive: true })
  try {
    svc.initImageSearchService(() => {}, tmp)
    if (!svc.getImageSearchStatus().nativeConnected) {
      t.skip('native addon not connected')
      return
    }
    const indexRoot = svc.getImageSearchStatus().segmentPath || path.join(tmp, 'image-search-index')
    addon.clearIndex()
    const insert = (recordPath) =>
      addon.upsertIndexRecord(recordPath, 1, 1, 1, 1, '0123456789abcdef', 'fedcba9876543210')
    assert.equal(insert('D:\\Gone\\a.png').ok, true)
    assert.equal(insert('D:\\Keep\\b.png').ok, true)

    // Stub the native save to fail transiently: the purge must still apply in
    // memory while the persist reports a retryable failure (M4).
    const realSave = addon.saveIndexToManifestAsync
    addon.saveIndexToManifestAsync = () => Promise.reject('simulated transient save failure')
    let failed
    try {
      failed = await svc.deleteImageSearchDataFolder('D:\\Gone', ['D:\\'])
    } finally {
      addon.saveIndexToManifestAsync = realSave
    }
    assert.equal(failed.ok, false)
    assert.match(failed.error, /simulated transient save failure/)
    assert.match(failed.error, /will retry saving automatically/)
    // The edit is still applied in memory; only persistence failed.
    assert.equal(addon.hasIndexPath('D:\\Gone\\a.png'), false)
    assert.equal(fs.existsSync(path.join(indexRoot, 'manifest.json')), false)

    // The next autosave opportunity (scan completion) retries the persist.
    const previousSaveTime = svc.getImageSearchStatus().lastSaveTime || 0
    svc.startImageSearchScan({ paths: [emptyScanDir] })
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const status = svc.getImageSearchStatus()
      if (
        (status.lastSaveTime || 0) > previousSaveTime &&
        fs.existsSync(path.join(indexRoot, 'manifest.json'))
      ) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.equal(
      fs.existsSync(path.join(indexRoot, 'manifest.json')),
      true,
      'retried persist should have written the manifest',
    )
    // The retried persist wrote the post-edit state: Keep only, Gone absent.
    addon.clearIndex()
    const loaded = addon.loadManifest(indexRoot)
    assert.equal(loaded.ok, true)
    assert.equal(loaded.recordCount, 1)
    assert.equal(addon.hasIndexPath('D:\\Gone\\a.png'), false)
    assert.equal(addon.hasIndexPath('D:\\Keep\\b.png'), true)
  } finally {
    try {
      addon.clearIndex()
    } catch {
      /* cleanup best-effort */
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
})
