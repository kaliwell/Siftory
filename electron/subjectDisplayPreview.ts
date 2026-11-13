import { readSharpFileSnapshot } from './sharpFileSnapshot'
import sharp from 'sharp'
import { orientedDimensions } from './subjectBoxes'

export interface SubjectDisplayPreviewResult {
  ok: boolean
  dataUrl?: string
  width?: number
  height?: number
  sourceWidth?: number
  sourceHeight?: number
  error?: string
}

/**
 * Decodes directly from the source file for the Subject Picker. This bypasses
 * the file-manager thumbnail cache, whose 256px ceiling is intentionally too
 * small for a large precision-editing surface.
 */
export async function createSubjectDisplayPreview(
  imagePath: string,
  maxWidth: number,
  maxHeight: number,
): Promise<SubjectDisplayPreviewResult> {
  let sharpSourceSnapshot: Promise<Buffer> | undefined
  const getSharpSourceSnapshot = () => (sharpSourceSnapshot ??= readSharpFileSnapshot(imagePath))

  try {
    const metadata = await sharp(await getSharpSourceSnapshot()).metadata()
    const source = orientedDimensions(
      metadata.width ?? 0,
      metadata.height ?? 0,
      metadata.orientation,
    )
    if (source.width <= 0 || source.height <= 0) {
      return { ok: false, error: 'Cannot read original image dimensions' }
    }
    const { data, info } = await sharp(await getSharpSourceSnapshot())
      .rotate()
      .resize(maxWidth, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 95, alphaQuality: 100, smartSubsample: true })
      .toBuffer({ resolveWithObject: true })
    return {
      ok: true,
      dataUrl: `data:image/webp;base64,${data.toString('base64')}`,
      width: info.width,
      height: info.height,
      sourceWidth: source.width,
      sourceHeight: source.height,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
