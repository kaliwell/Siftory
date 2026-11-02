import { float16ToFloat32 } from './embeddingF16Cache'

export type F16DotProductMode = 'lookup' | 'scalar'
export type F16DotProduct = (buffer: Buffer, byteOffset: number) => number

let decodeTable: Float32Array | undefined

/** One 256 KiB table per worker; no decoded copy of the vector library. */
function float16DecodeTable(): Float32Array {
  if (!decodeTable) {
    const table = new Float32Array(0x10000)
    for (let value = 0; value < table.length; value++) table[value] = float16ToFloat32(value)
    decodeTable = table
  }
  return decodeTable
}

/** Keep scalar accumulation order and little-endian decoding on every platform. */
export function createF16DotProduct(
  query: Float32Array,
  mode: F16DotProductMode = process.env.SIFTORY_F16_RERANK_SCALAR === '1' ? 'scalar' : 'lookup',
): F16DotProduct {
  const table = mode === 'lookup' ? float16DecodeTable() : undefined
  const rowBytes = query.length * 2
  return (buffer, byteOffset) => {
    if (
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < 0 ||
      byteOffset + rowBytes > buffer.byteLength
    )
      throw new RangeError('F16 dot product row is outside the buffer')
    let dot = 0
    if (table) {
      for (let dimension = 0; dimension < query.length; dimension++) {
        const offset = byteOffset + dimension * 2
        dot += query[dimension] * table[buffer[offset] | (buffer[offset + 1] << 8)]
      }
    } else {
      for (let dimension = 0; dimension < query.length; dimension++) {
        dot += query[dimension] * float16ToFloat32(buffer.readUInt16LE(byteOffset + dimension * 2))
      }
    }
    return dot
  }
}
