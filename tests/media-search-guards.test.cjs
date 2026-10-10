const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  isRevealableMediaScanPath,
  isVideoPath,
  normalizeMediaSearchStartScanArgs,
  normalizeTaskId,
} = loadTsModule('electron/mediaSearchGuards.ts')
const { buildMediaToolCandidates, parseFfprobeMetadata } = loadTsModule('electron/ffmpegService.ts')
const {
  clearMediaSearchCache,
  ensureMediaSearchDirs,
  getMediaCacheStatsAsync,
  setMediaSearchDirForTests,
} = loadTsModule('electron/mediaCacheService.ts')
const {
  clearMediaSearchImageDataUrlCache,
  getMediaSearchImageDataUrlCacheStats,
  readMediaSearchImageDataUrl,
} = loadTsModule('electron/mediaSearchImageCache.ts')
const {
  getReadyVideoFrameCount,
  getVideoFramesDir,
  invalidateVideoFrameManifestCache,
  loadVideoFrameManifest,
  loadVideoFrameManifestPreview,
  planVideoFrameTimestamps,
} = loadTsModule('electron/videoFrameService.ts')
const { invalidateVideoManifestCache, loadVideoManifest, loadVideoManifestPreview } = loadTsModule(
  'electron/videoScanService.ts',
)

test('video and frame manifest caches are isolated by data directory path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-manifest-cache-scope-'))
  const firstDir = path.join(root, 'a')
  const secondDir = path.join(root, 'b')
  const timestamp = new Date('2026-01-01T00:00:00.000Z')

  try {
    for (const [dir, suffix] of [
      [firstDir, 'a'],
      [secondDir, 'b'],
    ]) {
      const manifestDir = path.join(dir, 'manifests')
      fs.mkdirSync(manifestDir, { recursive: true })
      const videoPath = path.join(root, `${suffix}.mp4`)
      const imagePath = path.join(root, `${suffix}.jpg`)
      fs.writeFileSync(videoPath, suffix)
      fs.writeFileSync(imagePath, suffix)
      const videoManifest = path.join(manifestDir, 'video_files.jsonl')
      const frameManifest = path.join(manifestDir, 'video_frames.jsonl')
      fs.writeFileSync(
        videoManifest,
        `${JSON.stringify({ videoId: suffix, path: videoPath, missing: false })}\n`,
      )
      fs.writeFileSync(
        frameManifest,
        `${JSON.stringify({
          frameId: suffix.repeat(40),
          videoId: suffix,
          videoPath,
          timestampMs: 1000,
          imagePath,
          status: 'done',
        })}\n`,
      )
      fs.utimesSync(videoManifest, timestamp, timestamp)
      fs.utimesSync(frameManifest, timestamp, timestamp)
    }

    setMediaSearchDirForTests(firstDir)
    assert.equal(loadVideoManifest()[0].videoId, 'a')
    assert.equal(loadVideoFrameManifest()[0].videoId, 'a')

    setMediaSearchDirForTests(secondDir)
    assert.equal(loadVideoManifest()[0].videoId, 'b')
    assert.equal(loadVideoFrameManifest()[0].videoId, 'b')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('video and frame preview caches avoid repeated manifest reads and invalidate by signature', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-manifest-preview-cache-'))
  setMediaSearchDirForTests(dir)
  ensureMediaSearchDirs()
  const videoManifest = path.join(dir, 'manifests', 'video_files.jsonl')
  const frameManifest = path.join(dir, 'manifests', 'video_frames.jsonl')
  const videoRow = (id) => ({
    videoId: `video-${id}`,
    path: path.join(dir, `${id}.mp4`),
    name: `${id}.mp4`,
    sizeBytes: id,
    missing: false,
    discoveredAt: id,
    updatedAt: id,
  })
  const frameRow = (id) => ({
    frameId: `frame-${id}`,
    videoId: `video-${id}`,
    videoPath: path.join(dir, `${id}.mp4`),
    timestampMs: id * 1000,
    status: 'done',
    createdAt: id,
    updatedAt: id,
  })
  fs.writeFileSync(
    videoManifest,
    `${JSON.stringify(videoRow(1))}\n${JSON.stringify(videoRow(2))}\n`,
  )
  fs.writeFileSync(
    frameManifest,
    `${JSON.stringify(frameRow(1))}\n${JSON.stringify(frameRow(2))}\n`,
  )
  invalidateVideoManifestCache()
  invalidateVideoFrameManifestCache()

  const originalReadFileSync = fs.readFileSync
  let manifestReads = 0
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (filePath === videoManifest || filePath === frameManifest) manifestReads += 1
    return originalReadFileSync.call(this, filePath, ...args)
  }
  try {
    assert.equal(loadVideoManifestPreview(1).total, 2)
    assert.equal(loadVideoFrameManifestPreview(1).total, 2)
    // Video previews read JSONL directly. Frame previews use the bounded SQLite
    // lookup, so they must not reintroduce a synchronous whole-file read.
    assert.equal(manifestReads, 1)

    assert.equal(loadVideoManifestPreview(2).total, 2)
    assert.equal(loadVideoFrameManifestPreview(2).total, 2)
    assert.equal(manifestReads, 1)

    fs.appendFileSync(videoManifest, `${JSON.stringify(videoRow(3))}\n`)
    fs.appendFileSync(frameManifest, `${JSON.stringify(frameRow(3))}\n`)
    assert.equal(loadVideoManifestPreview(2).total, 3)
    assert.equal(loadVideoFrameManifestPreview(2).total, 3)
    assert.equal(manifestReads, 2)
  } finally {
    fs.readFileSync = originalReadFileSync
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('media search guards accept existing video files and directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-search-'))
  const video = path.join(dir, 'clip.mp4')
  fs.writeFileSync(video, 'x')

  const result = normalizeMediaSearchStartScanArgs({
    paths: [video, dir, video],
    mode: 'metadata',
  })

  assert.ok(result)
  assert.equal(result.mode, 'metadata')
  assert.deepEqual(
    result.paths,
    [video, dir].map((p) => path.resolve(p)),
  )
})

test('media search guards reject empty or inaccessible scan requests', () => {
  assert.equal(normalizeMediaSearchStartScanArgs({ paths: [] }), null)
  assert.equal(normalizeMediaSearchStartScanArgs({ paths: ['Z:\\definitely-missing'] }), null)
  assert.equal(normalizeMediaSearchStartScanArgs(null), null)
})

test('media search guards identify supported video extensions', () => {
  assert.equal(isVideoPath('a.MP4'), true)
  assert.equal(isVideoPath('b.mkv'), true)
  assert.equal(isVideoPath('c.jpg'), false)
})

test('media search guards validate task ids', () => {
  assert.equal(normalizeTaskId('media-123_ok'), 'media-123_ok')
  assert.equal(normalizeTaskId('../bad'), undefined)
  assert.equal(normalizeTaskId(''), undefined)
})

test('revealable media scan path allows known roots case-insensitively', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-reveal-root-'))
  const knownRoots = new Set([path.normalize(dir).toLowerCase()])

  const isDirectory = () => false
  assert.equal(isRevealableMediaScanPath(dir, knownRoots, [], isDirectory), true)
  assert.equal(isRevealableMediaScanPath(dir.toUpperCase(), knownRoots, [], isDirectory), true)
})

test('revealable media scan path allows manifest ancestor directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-reveal-ancestor-'))
  const nested = path.join(dir, 'nested')
  fs.mkdirSync(nested, { recursive: true })
  const videoPath = path.join(nested, 'clip.mp4')
  const isDirectory = (p) => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  }

  assert.equal(isRevealableMediaScanPath(dir, new Set(), [videoPath], isDirectory), true)
  assert.equal(isRevealableMediaScanPath(nested, new Set(), [videoPath], isDirectory), true)
})

test('revealable media scan path rejects non-directories and unrelated paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-reveal-reject-'))
  const videoPath = path.join(dir, 'clip.mp4')
  fs.writeFileSync(videoPath, 'x')
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-reveal-other-'))
  const isDirectory = (p) => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  }

  // A manifest video file itself is not a directory and is not a known root.
  assert.equal(isRevealableMediaScanPath(videoPath, new Set(), [videoPath], isDirectory), false)
  // An existing directory unrelated to the manifest is rejected.
  assert.equal(isRevealableMediaScanPath(otherDir, new Set(), [videoPath], isDirectory), false)
  // A non-existent path is rejected.
  assert.equal(
    isRevealableMediaScanPath(path.join(dir, 'missing'), new Set(), [videoPath], isDirectory),
    false,
  )
})

test('ffprobe metadata parser extracts duration, streams and format', () => {
  const metadata = parseFfprobeMetadata(
    JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: { duration: '12.345', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
    }),
  )

  assert.deepEqual(metadata, {
    durationMs: 12345,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioCodec: 'aac',
    containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
  })
})

test('ffprobe metadata parser rejects malformed json', () => {
  assert.equal(parseFfprobeMetadata('{bad'), null)
})

test('ffmpeg tool discovery prefers configured and app-local candidates before PATH', () => {
  const candidates = buildMediaToolCandidates('ffmpeg', {
    FLOATING_CLOCK_FFMPEG_DIR: 'C:\\tools\\ffmpeg\\bin',
    FLOATING_CLOCK_RESOURCES_PATH: 'C:\\packaged\\resources',
    FFMPEG_PATH: 'C:\\custom\\ffmpeg.exe',
  })

  assert.equal(candidates[0], 'C:\\custom\\ffmpeg.exe')
  assert.equal(candidates[1], 'C:\\tools\\ffmpeg\\bin\\ffmpeg.exe')
  assert.equal(candidates[2], 'C:\\packaged\\resources\\tools\\ffmpeg\\bin\\ffmpeg.exe')
  assert.equal(candidates.at(-1), 'ffmpeg')
  assert.ok(candidates.some((candidate) => candidate.endsWith('tools\\ffmpeg\\bin\\ffmpeg.exe')))
})

test('media cache clear removes disposable cache but keeps searchable data and tool config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-cache-clear-'))
  setMediaSearchDirForTests(dir)
  ensureMediaSearchDirs()

  const manifestFile = path.join(dir, 'manifests', 'video_files.jsonl')
  const thumbnailFile = path.join(dir, 'thumbnails', 'video-1', 'cover.jpg')
  const frameFile = path.join(dir, 'frames', 'video-1', 'frame.jpg')
  const toolConfigFile = path.join(dir, 'tool-config.json')
  fs.mkdirSync(path.dirname(thumbnailFile), { recursive: true })
  fs.mkdirSync(path.dirname(frameFile), { recursive: true })
  fs.writeFileSync(manifestFile, '{"videoId":"1"}\n')
  fs.writeFileSync(thumbnailFile, 'thumb')
  fs.writeFileSync(frameFile, 'frame')
  fs.writeFileSync(toolConfigFile, '{"ffmpegDir":"C:\\\\tools"}')

  const result = clearMediaSearchCache()

  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(manifestFile), true)
  assert.equal(fs.existsSync(thumbnailFile), false)
  assert.equal(fs.existsSync(frameFile), true)
  assert.equal(fs.existsSync(toolConfigFile), true)
  assert.equal(fs.existsSync(path.join(dir, 'manifests')), true)
  assert.equal(fs.existsSync(path.join(dir, 'thumbnails')), true)
  assert.equal(fs.existsSync(path.join(dir, 'frames')), true)
  assert.ok(result.deletedEntries >= 1)
  assert.ok(result.freedBytes >= 5)
})

test('media cache inventory is asynchronous, one-pass, and category accurate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-cache-stats-'))
  setMediaSearchDirForTests(dir)
  ensureMediaSearchDirs()
  const fixtures = [
    ['manifests', 'manifest.bin', 11],
    ['thumbnails', 'thumb.bin', 13],
    ['frames', 'frame.bin', 17],
    ['vectors', 'vector.bin', 19],
    ['temp', 'temp.bin', 23],
    ['transcripts', 'transcript.bin', 29],
  ]
  try {
    for (const [folder, name, bytes] of fixtures) {
      fs.writeFileSync(path.join(dir, folder, name), Buffer.alloc(bytes))
    }
    let timerFired = false
    const timer = new Promise((resolve) =>
      setTimeout(() => {
        timerFired = true
        resolve()
      }, 0),
    )
    const [stats] = await Promise.all([getMediaCacheStatsAsync({ force: true }), timer])
    assert.equal(timerFired, true)
    assert.equal(stats.totalBytes, 112)
    assert.equal(stats.manifestBytes, 11)
    assert.equal(stats.thumbnailBytes, 13)
    assert.equal(stats.frameBytes, 17)
    assert.equal(stats.vectorBytes, 19)
    assert.equal(stats.tempBytes, 23)
  } finally {
    setMediaSearchDirForTests('')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('video frame timestamp planner spreads samples uniformly across the full duration', () => {
  assert.deepEqual(planVideoFrameTimestamps(35_000, 4, 10_000), [1000, 12000, 23000])
  assert.deepEqual(planVideoFrameTimestamps(500, 4, 10_000), [0])
  assert.equal(planVideoFrameTimestamps(20 * 60_000, 12, 1000).length, 12)
})

test('default policy is 20 frames per minute with full-duration coverage', () => {
  // 1 hour → 1200 frames, from ~1s to the final minute (not just the opening)
  const hour = planVideoFrameTimestamps(3_600_000)
  assert.equal(hour.length, 1200)
  assert.equal(hour[0], 1000)
  assert.ok(hour[hour.length - 1] <= 3_599_000)
  assert.ok(hour[hour.length - 1] > 3_590_000)
  assert.ok(Math.abs(hour[1] - hour[0] - 2999) <= 1)
  // past the 3600-frame cap the spacing widens but stays uniform to the tail
  const fourHours = planVideoFrameTimestamps(4 * 3_600_000)
  assert.equal(fourHours.length, 3600)
  assert.ok(fourHours[fourHours.length - 1] <= 4 * 3_600_000 - 1000)
  assert.ok(fourHours[fourHours.length - 1] > 4 * 3_600_000 - 10_000)
})

test('video frame manifest loader skips malformed frame records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-frame-list-'))
  setMediaSearchDirForTests(dir)
  ensureMediaSearchDirs()
  fs.writeFileSync(
    path.join(dir, 'manifests', 'video_frames.jsonl'),
    [
      JSON.stringify({
        frameId: 'frame-1',
        videoId: 'video-1',
        videoPath: path.join(dir, 'clip.mp4'),
        timestampMs: 1000,
        status: 'done',
        createdAt: 1,
        updatedAt: 1,
      }),
      '{bad',
      JSON.stringify({ frameId: 'missing-required-fields' }),
    ].join('\n'),
  )

  const frames = loadVideoFrameManifest()

  assert.equal(frames.length, 1)
  assert.equal(frames[0].frameId, 'frame-1')
  assert.equal(frames[0].timestampMs, 1000)
})

test('ready video frame count only includes existing done images', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-frame-ready-'))
  setMediaSearchDirForTests(dir)
  ensureMediaSearchDirs()
  const frameDir = getVideoFramesDir()
  const readyImage = path.join(frameDir, 'video-1', 'ready.jpg')
  const missingImage = path.join(frameDir, 'video-1', 'missing.jpg')
  fs.mkdirSync(path.dirname(readyImage), { recursive: true })
  fs.writeFileSync(readyImage, 'jpg')
  fs.writeFileSync(
    path.join(dir, 'manifests', 'video_frames.jsonl'),
    [
      JSON.stringify({
        frameId: 'ready',
        videoId: 'video-1',
        videoPath: path.join(dir, 'clip.mp4'),
        timestampMs: 1000,
        imagePath: readyImage,
        status: 'done',
        createdAt: 1,
        updatedAt: 1,
      }),
      JSON.stringify({
        frameId: 'missing',
        videoId: 'video-1',
        videoPath: path.join(dir, 'clip.mp4'),
        timestampMs: 2000,
        imagePath: missingImage,
        status: 'done',
        createdAt: 1,
        updatedAt: 1,
      }),
      JSON.stringify({
        frameId: 'error',
        videoId: 'video-1',
        videoPath: path.join(dir, 'clip.mp4'),
        timestampMs: 3000,
        imagePath: readyImage,
        status: 'error',
        createdAt: 1,
        updatedAt: 1,
      }),
    ].join('\n'),
  )

  assert.equal(getReadyVideoFrameCount(), 1)
})

test('frame image data URL rejects symlink escape outside the cache root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-image-cache-guard-'))
  const mediaDir = path.join(root, 'media-search')
  const outsideDir = path.join(root, 'outside')
  try {
    fs.mkdirSync(mediaDir, { recursive: true })
    fs.mkdirSync(outsideDir, { recursive: true })
    const insideImage = path.join(mediaDir, 'frame.jpg')
    const outsideImage = path.join(outsideDir, 'secret.jpg')
    fs.writeFileSync(insideImage, 'inside')
    fs.writeFileSync(outsideImage, 'outside')
    setMediaSearchDirForTests(mediaDir)

    // Legitimate file inside the cache root is readable.
    assert.ok(readMediaSearchImageDataUrl(insideImage)?.startsWith('data:image/jpeg;base64,'))
    // Direct outside path is rejected.
    assert.equal(readMediaSearchImageDataUrl(outsideImage), undefined)

    // A junction inside the cache root pointing outside must also be rejected.
    const junctionDir = path.join(mediaDir, 'escape-dir')
    try {
      fs.symlinkSync(outsideDir, junctionDir, 'junction')
    } catch (error) {
      t.skip(`junction creation unavailable: ${error.message}`)
      return
    }
    assert.equal(readMediaSearchImageDataUrl(path.join(junctionDir, 'secret.jpg')), undefined)
  } finally {
    setMediaSearchDirForTests('')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('frame image data URL cache reports and clears its bounded byte budget', () => {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-image-cache-budget-'))
  const imagePath = path.join(mediaDir, 'frame.jpg')
  try {
    fs.writeFileSync(imagePath, Buffer.alloc(32 * 1024, 0x61))
    setMediaSearchDirForTests(mediaDir)
    clearMediaSearchImageDataUrlCache()

    const first = readMediaSearchImageDataUrl(imagePath)
    assert.ok(first?.startsWith('data:image/jpeg;base64,'))
    const populated = getMediaSearchImageDataUrlCacheStats()
    assert.equal(populated.entries, 1)
    assert.ok(populated.totalWeight > 32 * 1024)
    assert.equal(populated.maxEntries, 3000)
    assert.equal(populated.maxWeight, 128 * 1024 * 1024)

    assert.equal(readMediaSearchImageDataUrl(imagePath), first)
    assert.deepEqual(getMediaSearchImageDataUrlCacheStats(), populated)

    clearMediaSearchImageDataUrlCache()
    assert.equal(getMediaSearchImageDataUrlCacheStats().entries, 0)
    assert.equal(getMediaSearchImageDataUrlCacheStats().totalWeight, 0)
  } finally {
    clearMediaSearchImageDataUrlCache()
    setMediaSearchDirForTests('')
    fs.rmSync(mediaDir, { recursive: true, force: true })
  }
})
