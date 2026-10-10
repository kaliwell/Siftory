const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('./guard-utils.cjs')

const { ensureMediaSearchDirs, setMediaSearchDirForTests } = loadTsModule(
  'electron/mediaCacheService.ts',
)
const { invalidateVideoManifestCache, loadVideoManifest, loadVideoManifestPreview } = loadTsModule(
  'electron/videoScanService.ts',
)
const { invalidateVideoFrameManifestCache, loadVideoFrameManifest, loadVideoFrameManifestPreview } =
  loadTsModule('electron/videoFrameService.ts')

const requestedCounts = (process.env.MEDIA_SEARCH_MANIFEST_BENCH_COUNTS || '10000,100000')
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value >= 1000 && value <= 200000)
const counts = [...new Set(requestedCounts)].sort((a, b) => a - b)
if (counts.length === 0) throw new Error('No valid manifest benchmark counts')

function writeJsonLines(filePath, count, createRow) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const fd = fs.openSync(filePath, 'w')
  try {
    const chunkSize = 2000
    for (let offset = 0; offset < count; offset += chunkSize) {
      const end = Math.min(count, offset + chunkSize)
      const lines = []
      for (let index = offset; index < end; index++) lines.push(JSON.stringify(createRow(index)))
      fs.writeSync(fd, `${lines.join('\n')}\n`)
    }
  } finally {
    fs.closeSync(fd)
  }
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

function measureHot(run, iterations = 25) {
  const samples = []
  for (let index = 0; index < iterations; index++) {
    const startedAt = performance.now()
    run()
    samples.push(performance.now() - startedAt)
  }
  samples.sort((a, b) => a - b)
  const total = samples.reduce((sum, value) => sum + value, 0)
  return {
    iterations,
    avgMs: Number((total / samples.length).toFixed(3)),
    medianMs: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    maxMs: Number(samples[samples.length - 1].toFixed(3)),
  }
}

function measureCold(run, expectedCount) {
  const before = process.memoryUsage()
  const startedAt = performance.now()
  const result = run()
  const elapsedMs = performance.now() - startedAt
  const after = process.memoryUsage()
  const actualCount = Array.isArray(result) ? result.length : result.total
  if (actualCount !== expectedCount) {
    throw new Error(`Manifest count mismatch: expected ${expectedCount}, got ${actualCount}`)
  }
  return {
    elapsedMs: Number(elapsedMs.toFixed(3)),
    heapDeltaBytes: after.heapUsed - before.heapUsed,
    rssDeltaBytes: after.rss - before.rss,
  }
}

function runCase(root, count) {
  const mediaDir = path.join(root, `media-${count}`)
  setMediaSearchDirForTests(mediaDir)
  ensureMediaSearchDirs()
  const manifestsDir = path.join(mediaDir, 'manifests')
  const videoManifest = path.join(manifestsDir, 'video_files.jsonl')
  const frameManifest = path.join(manifestsDir, 'video_frames.jsonl')

  writeJsonLines(videoManifest, count, (index) => ({
    videoId: `video-${index}`,
    path: path.join(root, 'videos', `${index}.mp4`),
    name: `${index}.mp4`,
    sizeBytes: index + 1,
    missing: false,
    discoveredAt: index,
    updatedAt: index,
  }))
  writeJsonLines(frameManifest, count, (index) => ({
    frameId: `frame-${index}`,
    videoId: `video-${index}`,
    videoPath: path.join(root, 'videos', `${index}.mp4`),
    timestampMs: index * 1000,
    status: 'done',
    createdAt: index,
    updatedAt: index,
  }))

  invalidateVideoManifestCache()
  const videoCold = measureCold(loadVideoManifest, count)
  const videoHot = measureHot(loadVideoManifest)

  invalidateVideoFrameManifestCache()
  const frameCold = measureCold(loadVideoFrameManifest, count)
  const frameHot = measureHot(loadVideoFrameManifest)

  invalidateVideoManifestCache()
  const videoPreviewCold = measureCold(() => loadVideoManifestPreview(200), count)
  const videoPreviewHot = measureHot(() => loadVideoManifestPreview(200))

  invalidateVideoFrameManifestCache()
  const framePreviewCold = measureCold(() => loadVideoFrameManifestPreview(500), count)
  const framePreviewHot = measureHot(() => loadVideoFrameManifestPreview(500))

  return {
    count,
    manifestBytes: {
      videos: fs.statSync(videoManifest).size,
      frames: fs.statSync(frameManifest).size,
    },
    video: { cold: videoCold, hot: videoHot },
    frame: { cold: frameCold, hot: frameHot },
    videoPreview: { cold: videoPreviewCold, hot: videoPreviewHot },
    framePreview: { cold: framePreviewCold, hot: framePreviewHot },
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-search-manifest-bench-'))
try {
  const cases = counts.map((count) => runCase(root, count))
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        node: process.version,
        hotTargetMs: 20,
        cases,
      },
      null,
      2,
    ),
  )
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
