const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const sharp = require('sharp')

const addon = require('../native/build/Release/fast_scanner.node')
const imageCount = Math.max(64, Math.min(2048, Number(process.argv[2]) || 512))

function waitForScan() {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const progress = addon.getScanProgress()
      if (progress.state === 'error') {
        clearInterval(timer)
        reject(new Error(progress.lastError || progress.error || 'native scan failed'))
      } else if (progress.state === 'idle') {
        clearInterval(timer)
        resolve(progress)
      } else if (Date.now() - startedAt > 120_000) {
        clearInterval(timer)
        reject(new Error('native scan benchmark timed out'))
      }
    }, 5)
  })
}

function snapshotDigest() {
  const snapshot = addon.snapshotIndexRecords()
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.recordCount, imageCount)
  const hashes = snapshot.records
    .map((record) => `${record.diffHash64}:${record.dctHash64}`)
    .sort()
    .join('\n')
  return crypto.createHash('sha256').update(hashes).digest('hex')
}

async function run(label, workerOverride, source) {
  if (workerOverride == null) delete process.env.REASONIX_NATIVE_SCAN_WORKERS
  else process.env.REASONIX_NATIVE_SCAN_WORKERS = String(workerOverride)
  addon.clearIndex()
  addon.configureScanThumbnails('', false, 6)
  const startedAt = performance.now()
  const started = addon.scanDirectory(source, 'full')
  assert.equal(started.ok, true)
  const progress = await waitForScan()
  const elapsedMs = performance.now() - startedAt
  return {
    label,
    workers: progress.scanWorkerCount,
    queueCapacity: progress.scanQueueCapacity,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    imagesPerSecond: Number(((imageCount * 1000) / elapsedMs).toFixed(2)),
    indexed: addon.getIndexStats().indexedCount,
    digest: snapshotDigest(),
  }
}

function medianReport(label, samples) {
  const sorted = [...samples].sort((left, right) => left.elapsedMs - right.elapsedMs)
  const middle = sorted[Math.floor(sorted.length / 2)]
  return {
    label,
    workers: middle.workers,
    queueCapacity: middle.queueCapacity,
    elapsedMs: middle.elapsedMs,
    imagesPerSecond: middle.imagesPerSecond,
    indexed: middle.indexed,
    digest: middle.digest,
    samples: samples.map(({ elapsedMs, imagesPerSecond }) => ({ elapsedMs, imagesPerSecond })),
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-scan-workers-'))
  const source = path.join(root, 'source')
  fs.mkdirSync(source)
  const base = path.join(source, 'base.jpg')
  await sharp({
    create: {
      width: 2048,
      height: 1365,
      channels: 3,
      background: { r: 93, g: 127, b: 181 },
    },
  })
    .jpeg({ quality: 88 })
    .toFile(base)
  for (let index = 1; index < imageCount; index += 1) {
    fs.linkSync(base, path.join(source, `image-${String(index).padStart(4, '0')}.jpg`))
  }

  try {
    await run('warmup-fixed-2', 2, source)
    await run('warmup-adaptive', null, source)
    const baselineSamples = []
    const adaptiveSamples = []
    baselineSamples.push(await run('fixed-2', 2, source))
    adaptiveSamples.push(await run('adaptive', null, source))
    adaptiveSamples.push(await run('adaptive', null, source))
    baselineSamples.push(await run('fixed-2', 2, source))
    baselineSamples.push(await run('fixed-2', 2, source))
    adaptiveSamples.push(await run('adaptive', null, source))
    const baseline = medianReport('fixed-2', baselineSamples)
    const adaptive = medianReport('adaptive', adaptiveSamples)
    assert.equal(adaptive.indexed, baseline.indexed)
    assert.equal(adaptive.digest, baseline.digest, 'worker policy must not alter hash output')
    const report = {
      imageCount,
      baseline,
      adaptive,
      speedup: Number((adaptive.imagesPerSecond / baseline.imagesPerSecond).toFixed(3)),
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    delete process.env.REASONIX_NATIVE_SCAN_WORKERS
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  delete process.env.REASONIX_NATIVE_SCAN_WORKERS
  console.error(error)
  process.exitCode = 1
})
