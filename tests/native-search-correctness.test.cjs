const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const addon = require('../native/build/Release/fast_scanner.node')

function fnv64(buffer) {
  let hash = 0xcbf29ce484222325n
  for (const byte of buffer) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash
}

function writeU64(buffer, offset, value) {
  buffer.writeBigUInt64LE(BigInt(value), offset)
}

function writeV2Segment(filePath, hashes) {
  const records = hashes.map((hash, index) => ({
    path: path.join(path.dirname(filePath), `image-${index}.png`),
    hash,
  }))
  const headerSize = 80
  const metadataSize = 32
  const footerSize = 16
  const pathOffsetsOffset = headerSize
  const pathBytesOffset = pathOffsetsOffset + (records.length + 1) * 8
  const pathBytes = Buffer.concat(records.map((record) => Buffer.from(`${record.path}\0`)))
  const metadataOffset = pathBytesOffset + pathBytes.length
  const diffHashOffset = metadataOffset + records.length * metadataSize
  const footerOffset = diffHashOffset + records.length * 8
  const fileSize = footerOffset + footerSize
  const body = Buffer.alloc(footerOffset - headerSize)

  let pathOffset = 0
  records.forEach((record, index) => {
    writeU64(body, index * 8, pathOffset)
    pathOffset += Buffer.byteLength(`${record.path}\0`)
  })
  writeU64(body, records.length * 8, pathOffset)
  pathBytes.copy(body, pathBytesOffset - headerSize)

  records.forEach((record, index) => {
    const metadataPosition = metadataOffset - headerSize + index * metadataSize
    body.writeInt32LE(32, metadataPosition)
    body.writeInt32LE(32, metadataPosition + 4)
    writeU64(body, metadataPosition + 8, 1024)
    writeU64(body, metadataPosition + 16, 0)
    writeU64(body, diffHashOffset - headerSize + index * 8, record.hash)
  })

  const header = Buffer.alloc(headerSize)
  header.write('IMS1', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  ;[
    records.length,
    fileSize,
    headerSize,
    pathOffsetsOffset,
    pathBytesOffset,
    metadataOffset,
    diffHashOffset,
    footerOffset,
    fnv64(body),
  ].forEach((value, index) => writeU64(header, 8 + index * 8, value))

  const footer = Buffer.alloc(footerSize)
  footer.write('END\0', 0, 'binary')
  writeU64(footer, 4, records.length)
  footer.writeUInt32LE(2, 12)
  fs.writeFileSync(filePath, Buffer.concat([header, body, footer]))
  return records
}

function hamming64(left, right) {
  let value = left ^ right
  let count = 0
  while (value) {
    value &= value - 1n
    count += 1
  }
  return count
}

test('balanced search finds close hashes when the high prefix differs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mih-'))
  const segmentPath = path.join(root, 'index.idx')
  const query = 0x123456789abcdef0n
  const closeWithDifferentPrefix = query ^ (1n << 63n)

  try {
    writeV2Segment(segmentPath, [closeWithDifferentPrefix, 0xffffffffffffffffn])
    assert.equal(addon.loadIndexFromSegment(segmentPath).ok, true)
    const result = addon.searchByHash(query.toString(16).padStart(16, '0'), 10, 50, 'balanced')
    assert.equal(result.ok, true)
    assert.ok(result.results.some((entry) => entry.distance === 1))
  } finally {
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('balanced search matches a linear oracle for threshold 10', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mih-oracle-'))
  const segmentPath = path.join(root, 'index.idx')
  let state = 0x9e3779b97f4a7c15n
  const mask = 0xffffffffffffffffn
  const hashes = Array.from({ length: 512 }, () => {
    state ^= state << 13n
    state ^= state >> 7n
    state ^= state << 17n
    state &= mask
    return state
  })

  try {
    const records = writeV2Segment(segmentPath, hashes)
    assert.equal(addon.loadIndexFromSegment(segmentPath).ok, true)

    for (let queryIndex = 0; queryIndex < 32; queryIndex += 1) {
      const query = hashes[(queryIndex * 17) % hashes.length] ^ BigInt(queryIndex)
      const expected = new Set(
        records
          .filter((record) => hamming64(record.hash, query) <= 10)
          .map((record) => record.path.toLowerCase()),
      )
      const actual = addon.searchByHash(query.toString(16).padStart(16, '0'), 10, 1000, 'balanced')
      assert.equal(actual.ok, true)
      assert.equal(actual.indexType, 'linear-balanced')
      assert.deepEqual(new Set(actual.results.map((record) => record.path.toLowerCase())), expected)
    }
  } finally {
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ── FS-07P: missing-argument guards must return errors instead of reading
// uninitialized argv[] stack slots (UB / crash, same family as FS-07O) ──

test('FS-07P: sync entries reject missing arguments instead of crashing', () => {
  assert.equal(addon.searchByHash().ok, false)
  assert.equal(addon.searchByHash('0000000000000000', 10).ok, false)
  assert.equal(addon.searchByImage().ok, false)
  assert.equal(addon.searchByImage('no-such-file.png', 10).ok, false)
  assert.equal(addon.hashImage().ok, false)
  assert.equal(addon.scanDirectory().ok, false)
  assert.equal(addon.repairIndexPath().ok, false)
  assert.equal(addon.repairIndexPath('only-one-arg').ok, false)
})

test('FS-07P: async entries reject missing arguments instead of crashing', async () => {
  await assert.rejects(addon.hashImageAsync(), /filePath/)
  await assert.rejects(addon.loadManifestAsync(), /rootDir/)
  await assert.rejects(addon.saveIndexToManifestAsync(), /rootDir/)
  await assert.rejects(addon.compactManifestAsync(), /rootDir/)
  await assert.rejects(addon.searchByImageAsync(), /filePath/)
  await assert.rejects(addon.searchByImageAsync('only-one-arg'), /threshold/)
})

// ── FS-07Q: topK clamping — default 20 for missing/non-positive, clamp to
// 1..1000; threshold is a 64-bit hamming distance and is clamped to 0..64 ──

function writeAllMatchingSegment(filePath, hash, count) {
  return writeV2Segment(filePath, Array.from({ length: count }, () => hash))
}

test('FS-07Q: searchByHash defaults topK to 20 for zero/negative values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-topk-default-'))
  const segmentPath = path.join(root, 'index.idx')
  const query = 0x123456789abcdef0n
  try {
    writeAllMatchingSegment(segmentPath, query, 30)
    assert.equal(addon.loadIndexFromSegment(segmentPath).ok, true)
    const hex = query.toString(16).padStart(16, '0')
    for (const topK of [0, -5]) {
      const result = addon.searchByHash(hex, 10, topK, 'balanced')
      assert.equal(result.ok, true)
      assert.equal(result.resultCount, 20, `topK=${topK} should fall back to the default 20`)
    }
  } finally {
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('FS-07Q: searchByHash clamps topK above the 1000 limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-topk-clamp-'))
  const segmentPath = path.join(root, 'index.idx')
  const query = 0x123456789abcdef0n
  try {
    writeAllMatchingSegment(segmentPath, query, 1100)
    assert.equal(addon.loadIndexFromSegment(segmentPath).ok, true)
    const result = addon.searchByHash(query.toString(16).padStart(16, '0'), 10, 5000, 'balanced')
    assert.equal(result.ok, true)
    assert.equal(result.resultCount, 1000, 'topK=5000 must be clamped to 1000')
  } finally {
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('FS-07Q: sync and async image search apply identical topK clamping', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-topk-parity-'))
  const segmentPath = path.join(root, 'index.idx')
  const imagePath = path.join(root, 'query.png')
  try {
    fs.writeFileSync(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64',
      ),
    )
    const hashResult = addon.hashImage(imagePath)
    assert.equal(hashResult.ok, true, JSON.stringify(hashResult))
    const query = BigInt(`0x${hashResult.diffHash64}`)
    writeAllMatchingSegment(segmentPath, query, 1100)
    assert.equal(addon.loadIndexFromSegment(segmentPath).ok, true)

    const syncResult = addon.searchByImage(imagePath, 64, 5000, 'balanced')
    const asyncResult = await addon.searchByImageAsync(imagePath, 64, 5000, 'balanced')
    assert.equal(syncResult.ok, true)
    assert.equal(asyncResult.ok, true)
    assert.equal(syncResult.resultCount, 1000)
    assert.equal(asyncResult.resultCount, 1000)
    assert.deepEqual(
      asyncResult.results.map((entry) => entry.path.toLowerCase()).sort(),
      syncResult.results.map((entry) => entry.path.toLowerCase()).sort(),
    )
  } finally {
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
