import fs from 'fs'

export const EMBEDDING_DECODE_RGB_BUDGET_BYTES = 256 * 1024 * 1024
export const EMBEDDING_DECODE_HIGH_RISK_PIXELS = 80 * 1024 * 1024
export const EMBEDDING_DECODE_HIGH_RISK_ASPECT_RATIO = 100
export const EMBEDDING_DECODE_MAX_LONG_EDGE = 131_072

export interface EmbeddingImageHeader {
  width: number
  height: number
  rgbBytes: number
  highRisk: boolean
}

// 64 KiB covers ordinary JPEG APP/SOF headers and every fixed-header format
// below without duplicating a meaningful part of the compressed payload.
const FAST_HEADER_BYTES = 64 * 1024

function jpegExifOrientation(buffer: Buffer, start: number, end: number): number {
  if (end - start < 14 || buffer.toString('ascii', start, start + 6) !== 'Exif\0\0') return 1
  const tiff = start + 6
  const littleEndian = buffer.toString('ascii', tiff, tiff + 2) === 'II'
  if (!littleEndian && buffer.toString('ascii', tiff, tiff + 2) !== 'MM') return 1
  const uint16 = (offset: number) =>
    littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
  const uint32 = (offset: number) =>
    littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
  try {
    const ifd = tiff + uint32(tiff + 4)
    const entries = uint16(ifd)
    for (let index = 0; index < entries; index += 1) {
      const entry = ifd + 2 + index * 12
      if (entry + 12 > end) return 1
      if (uint16(entry) === 0x0112 && uint16(entry + 2) === 3 && uint32(entry + 4) === 1) {
        return uint16(entry + 8)
      }
    }
  } catch {
    return 1
  }
  return 1
}

function fastImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length >= 10 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  if (buffer.length >= 26 && buffer.toString('ascii', 0, 2) === 'BM') {
    return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) }
  }
  if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    let orientation = 1
    while (offset + 9 < buffer.length) {
      while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1
      if (offset >= buffer.length) break
      const marker = buffer[offset++]
      if (marker === 0xd8 || marker === 0x01) continue
      if (marker === 0xd9 || marker === 0xda || offset + 2 > buffer.length) break
      const length = buffer.readUInt16BE(offset)
      if (length < 2 || offset + length > buffer.length) break
      const segmentStart = offset + 2
      const segmentEnd = offset + length
      if (marker === 0xe1) orientation = jpegExifOrientation(buffer, segmentStart, segmentEnd)
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        const height = buffer.readUInt16BE(segmentStart + 1)
        const width = buffer.readUInt16BE(segmentStart + 3)
        return orientation >= 5 && orientation <= 8
          ? { width: height, height: width }
          : { width, height }
      }
      offset += length
    }
  }
  if (
    buffer.length >= 30 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const kind = buffer.toString('ascii', 12, 16)
    if (kind === 'VP8X') {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      }
    }
    if (kind === 'VP8L' && buffer[20] === 0x2f) {
      const packed = buffer.readUInt32LE(21)
      return { width: 1 + (packed & 0x3fff), height: 1 + ((packed >>> 14) & 0x3fff) }
    }
    if (kind === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
  }
  return null
}

async function probeFastImageDimensions(
  imagePath: string,
): Promise<{ width: number; height: number } | null> {
  const handle = await fs.promises.open(imagePath, 'r')
  try {
    const stat = await handle.stat()
    const buffer = Buffer.allocUnsafe(Math.min(FAST_HEADER_BYTES, stat.size))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return fastImageDimensions(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

function validatedEmbeddingImageHeader(
  width: number | undefined,
  height: number | undefined,
): EmbeddingImageHeader | null {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !width ||
    !height ||
    width <= 0 ||
    height <= 0 ||
    width > EMBEDDING_DECODE_MAX_LONG_EDGE ||
    height > EMBEDDING_DECODE_MAX_LONG_EDGE
  ) {
    return null
  }
  const pixels = width * height
  const rgbBytes = pixels * 3
  if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(rgbBytes)) return null
  const aspectRatio = Math.max(width, height) / Math.min(width, height)
  return {
    width,
    height,
    rgbBytes,
    highRisk:
      pixels >= EMBEDDING_DECODE_HIGH_RISK_PIXELS ||
      aspectRatio >= EMBEDDING_DECODE_HIGH_RISK_ASPECT_RATIO,
  }
}

export async function probeEmbeddingImageHeader(
  imagePath: string,
): Promise<EmbeddingImageHeader | null> {
  try {
    const fast = await probeFastImageDimensions(imagePath)
    if (fast) return validatedEmbeddingImageHeader(fast.width, fast.height)
    const { default: sharp } = await import('sharp')
    const metadata = await sharp(imagePath, { animated: false, sequentialRead: true }).metadata()
    const width = metadata.autoOrient?.width ?? metadata.width
    const height = metadata.autoOrient?.height ?? metadata.height
    return validatedEmbeddingImageHeader(width, height)
  } catch {
    return null
  }
}

export async function probeEmbeddingImageHeaders(
  imagePaths: readonly string[],
): Promise<Array<EmbeddingImageHeader | null>> {
  return Promise.all(imagePaths.map(probeEmbeddingImageHeader))
}

export function planEmbeddingDecodeWaves(
  headers: readonly (EmbeddingImageHeader | null)[],
  budgetBytes = EMBEDDING_DECODE_RGB_BUDGET_BYTES,
): number[][] {
  const waves: number[][] = []
  let current: number[] = []
  let currentBytes = 0
  const flush = () => {
    if (current.length > 0) waves.push(current)
    current = []
    currentBytes = 0
  }
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]
    if (header?.highRisk) {
      flush()
      waves.push([index])
      continue
    }
    const bytes = header?.rgbBytes ?? 0
    if (current.length > 0 && bytes > 0 && currentBytes + bytes > budgetBytes) flush()
    current.push(index)
    currentBytes += bytes
  }
  flush()
  return waves
}

/** A caller that must retain every decoded image for one batched inference
 * cannot honor the byte budget across multiple waves. Such a batch must run
 * complete decode->inference units serially so the prior RGB buffer can die. */
export function embeddingBatchRequiresSerialProcessing(
  headers: readonly (EmbeddingImageHeader | null)[],
  budgetBytes = EMBEDDING_DECODE_RGB_BUDGET_BYTES,
): boolean {
  return headers.length > 1 && planEmbeddingDecodeWaves(headers, budgetBytes).length > 1
}

export async function decodeEmbeddingImagesInWaves<T>(
  imagePaths: readonly string[],
  decode: (imagePath: string) => Promise<T>,
  preparedHeaders?: readonly (EmbeddingImageHeader | null)[],
): Promise<{
  headers: Array<EmbeddingImageHeader | null>
  results: Array<PromiseSettledResult<T>>
}> {
  const headers = preparedHeaders
    ? Array.from(preparedHeaders)
    : await probeEmbeddingImageHeaders(imagePaths)
  if (headers.length !== imagePaths.length) {
    throw new Error('Embedding image header count does not match the decode batch')
  }
  const results = new Array<PromiseSettledResult<T>>(imagePaths.length)
  for (const wave of planEmbeddingDecodeWaves(headers)) {
    const settled = await Promise.allSettled(wave.map((index) => decode(imagePaths[index])))
    for (let offset = 0; offset < wave.length; offset += 1) {
      results[wave[offset]] = settled[offset]
    }
  }
  return { headers, results }
}

export function totalEmbeddingDecodedRgbBytes(
  headers: readonly (EmbeddingImageHeader | null)[],
): number {
  return headers.reduce((sum, header) => sum + (header?.rgbBytes ?? 0), 0)
}

export function peakEmbeddingDecodedRgbBytes(
  headers: readonly (EmbeddingImageHeader | null)[],
): number {
  return headers.reduce((peak, header) => Math.max(peak, header?.rgbBytes ?? 0), 0)
}
