// SFR-011: generated temporary index only; never opens a user library.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const addon = require('../native/build/Release/fast_scanner.node')
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
  const pathBytes = Buffer.concat(records.map((r) => Buffer.from(`${r.path}\0`, 'utf8')))
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

  const meta = Buffer.concat(
    records.map((r) =>
      Buffer.concat([
        u32(r.width),
        u32(r.height),
        i64(r.fileSize),
        i64(r.modifiedTime),
        u32(0),
        u32(0),
      ]),
    ),
  )
  const hashes = Buffer.concat(records.map((r) => u64(BigInt(`0x${r.diffHash64}`))))
  const body = Buffer.concat([...pathOffsets.map(u64), pathBytes, meta, hashes])
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
  const footer = Buffer.concat([Buffer.from([0x45, 0x4e, 0x44, 0x00]), u64(records.length), u32(2)])
  fs.writeFileSync(filePath, Buffer.concat([header, body, footer]))
}

async function measure(operation) {
  let last = performance.now()
  let maxGapMs = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maxGapMs = Math.max(maxGapMs, now - last)
    last = now
  }, 1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const started = performance.now()
  try {
    const result = await operation()
    const totalMs = performance.now() - started
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { ...result, totalMs: +totalMs.toFixed(2), maxGapMs: +maxGapMs.toFixed(2) }
  } finally {
    clearInterval(timer)
  }
}

async function consume(cursor, field, expected) {
  let offset = 0
  let pages = 0
  let maxPageMs = 0
  try {
    do {
      await new Promise((resolve) => setImmediate(resolve))
      const started = performance.now()
      const page = addon.readIndexExportPage(cursor, offset, 256)
      maxPageMs = Math.max(maxPageMs, performance.now() - started)
      assert.equal(page.ok, true)
      assert.ok(page[field].length <= 256)
      assert.equal(page.nextOffset, offset + page[field].length)
      offset = page.nextOffset
      pages += 1
      if (!page.hasMore) break
    } while (offset < expected)
    assert.equal(offset, expected)
    return { pages, maxPageMs: +maxPageMs.toFixed(2) }
  } finally {
    await addon.closeIndexExport(cursor)
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-index-export-benchmark-'))
  const count = 120000
  const records = Array.from({ length: count }, (_, i) => ({
    path: path.join(root, 'sources', `${i}.png`),
    width: 100,
    height: 100,
    fileSize: 1234,
    modifiedTime: 1,
    diffHash64: '0123456789abcdef',
  }))
  try {
    const segment = path.join(root, 'fixture.idx')
    writeV2Segment(segment, records)
    const load = () => {
      addon.clearIndex()
      const result = addon.loadIndexFromSegment(segment)
      assert.equal(result.ok, true, JSON.stringify(result))
    }
    const rounds = []
    for (let round = 1; round <= 3; round += 1) {
      load()
      const syncSnapshot = await measure(async () => {
        const result = addon.snapshotIndexRecords()
        assert.equal(result.recordCount, count)
        return {}
      })
      const pagedSnapshot = await measure(async () => {
        const started = performance.now()
        const pending = addon.snapshotIndexRecordsAsync()
        const enqueueMs = performance.now() - started
        const result = await pending
        return {
          enqueueMs: +enqueueMs.toFixed(2),
          ...(await consume(result.cursor, 'records', count)),
        }
      })
      const removals = records.slice(0, 40000).map((record) => record.path)
      const pagedDelete = await measure(async () => {
        const started = performance.now()
        const pending = addon.deleteIndexPathsPagedAsync(removals)
        const enqueueMs = performance.now() - started
        const result = await pending
        assert.equal(result.removedCount, removals.length)
        assert.equal(result.remainingCount, count - removals.length)
        return {
          enqueueMs: +enqueueMs.toFixed(2),
          ...(await consume(result.cursor, 'removedPaths', removals.length)),
        }
      })
      rounds.push({ round, syncSnapshot, pagedSnapshot, pagedDelete })
    }
    console.log(
      JSON.stringify(
        {
          fixture: 'temporary generated v2 segment; no real source files',
          count,
          deleted: 40000,
          node: process.version,
          native: addon.getNativeVersion(),
          rounds,
        },
        null,
        2,
      ),
    )
  } finally {
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
