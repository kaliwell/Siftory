export const REGRESSION_REVIEW_SCHEMA_VERSION = 1

export const REGRESSION_SAMPLE_IDS = Object.freeze([
  'candidate-094ab8b92086',
  'candidate-479985fc3c5a',
  'candidate-93c0a58df3a7',
  'candidate-879551b6d52c',
  'candidate-25e59c0f81fb',
  'candidate-2b5d19012413',
])

export const REGRESSION_VERDICTS = Object.freeze([
  { id: 'improved', label: '改善', symbol: '↑' },
  { id: 'same', label: '持平', symbol: '＝' },
  { id: 'regressed', label: '退化', symbol: '↓' },
])

export const OUTPUT_PREFERENCES = Object.freeze([
  { id: 'v7', label: 'V7 更好' },
  { id: 'equivalent', label: '两版相当' },
  { id: 'v1', label: 'V1 更好' },
  { id: 'neither', label: '两版都不理想' },
])

const VERDICTS = new Set(['unreviewed', ...REGRESSION_VERDICTS.map((item) => item.id)])
const PREFERENCES = new Set(['unselected', ...OUTPUT_PREFERENCES.map((item) => item.id)])

function boundedText(value, maximum) {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

export function createEmptyRegressionJudgment() {
  return {
    verdict: 'unreviewed',
    preferredOutput: 'unselected',
    watchedFullSegment: false,
    notes: '',
    reviewedAt: null,
  }
}

export function normalizeRegressionJudgment(value) {
  const input = value && typeof value === 'object' ? value : {}
  return {
    verdict: VERDICTS.has(input.verdict) ? input.verdict : 'unreviewed',
    preferredOutput: PREFERENCES.has(input.preferredOutput) ? input.preferredOutput : 'unselected',
    watchedFullSegment: input.watchedFullSegment === true,
    notes: boundedText(input.notes, 1_000),
    reviewedAt:
      typeof input.reviewedAt === 'string' && input.reviewedAt.length <= 40
        ? input.reviewedAt
        : null,
  }
}

export function isRegressionJudgmentComplete(value) {
  const judgment = normalizeRegressionJudgment(value)
  return judgment.verdict !== 'unreviewed' && judgment.preferredOutput !== 'unselected'
}

export function summarizeRegressionReview(samples, judgments) {
  const comparable = samples.filter(
    (sample) => sample.v1?.resultState === 'ready' && sample.v7?.resultState === 'ready',
  )
  const reviewed = comparable.filter((sample) =>
    isRegressionJudgmentComplete(judgments[sample.sampleId]),
  )
  const verdicts = { improved: 0, same: 0, regressed: 0 }
  const preferences = { v1: 0, v7: 0, neither: 0, equivalent: 0 }
  let watchedFullSegment = 0
  for (const sample of reviewed) {
    const judgment = normalizeRegressionJudgment(judgments[sample.sampleId])
    verdicts[judgment.verdict] += 1
    preferences[judgment.preferredOutput] += 1
    if (judgment.watchedFullSegment) watchedFullSegment += 1
  }
  return {
    planned: samples.length,
    comparable: comparable.length,
    reviewed: reviewed.length,
    unreviewed: Math.max(0, comparable.length - reviewed.length),
    completionPercent: comparable.length
      ? Math.round((reviewed.length / comparable.length) * 100)
      : 0,
    verdicts,
    preferences,
    watchedFullSegment,
  }
}

export function buildRegressionReviewExport(samples, judgments, now = new Date()) {
  const records = samples.flatMap((sample) => {
    const judgment = normalizeRegressionJudgment(judgments[sample.sampleId])
    if (!isRegressionJudgmentComplete(judgment)) return []
    return [
      {
        sampleId: sample.sampleId,
        profileId: sample.profileId,
        baselineVerdict: sample.baselineVerdict || 'unknown',
        verdict: judgment.verdict,
        preferredOutput: judgment.preferredOutput,
        watchedFullSegment: judgment.watchedFullSegment,
        reviewedAt: judgment.reviewedAt,
      },
    ]
  })
  return {
    schemaVersion: REGRESSION_REVIEW_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    purpose: 'Qwen3-VL 2B V1/V7 六条定向回归人工对照',
    privacy: {
      anonymousSampleIdsOnly: true,
      originalPathsIncluded: false,
      originalNamesIncluded: false,
      freeTextIncluded: false,
      rawModelOutputIncluded: false,
    },
    summary: summarizeRegressionReview(samples, judgments),
    records,
  }
}
