import crypto from 'crypto'
import path from 'path'
import sharp from 'sharp'
import { orientedDimensions } from './subjectBoxes'
import type { SubjectMaskBBox } from './subjectMaskSession'

const MAX_MASK_QUERY_PIXELS = 16_000_000

export interface SubjectMaskQueryFiles {
  bbox: SubjectMaskBBox
  contextCropPath: string
  maskedCropPath: string
  maskHash: string
}

function clampBBox(bbox: SubjectMaskBBox, width: number, height: number): SubjectMaskBBox | null {
  if (width <= 0 || height <= 0) return null
  const x = Math.max(0, Math.min(width - 1, Math.round(bbox.x)))
  const y = Math.max(0, Math.min(height - 1, Math.round(bbox.y)))
  const w = Math.min(width - x, Math.round(bbox.w))
  const h = Math.min(height - y, Math.round(bbox.h))
  return w >= 4 && h >= 4 && w * h <= MAX_MASK_QUERY_PIXELS ? { x, y, w, h } : null
}

/**
 * Creates both the rectangular context crop and the authoritative masked
 * query crop. The masked image has neutral-gray background pixels so image
 * decoders that discard alpha still cannot reintroduce the original scene.
 */
export async function createSubjectMaskQueryFiles(
  imagePath: string,
  maskPng: Buffer,
  requestedBBox: SubjectMaskBBox,
  outputDir: string,
): Promise<SubjectMaskQueryFiles> {
  const [imageMetadata, maskMetadata] = await Promise.all([
    sharp(imagePath).metadata(),
    sharp(maskPng).metadata(),
  ])
  const oriented = orientedDimensions(
    imageMetadata.width ?? 0,
    imageMetadata.height ?? 0,
    imageMetadata.orientation,
  )
  if (maskMetadata.width !== oriented.width || maskMetadata.height !== oriented.height) {
    throw new Error('Segmentation mask dimensions do not match the source image')
  }
  const bbox = clampBBox(requestedBBox, oriented.width, oriented.height)
  if (!bbox) throw new Error('Invalid segmentation mask region')

  const contextCropPath = path.join(outputDir, 'context.jpg')
  const maskedCropPath = path.join(outputDir, 'masked.png')
  const maskAlpha = await sharp(maskPng)
    .extract({ left: bbox.x, top: bbox.y, width: bbox.w, height: bbox.h })
    .greyscale()
    .raw()
    .toBuffer()
  const sourceRgb = await sharp(imagePath)
    .rotate()
    .extract({ left: bbox.x, top: bbox.y, width: bbox.w, height: bbox.h })
    .removeAlpha()
    .raw()
    .toBuffer()
  for (let pixel = 0; pixel < bbox.w * bbox.h; pixel++) {
    const alpha = maskAlpha[pixel] / 255
    const offset = pixel * 3
    sourceRgb[offset] = Math.round(sourceRgb[offset] * alpha + 127 * (1 - alpha))
    sourceRgb[offset + 1] = Math.round(sourceRgb[offset + 1] * alpha + 127 * (1 - alpha))
    sourceRgb[offset + 2] = Math.round(sourceRgb[offset + 2] * alpha + 127 * (1 - alpha))
  }

  await sharp(imagePath)
    .rotate()
    .extract({ left: bbox.x, top: bbox.y, width: bbox.w, height: bbox.h })
    .removeAlpha()
    .jpeg({ quality: 92 })
    .toFile(contextCropPath)

  await sharp(sourceRgb, { raw: { width: bbox.w, height: bbox.h, channels: 3 } })
    .png()
    .toFile(maskedCropPath)

  return {
    bbox,
    contextCropPath,
    maskedCropPath,
    maskHash: crypto.createHash('sha256').update(maskPng).digest('hex'),
  }
}
