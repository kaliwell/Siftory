import type { SamPoint } from '../../shared/ipc-contract'

export const MAX_SAM_PROMPTS = 32

export type SubjectImagePoint = { x: number; y: number }

export interface SubjectBoxPercentStyle {
  left: string
  top: string
  width: string
  height: string
}

export interface SubjectImageBox {
  x: number
  y: number
  w: number
  h: number
}

export function subjectBoxFromPoints(
  start: SubjectImagePoint,
  end: SubjectImagePoint,
): SubjectImageBox | null {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  const w = Math.abs(end.x - start.x)
  const h = Math.abs(end.y - start.y)
  return w >= 4 && h >= 4 ? { x, y, w, h } : null
}

/**
 * React treats numeric inset/size styles as CSS pixels. Subject coordinates
 * are normalized to the displayed image, so the overlay must explicitly use
 * percentage units to stay aligned at every modal size and DPI.
 */
export function subjectBoxPercentStyle(
  start: SubjectImagePoint,
  end: SubjectImagePoint,
  imageWidth: number,
  imageHeight: number,
): SubjectBoxPercentStyle | null {
  if (imageWidth <= 0 || imageHeight <= 0) return null
  return {
    left: `${(Math.min(start.x, end.x) / imageWidth) * 100}%`,
    top: `${(Math.min(start.y, end.y) / imageHeight) * 100}%`,
    width: `${(Math.abs(end.x - start.x) / imageWidth) * 100}%`,
    height: `${(Math.abs(end.y - start.y) / imageHeight) * 100}%`,
  }
}

export function clampSubjectPoint(
  point: SubjectImagePoint,
  width: number,
  height: number,
): SubjectImagePoint {
  return {
    x: Math.max(0, Math.min(Math.max(0, width - 1), Math.round(point.x))),
    y: Math.max(0, Math.min(Math.max(0, height - 1), Math.round(point.y))),
  }
}

export function appendSubjectCorrection(
  prompts: readonly SamPoint[],
  point: SubjectImagePoint,
  label: 0 | 1,
): SamPoint[] {
  const box = prompts.filter((prompt) => prompt.label === 2 || prompt.label === 3)
  const corrections = [
    ...prompts.filter((prompt) => prompt.label === 0 || prompt.label === 1),
    { ...point, label },
  ]
  return [...box, ...corrections.slice(-(MAX_SAM_PROMPTS - box.length))]
}

export function buildSubjectBoxPrompts(
  prompts: readonly SamPoint[],
  start: SubjectImagePoint,
  end: SubjectImagePoint,
): SamPoint[] | null {
  const box = subjectBoxFromPoints(start, end)
  if (!box) return null
  const corrections = prompts
    .filter((prompt) => prompt.label !== 2 && prompt.label !== 3)
    .slice(-(MAX_SAM_PROMPTS - 2))
  return [
    { x: box.x, y: box.y, label: 2 },
    { x: box.x + box.w, y: box.y + box.h, label: 3 },
    ...corrections,
  ]
}
