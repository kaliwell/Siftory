const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

let model
let service

test.before(async () => {
  model = await import('../tools/video-semantic-review/model.mjs')
  service = await import('../scripts/serve-video-semantic-review.mjs')
})

test('review model fixes the approved anonymous sample set and pilot target window', () => {
  assert.equal(model.REVIEW_SAMPLES.length, 20)
  assert.equal(new Set(model.REVIEW_SAMPLES.map((sample) => sample.sampleId)).size, 20)
  assert.deepEqual(model.targetRange(34_100), { startMs: 7_050, endMs: 27_050 })
  assert.deepEqual(model.targetRange(14_900), { startMs: 0, endMs: 14_900 })
})

test('quick review completion requires only a like or unlike decision', () => {
  const incomplete = model.createEmptyJudgment()
  assert.equal(model.isJudgmentComplete(incomplete), false)
  const complete = { consistency: 'consistent' }
  assert.equal(model.isJudgmentComplete(complete), true)
  assert.equal(model.isJudgmentComplete({ consistency: 'inconsistent' }), true)
  assert.equal(model.isJudgmentComplete({ consistency: 'partial' }), false)
})

test('summary export excludes free text and original identity', () => {
  const sample = {
    ...model.REVIEW_SAMPLES[0],
    available: true,
    inference: { ok: true },
  }
  const judgment = {
    watchedFullSegment: true,
    scene: 'private scene truth',
    personCount: 2,
    events: 'private event truth',
    ocr: 'private OCR truth',
    consistency: 'consistent',
    hallucination: 'minor',
    notes: 'private notes',
  }
  const report = model.buildReviewExport(
    [sample],
    { [sample.sampleId]: judgment },
    'summary',
    new Date('2026-08-14T00:00:00.000Z'),
  )
  const serialized = JSON.stringify(report)
  assert.equal(report.summary.completed, 1)
  assert.equal(report.privacy.freeTextIncluded, false)
  assert.doesNotMatch(serialized, /private|prefix|displayPath|videoId/)
})

test('loopback server requires a token, redacts paths, streams ranges, and persists bounded review data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-semantic-review-'))
  const mediaRoot = path.join(root, 'media-search')
  const manifests = path.join(mediaRoot, 'manifests')
  const resultsRoot = path.join(root, 'results')
  const reviewFile = path.join(root, 'private', 'review.json')
  const videoPath = path.join(root, 'original-secret-name.mp4')
  fs.mkdirSync(manifests, { recursive: true })
  fs.mkdirSync(resultsRoot, { recursive: true })
  fs.writeFileSync(videoPath, Buffer.from('0123456789abcdef'))
  const definition = model.REVIEW_SAMPLES[0]
  fs.writeFileSync(
    path.join(manifests, 'video_files.jsonl'),
    `${JSON.stringify({
      videoId: `${definition.prefix}${'0'.repeat(28)}`,
      path: videoPath,
      durationMs: definition.durationMs,
      width: 720,
      height: 1280,
      videoCodec: 'h264',
      metadataStatus: 'done',
      missing: false,
    })}\n`,
  )
  fs.writeFileSync(
    path.join(resultsRoot, `${definition.sampleId}.json`),
    JSON.stringify({
      sample: { segmentStartMs: 7_050, segmentEndMs: 27_050 },
      parse: {
        ok: true,
        value: {
          summary: 'candidate summary',
          scenes: ['room'],
          events: [],
          persons: [],
          objects: [],
          visualText: [],
          searchTags: [],
          warnings: [],
          modelId: 'qwen3-vl-2b-instruct',
          modelRevision: 'revision-1',
          quantization: 'Q4_K_M',
        },
      },
      metrics: { latencyMs: 12_000, peakGpuUsedMiB: 2_000 },
    }),
  )

  const running = await service.createVideoSemanticReviewServer({
    mediaRoot,
    resultsRoot,
    reviewFile,
    token: 'fixture-token',
    port: 0,
  })
  try {
    const origin = new URL(running.url).origin
    const denied = await fetch(`${origin}/api/state`)
    assert.equal(denied.status, 403)
    const stateResponse = await fetch(`${origin}/api/state`, {
      headers: { 'X-Review-Token': 'fixture-token' },
    })
    const state = await stateResponse.json()
    assert.equal(state.ok, true)
    assert.equal(state.samples.length, 20)
    assert.equal(state.samples[0].available, true)
    assert.equal(state.samples[0].inference.candidate.summary, 'candidate summary')
    assert.doesNotMatch(JSON.stringify(state), /original-secret-name|video-semantic-review-/)

    const range = await fetch(`${origin}/api/video/${definition.sampleId}?token=fixture-token`, {
      headers: { Range: 'bytes=2-5' },
    })
    assert.equal(range.status, 206)
    assert.equal(await range.text(), '2345')

    const oversized = 'x'.repeat(5_000)
    const savedResponse = await fetch(`${origin}/api/review/${definition.sampleId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Review-Token': 'fixture-token' },
      body: JSON.stringify({
        markReviewed: true,
        judgment: {
          watchedFullSegment: true,
          scene: oversized,
          personCount: 1,
          events: '无',
          ocr: '无',
          consistency: 'consistent',
          hallucination: 'none',
        },
      }),
    })
    const saved = await savedResponse.json()
    assert.equal(saved.ok, true)
    assert.equal(saved.judgment.scene.length, 1_000)
    const disk = fs.readFileSync(reviewFile, 'utf8')
    assert.doesNotMatch(disk, /original-secret-name|videoPath|displayPath/)
  } finally {
    await running.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('review page has a strict CSP and all required review controls', () => {
  const html = fs.readFileSync('tools/video-semantic-review/index.html', 'utf8')
  const app = fs.readFileSync('tools/video-semantic-review/app.mjs', 'utf8')
  assert.match(html, /id="playSegment"/)
  assert.match(html, /id="playerShell"/)
  assert.match(html, /playsinline/)
  assert.match(html, /id="watchedFullSegment"/)
  assert.match(html, /id="consistencyButtons"/)
  assert.match(html, /id="quickCandidateSummary"/)
  assert.match(html, />✓ 像/)
  assert.match(html, />✕ 不像/)
  assert.match(html, /id="exportSummary"/)
  assert.match(app, /\/api\/video\/\$\{sample\.sampleId\}/)
  assert.match(app, /buildReviewExport/)
  assert.match(app, /height > width/)
  assert.doesNotMatch(html, /https?:\/\//)
})
