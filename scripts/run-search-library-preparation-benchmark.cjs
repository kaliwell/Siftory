const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const {
  snapshotFiles,
  writeJson,
} = require('../tests/search-library-preparation-benchmark-utils.cjs')

const projectRoot = path.resolve(__dirname, '..')
const DEFAULT_IMAGE_DATASET = process.env.SOURCE_AUDIT_DIR || ''
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'])
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.mov',
  '.avi',
  '.webm',
  '.wmv',
  '.m4v',
  '.flv',
  '.ts',
  '.mts',
  '.m2ts',
])

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function parseArgs(argv) {
  const defaultImageDataset = fs.existsSync(DEFAULT_IMAGE_DATASET) ? DEFAULT_IMAGE_DATASET : ''
  const imageDataset = option(argv, 'image-dataset', defaultImageDataset)
  const stamp = timestampId()
  const requestedBatchSize = Number(option(argv, 'batch-size', '4'))
  return {
    imageDataset: imageDataset ? path.resolve(imageDataset) : '',
    videoDataset: option(argv, 'video-dataset', '')
      ? path.resolve(option(argv, 'video-dataset', ''))
      : '',
    imageSample: Math.max(4, Math.min(256, Number(option(argv, 'image-sample', '16')) || 16)),
    videoLimit: Math.max(1, Math.min(20, Number(option(argv, 'video-limit', '3')) || 3)),
    runs: Math.max(1, Math.min(30, Number(option(argv, 'runs', '3')) || 3)),
    backend: option(argv, 'backend', 'gpu'),
    jobs: Math.max(1, Math.min(2, Number(option(argv, 'jobs', '2')) || 2)),
    batchSize:
      requestedBatchSize === 0
        ? 0
        : Math.max(1, Math.min(16, Number.isFinite(requestedBatchSize) ? requestedBatchSize : 4)),
    timeoutMs: Math.max(60_000, Number(option(argv, 'timeout-ms', '1800000')) || 1_800_000),
    outDir: path.resolve(
      option(
        argv,
        'out-dir',
        path.join(projectRoot, 'artifacts', 'benchmark', 'search-library-preparation', stamp),
      ),
    ),
    deferImageThumbnails: !argv.includes('--eager-image-thumbnails'),
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/run-search-library-preparation-benchmark.cjs [options]

Options:
  --image-dataset=<dir>  Fixed read-only image corpus
  --video-dataset=<path> Optional fixed read-only video corpus; omitted uses fixtures
  --image-sample=<count> Images per run (default: 16)
  --video-limit=<count>  Videos per run (default: 3)
  --runs=<count>         Repeated runs used for P50/P95 (default: 3)
  --backend=cpu|gpu      Embedding backend (default: gpu)
  --jobs=1|2             Embedding workers (default: 2)
  --batch-size=0..16     Fixed batch for comparable runs (default: 4; 0 is diagnostic adaptive mode)
  --eager-image-thumbnails  Diagnose the legacy eager path; default matches deferred simple setup
  --timeout-ms=<ms>      Per embedding phase timeout
  --out-dir=<dir>        De-identified report directory
`)
}

function collectFiles(target, extensions, limit = Number.POSITIVE_INFINITY) {
  const resolved = path.resolve(target)
  const stat = fs.statSync(resolved)
  if (stat.isFile()) return extensions.has(path.extname(resolved).toLowerCase()) ? [resolved] : []
  const files = []
  const queue = [resolved]
  while (queue.length > 0 && files.length < limit) {
    const directory = queue.shift()
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(filePath)
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        files.push(filePath)
        if (files.length >= limit) break
      }
    }
  }
  return files
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
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 4 * 1024 * 1024) stderr = stderr.slice(-4 * 1024 * 1024)
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
          `${path.basename(scriptPath)} failed (${timedOut ? 'timeout' : (code ?? signal)})\n${stderr.slice(-8000)}`,
        ),
      )
    })
  })
}

function percentile(values, percentileValue) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (finite.length === 0) return null
  const index = Math.max(0, Math.ceil(percentileValue * finite.length) - 1)
  return finite[index]
}

function summarizeNumbers(values) {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return { samples: 0, p50: null, p95: null, max: null }
  return {
    samples: finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: Math.max(...finite),
  }
}

function summarizePhases(reports) {
  const keys = [...new Set(reports.flatMap((report) => Object.keys(report.phases || {})))].sort()
  return Object.fromEntries(
    keys.map((key) => [
      key,
      summarizeNumbers(reports.map((report) => Number(report.phases?.[key]))),
    ]),
  )
}

function valueAt(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => current?.[key], value)
}

function summarizeResources(reports) {
  const metrics = [
    'cpu.logicalCapacityPercentApprox',
    'memory.mainPeakRssMiB',
    'memory.childPeakAggregateRssMiBApprox',
    'memory.childLargestPeakRssMiBApprox',
    'gpu.peakDeltaUsedMiB',
    'gpu.peakUtilizationPercent',
    'io.mainReadBytesApprox',
    'io.mainWriteBytesApprox',
    'io.childReadBytesApprox',
    'io.childWriteBytesApprox',
    'processes.spawned',
    'processes.peakActive',
  ]
  return Object.fromEntries(
    metrics.map((metric) => [
      metric,
      summarizeNumbers(
        reports.map((report) => {
          const value = valueAt(report.resources, metric)
          return value === null || value === undefined ? Number.NaN : Number(value)
        }),
      ),
    ]),
  )
}

function digestConsistency(reports, selectors) {
  return Object.fromEntries(
    Object.entries(selectors).map(([name, selector]) => {
      const values = reports.map(selector).filter(Boolean)
      const unique = [...new Set(values)]
      return [
        name,
        { consistent: values.length === reports.length && unique.length === 1, values: unique },
      ]
    }),
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
    phases: report.phases,
    resources: report.resources,
    counts: report.config,
    failures: report.frames
      ? {
          scan: report.scan.failed,
          metadata: report.scan.metadataErrors,
          thumbnails: report.scan.thumbnailErrors,
          frames: report.frames.failed,
          dino: report.dino.progress.failed,
          clip: report.clip.progress.failed,
          frameIndex: report.frameIndex.result.errors,
        }
      : {
          scan: report.scan.progress.failed || 0,
          dino: report.dino.progress.failed,
          clip: report.clip.progress.failed,
        },
  }
}

function markdownTable(phases) {
  const rows = ['| Phase | P50 ms | P95 ms | Max ms |', '| --- | ---: | ---: | ---: |']
  for (const [name, values] of Object.entries(phases)) {
    rows.push(`| ${name} | ${values.p50 ?? '-'} | ${values.p95 ?? '-'} | ${values.max ?? '-'} |`)
  }
  return rows.join('\n')
}

function renderMarkdown(report) {
  return `# Search library preparation baseline

- Generated: ${report.generatedAt}
- Git HEAD: \`${report.environment.git.head}\` (dirty: ${report.environment.git.dirty})
- Runs: ${report.config.runs}
- Image corpus: ${report.corpora.image.count} files / ${report.corpora.image.totalBytes} bytes
- Video corpus: ${report.corpora.video.kind}
- Backend: ${report.config.backend}; jobs: ${report.config.jobs}; batch size: ${report.config.batchSize}

## Image Search phases

${markdownTable(report.image.phases)}

## Media Search phases

${markdownTable(report.media.phases)}

## Correctness

- Image digests consistent: ${Object.values(report.image.correctness).every((row) => row.consistent)}
- Media digests consistent: ${Object.values(report.media.correctness).every((row) => row.consistent)}
- Effective embedding configuration consistent: ${[
    ...Object.values(report.image.runtimeConfiguration),
    ...Object.values(report.media.runtimeConfiguration),
  ].every((row) => row.consistent)}
- Source files unchanged in every run: ${report.safety.sourceFilesUnchanged}
- Derived data isolated from real userData in every run: ${report.safety.isolatedUserData}

Resource values for child processes are sampled approximations. NVIDIA GPU values are global
device values and can include unrelated activity; raw per-run reports preserve the sample scope.
`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  if (!['cpu', 'gpu'].includes(options.backend)) throw new Error('Use --backend=cpu or gpu')
  if (!options.imageDataset || !fs.existsSync(options.imageDataset)) {
    throw new Error('Pass an existing fixed image corpus with --image-dataset=<dir>')
  }
  const imageFiles = collectFiles(options.imageDataset, IMAGE_EXTENSIONS, options.imageSample)
  if (imageFiles.length < options.imageSample) {
    throw new Error(`Image corpus contains ${imageFiles.length}; ${options.imageSample} required`)
  }
  let videoFiles = []
  if (options.videoDataset) {
    if (!fs.existsSync(options.videoDataset))
      throw new Error('The fixed video corpus does not exist')
    videoFiles = collectFiles(options.videoDataset, VIDEO_EXTENSIONS, options.videoLimit)
    if (videoFiles.length === 0) throw new Error('The fixed video corpus contains no videos')
  }

  fs.mkdirSync(options.outDir, { recursive: true })
  const imageReports = []
  const mediaReports = []
  const imageRunner = path.join(projectRoot, 'tests', 'image-search-simple-e2e-benchmark.cjs')
  const mediaRunner = path.join(
    projectRoot,
    'tests',
    'media-search-library-preparation-benchmark.cjs',
  )
  for (let index = 0; index < options.runs; index += 1) {
    const runNumber = index + 1
    const imageOut = path.join(options.outDir, `image-run-${runNumber}.json`)
    process.stderr.write(`[prep-baseline] run ${runNumber}/${options.runs}: Image Search\n`)
    await runChild(
      imageRunner,
      [
        options.imageDataset,
        `--sample=${options.imageSample}`,
        `--backend=${options.backend}`,
        `--jobs=${options.jobs}`,
        `--batch-size=${options.batchSize}`,
        `--timeout-ms=${options.timeoutMs}`,
        `--json-out=${imageOut}`,
        ...(options.deferImageThumbnails ? ['--defer-thumbnails'] : []),
        '--compact',
      ],
      options.timeoutMs * 3,
    )
    imageReports.push(JSON.parse(fs.readFileSync(imageOut, 'utf8')))

    const mediaOut = path.join(options.outDir, `media-run-${runNumber}.json`)
    process.stderr.write(`[prep-baseline] run ${runNumber}/${options.runs}: Media Search\n`)
    await runChild(
      mediaRunner,
      [
        ...(options.videoDataset ? [options.videoDataset] : []),
        `--limit=${options.videoLimit}`,
        `--backend=${options.backend}`,
        `--jobs=${options.jobs}`,
        `--batch-size=${options.batchSize}`,
        `--timeout-ms=${options.timeoutMs}`,
        `--json-out=${mediaOut}`,
        '--compact',
      ],
      options.timeoutMs * 3,
    )
    mediaReports.push(JSON.parse(fs.readFileSync(mediaOut, 'utf8')))
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
      imageSample: options.imageSample,
      videoLimit: options.videoLimit,
      imageThumbnailMode: options.deferImageThumbnails ? 'deferred' : 'eager-diagnostic',
    },
    corpora: {
      image: snapshotFiles(imageFiles),
      video: options.videoDataset
        ? { kind: 'external-read-only', ...snapshotFiles(videoFiles) }
        : { kind: 'deterministic-cfr-vfr-damaged-fixtures', count: 3 },
    },
    image: {
      phases: summarizePhases(imageReports),
      resources: summarizeResources(imageReports),
      correctness: digestConsistency(imageReports, {
        nativeScan: (report) => report.scan?.digest?.sha256,
        dino: (report) => report.embeddingDigests?.dino?.stableSha256,
        clip: (report) => report.embeddingDigests?.clip?.stableSha256,
      }),
      bitwiseDiagnostics: digestConsistency(imageReports, {
        dino: (report) => report.embeddingDigests?.dino?.sha256,
        clip: (report) => report.embeddingDigests?.clip?.sha256,
      }),
      runtimeConfiguration: digestConsistency(imageReports, {
        dinoBatch: (report) => String(report.dino?.progress?.effectiveBatchSize ?? ''),
        clipBatch: (report) => String(report.clip?.progress?.effectiveBatchSize ?? ''),
      }),
      runs: imageReports.map(compactRun),
    },
    media: {
      phases: summarizePhases(mediaReports),
      resources: summarizeResources(mediaReports),
      correctness: digestConsistency(mediaReports, {
        videos: (report) => report.scan?.digest?.sha256,
        frames: (report) => report.frames?.digest?.sha256,
        dino: (report) => report.embeddingDigests?.dino?.stableSha256,
        clip: (report) => report.embeddingDigests?.clip?.stableSha256,
        dinoFrameIndex: (report) => report.frameIndex?.dino?.stableSha256,
        clipFrameIndex: (report) => report.frameIndex?.clip?.stableSha256,
      }),
      bitwiseDiagnostics: digestConsistency(mediaReports, {
        dino: (report) => report.embeddingDigests?.dino?.sha256,
        clip: (report) => report.embeddingDigests?.clip?.sha256,
        dinoFrameIndex: (report) => report.frameIndex?.dino?.sha256,
        clipFrameIndex: (report) => report.frameIndex?.clip?.sha256,
      }),
      runtimeConfiguration: digestConsistency(mediaReports, {
        dinoBatch: (report) => String(report.dino?.progress?.effectiveBatchSize ?? ''),
        clipBatch: (report) => String(report.clip?.progress?.effectiveBatchSize ?? ''),
      }),
      runs: mediaReports.map(compactRun),
    },
    safety: {
      sourceFilesUnchanged: [...imageReports, ...mediaReports].every(
        (run) => run.safety?.sourceUnchanged === true,
      ),
      isolatedUserData: [...imageReports, ...mediaReports].every(
        (run) => run.safety?.isolatedUserData === true,
      ),
      realLibraryWritten: false,
    },
  }
  const allCorrect = [
    ...Object.values(report.image.correctness),
    ...Object.values(report.media.correctness),
  ].every((row) => row.consistent)
  if (!allCorrect) throw new Error('Correctness digests changed between benchmark runs')
  const runtimeConfigurationConsistent = [
    ...Object.values(report.image.runtimeConfiguration),
    ...Object.values(report.media.runtimeConfiguration),
  ].every((row) => row.consistent)
  if (!runtimeConfigurationConsistent) {
    throw new Error('Effective embedding configuration changed between benchmark runs')
  }
  if (!report.safety.sourceFilesUnchanged || !report.safety.isolatedUserData) {
    throw new Error('Benchmark isolation verification failed')
  }

  const jsonPath = path.join(options.outDir, 'baseline.json')
  const markdownPath = path.join(options.outDir, 'baseline.md')
  writeJson(jsonPath, report)
  fs.writeFileSync(markdownPath, renderMarkdown(report), 'utf8')
  writeJson(
    path.join(projectRoot, 'artifacts', 'benchmark', 'search-library-preparation', 'latest.json'),
    {
      generatedAt: report.generatedAt,
      reportDirectory: path.basename(options.outDir),
      baselineFile: path.relative(projectRoot, jsonPath).split(path.sep).join('/'),
      markdownFile: path.relative(projectRoot, markdownPath).split(path.sep).join('/'),
    },
  )
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        outputDirectory: options.outDir,
        baseline: jsonPath,
        imageLibraryReady: report.image.phases.libraryReadyMs,
        mediaLibraryReady: report.media.phases.libraryReadyMs,
        safety: report.safety,
      },
      null,
      2,
    )}\n`,
  )
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = {
  digestConsistency,
  percentile,
  summarizeNumbers,
  summarizePhases,
  summarizeResources,
}
