// ── Subject Search Bridge ────────────────────────────────

import type {
  SubjectBBox,
  SubjectDetectionResult,
  SubjectSearchResult,
} from '../../shared/ipc-contract'

export const subjectSearchBridge = {
  detect: (imagePath: string): Promise<SubjectDetectionResult> =>
    window.electronAPI.subject.detect(imagePath),

  search: (
    imagePath: string,
    topK?: number,
    subject?: SubjectBBox,
    segmentationSessionId?: string,
  ): Promise<{
    ok: boolean
    results: SubjectSearchResult[]
    error?: string
    subjectLabel?: string
  }> => window.electronAPI.subject.search(imagePath, topK, subject, segmentationSessionId),

  selectImage: (): Promise<string | null> => window.electronAPI.subject.selectImage(),
}
