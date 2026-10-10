import fs from 'fs'
import { isRecoverableJpegDecodeWarning } from './jpegDecodeRecovery'

export const MAX_CLIP_FALLBACK_FILE_BYTES = 256 * 1024 * 1024
export const MAX_CLIP_FALLBACK_PIXELS = 64 * 1024 * 1024
export const CLIP_PREFETCH_SHORTEST_EDGE = 224

export interface ClipRawImageFactory {
  new (
    data: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    channels: 1 | 2 | 3 | 4,
  ): unknown
  read(filePath: string): Promise<unknown>
}

export function isClipChannelConversionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unsupported number of channels|conversion failed[^\n]*channels?|channels?[^\n]*conversion failed/i.test(
    message,
  )
}

async function readClipImageFallback(
  imagePath: string,
  RawImage: ClipRawImageFactory,
  tolerateJpegWarnings = false,
): Promise<unknown> {
  const stat = await fs.promises.stat(imagePath)
  if (!stat.isFile()) throw new Error('CLIP image fallback requires a regular file')
  if (stat.size > MAX_CLIP_FALLBACK_FILE_BYTES) {
    throw new Error(`CLIP image fallback file exceeds ${MAX_CLIP_FALLBACK_FILE_BYTES} bytes`)
  }
  const { default: sharp } = await import('sharp')
  const pipeline = sharp(imagePath, {
    limitInputPixels: MAX_CLIP_FALLBACK_PIXELS,
    animated: false,
    failOn: tolerateJpegWarnings ? 'none' : 'warning',
  })
  const metadata = await pipeline.metadata()
  const expectedWidth = metadata.autoOrient?.width ?? metadata.width
  const expectedHeight = metadata.autoOrient?.height ?? metadata.height
  if (
    !Number.isSafeInteger(expectedWidth) ||
    !Number.isSafeInteger(expectedHeight) ||
    !expectedWidth ||
    !expectedHeight ||
    expectedWidth * expectedHeight > MAX_CLIP_FALLBACK_PIXELS
  ) {
    throw new Error('CLIP image fallback dimensions are invalid or exceed the pixel limit')
  }
  const { data, info } = await pipeline
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (
    info.channels !== 3 ||
    info.width !== expectedWidth ||
    info.height !== expectedHeight ||
    data.length !== info.width * info.height * 3
  ) {
    throw new Error('CLIP image fallback did not produce a bounded RGB image')
  }
  return new RawImage(new Uint8Array(data), info.width, info.height, 3)
}

/**
 * Keep Transformers' native decoder as the fast path. Only its known channel
 * conversion failures are retried through Sharp; corrupt/unsupported inputs
 * retain the original failure instead of being retried indiscriminately.
 */
export async function readClipImage(
  imagePath: string,
  RawImage: ClipRawImageFactory,
): Promise<unknown> {
  try {
    return await RawImage.read(imagePath)
  } catch (error) {
    const recoverableJpegWarning = isRecoverableJpegDecodeWarning(imagePath, error)
    if (!isClipChannelConversionError(error) && !recoverableJpegWarning) throw error
    return readClipImageFallback(imagePath, RawImage, recoverableJpegWarning)
  }
}

function clipPrefetchResizeDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const factor = Math.max(CLIP_PREFETCH_SHORTEST_EDGE / width, CLIP_PREFETCH_SHORTEST_EDGE / height)
  return {
    // Match Transformers.js' two-decimal rounding and floor exactly.
    width: Math.floor(Number((width * factor).toFixed(2))),
    height: Math.floor(Number((height * factor).toFixed(2))),
  }
}

/**
 * Decode and apply CLIP's fixed shortest-edge affine resize in one Sharp graph.
 * The returned RawImage is still passed through the existing processor for RGB
 * conversion, center crop and normalization. If the bounded candidate cannot
 * prove its output shape/channel contract, preserve behavior via the original
 * decoder instead of surfacing a new failure.
 */
export async function readClipTensorPrefetchImage(
  imagePath: string,
  RawImage: ClipRawImageFactory,
): Promise<unknown> {
  try {
    const stat = await fs.promises.stat(imagePath)
    if (!stat.isFile() || stat.size > MAX_CLIP_FALLBACK_FILE_BYTES) {
      return readClipImage(imagePath, RawImage)
    }
    const { default: sharp } = await import('sharp')
    const pipeline = sharp(imagePath, {
      limitInputPixels: MAX_CLIP_FALLBACK_PIXELS,
      animated: false,
    })
    const metadata = await pipeline.metadata()
    const width = metadata.autoOrient?.width ?? metadata.width
    const height = metadata.autoOrient?.height ?? metadata.height
    const channels = metadata.channels
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      !width ||
      !height ||
      width * height > MAX_CLIP_FALLBACK_PIXELS ||
      channels !== 3
    ) {
      return readClipImage(imagePath, RawImage)
    }
    const resized = clipPrefetchResizeDimensions(width, height)
    const { data, info } = await pipeline
      .rotate()
      .affine([resized.width / width, 0, 0, resized.height / height], {
        interpolator: 'bicubic',
      })
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (
      info.width !== resized.width ||
      info.height !== resized.height ||
      info.channels !== channels ||
      data.length !== info.width * info.height * info.channels
    ) {
      return readClipImage(imagePath, RawImage)
    }
    return new RawImage(new Uint8ClampedArray(data), info.width, info.height, channels)
  } catch {
    return readClipImage(imagePath, RawImage)
  }
}
