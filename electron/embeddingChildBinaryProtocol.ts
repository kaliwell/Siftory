import { MAX_EMBEDDING_VECTOR_DIM } from './embeddingVectorValidation'

const MAGIC = Buffer.from('EMB1', 'ascii')
const PREFIX_BYTES = 12
export const MAX_EMBEDDING_CHILD_HEADER_BYTES = 256 * 1024
export const MAX_EMBEDDING_CHILD_VECTOR_BYTES = MAX_EMBEDDING_VECTOR_DIM * 8

export interface EmbeddingChildBinaryFrame {
  header: Record<string, unknown>
  body: Buffer<ArrayBufferLike>
}

export function encodeEmbeddingChildFrame(
  header: Record<string, unknown>,
  vector?: readonly number[],
): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  if (headerBytes.length === 0 || headerBytes.length > MAX_EMBEDDING_CHILD_HEADER_BYTES) {
    throw new Error('Embedding child frame header exceeds the safety limit')
  }
  const bodyBytes = vector ? vector.length * 8 : 0
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes > MAX_EMBEDDING_CHILD_VECTOR_BYTES) {
    throw new Error('Embedding child frame vector exceeds the safety limit')
  }
  const frame = Buffer.allocUnsafe(PREFIX_BYTES + headerBytes.length + bodyBytes)
  MAGIC.copy(frame, 0)
  frame.writeUInt32LE(headerBytes.length, 4)
  frame.writeUInt32LE(bodyBytes, 8)
  headerBytes.copy(frame, PREFIX_BYTES)
  if (vector) {
    let offset = PREFIX_BYTES + headerBytes.length
    for (const value of vector) {
      if (!Number.isFinite(value)) throw new Error('Embedding child frame contains non-finite data')
      frame.writeDoubleLE(value, offset)
      offset += 8
    }
  }
  return frame
}

/** Incremental decoder for bounded `EMB1 + JSON header + Float64 vector` frames. */
export class EmbeddingChildBinaryFrameDecoder {
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private failed = false

  push(chunk: Uint8Array): { frames: EmbeddingChildBinaryFrame[]; overflow: boolean } {
    if (this.failed) return { frames: [], overflow: true }
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const maximum =
      PREFIX_BYTES + MAX_EMBEDDING_CHILD_HEADER_BYTES + MAX_EMBEDDING_CHILD_VECTOR_BYTES
    if (this.buffered.length + incoming.length > maximum) return this.fail()
    this.buffered = this.buffered.length === 0 ? incoming : Buffer.concat([this.buffered, incoming])
    const frames: EmbeddingChildBinaryFrame[] = []
    while (this.buffered.length >= PREFIX_BYTES) {
      if (!this.buffered.subarray(0, MAGIC.length).equals(MAGIC)) return this.fail()
      const headerLength = this.buffered.readUInt32LE(4)
      const bodyLength = this.buffered.readUInt32LE(8)
      if (
        headerLength === 0 ||
        headerLength > MAX_EMBEDDING_CHILD_HEADER_BYTES ||
        bodyLength > MAX_EMBEDDING_CHILD_VECTOR_BYTES ||
        bodyLength % 8 !== 0
      ) {
        return this.fail()
      }
      const frameLength = PREFIX_BYTES + headerLength + bodyLength
      if (this.buffered.length < frameLength) break
      let header: unknown
      try {
        header = JSON.parse(
          this.buffered.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength).toString('utf8'),
        )
      } catch {
        return this.fail()
      }
      if (!header || typeof header !== 'object' || Array.isArray(header)) return this.fail()
      frames.push({
        header: header as Record<string, unknown>,
        body: this.buffered.subarray(PREFIX_BYTES + headerLength, frameLength),
      })
      this.buffered =
        frameLength === this.buffered.length ? Buffer.alloc(0) : this.buffered.subarray(frameLength)
    }
    return { frames, overflow: false }
  }

  private fail(): { frames: []; overflow: true } {
    this.failed = true
    this.buffered = Buffer.alloc(0)
    return { frames: [], overflow: true }
  }
}

export function decodeEmbeddingChildVector(
  frame: EmbeddingChildBinaryFrame,
  expectedDim: number,
): number[] | undefined {
  if (frame.body.length === 0) return undefined
  if (
    frame.header.vectorEncoding !== 'float64le' ||
    !Number.isSafeInteger(expectedDim) ||
    expectedDim <= 0 ||
    frame.body.length !== expectedDim * 8
  ) {
    throw new Error('Embedding child frame vector metadata is invalid')
  }
  const vector = new Array<number>(expectedDim)
  for (let index = 0; index < expectedDim; index += 1) {
    const value = frame.body.readDoubleLE(index * 8)
    if (!Number.isFinite(value)) throw new Error('Embedding child frame contains non-finite data')
    vector[index] = value
  }
  return vector
}
