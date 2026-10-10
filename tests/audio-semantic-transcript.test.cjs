const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-semantic-transcript-'))
process.env.FLOATING_CLOCK_MEDIA_SEARCH_DIR = root

const {
  getAudioSemanticTranscriptStats,
  getAudioSemanticTranscriptStatsSnapshot,
  saveAudioSemanticTranscript,
  searchTranscripts,
} = loadTsModule('electron/transcriptService.ts')

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    segmentId: 'segment-1',
    generationId: 'generation-1',
    assetId: 'asset-1',
    videoId: 'video-1',
    startMs: 1_000,
    endMs: 5_000,
    text: 'hello local dialogue',
    language: 'en',
    emotion: 'happy',
    audioEvents: [
      { label: 'speech', startMs: 1_000, endMs: 5_000, confidence: 0.9 },
      { label: 'laughter', startMs: 1_000, endMs: 5_000, confidence: 0.8 },
    ],
    transcriptRef: 'asr:segment-1',
    modelId: 'SenseVoiceSmall',
    modelRevision: 'official-revision-1',
    runtime: 'funasr',
    quantization: 'fp32',
    sourceFingerprint: 'source-1',
    createdAt: 100,
    speaker: {
      localId: 'speaker-1',
      modelId: 'campplus-speaker',
      modelRevision: 'modelscope-v2.0.2',
    },
    ...overrides,
  }
}

test('SenseVoice transcript persists separately and search exposes ASR provenance', () => {
  const transcript = saveAudioSemanticTranscript('C:\\private\\original-video.mp4', [record()])
  assert.equal(transcript.source, 'sensevoice-asr')
  assert.equal(transcript.segments[0].emotion, 'happy')
  assert.deepEqual(transcript.segments[0].audioEvents, ['speech', 'laughter'])
  assert.equal(transcript.segments[0].speakerId, 'speaker-1')
  assert.deepEqual(getAudioSemanticTranscriptStats(), { videos: 1, segments: 1 })

  const speech = searchTranscripts('hello', 10)
  assert.equal(speech.length, 1)
  assert.equal(speech[0].source, 'sensevoice-asr')
  assert.equal(speech[0].modelId, 'SenseVoiceSmall')
  assert.equal(speech[0].matchStartMs, 1_000)
  assert.equal(speech[0].matchEndMs, 5_000)
  assert.deepEqual(speech[0].audioEvents, ['speech', 'laughter'])
  assert.equal(speech[0].speakerId, 'speaker-1')

  const event = searchTranscripts('laughter', 10)
  assert.equal(event.length, 1)
  assert.equal(event[0].timestampMs, 1_000)
})

test('SenseVoice transcript rejects mixed generation or model authority', () => {
  assert.throws(
    () =>
      saveAudioSemanticTranscript('C:\\private\\original-video.mp4', [
        record(),
        record({ segmentId: 'segment-2', generationId: 'forged-generation' }),
      ]),
    /authority is inconsistent/,
  )
})

test('UI transcript statistics return immediately and persist their asynchronous summary', async () => {
  const first = getAudioSemanticTranscriptStatsSnapshot({ force: true })
  assert.equal(first.pending, true)

  let settled = first
  for (let attempt = 0; attempt < 100 && settled.pending; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    settled = getAudioSemanticTranscriptStatsSnapshot()
  }
  assert.deepEqual(settled, { videos: 1, segments: 1, pending: false })
  assert.equal(fs.existsSync(path.join(root, 'audio-semantic', 'transcript-stats.json')), true)
})

test('transcript source filtering runs before its topK cutoff', () => {
  saveAudioSemanticTranscript('C:\\selected\\a.mp4', [
    record({
      videoId: 'scope-a',
      text: 'scopefixtureterm',
      segmentId: 'scope-a-segment',
    }),
  ])
  saveAudioSemanticTranscript('C:\\outside\\b.mp4', [
    record({
      videoId: 'scope-b',
      text: 'scopefixtureterm '.repeat(10),
      segmentId: 'scope-b-segment',
    }),
  ])
  const unscoped = searchTranscripts('scopefixtureterm', 1)
  assert.equal(unscoped[0].videoId, 'scope-b')
  const scoped = searchTranscripts('scopefixtureterm', 1, {
    acceptVideo: (videoId, videoPath) =>
      videoId === 'scope-a' && videoPath.startsWith('C:\\selected\\'),
  })
  assert.equal(scoped.length, 1)
  assert.equal(scoped[0].videoId, 'scope-a')
})
