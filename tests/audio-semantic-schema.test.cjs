const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { AUDIO_SEMANTIC_MAX_CHUNK_MS } = loadTsModule('shared/audioSemantic.ts')
const { deriveAudioSemanticSegmentId, normalizeAudioSemanticOutput } = loadTsModule(
  'electron/audioSemanticSchema.ts',
)

function authority(overrides = {}) {
  return {
    generationId: 'audio-generation-1',
    assetId: 'asset-1',
    videoId: 'video-1',
    startMs: 10_000,
    endMs: 25_000,
    sourceFingerprint: 'source-1',
    model: {
      modelId: 'SenseVoiceSmall',
      modelRevision: 'official-revision-1',
      runtime: 'funasr',
      quantization: 'fp32',
    },
    createdAt: 100,
    ...overrides,
  }
}

test('audio semantic schema applies authoritative identity and bounded rich transcription', () => {
  const input = authority()
  const result = normalizeAudioSemanticOutput(
    {
      text: `  hello\u0000   world ${'x'.repeat(9_000)}  `,
      language: 'zh',
      emotion: 'happy',
      audioEvents: [
        { label: 'speech', confidence: 4 },
        { label: 'laughter', confidence: -1 },
        { label: 'unsupported', confidence: 1 },
        'laughter',
      ],
    },
    input,
  )
  assert.equal(result.ok, true)
  assert.equal(result.value.text.length, 8_000)
  assert.equal(result.value.language, 'zh')
  assert.equal(result.value.emotion, 'happy')
  assert.deepEqual(
    result.value.audioEvents.map((event) => [
      event.label,
      event.startMs,
      event.endMs,
      event.confidence,
    ]),
    [
      ['speech', 10_000, 25_000, 1],
      ['laughter', 10_000, 25_000, 0],
    ],
  )
  assert.equal(result.value.modelId, input.model.modelId)
  assert.equal(result.value.transcriptRef, `asr:${result.value.segmentId}`)
  assert.equal(
    result.value.segmentId,
    deriveAudioSemanticSegmentId({
      generationId: input.generationId,
      videoId: input.videoId,
      startMs: input.startMs,
      endMs: input.endMs,
    }),
  )
})

test('audio semantic schema rejects oversized chunks and unapproved speaker attribution', () => {
  assert.equal(
    normalizeAudioSemanticOutput(
      { text: 'speech', language: 'en' },
      authority({ endMs: 10_000 + AUDIO_SEMANTIC_MAX_CHUNK_MS + 1 }),
    ).ok,
    false,
  )
  const unapproved = normalizeAudioSemanticOutput(
    { text: 'speech', language: 'en', speakerId: 'speaker-1' },
    authority(),
  )
  assert.deepEqual(unapproved, {
    ok: false,
    error: 'Speaker output requires an approved diarization model',
  })
  const approved = normalizeAudioSemanticOutput(
    { text: 'speech', language: 'en', speakerId: 'speaker-1' },
    authority({ speakerModel: { modelId: 'cam-plus', modelRevision: 'revision-1' } }),
  )
  assert.equal(approved.ok, true)
  assert.equal(approved.value.speaker.modelId, 'cam-plus')
})

test('audio semantic schema accepts one canonical model-repository separator only', () => {
  const canonical = normalizeAudioSemanticOutput(
    { text: 'speech', language: 'en' },
    authority({
      model: {
        modelId: 'FunAudioLLM/SenseVoiceSmall',
        modelRevision: 'official-revision-1',
        runtime: 'funasr',
        quantization: 'fp32',
      },
    }),
  )
  assert.equal(canonical.ok, true)
  assert.equal(canonical.value.modelId, 'FunAudioLLM/SenseVoiceSmall')

  for (const modelId of ['FunAudioLLM/SenseVoice/Small', 'model/../escape', '../model']) {
    const rejected = normalizeAudioSemanticOutput(
      { text: 'speech', language: 'en' },
      authority({ model: { ...authority().model, modelId } }),
    )
    assert.deepEqual(rejected, {
      ok: false,
      error: 'Audio semantic model identity is invalid',
    })
  }
})
