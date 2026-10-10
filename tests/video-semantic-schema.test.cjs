const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  VIDEO_SEMANTIC_SCHEMA_VERSION,
  getVideoSemanticInvalidationReasons,
  videoSemanticGenerationIdentity,
} = loadTsModule('shared/videoSemantic.ts')
const { deriveVideoSemanticSegmentId, normalizeVideoSemanticSegmentRecord } = loadTsModule(
  'electron/videoSemanticSchema.ts',
)

const FRAME_A = 'a'.repeat(40)
const FRAME_B = 'b'.repeat(40)

function validRecord(overrides = {}) {
  return {
    schemaVersion: VIDEO_SEMANTIC_SCHEMA_VERSION,
    segmentId: 'segment-1',
    generationId: 'generation-1',
    assetId: 'asset-1',
    videoId: 'video-1',
    startMs: 10_000,
    endMs: 20_000,
    profileId: 'general',
    summary: 'A person enters a room.',
    scenes: ['room'],
    events: [
      {
        label: 'enter',
        description: 'A person enters.',
        startMs: 5_000,
        endMs: 30_000,
        confidence: 4,
      },
    ],
    persons: [
      {
        localId: 'person-1',
        description: 'An adult wearing a dark coat.',
        actions: ['entering'],
        confidence: -1,
      },
    ],
    objects: ['door'],
    searchTags: ['room', 'Room'],
    visualText: [],
    transcriptRefs: [],
    audioEvents: [],
    warnings: [],
    evidenceFrameIds: [FRAME_A, FRAME_A, FRAME_B],
    evidenceFrameDigest: 'frames-sha256',
    modelId: 'qwen3-vl-2b-instruct',
    modelRevision: 'revision-1',
    quantization: 'Q4_K_M',
    promptVersion: 'prompt-v1',
    profileRevision: '2026-08-14.v1',
    sourceFingerprint: 'size:100;mtime:200',
    createdAt: 100,
    updatedAt: 90,
    ...overrides,
  }
}

test('schema guard normalizes bounded lists, confidence, event time, and update order', () => {
  const result = normalizeVideoSemanticSegmentRecord(validRecord())
  assert.equal(result.ok, true)
  const record = result.value
  assert.equal(record.events[0].startMs, 10_000)
  assert.equal(record.events[0].endMs, 20_000)
  assert.equal(record.events[0].confidence, 1)
  assert.equal(record.persons[0].confidence, 0)
  assert.deepEqual(record.searchTags, ['room'])
  assert.deepEqual(record.evidenceFrameIds, [FRAME_A, FRAME_B])
  assert.equal(record.updatedAt, 100)
})

test('legacy schema migrates tags, people, and event descriptions deterministically', () => {
  const legacy = validRecord({
    schemaVersion: 0,
    segmentId: undefined,
    profileId: undefined,
    profileRevision: undefined,
    persons: undefined,
    people: ['Person in a red jacket'],
    events: undefined,
    eventDescriptions: ['Person enters'],
    searchTags: undefined,
    tags: ['entrance'],
  })
  const first = normalizeVideoSemanticSegmentRecord(legacy)
  const second = normalizeVideoSemanticSegmentRecord(structuredClone(legacy))
  assert.equal(first.ok, true)
  assert.equal(first.migratedFrom, 0)
  assert.equal(first.value.profileId, 'general')
  assert.equal(first.value.persons[0].localId, 'person-1')
  assert.equal(first.value.events[0].label, 'legacy-event')
  assert.deepEqual(first.value.searchTags, ['entrance'])
  assert.deepEqual(first, second)
})

test('schema guard rejects unsupported versions, invalid ranges, and missing evidence', () => {
  assert.deepEqual(normalizeVideoSemanticSegmentRecord(null), {
    ok: false,
    error: 'Video semantic segment must be an object',
  })
  assert.equal(normalizeVideoSemanticSegmentRecord(validRecord({ schemaVersion: 99 })).ok, false)
  assert.equal(
    normalizeVideoSemanticSegmentRecord(validRecord({ startMs: 20_000, endMs: 10_000 })).ok,
    false,
  )
  assert.equal(
    normalizeVideoSemanticSegmentRecord(validRecord({ evidenceFrameIds: ['../../frame.jpg'] })).ok,
    false,
  )
})

test('derived segment ids are stable and change with generation or time boundaries', () => {
  const base = { videoId: 'video-1', startMs: 1_000, endMs: 2_000, generationId: 'g1' }
  assert.equal(deriveVideoSemanticSegmentId(base), deriveVideoSemanticSegmentId({ ...base }))
  assert.notEqual(
    deriveVideoSemanticSegmentId(base),
    deriveVideoSemanticSegmentId({ ...base, generationId: 'g2' }),
  )
  assert.match(deriveVideoSemanticSegmentId(base), /^[a-f0-9]{40}$/)
})

test('generation invalidation reports every changed authority in stable order', () => {
  const normalized = normalizeVideoSemanticSegmentRecord(validRecord())
  assert.equal(normalized.ok, true)
  const current = videoSemanticGenerationIdentity(normalized.value)
  assert.deepEqual(getVideoSemanticInvalidationReasons(current, { ...current }), [])

  const expected = {
    ...current,
    assetId: 'asset-2',
    videoId: 'video-2',
    startMs: current.startMs + 1,
    profileId: 'sports',
    profileRevision: 'profile-v2',
    evidenceFrameDigest: 'different-frames',
    modelRevision: 'revision-2',
    promptVersion: 'prompt-v2',
    sourceFingerprint: 'different-source',
  }
  assert.deepEqual(getVideoSemanticInvalidationReasons(current, expected), [
    'asset-changed',
    'video-changed',
    'segment-boundary-changed',
    'profile-changed',
    'evidence-frames-changed',
    'model-changed',
    'prompt-changed',
    'source-fingerprint-changed',
  ])
})

test('each model identity dimension invalidates an existing generation', () => {
  const normalized = normalizeVideoSemanticSegmentRecord(validRecord())
  assert.equal(normalized.ok, true)
  const current = videoSemanticGenerationIdentity(normalized.value)
  for (const change of [
    { modelId: 'other-adapter-model' },
    { modelRevision: 'other-revision' },
    { quantization: 'Q8_0' },
  ]) {
    assert.deepEqual(getVideoSemanticInvalidationReasons(current, { ...current, ...change }), [
      'model-changed',
    ])
  }
})
