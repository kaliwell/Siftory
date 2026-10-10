const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { loadTsModule } = require('./guard-utils.cjs')

const ffmpegService = loadTsModule('electron/ffmpegService.ts')
const mediaCacheService = loadTsModule('electron/mediaCacheService.ts')
const videoFrameService = loadTsModule('electron/videoFrameService.ts')

const projectRoot = path.resolve(__dirname, '..')
const ffmpegDirectory = path.join(projectRoot, 'tools', 'ffmpeg', 'bin')
const ffmpeg = path.join(ffmpegDirectory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const ffprobe = path.join(ffmpegDirectory, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}

function createFixture(root, kind = 'cfr', durationSeconds = 12) {
  const outputPath = path.join(root, `${kind}.mkv`)
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=320x180:rate=30:duration=${durationSeconds}`,
  ]
  if (kind === 'vfr') {
    args.push('-vf', "select='if(lt(t,4),not(mod(n,2)),not(mod(n,5)))'", '-fps_mode', 'vfr')
  }
  args.push('-an', '-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p', outputPath)
  run(ffmpeg, args)
  return outputPath
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function imageDimensions(filePath) {
  const output = run(ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    filePath,
  ])
  const stream = JSON.parse(output).streams[0]
  return { width: stream.width, height: stream.height }
}

function partialFiles(root) {
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

function videoRecord(filePath, durationMs, videoId = 'video-fixture') {
  const stat = fs.statSync(filePath)
  return {
    videoId,
    path: filePath,
    name: path.basename(filePath),
    ext: path.extname(filePath),
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    durationMs,
    width: 320,
    height: 180,
    metadataStatus: 'done',
    discoveredAt: 1,
    updatedAt: 1,
  }
}

function frameSummary(result) {
  return result.records.map((record) => ({
    timestampMs: record.timestampMs,
    width: record.width,
    status: record.status,
    digest:
      record.status === 'done' && record.imagePath && fs.existsSync(record.imagePath)
        ? sha256(record.imagePath)
        : '',
  }))
}

ffmpegService.setConfiguredFfmpegDir(ffmpegDirectory)

test(
  'single-input frame extraction is bitwise-equivalent to legacy whole-second CFR/VFR frames',
  { concurrency: false },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'single-input-frame-parity-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    assert.equal(ffmpegService.getFfmpegStatus(true).ffmpeg.available, true)

    for (const kind of ['cfr', 'vfr']) {
      const source = createFixture(root, kind)
      const timestamps = [1000, 4000, 7000]
      const legacyPaths = timestamps.map((timestampMs) =>
        path.join(root, `${kind}-legacy-${timestampMs}.jpg`),
      )
      const batchPaths = timestamps.map((timestampMs) =>
        path.join(root, `${kind}-batch-${timestampMs}.jpg`),
      )

      for (let index = 0; index < timestamps.length; index++) {
        const legacy = await ffmpegService.generateVideoCoverThumbnailAsync({
          filePath: source,
          outputPath: legacyPaths[index],
          timestampMs: timestamps[index],
          width: 160,
          preferHardwareDecode: false,
        })
        assert.equal(legacy.ok, true, legacy.error)
      }
      const batch = await ffmpegService.generateVideoFramesSingleInputAsync({
        filePath: source,
        frames: timestamps.map((timestampMs, index) => ({
          timestampMs,
          outputPath: batchPaths[index],
        })),
        width: 160,
        preferHardwareDecode: false,
      })
      assert.equal(batch.ok, true, batch.error)
      assert.equal(batch.created.size, timestamps.length)
      for (let index = 0; index < timestamps.length; index++) {
        assert.equal(sha256(batchPaths[index]), sha256(legacyPaths[index]))
        assert.deepEqual(imageDimensions(batchPaths[index]), { width: 160, height: 90 })
      }
    }
    assert.deepEqual(partialFiles(root), [])
  },
)

test(
  'single-input build falls back only for missing frames and matches legacy failure semantics',
  { concurrency: false },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'single-input-frame-fallback-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const source = createFixture(root, 'short', 3)
    const sourceDigest = sha256(source)
    const record = videoRecord(source, 16_000)

    const summaries = {}
    for (const mode of ['legacy', 'single-input']) {
      const mediaDir = path.join(root, `media-${mode}`)
      mediaCacheService.setMediaSearchDirForTests(mediaDir)
      const result = await videoFrameService.buildVideoFrameIndex({
        videos: [record],
        maxFramesPerVideo: 2,
        intervalMs: 8000,
        width: 160,
        localFrameExtractionMode: mode,
      })
      summaries[mode] = frameSummary(result)
      assert.equal(result.completed, 1)
      assert.equal(result.failed, 1)
      assert.equal(result.records.length, 2)
      assert.deepEqual(partialFiles(mediaDir), [])
    }
    assert.deepEqual(summaries['single-input'], summaries.legacy)
    assert.equal(sha256(source), sourceDigest)
  },
)

test(
  'cancelling an active single-input batch commits no private partial files and leaves a resumable manifest',
  { concurrency: false },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'single-input-frame-cancel-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const source = createFixture(root, 'cancel', 12)
    const mediaDir = path.join(root, 'media')
    mediaCacheService.setMediaSearchDirForTests(mediaDir)
    let cancelled = false
    const build = videoFrameService.buildVideoFrameIndex({
      videos: [videoRecord(source, 12_000)],
      localFrameExtractionMode: 'single-input',
      isCancelled: () => cancelled,
    })
    setImmediate(() => {
      cancelled = true
      ffmpegService.cancelRunningMediaTools()
    })
    const result = await build
    assert.ok(result.completed < result.total)
    assert.ok(result.records.some((record) => record.status !== 'done'))
    const manifestPath = path.join(mediaDir, 'manifests', 'video_frames.jsonl')
    const manifest = fs.readFileSync(manifestPath, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(manifest.length, result.records.length)
    assert.deepEqual(partialFiles(mediaDir), [])
  },
)

test(
  'frame manifest rename failure preserves the prior snapshot and removes its private temporary file',
  { concurrency: false },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-manifest-atomic-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const mediaDir = path.join(root, 'media')
    mediaCacheService.setMediaSearchDirForTests(mediaDir)
    mediaCacheService.ensureMediaSearchDirs()
    const manifestPath = path.join(mediaDir, 'manifests', 'video_frames.jsonl')
    const previous = `${JSON.stringify({
      frameId: 'a'.repeat(40),
      videoId: 'preserved-video',
      videoPath: path.join(root, 'source.mp4'),
      timestampMs: 1000,
      status: 'error',
      createdAt: 1,
      updatedAt: 1,
    })}\n`
    fs.writeFileSync(manifestPath, previous)
    videoFrameService.invalidateVideoFrameManifestCache()

    const originalRename = fs.renameSync
    fs.renameSync = (from, to) => {
      if (path.resolve(to) === path.resolve(manifestPath)) throw new Error('injected rename fault')
      return originalRename(from, to)
    }
    try {
      await assert.rejects(
        videoFrameService.buildVideoFrameIndex({ videos: [] }),
        /injected rename fault/,
      )
    } finally {
      fs.renameSync = originalRename
    }
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), previous)
    assert.deepEqual(partialFiles(mediaDir), [])
  },
)

test(
  'source revision changes after a committed frame batch invalidate every derived frame',
  { concurrency: false },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'single-input-source-revision-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const source = createFixture(root, 'revision', 12)
    const mediaDir = path.join(root, 'media')
    mediaCacheService.setMediaSearchDirForTests(mediaDir)
    let mutated = false
    const result = await videoFrameService.buildVideoFrameIndex({
      videos: [videoRecord(source, 12_000)],
      maxFramesPerVideo: 4,
      intervalMs: 3_000,
      width: 160,
      onCheckpoint: (checkpoint) => {
        if (mutated || checkpoint.kind !== 'checkpoint') return
        mutated = true
        fs.appendFileSync(source, Buffer.from([0]))
      },
    })

    assert.equal(mutated, true)
    assert.equal(result.sourceChanged, 1)
    assert.equal(result.completed, 0)
    assert.equal(result.failed, result.total)
    assert.equal(result.invalidatedImagePaths.length, result.total)
    assert.ok(result.records.every((record) => record.status === 'error'))
    assert.ok(
      result.invalidatedImagePaths.every((imagePath) => !fs.existsSync(imagePath)),
      'stale frame files must not survive source revision invalidation',
    )
  },
)
