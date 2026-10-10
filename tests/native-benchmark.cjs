const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const addon = require('../native/build/Release/fast_scanner.node')

const defaultIndexDir = path.join(
  process.env.APPDATA || '',
  'floating-clock-electron',
  'image-search-index',
)
const indexDir = path.resolve(process.argv[2] || defaultIndexDir)
const rounds = Math.max(1, Math.min(10_000, Number(process.argv[3]) || 100))

if (!fs.existsSync(path.join(indexDir, 'manifest.json'))) {
  console.error(`Manifest not found: ${indexDir}`)
  process.exit(1)
}

function mib(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2))
}

function benchmarkSearch(label, mode, hashes, threshold) {
  let scanned = 0
  let candidates = 0
  let fallbacks = 0
  const startedAt = performance.now()

  for (let i = 0; i < rounds; i += 1) {
    const result = addon.searchByHash(hashes[i % hashes.length], threshold, 50, mode)
    scanned += result.scannedCount || 0
    candidates += result.candidateCount || 0
    fallbacks += result.fallbackUsed ? 1 : 0
  }

  const totalMs = performance.now() - startedAt
  return {
    label,
    mode,
    threshold,
    rounds,
    totalMs: Number(totalMs.toFixed(3)),
    averageMs: Number((totalMs / rounds).toFixed(4)),
    averageScanned: scanned / rounds,
    averageCandidates: candidates / rounds,
    fallbacks,
  }
}

function readSampleHashes(directory, sampleCount = 32) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  const segmentPath = path.join(directory, manifest.segments[0].file)
  const file = fs.openSync(segmentPath, 'r')
  try {
    const header = Buffer.alloc(80)
    fs.readSync(file, header, 0, header.length, 0)
    const recordCount = Number(header.readBigUInt64LE(8))
    const diffHashOffset = Number(header.readBigUInt64LE(56))
    const hashes = []
    for (let index = 0; index < sampleCount; index += 1) {
      const recordIndex = Math.floor((index * recordCount) / sampleCount)
      const value = Buffer.alloc(8)
      fs.readSync(file, value, 0, value.length, diffHashOffset + recordIndex * 8)
      hashes.push(value.readBigUInt64LE().toString(16).padStart(16, '0'))
    }
    return hashes
  } finally {
    fs.closeSync(file)
  }
}

const memoryBefore = process.memoryUsage()
const sampledHashes = readSampleHashes(indexDir)
const loadStartedAt = performance.now()
const loaded = addon.loadManifest(indexDir)
const loadMs = performance.now() - loadStartedAt
const memoryAfter = process.memoryUsage()

if (!loaded.ok) {
  console.error(JSON.stringify(loaded, null, 2))
  process.exit(1)
}

const report = {
  indexDir,
  load: {
    ...loaded,
    loadMs: Number(loadMs.toFixed(2)),
    rssDeltaMiB: mib(memoryAfter.rss - memoryBefore.rss),
    heapDeltaMiB: mib(memoryAfter.heapUsed - memoryBefore.heapUsed),
    externalDeltaMiB: mib(memoryAfter.external - memoryBefore.external),
  },
  index: addon.getIndexMode(),
  searches: [
    benchmarkSearch('zero-skew', 'fast', ['0000000000000000'], 10),
    benchmarkSearch('zero-skew', 'balanced', ['0000000000000000'], 10),
    benchmarkSearch('zero-skew', 'recall', ['0000000000000000'], 10),
    benchmarkSearch('sampled-index', 'fast', sampledHashes, 10),
    benchmarkSearch('sampled-index', 'balanced', sampledHashes, 10),
    benchmarkSearch('sampled-index', 'recall', sampledHashes, 10),
  ],
}

console.log(JSON.stringify(report, null, 2))
addon.clearIndex()
