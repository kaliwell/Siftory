export const REVIEW_SCHEMA_VERSION = 1

export const REVIEW_SAMPLES = Object.freeze(
  [
    ['sample-25ed', '25ed523fd145', '3.4 MB', 34_100, '720×1280', 'h264', 'short-form-vlog'],
    ['sample-097f', '097fb3d0b5aa', '26.8 MB', 15_100, '3840×2160', 'hevc', 'short-form-vlog'],
    ['sample-248a', '248aeaa4c13d', '221.8 MB', 37_000, '3840×2160', 'h264', 'short-form-vlog'],
    ['sample-ceda', 'ceda2034bb2d', '4.08 GB', 5_950_500, '1920×1080', 'h264', 'general'],
    ['sample-07ac', '07ace04a0011', '8.24 GB', 12_007_200, '1920×1080', 'h264', 'general'],
    ['sample-9461', '94614cebcf3c', '10.17 GB', 14_529_500, '1920×1080', 'h264', 'general'],
    ['sample-e49e', 'e49e32410674', '0.7 MB', 14_900, '960×720', 'h264', 'short-form-vlog'],
    ['sample-83d9', '83d93d2223d3', '1.6 MB', 16_700, '720×1280', 'hevc', 'short-form-vlog'],
    ['sample-ebe4', 'ebe4b0bf974f', '3.7 MB', 47_800, '912×720', 'hevc', 'short-form-vlog'],
    ['sample-19d2', '19d2ffb469eb', '5.0 MB', 93_000, '480×360', 'h264', 'short-form-vlog'],
    ['sample-a551', 'a5512f5def6e', '8.9 MB', 24_900, '1280×720', 'h264', 'short-form-vlog'],
    ['sample-e666', 'e666daf94850', '9.7 MB', 61_000, '1710×720', 'h264', 'short-form-vlog'],
    ['sample-59fa', '59faa4639800', '12.6 MB', 30_100, '1080×1920', 'h264', 'short-form-vlog'],
    ['sample-021b', '021b1160eeed', '16.0 MB', 64_800, '2560×1440', 'h264', 'short-form-vlog'],
    ['sample-2952', '2952263bb731', '31.5 MB', 45_700, '1920×1080', 'h264', 'short-form-vlog'],
    ['sample-2702', '270229404eef', '53.4 MB', 222_000, '1080×1920', 'hevc', 'general'],
    ['sample-a569', 'a5695170b24d', '59.7 MB', 1_668_700, '368×640', 'hevc', 'general'],
    ['sample-39de', '39de224eca70', '97.8 MB', 253_300, '1336×720', 'h264', 'general'],
    ['sample-5c66', '5c66930f2990', '4.12 GB', 4_864_700, '1920×1080', 'h264', 'general'],
    ['sample-0b05', '0b0594e401c4', '4.97 GB', 7_274_000, '1920×1080', 'h264', 'general'],
  ].map(([sampleId, prefix, sizeLabel, durationMs, resolution, codec, profile]) => ({
    sampleId,
    prefix,
    sizeLabel,
    durationMs,
    resolution,
    codec,
    profile,
  })),
)

const CONSISTENCY = new Set(['unreviewed', 'consistent', 'partial', 'inconsistent'])
const HALLUCINATION = new Set(['none', 'minor', 'major'])

function boundedText(value, maximum) {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

export function createEmptyJudgment() {
  return {
    watchedFullSegment: false,
    scene: '',
    personCount: null,
    events: '',
    ocr: '',
    consistency: 'unreviewed',
    hallucination: 'none',
    notes: '',
    reviewedAt: null,
  }
}

export function normalizeJudgment(value) {
  const input = value && typeof value === 'object' ? value : {}
  const numericPeople = Number(input.personCount)
  return {
    watchedFullSegment: input.watchedFullSegment === true,
    scene: boundedText(input.scene, 1_000),
    personCount:
      Number.isSafeInteger(numericPeople) && numericPeople >= 0 && numericPeople <= 100
        ? numericPeople
        : null,
    events: boundedText(input.events, 4_000),
    ocr: boundedText(input.ocr, 2_000),
    consistency: CONSISTENCY.has(input.consistency) ? input.consistency : 'unreviewed',
    hallucination: HALLUCINATION.has(input.hallucination) ? input.hallucination : 'none',
    notes: boundedText(input.notes, 2_000),
    reviewedAt:
      typeof input.reviewedAt === 'string' && input.reviewedAt.length <= 40
        ? input.reviewedAt
        : null,
  }
}

export function isJudgmentComplete(value) {
  const judgment = normalizeJudgment(value)
  return judgment.consistency === 'consistent' || judgment.consistency === 'inconsistent'
}

export function targetRange(durationMs) {
  const safeDuration = Math.max(1_000, Math.floor(Number(durationMs) || 0))
  const spanMs = Math.min(20_000, safeDuration)
  const startMs = Math.max(0, Math.floor((safeDuration - spanMs) / 2))
  return { startMs, endMs: Math.min(safeDuration, startMs + spanMs) }
}

export function summarizeReview(samples, judgments) {
  const totals = {
    samples: samples.length,
    available: 0,
    inferencePassed: 0,
    completed: 0,
    consistent: 0,
    partial: 0,
    inconsistent: 0,
    hallucinationMinor: 0,
    hallucinationMajor: 0,
  }
  for (const sample of samples) {
    if (sample.available) totals.available += 1
    if (sample.inference?.ok) totals.inferencePassed += 1
    const judgment = normalizeJudgment(judgments[sample.sampleId])
    if (isJudgmentComplete(judgment)) totals.completed += 1
    if (judgment.consistency === 'consistent') totals.consistent += 1
    if (judgment.consistency === 'partial') totals.partial += 1
    if (judgment.consistency === 'inconsistent') totals.inconsistent += 1
    if (judgment.hallucination === 'minor') totals.hallucinationMinor += 1
    if (judgment.hallucination === 'major') totals.hallucinationMajor += 1
  }
  return {
    ...totals,
    completionPercent: totals.samples ? Math.round((totals.completed / totals.samples) * 100) : 0,
    strictJsonPercent: totals.samples
      ? Number(((totals.inferencePassed / totals.samples) * 100).toFixed(1))
      : 0,
  }
}

export function buildReviewExport(samples, judgments, kind = 'summary', now = new Date()) {
  const summary = summarizeReview(samples, judgments)
  const records = samples.map((sample) => {
    const judgment = normalizeJudgment(judgments[sample.sampleId])
    const base = {
      sampleId: sample.sampleId,
      profile: sample.profile,
      inferenceOk: Boolean(sample.inference?.ok),
      complete: isJudgmentComplete(judgment),
      consistency: judgment.consistency,
      hallucination: judgment.hallucination,
      reviewedAt: judgment.reviewedAt,
    }
    return kind === 'full' ? { ...base, judgment } : base
  })
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    privacy: {
      anonymousSampleIdsOnly: true,
      originalPathsIncluded: false,
      originalNamesIncluded: false,
      freeTextIncluded: kind === 'full',
    },
    summary,
    records,
  }
}
