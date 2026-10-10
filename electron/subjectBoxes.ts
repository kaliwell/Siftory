// ── Subject bounding-box utilities (pure functions) ───────
// Extracted from subjectSearchService so NMS/IoU can be unit-tested
// without loading sharp / onnxruntime-node / the rerank graph.

export interface SubjectBBox {
  x: number
  y: number
  w: number
  h: number
  confidence: number
  label: string
}

export function iou(a: SubjectBBox, b: SubjectBBox): number {
  const ax1 = a.x,
    ay1 = a.y,
    ax2 = a.x + a.w,
    ay2 = a.y + a.h
  const bx1 = b.x,
    by1 = b.y,
    bx2 = b.x + b.w,
    by2 = b.y + b.h
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1))
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1))
  const inter = ix * iy
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/** Non-maximum suppression: keeps highest-confidence boxes, drops overlaps. */
export function nms(boxes: SubjectBBox[], iouThresh: number): SubjectBBox[] {
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence)
  const kept: SubjectBBox[] = []
  for (const box of sorted) {
    if (kept.every((k) => iou(box, k) <= iouThresh)) kept.push(box)
  }
  return kept
}

/**
 * Pick the primary subject for search. YOLO detections are ordered by
 * confidence, but the user's intent is the image's MAIN subject — a small
 * high-confidence item (e.g. a circular eye icon) must not beat the large
 * subject (the cat). Fallback pseudo-subjects (label 'subject*') only win
 * when no YOLO detection exists.
 */
export function pickPrimarySubject(subjects: SubjectBBox[]): SubjectBBox | null {
  if (subjects.length === 0) return null
  const detected = subjects.filter((s) => !s.label.startsWith('subject'))
  if (detected.length === 0) return subjects[0]
  let best = detected[0]
  for (const s of detected) {
    if (s.w * s.h > best.w * best.h) best = s
  }
  return best
}

/**
 * Display-oriented dimensions. EXIF orientation 5–8 transposes the image
 * (90°/270° rotations); browsers and the thumbnail pipeline apply it, so
 * any bbox/mask coordinate space meant to match what the user sees must
 * swap width/height for those values. sharp's metadata() always reports
 * the raw (unrotated) dimensions.
 */
export function orientedDimensions(
  rawWidth: number,
  rawHeight: number,
  orientation: number | undefined,
): { width: number; height: number } {
  return orientation !== undefined && orientation >= 5 && orientation <= 8
    ? { width: rawHeight, height: rawWidth }
    : { width: rawWidth, height: rawHeight }
}
