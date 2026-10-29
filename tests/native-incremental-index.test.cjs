const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const addon = require('../native/build/Release/fast_scanner.node')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.siftory-index-repeat-'))
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
    if (progress.state === 'idle') {
      await addon.stopScanAsync()
      return progress
    }
    assert.notEqual(progress.state, 'error', JSON.stringify(progress))
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('scan timed out')
}

// A legacy immutable fixture is written independently of the current upsert API.
function writeV2Segment(filename, records) {
  const paths = records.map((record) => Buffer.from(record.path + '\0'))
  const offsets = Buffer.alloc((records.length + 1) * 8)
  let bytes = 0
  paths.forEach((value, index) => {
    offsets.writeBigUInt64LE(BigInt(bytes), index * 8)
    bytes += value.length
  })
  offsets.writeBigUInt64LE(BigInt(bytes), records.length * 8)
  const metadata = Buffer.alloc(records.length * 32),
    hashes = Buffer.alloc(records.length * 8)
  records.forEach((record, index) => {
    metadata.writeInt32LE(1, index * 32)
    metadata.writeInt32LE(1, index * 32 + 4)
    metadata.writeBigUInt64LE(68n, index * 32 + 8)
    metadata.writeBigUInt64LE(1000n, index * 32 + 16)
    hashes.writeBigUInt64LE(record.hash, index * 8)
  })
  const body = Buffer.concat([offsets, ...paths, metadata, hashes])
  let checksum = 0xcbf29ce484222325n
  for (const byte of body)
    checksum = ((checksum ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  const header = Buffer.alloc(80),
    footer = Buffer.alloc(16)
  header.write('IMS1')
  header.writeUInt32LE(2, 4)
  const pathBytes = 80 + offsets.length,
    metadataOffset = pathBytes + bytes,
    hashOffset = metadataOffset + metadata.length
  const values = [
    records.length,
    80 + body.length + 16,
    80,
    80,
    pathBytes,
    metadataOffset,
    hashOffset,
    80 + body.length,
    checksum,
  ]
  values.forEach((value, index) => header.writeBigUInt64LE(BigInt(value), 8 + index * 8))
  footer.write('END\0')
  footer.writeBigUInt64LE(BigInt(records.length), 4)
  footer.writeUInt32LE(2, 12)
  fs.writeFileSync(filename, Buffer.concat([header, body, footer]))
}

test('UNC and extended UNC spellings resolve to one indexed file', (t) => {
  fixture(t)
  const ordinary = '\\\\server\\share\\设计资料\\image.png'
  const extended = '\\\\?\\UNC\\SERVER\\share\\设计资料\\image.png'
  upsert(ordinary, 1000)
  upsert(extended, 2000, '0000000000000001')
  assert.equal(addon.hasIndexPath(ordinary), true)
  assert.equal(addon.hasIndexPath(extended), true)
  const rows = addon.snapshotIndexRecords().records
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
  }
  assert.ok(addon.getIndexMode().physicalRecordCount >= 4)
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
  assert.equal(addon.scanDirectory(path.relative(process.cwd(), f.source), 'update').ok, true)
  const progress = await waitForScan()
  assert.equal(progress.updatedCount, 0)
  assert.equal(progress.newCount, 0)
  assert.equal(progress.skippedUnchanged, 1)
  assert.equal(addon.loadManifest(f.index).ok, true, 'reload an already loaded manifest safely')
  assert.equal(addon.scanDirectory(path.relative(process.cwd(), f.source), 'update').ok, true)
  assert.equal((await waitForScan()).updatedCount, 0)
})

test('overlapping directory and extended drive roots add each physical path once', async (t) => {
  const f = fixture(t),
    item = path.join(f.source, 'one.png')
  fs.writeFileSync(
    item,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  const roots = [path.relative(process.cwd(), f.source), path.toNamespacedPath(f.source)]
  assert.equal(addon.scanDirectory(roots.join('\x1f'), 'addNew').ok, true)
  assert.equal((await waitForScan()).newCount, 1)
  assert.equal(addon.getIndexMode().recordCount, 1)
  await addon.saveIndexToManifestAsync(f.index)
  assert.equal(addon.scanDirectory(roots.join('\x1f'), 'addNew').ok, true)
  assert.equal((await waitForScan()).newCount, 0)
  assert.equal(addon.getIndexMode().recordCount, 1)
})

test('identical upserts after reload do not append another historical version', async (t) => {
  const f = fixture(t),
    item = path.join(f.source, 'same.png')
  upsert(item, 1000)
  await addon.saveIndexToManifestAsync(f.index)
  const before = addon.getIndexMode().physicalRecordCount
  upsert(item, 1000)
  assert.equal(addon.isIndexDirty().dirty, false)
  await addon.saveIndexToManifestAsync(f.index)
  assert.equal(addon.getIndexMode().physicalRecordCount, before)
})

test('legacy duplicate aliases are hidden before topK without deleting immutable segments', async (t) => {
  const f = fixture(t),
    a = path.join(f.source, 'a.png'),
    b = path.join(f.source, 'b.png')
  const segments = path.join(f.index, 'segments')
  fs.mkdirSync(segments)
  const oldSegment = path.join(segments, 'older.idx'),
    newSegment = path.join(segments, 'newer.idx')
  writeV2Segment(oldSegment, [
    { path: a, hash: 0n },
    { path: b, hash: 1n },
    { path: path.toNamespacedPath(a), hash: 0n },
  ])
  writeV2Segment(newSegment, [{ path: a, hash: 0xffffffffffffffffn }])
  const unchangedBytes = fs.readFileSync(oldSegment)
  fs.writeFileSync(
    path.join(f.index, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      segments: [
        { id: 'newer', file: 'segments/newer.idx' },
        { id: 'older', file: 'segments/older.idx' },
      ],
    }),
  )
  assert.equal((await addon.loadManifestAsync(f.index)).recordCount, 2)
  assert.equal(addon.getIndexMode().physicalRecordCount, 4)
  for (const mode of ['balanced', 'recall', 'fast']) {
    const result = addon.searchByHash('0000000000000000', 2, 1, mode)
    assert.equal(result.ok, true)
    assert.deepEqual(
      result.results.map((row) => row.path),
      [b],
      mode,
    )
  }
  assert.deepEqual(fs.readFileSync(oldSegment), unchangedBytes)
})
