const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'])

function parseArgs(argv) {
  const positional = argv.filter((argument) => !argument.startsWith('--'))
  const option = (name) =>
    argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
  const only = option('only') || 'all'
  if (!['all', 'cold-no-thumbnails', 'cold-with-thumbnails'].includes(only)) {
    throw new Error(`Unsupported --only value: ${only}`)
  }
  return {
    dataset: positional[0] ? path.resolve(positional[0]) : '',
    addonPath: path.resolve(
      option('addon') ||
        path.join(__dirname, '..', 'native', 'build-node', 'Release', 'fast_scanner.node'),
    ),
    timeoutMs: Math.max(60_000, Number(option('timeout-ms')) || 30 * 60 * 1000),
    only,
  }
}

function countImages(root) {
  let count = 0
  let bytes = 0
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(target)
      else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        count += 1
        bytes += fs.statSync(target).size
      }
    }
  }
  return { count, bytes }
}

function waitForScan(addon, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let peakRss = process.memoryUsage().rss
    const timer = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      const progress = addon.getScanProgress()
      if (progress.state === 'error') {
        clearInterval(timer)
        reject(new Error(progress.lastError || progress.error || 'native scan failed'))
      } else if (progress.state === 'idle') {
        clearInterval(timer)
        resolve({ progress, peakRss })
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`native scan timed out after ${timeoutMs}ms`))
      }
    }, 20)
  })
}

function indexDigest(addon) {
  const snapshot = addon.snapshotIndexRecords()
  assert.equal(snapshot.ok, true)
  const rows = snapshot.records
    .map((record) => `${record.path}\u001f${record.diffHash64}\u001f${record.dctHash64}`)
    .sort()
    .join('\n')
  return {
    recordCount: snapshot.recordCount,
    sha256: crypto.createHash('sha256').update(rows).digest('hex'),
  }
}

async function runScan(addon, options) {
  if (options.clear) {
    const cleared = addon.clearIndex()
    assert.equal(cleared.ok, true)
  }
  const configured = addon.configureScanThumbnails(options.thumbnailDir, options.thumbnails, 6)
  assert.equal(configured.ok, true)
  const memoryBefore = process.memoryUsage().rss
  const startedAt = performance.now()
  const started = addon.scanDirectory(options.dataset, 'update')
  assert.equal(started.ok, true)
  const { progress, peakRss } = await waitForScan(addon, options.timeoutMs)
  const elapsedMs = performance.now() - startedAt
  const digest = indexDigest(addon)
  const report = {
    label: options.label,
    thumbnails: options.thumbnails,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    imagesPerSecond: Number(((options.imageCount * 1000) / elapsedMs).toFixed(2)),
    sourceMiBPerSecond: Number((options.imageBytes / 1024 / 1024 / (elapsedMs / 1000)).toFixed(2)),
    rssDeltaMiB: Number(((process.memoryUsage().rss - memoryBefore) / 1024 / 1024).toFixed(2)),
    rssPeakDeltaMiB: Number(((peakRss - memoryBefore) / 1024 / 1024).toFixed(2)),
    digest,
    index: addon.getIndexStats(),
    progress,
  }
  process.stderr.write(
    `${options.label}: ${report.elapsedMs}ms, ${report.imagesPerSecond} images/s, ` +
      `thumb-reused=${progress.thumbnailInputReused}, ` +
      `thumb-rereads=${progress.thumbnailSourceReads}, ` +
      `retained-limit=${progress.thumbnailRetainedInputLimitBytes}, ` +
      `peak-rss-delta=${report.rssPeakDeltaMiB}MiB\n`,
  )
  return report
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.dataset || !fs.statSync(options.dataset).isDirectory()) {
    throw new Error('Pass an existing image dataset directory')
  }
  if (!fs.existsSync(options.addonPath))
    throw new Error(`Native addon missing: ${options.addonPath}`)
  const dataset = countImages(options.dataset)
  if (dataset.count === 0) throw new Error('Dataset contains no supported images')
  const addon = require(options.addonPath)
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-simple-mode-'))
  const thumbnailDir = path.join(tempRoot, 'thumbcache')
  const indexDir = path.join(tempRoot, 'index')
  fs.mkdirSync(thumbnailDir)
  try {
    if (options.only !== 'all') {
      const thumbnails = options.only === 'cold-with-thumbnails'
      const run = await runScan(addon, {
        ...options,
        label: options.only,
        clear: true,
        thumbnails,
        thumbnailDir,
        imageCount: dataset.count,
        imageBytes: dataset.bytes,
      })
      assert.equal(run.digest.recordCount, dataset.count)
      process.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            dataset: { imageCount: dataset.count, imageBytes: dataset.bytes },
            nativeVersion: addon.getNativeVersion(),
            runs: [run],
          },
          null,
          2,
        )}\n`,
      )
      return
    }
    const coldNoThumbnails = await runScan(addon, {
      ...options,
      label: 'cold-no-thumbnails',
      clear: true,
      thumbnails: false,
      thumbnailDir,
      imageCount: dataset.count,
      imageBytes: dataset.bytes,
    })
    const coldWithThumbnails = await runScan(addon, {
      ...options,
      label: 'cold-with-thumbnails',
      clear: true,
      thumbnails: true,
      thumbnailDir,
      imageCount: dataset.count,
      imageBytes: dataset.bytes,
    })
    const persistStartedAt = performance.now()
    const saved = addon.saveIndexToManifest(indexDir)
    assert.equal(saved.ok, true, JSON.stringify(saved))
    const persistMs = performance.now() - persistStartedAt
    assert.equal(addon.clearIndex().ok, true)
    const loadStartedAt = performance.now()
    const loaded = addon.loadManifest(indexDir)
    assert.equal(loaded.ok, true, JSON.stringify(loaded))
    const loadMs = performance.now() - loadStartedAt
    const loadedDigest = indexDigest(addon)
    const warmUpdate = await runScan(addon, {
      ...options,
      label: 'warm-update',
      clear: false,
      thumbnails: true,
      thumbnailDir,
      imageCount: dataset.count,
      imageBytes: dataset.bytes,
    })
    assert.equal(coldNoThumbnails.digest.recordCount, dataset.count)
    assert.equal(coldWithThumbnails.digest.recordCount, dataset.count)
    assert.equal(coldNoThumbnails.digest.sha256, coldWithThumbnails.digest.sha256)
    assert.equal(loadedDigest.sha256, coldWithThumbnails.digest.sha256)
    assert.equal(warmUpdate.digest.sha256, coldWithThumbnails.digest.sha256)
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      dataset: { imageCount: dataset.count, imageBytes: dataset.bytes },
      nativeVersion: addon.getNativeVersion(),
      persistence: {
        persistMs: Number(persistMs.toFixed(2)),
        loadMs: Number(loadMs.toFixed(2)),
        recordCount: loaded.recordCount,
      },
      runs: [coldNoThumbnails, coldWithThumbnails, warmUpdate],
      thumbnailOverheadRatio: Number(
        (coldWithThumbnails.elapsedMs / coldNoThumbnails.elapsedMs).toFixed(3),
      ),
      warmUpdateSpeedup: Number((coldWithThumbnails.elapsedMs / warmUpdate.elapsedMs).toFixed(3)),
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    addon.stopScan()
    addon.clearIndex()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
