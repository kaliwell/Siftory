const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const { writeJson } = require('./search-library-preparation-benchmark-utils.cjs')

const projectRoot = path.resolve(__dirname, '..')
const defaultDataset = String.raw`D:\PxHereDataset\images\pxhere-000000`

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function integerList(value, minimum, maximum, label) {
  const values = [...new Set(String(value).split(',').map(Number))]
  if (
    values.length === 0 ||
    values.some((item) => !Number.isInteger(item) || item < minimum || item > maximum)
  ) {
    throw new Error(`${label} must contain comma-separated integers from ${minimum} to ${maximum}`)
  }
  return values
}

function parseCombos(value) {
  if (!value) return null
  const combos = value.split(',').map((entry) => {
    const [scanWorkers, embeddingJobs] = entry.split(':').map(Number)
    if (
      !Number.isInteger(scanWorkers) ||
      scanWorkers < 2 ||
      scanWorkers > 8 ||
      !Number.isInteger(embeddingJobs) ||
      embeddingJobs < 1 ||
      embeddingJobs > 2
    ) {
      throw new Error('Use --combos as scanWorkers:embeddingJobs pairs, for example 3:2,2:2')
    }
    return { scanWorkers, embeddingJobs }
  })
  return [
    ...new Map(
      combos.map((combo) => [`${combo.scanWorkers}:${combo.embeddingJobs}`, combo]),
    ).values(),
  ]
}

function parseArgs(argv) {
  const datasetValue = option(argv, 'dataset', fs.existsSync(defaultDataset) ? defaultDataset : '')
  const scanWorkers = integerList(option(argv, 'scan-workers', '2,3,4'), 2, 8, '--scan-workers')
  const embeddingJobs = integerList(option(argv, 'embedding-jobs', '1,2'), 1, 2, '--embedding-jobs')
  const explicitCombos = parseCombos(option(argv, 'combos', ''))
  return {
    dataset: datasetValue ? path.resolve(datasetValue) : '',
    sample: Math.max(16, Math.min(1000, Number(option(argv, 'sample', '256')) || 256)),
    rounds: Math.max(3, Math.min(10, Number(option(argv, 'rounds', '3')) || 3)),
    scanWorkers,
    embeddingJobs,
    combos:
      explicitCombos ||
      scanWorkers.flatMap((workers) =>
        embeddingJobs.map((jobs) => ({ scanWorkers: workers, embeddingJobs: jobs })),
      ),
    batchSize: Math.max(1, Math.min(16, Number(option(argv, 'batch-size', '4')) || 4)),
    backend: option(argv, 'backend', 'gpu'),
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
          `prep014-${timestampId()}`,
        ),
      ),
    ),
    verifyWarm: argv.includes('--verify-warm'),
  }
}

function orderForRound(combos, roundIndex) {
  const rotation = (roundIndex * 2) % combos.length
  const rotated = [...combos.slice(rotation), ...combos.slice(0, rotation)]
  return roundIndex % 2 === 0 ? rotated : rotated.reverse()
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
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Joint scheduling child timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 128 * 1024) stdout = stdout.slice(-128 * 1024)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 128 * 1024) stderr = stderr.slice(-128 * 1024)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else {
        reject(
          new Error(
            `Joint scheduling child failed (${code ?? signal ?? 'unknown'}): ${stderr.trim() || stdout.trim()}`,
          ),
        )
      }
    })
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (
    !options.dataset ||
    !fs.existsSync(options.dataset) ||
    !fs.statSync(options.dataset).isDirectory()
  ) {
    throw new Error('Pass an existing fixed image corpus with --dataset=<dir>')
  }
  if (!['cpu', 'gpu'].includes(options.backend)) throw new Error('Use --backend=cpu or gpu')
  if (!options.combos.some((combo) => combo.scanWorkers === 3 && combo.embeddingJobs === 2)) {
    throw new Error('The matrix must include the current baseline combo 3:2')
  }
  fs.mkdirSync(options.outDir, { recursive: true })
  const runner = path.join(projectRoot, 'tests', 'image-search-simple-e2e-benchmark.cjs')
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    config: {
      sample: options.sample,
      rounds: options.rounds,
      batchSize: options.batchSize,
      backend: options.backend,
      combos: options.combos,
      orderBalanced: true,
      verifyWarm: options.verifyWarm,
      sourceDatasetReadOnly: true,
      pathsAndFilenamesOmitted: true,
    },
    runs: [],
  }
  let sequence = 0
  for (let roundIndex = 0; roundIndex < options.rounds; roundIndex += 1) {
    const round = roundIndex + 1
    for (const combo of orderForRound(options.combos, roundIndex)) {
      sequence += 1
      const freeMiBBefore = Math.round(os.freemem() / 1024 / 1024)
      if (freeMiBBefore < 256) {
        throw new Error(
          `Only ${freeMiBBefore} MiB system memory free before matrix run ${sequence}`,
        )
      }
      const baseName = `matrix-r${round}-scan${combo.scanWorkers}-jobs${combo.embeddingJobs}`
      const outputPath = path.join(options.outDir, `${baseName}.json`)
      const timelinePath = path.join(options.outDir, `${baseName}.timeline.ndjson`)
      process.stderr.write(
        `[PREP-014] ${sequence}/${options.rounds * options.combos.length}: round=${round} scan=${combo.scanWorkers} jobs=${combo.embeddingJobs} free=${freeMiBBefore}MiB\n`,
      )
      const startedAt = Date.now()
      const result = await runChild(
        runner,
        [
          options.dataset,
          '--pipeline=overlap',
          `--sample=${options.sample}`,
          `--backend=${options.backend}`,
          `--jobs=${combo.embeddingJobs}`,
          `--batch-size=${options.batchSize}`,
          `--scan-workers=${combo.scanWorkers}`,
          `--timeout-ms=${options.timeoutMs}`,
          `--json-out=${outputPath}`,
          `--timeline-out=${timelinePath}`,
          '--stage-metrics',
          '--defer-thumbnails',
          ...(options.verifyWarm ? ['--verify-warm'] : []),
          '--compact',
        ],
        options.timeoutMs,
      )
      const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      const run = {
        sequence,
        round,
        scanWorkers: combo.scanWorkers,
        embeddingJobs: combo.embeddingJobs,
        freeMiBBefore,
        elapsedMs: Date.now() - startedAt,
        libraryReadyMs: report.phases?.libraryReadyMs ?? null,
        scanReadyMs: report.pipeline?.result?.timings?.scanReadyMs ?? null,
        dinoReadyMs: report.pipeline?.result?.timings?.dinoReadyMs ?? null,
        clipReadyMs: report.pipeline?.result?.timings?.clipReadyMs ?? null,
        effectiveScanWorkers: report.scan?.progress?.scanWorkerCount ?? null,
        samplingErrors: report.resources?.sampling?.errors ?? null,
        systemMinFreeMiB: report.resources?.memory?.systemMinFreeMiB ?? null,
        gpuPeakUsedMiB: report.resources?.gpu?.peakUsedMiB ?? null,
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
        reportFile: `${baseName}.json`,
        timelineFile: `${baseName}.timeline.ndjson`,
      }
      manifest.runs.push(run)
      writeJson(path.join(options.outDir, 'matrix-manifest.json'), manifest)
      process.stderr.write(
        `[PREP-014] done scan=${combo.scanWorkers} jobs=${combo.embeddingJobs} ready=${Math.round(run.libraryReadyMs)}ms scanReady=${Math.round(run.scanReadyMs)}ms minFree=${run.systemMinFreeMiB}MiB gpu=${run.gpuPeakUsedMiB}MiB samplingErrors=${run.samplingErrors}\n`,
      )
    }
  }

  const analyzer = path.join(projectRoot, 'scripts', 'analyze-image-joint-scheduling-matrix.cjs')
  const analyzed = spawnSync(process.execPath, [analyzer, `--dir=${options.outDir}`], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (analyzed.status !== 0) {
    throw new Error(analyzed.stderr.trim() || analyzed.stdout.trim() || 'Matrix analyzer failed')
  }
  const analysis = JSON.parse(
    fs.readFileSync(path.join(options.outDir, 'matrix-analysis.json'), 'utf8'),
  )
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      outputDirectory: options.outDir,
      runs: manifest.runs.length,
      recommendation: analysis.recommendation,
    })}\n`,
  )
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = { orderForRound, parseArgs, parseCombos }
