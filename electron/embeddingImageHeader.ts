import type { FileHandle } from 'node:fs/promises'

function hasPrefix(buffer: Uint8Array, values: number[]): boolean {
  return values.every((value, index) => buffer[index] === value)
}

export function hasSupportedEmbeddingImageSignature(buffer: Uint8Array): boolean {
  if (buffer.length < 4) return false
  if (hasPrefix(buffer, [0xff, 0xd8, 0xff])) return true
  if (hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return true
  if (
    hasPrefix(buffer, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    hasPrefix(buffer, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return true
  }
  if (
    hasPrefix(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    buffer.length >= 12 &&
    hasPrefix(buffer.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return true
  }
  if (hasPrefix(buffer, [0x42, 0x4d])) return true
  if (hasPrefix(buffer, [0x49, 0x49, 0x2a, 0x00]) || hasPrefix(buffer, [0x4d, 0x4d, 0x00, 0x2a])) {
    return true
  }
  return false
}

export interface ImageHeader {
  format: string
  width?: number
  height?: number
  depth?: number
  encoding?: string
  invalid?: boolean
  unsupported?: boolean
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

/** Seek over JPEG metadata instead of reading its payload. Budgets count actual
 * bytes read, so even SOF markers past multiple 64 KiB APP blocks are reachable.
 * An exhausted inspection budget is inconclusive, never proof of invalid input. */
export async function readEmbeddingImageHeader(
  handle: Pick<FileHandle, 'read'>,
  size: number,
): Promise<ImageHeader | null> {
  const budget = 64 * 1024
  let consumed = 0
  let windowStart = -1
  let window = Buffer.alloc(0)
  const read = async (position: number, count: number): Promise<Buffer | null> => {
    if (position < 0 || position + count > size) return null
    if (position >= windowStart && position + count <= windowStart + window.length)
      return window.subarray(position - windowStart, position - windowStart + count)
    const length = Math.min(512, size - position, budget - consumed)
    if (length < count) return null
    windowStart = position
    window = Buffer.alloc(length)
    let filled = 0
    while (filled < length) {
      const result = await handle.read(window, filled, length - filled, position + filled)
      if (!result.bytesRead) return null
      filled += result.bytesRead
      consumed += result.bytesRead
    }
    return window.subarray(0, count)
  }
  if (!size) return { format: 'empty', invalid: true }
  const initial = await read(0, Math.min(size, 54))
  if (!initial) return null
  if (initial[0] !== 0xff || initial[1] !== 0xd8) return inspectHeader(initial)
  let offset = 2
  for (let segments = 0; segments < 1024; segments++) {
    let marker = await read(offset++, 1)
    if (!marker) return null
    if (marker[0] !== 0xff) return { format: 'jpeg', invalid: true }
    do {
      marker = await read(offset++, 1)
      if (!marker) return null
    } while (marker[0] === 0xff)
    const kind = marker[0]
    if (kind === 0xda || kind === 0xd9) return { format: 'jpeg' }
    if (kind === 0x01 || kind === 0xd8 || (kind >= 0xd0 && kind <= 0xd7)) continue
    const lengthBytes = await read(offset, 2)
    if (!lengthBytes) return null
    const length = lengthBytes.readUInt16BE(0)
    if (length < 2 || offset + length > size) return { format: 'jpeg', invalid: true }
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(kind)
    ) {
      if (length < 8) return { format: 'jpeg', invalid: true }
      const sof = await read(offset, 8)
      if (!sof) return null
      const depth = sof[2],
        height = sof.readUInt16BE(3),
        width = sof.readUInt16BE(5),
        channels = sof[7]
      if (!width || !height || !channels || length < 8 + channels * 3)
        return { format: 'jpeg', invalid: true }
      const arithmetic = kind >= 0xc9
      return {
        format: 'jpeg',
        width,
        height,
        depth,
        encoding: arithmetic ? 'arithmetic' : 'huffman',
        unsupported: arithmetic || depth !== 8 || kind === 0xc3 || kind === 0xc7,
      }
    }
    offset += length
  }
  return null
}
