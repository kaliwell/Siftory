#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { compareEmbeddingSnapshots } = require('./verify-embedding-provider-parity.cjs')

const projectRoot = path.resolve(__dirname, '..')
const benchmarkRoot = path.join(projectRoot, 'artifacts', 'benchmark', 'image-preparation-pipeline')
const automationRoot = path.join(projectRoot, 'artifacts', 'automation')
const DEFAULT_IMAGE_DATASET = process.env.SOURCE_AUDIT_DIR || ''
const GPU_ABSOLUTE_DELTA_BUDGET_MIB = 768
const GPU_BASELINE_GROWTH_BUDGET_MIB = 256
const GPU_DEVICE_USAGE_BUDGET_RATIO = 0.75

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function parseArgs(argv) {
  const defaultDataset = fs.existsSync(DEFAULT_IMAGE_DATASET) ? DEFAULT_IMAGE_DATASET : ''
  const dataset = option(argv, 'dataset', defaultDataset)
  return {
    dataset: dataset ? path.resolve(dataset) : '',
    sample: Math.max(4, Math.min(1000, Number(option(argv, 'sample', '16')) || 16)),
    runs: Math.max(3, Math.min(20, Number(option(argv, 'runs', '3')) || 3)),
    backend: option(argv, 'backend', 'gpu'),
    jobs: Math.max(1, Math.min(2, Number(option(argv, 'jobs', '2')) || 2)),
    batchSize: Math.max(1, Math.min(16, Number(option(argv, 'batch-size', '4')) || 4)),
    timeoutMs: Math.max(60_000, Number(option(argv, 'timeout-ms', '600000')) || 600_000),
    outDir: path.resolve(
      option(
        argv,
        'out-dir',
        path.join(
          projectRoot,
          'artifacts',
          'benchmark',
          'image-preparation-pipeline',
          timestampId(),
        ),
      ),
    ),
    skipAnalysis: argv.includes('--skip-analysis'),
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

function isStrictChild(root, directory) {
  const relative = path.relative(path.resolve(root), path.resolve(directory))
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function validateOutputDirectory(directory) {
  if (![benchmarkRoot, automationRoot].some((root) => isStrictChild(root, directory))) {
    throw new Error('Output directory must be a child of a managed benchmark artifact root')
  }
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/run-image-preparation-pipeline-ab.cjs [options]

Runs paired, order-alternated serial/overlap Image Search preparation in isolated userData.

Options:
  --dataset=<dir>       Fixed read-only image corpus
  --sample=<count>      Deterministic images per run (default: 16, max: 1000)
  --runs=<count>        Paired rounds (minimum/default: 3)
  --backend=cpu|gpu     Embedding backend (default: gpu)
  --jobs=1|2            Embedding workers (default: 2)
  --batch-size=1..16    Fixed comparable batch (default: 4)
  --timeout-ms=<n>      Child timeout (default: 600000)
  --out-dir=<dir>       De-identified report directory
  --skip-analysis       Leave detailed stage analysis to an outer orchestrator
`)
}

function runChild(scriptPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
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
      if (code === 0 && !timedOut) return resolve()
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
  const finite = values.map(Number).filter(Number.isFinite)
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

function pairedSummary(serialReports, overlapReports, field) {
  const serial = summarize(serialReports.map((report) => valueAt(report, field)))
  const overlap = summarize(overlapReports.map((report) => valueAt(report, field)))
  return {
    serial,
    overlap,
    p50ChangePercent:
      serial.p50 && overlap.p50
        ? Number((((overlap.p50 - serial.p50) / serial.p50) * 100).toFixed(2))
        : null,
  }
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

function embeddingSnapshot(report, model, provider) {
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
        embeddingSnapshot(serial, model, `serial-${round}`),
        embeddingSnapshot(overlap, model, `overlap-${round}`),
      ),
    ]),
  )
}

function compactRun(report) {
  return {
    pipeline: report.config.pipeline,
    phases: report.phases,
    resources: report.resources,
    counts: {
      native: report.scan.digest.count,
      dino: report.embeddingDigests.dino.count,
      clip: report.embeddingDigests.clip.count,
      index: report.vectorIndex.status.count,
    },
    digests: {
      native: report.scan.digest.sha256,
      dino: report.embeddingDigests.dino.stableSha256,
      clip: report.embeddingDigests.clip.stableSha256,
    },
    pipelineResult: report.pipeline?.result,
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
  return `# PREP-005 image preparation pipeline A/B

- Generated: ${report.generatedAt}
- Runs: ${report.config.runs} paired rounds (order alternated)
- Corpus: ${report.config.sample} deterministic read-only images
- Backend: ${report.config.backend}; jobs: ${report.config.jobs}; batch: ${report.config.batchSize}
- Serial ready P50/P95: ${ready.serial.p50}/${ready.serial.p95} ms
- Overlap ready P50/P95: ${ready.overlap.p50}/${ready.overlap.p95} ms
- P50 improvement: ${report.performance.p50ImprovementPercent}%
- Gate: **${report.gate.passed ? 'PASS' : 'FAIL'}**

| Phase | Serial P50 ms | Overlap P50 ms | Change |
| --- | ---: | ---: | ---: |
${phaseRows}

## Correctness and safety

- Native and embedding count parity: ${report.correctness.contentParity}
- DINO/CLIP cosine, absolute-error, and Top-10 parity: ${report.correctness.embeddingParity}
- Unchanged warm pass uses zero duplicate inference: ${report.correctness.warmZeroDuplicateInference}
- Final vector-index parity: ${report.correctness.vectorIndexParity}
- Commit-feed drops in overlap runs: ${report.correctness.commitFeedDropped}
- Source files unchanged: ${report.safety.sourceFilesUnchanged}
- Isolated userData only: ${report.safety.isolatedUserData}
- Ready is emitted only after scan persistence, complete DINO/CLIP coverage, revision fence, and vector-index commit.

## Gate details

${report.gate.failures.length ? report.gate.failures.map((failure) => `- ${failure}`).join('\n') : '- All PREP-005 gates passed.'}
`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return printHelp()
  if (!fs.existsSync(options.dataset) || !fs.statSync(options.dataset).isDirectory()) {
    throw new Error('Pass an existing fixed image corpus with --dataset=<dir>')
  }
  if (!['cpu', 'gpu'].includes(options.backend)) throw new Error('Use --backend=cpu or gpu')
  validateOutputDirectory(options.outDir)
  fs.mkdirSync(options.outDir, { recursive: true })
  const runner = path.join(projectRoot, 'tests', 'image-search-simple-e2e-benchmark.cjs')
  const reports = { serial: [], overlap: [] }

  for (let index = 0; index < options.runs; index += 1) {
    const round = index + 1
    const order = round % 2 === 1 ? ['serial', 'overlap'] : ['overlap', 'serial']
    for (const pipeline of order) {
      const outputPath = path.join(options.outDir, `round-${round}-${pipeline}.json`)
      const timelinePath = path.join(options.outDir, `round-${round}-${pipeline}.timeline.ndjson`)
      process.stderr.write(`[PREP-005] round ${round}/${options.runs}: ${pipeline}\n`)
      await runChild(
        runner,
        [
          options.dataset,
          `--pipeline=${pipeline}`,
          `--sample=${options.sample}`,
          `--backend=${options.backend}`,
          `--jobs=${options.jobs}`,
          `--batch-size=${options.batchSize}`,
          `--timeout-ms=${options.timeoutMs}`,
          `--json-out=${outputPath}`,
          `--timeline-out=${timelinePath}`,
          '--stage-metrics',
          '--defer-thumbnails',
          ...(pipeline === 'overlap' ? ['--verify-warm'] : []),
          '--compact',
        ],
        options.timeoutMs,
      )
      reports[pipeline].push(JSON.parse(fs.readFileSync(outputPath, 'utf8')))
    }
  }

  const pairedEmbeddingParity = reports.serial.map((serial, index) =>
    parityForPair(serial, reports.overlap[index], index + 1),
  )
  const embeddingParity = pairedEmbeddingParity.every((pair) => pair.dino.ok && pair.clip.ok)
  const contentParity = reports.serial.every((serial, index) => {
    const overlap = reports.overlap[index]
    return (
      serial.scan.digest.sha256 === overlap.scan.digest.sha256 &&
      serial.scan.digest.count === overlap.scan.digest.count &&
      serial.embeddingDigests.dino.count === overlap.embeddingDigests.dino.count &&
      serial.embeddingDigests.clip.count === overlap.embeddingDigests.clip.count
    )
  })
  const vectorIndexParity = reports.serial.every((serial, index) => {
    const overlap = reports.overlap[index]
    return (
      serial.vectorIndex.status.built === true &&
      overlap.vectorIndex.status.built === true &&
      serial.vectorIndex.status.count === overlap.vectorIndex.status.count &&
      serial.vectorIndex.status.dim === overlap.vectorIndex.status.dim
    )
  })
  const commitFeedDropped = reports.overlap.reduce(
    (total, report) => total + Number(report.pipeline?.result?.commitFeedDropped || 0),
    0,
  )
  const warmZeroDuplicateInference = reports.overlap.every(
    (report) =>
      report.warmVerification?.ok === true &&
      report.warmVerification.committedImages === 0 &&
      report.warmVerification.invalidatedImages === 0 &&
      report.warmVerification.embeddingRuns?.every(
        (run) =>
          run.streaming === false &&
          run.terminal?.completed === 0 &&
          run.terminal?.failed === 0 &&
          run.terminal?.skipped === options.sample,
      ),
  )
  const libraryReadyMs = pairedSummary(reports.serial, reports.overlap, 'phases.libraryReadyMs')
  const p50ImprovementPercent = Number(
    ((1 - libraryReadyMs.overlap.p50 / libraryReadyMs.serial.p50) * 100).toFixed(2),
  )
  const phases = Object.fromEntries(
    [
      'phases.imageScanMs',
      'phases.hashIndexSaveMs',
      'phases.vectorIndexBuildMs',
      'phases.verificationMs',
      'phases.libraryReadyMs',
    ].map((field) => [
      field.replace('phases.', ''),
      pairedSummary(reports.serial, reports.overlap, field),
    ]),
  )
  const resourceFields = [
    'resources.memory.mainPeakRssMiB',
    'resources.memory.childPeakAggregateRssMiBApprox',
    'resources.gpu.peakUsedMiB',
    'resources.gpu.peakDeltaUsedMiB',
    'resources.gpu.totalMiB',
    'resources.processes.spawned',
    'resources.processes.peakActive',
  ]
  const resources = Object.fromEntries(
    resourceFields.map((field) => [
      field.replace('resources.', ''),
      pairedSummary(reports.serial, reports.overlap, field),
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
  if (!contentParity) failures.push('Native or embedding count parity failed')
  if (!embeddingParity) failures.push('DINO/CLIP provider-parity thresholds failed')
  if (!vectorIndexParity) failures.push('final vector-index count/dimension parity failed')
  if (commitFeedDropped !== 0)
    failures.push(`native commit feed dropped ${commitFeedDropped} paths`)
  if (!warmZeroDuplicateInference)
    failures.push('unchanged warm pass performed duplicate inference')
  if (!sourceFilesUnchanged) failures.push('a source image changed during a measured run')
  if (!isolatedUserData) failures.push('a measured run escaped isolated userData')
  for (const phase of ['hashIndexSaveMs', 'vectorIndexBuildMs', 'verificationMs']) {
    const values = phases[phase]
    const allowance = Math.max(25, values.serial.p50 * 0.05)
    if (values.overlap.p50 - values.serial.p50 > allowance) {
      failures.push(`${phase} P50 regressed beyond max(5%, 25ms)`)
    }
  }
  for (const metric of ['memory.mainPeakRssMiB', 'memory.childPeakAggregateRssMiBApprox']) {
    const values = resources[metric]
    const allowance = Math.max(64, values.serial.p95 * 0.15)
    if (values.overlap.p95 - values.serial.p95 > allowance) {
      failures.push(`${metric} P95 exceeded the bounded memory allowance`)
    }
  }
  const gpuDelta = resources['gpu.peakDeltaUsedMiB']
  if (gpuDelta.overlap.max > GPU_ABSOLUTE_DELTA_BUDGET_MIB) {
    failures.push(`GPU delta exceeded ${GPU_ABSOLUTE_DELTA_BUDGET_MIB} MiB`)
  }
  if (gpuDelta.overlap.p95 - gpuDelta.serial.p95 > GPU_BASELINE_GROWTH_BUDGET_MIB) {
    failures.push(`GPU delta P95 grew by more than ${GPU_BASELINE_GROWTH_BUDGET_MIB} MiB`)
  }
  const peakGpuUsed = resources['gpu.peakUsedMiB'].overlap.max
  const minimumGpuCapacity = resources['gpu.totalMiB'].overlap.min
  if (peakGpuUsed / minimumGpuCapacity > GPU_DEVICE_USAGE_BUDGET_RATIO) {
    failures.push(`GPU peak used memory exceeded ${GPU_DEVICE_USAGE_BUDGET_RATIO * 100}%`)
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
      sample: options.sample,
      backend: options.backend,
      jobs: options.jobs,
      batchSize: options.batchSize,
      orderAlternated: true,
    },
    performance: { libraryReadyMs, p50ImprovementPercent, phases, resources },
    correctness: {
      contentParity,
      vectorIndexParity,
      embeddingParity,
      warmZeroDuplicateInference,
      pairedEmbeddingParity: pairedEmbeddingParity.map((pair) => ({
        dino: { ok: pair.dino.ok, metrics: pair.dino.metrics, failures: pair.dino.failures },
        clip: { ok: pair.clip.ok, metrics: pair.clip.metrics, failures: pair.clip.failures },
      })),
      commitFeedDropped,
    },
    safety: { sourceFilesUnchanged, isolatedUserData, realLibraryWritten: false },
    gate: {
      passed: failures.length === 0,
      failures,
      budgets: {
        minimumP50ImprovementPercent: 10,
        nonParticipatingPhaseRegressionPercent: 5,
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
  if (!options.skipAnalysis) {
    const analyzer = path.join(projectRoot, 'scripts', 'analyze-image-preparation-stages.cjs')
    const analyzed = spawnSync(process.execPath, [analyzer, `--dir=${options.outDir}`], {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
    })
    if (analyzed.status !== 0) {
      throw new Error(
        `Detailed stage analysis failed: ${String(analyzed.stderr || analyzed.stdout || '').trim()}`,
      )
    }
  }
  if (isStrictChild(benchmarkRoot, options.outDir)) {
    const latestPath = path.join(benchmarkRoot, 'latest.json')
    fs.mkdirSync(path.dirname(latestPath), { recursive: true })
    fs.writeFileSync(
      latestPath,
      `${JSON.stringify(
        {
          generatedAt: report.generatedAt,
          reportDirectory: path.basename(options.outDir),
          reportFile: path.relative(projectRoot, jsonPath).split(path.sep).join('/'),
          markdownFile: path.relative(projectRoot, markdownPath).split(path.sep).join('/'),
          stageAnalysisJson: options.skipAnalysis
            ? null
            : path
                .relative(projectRoot, path.join(options.outDir, 'stage-analysis.json'))
                .split(path.sep)
                .join('/'),
          stageAnalysisMarkdown: options.skipAnalysis
            ? null
            : path
                .relative(projectRoot, path.join(options.outDir, 'stage-analysis.md'))
                .split(path.sep)
                .join('/'),
          gate: report.gate,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: report.gate.passed,
        outputDirectory: options.outDir,
        serialLibraryReadyMs: libraryReadyMs.serial,
        overlapLibraryReadyMs: libraryReadyMs.overlap,
        p50ImprovementPercent,
        detailedStageAnalysis: options.skipAnalysis
          ? { delegated: true, timelines: options.runs * 2 }
          : {
              json: path.join(options.outDir, 'stage-analysis.json'),
              markdown: path.join(options.outDir, 'stage-analysis.md'),
              timelines: options.runs * 2,
            },
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

module.exports = { isStrictChild, pairedSummary, parseArgs, validateOutputDirectory }
