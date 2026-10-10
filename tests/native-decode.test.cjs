// P0-E: Native decode tests — no external dependencies, no network.
// Uses minimal embedded base64 images written to temp dir.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const addon = require('../native/build/Release/fast_scanner.node')

// Minimal valid images (base64-encoded, smallest possible)
// 1×1 red PNG (67 bytes)
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
// Minimal valid JPEG (1×1, ~160 bytes) — grayscale
const JPEG_1PX =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYI1KiQzQ1NjdTVFVHV2h1dnd4eXqCg4SFhoeIiYqLjI1Oj4KTlJWWl5iZmpucnZ6fkqOkpaanqKmqq6usra6u/9oADAMBAAIRAxEAPwD/2Q=='
const JPEG_320X240 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCADwAUADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCIAQFoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//2Q=='
// Minimal valid GIF (1×1, ~35 bytes)
const GIF_1PX = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function createFromBase64(filePath, b64) {
  const buf = Buffer.from(b64, 'base64')
  fs.writeFileSync(filePath, buf)
}

function createOversizedFile(filePath, size) {
  const fd = fs.openSync(filePath, 'w')
  // Write sparse: seek to size-1, write 1 byte
  fs.writeSync(fd, Buffer.alloc(1), 0, 1, size - 1)
  fs.closeSync(fd)
}

function createBmpHeader(filePath, width, height, bitsPerPixel = 24) {
  const header = Buffer.alloc(54)
  header.write('BM', 0, 'ascii')
  header.writeUInt32LE(header.length, 2)
  header.writeUInt32LE(54, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(width, 18)
  header.writeInt32LE(height, 22)
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(bitsPerPixel, 28)
  fs.writeFileSync(filePath, header)
}

test('P0: hashImage returns ok + diffHash64 for PNG', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-decode-'))
  const fp = path.join(dir, 'test.png')
  createFromBase64(fp, PNG_1PX)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, true, `hashImage should succeed: ${JSON.stringify(r)}`)
    assert.ok(
      typeof r.diffHash64 === 'string' && r.diffHash64.length > 0,
      'diffHash64 should be non-empty string',
    )
    assert.ok(r.width > 0, 'width should be > 0')
    assert.ok(r.height > 0, 'height should be > 0')
    assert.ok(typeof r.decodeMs === 'number' && r.decodeMs >= 0, 'decodeMs should be a number')
    assert.ok(typeof r.hashMs === 'number' && r.hashMs >= 0, 'hashMs should be a number')
    assert.ok(
      typeof r.decodeBackend === 'string',
      `decodeBackend should be a string, got ${r.decodeBackend}`,
    )
    assert.ok(
      r.decodeBackend.includes('png') || r.decodeBackend.includes('stb'),
      `decodeBackend should mention png/stb: ${r.decodeBackend}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P0: hashImage returns ok + diffHash64 for JPEG', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-decode-'))
  const fp = path.join(dir, 'test.jpg')
  createFromBase64(fp, JPEG_1PX)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, true, `hashImage should succeed: ${JSON.stringify(r)}`)
    assert.ok(typeof r.diffHash64 === 'string' && r.diffHash64.length > 0)
    assert.ok(
      r.decodeBackend.includes('jpeg') || r.decodeBackend.includes('stb'),
      `decodeBackend: ${r.decodeBackend}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P0: WIC JPEG downsample stays in bounds and reports original dimensions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-decode-'))
  const fp = path.join(dir, 'downsample.jpg')
  createFromBase64(fp, JPEG_320X240)
  const previousWicShadow = process.env.REASONIX_NATIVE_JPEG_WIC_SHADOW

  try {
    process.env.REASONIX_NATIVE_JPEG_WIC_SHADOW = '1'
    const r = addon.hashImage(fp)
    assert.equal(r.ok, true, `hashImage should succeed: ${JSON.stringify(r)}`)
    assert.equal(r.width, 320)
    assert.equal(r.height, 240)
    assert.equal(r.diffHash64.length, 16)
    assert.equal(r.dctHash64.length, 16)
    assert.equal(r.diffHash256.length, 64)
  } finally {
    if (previousWicShadow === undefined) delete process.env.REASONIX_NATIVE_JPEG_WIC_SHADOW
    else process.env.REASONIX_NATIVE_JPEG_WIC_SHADOW = previousWicShadow
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P0: hashImage returns ok + diffHash64 for GIF', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-decode-'))
  const fp = path.join(dir, 'test.gif')
  createFromBase64(fp, GIF_1PX)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, true, `hashImage should succeed for GIF: ${JSON.stringify(r)}`)
    assert.ok(typeof r.diffHash64 === 'string' && r.diffHash64.length > 0)
    assert.ok(
      r.decodeBackend.includes('gif') || r.decodeBackend.includes('stb'),
      `decodeBackend: ${r.decodeBackend}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P0: hashImage fails gracefully for non-image file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-decode-'))
  const fp = path.join(dir, 'not_an_image.txt')
  fs.writeFileSync(fp, 'hello world')

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, false, 'should fail')
    assert.ok(r.error, 'should have error message')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P0: hashImage fails gracefully for oversized file (>64MB)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-decode-'))
  const fp = path.join(dir, 'oversized.bin')
  createOversizedFile(fp, 65 * 1024 * 1024)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, false, 'should fail for oversized file')
    assert.ok(
      r.error && r.error.toLowerCase().includes('large'),
      `error should mention size: ${r.error}`,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P0: decoder rejects an image dimension above the safety limit before allocation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-decode-limit-'))
  const fp = path.join(dir, 'oversized-dimension.bmp')
  createBmpHeader(fp, 40000, 1)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, false)
    assert.match(r.error, /dimension|large|limit/i)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P0: decoder rejects excessive source pixels before allocation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-decode-limit-'))
  const fp = path.join(dir, 'pixel-budget.bmp')
  createBmpHeader(fp, 20000, 20000)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, false)
    assert.match(r.error, /pixel count/i)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P0: decoder rejects excessive decoded memory before allocation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-decode-limit-'))
  const fp = path.join(dir, 'memory-budget.bmp')
  createBmpHeader(fp, 10000, 8000, 32)

  try {
    const r = addon.hashImage(fp)
    assert.equal(r.ok, false)
    assert.match(r.error, /memory/i)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('P0: native status exposes the active image decode limits', () => {
  const status = addon.getNativeStatus()
  assert.equal(status.maxImageDimension, 32768)
  assert.equal(status.maxSourcePixels, 100000000)
  assert.equal(status.maxDecodedBytes, 256 * 1024 * 1024)
  assert.equal(status.scanSignatureBytes, 12)
  const gib = 1024 ** 3
  const cpuTarget = Math.max(2, Math.min(8, Math.ceil(status.scanLogicalProcessors / 4)))
  const totalCap =
    status.scanTotalMemoryBytes > 0 && status.scanTotalMemoryBytes < 6 * gib
      ? 2
      : status.scanTotalMemoryBytes > 0 && status.scanTotalMemoryBytes < 10 * gib
        ? 3
        : status.scanTotalMemoryBytes > 0 && status.scanTotalMemoryBytes < 14 * gib
          ? 4
          : 8
  const availableCap =
    status.scanAvailableMemoryBytes > 0 && status.scanAvailableMemoryBytes < 2 * gib
      ? 2
      : status.scanAvailableMemoryBytes > 0 && status.scanAvailableMemoryBytes < 4 * gib
        ? 3
        : status.scanAvailableMemoryBytes > 0 && status.scanAvailableMemoryBytes < 6 * gib
          ? 4
          : 8
  const expectedWorkers = Math.max(2, Math.min(cpuTarget, totalCap, availableCap))
  assert.equal(status.scanWorkerPolicy, 'cpu-memory-bounded-v1')
  assert.equal(status.scanWorkerOverride, false)
  assert.equal(status.scanWorkerMin, 2)
  assert.equal(status.scanWorkerMax, 8)
  assert.equal(status.scanWorkerCount, expectedWorkers)
  assert.equal(status.scanQueueCapacity, Math.max(64, Math.min(256, expectedWorkers * 32)))
  assert.ok(status.features.includes('bounded-scan-pipeline'))
  assert.ok(status.features.includes('adaptive-scan-workers'))
  assert.ok(status.features.includes('scan-signature-prefilter'))
  assert.ok(status.features.includes('scan-fallback-policy-v1'))
  assert.ok(status.features.includes('scan-thumbnail-input-reuse'))
  assert.ok(status.features.includes('adaptive-thumbnail-fill'))
  assert.ok(status.features.includes('async-exact-bulk-delete'))
  assert.ok(status.thumbnailScanWorkerCount >= 1)
  assert.ok(status.thumbnailScanWorkerCount <= 2)
  assert.ok(status.thumbnailFillWorkerCount >= status.thumbnailScanWorkerCount)
  assert.ok(status.thumbnailFillWorkerCount <= 8)
  assert.ok(status.thumbnailQueueCapacity >= 64)
  assert.ok(status.thumbnailQueueCapacity <= 256)
  assert.equal(status.thumbnailWorkerPolicy, 'index-priority-adaptive-fill-v1')
  assert.ok(status.features.includes('scan-runtime-context'))
  assert.equal(status.scanRuntimeMode, 'env-owned-shared-lifetime')
  assert.equal(status.stopScanAsyncMode, 'shared-runtime-owned')
  assert.equal(status.scanStopInProgress, false)
  assert.equal(status.scanStopWorkCount, 0)
  assert.ok(status.features.includes('scan-runtime-ownership'))
  assert.ok(status.features.includes('async-work-registry'))
  assert.ok(status.features.includes('cooperative-persistence-cancellation'))
  assert.equal(status.asyncWorkMode, 'env-owned-explicit-cancel-teardown-drain')
  assert.equal(status.asyncWorkCancellationMode, 'explicit-cooperative-persistence-native-queued')
  assert.equal(status.asyncWorkActiveCount, 0)
  assert.equal(status.asyncWorkRunningCount, 0)
  assert.equal(status.asyncWorkCancellableCount, 0)
  assert.equal(status.asyncWorkPreCommitCount, 0)
  assert.equal(status.asyncWorkClosing, false)
  assert.equal(status.asyncWorkCancelAccepted, 0)
  assert.ok(status.features.includes('scan-metrics-context'))
  assert.equal(status.scanMetricsMode, 'runtime-owned')
  assert.ok(status.features.includes('index-runtime-context'))
  assert.equal(status.indexRuntimeMode, 'process-shared-owned')
  assert.ok(status.features.includes('addon-context'))
  assert.equal(status.addonContextMode, 'env-owned-scan-shared-index-owner')
  assert.ok(status.features.includes('scan-index-injection'))
  assert.equal(status.scanIndexMode, 'context-injected-shared')
  assert.ok(status.features.includes('search-index-injection'))
  assert.equal(status.searchIndexMode, 'context-injected-shared')
  assert.ok(status.features.includes('sync-persistence-index-injection'))
  assert.ok(status.features.includes('async-persistence-index-injection'))
  assert.equal(status.persistenceIndexMode, 'context-injected-shared')
  assert.ok(status.features.includes('shared-index-ownership'))
  assert.ok(status.features.includes('single-writer-admission'))
  assert.equal(status.indexWriteMode, 'single-writer-process-shared')
  assert.equal(status.indexWriterActive, false)
  assert.equal(status.indexWriterOperation, '')
})

test('P0: hashImage handles missing file', () => {
  const r = addon.hashImage('C:\\nonexistent\\file\\path\\xyz.jpg')
  assert.equal(r.ok, false, 'should fail for missing file')
})

test('P0: hashImage is deterministic (same image → same hash)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nat-decode-'))
  const fp = path.join(dir, 'test.png')
  createFromBase64(fp, PNG_1PX)

  try {
    const r1 = addon.hashImage(fp)
    const r2 = addon.hashImage(fp)
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.equal(r1.diffHash64, r2.diffHash64, 'hash should be deterministic')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
