const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

let model
let service

test.before(async () => {
  model = await import('../tools/video-semantic-review/audio-model.mjs')
  service = await import('../scripts/serve-video-semantic-review.mjs')
})

test('audio review judgments have bounded values and a one-click completion gate', () => {
  assert.equal(model.isAudioJudgmentComplete(model.createEmptyAudioJudgment()), false)
  assert.equal(model.isAudioJudgmentComplete({ verdict: 'correct' }), true)
  assert.equal(model.isAudioJudgmentComplete({ verdict: 'wrong-speaker' }), true)
  assert.equal(model.isAudioJudgmentComplete({ verdict: 'wrong-boundary' }), true)
  assert.equal(model.isAudioJudgmentComplete({ verdict: 'unusable' }), true)
  const normalized = model.normalizeAudioJudgment({
    verdict: 'invented',
    correctedSpeaker: 'x'.repeat(200),
    notes: 'n'.repeat(2_000),
  })
  assert.equal(normalized.verdict, 'unreviewed')
  assert.equal(normalized.correctedSpeaker.length, 80)
  assert.equal(normalized.notes.length, 1_000)
})

test('audio review summary export excludes transcript and free text', () => {
  const segments = [
    { segmentId: 'turn-01', speakerId: 'speaker-1', transcriptText: 'private transcript' },
    { segmentId: 'turn-02', speakerId: 'speaker-2', transcriptText: 'another transcript' },
  ]
  const judgments = {
    'turn-01': { verdict: 'correct', notes: 'private note' },
    'turn-02': { verdict: 'wrong-speaker', correctedSpeaker: 'private identity' },
  }
  const report = model.buildAudioReviewExport(
    segments,
    judgments,
    { sampleId: model.AUDIO_REVIEW_SAMPLE.sampleId, generationId: 'safe-generation' },
    'summary',
    new Date('2026-08-14T00:00:00.000Z'),
  )
  assert.equal(report.summary.completed, 2)
  assert.equal(report.summary.speakerAccuracyPercent, 50)
  assert.equal(report.privacy.transcriptTextIncluded, false)
  assert.equal(report.privacy.freeTextIncluded, false)
  assert.doesNotMatch(
    JSON.stringify(report),
    /private transcript|private note|private identity|videoPath|displayPath/,
  )
})

test('audio review API validates authority, redacts paths, streams ranges, and saves atomically', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-semantic-review-'))
  const mediaRoot = path.join(root, 'media-search')
  const manifests = path.join(mediaRoot, 'manifests')
  const audioRoot = path.join(mediaRoot, 'audio-semantic')
  const transcripts = path.join(mediaRoot, 'transcripts')
  const audioReviewFile = path.join(root, 'private', 'audio-review.json')
  const videoPath = path.join(root, 'original-secret-audio-source.mp4')
  fs.mkdirSync(manifests, { recursive: true })
  fs.mkdirSync(audioRoot, { recursive: true })
  fs.mkdirSync(transcripts, { recursive: true })
  fs.writeFileSync(videoPath, Buffer.from('0123456789abcdef'))
  const videoId = `${model.AUDIO_REVIEW_SAMPLE.prefix}${'0'.repeat(28)}`
  const generationId = 'sensevoice-fixture-generation'
  fs.writeFileSync(
    path.join(manifests, 'video_files.jsonl'),
    `${JSON.stringify({ videoId, path: videoPath, durationMs: 10_000, missing: false })}\n`,
  )
  fs.writeFileSync(
    path.join(audioRoot, 'build-job.json'),
    JSON.stringify({
      jobId: 'audio-fixture',
      generationId,
      state: 'completed',
      totalSegments: 2,
      completedSegments: 2,
      failedSegments: 0,
      videos: [{ videoId, videoPath, durationMs: 10_000 }],
    }),
  )
  fs.writeFileSync(
    path.join(transcripts, `asr-${videoId}.json`),
    JSON.stringify({
      videoId,
      videoPath,
      language: 'zh',
      modelId: 'FunAudioLLM/SenseVoiceSmall',
      modelRevision: 'fixture-revision',
      generationId,
      segments: [
        {
          startMs: 1_000,
          endMs: 2_000,
          text: 'private transcript one',
          speakerId: 'speaker-1',
          emotion: 'neutral',
          audioEvents: ['speech'],
        },
        {
          startMs: 4_000,
          endMs: 6_000,
          text: 'private transcript two',
          speakerId: 'speaker-2',
          emotion: 'happy',
          audioEvents: ['speech', 'bgm'],
        },
      ],
    }),
  )

  const running = await service.createVideoSemanticReviewServer({
    mediaRoot,
    audioReviewFile,
    token: 'audio-fixture-token',
    port: 0,
  })
  try {
    const origin = new URL(running.audioUrl).origin
    const denied = await fetch(`${origin}/api/audio/state`)
    assert.equal(denied.status, 403)
    const stateResponse = await fetch(`${origin}/api/audio/state`, {
      headers: { 'X-Review-Token': 'audio-fixture-token' },
    })
    const state = await stateResponse.json()
    assert.equal(state.ok, true)
    assert.equal(state.metadata.available, true)
    assert.equal(state.metadata.generationId, generationId)
    assert.equal(state.segments.length, 2)
    assert.equal(state.segments[0].segmentId, 'turn-01')
    assert.equal(state.segments[0].contextStartMs, 650)
    assert.equal(state.referenceSegments['speaker-2'], 'turn-02')
    assert.doesNotMatch(JSON.stringify(state), /original-secret|audio-semantic-review-/)

    const range = await fetch(
      `${origin}/api/audio/video/${model.AUDIO_REVIEW_SAMPLE.sampleId}?token=audio-fixture-token`,
      { headers: { Range: 'bytes=3-7' } },
    )
    assert.equal(range.status, 206)
    assert.equal(await range.text(), '34567')

    const savedResponse = await fetch(`${origin}/api/audio/review/turn-01`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Review-Token': 'audio-fixture-token' },
      body: JSON.stringify({
        markReviewed: true,
        judgment: {
          listenedFullSegment: true,
          verdict: 'correct',
          notes: 'n'.repeat(2_000),
        },
      }),
    })
    const saved = await savedResponse.json()
    assert.equal(saved.ok, true)
    assert.equal(saved.judgment.notes.length, 1_000)
    const disk = JSON.parse(fs.readFileSync(audioReviewFile, 'utf8'))
    assert.equal(disk.generationId, generationId)
    assert.equal(disk.judgments['turn-01'].verdict, 'correct')
    assert.doesNotMatch(JSON.stringify(disk), /original-secret|videoPath|displayPath/)

    const page = await fetch(`${origin}/audio`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/)
  } finally {
    await running.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('audio review page exposes playback, references, verdicts, and private export controls', () => {
  const html = fs.readFileSync('tools/video-semantic-review/audio.html', 'utf8')
  const app = fs.readFileSync('tools/video-semantic-review/audio-app.mjs', 'utf8')
  assert.match(html, /id="referenceButtons"/)
  assert.match(html, /id="playExact"/)
  assert.match(html, /id="playContext"/)
  assert.match(html, /data-value="correct"/)
  assert.match(html, /data-value="wrong-speaker"/)
  assert.match(html, /data-value="wrong-boundary"/)
  assert.match(html, /data-value="unusable"/)
  assert.match(html, /id="exportSummary"/)
  assert.match(app, /\/api\/audio\/video\/\$\{state\.metadata\.sampleId\}/)
  assert.match(app, /buildAudioReviewExport/)
  assert.doesNotMatch(html, /https?:\/\//)
})
