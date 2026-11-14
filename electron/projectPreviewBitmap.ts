export function projectPreviewBitmapDifference(left: Buffer, right: Buffer): number {
  if (left.length !== right.length || left.length === 0) return 1
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index] - right[index])
  }
  return difference / (left.length * 255)
}
