export const AUDIO_REVIEW_SCHEMA_VERSION = 1

export const AUDIO_REVIEW_SAMPLE = Object.freeze({
  sampleId: 'sample-a569',
  prefix: 'a5695170b24d',
})

const VERDICTS = new Set(['unreviewed', 'correct', 'wrong-speaker', 'wrong-boundary', 'unusable'])

function boundedText(value, maximum) {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

export function createEmptyAudioJudgment() {
  return {
    listenedFullSegment: false,
    verdict: 'unreviewed',
    correctedSpeaker: '',
    notes: '',
    reviewedAt: null,
  }
}

export function normalizeAudioJudgment(value) {
  const input = value && typeof value === 'object' ? value : {}
  return {
    listenedFullSegment: input.listenedFullSegment === true,
    verdict: VERDICTS.has(input.verdict) ? input.verdict : 'unreviewed',
    correctedSpeaker: boundedText(input.correctedSpeaker, 80),
    notes: boundedText(input.notes, 1_000),
    reviewedAt:
      typeof input.reviewedAt === 'string' && input.reviewedAt.length <= 40
        ? input.reviewedAt
        : null,
  }
}

export function isAudioJudgmentComplete(value) {
  return normalizeAudioJudgment(value).verdict !== 'unreviewed'
}

export function summarizeAudioReview(segments, judgments) {
  const totals = {
    segments: segments.length,
    completed: 0,
    correct: 0,
    wrongSpeaker: 0,
    wrongBoundary: 0,
    unusable: 0,
  }
  for (const segment of segments) {
    const judgment = normalizeAudioJudgment(judgments[segment.segmentId])
    if (isAudioJudgmentComplete(judgment)) totals.completed += 1
    if (judgment.verdict === 'correct') totals.correct += 1
    if (judgment.verdict === 'wrong-speaker') totals.wrongSpeaker += 1
    if (judgment.verdict === 'wrong-boundary') totals.wrongBoundary += 1
    if (judgment.verdict === 'unusable') totals.unusable += 1
  }
  const assessed = totals.correct + totals.wrongSpeaker
  return {
    ...totals,
    completionPercent: totals.segments ? Math.round((totals.completed / totals.segments) * 100) : 0,
    speakerAccuracyPercent: assessed
      ? Number(((totals.correct / assessed) * 100).toFixed(1))
      : null,
  }
}

export function buildAudioReviewExport(
  segments,
  judgments,
  metadata,
  kind = 'summary',
  now = new Date(),
) {
  const summary = summarizeAudioReview(segments, judgments)
  const records = segments.map((segment) => {
    const judgment = normalizeAudioJudgment(judgments[segment.segmentId])
    const base = {
      segmentId: segment.segmentId,
      speakerId: segment.speakerId || null,
      complete: isAudioJudgmentComplete(judgment),
      verdict: judgment.verdict,
      reviewedAt: judgment.reviewedAt,
    }
    return kind === 'full' ? { ...base, judgment } : base
  })
  return {
    schemaVersion: AUDIO_REVIEW_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    sampleId: metadata?.sampleId || AUDIO_REVIEW_SAMPLE.sampleId,
    generationId: metadata?.generationId || null,
    privacy: {
      anonymousIdsOnly: true,
      originalPathsIncluded: false,
      originalNamesIncluded: false,
      transcriptTextIncluded: false,
      freeTextIncluded: kind === 'full',
    },
    summary,
    records,
  }
}
