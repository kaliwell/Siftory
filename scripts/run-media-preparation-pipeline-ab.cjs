#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { compareEmbeddingSnapshots } = require('./verify-embedding-provider-parity.cjs')

const projectRoot = path.resolve(__dirname, '..')
const benchmarkRoot = path.join(projectRoot, 'artifacts', 'benchmark', 'media-preparation-pipeline')
const GPU_ABSOLUTE_DELTA_BUDGET_MIB = 768
const GPU_BASELINE_GROWTH_BUDGET_MIB = 256
const GPU_DEVICE_USAGE_BUDGET_RATIO = 0.75

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function isStrictChild(root, directory) {
  const relative = path.relative(path.resolve(root), path.resolve(directory))
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function parseArgs(argv) {
  const stamp = timestampId()
  return {
    runs: Math.max(3, Math.min(20, Number(option(argv, 'runs', '3')) || 3)),
    backend: option(argv, 'backend', 'gpu'),
    jobs: Math.max(1, Math.min(2, Number(option(argv, 'jobs', '2')) || 2)),
    batchSize: Math.max(1, Math.min(16, Number(option(argv, 'batch-size', '4')) || 4)),
    fixtureCfrSeconds: Math.max(
      30,
      Math.min(120, Number(option(argv, 'fixture-cfr-seconds', '120')) || 120),
    ),
    fixtureVfrSeconds: Math.max(
      30,
      Math.min(120, Number(option(argv, 'fixture-vfr-seconds', '90')) || 90),
    ),
    intervalMs: Math.max(1_000, Number(option(argv, 'interval-ms', '3000')) || 3_000),
    width: Math.max(128, Math.min(960, Number(option(argv, 'width', '256')) || 256)),
    timeoutMs: Math.max(60_000, Number(option(argv, 'timeout-ms', '1800000')) || 1_800_000),
    outDir: path.resolve(
      option(
        argv,
        'out-dir',
        path.join(projectRoot, 'artifacts', 'benchmark', 'media-preparation-pipeline', stamp),
      ),
    ),
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/run-media-preparation-pipeline-ab.cjs [options]

Runs paired, order-alternated serial/overlap preparation against deterministic CFR, VFR,
and damaged fixtures. Every child uses isolated userData and verifies source immutability.

Options:
  --runs=<count>                 Paired rounds (minimum/default: 3)
  --backend=cpu|gpu              Embedding backend (default: gpu)
  --jobs=1|2                     Embedding workers (default: 2)
  --batch-size=1..16             Fixed comparable batch (default: 4)
  --fixture-cfr-seconds=<n>      CFR fixture duration (default: 120)
  --fixture-vfr-seconds=<n>      VFR fixture duration (default: 90)
  --interval-ms=<n>              Fixed frame interval (default: 3000)
  --width=<pixels>               Fixed frame width (default: 256)
  --timeout-ms=<n>               Child timeout (default: 1800000)
  --out-dir=<dir>                De-identified report directory
`)
}

function runChild(scriptPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.length > 2 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && !timedOut) return resolve({ stdout, stderr })
      reject(
        new Error(
          `${path.basename(scriptPath)} failed (${timedOut ? 'timeout' : (code ?? signal)})\n${stderr.slice(-12_000)}`,
        ),
      )
    })
  })
}

function percentile(values, percentileValue) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)]
}

function summarize(values) {
  const finite = values
    .filter((value) => value !== null && value !== undefined)
    .map(Number)
    .filter(Number.isFinite)
  return {
    samples: finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    min: finite.length ? Math.min(...finite) : null,
    max: finite.length ? Math.max(...finite) : null,
  }
}

function valueAt(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => current?.[key], value)
}

function pairedPhaseSummary(serialReports, overlapReports, phase) {
  const serial = summarize(serialReports.map((report) => Number(report.phases?.[phase])))
  const overlap = summarize(overlapReports.map((report) => Number(report.phases?.[phase])))
  return {
    serial,
    overlap,
    p50ChangePercent:
      serial.p50 && overlap.p50
        ? Number((((overlap.p50 - serial.p50) / serial.p50) * 100).toFixed(2))
        : null,
  }
}

function writeLatestPointer(options, report, jsonPath, markdownPath, dependencies = {}) {
  const managedBenchmarkRoot = path.resolve(dependencies.benchmarkRoot || benchmarkRoot)
  if (!isStrictChild(managedBenchmarkRoot, options.outDir)) return null

  const managedProjectRoot = path.resolve(dependencies.projectRoot || projectRoot)
  const latestPath = path.join(managedBenchmarkRoot, 'latest.json')
  fs.mkdirSync(path.dirname(latestPath), { recursive: true })
  fs.writeFileSync(
    latestPath,
    `${JSON.stringify(
      {
        generatedAt: report.generatedAt,
        reportDirectory: path.basename(options.outDir),
        reportFile: path.relative(managedProjectRoot, jsonPath).split(path.sep).join('/'),
        markdownFile: path.relative(managedProjectRoot, markdownPath).split(path.sep).join('/'),
        gate: report.gate,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return latestPath
}

function snapshot(report, model, provider) {
  const samples = report.embeddingComparison?.[model]
  return {
    schemaVersion: 1,
    model: model === 'dino' ? 'dinov2_vitb14' : 'clip_vit_base_patch32',
    provider,
    samples,
    dimension: samples?.[0]?.vector?.length,
  }
}

function parityForPair(serial, overlap, round) {
  return Object.fromEntries(
    ['dino', 'clip'].map((model) => [
      model,
      compareEmbeddingSnapshots(
        snapshot(serial, model, `serial-${round}`),
        snapshot(overlap, model, `overlap-${round}`),
      ),
    ]),
  )
}

function getGitMetadata() {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  const dirty = spawnSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    head: String(head.stdout || '').trim() || 'unknown',
    dirty: Boolean(String(dirty.stdout || '').trim()),
  }
}

function compactRun(report) {
  return {
    pipeline: report.config.pipeline,
    phases: report.phases,
    resources: report.resources,
    frames: {
      total: report.frames.total,
      completed: report.frames.completed,
      failed: report.frames.failed,
      unavailable: report.frames.unavailable,
      digest: report.frames.digest.sha256,
    },
    digests: {
      scan: report.scan.digest.sha256,
      dinoStable: report.embeddingDigests.dino.stableSha256,
      clipStable: report.embeddingDigests.clip.stableSha256,
      dinoIndexStable: report.frameIndex.dino.stableSha256,
      clipIndexStable: report.frameIndex.clip.stableSha256,
    },
  }
}

function renderMarkdown(report) {
  const ready = report.performance.libraryReadyMs
  const phaseRows = Object.entries(report.performance.phases)
    .map(
      ([phase, values]) =>
        `| ${phase} | ${values.serial.p50 ?? '-'} | ${values.overlap.p50 ?? '-'} | ${values.p50ChangePercent ?? '-'}% |`,
    )
    .join('\n')
  return `# PREP-003 media preparation pipeline A/B

- Generated: ${report.generatedAt}
- Runs: ${report.config.runs} paired rounds (order alternated)
- Corpus: deterministic CFR ${report.config.fixtureCfrSeconds}s + VFR ${report.config.fixtureVfrSeconds}s + damaged input
- Backend: ${report.config.backend}; jobs: ${report.config.jobs}; batch: ${report.config.batchSize}
- Serial ready P50/P95: ${ready.serial.p50}/${ready.serial.p95} ms
- Overlap ready P50/P95: ${ready.overlap.p50}/${ready.overlap.p95} ms
- P50 improvement: ${report.performance.p50ImprovementPercent}%
- Gate: **${report.gate.passed ? 'PASS' : 'FAIL'}**

| Phase | Serial P50 ms | Overlap P50 ms | Change |
| --- | ---: | ---: | ---: |
${phaseRows}

## Correctness and safety

- Frame/scan/count parity: ${report.correctness.manifestParity}
- Embedding provider-parity gate: ${report.correctness.embeddingParity}
- Source files unchanged: ${report.safety.sourceFilesUnchanged}
- Isolated userData only: ${report.safety.isolatedUserData}
- GPU gate: overlap delta <= ${report.gate.budgets.gpuAbsoluteDeltaMiB} MiB; growth versus serial <= ${report.gate.budgets.gpuGrowthVersusSerialMiB} MiB; device usage <= ${report.gate.budgets.gpuDeviceUsageRatio * 100}%
- No premature ready milestone: covered by automated pipeline tests and final index/coverage assertions in every run.

## Gate details

${report.gate.failures.length ? report.gate.failures.map((failure) => `- ${failure}`).join('\n') : '- All PREP-003 gates passed.'}
`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  if (!['cpu', 'gpu'].includes(options.backend)) throw new Error('Use --backend=cpu or gpu')
  fs.mkdirSync(options.outDir, { recursive: true })
  const runner = path.join(projectRoot, 'tests', 'media-search-library-preparation-benchmark.cjs')
  const reports = { serial: [], overlap: [] }

  for (let index = 0; index < options.runs; index += 1) {
    const round = index + 1
    const order = round % 2 === 1 ? ['serial', 'overlap'] : ['overlap', 'serial']
    for (const pipeline of order) {
      const outputPath = path.join(options.outDir, `round-${round}-${pipeline}.json`)
      process.stderr.write(`[PREP-003] round ${round}/${options.runs}: ${pipeline}\n`)
      await runChild(
        runner,
        [
          `--pipeline=${pipeline}`,
          `--backend=${options.backend}`,
          `--jobs=${options.jobs}`,
          `--batch-size=${options.batchSize}`,
          `--fixture-cfr-seconds=${options.fixtureCfrSeconds}`,
          `--fixture-vfr-seconds=${options.fixtureVfrSeconds}`,
          `--interval-ms=${options.intervalMs}`,
          '--max-frames-per-video=3600',
          `--width=${options.width}`,
          `--timeout-ms=${options.timeoutMs}`,
          `--json-out=${outputPath}`,
          '--compact',
        ],
        options.timeoutMs,
      )
      reports[pipeline].push(JSON.parse(fs.readFileSync(outputPath, 'utf8')))
    }
  }

  const pairedParity = reports.serial.map((serial, index) =>
    parityForPair(serial, reports.overlap[index], index + 1),
  )
  const manifestParity = reports.serial.every((serial, index) => {
    const overlap = reports.overlap[index]
    return (
      serial.scan.digest.sha256 === overlap.scan.digest.sha256 &&
      serial.frames.digest.sha256 === overlap.frames.digest.sha256 &&
      serial.frames.total === overlap.frames.total &&
      serial.frames.completed === overlap.frames.completed &&
      serial.frames.failed === overlap.frames.failed &&
      serial.frames.unavailable === overlap.frames.unavailable &&
      serial.frameIndex.result.entries === overlap.frameIndex.result.entries &&
      serial.frameIndex.result.errors === overlap.frameIndex.result.errors
    )
  })
  const embeddingParity = pairedParity.every((pair) => pair.dino.ok && pair.clip.ok)
  const libraryReadyMs = pairedPhaseSummary(reports.serial, reports.overlap, 'libraryReadyMs')
  const p50ImprovementPercent = Number(
    ((1 - libraryReadyMs.overlap.p50 / libraryReadyMs.serial.p50) * 100).toFixed(2),
  )
  const monitoredPhases = ['scanAndVideoManifestCommitMs', 'frameIndexCommitMs', 'verificationMs']
  const phases = Object.fromEntries(
    [
      'frameExtractionAndManifestCommitMs',
      ...monitoredPhases,
      'libraryReadyMs',
      'workflowReadySignalMs',
    ].map((phase) => [phase, pairedPhaseSummary(reports.serial, reports.overlap, phase)]),
  )
  const resourceMetrics = [
    'memory.mainPeakRssMiB',
    'memory.childPeakAggregateRssMiBApprox',
    'gpu.peakUsedMiB',
    'gpu.peakDeltaUsedMiB',
    'gpu.totalMiB',
    'processes.spawned',
    'processes.peakActive',
  ]
  const resources = Object.fromEntries(
    resourceMetrics.map((metric) => [
      metric,
      {
        serial: summarize(
          reports.serial.map((report) => Number(valueAt(report.resources, metric))),
        ),
        overlap: summarize(
          reports.overlap.map((report) => Number(valueAt(report.resources, metric))),
        ),
      },
    ]),
  )
  const sourceFilesUnchanged = [...reports.serial, ...reports.overlap].every(
    (report) => report.safety.sourceUnchanged === true,
  )
  const isolatedUserData = [...reports.serial, ...reports.overlap].every(
    (report) => report.safety.isolatedUserData === true,
  )
  const failures = []
  if (p50ImprovementPercent < 10) {
    failures.push(`library-ready P50 improvement ${p50ImprovementPercent}% is below 10%`)
  }
  if (!manifestParity) failures.push('scan/frame/count/index parity failed')
  if (!embeddingParity) failures.push('embedding cosine/absolute-error/top-10 parity failed')
  if (!sourceFilesUnchanged) failures.push('a source fixture changed during a measured run')
  if (!isolatedUserData) failures.push('a measured run escaped isolated userData')
  for (const phase of monitoredPhases) {
    const values = phases[phase]
    const toleranceMs = Math.max(25, values.serial.p50 * 0.03)
    if (values.overlap.p50 - values.serial.p50 > toleranceMs) {
      failures.push(`${phase} P50 regressed by more than max(3%, 25ms)`)
    }
  }
  for (const metric of ['memory.mainPeakRssMiB', 'memory.childPeakAggregateRssMiBApprox']) {
    const values = resources[metric]
    const allowance = Math.max(32, values.serial.p95 * 0.1)
    if (values.overlap.p95 - values.serial.p95 > allowance) {
      failures.push(`${metric} P95 exceeded the bounded memory allowance`)
    }
  }
  const gpuDelta = resources['gpu.peakDeltaUsedMiB']
  const peakGpuDelta = gpuDelta.overlap.max
  if (peakGpuDelta !== null && peakGpuDelta > GPU_ABSOLUTE_DELTA_BUDGET_MIB) {
    failures.push(
      `GPU used-memory delta ${peakGpuDelta} MiB exceeded the ${GPU_ABSOLUTE_DELTA_BUDGET_MIB} MiB gate`,
    )
  }
  if (
    gpuDelta.serial.p95 !== null &&
    gpuDelta.overlap.p95 !== null &&
    gpuDelta.overlap.p95 - gpuDelta.serial.p95 > GPU_BASELINE_GROWTH_BUDGET_MIB
  ) {
    failures.push(
      `GPU used-memory P95 grew by more than ${GPU_BASELINE_GROWTH_BUDGET_MIB} MiB versus serial`,
    )
  }
  const peakGpuUsed = resources['gpu.peakUsedMiB'].overlap.max
  const minimumGpuCapacity = resources['gpu.totalMiB'].overlap.min
  if (
    peakGpuUsed !== null &&
    minimumGpuCapacity !== null &&
    peakGpuUsed / minimumGpuCapacity > GPU_DEVICE_USAGE_BUDGET_RATIO
  ) {
    failures.push(
      `GPU peak used memory exceeded ${GPU_DEVICE_USAGE_BUDGET_RATIO * 100}% of device capacity`,
    )
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      node: process.version,
      cpuModel: os.cpus()[0]?.model || 'unknown',
      logicalProcessors: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      git: getGitMetadata(),
    },
    config: {
      runs: options.runs,
      backend: options.backend,
      jobs: options.jobs,
      batchSize: options.batchSize,
      fixtureCfrSeconds: options.fixtureCfrSeconds,
      fixtureVfrSeconds: options.fixtureVfrSeconds,
      intervalMs: options.intervalMs,
      width: options.width,
      orderAlternated: true,
    },
    performance: {
      libraryReadyMs: {
        serial: libraryReadyMs.serial,
        overlap: libraryReadyMs.overlap,
      },
      p50ImprovementPercent,
      phases,
      resources,
    },
    correctness: {
      manifestParity,
      embeddingParity,
      pairedEmbeddingParity: pairedParity.map((pair) => ({
        dino: { ok: pair.dino.ok, metrics: pair.dino.metrics, failures: pair.dino.failures },
        clip: { ok: pair.clip.ok, metrics: pair.clip.metrics, failures: pair.clip.failures },
      })),
    },
    safety: {
      sourceFilesUnchanged,
      isolatedUserData,
      realLibraryWritten: false,
    },
    gate: {
      passed: failures.length === 0,
      failures,
      budgets: {
        minimumP50ImprovementPercent: 10,
        nonParticipatingPhaseRegressionPercent: 3,
        gpuAbsoluteDeltaMiB: GPU_ABSOLUTE_DELTA_BUDGET_MIB,
        gpuGrowthVersusSerialMiB: GPU_BASELINE_GROWTH_BUDGET_MIB,
        gpuDeviceUsageRatio: GPU_DEVICE_USAGE_BUDGET_RATIO,
      },
    },
    runs: {
      serial: reports.serial.map(compactRun),
      overlap: reports.overlap.map(compactRun),
    },
  }
  const jsonPath = path.join(options.outDir, 'report.json')
  const markdownPath = path.join(options.outDir, 'report.md')
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  fs.writeFileSync(markdownPath, renderMarkdown(report), 'utf8')
  writeLatestPointer(options, report, jsonPath, markdownPath)
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: report.gate.passed,
        outputDirectory: options.outDir,
        serialLibraryReadyMs: report.performance.libraryReadyMs.serial,
        overlapLibraryReadyMs: report.performance.libraryReadyMs.overlap,
        p50ImprovementPercent,
        correctness: report.correctness,
        safety: report.safety,
        failures,
      },
      null,
      2,
    )}\n`,
  )
  if (!report.gate.passed) process.exitCode = 1
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = { isStrictChild, pairedPhaseSummary, parseArgs, writeLatestPointer }
