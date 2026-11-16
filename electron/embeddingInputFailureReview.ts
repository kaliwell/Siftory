import fs from 'node:fs/promises'
import { hasSupportedEmbeddingImageSignature } from './embeddingInputValidation'

const HEADER_BYTES = 64 * 1024
const DINO_MAX_PIXELS = Math.floor((256 * 1024 * 1024) / 3)
const DEFAULT_MAX_PIXELS = 268_402_689

export interface FailedEmbeddingInput {
  inputPath?: string
  inputFailure?: boolean
  error?: string
  modelName: string
}

export interface EmbeddingInputRejection {
  code:
    | 'INPUT_NOT_SUPPORTED'
    | 'INPUT_INVALID_HEADER'
    | 'INPUT_PIXEL_LIMIT'
    | 'INPUT_DECODE_REJECTED'
  format: string
  sizeBytes: number
  width?: number
  height?: number
  depth?: number
  encoding?: string
}

interface ImageHeader {
  format: string
  width?: number
  height?: number
  depth?: number
  encoding?: string
  invalid?: boolean
  unsupported?: boolean
}

// Never turn runtime/provider/persistence failures into skipped inputs, even
// when their source happens to be an unsupported image. Unknown errors require
// independent header evidence; a normal supported header is not sufficient.
export function isEmbeddingInputFailureCandidate(error?: string): boolean {
  if (
    !error ||
    /cuda|directml|onnx|execution provider|inference|tensor|model|worker|child|persist|database|disk|enospc|eacces|eperm|enomem|bad_alloc|out of memory/i.test(
      error,
    )
  )
    return false
  return (
    /^(?:Unknown error|Input buffer is empty|Input (?:buffer|file) contains unsupported image format|Input image exceeds pixel limit)$/i.test(
      error.trim(),
    ) ||
    /(?:^|\n)(?:VipsJpeg:|jpegload(?:_buffer)?:|vipspng:|pngload(?:_buffer)?:|gifload:|webpload:|tiffload:)/i.test(
      error,
    )
  )
}

function inspectHeader(bytes: Buffer): ImageHeader {
  if (bytes.length === 0) return { format: 'empty', invalid: true }
  if (
    bytes.length >= 4 &&
    (bytes.readUInt32BE(0) === 0x00051607 || bytes.readUInt32BE(0) === 0x00051600)
  ) {
    return { format: 'appledouble', unsupported: true }
  }
  if (!hasSupportedEmbeddingImageSignature(bytes)) return { format: 'unknown', unsupported: true }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 1 < bytes.length) {
      if (bytes[offset++] !== 0xff) return { format: 'jpeg', invalid: true }
      while (bytes[offset] === 0xff) offset++
      if (offset >= bytes.length) break
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = bytes.readUInt16BE(offset)
      if (length < 2) return { format: 'jpeg', invalid: true }
      // A large APP block may extend beyond the bounded read. Do not mistake
      // a partial header for a corrupt or unsupported source.
      if (offset + length > bytes.length) break
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        if (length < 8) return { format: 'jpeg', invalid: true }
        const depth = bytes[offset + 2]
        const height = bytes.readUInt16BE(offset + 3)
        const width = bytes.readUInt16BE(offset + 5)
        const channels = bytes[offset + 7]
        if (length < 8 + channels * 3 || !channels || !width || !height)
          return { format: 'jpeg', invalid: true }
        const arithmetic = marker >= 0xc9
        return {
          format: 'jpeg',
          width,
          height,
          depth,
          encoding: arithmetic ? 'arithmetic' : 'huffman',
          unsupported: arithmetic || depth !== 8 || marker === 0xc3 || marker === 0xc7,
        }
      }
      offset += length
    }
    return { format: 'jpeg' }
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (
      bytes.length < 33 ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR'
    )
      return { format: 'png', invalid: true }
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20)
    return { format: 'png', width, height, depth: bytes[24], invalid: !width || !height }
  }
  if (bytes.toString('ascii', 0, 2) === 'BM') {
    if (bytes.length < 26) return { format: 'bmp', invalid: true }
    const dib = bytes.readUInt32LE(14)
    if (dib === 12)
      return { format: 'bmp', width: bytes.readUInt16LE(18), height: bytes.readUInt16LE(20) }
    if (bytes.length < 54 || dib < 40) return { format: 'bmp', invalid: true }
    const width = bytes.readInt32LE(18),
      height = Math.abs(bytes.readInt32LE(22))
    return {
      format: 'bmp',
      width,
      height,
      depth: bytes.readUInt16LE(28),
      invalid: width <= 0 || !height,
    }
  }
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    return bytes.length < 10
      ? { format: 'gif', invalid: true }
      : { format: 'gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF') return { format: 'webp' }
  return { format: 'tiff' }
}

export async function recheckEmbeddingInputFailure(
  input: FailedEmbeddingInput,
): Promise<EmbeddingInputRejection | null> {
  if (
    !input.inputPath ||
    input.inputFailure !== true ||
    !isEmbeddingInputFailureCandidate(input.error)
  )
    return null
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(input.inputPath, 'r')
    const before = await handle.stat()
    if (!before.isFile()) return null
    const bytes = Buffer.alloc(Math.min(HEADER_BYTES, before.size))
    let read = 0
    while (read < bytes.length) {
      const result = await handle.read(bytes, read, bytes.length - read, read)
      if (!result.bytesRead) break
      read += result.bytesRead
    }
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null
    const current = await fs.stat(input.inputPath)
    if (
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev
    )
      return null
    const header = inspectHeader(bytes.subarray(0, read))
    let code: EmbeddingInputRejection['code'] | undefined
    if (header.unsupported) code = 'INPUT_NOT_SUPPORTED'
    else if (header.invalid) code = 'INPUT_INVALID_HEADER'
    else if (
      /pixel limit/i.test(input.error!) &&
      header.width &&
      header.height &&
      header.width * header.height >
        (input.modelName.startsWith('dino') ? DINO_MAX_PIXELS : DEFAULT_MAX_PIXELS)
    )
      code = 'INPUT_PIXEL_LIMIT'
    else if (
      /(?:^|\n)(?:VipsJpeg:|jpegload(?:_buffer)?:|vipspng:|pngload(?:_buffer)?:|gifload:|webpload:|tiffload:)/i.test(
        input.error!,
      ) ||
      /^Input (?:buffer|file) contains unsupported image format$/i.test(input.error!)
    )
      code = 'INPUT_DECODE_REJECTED'
    if (!code) return null
    return {
      code,
      format: header.format,
      sizeBytes: before.size,
      width: header.width,
      height: header.height,
      depth: header.depth,
      encoding: header.encoding,
    }
  } catch {
    // Missing/denied files or failed inspection are not proof of bad input.
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function reviewEmbeddingInputFailures<T extends FailedEmbeddingInput>(
  inputs: readonly T[],
  isCancelled: () => boolean,
): Promise<Array<{ input: T; rejection: EmbeddingInputRejection | null }>> {
  const results = new Array<{ input: T; rejection: EmbeddingInputRejection | null }>(inputs.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(4, inputs.length) }, async () => {
      while (!isCancelled()) {
        const index = cursor++
        if (index >= inputs.length) return
        results[index] = {
          input: inputs[index],
          rejection: await recheckEmbeddingInputFailure(inputs[index]),
        }
      }
    }),
  )
  return results.filter(Boolean)
}
