import type {
  UnifiedDegradedReason,
  UnifiedSearchEvidence,
  UnifiedSearchHitType,
  UnifiedSearchRankingFeedback,
} from '../../shared/ipc-contract'

const HIT_LABEL_KEYS: Record<UnifiedSearchHitType, string> = {
  filename: 'Filename match',
  'image-semantic': 'Image semantic match',
  subject: 'Subject match',
  duplicate: 'Duplicate match',
  'video-visual': 'Video visual match',
  'video-semantic': 'Video semantic match',
  dialogue: 'Dialogue match',
  mixed: 'Mixed evidence match',
}

const DEGRADED_LABEL_KEYS: Record<UnifiedDegradedReason, string> = {
  'vector-corrupt': 'Vector index is damaged',
  'model-missing': 'Required model is missing',
  'task-failed': 'Index task failed',
  'index-stale': 'Index needs rebuilding',
  'source-offline': 'Source is offline',
  'remote-content-required': 'Remote original is required',
}

const FEEDBACK_REASON_LABEL_KEYS: Record<UnifiedSearchRankingFeedback['reason'], string> = {
  relevant: 'Boosted by your relevant feedback',
  irrelevant: 'Demoted by your irrelevant feedback',
  'timestamp-wrong': 'Adjusted because the hit time was marked wrong',
  'relevant-and-timestamp-wrong': 'Relevant result; incorrect hit time was deprioritized',
  'irrelevant-and-timestamp-wrong': 'Irrelevant result and incorrect hit time',
}

export function unifiedEvidenceHitLabelKey(evidence: UnifiedSearchEvidence): string {
  return HIT_LABEL_KEYS[evidence.hitType]
}

export function unifiedEvidenceModelLabel(evidence: UnifiedSearchEvidence): string | undefined {
  if (!evidence.modelSources?.length) return undefined
  return evidence.modelSources
    .map((model) =>
      model.modelRevision ? `${model.modelId}@${model.modelRevision}` : model.modelId,
    )
    .join(' + ')
}

export function unifiedDegradedLabelKey(reason: UnifiedDegradedReason): string {
  return DEGRADED_LABEL_KEYS[reason]
}

export function unifiedFeedbackReasonLabelKey(feedback: UnifiedSearchRankingFeedback): string {
  return FEEDBACK_REASON_LABEL_KEYS[feedback.reason]
}
