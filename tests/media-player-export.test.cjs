const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const ROOT = path.resolve(__dirname, '..')
const ffmpeg = path.join(ROOT, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe')
const ffprobe = path.join(ROOT, 'tools', 'ffmpeg', 'bin', 'ffprobe.exe')
const { buildMediaPlayerTimelineRequest, normalizeMediaPlayerExportRequest } = loadTsModule(
  'electron/mediaPlayerExportService.ts',
)
const { exportVideoSelectionToMp4 } = loadTsModule('electron/ffmpegService.ts')
const { serializeUnifiedSearchEdl, validateCmx3600Edl } = loadTsModule(
  'electron/unifiedSearchEdlExport.ts',
)
const { serializeUnifiedSearchFcpxml, validateFcpxml } = loadTsModule(
  'electron/unifiedSearchFcpxmlExport.ts',
)

const token = 'A'.repeat(32)

test('player export request accepts only bounded ranges and supported timeline rates', () => {
  assert.deepEqual(
    normalizeMediaPlayerExportRequest(
      { token, format: 'video', startMs: 1_000, endMs: 2_500 },
      4_000,
    ),
    { token, format: 'video', startMs: 1_000, endMs: 2_500 },
  )
  assert.equal(
    normalizeMediaPlayerExportRequest(
      { token, format: 'edl', startMs: 1_000, endMs: 2_500 },
      4_000,
    ),
    undefined,
  )
  assert.equal(
    normalizeMediaPlayerExportRequest(
      { token, format: 'edl', startMs: 1_000, endMs: 2_500, frameRate: 25 },
      4_000,
    ).frameRate,
    25,
  )
  for (const request of [
    { token: 'short', format: 'video', startMs: 0, endMs: 1_000 },
    { token, format: 'video', startMs: -1, endMs: 1_000 },
    { token, format: 'video', startMs: 1_000, endMs: 1_039 },
    { token, format: 'video', startMs: 1_000, endMs: 4_001 },
    { token, format: 'fcpxml', startMs: 1_000, endMs: 2_000, frameRate: 27 },
  ]) {
    assert.equal(normalizeMediaPlayerExportRequest(request, 4_000), undefined)
  }
})

test('player selection projects to validated EDL and FCPXML documents', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-player-timeline-'))
  const sourcePath = path.join(temp, 'source clip.mp4')
  fs.writeFileSync(sourcePath, Buffer.from([0]))
  try {
    const source = {
      videoId: 'video-1',
      videoPath: sourcePath,
      title: 'source clip.mp4',
      durationMs: 4_000,
      width: 320,
      height: 180,
    }
    const request = {
      token,
      format: 'edl',
      startMs: 1_000,
      endMs: 2_500,
      frameRate: 25,
    }
    const edl = serializeUnifiedSearchEdl(buildMediaPlayerTimelineRequest(source, request))
    assert.equal(validateCmx3600Edl(edl.content).ok, true)
    assert.match(edl.content, /00:00:01:00 00:00:02:13/)

    const fcpxmlRequest = buildMediaPlayerTimelineRequest(source, {
      ...request,
      format: 'fcpxml',
    })
    const fcpxml = serializeUnifiedSearchFcpxml(fcpxmlRequest)
    assert.equal(validateFcpxml(fcpxml.content).ok, true)
    assert.match(fcpxml.content, /start="1s" duration="38\/25s"/)
    assert.match(fcpxml.content, /source%20clip\.mp4/)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('accurate MP4 export creates the selected playable duration', async (t) => {
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) {
    t.skip('bundled FFmpeg tools are unavailable')
    return
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-player-video-export-'))
  const sourcePath = path.join(temp, 'source.mp4')
  const outputPath = path.join(temp, 'selection.mp4')
  try {
    const generated = spawnSync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=25:duration=4',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=4',
        '-shortest',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        sourcePath,
      ],
      { encoding: 'utf8', windowsHide: true },
    )
    assert.equal(generated.status, 0, generated.stderr)

    const exported = await exportVideoSelectionToMp4({
      filePath: sourcePath,
      outputPath,
      startMs: 1_000,
      endMs: 2_500,
    })
    assert.equal(exported.ok, true, exported.error)
    assert.ok(fs.statSync(outputPath).size > 1_000)
    const probed = spawnSync(
      ffprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        outputPath,
      ],
      { encoding: 'utf8', windowsHide: true },
    )
    assert.equal(probed.status, 0, probed.stderr)
    const duration = Number(probed.stdout.trim())
    assert.ok(duration >= 1.45 && duration <= 1.6, `unexpected duration ${duration}`)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('player UI exposes adjustable In/Out controls without accepting arbitrary source paths', () => {
  const html = fs.readFileSync(path.join(ROOT, 'media-player.html'), 'utf8')
  const script = fs.readFileSync(path.join(ROOT, 'src', 'mediaPlayer.ts'), 'utf8')
  const preload = fs.readFileSync(path.join(ROOT, 'electron', 'mediaPlayerPreload.ts'), 'utf8')
  const service = fs.readFileSync(
    path.join(ROOT, 'electron', 'mediaPlayerExportService.ts'),
    'utf8',
  )
  for (const id of [
    'clip-start',
    'clip-end',
    'clip-start-range',
    'clip-end-range',
    'selection-track',
    'selection-range-fill',
    'selection-playhead',
    'loop-selection',
    'start-frame-back',
    'start-frame-forward',
    'end-frame-back',
    'end-frame-forward',
    'start-frame-value',
    'end-frame-value',
    'export-video',
    'export-edl',
    'export-fcpxml',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(script, /event\.key\.toLowerCase\(\) === 'i'/)
  assert.match(script, /event\.key\.toLowerCase\(\) === 'o'/)
  assert.match(script, /function enforceSelectionLoop/)
  assert.match(script, /window\.requestAnimationFrame\(monitorPlayback\)/)
  assert.match(script, /player\.currentTime = selectionStartMs \/ 1_000/)
  assert.match(script, /selectionRangeFill\.style\.width/)
  assert.match(script, /function frameIndexAt/)
  assert.match(script, /function frameTimeMs/)
  assert.match(script, /function adjustSelectionByFrame/)
  assert.match(script, /event\.shiftKey/)
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|eval\(/)
  assert.match(preload, /--siftory-player-export-token=/)
  assert.doesNotMatch(preload, /filePath|sourcePath|videoPath/)
  assert.match(service, /grant\.senderId !== event\.sender\.id/)
  assert.match(service, /grant\.source\.videoPath/)
})

test('controlled player navigation uses an exact normalized file path', () => {
  const service = fs.readFileSync(path.join(ROOT, 'electron', 'mediaPlayerService.ts'), 'utf8')
  assert.match(service, /function isTrustedPlayerNavigation/)
  assert.match(service, /path\.resolve\(fileURLToPath\(parsed\)\)/)
  assert.match(service, /if \(!isTrustedPlayerNavigation\(targetUrl, trustedPlayerPath\)\)/)
  assert.doesNotMatch(service, /targetUrl\.startsWith/)
})
