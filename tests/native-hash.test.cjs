// P1-A: DctHash64 tests — no external dependencies, no network.
// Uses minimal embedded base64 images written to temp dir.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const { loadTsModule } = require('./guard-utils.cjs')

const addon = require('../native/build/Release/fast_scanner.node')
const { ProjectPreviewService } = loadTsModule('electron/projectPreviewService.ts')

function hamming64(left, right) {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`)
  let count = 0
  while (value) {
    value &= value - 1n
    count += 1
  }
  return count
}

// Minimal valid images (same as native-decode test for deterministic tests)
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
const JPEG_1PX =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxRwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYI1iQzQ1NjdTVFVHV2h1dnd4eXqCg4SFhoeIiYqLjI1Oj4KTlJWWl5iZmpucnZ6fkqOkpaanqKmqq6usra6u/9oADAMBAAIRAxEAPwD/2Q=='
const GIF_1PX = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

// Helper: create a valid 8×8 grayscale PNG from raw pixel data
// Uses zlib + minimal PNG structure
const zlib = require('node:zlib')

function create8x8Png(filePath, pixels) {
  // pixels: Uint8Array of 64 bytes (8 rows × 8 cols, grayscale 0-255)
  // Build raw scanlines (filter byte 0 + 8 pixels per row)
  const raw = Buffer.alloc(8 * 9) // 8 rows × (1 filter + 8 pixels)
  for (let row = 0; row < 8; row++) {
    raw[row * 9] = 0 // filter: None
    for (let col = 0; col < 8; col++) {
      raw[row * 9 + 1 + col] = pixels[row * 8 + col]
    }
  }
  const compressed = zlib.deflateSync(raw)

  // Build minimal PNG
  const chunks = []
  // IHDR
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(8, 0) // width
  ihdr.writeUInt32BE(8, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type: grayscale
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  chunks.push(pngChunk('IHDR', ihdr))
  // IDAT
  chunks.push(pngChunk('IDAT', compressed))
  // IEND
  chunks.push(pngChunk('IEND', Buffer.alloc(0)))

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    ...chunks,
  ])
  fs.writeFileSync(filePath, png)
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeB = Buffer.from(type, 'ascii')
  const crcInput = Buffer.concat([typeB, data])
  const crc = crc32(crcInput)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc >>> 0, 0)
  return Buffer.concat([len, typeB, data, crcBuf])
}

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

// Two distinctly different 8×8 grayscale patterns
const PIXELS_A = new Uint8Array(64)
for (let i = 0; i < 64; i++) PIXELS_A[i] = i % 2 === 0 ? 255 : 0 // checkerboard

const PIXELS_B = new Uint8Array(64)
for (let i = 0; i < 64; i++) PIXELS_B[i] = i < 32 ? 255 : 0 // top-half white, bottom-half black

function createFromBase64(filePath, b64) {
  const buf = Buffer.from(b64, 'base64')
  fs.writeFileSync(filePath, buf)
}

test('P1-A: hashImage returns dctHash64 as 16-char hex string', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-hash-'))
  const fp = path.join(dir, 'test.png')
  createFromBase64(fp, PNG_1PX)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(
      typeof r.diffHash64 === 'string' && r.diffHash64.length === 16,
      `diffHash64 should be 16 hex chars: ${r.diffHash64}`,
    )
    assert.ok(
      typeof r.dctHash64 === 'string' && r.dctHash64.length === 16,
      `dctHash64 should be 16 hex chars, got: ${r.dctHash64}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-A: hashImage is deterministic for DCT hash (same image → same dctHash64)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-hash-'))
  const fp = path.join(dir, 'test.png')
  createFromBase64(fp, PNG_1PX)

  try {
    const r1 = addon.hashImage(fp)
    const r2 = addon.hashImage(fp)
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.equal(
      r1.dctHash64,
      r2.dctHash64,
      `dctHash64 should be deterministic: ${r1.dctHash64} vs ${r2.dctHash64}`,
    )
    assert.equal(
      r1.diffHash64,
      r2.diffHash64,
      `diffHash64 should still be deterministic: ${r1.diffHash64} vs ${r2.diffHash64}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-A: hashImage returns different dctHash64 for different images', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-hash-'))
  const fp1 = path.join(dir, 'test_a.png')
  const fp2 = path.join(dir, 'test_b.png')
  create8x8Png(fp1, PIXELS_A)
  create8x8Png(fp2, PIXELS_B)

  try {
    const r1 = addon.hashImage(fp1)
    const r2 = addon.hashImage(fp2)
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.notEqual(
      r1.dctHash64,
      r2.dctHash64,
      `DCT hashes for different images should differ: both got ${r1.dctHash64}`,
    )
    assert.notEqual(
      r1.diffHash64,
      r2.diffHash64,
      `Diff hashes for different images should differ: both got ${r1.diffHash64}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-A: hashImage returns dctHash64 for JPEG', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-hash-'))
  const fp = path.join(dir, 'test.jpg')
  createFromBase64(fp, JPEG_1PX)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(typeof r.dctHash64 === 'string' && r.dctHash64.length === 16)
    assert.ok(typeof r.diffHash256 === 'string' && r.diffHash256.length === 64)
    assert.ok(typeof r.diffHash64 === 'string' && r.diffHash64.length === 16)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('project preview cache emits a native-hash-compatible JPEG proxy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-project-preview-'))
  const sourcePath = path.join(dir, 'source.psd')
  fs.writeFileSync(sourcePath, 'project-source')
  const providerPreview = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 40, g: 120, b: 220 },
    },
  })
    .jpeg()
    .toBuffer()
  const provider = {
    id: 'native-contract-fixture',
    version: '1',
    extensions: ['psd'],
    extract: async () => providerPreview,
  }
  try {
    const entry = await new ProjectPreviewService(dir, [provider]).getOrCreate(sourcePath)
    assert.equal(entry.status, 'ready')
    assert.equal(path.extname(entry.previewPath), '.jpg')
    assert.match(entry.providerVersion, /\+jpeg-v2-vector-focus$/)
    const hashed = addon.hashImage(entry.previewPath)
    assert.equal(hashed.ok, true, JSON.stringify(hashed))
    assert.equal(typeof hashed.diffHash64, 'string')
    assert.equal(typeof hashed.dctHash64, 'string')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Illustrator preview focuses vector content across mismatched artboard ratios', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-ai-focus-'))
  const sourcePath = path.join(dir, 'source.ai')
  const queryPath = path.join(dir, 'query.png')
  fs.writeFileSync(sourcePath, 'illustrator-source')
  const artwork = `
    <g fill="none" stroke="#fff" stroke-width="28">
      <ellipse cx="360" cy="512" rx="300" ry="155"/>
      <rect x="235" y="435" width="250" height="155" rx="18"/>
    </g>
    <circle cx="285" cy="480" r="20" fill="#fff"/>
  `
  const providerPreview = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="720" height="1024">
      <rect width="720" height="1024" fill="#4b84ef"/>
      <rect x="18" y="20" width="700" height="980" fill="#4f88f3"/>
      <path d="M718 0v1024" stroke="#fff" stroke-width="2"/>
      ${artwork}
    </svg>
  `)
  await sharp(
    Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="648" height="648">
        <rect width="648" height="648" fill="#4b84ef"/>
        <g transform="translate(-36 -188)">${artwork}</g>
      </svg>
    `),
  )
    .png()
    .toFile(queryPath)
  const provider = {
    id: 'ai-focus-fixture',
    version: '1',
    extensions: ['ai'],
    extract: async () => providerPreview,
  }
  try {
    const entry = await new ProjectPreviewService(dir, [provider]).getOrCreate(sourcePath)
    assert.equal(entry.status, 'ready')
    assert.equal(entry.width, entry.height)
    const queryHash = addon.hashImage(queryPath)
    const previewHash = addon.hashImage(entry.previewPath)
    assert.equal(queryHash.ok, true)
    assert.equal(previewHash.ok, true)
    assert.ok(
      hamming64(queryHash.diffHash64, previewHash.diffHash64) <= 10,
      JSON.stringify({ queryHash, previewHash }),
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-A: hashImage returns dctHash64 for GIF', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-hash-'))
  const fp = path.join(dir, 'test.gif')
  createFromBase64(fp, GIF_1PX)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(typeof r.dctHash64 === 'string' && r.dctHash64.length === 16)
    assert.ok(typeof r.diffHash64 === 'string' && r.diffHash64.length === 16)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-A: dctHash64 bit 0 is always 0 (DC excluded)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-hash-'))
  const fp = path.join(dir, 'test.png')
  createFromBase64(fp, PNG_1PX)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, true)
    assert.ok(
      typeof r.readMs === 'number' && r.readMs >= 0,
      `readMs should be a non-negative number: ${r.readMs}`,
    )
    // Parse hex → check bit 0 (LSB of the uint64) — bit 0 corresponds to
    // the LEAST significant bit of the first character pair in little-endian.
    // Since hex64 outputs big-endian hex, the last char of the 16-char hex
    // string corresponds to the least significant nibble.
    // Check: the least significant bit (bit 0) of the last hex digit is 0.
    const lastNibble = parseInt(r.dctHash64[15], 16)
    assert.equal(
      lastNibble & 1,
      0,
      `dctHash64 bit 0 (DC) should be 0, got last hex digit ${r.dctHash64[15]}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── P1-B: SearchByImage tests ──────────────────────────

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

test('P1-B: searchByImage returns queryDctHash64 and preserves queryHash (diffHash)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-sbihash-'))
  const sub = path.join(root, 'sub')
  fs.mkdirSync(sub)

  // Create two distinct 8×8 PNGs
  const fp1 = path.join(sub, 'img_a.png')
  const fp2 = path.join(sub, 'img_b.png')
  create8x8Png(fp1, PIXELS_A)
  create8x8Png(fp2, PIXELS_B)

  try {
    addon.clearIndex()
    const started = addon.scanDirectory(root, 'full')
    assert.equal(started.ok, true)
    const progress = await waitForScan(addon)
    assert.equal(progress.state, 'idle')

    const res = addon.searchByImage(fp1, 30, 50, 'balanced')
    assert.equal(res.ok, true, JSON.stringify(res))

    // queryHash must exist (diffHash64, 16 hex chars)
    assert.ok(
      typeof res.queryHash === 'string' && res.queryHash.length === 16,
      `queryHash should be 16 hex: ${res.queryHash}`,
    )

    // queryDctHash64 must exist (16 hex chars)
    assert.ok(
      typeof res.queryDctHash64 === 'string' && res.queryDctHash64.length === 16,
      `queryDctHash64 should be 16 hex: ${res.queryDctHash64}`,
    )

    // Results should still come back (search via diffHash)
    assert.ok(Array.isArray(res.results), 'results should be an array')
    assert.ok(res.results.length > 0, 'should find at least the query image itself')

    // The query image itself should be in results (score ≈ 1.0)
    const selfHit = res.results.find(
      (r) => r.path.replace(/\\/g, '/').toLowerCase() === fp1.replace(/\\/g, '/').toLowerCase(),
    )
    assert.ok(selfHit, 'query image should match itself')
    assert.ok(selfHit.score > 0.9, `self score should be >0.9, got ${selfHit.score}`)
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P1-B: hashImage.dctHash64 === searchByImage.queryDctHash64 for same image', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-sbiconsist-'))
  const fp = path.join(dir, 'test.png')
  create8x8Png(fp, PIXELS_A)

  try {
    addon.clearIndex()
    const started = addon.scanDirectory(dir, 'full')
    assert.equal(started.ok, true)
    await waitForScan(addon)

    const h = addon.hashImage(fp)
    const s = addon.searchByImage(fp, 30, 50, 'balanced')

    assert.equal(h.ok, true)
    assert.equal(s.ok, true)
    assert.equal(
      h.dctHash64,
      s.queryDctHash64,
      `hashImage.dctHash64 (${h.dctHash64}) should equal searchByImage.queryDctHash64 (${s.queryDctHash64})`,
    )
    assert.equal(
      h.diffHash64,
      s.queryHash,
      `hashImage.diffHash64 should equal searchByImage.queryHash`,
    )
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-B: JPEG scan, hash and sync/async image search keep exact hash parity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-jpeg-search-parity-'))
  const fp = path.join(dir, 'query.jpg')

  try {
    const width = 96
    const height = 64
    const pixels = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 3
        pixels[offset] = (x * 3 + y * 5) & 0xff
        pixels[offset + 1] = (x * 7 + y * 2) & 0xff
        pixels[offset + 2] = (x * 11 + y * 13) & 0xff
      }
    }
    await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 91 }).toFile(fp)

    addon.clearIndex()
    assert.equal(addon.scanDirectory(dir, 'full').ok, true)
    assert.equal((await waitForScan(addon)).state, 'idle')

    const indexed = addon.snapshotIndexRecords().records.find((record) => record.path === fp)
    const hashed = addon.hashImage(fp)
    const hashedAsync = await addon.hashImageAsync(fp)
    const searched = addon.searchByImage(fp, 0, 10, 'recall')
    const searchedAsync = await addon.searchByImageAsync(fp, 0, 10, 'recall')

    assert.ok(indexed, 'the JPEG must be present in the authoritative scan index')
    assert.equal(hashed.ok, true)
    assert.equal(hashedAsync.diffHash64, hashed.diffHash64)
    assert.equal(hashedAsync.dctHash64, hashed.dctHash64)
    assert.equal(searched.queryHash, hashed.diffHash64)
    assert.equal(searched.queryDctHash64, hashed.dctHash64)
    assert.equal(searchedAsync.queryHash, hashed.diffHash64)
    assert.equal(searchedAsync.queryDctHash64, hashed.dctHash64)

    for (const result of [searched, searchedAsync]) {
      const self = result.results.find((entry) => entry.path === fp)
      assert.ok(self, 'the indexed JPEG must match itself')
      assert.equal(self.distance, 0)
      assert.equal(self.dctDistance, 0)
    }
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-B: compute_dcthash64 remains deterministic after cos table optimization', () => {
  // Same test as P1-A deterministic — re-verified after P1-B change
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-hash-'))
  const fp = path.join(dir, 'test.png')
  createFromBase64(fp, PNG_1PX)

  try {
    const r1 = addon.hashImage(fp)
    const r2 = addon.hashImage(fp)
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.equal(
      r1.dctHash64,
      r2.dctHash64,
      `dctHash64 should be deterministic after cos table change: ${r1.dctHash64} vs ${r2.dctHash64}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── P1-C: Single decode dual hash tests ─────────────────

test('P1-C: hashImage dual hash path uses consistent dimensions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-hash-'))
  const fp = path.join(dir, 'test.png')
  create8x8Png(fp, PIXELS_A)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.width, 8, 'width should be 8')
    assert.equal(r.height, 8, 'height should be 8')
    assert.ok(typeof r.diffHash64 === 'string' && r.diffHash64.length === 16)
    assert.ok(typeof r.dctHash64 === 'string' && r.dctHash64.length === 16)
    // Both hashes should be non-zero for 8×8 checkerboard
    assert.notEqual(
      r.diffHash64,
      '0000000000000000',
      `diffHash64 should not be zero for checkerboard: ${r.diffHash64}`,
    )
    assert.notEqual(
      r.dctHash64,
      '0000000000000000',
      `dctHash64 should not be zero for checkerboard: ${r.dctHash64}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-C: hashImage decodeMs and hashMs are reasonable numbers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-hash-'))
  const fp = path.join(dir, 'test.png')
  create8x8Png(fp, PIXELS_A)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, true)
    assert.ok(
      typeof r.decodeMs === 'number' && r.decodeMs >= 0,
      `decodeMs should be a non-negative number: ${r.decodeMs}`,
    )
    assert.ok(
      typeof r.hashMs === 'number' && r.hashMs >= 0,
      `hashMs should be a non-negative number: ${r.hashMs}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-C: hashImage diffHash64 and dctHash64 are independent (different hash values)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-hash-'))
  const fp = path.join(dir, 'test.png')
  create8x8Png(fp, PIXELS_A)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, true)
    // diffHash64 and dctHash64 are fundamentally different algorithms;
    // they should produce different values for a non-trivial image
    assert.notEqual(
      r.diffHash64,
      r.dctHash64,
      `diffHash64 (${r.diffHash64}) should differ from dctHash64 (${r.dctHash64}) for non-uniform image`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-E: hashImageAsync matches the synchronous hash result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-async-hash-'))
  const fp = path.join(dir, 'test.png')
  create8x8Png(fp, PIXELS_A)

  try {
    const syncResult = addon.hashImage(fp)
    const asyncResult = await addon.hashImageAsync(fp)
    assert.equal(asyncResult.ok, true, JSON.stringify(asyncResult))
    assert.equal(asyncResult.diffHash64, syncResult.diffHash64)
    assert.equal(asyncResult.dctHash64, syncResult.dctHash64)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
