// Phase 0 baseline benchmark runner ("freeze boundaries and establish baselines").
// Orchestrates the existing native scanner benchmark surface instead of
// reimplementing it, and writes a redacted raw JSON report to benchmarks/
// (artifacts/ is blocked by git-preflight for tracked files).
//
// Usage:
//   node scripts/run-phase0-baseline.cjs [--count=100000] [--fresh] [--skip-embedding]
//     [--skip-thumbnails] [--keep-corpus] [--embedding-timeout-ms=300000] [--output=<path>]
//
// The synthetic corpus is generated OUTSIDE the repository (default %TEMP%/phase0-corpus-100k)
// by scripts/create-synthetic-corpus.cjs so it can never be git-tracked.

const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const REPO = path.resolve(__dirname, '..')
const ADDON_PATH = path.join(REPO, 'native', 'build', 'Release', 'fast_scanner.node')
const FIXTURE_FACES = path.join(REPO, 'tests', 'fixtures', 'faces')
const { removeManagedPhase0Target } = require('./cleanup-phase0-temp.cjs')

function option(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const corpusCount = Math.max(1, Number(option('count', '100000')) || 100000)
const explicitCorpusRoot = process.argv.some((value) => value.startsWith('--corpus-root='))
const corpusRoot = path.resolve(
  option(
    'corpus-root',
    path.join(os.tmpdir(), `phase0-corpus-${Math.max(1, Math.round(corpusCount / 1000))}k`),
  ),
)
const fresh = process.argv.includes('--fresh')
const keepCorpus = process.argv.includes('--keep-corpus')
const skipEmbedding = process.argv.includes('--skip-embedding')
const skipThumbnails = process.argv.includes('--skip-thumbnails')
const embeddingTimeoutMs = Math.max(
  60_000,
  Number(option('embedding-timeout-ms', '300000')) || 300_000,
)
const dateStamp = new Date().toISOString().slice(0, 10)
const outputPath = path.resolve(
  option('output', path.join(REPO, 'benchmarks', `phase0-baseline-${dateStamp}.json`)),
)

// ---------- helpers ----------

// The privacy hook rejects tracked files containing real user directories.
// Redact any user-profile path segment before the report leaves the machine.
function redact(value) {
  const text = JSON.stringify(value)
  const redacted = text.replace(/([A-Za-z]:[\\/]{1,2}Users[\\/]{1,2})[^\\/\s"'`]+/g, '$1<user>')
  return JSON.parse(redacted)
}

function runPowerShell(script) {
  try {
    const stdout = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 30_000 },
    )
    const parsed = JSON.parse(stdout.trim() || 'null')
    return parsed
  } catch (error) {
    return { error: String(error.message || error) }
  }
}

function collectEnvironment() {
  const disks = runPowerShell(
    'Get-PhysicalDisk | Select-Object DeviceId,FriendlyName,MediaType,BusType,Size,HealthStatus | ConvertTo-Json -Compress',
  )
  const volumes = runPowerShell(
    'Get-Volume | Where-Object {$_.DriveLetter} | Select-Object DriveLetter,FileSystemType,FileSystemLabel,Size,SizeRemaining | ConvertTo-Json -Compress',
  )
  return {
    platform: `${os.platform()} ${os.arch()}`,
    osRelease: os.release(),
    node: process.version,
    cpu: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
    logicalProcessors: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    physicalDisks: disks,
    volumes,
    corpusDrive: path.parse(corpusRoot).root,
  }
}

function waitForScan(addon, timeoutMs, onPoll) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const progress = addon.getScanProgress()
    if (onPoll) onPoll(progress)
    if (progress.state !== 'scanning') return progress
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
  addon.stopScan()
  throw new Error(`scan timed out after ${timeoutMs}ms`)
}

function scanOnce(addon, root, mode, timeoutMs, onPoll) {
  addon.clearIndex()
  const started = performance.now()
  const begin = addon.scanDirectory(root, mode)
  if (!begin.ok) throw new Error(begin.error || `scan did not start (mode=${mode})`)
  const progress = waitForScan(addon, timeoutMs, onPoll)
  const wallMs = performance.now() - started
  return { progress, wallMs: Number(wallMs.toFixed(1)) }
}

function summarizeScan(label, mode, { progress, wallMs }, extra = {}) {
  return {
    label,
    mode,
    backend: progress.backend,
    fallbackCode: progress.fallbackCode || null,
    fallbackReason: progress.fallbackReason || null,
    indexedCount: progress.indexedCount,
    failedCount: progress.failedCount,
    totalBytes: progress.totalBytes,
    wallMs,
    totalScanMs: progress.totalScanMs || progress.durationMs,
    enumMs: progress.enumMs,
    statMs: progress.statMs,
    decodeMsTotal: progress.decodeMsTotal,
    hashMsTotal: progress.hashMsTotal,
    enumDirCount: progress.enumDirCount,
    enumFileCount: progress.enumFileCount,
    enumImageCount: progress.enumImageCount,
    usnReadMs: progress.usnReadMs,
    usnRecordsRead: progress.usnRecordsRead,
    filesPerSecond:
      progress.indexedCount > 0 ? Number((progress.indexedCount / (wallMs / 1000)).toFixed(1)) : 0,
    ...extra,
  }
}

// ---------- benchmark steps ----------

function ensureCorpus() {
  if (!fresh && fs.existsSync(corpusRoot)) {
    const probe = path.join(corpusRoot, 'g0')
    if (fs.existsSync(probe)) return { reused: true, root: corpusRoot }
  }
  const result = spawnSync(
    process.execPath,
    [
      path.join(REPO, 'scripts', 'create-synthetic-corpus.cjs'),
      `--count=${corpusCount}`,
      `--root=${corpusRoot}`,
      '--clean',
    ],
    { encoding: 'utf8', timeout: 15 * 60 * 1000 },
  )
  if (result.status !== 0) {
    throw new Error(`corpus generation failed: ${result.stderr || result.stdout}`)
  }
  return { reused: false, ...JSON.parse(result.stdout.trim()) }
}

// The thumbnail pipeline only accepts JPEG sources (native/thumbnail_sidecar.h
// try_enqueue -> is_jpeg_path). Build a small JPEG subset from the repo's
// desensitized face fixtures, made unique with appended counter bytes
// (decoders stop at EOI, so trailing bytes keep the files valid).
function ensureJpegSubset(size = 500) {
  const subsetDir = path.join(os.tmpdir(), 'phase0-jpeg-subset')
  fs.rmSync(subsetDir, { recursive: true, force: true })
  fs.mkdirSync(subsetDir, { recursive: true })
  const fixtures = fs
    .readdirSync(FIXTURE_FACES)
    .filter((name) => /\.jpe?g$/i.test(name))
    .map((name) => fs.readFileSync(path.join(FIXTURE_FACES, name)))
  for (let i = 0; i < size; i += 1) {
    const base = fixtures[i % fixtures.length]
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64LE(BigInt(i))
    fs.writeFileSync(
      path.join(subsetDir, `photo_${String(i).padStart(4, '0')}.jpg`),
      Buffer.concat([base, counter]),
    )
  }
  return { dir: subsetDir, files: size }
}

function benchmarkDiscovery(addon) {
  // metaOnly forces the Win32 enumeration backend (USN is skipped for metaOnly/decodeOnly),
  // which isolates pure path+size discovery.
  let firstPathMs = null
  const startedAt = performance.now()
  const result = scanOnce(addon, corpusRoot, 'metaOnly', 10 * 60 * 1000, (progress) => {
    if (firstPathMs === null && progress.indexedCount > 0) {
      firstPathMs = Number((performance.now() - startedAt).toFixed(1))
    }
  })
  return summarizeScan('discovery-metaonly-enum', 'metaOnly', result, { firstPathMs })
}

function benchmarkFullDiscovery(addon) {
  // 'full' attempts USN first and falls back to Win32 enumeration automatically;
  // the backend/fallback fields in the report record which path was taken.
  const result = scanOnce(addon, corpusRoot, 'full', 10 * 60 * 1000)
  return summarizeScan('discovery-full-usn-or-fallback', 'full', result)
}

function benchmarkThumbnails(addon) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-thumbs-'))
  const subset = ensureJpegSubset(500)
  try {
    addon.configureScanThumbnails(cacheDir, true, 6)
    const result = scanOnce(addon, subset.dir, 'full', 10 * 60 * 1000)
    // Wait for the asynchronous thumbnail sidecar queue to drain.
    const drainStartedAt = Date.now()
    const deadline = drainStartedAt + 5 * 60 * 1000
    let progress = result.progress
    while (Date.now() < deadline) {
      progress = addon.getScanProgress()
      if (progress.thumbnailPending === 0) break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
    const drainWaitMs = Date.now() - drainStartedAt
    const totalMsWithDrain = result.wallMs + drainWaitMs
    return {
      subsetFiles: progress.indexedCount,
      subsetSource: 'tests/fixtures/faces jpg variants (desensitized real assets)',
      thumbnailCompleted: progress.thumbnailCompleted,
      thumbnailFailed: progress.thumbnailFailed,
      thumbnailDropped: progress.thumbnailDropped,
      wallMs: result.wallMs,
      drainWaitMs,
      totalMsWithDrain,
      avgMsPerThumbnail:
        progress.thumbnailCompleted > 0
          ? Number((totalMsWithDrain / progress.thumbnailCompleted).toFixed(3))
          : null,
    }
  } finally {
    addon.configureScanThumbnails('', false, 6)
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
}

function benchmarkHashMicro(addon) {
  const fixtures = fs
    .readdirSync(FIXTURE_FACES)
    .filter((name) => /\.jpe?g$/i.test(name))
    .map((name) => path.join(FIXTURE_FACES, name))
  const samples = []
  for (const file of fixtures) {
    const rounds = 20
    const started = performance.now()
    let last = null
    for (let i = 0; i < rounds; i += 1) last = addon.hashImage(file)
    const totalMs = performance.now() - started
    samples.push({
      file: path.basename(file),
      bytes: fs.statSync(file).size,
      rounds,
      avgMs: Number((totalMs / rounds).toFixed(3)),
      diffHash: last && last.diffHash64 ? String(last.diffHash64) : null,
    })
  }
  return { rounds: 20, samples }
}

function benchmarkSearch(addon) {
  // Reuse the existing native benchmark: persist the in-memory index built by the
  // full discovery scan, then run tests/native-benchmark.cjs against it.
  const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-index-'))
  try {
    const saved = addon.saveIndexToManifest(indexDir)
    if (!saved.ok) return { skipped: true, reason: saved.error || 'saveIndexToManifest failed' }
    const result = spawnSync(
      process.execPath,
      [path.join(REPO, 'tests', 'native-benchmark.cjs'), indexDir, '100'],
      { encoding: 'utf8', timeout: 10 * 60 * 1000 },
    )
    if (result.status !== 0) {
      return {
        skipped: true,
        reason: `native-benchmark failed: ${result.stderr || result.stdout}`.slice(0, 500),
      }
    }
    return JSON.parse(result.stdout.trim())
  } finally {
    // The addon keeps saved segments mmap'd in this process; on Windows that makes
    // synchronous deletion fail with EPERM. Clean up best-effort via a detached
    // delayed rmdir so the report is never lost to cleanup failure.
    try {
      fs.rmSync(indexDir, { recursive: true, force: true })
    } catch {
      spawnSync(
        'cmd.exe',
        [
          '/c',
          'start',
          '/min',
          'cmd.exe',
          '/c',
          `ping 127.0.0.1 -n 3 >nul & rmdir /s /q "${indexDir}"`,
        ],
        {
          detached: true,
          stdio: 'ignore',
        },
      )
    }
  }
}

function benchmarkEmbedding() {
  if (skipEmbedding) return { skipped: true, reason: '--skip-embedding' }
  const dataset = path.join(os.tmpdir(), 'phase0-jpeg-subset')
  if (!fs.existsSync(dataset)) ensureJpegSubset(500)
  const result = spawnSync(
    process.execPath,
    [
      path.join(REPO, 'tests', 'image-search-simple-embedding-benchmark.cjs'),
      dataset,
      '--models=dino',
      '--batch-sizes=4',
      '--sample=16',
      '--backend=cpu',
    ],
    { encoding: 'utf8', timeout: embeddingTimeoutMs, killSignal: 'SIGTERM' },
  )
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (result.status !== 0) {
    return {
      skipped: true,
      reason: `embedding benchmark failed (status=${result.status}, signal=${result.signal || 'none'})`,
      tail: output.slice(-800),
    }
  }
  const stdout = (result.stdout || '').trim()
  const jsonStart = stdout.indexOf('{')
  if (jsonStart >= 0) {
    try {
      return JSON.parse(stdout.slice(jsonStart))
    } catch {
      // fall through to raw capture
    }
  }
  return { raw: output.slice(-2000) }
}

// ---------- main ----------

function main() {
  const report = {
    phase: 'phase0-discovery-baseline',
    generatedAt: new Date().toISOString(),
    corpusCount,
    corpusRoot,
    environment: collectEnvironment(),
  }
  console.log('[phase0] environment collected')

  report.corpus = ensureCorpus()
  console.log(
    `[phase0] corpus ready (${report.corpus.reused ? 'reused' : 'generated'}: ${corpusRoot})`,
  )

  const addon = require(ADDON_PATH)
  report.nativeVersion = addon.getNativeVersion()
  try {
    report.usnAvailability = addon.checkUsnAvailability(corpusRoot)
  } catch (error) {
    report.usnAvailability = { error: String(error.message || error) }
  }

  report.discovery = benchmarkDiscovery(addon)
  console.log(
    `[phase0] discovery(metaOnly/enum): ${report.discovery.wallMs}ms, ${report.discovery.indexedCount} files`,
  )

  report.fullDiscovery = benchmarkFullDiscovery(addon)
  console.log(
    `[phase0] discovery(full, backend=${report.fullDiscovery.backend}): ${report.fullDiscovery.wallMs}ms`,
  )

  report.thumbnails = skipThumbnails
    ? { skipped: true, reason: '--skip-thumbnails' }
    : benchmarkThumbnails(addon)
  console.log('[phase0] thumbnails done')

  report.hashMicro = benchmarkHashMicro(addon)
  console.log('[phase0] hash micro-benchmark done')

  report.search = benchmarkSearch(addon)
  console.log('[phase0] search benchmark done')

  report.embedding = benchmarkEmbedding()
  console.log('[phase0] embedding benchmark done')

  addon.stopScan()
  addon.clearIndex()

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(redact(report), null, 2)}\n`)
  console.log(`[phase0] report written: ${outputPath}`)
}

try {
  main()
} finally {
  if (!keepCorpus && !explicitCorpusRoot) {
    const cleanup = removeManagedPhase0Target(os.tmpdir(), corpusRoot)
    if (cleanup.deleted || cleanup.missing) {
      console.log(`[phase0] temporary corpus removed: ${corpusRoot}`)
    } else {
      console.warn(`[phase0] temporary corpus cleanup refused: ${cleanup.reason || 'unknown'}`)
    }
  }
}
