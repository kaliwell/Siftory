export interface SamPromptPoint {
  x: number
  y: number
  label?: 0 | 1 | 2 | 3
}

/**
 * SAM prompt coordinates belong to the resized encoder input, while the UI
 * works in oriented source-image pixels. Scale each axis by the encoder's
 * actual rounded resize dimensions; the decoder's orig_im_size maps the mask
 * back to source pixels.
 */
export function scaleSamPromptsToInput(
  points: readonly SamPromptPoint[],
  sourceWidth: number,
  sourceHeight: number,
  inputWidth: number,
  inputHeight: number,
): SamPromptPoint[] {
  if (sourceWidth <= 0 || sourceHeight <= 0 || inputWidth <= 0 || inputHeight <= 0) {
    throw new Error('Invalid SAM coordinate dimensions')
  }
  const scaleX = inputWidth / sourceWidth
  const scaleY = inputHeight / sourceHeight
  return points.map((point) => ({
    x: point.x * scaleX,
    y: point.y * scaleY,
    label: point.label,
  }))
}
