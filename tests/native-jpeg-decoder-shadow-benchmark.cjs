const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

// The WIC JPEG decoder is a rejected performance candidate and must never alter
// production query hashes. This benchmark opts into the candidate explicitly.
process.env.REASONIX_NATIVE_JPEG_WIC_SHADOW = '1'

const {
  assertFileSnapshotUnchanged,
  round,
  safeRemoveTempRoot,
  snapshotFiles,
  startResourceMonitor,
  writeJson,
} = require('./search-library-preparation-benchmark-utils.cjs')

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'])
const projectRoot = path.resolve(__dirname, '..')

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function parseArgs(argv) {
  const positional = argv.filter((value) => !value.startsWith('--'))
  return {
    dataset: positional[0] ? path.resolve(positional[0]) : '',
    addonPath: path.resolve(
      option(
        argv,
        'addon',
        path.join(projectRoot, 'native', 'build', 'Release', 'fast_scanner.node'),
      ),
    ),
    sample: Math.max(1, Math.min(1000, Number(option(argv, 'sample', '1000')) || 1000)),
    scanWorkers: Math.max(2, Math.min(8, Number(option(argv, 'scan-workers', '3')) || 3)),
    timeoutMs: Math.max(60_000, Number(option(argv, 'timeout-ms', '900000')) || 900_000),
    outDir: path.resolve(
      option(
        argv,
        'out-dir',
        path.join(
          projectRoot,
          'artifacts',
          'benchmark',
          'image-preparation-pipeline',
          `prep015-${timestampId()}`,
        ),
      ),
    ),
  }
}

function collectImages(root) {
  const files = []
  const directories = [root]
  while (directories.length > 0) {
    const directory = directories.pop()
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) directories.push(target)
      else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(target)
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right))
}

function createSampleCorpus(dataset, files, sample) {
  if (sample >= files.length) return { root: dataset, tempRoot: '', files }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-jpeg-shadow-'))
  const root = path.join(tempRoot, 'corpus')
  fs.mkdirSync(root)
  const selected = files.slice(0, sample)
  for (let index = 0; index < selected.length; index += 1) {
    const extension = path.extname(selected[index]).toLowerCase()
    fs.copyFileSync(
      selected[index],
      path.join(root, `image-${String(index).padStart(6, '0')}${extension}`),
    )
  }
  return { root, tempRoot, files: selected }
}

function createTimeline(filePath, context) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, '', 'utf8')
  const startedAt = performance.now()
  return {
    write(event, details = {}) {
      const memory = process.memoryUsage()
      fs.appendFileSync(
        filePath,
        `${JSON.stringify({
          schemaVersion: 1,
          timestamp: new Date().toISOString(),
          atMs: round(performance.now() - startedAt),
          event,
          ...context,
          ...details,
          mainRssMiB: round(memory.rss / 1024 / 1024),
          systemFreeMiB: round(os.freemem() / 1024 / 1024),
        })}\n`,
        'utf8',
      )
    },
  }
}

function waitForScan(addon, timeoutMs, timeline) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let lastTimelineAt = 0
    const timer = setInterval(() => {
      const progress = addon.getScanProgress()
      const now = Date.now()
      if (now - lastTimelineAt >= 1_000) {
        lastTimelineAt = now
        timeline.write('scan-progress', {
          stage: 'stb-baseline',
          state: String(progress.state || 'unknown'),
          indexedCount: Number(progress.indexedCount) || 0,
          skippedCount: Number(progress.skippedCount) || 0,
          activeWorkers: Number(progress.scanActiveWorkers) || 0,
          queuePending: Number(progress.scanQueuePending) || 0,
          decodeMs: Number(progress.decodeMsTotal) || 0,
          hashMs: Number(progress.hashMsTotal) || 0,
        })
      }
      if (progress.state === 'error') {
        clearInterval(timer)
        reject(new Error(progress.lastError || progress.error || 'Native scan failed'))
      } else if (progress.state === 'idle') {
        clearInterval(timer)
        resolve(progress)
      } else if (now - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Native scan timed out after ${timeoutMs}ms`))
      }
    }, 50)
  })
}

function recordDigest(records, root) {
  const rows = records
    .map((record) =>
      [
        path.relative(root, record.path).split(path.sep).join('/'),
        record.width,
        record.height,
        record.channels,
        record.diffHash64,
        record.dctHash64,
      ].join('\u001f'),
    )
    .sort()
  return {
    count: rows.length,
    sha256: crypto.createHash('sha256').update(rows.join('\n')).digest('hex'),
  }
}

function fileId(root, filePath) {
  const relative = path.relative(root, filePath).split(path.sep).join('/').toLowerCase()
  return crypto.createHash('sha256').update(relative).digest('hex').slice(0, 16)
}

function compactScanProgress(progress) {
  const fields = [
    'scanWorkerCount',
    'scanQueueCapacity',
    'scanPeakQueuePending',
    'scanPeakWorkers',
    'scanWorkerMinCompleted',
    'scanWorkerMaxCompleted',
    'scanWorkerMinBusyMs',
    'scanWorkerMaxBusyMs',
    'filesystemEnumMs',
    'queueWaitMs',
    'readMs',
    'readBytes',
    'decodeMsTotal',
    'hashMsTotal',
    'commitMs',
    'skippedCount',
    'failedCount',
  ]
  return Object.fromEntries(fields.map((field) => [field, progress[field] ?? null]))
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
  if (!fs.existsSync(options.addonPath))
    throw new Error(`Native addon missing: ${options.addonPath}`)

  const allFiles = collectImages(options.dataset)
  if (allFiles.length === 0) throw new Error('Dataset contains no supported images')
  const sampleCorpus = createSampleCorpus(options.dataset, allFiles, options.sample)
  const sourceSnapshotBefore = snapshotFiles(sampleCorpus.files)
  fs.mkdirSync(options.outDir, { recursive: true })
  const timelinePath = path.join(options.outDir, 'shadow.timeline.ndjson')
  const reportPath = path.join(options.outDir, 'shadow-report.json')
  const timeline = createTimeline(timelinePath, { task: 'PREP-015' })
  timeline.write('benchmark-start', {
    sample: sampleCorpus.files.length,
    sourceBytes: sourceSnapshotBefore.totalBytes,
    scanWorkers: options.scanWorkers,
  })

  const originalScanWorkers = process.env.REASONIX_NATIVE_SCAN_WORKERS
  const originalStageMetrics = process.env.REASONIX_NATIVE_STAGE_METRICS
  const originalParityFields = process.env.REASONIX_NATIVE_PARITY_FIELDS
  process.env.REASONIX_NATIVE_SCAN_WORKERS = String(options.scanWorkers)
  process.env.REASONIX_NATIVE_STAGE_METRICS = '1'
  process.env.REASONIX_NATIVE_PARITY_FIELDS = '1'
  const addon = require(options.addonPath)
  let resourceMonitor
  try {
    resourceMonitor = await startResourceMonitor({ intervalMs: 100 })
    assert.equal(addon.clearIndex().ok, true)
    assert.equal(addon.configureScanThumbnails('', false, 6).ok, true)
    timeline.write('stage-start', { stage: 'stb-baseline' })
    const scanStartedAt = performance.now()
    assert.equal(addon.scanDirectory(sampleCorpus.root, 'update').ok, true)
    const scanProgress = await waitForScan(addon, options.timeoutMs, timeline)
    const scanElapsedMs = round(performance.now() - scanStartedAt)
    const snapshot = addon.snapshotIndexRecords()
    assert.equal(snapshot.ok, true)
    timeline.write('stage-end', {
      stage: 'stb-baseline',
      elapsedMs: scanElapsedMs,
      records: snapshot.recordCount,
      skipped: Number(scanProgress.skippedCount) || 0,
    })

    const mismatchCounts = {
      decodeFailure: 0,
      width: 0,
      height: 0,
      channels: 0,
      diffHash64: 0,
      dctHash64: 0,
    }
    const mismatchSamples = []
    const extensionCounts = {}
    const backendCounts = {}
    const timingTotals = { readMs: 0, decodeMs: 0, hashMs: 0 }
    let exactRecords = 0
    timeline.write('stage-start', { stage: 'wic-shadow' })
    const shadowStartedAt = performance.now()
    for (let index = 0; index < snapshot.records.length; index += 1) {
      const baseline = snapshot.records[index]
      const extension = path.extname(baseline.path).toLowerCase() || '<none>'
      extensionCounts[extension] = (extensionCounts[extension] || 0) + 1
      const candidate = addon.hashImage(baseline.path)
      const fields = []
      if (candidate.ok !== true) {
        mismatchCounts.decodeFailure += 1
        fields.push('decodeFailure')
      } else {
        const comparisons = [
          ['width', Number(candidate.width), Number(baseline.width)],
          ['height', Number(candidate.height), Number(baseline.height)],
          ['channels', Number(candidate.channels), Number(baseline.channels)],
          ['diffHash64', String(candidate.diffHash64), String(baseline.diffHash64)],
          ['dctHash64', String(candidate.dctHash64), String(baseline.dctHash64)],
        ]
        for (const [field, actual, expected] of comparisons) {
          if (actual !== expected) {
            mismatchCounts[field] += 1
            fields.push(field)
          }
        }
        timingTotals.readMs += Number(candidate.readMs) || 0
        timingTotals.decodeMs += Number(candidate.decodeMs) || 0
        timingTotals.hashMs += Number(candidate.hashMs) || 0
        const backend = String(candidate.decodeBackend || 'unknown')
        backendCounts[backend] = (backendCounts[backend] || 0) + 1
      }
      if (fields.length === 0) exactRecords += 1
      else if (mismatchSamples.length < 25) {
        mismatchSamples.push({
          id: fileId(sampleCorpus.root, baseline.path),
          extension,
          fields,
        })
      }
      if ((index + 1) % 25 === 0 || index + 1 === snapshot.records.length) {
        timeline.write('shadow-progress', {
          stage: 'wic-shadow',
          completed: index + 1,
          exact: exactRecords,
          mismatched: index + 1 - exactRecords,
        })
      }
    }
    const shadowElapsedMs = round(performance.now() - shadowStartedAt)
    timeline.write('stage-end', {
      stage: 'wic-shadow',
      elapsedMs: shadowElapsedMs,
      compared: snapshot.recordCount,
      exact: exactRecords,
    })

    const resources = await resourceMonitor.stop()
    resourceMonitor = null
    const sourceSnapshotAfter = snapshotFiles(sampleCorpus.files)
    assertFileSnapshotUnchanged(sourceSnapshotBefore, sourceSnapshotAfter)
    const strictParity = exactRecords === snapshot.recordCount && snapshot.recordCount > 0
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      config: {
        sampleRequested: options.sample,
        sourceImageCount: allFiles.length,
        comparedRecords: snapshot.recordCount,
        scanWorkers: options.scanWorkers,
        nativeVersion: addon.getNativeVersion(),
      },
      baseline: {
        decoder: 'stb-full-resolution-seh',
        scanElapsedMs,
        digest: recordDigest(snapshot.records, sampleCorpus.root),
        progress: compactScanProgress(scanProgress),
      },
      candidate: {
        decoder: 'wic-downsample-shadow-via-hashImage',
        wallMs: shadowElapsedMs,
        imagesPerSecond: round((snapshot.recordCount * 1000) / Math.max(1, shadowElapsedMs)),
        timingTotals: Object.fromEntries(
          Object.entries(timingTotals).map(([name, value]) => [name, round(value)]),
        ),
        backendCounts,
      },
      parity: {
        strict: strictParity,
        compared: snapshot.recordCount,
        exact: exactRecords,
        mismatched: snapshot.recordCount - exactRecords,
        mismatchCounts,
        mismatchSamples,
        extensionCounts,
      },
      resources,
      safety: {
        sourceDatasetReadOnly: true,
        sourceUnchanged: true,
        sourceSnapshot: sourceSnapshotBefore,
        pathsAndFilenamesOmitted: true,
        mismatchSampleIdsIrreversible: true,
      },
      gate: {
        strictParity,
        scanPerformanceEligible: strictParity,
        passed: false,
        status: strictParity ? 'pending-integrated-scan-performance' : 'rejected-strict-parity',
        failures: strictParity
          ? ['Integrated scan P50 and complete-ready performance have not been measured yet']
          : ['WIC candidate changed at least one required Native record field'],
      },
    }
    writeJson(reportPath, report)
    timeline.write('benchmark-end', {
      ok: true,
      strictParity,
      status: report.gate.status,
      samplingErrors: resources.sampling.errors,
    })
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        outputDirectory: options.outDir,
        compared: report.parity.compared,
        exact: report.parity.exact,
        mismatched: report.parity.mismatched,
        strictParity,
        scanPerformanceEligible: report.gate.scanPerformanceEligible,
        status: report.gate.status,
      })}\n`,
    )
  } finally {
    if (resourceMonitor) await resourceMonitor.stop().catch(() => undefined)
    addon.stopScan()
    addon.clearIndex()
    if (originalScanWorkers === undefined) delete process.env.REASONIX_NATIVE_SCAN_WORKERS
    else process.env.REASONIX_NATIVE_SCAN_WORKERS = originalScanWorkers
    if (originalStageMetrics === undefined) delete process.env.REASONIX_NATIVE_STAGE_METRICS
    else process.env.REASONIX_NATIVE_STAGE_METRICS = originalStageMetrics
    if (originalParityFields === undefined) delete process.env.REASONIX_NATIVE_PARITY_FIELDS
    else process.env.REASONIX_NATIVE_PARITY_FIELDS = originalParityFields
    if (sampleCorpus.tempRoot) safeRemoveTempRoot(sampleCorpus.tempRoot, 'siftory-jpeg-shadow-')
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = { collectImages, parseArgs, recordDigest }
