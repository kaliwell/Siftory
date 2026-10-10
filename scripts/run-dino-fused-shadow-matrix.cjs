const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const {
  collectRuntimeMemoryPreflight,
  evaluateRuntimeMemoryPreflight,
  pairedOrderForRound,
  resolveAcceptedGpuBaseline,
} = require('./runtime-memory-preflight.cjs')

const projectRoot = path.resolve(__dirname, '..')
const GIB = 1024 ** 3

function option(argv, name, fallback) {
  const prefix = `--${name}=`
  const value = argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  return value === undefined ? fallback : value
}

function parseArgs(argv, root = projectRoot) {
  for (const entry of argv) {
    if (entry !== '--formal' && !/^--(?:dataset|output-dir|runs|sample)=/.test(entry)) {
      throw new Error(`Unknown DINO fused matrix argument: ${entry}`)
    }
  }
  const datasetArgument = option(argv, 'dataset', process.env.SOURCE_AUDIT_DIR || '')
  if (!datasetArgument) {
    throw new Error('--dataset=<dir> is required (or set the SOURCE_AUDIT_DIR environment variable)')
  }
  const dataset = path.resolve(datasetArgument)
  const datasetEntry = fs.lstatSync(dataset)
  if (!datasetEntry.isDirectory() || datasetEntry.isSymbolicLink()) {
    throw new Error('--dataset must name a regular, non-symlink directory')
  }
  const allowedRoot = path.join(root, 'artifacts', 'benchmark', 'runtime-memory')
  const outputDir = path.resolve(
    option(argv, 'output-dir', path.join(allowedRoot, 'dino-fused-shadow', 'matrix')),
  )
  const relative = path.relative(allowedRoot, outputDir)
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('--output-dir must stay under artifacts/benchmark/runtime-memory')
  }
  const runs = Number(option(argv, 'runs', '3'))
  const sample = Number(option(argv, 'sample', '1000'))
  if (!Number.isInteger(runs) || runs < 3 || runs > 5) throw new Error('runs must be 3..5')
  if (!Number.isInteger(sample) || sample < 4 || sample > 1000) {
    throw new Error('sample must be 4..1000')
  }
  return { dataset, formal: argv.includes('--formal'), outputDir, projectRoot: root, runs, sample }
}

async function runFormalPreflight(options, dependencies = {}) {
  const resolveGpuBaseline = dependencies.resolveAcceptedGpuBaseline || resolveAcceptedGpuBaseline
  const collect = dependencies.collectRuntimeMemoryPreflight || collectRuntimeMemoryPreflight
  const evaluate = dependencies.evaluateRuntimeMemoryPreflight || evaluateRuntimeMemoryPreflight
  const gpuBaseline = resolveGpuBaseline({ projectRoot: options.projectRoot })
  const snapshot = await collect({ cwd: options.projectRoot })
  const evaluation = evaluate(snapshot, {
    formal: true,
    gpuBaselineUsedMiB: gpuBaseline.usedMiB,
  })
  return { snapshot, gpuBaseline, evaluation }
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.partial`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, filePath)
}

function imageCount(report) {
  return report.imageCount ?? report.config?.imageCount
}

function scanEvidence(report) {
  return report.scan?.digest ?? report.scan
}

function embeddingEvidence(report, model) {
  return report.embeddingDigests?.[model] ?? report[model]
}

function vectorIndexEvidence(report) {
  return report.vectorIndex?.status ?? report.vectorIndex
}

function stableIdentity(report) {
  return JSON.stringify({
    imageCount: imageCount(report),
    source: report.safety?.sourceSnapshot,
    scan: scanEvidence(report),
    dino: embeddingEvidence(report, 'dino'),
    clip: embeddingEvidence(report, 'clip'),
    vectorIndex: vectorIndexEvidence(report),
  })
}

function evaluateMatrix(entries, expectedRuns = 3, expectedImages = 1000) {
  const failures = []
  if (entries.length !== expectedRuns * 2) failures.push('matrix entry count is incomplete')
  const byMode = {
    baseline: entries.filter((entry) => entry.mode === 'baseline'),
    candidate: entries.filter((entry) => entry.mode === 'candidate'),
  }
  for (const [mode, rows] of Object.entries(byMode)) {
    if (rows.length !== expectedRuns)
      failures.push(`${mode} does not contain ${expectedRuns} rounds`)
    if (rows.some((entry) => entry.report?.ok !== true)) failures.push(`${mode} has a failed round`)
    if (
      rows.some(
        (entry) =>
          imageCount(entry.report) !== expectedImages ||
          vectorIndexEvidence(entry.report)?.count !== expectedImages,
      )
    ) {
      failures.push(`${mode} count or ready index differs from ${expectedImages}`)
    }
    if (new Set(rows.map((entry) => stableIdentity(entry.report))).size !== 1) {
      failures.push(`${mode} identity changed across rounds`)
    }
    if (
      rows.some(
        (entry) =>
          entry.report.safety?.sourceDatasetReadOnly !== true ||
          entry.report.safety?.sourceUnchanged !== true ||
          entry.report.safety?.isolatedUserData !== true ||
          entry.report.safety?.noBenchmarkChildProcessesAtStop !== true,
      )
    ) {
      failures.push(`${mode} safety or lifecycle evidence failed`)
    }
  }
  const allReports = entries.map((entry) => entry.report)
  for (const field of ['scan', 'dino', 'clip']) {
    const values = allReports.map((report) =>
      field === 'scan' ? scanEvidence(report)?.sha256 : embeddingEvidence(report, field)?.sha256,
    )
    if (values.some((value) => typeof value !== 'string') || new Set(values).size !== 1) {
      failures.push(`${field} exact digest changed across baseline/candidate rounds`)
    }
  }
  const providerFailed = allReports.some((report) =>
    ['dino', 'clip'].some((model) => {
      const evidence = report.providerEvidence?.[model]
      return (
        !evidence ||
        evidence.fallbackDetected !== false ||
        !Array.isArray(evidence.selectedProviders) ||
        !evidence.selectedProviders.includes('dml')
      )
    }),
  )
  if (providerFailed) failures.push('DirectML provider evidence is incomplete or fell back')
  const baselineReady = byMode.baseline.map((entry) => entry.report.phases.libraryReadyMs)
  const candidateReady = byMode.candidate.map((entry) => entry.report.phases.libraryReadyMs)
  const baselineP50 = percentile(baselineReady, 0.5)
  const candidateP50 = percentile(candidateReady, 0.5)
  const baselineP95 = percentile(baselineReady, 0.95)
  const candidateP95 = percentile(candidateReady, 0.95)
  if (candidateP95 > baselineP95 * 1.05)
    failures.push('candidate Library Ready P95 regressed by more than 5%')
  const baselineChildPeak = Math.max(
    ...byMode.baseline.map((entry) => entry.report.resources.memory.childPeakAggregateRssMiBApprox),
  )
  const candidateChildPeak = Math.max(
    ...byMode.candidate.map(
      (entry) => entry.report.resources.memory.childPeakAggregateRssMiBApprox,
    ),
  )
  if (candidateChildPeak > baselineChildPeak + 64) {
    failures.push('candidate child RSS peak exceeded baseline by more than 64 MiB')
  }
  const sourceSafe = allReports.every(
    (report) =>
      report.safety?.sourceDatasetReadOnly === true &&
      report.safety?.sourceUnchanged === true &&
      report.safety?.isolatedUserData === true,
  )
  const lifecycleSafe = allReports.every(
    (report) => report.safety?.noBenchmarkChildProcessesAtStop === true,
  )
  return {
    passed: failures.length === 0,
    failures,
    parity: {
      scanDigest: scanEvidence(allReports[0])?.sha256 ?? null,
      dinoDigest: embeddingEvidence(allReports[0], 'dino')?.sha256 ?? null,
      clipDigest: embeddingEvidence(allReports[0], 'clip')?.sha256 ?? null,
    },
    ready: {
      baselineP50Ms: baselineP50,
      baselineP95Ms: baselineP95,
      candidateP50Ms: candidateP50,
      candidateP95Ms: candidateP95,
      p50ChangePercent: ((candidateP50 - baselineP50) / Math.max(1, baselineP50)) * 100,
    },
    memory: {
      baselineChildPeakRssMiB: baselineChildPeak,
      candidateChildPeakRssMiB: candidateChildPeak,
    },
    safety: { sourceSafe, lifecycleSafe },
  }
}

function runE2e({ dataset, sample, mode, round, outputDir }) {
  return new Promise((resolve, reject) => {
    const reportPath = path.join(outputDir, `round-${round}-${mode}.json`)
    const timelinePath = path.join(outputDir, `round-${round}-${mode}.ndjson`)
    const nonce = `dino_fused_${round}_${mode}_${crypto.randomBytes(8).toString('hex')}`
    const args = [
      path.join(projectRoot, 'tests', 'image-search-simple-e2e-benchmark.cjs'),
      dataset,
      `--sample=${sample}`,
      '--backend=gpu',
      '--pipeline=overlap',
      '--jobs=2',
      '--batch-size=4',
      '--stage-metrics',
      '--compact',
      `--run-nonce=${nonce}`,
      `--json-out=${reportPath}`,
      `--timeline-out=${timelinePath}`,
    ]
    if (mode === 'candidate') args.push('--dino-fused-shadow=1')
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdoutBytes = 0
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > 2 * 1024 * 1024) child.kill()
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stderr = (stderr + text).slice(-64 * 1024)
      process.stderr.write(`[dino ${round} ${mode}] ${text}`)
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`DINO fused ${round}/${mode} exited ${code}: ${stderr.slice(-2000)}`))
        return
      }
      try {
        resolve({
          round,
          mode,
          reportFile: path.relative(projectRoot, reportPath),
          report: JSON.parse(fs.readFileSync(reportPath, 'utf8')),
        })
      } catch (error) {
        reject(error)
      }
    })
  })
}

async function main(options = parseArgs(process.argv.slice(2))) {
  const { dataset, formal, outputDir, runs, sample } = options
  fs.mkdirSync(outputDir, { recursive: true })
  const freePhysicalMemoryBytes = os.freemem()
  if (!formal && freePhysicalMemoryBytes < 4 * GIB) {
    const incomplete = {
      schema: 'siftory-dino-fused-shadow-matrix/v1',
      generatedAt: new Date().toISOString(),
      status: 'incomplete',
      reason: 'free physical memory is below 4 GiB',
      preflight: { freePhysicalMemoryBytes, minimumFreePhysicalMemoryBytes: 4 * GIB },
    }
    atomicJson(path.join(outputDir, 'report.json'), incomplete)
    process.stdout.write(`${JSON.stringify(incomplete, null, 2)}\n`)
    process.exitCode = 2
    return
  }
  const orders = [
    ['baseline', 'candidate'],
    ['candidate', 'baseline'],
    ['baseline', 'candidate'],
  ]
  const entries = []
  const formalPreflights = []
  for (let round = 1; round <= runs; round++) {
    const order = orders[(round - 1) % orders.length]
    if (formal) {
      let preflight
      try {
        preflight = await runFormalPreflight(options)
      } catch (error) {
        preflight = {
          snapshot: null,
          gpuBaseline: null,
          evaluation: {
            status: 'incomplete',
            failures: [],
            incomplete: [error instanceof Error ? error.message : String(error)],
          },
        }
      }
      formalPreflights.push({ round, order: pairedOrderForRound(round - 1), ...preflight })
      if (preflight.evaluation.status !== 'passed') {
        const incomplete = {
          schema: 'siftory-dino-fused-shadow-matrix/v1',
          generatedAt: new Date().toISOString(),
          status: 'incomplete',
          formal: true,
          reason: `formal preflight ${round} is ${preflight.evaluation.status}`,
          config: { runs, sample, order: orders },
          formalPreflights,
          completedMatrixEntries: entries.length,
        }
        atomicJson(path.join(outputDir, 'report.json'), incomplete)
        process.stdout.write(`${JSON.stringify(incomplete, null, 2)}\n`)
        process.exitCode = 2
        return
      }
    }
    for (const mode of order) {
      process.stderr.write(`[dino] round ${round}/${runs}: ${mode}\n`)
      entries.push(await runE2e({ dataset, sample, mode, round, outputDir }))
    }
  }
  const gate = evaluateMatrix(entries, runs, sample)
  const report = {
    schema: 'siftory-dino-fused-shadow-matrix/v1',
    generatedAt: new Date().toISOString(),
    status: gate.passed ? 'passed' : 'failed',
    formal,
    config: { runs, sample, order: orders },
    ...(formal ? { formalPreflights } : {}),
    parity: gate.parity,
    ready: gate.ready,
    memory: gate.memory,
    safety: {
      sourceReadOnly: gate.safety.sourceSafe,
      isolatedUserData: gate.safety.sourceSafe,
      noBenchmarkChildProcessesAtStop: gate.safety.lifecycleSafe,
    },
    gate: { passed: gate.passed, failures: gate.failures },
    rounds: entries.map(({ round, mode, reportFile, report }) => ({
      round,
      mode,
      reportFile,
      readyMs: report.phases.libraryReadyMs,
      mainPeakRssMiB: report.resources.memory.mainPeakRssMiB,
      childPeakAggregateRssMiBApprox: report.resources.memory.childPeakAggregateRssMiBApprox,
      systemMinFreeMiB: report.resources.memory.systemMinFreeMiB,
      dinoDigest: embeddingEvidence(report, 'dino')?.sha256 ?? null,
    })),
  }
  atomicJson(path.join(outputDir, 'report.json'), report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!gate.passed) process.exitCode = 1
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = {
  embeddingEvidence,
  evaluateMatrix,
  imageCount,
  parseArgs,
  runFormalPreflight,
  scanEvidence,
  stableIdentity,
  vectorIndexEvidence,
}
