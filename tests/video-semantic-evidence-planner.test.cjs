const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { planVideoSemanticEvidence } = loadTsModule('electron/videoSemanticBuildCoordinator.ts')

function video(overrides = {}) {
  return {
    videoId: 'a'.repeat(40),
    path: 'D:\\library\\fixture.mp4',
    name: 'fixture.mp4',
    ext: '.mp4',
    sizeBytes: 1_000,
    mtimeMs: 200,
    durationMs: 25_000,
    width: 1920,
    height: 1080,
    metadataStatus: 'done',
    discoveredAt: 100,
    updatedAt: 200,
    ...overrides,
  }
}

function frames(videoId = 'a'.repeat(40)) {
  return [0, 2_000, 4_000, 6_000, 8_000, 10_000, 12_000, 18_000, 24_000].map(
    (timestampMs, index) => ({
      frameId: (index + 1).toString(16).padStart(40, '0'),
      videoId,
      videoPath: 'D:\\library\\fixture.mp4',
      timestampMs,
      imagePath: `C:\\cache\\${index + 1}.jpg`,
      status: 'done',
      createdAt: 100,
      updatedAt: 100,
    }),
  )
}

test('planner creates deterministic bounded segments from authoritative ready frames', () => {
  const input = {
    video: video(),
    frames: frames(),
    generationId: 'generation-1',
    profileOverride: 'sports',
    maximumFramesPerSegment: 4,
  }
  const first = planVideoSemanticEvidence(input)
  const second = planVideoSemanticEvidence(input)
  assert.deepEqual(first, second)
  assert.equal(first.profile.profileId, 'sports')
  assert.equal(first.profile.decision, 'user-override')
  assert.equal(first.segments.length, 3)
  assert.ok(first.segments.every((segment) => segment.evidenceFrameIds.length <= 4))
  assert.ok(first.segments.every((segment) => segment.startMs >= 0 && segment.endMs <= 25_000))
  assert.ok(first.segments.every((segment) => /^[a-f0-9]{40}$/.test(segment.segmentId)))
  assert.ok(first.segments.every((segment) => /^[a-f0-9]{64}$/.test(segment.evidenceFrameDigest)))
  assert.deepEqual(first.segments[0].evidenceFrameIds, [
    '1'.padStart(40, '0'),
    '2'.padStart(40, '0'),
    '4'.padStart(40, '0'),
    '5'.padStart(40, '0'),
  ])
})

test('planner ignores unrelated and unavailable frames without accepting an empty plan', () => {
  const unavailable = frames('b'.repeat(40)).map((frame) => ({ ...frame, status: 'error' }))
  assert.throws(
    () =>
      planVideoSemanticEvidence({
        video: video(),
        frames: unavailable,
        generationId: 'generation-1',
        profileOverride: 'auto',
        maximumFramesPerSegment: 4,
      }),
    /ready frames are missing/,
  )
})

test('planner rejects missing metadata and invalid frame budgets before creating jobs', () => {
  assert.throws(
    () =>
      planVideoSemanticEvidence({
        video: video({ metadataStatus: 'pending' }),
        frames: frames(),
        generationId: 'generation-1',
        profileOverride: 'auto',
        maximumFramesPerSegment: 4,
      }),
    /metadata is not ready/,
  )
  assert.throws(
    () =>
      planVideoSemanticEvidence({
        video: video(),
        frames: frames(),
        generationId: 'generation-1',
        profileOverride: 'auto',
        maximumFramesPerSegment: 0,
      }),
    /frame budget/,
  )
})
