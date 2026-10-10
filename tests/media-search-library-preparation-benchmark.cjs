const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { spawnSync } = require('node:child_process')

const { loadTsModule } = require('./guard-utils.cjs')
const {
  assertFileSnapshotUnchanged,
  redactPaths,
  safeRemoveTempRoot,
  sha256Text,
  snapshotFiles,
  startResourceMonitor,
  writeJson,
} = require('./search-library-preparation-benchmark-utils.cjs')

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
const projectRoot = path.resolve(__dirname, '..')

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function optionalInteger(argv, name) {
  const raw = option(argv, name, '')
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Use --${name}=<positive integer>`)
  return value
}

function parseArgs(argv) {
  const positional = argv.filter((value) => !value.startsWith('--'))
  const requestedBatchSize = Number(option(argv, 'batch-size', '0'))
  return {
    source: positional[0] ? path.resolve(positional[0]) : '',
    limit: Math.max(1, Math.min(20, Number(option(argv, 'limit', '3')) || 3)),
    backend: option(argv, 'backend', 'gpu'),
    pipeline: option(argv, 'pipeline', 'serial'),
    jobs: Math.max(1, Math.min(2, Number(option(argv, 'jobs', '2')) || 2)),
    batchSize:
      requestedBatchSize === 0
        ? 0
        : Math.max(1, Math.min(16, Number.isFinite(requestedBatchSize) ? requestedBatchSize : 4)),
    intervalMs: optionalInteger(argv, 'interval-ms'),
    maxFramesPerVideo: optionalInteger(argv, 'max-frames-per-video'),
    width: optionalInteger(argv, 'width'),
    fixtureCfrSeconds: Math.max(
      6,
      Math.min(120, Number(option(argv, 'fixture-cfr-seconds', '12')) || 12),
    ),
    fixtureVfrSeconds: Math.max(
      6,
      Math.min(120, Number(option(argv, 'fixture-vfr-seconds', '9')) || 9),
    ),
    timeoutMs: Math.max(60_000, Number(option(argv, 'timeout-ms', '1800000')) || 1_800_000),
    appRoot: path.resolve(option(argv, 'app-root', projectRoot)),
    childrenDir: path.resolve(
      option(argv, 'children-dir', path.join(projectRoot, 'dist-electron')),
    ),
    jsonOut: option(argv, 'json-out', ''),
    compact: argv.includes('--compact'),
    keepTemp: argv.includes('--keep-temp'),
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

function printHelp() {
  process.stdout.write(`Usage:
  node tests/media-search-library-preparation-benchmark.cjs [video-file-or-directory] [options]

With no source, the runner creates deterministic CFR, VFR and damaged fixtures outside
the measured interval. Real source files are opened read-only and all derived data uses
an isolated temporary userData/media-search directory.

Options:
  --limit=<count>                 Maximum source videos (default: 3)
  --backend=cpu|gpu              Embedding backend (default: gpu)
  --pipeline=serial|overlap      Preparation execution mode (default: serial)
  --jobs=1|2                     Maximum embedding workers (default: 2)
  --batch-size=0..16             0 selects the adaptive batch policy (default: 0)
  --interval-ms=<milliseconds>   Explicit frame interval; omitted uses production policy
  --max-frames-per-video=<count> Explicit cap; omitted uses production policy
  --width=<pixels>               Explicit frame width; omitted uses production policy
  --json-out=<file>              Write the full de-identified report
  --compact                      Print only the compact summary
  --keep-temp                    Keep this run's validated temp root for debugging
`)
}

function collectVideos(target, limit) {
  const resolved = path.resolve(target)
  const stat = fs.statSync(resolved)
  if (stat.isFile()) {
    if (!VIDEO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new Error('The selected source file is not a supported video')
    }
    return { root: path.dirname(resolved), files: [resolved] }
  }
  if (!stat.isDirectory()) throw new Error('The selected video source is not a directory or file')
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
      else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(filePath)
        if (files.length >= limit) break
      }
    }
  }
  return { root: resolved, files }
}

function findFfmpeg() {
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const candidates = [
    path.join(projectRoot, 'tools', 'ffmpeg', 'bin', executable),
    path.join(projectRoot, 'tools', 'ffmpeg', executable),
    executable,
  ]
  return candidates.find((candidate) => !path.isAbsolute(candidate) || fs.existsSync(candidate))
}

function runFixtureFfmpeg(ffmpeg, args) {
  const result = spawnSync(ffmpeg, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `Fixture FFmpeg failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`,
    )
  }
}

function createSyntheticFixtures(root, options) {
  const startedAt = performance.now()
  const ffmpeg = findFfmpeg()
  const fixtureRoot = path.join(root, 'source-fixtures')
  fs.mkdirSync(fixtureRoot, { recursive: true })
  const cfr = path.join(fixtureRoot, 'cfr-testsrc.mp4')
  const vfr = path.join(fixtureRoot, 'vfr-testsrc.mkv')
  const damaged = path.join(fixtureRoot, 'damaged-truncated.mp4')
  runFixtureFfmpeg(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=320x180:rate=30:duration=${options.fixtureCfrSeconds}`,
    '-an',
    '-c:v',
    'mpeg4',
    '-q:v',
    '5',
    '-pix_fmt',
    'yuv420p',
    cfr,
  ])
  runFixtureFfmpeg(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=320x180:rate=30:duration=${options.fixtureVfrSeconds}`,
    '-vf',
    "select='if(lt(t,4),not(mod(n,2)),not(mod(n,5)))'",
    '-fps_mode',
    'vfr',
    '-an',
    '-c:v',
    'mpeg4',
    '-q:v',
    '5',
    '-pix_fmt',
    'yuv420p',
    vfr,
  ])
  const source = fs.readFileSync(cfr)
  fs.writeFileSync(damaged, source.subarray(0, Math.min(source.length, 4096)))
  return {
    root: fixtureRoot,
    files: [cfr, vfr, damaged],
    generationMs: Number((performance.now() - startedAt).toFixed(2)),
    kinds: ['cfr', 'vfr', 'damaged-truncated'],
  }
}

function createElectronMock(appDataPath, userDataPath, appRoot) {
  return {
    app: {
      isPackaged: false,
      getPath: (name) => (name === 'appData' ? appDataPath : userDataPath),
      getAppPath: () => appRoot,
    },
  }
}

function waitForEmbedding(embeddingService, timeoutMs, samples) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let lastRecordedAt = 0
    const timer = setInterval(() => {
      const progress = embeddingService.getEmbeddingProgress()
      const now = Date.now()
      if (now - lastRecordedAt >= 1_000) {
        lastRecordedAt = now
        samples.push({
          atMs: now - startedAt,
          completed: progress.completed,
          failed: progress.failed,
          skipped: progress.skipped,
          pending: progress.pending,
          running: progress.running,
          itemsPerSecond: progress.itemsPerSecond,
          message:
            typeof progress.currentPath === 'string' && path.isAbsolute(progress.currentPath)
              ? path.basename(progress.currentPath)
              : progress.currentPath,
        })
      }
      if (progress.state === 'done') {
        clearInterval(timer)
        resolve(progress)
      } else if (progress.state === 'error') {
        clearInterval(timer)
        reject(new Error(progress.error || 'Embedding build failed'))
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Embedding build timed out after ${timeoutMs}ms`))
      }
    }, 100)
  })
}

async function runEmbeddingPhase(embeddingService, request, timeoutMs) {
  const samples = []
  const startedAt = performance.now()
  const started = await embeddingService.startEmbeddingBuild(request)
  const preparationMs = performance.now() - startedAt
  assert.equal(started.ok, true, JSON.stringify(started))
  const inferenceStartedAt = performance.now()
  const progress = await waitForEmbedding(embeddingService, timeoutMs, samples)
  const inferencePersistenceMs = performance.now() - inferenceStartedAt
  assert.equal(progress.failed, 0)
  assert.equal(progress.completed + progress.skipped, progress.total)
  return {
    totalMs: Number((performance.now() - startedAt).toFixed(2)),
    preparationMs: Number(preparationMs.toFixed(2)),
    inferencePersistenceMs: Number(inferencePersistenceMs.toFixed(2)),
    progress,
    progressSamples: samples.filter(
      (sample, index) => index === 0 || index === samples.length - 1 || index % 10 === 0,
    ),
  }
}

function sourceKey(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function fileDigest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function digestRows(rows) {
  const normalized = rows.sort().join('\n')
  return { count: rows.length, sha256: sha256Text(normalized) }
}

function videoDigest(records, sourceRoot) {
  return digestRows(
    records.map((record) =>
      [
        sourceKey(sourceRoot, record.path),
        record.sizeBytes,
        record.durationMs ?? '',
        record.width ?? '',
        record.height ?? '',
        record.videoCodec ?? '',
        record.metadataStatus,
        record.thumbnailStatus ?? '',
      ].join('\u001f'),
    ),
  )
}

function frameKeyMaps(records, videoKeys) {
  const keyByFramePath = new Map()
  const rows = []
  for (const record of records) {
    const key = `${videoKeys.get(record.videoId) || 'unknown'}@${record.timestampMs}`
    if (record.imagePath) keyByFramePath.set(path.resolve(record.imagePath).toLowerCase(), key)
    rows.push(
      [
        key,
        record.width,
        record.status,
        record.imagePath && fs.existsSync(record.imagePath) ? fileDigest(record.imagePath) : '',
      ].join('\u001f'),
    )
  }
  return { keyByFramePath, digest: digestRows(rows) }
}

function embeddingDigest(entries, keyByFramePath) {
  const exactRows = []
  const stableRows = []
  for (const entry of entries) {
    const frameKey = keyByFramePath.get(path.resolve(entry.imageId).toLowerCase())
    if (!frameKey) continue
    exactRows.push(`${frameKey}\u001f${entry.vector.join(',')}`)
    stableRows.push(`${frameKey}\u001f${entry.vector.map((value) => value.toFixed(4)).join(',')}`)
  }
  return {
    count: exactRows.length,
    sha256: sha256Text(exactRows.sort().join('\n')),
    stableSha256: sha256Text(stableRows.sort().join('\n')),
    stableDecimalPlaces: 4,
  }
}

function embeddingComparisonRows(entries, keyByFramePath) {
  return entries
    .flatMap((entry) => {
      const frameKey = keyByFramePath.get(path.resolve(entry.imageId).toLowerCase())
      if (!frameKey) return []
      return [
        {
          id: sha256Text(frameKey).slice(0, 24),
          vector: Array.from(entry.vector, (value) => Number(value)),
        },
      ]
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}

function frameIndexDigest(index, keyByFramePath) {
  const exactRows = []
  const stableRows = []
  for (const [imagePath, vector] of index) {
    const frameKey = keyByFramePath.get(path.resolve(imagePath).toLowerCase())
    if (!frameKey) continue
    const values = Array.from(vector)
    exactRows.push(`${frameKey}\u001f${values.join(',')}`)
    stableRows.push(`${frameKey}\u001f${values.map((value) => value.toFixed(4)).join(',')}`)
  }
  return {
    count: exactRows.length,
    sha256: sha256Text(exactRows.sort().join('\n')),
    stableSha256: sha256Text(stableRows.sort().join('\n')),
    stableDecimalPlaces: 4,
  }
}

function directoryBytes(root) {
  let files = 0
  let bytes = 0
  const queue = fs.existsSync(root) ? [root] : []
  while (queue.length > 0) {
    const directory = queue.shift()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(filePath)
      else if (entry.isFile()) {
        files += 1
        bytes += fs.statSync(filePath).size
      }
    }
  }
  return { files, bytes }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  if (!['cpu', 'gpu'].includes(options.backend)) throw new Error('Use --backend=cpu or gpu')
  if (!['serial', 'overlap'].includes(options.pipeline)) {
    throw new Error('Use --pipeline=serial or overlap')
  }
  for (const child of [
    'embeddingPreparationChild.js',
    'dinoEmbeddingChild.js',
    'clipEmbeddingChild.js',
  ]) {
    if (!fs.existsSync(path.join(options.childrenDir, child))) {
      throw new Error(`Compiled child missing: ${path.join(options.childrenDir, child)}`)
    }
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-media-prep-'))
  let source
  let sourceSnapshotBefore
  let sourceVerified = false
  let resourceMonitor
  let embeddingService
  let ffmpegService
  const originalAppData = process.env.APPDATA
  const originalResourcesPath = process.resourcesPath
  const originalLoad = Module._load
  const originalConsoleLog = console.log
  const appDataPath = path.join(tempRoot, 'appdata')
  const userDataPath = path.join(appDataPath, 'siftory-desktop')
  const mediaSearchDir = path.join(tempRoot, 'media-search')
  fs.mkdirSync(userDataPath, { recursive: true })

  try {
    if (options.source) {
      if (!fs.existsSync(options.source))
        throw new Error('The selected video source does not exist')
      const collected = collectVideos(options.source, options.limit)
      source = {
        ...collected,
        files: collected.files.slice(0, options.limit),
        generationMs: 0,
        kinds: ['external'],
        kind: 'external-read-only',
      }
    } else {
      source = {
        ...createSyntheticFixtures(tempRoot, options),
        kind: 'deterministic-synthetic',
      }
    }
    if (source.files.length === 0) throw new Error('The selected source contains no videos')
    sourceSnapshotBefore = snapshotFiles(source.files)

    process.env.APPDATA = appDataPath
    process.resourcesPath = options.childrenDir
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') {
        return createElectronMock(appDataPath, userDataPath, options.appRoot)
      }
      return originalLoad.call(this, request, parent, isMain)
    }
    console.log = (...values) => {
      if (typeof values[0] === 'string' && values[0].startsWith('[MediaSearch] data dir:')) {
        process.stderr.write('[MediaSearch] data dir: <isolated-temp>\n')
        return
      }
      originalConsoleLog(...values)
    }

    resourceMonitor = await startResourceMonitor()
    const totalStartedAt = performance.now()
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      safety: {
        sourceDatasetReadOnly: true,
        isolatedUserData: true,
        sourceKind: source.kind,
        tempDirectoryId: path.basename(tempRoot),
        sourceSnapshot: sourceSnapshotBefore,
      },
      config: {
        sourceVideoCount: source.files.length,
        sourceKinds: source.kinds,
        fixtureGenerationMsExcluded: source.generationMs,
        backend: options.backend,
        pipeline: options.pipeline,
        jobs: options.jobs,
        batchSize: options.batchSize,
        framePolicy: {
          intervalMs: options.intervalMs ?? 'production-default',
          maxFramesPerVideo: options.maxFramesPerVideo ?? 'production-default',
          width: options.width ?? 'production-default',
        },
      },
      phases: {},
    }

    const mediaCache = loadTsModule('electron/mediaCacheService.ts')
    mediaCache.setMediaSearchDirForTests(mediaSearchDir)
    ffmpegService = loadTsModule('electron/ffmpegService.ts')
    const videoScan = loadTsModule('electron/videoScanService.ts')
    const videoFrames = loadTsModule('electron/videoFrameService.ts')
    const modelService = loadTsModule('electron/modelService.ts')
    const vectorDb = loadTsModule('electron/vectorDatabaseService.ts')
    embeddingService = loadTsModule('electron/embeddingService.ts')
    const frameIndex = loadTsModule('electron/mediaSearchFrameIndex.ts')
    // The production task queue imports the coordinator for both modes. Load it
    // symmetrically so TypeScript test-loader module state is not charged only
    // to the overlap candidate's RSS and end-to-end time.
    const preparationPipeline = loadTsModule('electron/mediaPreparationPipeline.ts')

    const serviceStartedAt = performance.now()
    const toolStatus = ffmpegService.getFfmpegStatus(true)
    assert.equal(toolStatus.ffmpeg.available, true, JSON.stringify(toolStatus))
    assert.equal(toolStatus.ffprobe.available, true, JSON.stringify(toolStatus))
    modelService.initModelService(userDataPath)
    vectorDb.initVectorDatabase(userDataPath)
    report.phases.serviceAndToolInitMs = Number((performance.now() - serviceStartedAt).toFixed(2))
    report.tools = {
      ffmpeg: {
        available: true,
        command: path.basename(toolStatus.ffmpeg.command),
        version: toolStatus.ffmpeg.version,
      },
      ffprobe: {
        available: true,
        command: path.basename(toolStatus.ffprobe.command),
        version: toolStatus.ffprobe.version,
      },
    }

    report.models = {}
    for (const modelName of ['dinov2_vitb14', 'clip_vit_base_patch32']) {
      const status = modelService.getModelStatus(modelName)
      report.models[modelName] = { state: status.state, version: status.version }
      assert.equal(status.state, 'downloaded', JSON.stringify(status))
    }

    const scanProgress = []
    const scanStartedAt = performance.now()
    const scanResult = await videoScan.scanVideoFiles({
      paths: source.files,
      onProgress: (progress) => {
        if (scanProgress.length === 0 || progress.processedVideos === progress.videoCount) {
          scanProgress.push({
            phase: progress.phase,
            currentName: progress.currentPath ? path.basename(progress.currentPath) : undefined,
            scannedEntries: progress.scannedEntries,
            videoCount: progress.videoCount,
            processedVideos: progress.processedVideos,
            failed: progress.failed,
          })
        }
      },
    })
    report.phases.scanAndVideoManifestCommitMs = Number(
      (performance.now() - scanStartedAt).toFixed(2),
    )
    assert.equal(scanResult.records.length, source.files.length)
    const videoKeys = new Map(
      scanResult.records.map((record) => [record.videoId, sourceKey(source.root, record.path)]),
    )
    report.scan = {
      discovered: scanResult.discovered,
      updated: scanResult.updated,
      unchanged: scanResult.unchanged,
      failed: scanResult.failed,
      scannedEntries: scanResult.scannedEntries,
      capped: scanResult.capped,
      progressSamples: scanProgress,
      digest: videoDigest(scanResult.records, source.root),
      metadataErrors: scanResult.records.filter((record) => record.metadataStatus === 'error')
        .length,
      thumbnailErrors: scanResult.records.filter((record) => record.thumbnailStatus === 'error')
        .length,
    }

    let frameResult
    let readyFrames
    let indexResult
    const frameProgress = []
    if (options.pipeline === 'overlap') {
      const pipelineResult = await preparationPipeline.runMediaPreparationPipeline({
        videos: scanResult.records,
        backend: options.backend,
        maxConcurrentEmbeddings: options.jobs,
        batchSize: options.batchSize,
        ...(options.intervalMs ? { frameIntervalMs: options.intervalMs } : {}),
        ...(options.maxFramesPerVideo ? { maxFramesPerVideo: options.maxFramesPerVideo } : {}),
        ...(options.width ? { frameWidth: options.width } : {}),
        modelWaitTimeoutMs: options.timeoutMs,
        onProgress: (progress) => {
          if (
            frameProgress.length === 0 ||
            progress.frameIndexComplete ||
            frameProgress.length % 10 === 0
          ) {
            frameProgress.push({
              phase: progress.phase,
              completed: progress.extractionProcessed,
              total: progress.extractionTotal,
              failed: progress.extractionFailed,
              committedFrames: progress.committedFrames,
              percentage: progress.percentage,
            })
          }
        },
      })
      frameResult = pipelineResult.frameResult
      readyFrames = videoFrames.loadReadyVideoFrameManifest()
      indexResult = { entries: pipelineResult.frameIndexEntries, errors: 0 }
      report.pipeline = pipelineResult.timings
      report.phases.frameExtractionAndManifestCommitMs = Number(
        pipelineResult.timings.frameExtractionMs.toFixed(2),
      )
      report.phases.dinoReadyFromPipelineStartMs = Number(
        pipelineResult.timings.dinoReadyMs.toFixed(2),
      )
      report.phases.clipReadyFromPipelineStartMs = Number(
        pipelineResult.timings.clipReadyMs.toFixed(2),
      )
      report.phases.frameIndexCommitMs = Number(pipelineResult.timings.frameIndexMs.toFixed(2))
      report.dino = {
        totalMs: null,
        progress: {
          state: 'done',
          total: readyFrames.length,
          completed: readyFrames.length,
          failed: 0,
          skipped: 0,
          running: 0,
          pending: 0,
        },
        progressSamples: [],
      }
      report.clip = {
        totalMs: null,
        progress: {
          state: 'done',
          total: readyFrames.length,
          completed: readyFrames.length,
          failed: 0,
          skipped: 0,
          running: 0,
          pending: 0,
        },
        progressSamples: [],
      }
    } else {
      const frameStartedAt = performance.now()
      frameResult = await videoFrames.buildVideoFrameIndex({
        videos: scanResult.records,
        ...(options.intervalMs ? { intervalMs: options.intervalMs } : {}),
        ...(options.maxFramesPerVideo ? { maxFramesPerVideo: options.maxFramesPerVideo } : {}),
        ...(options.width ? { width: options.width } : {}),
        onProgress: (progress) => {
          if (
            frameProgress.length === 0 ||
            progress.completed === progress.total ||
            frameProgress.length % 10 === 0
          ) {
            frameProgress.push({
              currentName: progress.currentPath ? path.basename(progress.currentPath) : undefined,
              completed: progress.completed,
              total: progress.total,
              failed: progress.failed,
              itemsPerSecond: progress.itemsPerSecond,
            })
          }
        },
      })
      report.phases.frameExtractionAndManifestCommitMs = Number(
        (performance.now() - frameStartedAt).toFixed(2),
      )
      readyFrames = videoFrames.loadReadyVideoFrameManifest()
      const imageIds = readyFrames.map((record) => record.imagePath)
      const baseEmbeddingRequest = {
        embeddingType: 'global',
        imageIds,
        backend: options.backend,
        maxConcurrentEmbeddings: options.jobs,
        batchSize: options.batchSize,
      }
      const dino = await runEmbeddingPhase(
        embeddingService,
        { ...baseEmbeddingRequest, modelName: 'dinov2_vitb14' },
        options.timeoutMs,
      )
      report.phases.dinoPreparationMs = dino.preparationMs
      report.phases.dinoInferencePersistenceMs = dino.inferencePersistenceMs
      report.dino = dino
      const clip = await runEmbeddingPhase(
        embeddingService,
        { ...baseEmbeddingRequest, modelName: 'clip_vit_base_patch32' },
        options.timeoutMs,
      )
      report.phases.clipPreparationMs = clip.preparationMs
      report.phases.clipInferencePersistenceMs = clip.inferencePersistenceMs
      report.clip = clip
      const indexStartedAt = performance.now()
      indexResult = await frameIndex.buildFrameIndexAsync()
      report.phases.frameIndexCommitMs = Number((performance.now() - indexStartedAt).toFixed(2))
    }

    assert.equal(readyFrames.length, frameResult.completed)
    const frameMaps = frameKeyMaps(frameResult.records, videoKeys)
    report.frames = {
      total: frameResult.total,
      completed: frameResult.completed,
      failed: frameResult.failed,
      unavailable: frameResult.unavailable,
      preserved: frameResult.preserved,
      sourceChanged: frameResult.sourceChanged,
      ready: readyFrames.length,
      progressSamples: frameProgress,
      digest: frameMaps.digest,
    }
    assert.ok(readyFrames.length > 0, 'The fixed corpus produced no searchable frames')
    assert.equal(indexResult.errors, 0)
    assert.equal(indexResult.entries, readyFrames.length * 2)

    const verificationStartedAt = performance.now()
    const dinoEntries = vectorDb.getEmbeddingsByModel('dinov2_vitb14', 'global')
    const clipEntries = vectorDb.getEmbeddingsByModel('clip_vit_base_patch32', 'global')
    const dinoIndex = frameIndex.loadFrameIndex('dinov2_vitb14')
    const clipIndex = frameIndex.loadFrameIndex('clip_vit_base_patch32')
    const stats = await videoFrames.getFrameEmbeddingStats()
    assert.equal(stats.readyFrames, readyFrames.length)
    assert.equal(stats.dinoEmbeddedFrames, readyFrames.length)
    assert.equal(stats.clipEmbeddedFrames, readyFrames.length)
    assert.equal(dinoIndex.size, readyFrames.length)
    assert.equal(clipIndex.size, readyFrames.length)
    report.embeddingDigests = {
      dino: embeddingDigest(dinoEntries, frameMaps.keyByFramePath),
      clip: embeddingDigest(clipEntries, frameMaps.keyByFramePath),
    }
    report.embeddingComparison = {
      dino: embeddingComparisonRows(dinoEntries, frameMaps.keyByFramePath),
      clip: embeddingComparisonRows(clipEntries, frameMaps.keyByFramePath),
    }
    report.frameIndex = {
      result: indexResult,
      dino: frameIndexDigest(dinoIndex, frameMaps.keyByFramePath),
      clip: frameIndexDigest(clipIndex, frameMaps.keyByFramePath),
    }
    assert.equal(report.embeddingDigests.dino.count, readyFrames.length)
    assert.equal(report.embeddingDigests.clip.count, readyFrames.length)
    assert.equal(report.frameIndex.dino.count, readyFrames.length)
    assert.equal(report.frameIndex.clip.count, readyFrames.length)
    report.frameEmbeddingStats = stats
    report.phases.verificationMs = Number((performance.now() - verificationStartedAt).toFixed(2))
    report.phases.libraryReadyMs = Number((performance.now() - totalStartedAt).toFixed(2))
    report.phases.workflowReadySignalMs = report.phases.libraryReadyMs
    report.milestones = {
      searchableServiceMs: report.phases.libraryReadyMs,
      workflowReadySignalMs: report.phases.workflowReadySignalMs,
      rendererPaintMeasured: false,
    }
    report.phases.totalMs = report.phases.libraryReadyMs
    report.storage = {
      mediaSearch: directoryBytes(mediaSearchDir),
      userData: directoryBytes(userDataPath),
      frames: directoryBytes(path.join(mediaSearchDir, 'frames')),
      vectorDb: directoryBytes(path.join(userDataPath, 'vector-db')),
    }
    report.resources = await resourceMonitor.stop()
    resourceMonitor = null
    const sourceSnapshotAfter = snapshotFiles(source.files)
    assertFileSnapshotUnchanged(sourceSnapshotBefore, sourceSnapshotAfter)
    sourceVerified = true
    report.safety.sourceUnchanged = true
    report.ok = true

    const summary = {
      ok: true,
      sourceVideoCount: source.files.length,
      phases: report.phases,
      resources: report.resources,
      scan: report.scan,
      frames: report.frames,
      dino: report.embeddingDigests.dino,
      clip: report.embeddingDigests.clip,
      frameIndex: report.frameIndex,
      frameEmbeddingStats: report.frameEmbeddingStats,
      storage: report.storage,
      safety: report.safety,
    }
    const publicReport = redactPaths(report, [
      [source.root, '<source-corpus>'],
      [tempRoot, '<isolated-temp>'],
      [options.appRoot, '<app-root>'],
    ])
    if (options.jsonOut) writeJson(options.jsonOut, publicReport)
    if (options.compact) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    else {
      process.stdout.write(`${JSON.stringify(publicReport, null, 2)}\n`)
      process.stderr.write(`[media-preparation-summary] ${JSON.stringify(summary)}\n`)
    }
  } finally {
    if (embeddingService) {
      const state = embeddingService.getEmbeddingProgress?.().state
      if (['queued', 'running', 'paused', 'stopping'].includes(state)) {
        embeddingService.stopEmbeddingBuild?.()
      }
    }
    ffmpegService?.cancelRunningMediaTools?.()
    if (resourceMonitor) await resourceMonitor.stop().catch(() => undefined)
    Module._load = originalLoad
    console.log = originalConsoleLog
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    process.resourcesPath = originalResourcesPath
    if (sourceSnapshotBefore && source && !sourceVerified) {
      const sourceSnapshotAfter = snapshotFiles(source.files)
      assertFileSnapshotUnchanged(sourceSnapshotBefore, sourceSnapshotAfter)
    }
    if (options.keepTemp) process.stderr.write(`Kept temporary output: ${tempRoot}\n`)
    else safeRemoveTempRoot(tempRoot, 'siftory-media-prep-')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
