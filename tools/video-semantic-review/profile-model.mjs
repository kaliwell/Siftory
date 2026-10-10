export const PROFILE_REVIEW_SCHEMA_VERSION = 1

export const VIDEO_PROFILES = Object.freeze([
  { id: 'general', label: '通用视频', shortLabel: '通用' },
  { id: 'film-series-animation', label: '电影、剧集或动画', shortLabel: '影视/动画' },
  { id: 'short-form-vlog', label: '短视频或 Vlog', shortLabel: '短视频' },
  { id: 'meeting-interview-podcast', label: '会议、访谈或播客', shortLabel: '会议/访谈' },
  { id: 'course-tutorial-screen', label: '课程、教程或录屏', shortLabel: '课程/录屏' },
  { id: 'game-stream', label: '游戏或直播', shortLabel: '游戏/直播' },
  { id: 'surveillance-fixed', label: '监控或固定机位', shortLabel: '监控/固定' },
  { id: 'sports', label: '体育运动', shortLabel: '体育' },
])

const PROFILE_IDS = new Set(VIDEO_PROFILES.map((profile) => profile.id))
const VERDICTS = new Set(['unreviewed', 'accepted', 'skipped'])

function boundedText(value, maximum) {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

export function createEmptyProfileJudgment() {
  return {
    verdict: 'unreviewed',
    profileId: '',
    notes: '',
    reviewedAt: null,
  }
}

export function normalizeProfileJudgment(value) {
  const input = value && typeof value === 'object' ? value : {}
  const verdict = VERDICTS.has(input.verdict) ? input.verdict : 'unreviewed'
  const profileId = PROFILE_IDS.has(input.profileId) ? input.profileId : ''
  return {
    verdict: verdict === 'accepted' && !profileId ? 'unreviewed' : verdict,
    profileId: verdict === 'accepted' ? profileId : '',
    notes: boundedText(input.notes, 1_000),
    reviewedAt:
      typeof input.reviewedAt === 'string' && input.reviewedAt.length <= 40
        ? input.reviewedAt
        : null,
  }
}

export function isProfileJudgmentComplete(value) {
  const judgment = normalizeProfileJudgment(value)
  return judgment.verdict === 'accepted' || judgment.verdict === 'skipped'
}

export function summarizeProfileReview(samples, judgments, targetPerProfile = 10) {
  return summarizeSelectedProfileReview(samples, judgments, targetPerProfile)
}

export function summarizeSelectedProfileReview(
  samples,
  judgments,
  targetPerProfile = 10,
  targetProfileIds = VIDEO_PROFILES.map((profile) => profile.id),
) {
  const selectedProfileIds = new Set(
    Array.isArray(targetProfileIds)
      ? targetProfileIds.filter((profileId) => PROFILE_IDS.has(profileId))
      : VIDEO_PROFILES.map((profile) => profile.id),
  )
  const perProfile = Object.fromEntries(
    VIDEO_PROFILES.filter((profile) => selectedProfileIds.has(profile.id)).map((profile) => [
      profile.id,
      { accepted: 0, target: targetPerProfile },
    ]),
  )
  let completed = 0
  let skipped = 0
  for (const sample of samples) {
    const judgment = normalizeProfileJudgment(judgments[sample.sampleId])
    if (isProfileJudgmentComplete(judgment)) completed += 1
    if (judgment.verdict === 'skipped') skipped += 1
    if (judgment.verdict === 'accepted' && perProfile[judgment.profileId])
      perProfile[judgment.profileId].accepted += 1
  }
  const readyProfiles = Object.values(perProfile).filter(
    (profile) => profile.accepted >= targetPerProfile,
  ).length
  return {
    samples: samples.length,
    completed,
    skipped,
    accepted: completed - skipped,
    unreviewed: Math.max(0, samples.length - completed),
    readyProfiles,
    totalProfiles: selectedProfileIds.size,
    readyForBenchmark: selectedProfileIds.size > 0 && readyProfiles === selectedProfileIds.size,
    completionPercent: samples.length ? Math.round((completed / samples.length) * 100) : 0,
    perProfile,
  }
}

export function buildProfileReviewExport(
  samples,
  judgments,
  now = new Date(),
  targetProfileIds = VIDEO_PROFILES.map((profile) => profile.id),
) {
  const records = samples.flatMap((sample) => {
    const judgment = normalizeProfileJudgment(judgments[sample.sampleId])
    if (judgment.verdict !== 'accepted') return []
    return [
      {
        sampleId: sample.sampleId,
        profileId: judgment.profileId,
        durationBucket: sample.durationBucket,
        orientation: sample.orientation,
        hasAudio: sample.hasAudio,
        hasTranscript: sample.hasTranscript,
        reviewedAt: judgment.reviewedAt,
      },
    ]
  })
  return {
    schemaVersion: PROFILE_REVIEW_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    privacy: {
      anonymousSampleIdsOnly: true,
      originalPathsIncluded: false,
      originalNamesIncluded: false,
      freeTextIncluded: false,
    },
    summary: summarizeSelectedProfileReview(samples, judgments, 10, targetProfileIds),
    records,
  }
}
