import { MAX_USER_MODEL_RUNTIME_LINE_BYTES } from './embeddingChildLineFraming'

export const MAX_USER_MODEL_RUNTIME_HEADER_BYTES = 1024 * 1024
export const MAX_USER_MODEL_RUNTIME_BINARY_BYTES = MAX_USER_MODEL_RUNTIME_LINE_BYTES
export const USER_MODEL_RUNTIME_SESSION_BUDGET_BYTES = 512 * 1024 * 1024
const FRAME_PREFIX_BYTES = 8

export interface UserModelBinaryFrame {
  header: Record<string, unknown>
  body: Buffer<ArrayBufferLike>
}

export function encodeUserModelBinaryFrame(
  header: Record<string, unknown>,
  bodyParts: readonly ArrayBufferView[] = [],
): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  if (headerBytes.length === 0 || headerBytes.length > MAX_USER_MODEL_RUNTIME_HEADER_BYTES) {
    throw new Error('User model runtime binary header exceeds the safety limit')
  }
  const bodyBytes = bodyParts.reduce((sum, part) => sum + part.byteLength, 0)
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes > MAX_USER_MODEL_RUNTIME_BINARY_BYTES) {
    throw new Error('User model runtime binary body exceeds the safety limit')
  }
  const prefix = Buffer.allocUnsafe(FRAME_PREFIX_BYTES)
  prefix.writeUInt32LE(headerBytes.length, 0)
  prefix.writeUInt32LE(bodyBytes, 4)
  return Buffer.concat(
    [
      prefix,
      headerBytes,
      ...bodyParts.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength)),
    ],
    FRAME_PREFIX_BYTES + headerBytes.length + bodyBytes,
  )
}

/** Bounded parser for `[headerBytes, bodyBytes, JSON header, raw body]` frames. */
export class UserModelBinaryFrameDecoder {
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private failed = false

  push(chunk: Uint8Array): { frames: UserModelBinaryFrame[]; overflow: boolean } {
    if (this.failed) return { frames: [], overflow: true }
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const maximumBuffered =
      FRAME_PREFIX_BYTES + MAX_USER_MODEL_RUNTIME_HEADER_BYTES + MAX_USER_MODEL_RUNTIME_BINARY_BYTES
    if (this.buffered.length + incoming.length > maximumBuffered) {
      this.failed = true
      this.buffered = Buffer.alloc(0)
      return { frames: [], overflow: true }
    }
    this.buffered = this.buffered.length === 0 ? incoming : Buffer.concat([this.buffered, incoming])
    const frames: UserModelBinaryFrame[] = []
    while (this.buffered.length >= FRAME_PREFIX_BYTES) {
      const headerLength = this.buffered.readUInt32LE(0)
      const bodyLength = this.buffered.readUInt32LE(4)
      if (
        headerLength === 0 ||
        headerLength > MAX_USER_MODEL_RUNTIME_HEADER_BYTES ||
        bodyLength > MAX_USER_MODEL_RUNTIME_BINARY_BYTES
      ) {
        this.failed = true
        this.buffered = Buffer.alloc(0)
        return { frames: [], overflow: true }
      }
      const frameLength = FRAME_PREFIX_BYTES + headerLength + bodyLength
      if (this.buffered.length < frameLength) break
      const headerBuffer = this.buffered.subarray(
        FRAME_PREFIX_BYTES,
        FRAME_PREFIX_BYTES + headerLength,
      )
      let header: unknown
      try {
        header = JSON.parse(headerBuffer.toString('utf8'))
      } catch {
        this.failed = true
        this.buffered = Buffer.alloc(0)
        return { frames: [], overflow: true }
      }
      if (!header || typeof header !== 'object' || Array.isArray(header)) {
        this.failed = true
        this.buffered = Buffer.alloc(0)
        return { frames: [], overflow: true }
      }
      frames.push({
        header: header as Record<string, unknown>,
        body: this.buffered.subarray(FRAME_PREFIX_BYTES + headerLength, frameLength),
      })
      this.buffered = this.buffered.subarray(frameLength)
    }
    return { frames, overflow: false }
  }
}

export function boundedBinarySlice(
  body: Buffer<ArrayBufferLike>,
  offset: unknown,
  byteLength: unknown,
): Buffer<ArrayBufferLike> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(byteLength) ||
    (offset as number) < 0 ||
    (byteLength as number) < 0 ||
    (offset as number) + (byteLength as number) > body.length
  ) {
    throw new Error('User model runtime binary tensor range is invalid')
  }
  return body.subarray(offset as number, (offset as number) + (byteLength as number))
}
