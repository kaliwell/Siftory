const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const addon = require('../native/build/Release/fast_scanner.node')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-index-repeat-'))
  const source = path.join(root, 'source'),
    index = path.join(root, 'index')
  fs.mkdirSync(source)
  fs.mkdirSync(index)
  addon.clearIndex()
  addon.configureScanThumbnails('', false, 6)
  t.after(async () => {
    await addon.stopScanAsync()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, source, index }
}

function upsert(filePath, modifiedTime, hash = '0000000000000000') {
  const result = addon.upsertIndexRecord(filePath, 1, 1, 68, modifiedTime, hash, hash)
  assert.equal(result.ok, true, JSON.stringify(result))
}

async function waitForScan() {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const progress = addon.getScanProgress()
    if (progress.state === 'idle') return progress
    assert.notEqual(progress.state, 'error', JSON.stringify(progress))
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('scan timed out')
}

test('UNC and extended UNC spellings resolve to one indexed file', (t) => {
  fixture(t)
  const ordinary = '\\\\server\\share\\设计资料\\image.png'
  const extended = '\\\\?\\UNC\\SERVER\\share\\设计资料\\image.png'
  upsert(ordinary, 1000)
  upsert(extended, 2000, '0000000000000001')
  assert.equal(addon.hasIndexPath(ordinary), true)
  assert.equal(addon.hasIndexPath(extended), true)
  const rows = addon.queryIndexRecords('', 0, 100).records
  assert.equal(rows.length, 1)
  assert.equal(rows[0].modifiedTime, 2000)
  assert.equal(addon.getIndexMode().recordCount, 1)
})

test('logical count and mapping health remain stable across append versions and reload', async (t) => {
  const f = fixture(t),
    item = path.join(f.source, 'one.png')
  for (let revision = 0; revision < 4; revision++) {
    upsert(item, revision * 1000, revision.toString(16).padStart(16, '0'))
    assert.equal((await addon.saveIndexToManifestAsync(f.index)).ok, true)
    const status = addon.getIndexMode()
    assert.equal(status.recordCount, 1, 'historical versions are not additional live files')
    assert.equal(status.pathMapHealthy, true)
    assert.ok(status.physicalRecordCount >= status.recordCount)
  }
  addon.clearIndex()
  assert.equal((await addon.loadManifestAsync(f.index)).ok, true)
  assert.equal(addon.getIndexMode().recordCount, 1)
  for (const mode of ['balanced', 'recall', 'fast']) {
    const result = addon.searchByHash('0000000000000003', 64, 100, mode)
    assert.equal(result.ok, true)
    assert.equal(result.results.length, 1, mode)
  }
})

test('sync reload keeps newest metadata so an unchanged update does no repeated work', async (t) => {
  const f = fixture(t),
    item = path.join(f.source, 'one.png')
  fs.writeFileSync(
    item,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  const oldTime = Math.floor(Date.now() / 1000) - 60,
    newTime = oldTime + 30
  const bytes = fs.statSync(item).size
  fs.utimesSync(item, oldTime, oldTime)
  assert.equal(
    addon.upsertIndexRecord(
      item,
      1,
      1,
      bytes,
      oldTime * 1000,
      '0000000000000000',
      '0000000000000000',
    ).ok,
    true,
  )
  await addon.saveIndexToManifestAsync(f.index)
  fs.utimesSync(item, newTime, newTime)
  assert.equal(
    addon.upsertIndexRecord(
      item,
      1,
      1,
      bytes,
      newTime * 1000,
      '0000000000000001',
      '0000000000000001',
    ).ok,
    true,
  )
  await addon.saveIndexToManifestAsync(f.index)
  addon.clearIndex()
  assert.equal(addon.loadManifest(f.index).ok, true)
  assert.equal(addon.scanDirectory(f.source, 'update').ok, true)
  const progress = await waitForScan()
  assert.equal(progress.updatedCount, 0)
  assert.equal(progress.newCount, 0)
  assert.equal(progress.skippedUnchanged, 1)
})
