const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const sharp = require('sharp')

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const addonPath = path.resolve(argument('--addon', 'native/build/Release/fast_scanner.node'))
const imageCount = Math.max(16, Number(argument('--count', '96')))
const rounds = Math.max(1, Number(argument('--rounds', '3')))
const addon = require(addonPath)

async function waitForScan() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const progress = addon.getScanProgress()
    if (progress.state !== 'scanning') return progress
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  addon.stopScan()
  throw new Error('JPEG single-pass benchmark timed out')
}

function indexDigest() {
  const snapshot = addon.snapshotIndexRecords()
  assert.equal(snapshot.ok, true)
  const hashes = snapshot.records
    .map((record) => `${path.basename(record.path)}|${record.diffHash64}|${record.dctHash64}`)
    .sort()
    .join('\n')
  return crypto.createHash('sha256').update(hashes).digest('hex')
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-jpeg-single-pass-'))
  const source = path.join(root, 'source')
  const cache = path.join(root, 'cache')
  fs.mkdirSync(source)
  fs.mkdirSync(cache)
  const base = path.join(source, 'image-0000.jpg')
  const width = 1600
  const height = 1200
  const pixels = Buffer.allocUnsafe(width * height * 3)
  let state = 0x9e3779b9
  for (let index = 0; index < pixels.length; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    pixels[index] = state & 0xff
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toFile(base)
  for (let index = 1; index < imageCount; index += 1) {
    fs.linkSync(base, path.join(source, `image-${String(index).padStart(4, '0')}.jpg`))
  }

  try {
    const samples = []
    for (let round = 0; round < rounds; round += 1) {
      addon.clearIndex()
      fs.rmSync(cache, { recursive: true, force: true })
      fs.mkdirSync(cache)
      addon.configureScanThumbnails(cache, true, 6)
      const startedAt = performance.now()
      const started = addon.scanDirectory(source, 'full')
      assert.equal(started.ok, true)
      const progress = await waitForScan()
      const elapsedMs = performance.now() - startedAt
      assert.equal(progress.state, 'idle')
      assert.equal(addon.getIndexStats().indexedCount, imageCount)
      assert.equal(progress.thumbnailQueued, imageCount)
      assert.equal(progress.thumbnailCompleted, imageCount)
      assert.equal(progress.thumbnailFailed, 0)
      assert.equal(fs.readdirSync(cache).filter((name) => name.endsWith('.jpg')).length, imageCount)
      samples.push({
        elapsedMs: Number(elapsedMs.toFixed(2)),
        thumbnailInputReused: progress.thumbnailInputReused ?? null,
        thumbnailInputReusedBytes: progress.thumbnailInputReusedBytes ?? null,
        thumbnailSourceReads: progress.thumbnailSourceReads ?? null,
        thumbnailInputFallback: progress.thumbnailInputFallback ?? null,
        retainedInputBytes: progress.thumbnailRetainedInputBytes ?? null,
        digest: indexDigest(),
      })
    }
    assert.equal(new Set(samples.map((sample) => sample.digest)).size, 1)
    const ordered = [...samples].sort((left, right) => left.elapsedMs - right.elapsedMs)
    const median = ordered[Math.floor(ordered.length / 2)]
    process.stdout.write(
      `${JSON.stringify(
        {
          version: addon.getNativeVersion(),
          addonPath,
          imageCount,
          sourceBytesPerImage: fs.statSync(base).size,
          medianMs: median.elapsedMs,
          imagesPerSecond: Number(((imageCount * 1000) / median.elapsedMs).toFixed(2)),
          samples,
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    addon.stopScan()
    addon.configureScanThumbnails('', false, 6)
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
