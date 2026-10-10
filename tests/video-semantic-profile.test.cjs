const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  VIDEO_SEMANTIC_PROFILE_IDS,
  VIDEO_SEMANTIC_PROFILE_REVISION,
  VIDEO_SEMANTIC_PROFILES,
  isVideoSemanticProfileId,
} = loadTsModule('shared/videoSemantic.ts')
const { planVideoSemanticProfile } = loadTsModule('electron/videoSemanticProfilePlanner.ts')

test('video semantic contract exposes eight stable profiles with bounded policies', () => {
  assert.equal(VIDEO_SEMANTIC_PROFILE_REVISION, '2026-08-14.v1')
  assert.deepEqual(VIDEO_SEMANTIC_PROFILE_IDS, [
    'general',
    'film-series-animation',
    'short-form-vlog',
    'meeting-interview-podcast',
    'course-tutorial-screen',
    'game-stream',
    'surveillance-fixed',
    'sports',
  ])
  for (const profileId of VIDEO_SEMANTIC_PROFILE_IDS) {
    assert.equal(isVideoSemanticProfileId(profileId), true)
    const profile = VIDEO_SEMANTIC_PROFILES[profileId]
    assert.equal(profile.id, profileId)
    assert.ok(profile.policy.minSegmentMs <= profile.policy.targetSegmentMs)
    assert.ok(profile.policy.targetSegmentMs <= profile.policy.maxSegmentMs)
    assert.ok(profile.policy.minFrames >= 2)
    assert.ok(profile.policy.maxFrames <= 10)
    assert.ok(profile.policy.minFrames <= profile.policy.maxFrames)
    assert.ok(profile.policy.preferredFrameWidth >= 256)
    assert.equal(new Set(profile.policy.evidencePriority).size, 6)
  }
  assert.equal(isVideoSemanticProfileId('unknown'), false)
  assert.equal(VIDEO_SEMANTIC_PROFILES['surveillance-fixed'].policy.skipStaticSegments, true)
})

test('explicit user profile override always wins and is explainable', () => {
  const plan = planVideoSemanticProfile({
    userOverride: 'course-tutorial-screen',
    motionDensity: 1,
    fixedCameraScore: 1,
  })
  assert.equal(plan.profileId, 'course-tutorial-screen')
  assert.equal(plan.decision, 'user-override')
  assert.equal(plan.confidence, 1)
  assert.deepEqual(plan.reasons, ['user-override'])
  assert.equal(plan.scores['course-tutorial-screen'], 1)
})

const fixtures = [
  {
    expected: 'film-series-animation',
    signals: {
      durationMs: 7_200_000,
      shotChangeRate: 0.34,
      speechRatio: 0.48,
      motionDensity: 0.42,
    },
  },
  {
    expected: 'short-form-vlog',
    signals: {
      durationMs: 55_000,
      width: 1080,
      height: 1920,
      shotChangeRate: 0.78,
      speechRatio: 0.5,
    },
  },
  {
    expected: 'meeting-interview-podcast',
    signals: {
      durationMs: 3_600_000,
      speechRatio: 0.92,
      motionDensity: 0.18,
      fixedCameraScore: 0.75,
      shotChangeRate: 0.1,
    },
  },
  {
    expected: 'course-tutorial-screen',
    signals: {
      durationMs: 2_400_000,
      speechRatio: 0.82,
      ocrCoverage: 0.86,
      motionDensity: 0.2,
      screenContentRatio: 0.94,
    },
  },
  {
    expected: 'game-stream',
    signals: {
      durationMs: 5_400_000,
      ocrCoverage: 0.45,
      motionDensity: 0.86,
      screenContentRatio: 0.96,
      audioPeakDensity: 0.62,
      fileName: 'gameplay-session.webm',
    },
  },
  {
    expected: 'surveillance-fixed',
    signals: {
      durationMs: 28_800_000,
      speechRatio: 0.01,
      motionDensity: 0.03,
      fixedCameraScore: 0.98,
      shotChangeRate: 0.01,
    },
  },
  {
    expected: 'sports',
    signals: {
      durationMs: 6_600_000,
      shotChangeRate: 0.72,
      motionDensity: 0.96,
      ocrCoverage: 0.24,
      audioPeakDensity: 0.88,
      fileName: 'football-match.mp4',
    },
  },
]

for (const fixture of fixtures) {
  test(`automatic profile planner selects ${fixture.expected}`, () => {
    const first = planVideoSemanticProfile(fixture.signals)
    const second = planVideoSemanticProfile(structuredClone(fixture.signals))
    assert.equal(first.profileId, fixture.expected)
    assert.equal(first.decision, 'automatic')
    assert.ok(first.confidence >= 0.5 && first.confidence <= 0.99)
    assert.ok(first.reasons.length > 0)
    assert.deepEqual(first, second, 'same normalized evidence must produce an identical plan')
  })
}

test('missing or weak filename-only evidence falls back to general', () => {
  const empty = planVideoSemanticProfile({})
  assert.equal(empty.profileId, 'general')
  assert.equal(empty.decision, 'fallback')
  assert.deepEqual(empty.reasons, ['insufficient-signals'])

  const weakPath = planVideoSemanticProfile({ fileName: 'important-meeting.mp4' })
  assert.equal(weakPath.profileId, 'general')
  assert.equal(weakPath.decision, 'fallback')
})

test('planner clamps invalid normalized signals and never mutates input', () => {
  const signals = {
    durationMs: -1,
    width: Number.NaN,
    height: Number.POSITIVE_INFINITY,
    motionDensity: 9,
    speechRatio: -4,
    ocrCoverage: Number.NaN,
    userOverride: 'not-a-profile',
  }
  const before = { ...signals }
  const plan = planVideoSemanticProfile(signals)
  assert.deepEqual(signals, before)
  assert.equal(isVideoSemanticProfileId(plan.profileId), true)
  assert.ok(Number.isFinite(plan.confidence))
  for (const score of Object.values(plan.scores)) {
    assert.ok(Number.isFinite(score))
    assert.ok(score >= 0 && score <= 1)
  }
})
