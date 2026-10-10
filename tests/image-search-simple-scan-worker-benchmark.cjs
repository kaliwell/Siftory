const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'])

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function parseArgs(argv) {
  const positional = argv.filter((value) => !value.startsWith('--'))
  const workers = option(argv, 'workers', '3,4')
    .split(',')
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 2 && value <= 8)
  return {
    dataset: positional[0] ? path.resolve(positional[0]) : '',
    addonPath: path.resolve(
      option(
        argv,
        'addon',
        path.join(__dirname, '..', 'native', 'build-node', 'Release', 'fast_scanner.node'),
      ),
    ),
    workers: [...new Set(workers)],
    repeats: Math.max(1, Math.min(5, Number(option(argv, 'repeats', '3')) || 3)),
    timeoutMs: Math.max(60_000, Number(option(argv, 'timeout-ms', '600000')) || 600_000),
  }
}

function countImages(root) {
  let count = 0
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(target)
      else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        count++
    }
  }
  return count
}

function digest(addon) {
  const snapshot = addon.snapshotIndexRecords()
  assert.equal(snapshot.ok, true)
  const rows = snapshot.records
    .map((record) => `${record.path}\u001f${record.diffHash64}\u001f${record.dctHash64}`)
    .sort()
    .join('\n')
  return {
    count: snapshot.recordCount,
    sha256: crypto.createHash('sha256').update(rows).digest('hex'),
  }
}

function waitForScan(addon, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let minAvailableMemoryBytes = os.freemem()
    let peakRssBytes = process.memoryUsage().rss
    const timer = setInterval(() => {
      minAvailableMemoryBytes = Math.min(minAvailableMemoryBytes, os.freemem())
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
      const progress = addon.getScanProgress()
      if (progress.state === 'error') {
        clearInterval(timer)
        reject(new Error(progress.lastError || progress.error || 'native scan failed'))
      } else if (progress.state === 'idle') {
        clearInterval(timer)
        resolve({ progress, minAvailableMemoryBytes, peakRssBytes })
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`native scan timed out after ${timeoutMs}ms`))
      }
    }, 20)
  })
}

async function run(addon, options, requestedWorkers, sequence) {
  process.env.REASONIX_NATIVE_SCAN_WORKERS = String(requestedWorkers)
  assert.equal(addon.clearIndex().ok, true)
  assert.equal(addon.configureScanThumbnails('', false, 6).ok, true)
  const availableMemoryBeforeBytes = os.freemem()
  const rssBeforeBytes = process.memoryUsage().rss
  const resourcesBefore = process.resourceUsage()
  const startedAt = performance.now()
  assert.equal(addon.scanDirectory(options.dataset, 'update').ok, true)
  const observed = await waitForScan(addon, options.timeoutMs)
  const elapsedMs = performance.now() - startedAt
  const resourcesAfter = process.resourceUsage()
  const result = {
    sequence,
    requestedWorkers,
    effectiveWorkers: observed.progress.scanWorkerCount,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    imagesPerSecond: Number(((options.imageCount * 1000) / elapsedMs).toFixed(2)),
    availableMemoryBeforeBytes,
    minAvailableMemoryBytes: observed.minAvailableMemoryBytes,
    rssBeforeBytes,
    peakRssBytes: observed.peakRssBytes,
    majorPageFaults: resourcesAfter.majorPageFault - resourcesBefore.majorPageFault,
    minorPageFaults: resourcesAfter.minorPageFault - resourcesBefore.minorPageFault,
    fsRead: resourcesAfter.fsRead - resourcesBefore.fsRead,
    digest: digest(addon),
  }
  assert.equal(result.digest.count, options.imageCount)
  process.stderr.write(
    `[scan-workers] ${requestedWorkers} workers: ${result.elapsedMs}ms, ` +
      `${result.imagesPerSecond} images/s, min-free=${Math.round(result.minAvailableMemoryBytes / 1024 / 1024)}MiB\n`,
  )
  return result
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (
    !options.dataset ||
    !fs.existsSync(options.dataset) ||
    !fs.statSync(options.dataset).isDirectory()
  ) {
    throw new Error('Pass an existing image dataset directory')
  }
  if (options.workers.length < 2) throw new Error('Pass at least two distinct --workers values')
  if (!fs.existsSync(options.addonPath))
    throw new Error(`Native addon missing: ${options.addonPath}`)
  options.imageCount = countImages(options.dataset)
  assert.ok(options.imageCount > 0)
  const addon = require(options.addonPath)
  const runs = []
  try {
    let sequence = 0
    for (let repeat = 0; repeat < options.repeats; repeat++) {
      const order = repeat % 2 === 0 ? options.workers : [...options.workers].reverse()
      for (const workers of order) runs.push(await run(addon, options, workers, sequence++))
    }
    assert.equal(new Set(runs.map((run) => run.digest.sha256)).size, 1)
    const summaries = options.workers.map((workers) => {
      const samples = runs.filter((run) => run.requestedWorkers === workers)
      return {
        workers,
        effectiveWorkers: [...new Set(samples.map((sample) => sample.effectiveWorkers))],
        medianElapsedMs: median(samples.map((sample) => sample.elapsedMs)),
        medianImagesPerSecond: median(samples.map((sample) => sample.imagesPerSecond)),
        maxMajorPageFaults: Math.max(...samples.map((sample) => sample.majorPageFaults)),
        minAvailableMemoryBytes: Math.min(
          ...samples.map((sample) => sample.minAvailableMemoryBytes),
        ),
        peakRssBytes: Math.max(...samples.map((sample) => sample.peakRssBytes)),
      }
    })
    const baseline = summaries[0]
    const candidate = summaries[1]
    const comparisonValid = summaries.every(
      (summary) =>
        summary.effectiveWorkers.length === 1 && summary.effectiveWorkers[0] === summary.workers,
    )
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          sourceDatasetReadOnly: true,
          nativeVersion: addon.getNativeVersion(),
          imageCount: options.imageCount,
          digest: runs[0].digest,
          summaries,
          comparisonValid,
          speedup: comparisonValid
            ? Number((baseline.medianElapsedMs / candidate.medianElapsedMs).toFixed(3))
            : null,
          runs,
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    delete process.env.REASONIX_NATIVE_SCAN_WORKERS
    addon.stopScan()
    addon.clearIndex()
  }
}

main().catch((error) => {
  delete process.env.REASONIX_NATIVE_SCAN_WORKERS
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
