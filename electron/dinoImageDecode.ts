import { isRecoverableJpegDecodeWarning } from './jpegDecodeRecovery'

export const MAX_DINO_INPUT_PIXELS = Math.floor((256 * 1024 * 1024) / 3)
export const DINO_PREFETCH_SHORTEST_EDGE = 256

export interface DinoRawImageValue {
  data?: Uint8Array | Uint8ClampedArray
  width?: number
  height?: number
  channels?: number
  rgb(): DinoRawImageValue
}

export interface DinoRawImageFactory {
  new (data: Uint8Array, width: number, height: number, channels: 3): DinoRawImageValue
}

async function decodeDinoRgb(imagePath: string, failOn: 'warning' | 'none') {
  const { default: sharp } = await import('sharp')
  const { data, info } = await sharp(imagePath, {
    animated: false,
    failOn,
    limitInputPixels: MAX_DINO_INPUT_PIXELS,
    sequentialRead: true,
  })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (
    info.channels !== 3 ||
    !Number.isSafeInteger(info.width) ||
    !Number.isSafeInteger(info.height) ||
    info.width <= 0 ||
    info.height <= 0 ||
    info.width * info.height > MAX_DINO_INPUT_PIXELS ||
    data.length !== info.width * info.height * 3
  ) {
    throw new Error('DINO image normalization did not produce a bounded RGB image')
  }
  return { data, info }
}

async function decodeDinoRgbWithRecovery(imagePath: string) {
  try {
    return await decodeDinoRgb(imagePath, 'warning')
  } catch (error) {
    if (!isRecoverableJpegDecodeWarning(imagePath, error)) throw error
    return decodeDinoRgb(imagePath, 'none')
  }
}

/** The production baseline: normalize the complete bounded source to RGB. */
export async function readDinoImage(
  imagePath: string,
  RawImage: DinoRawImageFactory,
): Promise<DinoRawImageValue> {
  const { data, info } = await decodeDinoRgbWithRecovery(imagePath)
  return new RawImage(new Uint8Array(data), info.width, info.height, 3)
}

function resizedDimensions(width: number, height: number, shortestEdge: number) {
  const factor = shortestEdge / Math.min(width, height)
  return {
    width: Math.floor(Number((width * factor).toFixed(2))),
    height: Math.floor(Number((height * factor).toFixed(2))),
  }
}

/**
 * Shadow-only candidate. It performs orientation, RGB normalization and the
 * DINO processor's fixed shortest-edge resize in one Sharp graph. Production
 * must keep using readDinoImage until tensor/vector/Top-K/ready parity passes.
 */
export async function readDinoTensorPrefetchImage(
  imagePath: string,
  RawImage: DinoRawImageFactory,
  shortestEdge = DINO_PREFETCH_SHORTEST_EDGE,
): Promise<DinoRawImageValue> {
  const { default: sharp } = await import('sharp')
  const pipeline = sharp(imagePath, {
    animated: false,
    failOn: 'warning',
    limitInputPixels: MAX_DINO_INPUT_PIXELS,
    sequentialRead: true,
  })
  const metadata = await pipeline.metadata()
  const width = metadata.autoOrient?.width ?? metadata.width
  const height = metadata.autoOrient?.height ?? metadata.height
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !width ||
    !height ||
    width * height > MAX_DINO_INPUT_PIXELS
  ) {
    throw new Error('DINO image dimensions are invalid or exceed the pixel limit')
  }
  const resized = resizedDimensions(width, height, shortestEdge)
  let result: Awaited<ReturnType<typeof pipeline.toBuffer>>
  try {
    result = await pipeline
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .toColourspace('srgb')
      .removeAlpha()
      .affine([resized.width / width, 0, 0, resized.height / height], {
        interpolator: 'bicubic',
      })
      .raw()
      .toBuffer({ resolveWithObject: true })
  } catch (error) {
    if (!isRecoverableJpegDecodeWarning(imagePath, error)) throw error
    return readDinoImage(imagePath, RawImage)
  }
  const { data, info } = result
  if (
    info.channels !== 3 ||
    info.width !== resized.width ||
    info.height !== resized.height ||
    data.length !== info.width * info.height * 3
  ) {
    throw new Error('DINO tensor-prefetch candidate produced an invalid RGB image')
  }
  return new RawImage(new Uint8Array(data), info.width, info.height, 3)
}
