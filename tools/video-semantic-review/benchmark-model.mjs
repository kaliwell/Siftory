export const BENCHMARK_REVIEW_SCHEMA_VERSION = 1

export const SEMANTIC_VERDICTS = Object.freeze([
  { id: 'consistent', label: '像', symbol: '✓' },
  { id: 'partial', label: '部分像', symbol: '≈' },
  { id: 'inconsistent', label: '不像', symbol: '×' },
])

const VERDICTS = new Set(['unreviewed', ...SEMANTIC_VERDICTS.map((item) => item.id)])
const HALLUCINATIONS = new Set(['none', 'minor', 'major'])
const TIMESTAMPS = new Set(['not-applicable', 'accurate', 'approximate', 'wrong'])

function boundedText(value, maximum) {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

export function createEmptyBenchmarkJudgment() {
  return {
    verdict: 'unreviewed',
    hallucination: 'none',
    timestamp: 'not-applicable',
    watchedFullSegment: false,
    notes: '',
    reviewedAt: null,
  }
}

export function normalizeBenchmarkJudgment(value) {
  const input = value && typeof value === 'object' ? value : {}
  return {
    verdict: VERDICTS.has(input.verdict) ? input.verdict : 'unreviewed',
    hallucination: HALLUCINATIONS.has(input.hallucination) ? input.hallucination : 'none',
    timestamp: TIMESTAMPS.has(input.timestamp) ? input.timestamp : 'not-applicable',
    watchedFullSegment: input.watchedFullSegment === true,
    notes: boundedText(input.notes, 1_000),
    reviewedAt:
      typeof input.reviewedAt === 'string' && input.reviewedAt.length <= 40
        ? input.reviewedAt
        : null,
  }
}

export function isBenchmarkJudgmentComplete(value) {
  return normalizeBenchmarkJudgment(value).verdict !== 'unreviewed'
}

export function summarizeBenchmarkReview(samples, judgments) {
  const generated = samples.filter((sample) => sample.resultState === 'ready')
  const reviewed = generated.filter((sample) =>
    isBenchmarkJudgmentComplete(judgments[sample.sampleId]),
  )
  const fullyWatched = reviewed.filter(
    (sample) => normalizeBenchmarkJudgment(judgments[sample.sampleId]).watchedFullSegment,
  )
  const counts = { consistent: 0, partial: 0, inconsistent: 0, minor: 0, major: 0 }
  const timestamps = { applicable: 0, accurate: 0, approximate: 0, wrong: 0 }
  for (const sample of reviewed) {
    const judgment = normalizeBenchmarkJudgment(judgments[sample.sampleId])
    counts[judgment.verdict] += 1
    if (judgment.hallucination === 'minor' || judgment.hallucination === 'major')
      counts[judgment.hallucination] += 1
    if (judgment.timestamp !== 'not-applicable') {
      timestamps.applicable += 1
      timestamps[judgment.timestamp] += 1
    }
  }
  const byProfile = {}
  for (const sample of samples) {
    byProfile[sample.profileId] ||= {
      planned: 0,
      generated: 0,
      reviewed: 0,
      consistent: 0,
      partial: 0,
      inconsistent: 0,
    }
    const row = byProfile[sample.profileId]
    row.planned += 1
    if (sample.resultState !== 'ready') continue
    row.generated += 1
    const judgment = normalizeBenchmarkJudgment(judgments[sample.sampleId])
    if (!isBenchmarkJudgmentComplete(judgment)) continue
    row.reviewed += 1
    row[judgment.verdict] += 1
  }
  return {
    planned: samples.length,
    generated: generated.length,
    reviewed: reviewed.length,
    unreviewedGenerated: Math.max(0, generated.length - reviewed.length),
    pending: Math.max(0, samples.length - generated.length),
    completionPercent: generated.length
      ? Math.round((reviewed.length / generated.length) * 100)
      : 0,
    fullWatch: {
      completed: fullyWatched.length,
      incomplete: Math.max(0, generated.length - fullyWatched.length),
      completionPercent: generated.length
        ? Math.round((fullyWatched.length / generated.length) * 100)
        : 0,
    },
    deepTruthReady:
      samples.length > 0 &&
      generated.length === samples.length &&
      reviewed.length === generated.length &&
      fullyWatched.length === generated.length,
    semanticAcceptancePercent: reviewed.length
      ? Math.round(((counts.consistent + counts.partial) / reviewed.length) * 100)
      : 0,
    strictConsistencyPercent: reviewed.length
      ? Math.round((counts.consistent / reviewed.length) * 100)
      : 0,
    counts,
    timestamps,
    byProfile,
  }
}

export function buildBenchmarkReviewExport(samples, judgments, now = new Date()) {
  const records = samples.flatMap((sample) => {
    const judgment = normalizeBenchmarkJudgment(judgments[sample.sampleId])
    if (sample.resultState !== 'ready' || judgment.verdict === 'unreviewed') return []
    return [
      {
        sampleId: sample.sampleId,
        profileId: sample.profileId,
        verdict: judgment.verdict,
        hallucination: judgment.hallucination,
        timestamp: judgment.timestamp,
        watchedFullSegment: judgment.watchedFullSegment,
        reviewedAt: judgment.reviewedAt,
      },
    ]
  })
  return {
    schemaVersion: BENCHMARK_REVIEW_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    metricNote: '人工语义一致性代理指标，不等同于正式召回率。',
    privacy: {
      anonymousSampleIdsOnly: true,
      originalPathsIncluded: false,
      originalNamesIncluded: false,
      freeTextIncluded: false,
    },
    summary: summarizeBenchmarkReview(samples, judgments),
    records,
  }
}
