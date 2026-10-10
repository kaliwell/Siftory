// P1-D: Segment v3 tests — save/load/manifest/repair with dctHash64
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const addon = require('../native/build/Release/fast_scanner.node')

// ── Helpers (same as native-hash test) ──────────────────

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const typeB = Buffer.from(type, 'ascii')
  const crcInput = Buffer.concat([typeB, data])
  const crcBuf = Buffer.alloc(4)
  let crc = 0xFFFFFFFF
  for (let i = 0; i < crcInput.length; i++) {
    crc ^= crcInput[i]
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
  }
  crcBuf.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0, 0)
  return Buffer.concat([len, typeB, data, crcBuf])
}

function create8x8Png(filePath, pixels) {
  const raw = Buffer.alloc(8 * 9)
  for (let row = 0; row < 8; row++) {
    raw[row * 9] = 0
    for (let col = 0; col < 8; col++) raw[row * 9 + 1 + col] = pixels[row * 8 + col]
  }
  const compressed = zlib.deflateSync(raw)
  const chunks = []
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 0
  chunks.push(pngChunk('IHDR', ihdr))
  chunks.push(pngChunk('IDAT', compressed))
  chunks.push(pngChunk('IEND', Buffer.alloc(0)))
  fs.writeFileSync(filePath, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), ...chunks]))
}

function fnv64(buf) {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const b of buf) {
    h ^= BigInt(b)
    h = (h * prime) & 0xffffffffffffffffn
  }
  return h
}

function u32(v) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v >>> 0, 0)
  return b
}

function u64(v) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(v), 0)
  return b
}

function i64(v) {
  const b = Buffer.alloc(8)
  b.writeBigInt64LE(BigInt(v), 0)
  return b
}

function writeV2Segment(filePath, records) {
  const headerSize = 80
  const metaSize = 32
  const footerSize = 16
  const pathOffsetsOffset = headerSize
  const pathBytesOffset = pathOffsetsOffset + (records.length + 1) * 8
  const pathBytes = Buffer.concat(records.map(r => Buffer.from(`${r.path}\0`, 'utf8')))
  const metadataOffset = pathBytesOffset + pathBytes.length
  const diffHashOffset = metadataOffset + records.length * metaSize
  const footerOffset = diffHashOffset + records.length * 8
  const fileSize = footerOffset + footerSize

  const pathOffsets = []
  let off = 0
  for (const r of records) {
    pathOffsets.push(off)
    off += Buffer.byteLength(`${r.path}\0`)
  }
  pathOffsets.push(off)

  const meta = Buffer.concat(records.map(r => Buffer.concat([
    u32(r.width),
    u32(r.height),
    i64(r.fileSize),
    i64(r.modifiedTime),
    u32(0),
    u32(0),
  ])))
  const hashes = Buffer.concat(records.map(r => u64(BigInt(`0x${r.diffHash64}`))))
  const body = Buffer.concat([
    ...pathOffsets.map(u64),
    pathBytes,
    meta,
    hashes,
  ])
  const checksum = fnv64(body)
  const header = Buffer.concat([
    Buffer.from('IMS1', 'ascii'),
    u32(2),
    u64(records.length),
    u64(fileSize),
    u64(headerSize),
    u64(pathOffsetsOffset),
    u64(pathBytesOffset),
    u64(metadataOffset),
    u64(diffHashOffset),
    u64(footerOffset),
    u64(checksum),
  ])
  const footer = Buffer.concat([
    Buffer.from([0x45, 0x4e, 0x44, 0x00]),
    u64(records.length),
    u32(2),
  ])
  fs.writeFileSync(filePath, Buffer.concat([header, body, footer]))
}

const PIXELS_A = new Uint8Array(64)
for (let i = 0; i < 64; i++) PIXELS_A[i] = (i % 2 === 0) ? 255 : 0

async function waitForScan(addonRef) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const progress = addonRef.getScanProgress()
    if (progress.state !== 'scanning') return progress
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  addonRef.stopScan()
  throw new Error('scan timed out')
}

// ── Tests ──────────────────────────────────────────────

test('P1-D: save/load v3 segment preserves dctHash64 in search results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-segv3-'))
  const sub = path.join(root, 'sub')
  fs.mkdirSync(sub)

  const fp = path.join(sub, 'img_a.png')
  create8x8Png(fp, PIXELS_A)

  const indexDir = path.join(root, 'index')

  try {
    // Phase 1: scan
    addon.clearIndex()
    const started = addon.scanDirectory(root, 'full')
    assert.equal(started.ok, true)
    const progress = await waitForScan(addon)
    assert.equal(progress.state, 'idle')
    assert.ok(addon.getIndexStats().indexedCount >= 1)

    // Phase 2: save manifest (creates v3 segment)
    const saveResult = addon.saveIndexToManifest(indexDir)
    assert.equal(saveResult.ok, true, JSON.stringify(saveResult))
    assert.ok(saveResult.recordCount >= 1)

    // Phase 3: clear and reload
    addon.clearIndex()
    assert.equal(addon.getIndexStats().indexedCount, 0)

    const loadResult = addon.loadManifest(indexDir)
    assert.equal(loadResult.ok, true, JSON.stringify(loadResult))
    assert.equal(loadResult.recordCount, saveResult.recordCount)

    // Phase 4: search — results should have dctHash64
    const searchResult = addon.searchByImage(fp, 30, 50, 'balanced')
    assert.equal(searchResult.ok, true, JSON.stringify(searchResult))
    assert.ok(searchResult.results.length > 0, 'should find at least self')

    const selfHit = searchResult.results.find(r =>
      r.path.replace(/\\/g, '/').toLowerCase() === fp.replace(/\\/g, '/').toLowerCase())
    assert.ok(selfHit, 'query image should match itself')

    // v3 segment should return dctHash64
    assert.ok(typeof selfHit.dctHash64 === 'string' && selfHit.dctHash64.length === 16,
      `dctHash64 should be 16 hex in v3 result: ${selfHit.dctHash64}`)
    assert.notEqual(selfHit.dctHash64, '0000000000000000',
      'dctHash64 should be non-zero for non-uniform image')

    // Score should still be high (diffHash-based search unchanged)
    assert.ok(selfHit.score > 0.9, `self score should be >0.9, got ${selfHit.score}`)

  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P1-D: save manifest hot reload preserves dctHash64 before manual reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-segv3-'))
  const sub = path.join(root, 'sub')
  fs.mkdirSync(sub)

  const fp = path.join(sub, 'img_a.png')
  create8x8Png(fp, PIXELS_A)
  const indexDir = path.join(root, 'index')

  try {
    addon.clearIndex()
    const started = addon.scanDirectory(root, 'full')
    assert.equal(started.ok, true)
    await waitForScan(addon)

    const saveResult = addon.saveIndexToManifest(indexDir)
    assert.equal(saveResult.ok, true, JSON.stringify(saveResult))

    const mode = addon.getIndexMode()
    assert.equal(mode.version, 4, `hot-loaded segment mode should report v4, got ${JSON.stringify(mode)}`)

    const searchResult = addon.searchByImage(fp, 30, 50, 'balanced')
    assert.equal(searchResult.ok, true, JSON.stringify(searchResult))
    const selfHit = searchResult.results.find(r =>
      r.path.replace(/\\/g, '/').toLowerCase() === fp.replace(/\\/g, '/').toLowerCase())
    assert.ok(selfHit, 'query image should match itself after save hot reload')
    assert.ok(typeof selfHit.dctHash64 === 'string' && selfHit.dctHash64.length === 16,
      `hot-loaded result should include dctHash64: ${JSON.stringify(selfHit)}`)
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P1-E: async manifest save, load, and compact preserve the active index runtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-async-manifest-'))
  const sub = path.join(root, 'sub')
  fs.mkdirSync(sub)

  const fp = path.join(sub, 'img_a.png')
  create8x8Png(fp, PIXELS_A)
  const indexDir = path.join(root, 'index')

  try {
    addon.clearIndex()
    const started = addon.scanDirectory(root, 'full')
    assert.equal(started.ok, true)
    await waitForScan(addon)

    const saved = await addon.saveIndexToManifestAsync(indexDir)
    assert.equal(saved.ok, true, JSON.stringify(saved))
    assert.ok(saved.recordCount >= 1)

    addon.clearIndex()
    const loaded = await addon.loadManifestAsync(indexDir)
    assert.equal(loaded.ok, true, JSON.stringify(loaded))
    assert.equal(loaded.recordCount, saved.recordCount)

    const search = addon.searchByImage(fp, 30, 50, 'balanced')
    assert.equal(search.ok, true, JSON.stringify(search))
    assert.ok(search.results.some((result) =>
      result.path.replace(/\\/g, '/').toLowerCase() === fp.replace(/\\/g, '/').toLowerCase()))

    const manifestPath = path.join(indexDir, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const original = manifest.segments[0]
    const duplicateFile = 'segments/async-duplicate.idx'
    fs.copyFileSync(path.join(indexDir, original.file), path.join(indexDir, duplicateFile))
    manifest.segments = [{ ...original, id: 'async-duplicate', file: duplicateFile }, original]
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))

    addon.clearIndex()
    const duplicated = await addon.loadManifestAsync(indexDir)
    assert.equal(duplicated.ok, true, JSON.stringify(duplicated))
    assert.equal(duplicated.segmentCount, 2)

    const compacted = await addon.compactManifestAsync(indexDir)
    assert.equal(compacted.ok, true, JSON.stringify(compacted))
    assert.equal(compacted.beforeSegments, 2)
    assert.equal(addon.getIndexMode().segmentCount, 1)
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P1-E: compact physically removes tombstoned paths from a single segment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-single-segment-compact-'))
  const selected = path.join(root, 'selected')
  const retained = path.join(root, 'retained')
  fs.mkdirSync(selected)
  fs.mkdirSync(retained)
  const removedPath = path.join(selected, 'remove-me.png')
  const retainedPath = path.join(retained, 'keep-me.png')
  create8x8Png(removedPath, PIXELS_A)
  create8x8Png(retainedPath, Uint8Array.from(PIXELS_A, (value, index) => value ^ (index * 17)))
  const indexDir = path.join(root, 'index')

  try {
    addon.clearIndex()
    assert.equal(addon.scanDirectory(root, 'full').ok, true)
    await waitForScan(addon)
    const saved = await addon.saveIndexToManifestAsync(indexDir)
    assert.equal(saved.ok, true, JSON.stringify(saved))
    assert.equal(addon.getIndexMode().segmentCount, 1)

    const purged = addon.purgeIndexPathPrefix(selected)
    assert.equal(purged.ok, true, JSON.stringify(purged))
    assert.equal(purged.removedCount, 1)
    const persisted = await addon.saveIndexToManifestAsync(indexDir)
    assert.equal(persisted.ok, true, JSON.stringify(persisted))
    assert.equal(addon.getIndexMode().segmentCount, 1)
    assert.ok(addon.getIndexMode().deletedCount > 0)

    const compacted = await addon.compactManifestAsync(indexDir)
    assert.equal(compacted.ok, true, JSON.stringify(compacted))
    assert.equal(compacted.beforeSegments, 1)
    assert.equal(compacted.physicalCleanupComplete, true, JSON.stringify(compacted))
    assert.equal(addon.getIndexMode().deletedCount, 0)
    assert.equal(addon.getIndexPathStats(selected).count, 0)
    assert.equal(addon.getIndexPathStats(retained).count, 1)
    assert.equal(fs.existsSync(path.join(indexDir, 'overlay.json')), false)

    const manifest = JSON.parse(fs.readFileSync(path.join(indexDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.segments.length, 1)
    assert.equal(
      fs.readdirSync(path.join(indexDir, 'segments')).filter((name) => name.endsWith('.idx')).length,
      1,
    )
    const segmentBytes = fs.readFileSync(path.join(indexDir, manifest.segments[0].file))
    assert.equal(segmentBytes.includes(Buffer.from(removedPath, 'utf8')), false)
    assert.equal(segmentBytes.includes(Buffer.from(retainedPath, 'utf8')), true)
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P1-D: search results unchanged by v3 (score still based on diffHash)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-segv3-'))
  const sub = path.join(root, 'sub')
  fs.mkdirSync(sub)

  const fp1 = path.join(sub, 'img_a.png')
  create8x8Png(fp1, PIXELS_A)

  const indexDir = path.join(root, 'index')

  try {
    addon.clearIndex()
    const started = addon.scanDirectory(root, 'full')
    assert.equal(started.ok, true)
    await waitForScan(addon)

    // Search from memory (before saving)
    const memSearch = addon.searchByImage(fp1, 30, 50, 'balanced')
    assert.equal(memSearch.ok, true)

    // Save and reload
    addon.saveIndexToManifest(indexDir)
    addon.clearIndex()
    addon.loadManifest(indexDir)

    // Search from segment
    const segSearch = addon.searchByImage(fp1, 30, 50, 'balanced')
    assert.equal(segSearch.ok, true)

    // Self-match should have same score regardless of storage backend
    const memSelf = memSearch.results.find(r =>
      r.path.replace(/\\/g, '/').toLowerCase() === fp1.replace(/\\/g, '/').toLowerCase())
    const segSelf = segSearch.results.find(r =>
      r.path.replace(/\\/g, '/').toLowerCase() === fp1.replace(/\\/g, '/').toLowerCase())

    assert.ok(memSelf, 'memory search should find self')
    assert.ok(segSelf, 'segment search should find self')
    assert.equal(memSelf.score, segSelf.score,
      `score should be identical memory vs segment: ${memSelf.score} vs ${segSelf.score}`)

  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P1-D: manifest repair supports v3 segments', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-segv3-'))
  const sub = path.join(root, 'sub')
  fs.mkdirSync(sub)

  const fp = path.join(sub, 'img_a.png')
  create8x8Png(fp, PIXELS_A)

  const indexDir = path.join(root, 'index')

  try {
    addon.clearIndex()
    const started = addon.scanDirectory(root, 'full')
    assert.equal(started.ok, true)
    await waitForScan(addon)

    const saveResult = addon.saveIndexToManifest(indexDir)
    assert.equal(saveResult.ok, true)
    const originalCount = saveResult.recordCount

    // Delete manifest.json, keep segments
    fs.unlinkSync(path.join(indexDir, 'manifest.json'))

    // Repair
    const repairResult = addon.repairManifestFromSegments(indexDir)
    assert.equal(repairResult.ok, true, JSON.stringify(repairResult))
    assert.equal(repairResult.recordCount, originalCount)

    // Load repaired manifest
    addon.clearIndex()
    const loadResult = addon.loadManifest(indexDir)
    assert.equal(loadResult.ok, true)
    assert.equal(loadResult.recordCount, originalCount)

    // Search should still work
    const searchResult = addon.searchByImage(fp, 30, 50, 'balanced')
    assert.equal(searchResult.ok, true)
    assert.ok(searchResult.results.length > 0)

  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P1-D: save/load single segment v3 via SaveIndexToSegment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-segv3-'))
  const sub = path.join(root, 'sub')
  fs.mkdirSync(sub)

  const fp = path.join(sub, 'img_a.png')
  create8x8Png(fp, PIXELS_A)

  const segPath = path.join(root, 'test.idx')

  try {
    addon.clearIndex()
    const started = addon.scanDirectory(root, 'full')
    assert.equal(started.ok, true)
    await waitForScan(addon)

    // Save single segment
    const saveResult = addon.saveIndexToSegment(segPath)
    assert.equal(saveResult.ok, true, JSON.stringify(saveResult))

    // Load it back
    addon.clearIndex()
    const loadResult = addon.loadIndexFromSegment(segPath)
    assert.equal(loadResult.ok, true, JSON.stringify(loadResult))
    assert.equal(loadResult.recordCount, saveResult.recordCount)

    // Verify v3 file magic
    const buf = fs.readFileSync(segPath)
    const magic = buf.toString('ascii', 0, 4)
    assert.equal(magic, 'IMS1')
    const version = buf.readUInt32LE(4) // little-endian
    assert.equal(version, 4, `segment should be version 4, got ${version}`)

    // Search
    const searchResult = addon.searchByImage(fp, 30, 50, 'balanced')
    assert.equal(searchResult.ok, true)
    assert.ok(searchResult.results.length > 0)

  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P1-D: load old v2 segment still works without dctHash64', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-segv2-'))
  const fp = path.join(root, 'img_v2.png')
  const segPath = path.join(root, 'legacy-v2.idx')
  create8x8Png(fp, PIXELS_A)

  try {
    const h = addon.hashImage(fp)
    assert.equal(h.ok, true, JSON.stringify(h))
    const st = fs.statSync(fp)
    writeV2Segment(segPath, [{
      path: fp,
      width: h.width,
      height: h.height,
      fileSize: st.size,
      modifiedTime: Math.floor(st.mtimeMs),
      diffHash64: h.diffHash64,
    }])

    addon.clearIndex()
    const loadResult = addon.loadIndexFromSegment(segPath)
    assert.equal(loadResult.ok, true, JSON.stringify(loadResult))
    assert.equal(loadResult.recordCount, 1)

    const searchResult = addon.searchByImage(fp, 30, 20, 'balanced')
    assert.equal(searchResult.ok, true, JSON.stringify(searchResult))
    const selfHit = searchResult.results.find(r =>
      r.path.replace(/\\/g, '/').toLowerCase() === fp.replace(/\\/g, '/').toLowerCase())
    assert.ok(selfHit, 'legacy v2 segment should find self')
    assert.equal(selfHit.dctHash64, undefined, 'legacy v2 result should not expose dctHash64')
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
