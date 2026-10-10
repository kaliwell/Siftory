import type { UnifiedVideoEvidenceSource, UnifiedVideoHit } from '../../shared/ipc-contract'

const EVIDENCE_LABEL_KEYS: Record<UnifiedVideoEvidenceSource, string> = {
  'cached-frame': 'Cached frame',
  'embedded-subtitle': 'Embedded subtitle',
  'ai-visual-semantic': 'AI visual semantics',
  ocr: 'OCR',
  'transcript-reference': 'Transcript reference',
  'audio-event': 'Audio event',
}

export function videoHitLabelKey(hit: UnifiedVideoHit): string {
  if (hit.kind === 'fused') return 'Fused evidence hit'
  if (hit.kind === 'visual') return 'Visual hit'
  if (hit.kind === 'subtitle') return 'Subtitle hit'
  return 'AI semantic hit'
}

export function videoHitEvidenceLabelKeys(hit: UnifiedVideoHit): string[] {
  return videoEvidenceSourceLabelKeys(hit.evidenceSources)
}

export function videoEvidenceSourceLabelKeys(
  sources: readonly UnifiedVideoEvidenceSource[],
): string[] {
  return [...new Set(sources)].map((source) => EVIDENCE_LABEL_KEYS[source])
}

export function videoHitModelLabel(hit: UnifiedVideoHit): string | undefined {
  const models = hit.generatedByAll?.length
    ? hit.generatedByAll
    : hit.generatedBy
      ? [hit.generatedBy]
      : []
  if (!models.length) return undefined
  return models
    .map((model) =>
      model.modelRevision ? `${model.modelId}@${model.modelRevision}` : model.modelId,
    )
    .join(' + ')
}
