const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { DatabaseSync } = require('node:sqlite')
const { loadTsModule } = require('./guard-utils.cjs')

const { VIDEO_SEMANTIC_DATABASE_FILENAME, VideoSemanticDatabase } = loadTsModule(
  'electron/videoSemanticDatabase.ts',
)

const FRAME = 'a'.repeat(40)

function segment(generationId, suffix, overrides = {}) {
  return {
    schemaVersion: 1,
    segmentId: `${generationId}-segment-${suffix}`,
    generationId,
    assetId: 'asset-1',
    videoId: 'video-1',
    startMs: suffix * 10_000,
    endMs: suffix * 10_000 + 9_000,
    profileId: 'general',
    summary: suffix === 1 ? 'A person enters the meeting room' : 'A cat sleeps on a sofa',
    scenes: suffix === 1 ? ['meeting room'] : ['living room'],
    events: [
      {
        label: suffix === 1 ? 'enter' : 'sleep',
        description: suffix === 1 ? 'Person enters room' : 'Cat is sleeping',
        startMs: suffix * 10_000,
        endMs: suffix * 10_000 + 9_000,
        confidence: 0.8,
      },
    ],
    persons:
      suffix === 1
        ? [
            {
              localId: 'person-1',
              description: 'Person wearing a dark coat',
              actions: ['entering'],
              confidence: 0.8,
            },
          ]
        : [],
    objects: suffix === 1 ? ['door'] : ['sofa'],
    searchTags: suffix === 1 ? ['meeting'] : ['cat'],
    visualText: [],
    transcriptRefs: [],
    audioEvents: [],
    warnings: [],
    evidenceFrameIds: [FRAME],
    evidenceFrameDigest: `digest-${generationId}-${suffix}`,
    modelId: 'qwen3-vl-2b-instruct',
    modelRevision: 'revision-1',
    quantization: 'Q4_K_M',
    promptVersion: 'prompt-v1',
    profileRevision: '2026-08-14.v1',
    sourceFingerprint: 'source-1',
    createdAt: 100 + suffix,
    updatedAt: 100 + suffix,
    ...overrides,
  }
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-semantic-db-'))
  const file = path.join(dir, VIDEO_SEMANTIC_DATABASE_FILENAME)
  const database = new VideoSemanticDatabase(file)
  return {
    dir,
    file,
    database,
    close() {
      database.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('video semantic database atomically commits and reads one active generation', () => {
  const scope = fixture()
  try {
    scope.database.commitGeneration([segment('g1', 1), segment('g1', 2)], 1_000)
    assert.equal(scope.database.getActiveGenerationId('video-1'), 'g1')
    assert.deepEqual(
      scope.database.getActiveSegments('video-1').map((item) => item.segmentId),
      ['g1-segment-1', 'g1-segment-2'],
    )
    assert.deepEqual(scope.database.stats(), {
      generations: 1,
      activeVideos: 1,
      segments: 2,
      events: 2,
      persons: 1,
    })
    const raw = new DatabaseSync(scope.file, { readOnly: true })
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1)
    raw.close()
  } finally {
    scope.close()
  }
})

test('new generation becomes active without deleting the previous generation', () => {
  const scope = fixture()
  try {
    scope.database.commitGeneration([segment('g1', 1)], 1_000)
    scope.database.commitGeneration(
      [segment('g2', 1, { summary: 'A person presents a contract document' })],
      2_000,
    )
    assert.equal(scope.database.getActiveGenerationId('video-1'), 'g2')
    assert.equal(scope.database.getActiveSegments('video-1')[0].summary.includes('contract'), true)
    assert.equal(scope.database.stats().generations, 2)
    assert.equal(scope.database.deleteInactiveGenerations('video-1'), 1)
    assert.equal(scope.database.stats().generations, 1)
    assert.equal(scope.database.getActiveGenerationId('video-1'), 'g2')
  } finally {
    scope.close()
  }
})

test('source cleanup deletes every semantic row for selected videos and preserves other videos', () => {
  const scope = fixture()
  try {
    scope.database.commitGeneration([segment('g1', 1)], 1_000)
    scope.database.commitGeneration(
      [
        segment('g2', 1, {
          segmentId: 'g2-video-2-segment-1',
          assetId: 'asset-2',
          videoId: 'video-2',
          summary: 'A dog runs through a garden',
          searchTags: ['dog'],
        }),
      ],
      2_000,
    )
    scope.database.setVideoProfileOverride('video-1', 'general')
    const preview = scope.database.previewVideoData(['video-1'])
    assert.equal(preview.generations, 1)
    assert.equal(preview.segments, 1)
    assert.equal(preview.events, 1)
    assert.equal(preview.persons, 1)
    assert.equal(preview.preferences, 1)

    const removed = scope.database.deleteVideoData(['video-1'])
    assert.deepEqual(removed, preview)
    assert.equal(scope.database.getActiveGenerationId('video-1'), null)
    assert.deepEqual(scope.database.getActiveSegments('video-1'), [])
    assert.equal(
      scope.database.search('meeting').some((hit) => hit.segment.videoId === 'video-1'),
      false,
    )
    assert.equal(scope.database.getActiveGenerationId('video-2'), 'g2')
    assert.equal(scope.database.search('dog')[0].segment.videoId, 'video-2')
    assert.deepEqual(scope.database.stats(), {
      generations: 1,
      activeVideos: 1,
      segments: 1,
      events: 1,
      persons: 1,
    })
  } finally {
    scope.close()
  }
})

test('read-only semantic preview neither creates schema files nor permits writes', () => {
  const scope = fixture()
  try {
    scope.database.commitGeneration([segment('g1', 1)], 1_000)
    scope.database.close()
    const snapshot = () =>
      fs
        .readdirSync(scope.dir)
        .sort()
        .map((name) => {
          const stat = fs.statSync(path.join(scope.dir, name))
          return { name, size: stat.size, mtimeMs: stat.mtimeMs }
        })
    const before = snapshot()
    const reader = new VideoSemanticDatabase(scope.file, { readOnly: true, immutable: true })
    try {
      assert.equal(reader.previewVideoData(['video-1']).segments, 1)
      assert.throws(() => reader.setVideoProfileOverride('video-1', 'general'), /read.?only/i)
    } finally {
      reader.close()
    }
    assert.deepEqual(snapshot(), before)

    const missingPath = path.join(scope.dir, 'missing.sqlite')
    const missingReader = new VideoSemanticDatabase(missingPath, {
      readOnly: true,
      immutable: true,
    })
    try {
      assert.deepEqual(missingReader.previewVideoData(['video-1']), {
        generations: 0,
        segments: 0,
        events: 0,
        persons: 0,
        jobs: 0,
        preferences: 0,
      })
    } finally {
      missingReader.close()
    }
    assert.equal(fs.existsSync(missingPath), false)
  } finally {
    scope.close()
  }
})

test('FTS searches active summary, event, person, object, and tags only', () => {
  const scope = fixture()
  try {
    scope.database.commitGeneration([segment('g1', 1), segment('g1', 2)], 1_000)
    assert.equal(scope.database.search('meeting')[0].segment.segmentId, 'g1-segment-1')
    assert.equal(scope.database.search('dark coat')[0].segment.persons[0].localId, 'person-1')
    assert.equal(scope.database.search('sofa')[0].segment.segmentId, 'g1-segment-2')
    assert.deepEqual(scope.database.search('!!!'), [])

    scope.database.commitGeneration(
      [segment('g2', 1, { summary: 'A presenter discusses a contract', searchTags: ['contract'] })],
      2_000,
    )
    assert.deepEqual(
      scope.database.search('cat'),
      [],
      'inactive generation must not leak into search',
    )
    assert.equal(scope.database.search('contract')[0].segment.generationId, 'g2')
  } finally {
    scope.close()
  }
})

test('FTS reports the exact evidence fields that matched without inferring OCR from presence', () => {
  const scope = fixture()
  try {
    scope.database.commitGeneration(
      [
        segment('g1', 1, {
          summary: 'A presenter stands beside a screen',
          visualText: ['REASONIX-OCR-731'],
        }),
      ],
      1_000,
    )
    assert.deepEqual(scope.database.search('presenter')[0].matchedFields, ['visual-semantic'])
    assert.deepEqual(scope.database.search('REASONIX-OCR-731')[0].matchedFields, ['visual-text'])
  } finally {
    scope.close()
  }
})

test('failed duplicate insert rolls back and preserves the previously active generation', () => {
  const scope = fixture()
  try {
    scope.database.commitGeneration([segment('g1', 1)], 1_000)
    const duplicate = segment('g2', 1)
    assert.throws(() => scope.database.commitGeneration([duplicate, { ...duplicate }], 2_000))
    assert.equal(scope.database.getActiveGenerationId('video-1'), 'g1')
    assert.equal(scope.database.stats().generations, 1)
    assert.equal(scope.database.getActiveSegments('video-1')[0].generationId, 'g1')
  } finally {
    scope.close()
  }
})

test('generation commit rejects mixed video or model authorities before activation', () => {
  const scope = fixture()
  try {
    assert.throws(() =>
      scope.database.commitGeneration([segment('g1', 1), segment('g1', 2, { videoId: 'video-2' })]),
    )
    assert.equal(scope.database.getActiveGenerationId('video-1'), null)
    assert.deepEqual(scope.database.stats(), {
      generations: 0,
      activeVideos: 0,
      segments: 0,
      events: 0,
      persons: 0,
    })
  } finally {
    scope.close()
  }
})
