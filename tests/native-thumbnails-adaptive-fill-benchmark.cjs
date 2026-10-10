const assert = require('node:assert/strict')
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
const imageCount = Math.max(64, Number(argument('--count', '512')))
const rounds = Math.max(1, Number(argument('--rounds', '3')))
const addon = require(addonPath)

async function waitForCompletion(startedAt) {
  const deadline = Date.now() + 120_000
  let indexReadyMs = null
  while (Date.now() < deadline) {
    if (indexReadyMs == null && addon.getIndexStats().indexedCount === imageCount) {
      indexReadyMs = performance.now() - startedAt
    }
    const progress = addon.getScanProgress()
    if (progress.state !== 'scanning') {
      return { progress, indexReadyMs: indexReadyMs ?? performance.now() - startedAt }
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  addon.stopScan()
  throw new Error('adaptive thumbnail fill benchmark timed out')
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-thumb-fill-benchmark-'))
  const source = path.join(root, 'source')
  const cache = path.join(root, 'cache')
  fs.mkdirSync(source)
  fs.mkdirSync(cache)
  const width = 800
  const height = 600
  const pixels = Buffer.allocUnsafe(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      pixels[offset] = (x * 3 + y) % 256
      pixels[offset + 1] = (x + y * 5) % 256
      pixels[offset + 2] = (x * 7 + y * 11) % 256
    }
  }
  const base = path.join(source, 'image-0000.jpg')
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 88 })
    .toFile(base)
  for (let index = 1; index < imageCount; index += 1) {
    fs.linkSync(base, path.join(source, `image-${String(index).padStart(4, '0')}.jpg`))
  }

  process.env.REASONIX_NATIVE_THUMB_SCAN_WORKERS = '1'
  process.env.REASONIX_NATIVE_THUMB_FILL_WORKERS = '8'
  process.env.REASONIX_NATIVE_THUMB_QUEUE_CAPACITY = '4'
  try {
    const samples = []
    for (let round = 0; round < rounds; round += 1) {
      addon.clearIndex()
      fs.rmSync(cache, { recursive: true, force: true })
      fs.mkdirSync(cache)
      addon.configureScanThumbnails(cache, true, 6)
      const startedAt = performance.now()
      assert.equal(addon.scanDirectory(source, 'full').ok, true)
      const { progress, indexReadyMs } = await waitForCompletion(startedAt)
      const totalMs = performance.now() - startedAt
      assert.equal(progress.state, 'idle')
      assert.equal(addon.getIndexStats().indexedCount, imageCount)
      const cached = fs.readdirSync(cache).filter((name) => name.endsWith('.jpg')).length
      const adaptive = addon.getNativeStatus().features.includes('adaptive-thumbnail-fill')
      if (adaptive) {
        assert.equal(progress.thumbnailQueued, imageCount)
        assert.equal(progress.thumbnailCompleted, imageCount)
        assert.equal(progress.thumbnailDropped, 0)
        assert.equal(progress.thumbnailDeferred, progress.thumbnailFillCompleted)
        assert.equal(progress.thumbnailPending, 0)
        assert.equal(cached, imageCount)
      }
      samples.push({
        indexReadyMs: Number(indexReadyMs.toFixed(2)),
        totalMs: Number(totalMs.toFixed(2)),
        cached,
        queued: progress.thumbnailQueued,
        completed: progress.thumbnailCompleted,
        dropped: progress.thumbnailDropped,
        deferred: progress.thumbnailDeferred ?? null,
        fillCompleted: progress.thumbnailFillCompleted ?? null,
        scanWorkers: progress.thumbnailScanWorkerCount ?? null,
        fillWorkers: progress.thumbnailFillWorkerCount ?? null,
        queueCapacity: progress.thumbnailQueueCapacity ?? null,
        inputReused: progress.thumbnailInputReused ?? null,
        sourceReads: progress.thumbnailSourceReads ?? null,
        retainedInputBytes: progress.thumbnailRetainedInputBytes ?? null,
      })
    }
    const medianValue = (field) => {
      const ordered = samples.map((sample) => sample[field]).sort((left, right) => left - right)
      return ordered[Math.floor(ordered.length / 2)]
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          version: addon.getNativeVersion(),
          addonPath,
          imageCount,
          sourceBytesPerImage: fs.statSync(base).size,
          medianIndexReadyMs: medianValue('indexReadyMs'),
          medianTotalMs: medianValue('totalMs'),
          minimumCached: Math.min(...samples.map((sample) => sample.cached)),
          samples,
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    delete process.env.REASONIX_NATIVE_THUMB_SCAN_WORKERS
    delete process.env.REASONIX_NATIVE_THUMB_FILL_WORKERS
    delete process.env.REASONIX_NATIVE_THUMB_QUEUE_CAPACITY
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
