const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { spawnSync } = require('node:child_process')
const sharp = require('sharp')

const {
  assertFileSnapshotUnchanged,
  safeRemoveTempRoot,
  snapshotFiles,
  startResourceMonitor,
  writeJson,
} = require('./search-library-preparation-benchmark-utils.cjs')

const projectRoot = path.resolve(__dirname, '..')

function option(argv, name, fallback) {
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
}

function parseArgs(argv) {
  const sourceType = option(argv, 'source-type', 'local')
  const defaultMode = sourceType === 'local' ? 'single-input' : 'multi-input'
  return {
    sourceType,
    mode: option(argv, 'mode', defaultMode),
    fixtureSeconds: Math.max(
      45,
      Math.min(300, Number(option(argv, 'fixture-seconds', '120')) || 120),
    ),
    width: Math.max(128, Math.min(640, Number(option(argv, 'width', '256')) || 256)),
    jsonOut: option(argv, 'json-out', ''),
    keepTemp: argv.includes('--keep-temp'),
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

function printHelp() {
  process.stdout.write(`Usage:
  node tests/video-frame-extraction-benchmark.cjs [options]

Options:
  --source-type=local|mounted-network
  --mode=legacy|single-input       Local extraction mode
  --mode=multi-input|single-input Mounted-network extraction mode
  --fixture-seconds=<45..300>      CFR fixture duration (default: 120)
  --width=<128..640>               Output frame width (default: 256)
  --json-out=<file>                Write the isolated run report
  --keep-temp                      Keep the validated temp root
`)
}

function runFfmpeg(ffmpeg, args) {
  const result = spawnSync(ffmpeg, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || `FFmpeg exited ${result.status}`)
  }
}

function createFixtures(root, ffmpeg, durationSeconds) {
  const fixtureRoot = path.join(root, 'source-fixtures')
  fs.mkdirSync(fixtureRoot, { recursive: true })
  const cfr = path.join(fixtureRoot, 'long-cfr.mp4')
  const vfr = path.join(fixtureRoot, 'long-vfr.mkv')
  const damaged = path.join(fixtureRoot, 'damaged-truncated.mp4')
  const vfrSeconds = Math.max(45, Math.floor(durationSeconds * 0.75))
  runFfmpeg(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=320x180:rate=30:duration=${durationSeconds}`,
    '-an',
    '-c:v',
    'mpeg4',
    '-q:v',
    '5',
    '-pix_fmt',
    'yuv420p',
    cfr,
  ])
  runFfmpeg(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=320x180:rate=30:duration=${vfrSeconds}`,
    '-vf',
    "select='if(lt(t,20),not(mod(n,2)),not(mod(n,5)))'",
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
  return [
    { kind: 'cfr', path: cfr, durationMs: durationSeconds * 1000 },
    { kind: 'vfr', path: vfr, durationMs: vfrSeconds * 1000 },
    { kind: 'damaged-truncated', path: damaged, durationMs: 3000 },
  ]
}

function videoRecord(fixture, sourceType) {
  const stat = fs.statSync(fixture.path)
  return {
    videoId: `benchmark-${fixture.kind}`,
    path: fixture.path,
    name: path.basename(fixture.path),
    ext: path.extname(fixture.path),
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    durationMs: fixture.durationMs,
    width: 320,
    height: 180,
    metadataStatus: fixture.kind === 'damaged-truncated' ? 'error' : 'done',
    sourceType: sourceType === 'mounted-network' ? 'mounted-network' : undefined,
    discoveredAt: 1,
    updatedAt: 1,
  }
}

function digestFrames(records) {
  const rows = records
    .map((record) => {
      const digest =
        record.status === 'done' && record.imagePath && fs.existsSync(record.imagePath)
          ? crypto.createHash('sha256').update(fs.readFileSync(record.imagePath)).digest('hex')
          : ''
      return [record.videoId, record.timestampMs, record.width, record.status, digest].join(
        '\u001f',
      )
    })
    .sort()
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex')
}

function findPrivateFiles(root) {
  const found = []
  const queue = fs.existsSync(root) ? [root] : []
  while (queue.length > 0) {
    const directory = queue.shift()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(filePath)
      else if (entry.name.includes('.partial') || entry.name.endsWith('.tmp')) found.push(filePath)
    }
  }
  return found
}

async function verifyImages(records, expectedWidth) {
  const ready = records.filter((record) => record.status === 'done')
  const metadata = await Promise.all(ready.map((record) => sharp(record.imagePath).metadata()))
  for (const image of metadata) {
    assert.equal(image.width, expectedWidth)
    assert.ok(Number(image.height) > 0)
    assert.equal(image.format, 'jpeg')
  }
  return ready.length
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  if (!['local', 'mounted-network'].includes(options.sourceType)) {
    throw new Error('Use --source-type=local or mounted-network')
  }
  const validModes =
    options.sourceType === 'local' ? ['legacy', 'single-input'] : ['multi-input', 'single-input']
  if (!validModes.includes(options.mode)) {
    throw new Error(`Use --mode=${validModes.join(' or ')}`)
  }

  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const ffmpegDirectory = path.join(projectRoot, 'tools', 'ffmpeg', 'bin')
  const ffmpeg = path.join(ffmpegDirectory, executable)
  if (!fs.existsSync(ffmpeg)) throw new Error(`FFmpeg fixture tool is missing: ${ffmpeg}`)

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-frame-extraction-'))
  let monitor
  try {
    const fixtures = createFixtures(tempRoot, ffmpeg, options.fixtureSeconds)
    const sourcePaths = fixtures.map((fixture) => fixture.path)
    const sourceBefore = snapshotFiles(sourcePaths)
    const mediaDir = path.join(tempRoot, 'media-search')

    // Load FFmpeg consumers only after the sampler has replaced child_process
    // functions, otherwise their named imports would bypass process accounting.
    monitor = await startResourceMonitor()
    const { loadTsModule } = require('./guard-utils.cjs')
    const mediaCache = loadTsModule('electron/mediaCacheService.ts')
    const ffmpegService = loadTsModule('electron/ffmpegService.ts')
    const videoFrames = loadTsModule('electron/videoFrameService.ts')
    mediaCache.setMediaSearchDirForTests(mediaDir)
    ffmpegService.setConfiguredFfmpegDir(ffmpegDirectory)
    const toolStatus = ffmpegService.getFfmpegStatus(true)
    assert.equal(toolStatus.ffmpeg.available, true, toolStatus.ffmpeg.error)

    const records = fixtures.map((fixture) => videoRecord(fixture, options.sourceType))
    const extractionStartedAt = performance.now()
    const result = await videoFrames.buildVideoFrameIndex({
      videos: records,
      width: options.width,
      ...(options.sourceType === 'local'
        ? { localFrameExtractionMode: options.mode }
        : { networkFrameExtractionMode: options.mode }),
    })
    const extractionMs = Number((performance.now() - extractionStartedAt).toFixed(2))
    const resources = await monitor.stop()
    monitor = null

    const sourceAfter = snapshotFiles(sourcePaths)
    assertFileSnapshotUnchanged(sourceBefore, sourceAfter)
    const manifestPath = path.join(mediaDir, 'manifests', 'video_frames.jsonl')
    const manifestRows = fs
      .readFileSync(manifestPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
    assert.equal(manifestRows.length, result.records.length)
    assert.equal(result.failed, 1)
    assert.equal(result.unavailable, 0)
    assert.equal(await verifyImages(result.records, options.width), result.completed)
    assert.deepEqual(findPrivateFiles(mediaDir), [])

    const ffmpegLabel = path.basename(toolStatus.ffmpeg.command)
    const totalFfmpegStarts = Number(resources.processes.byCommand[ffmpegLabel]) || 0
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      config: {
        sourceType: options.sourceType,
        mode: options.mode,
        fixtureSeconds: options.fixtureSeconds,
        width: options.width,
      },
      extractionMs,
      frames: {
        total: result.total,
        completed: result.completed,
        failed: result.failed,
        unavailable: result.unavailable,
        preserved: result.preserved,
        digest: digestFrames(result.records),
      },
      resources,
      extractionProcessStarts: Math.max(0, totalFfmpegStarts - 1),
      correctness: {
        sourceUnchanged: true,
        manifestRows: manifestRows.length,
        decodableJpegs: result.completed,
        privateFilesLeft: 0,
      },
      safety: {
        isolatedOutput: true,
        sourceReadOnly: true,
        sourceKinds: fixtures.map((fixture) => fixture.kind),
      },
      ok: true,
    }
    if (options.jsonOut) writeJson(options.jsonOut, report)
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } finally {
    if (monitor) await monitor.stop().catch(() => undefined)
    if (options.keepTemp) process.stderr.write(`Kept temporary output: ${tempRoot}\n`)
    else safeRemoveTempRoot(tempRoot, 'siftory-frame-extraction-')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
