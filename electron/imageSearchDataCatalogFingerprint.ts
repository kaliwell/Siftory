import crypto from 'node:crypto'
import fs from 'node:fs'

export const CATALOG_SOURCE_CHUNK_BYTES = 8 * 1024 * 1024
const SAMPLE_BYTES = 64 * 1024
const FINGERPRINT_DOMAIN = 'siftory-catalog-source-chunks-v1\0'

export interface CatalogSourceChunk {
  chunkIndex: number
  offsetBytes: number
  lengthBytes: number
  sha256: string
}

/**
 * Incremental, fixed-boundary source fingerprint builder. Every source byte is
 * hashed exactly once during a full scan. An append can reuse completed chunks
 * and rebuild only the prior partial chunk plus the new tail.
 */
export class CatalogSourceChunkBuilder {
  private readonly chunks: CatalogSourceChunk[] = []
  private chunkHash = crypto.createHash('sha256')
  private chunkLength = 0
  private offset: number
  private chunkIndex: number
  private finished = false

  constructor(startOffset = 0) {
    if (
      !Number.isSafeInteger(startOffset) ||
      startOffset < 0 ||
      startOffset % CATALOG_SOURCE_CHUNK_BYTES !== 0
    ) {
      throw new RangeError('Catalog source chunk start must be an aligned safe integer')
    }
    this.offset = startOffset
    this.chunkIndex = startOffset / CATALOG_SOURCE_CHUNK_BYTES
  }

  update(buffer: Buffer): void {
    if (this.finished) throw new Error('Catalog source chunk builder is already finished')
    let cursor = 0
    while (cursor < buffer.length) {
      const available = CATALOG_SOURCE_CHUNK_BYTES - this.chunkLength
      const length = Math.min(available, buffer.length - cursor)
      this.chunkHash.update(buffer.subarray(cursor, cursor + length))
      this.chunkLength += length
      cursor += length
      if (this.chunkLength === CATALOG_SOURCE_CHUNK_BYTES) this.finishChunk()
    }
  }

  finish(): CatalogSourceChunk[] {
    if (!this.finished) {
      if (this.chunkLength > 0) this.finishChunk()
      this.finished = true
    }
    return this.chunks.map((chunk) => ({ ...chunk }))
  }

  private finishChunk(): void {
    this.chunks.push({
      chunkIndex: this.chunkIndex,
      offsetBytes: this.offset,
      lengthBytes: this.chunkLength,
      sha256: this.chunkHash.digest('hex'),
    })
    this.offset += this.chunkLength
    this.chunkIndex++
    this.chunkHash = crypto.createHash('sha256')
    this.chunkLength = 0
  }
}

/** A deterministic SHA-256 root over every fixed source chunk. */
export function catalogSourceFingerprintSha256(chunksInput: readonly CatalogSourceChunk[]): string {
  const chunks = [...chunksInput].sort((left, right) => left.chunkIndex - right.chunkIndex)
  const hash = crypto.createHash('sha256')
  hash.update(FINGERPRINT_DOMAIN)
  let expectedOffset = 0
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]
    if (
      chunk.chunkIndex !== index ||
      chunk.offsetBytes !== expectedOffset ||
      !Number.isSafeInteger(chunk.lengthBytes) ||
      chunk.lengthBytes <= 0 ||
      chunk.lengthBytes > CATALOG_SOURCE_CHUNK_BYTES ||
      !/^[a-f0-9]{64}$/.test(chunk.sha256)
    ) {
      throw new Error('Catalog source chunk sequence is invalid')
    }
    if (index + 1 < chunks.length && chunk.lengthBytes !== CATALOG_SOURCE_CHUNK_BYTES) {
      throw new Error('Only the final catalog source chunk may be partial')
    }
    const header = Buffer.allocUnsafe(16)
    header.writeBigUInt64LE(BigInt(chunk.offsetBytes), 0)
    header.writeBigUInt64LE(BigInt(chunk.lengthBytes), 8)
    hash.update(header)
    hash.update(Buffer.from(chunk.sha256, 'hex'))
    expectedOffset += chunk.lengthBytes
  }
  return hash.digest('hex')
}

/** Matches the service-side bounded source snapshot fingerprint. */
export function sampleCatalogSourceFileSync(filePath: string, sizeBytes: number): string {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new RangeError('Catalog source size must be a non-negative safe integer')
  }
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size < sizeBytes) throw new Error('Catalog source is incomplete')
    const hash = crypto.createHash('sha256')
    hash.update(String(sizeBytes))
    const firstLength = Math.min(SAMPLE_BYTES, sizeBytes)
    if (firstLength > 0) {
      const first = Buffer.allocUnsafe(firstLength)
      const read = fs.readSync(descriptor, first, 0, firstLength, 0)
      if (read !== firstLength) throw new Error('Could not sample catalog source head')
      hash.update(first)
    }
    if (sizeBytes > firstLength) {
      const lastLength = Math.min(SAMPLE_BYTES, sizeBytes - firstLength)
      const last = Buffer.allocUnsafe(lastLength)
      const read = fs.readSync(descriptor, last, 0, lastLength, sizeBytes - lastLength)
      if (read !== lastLength) throw new Error('Could not sample catalog source tail')
      hash.update(last)
    }
    return hash.digest('hex')
  } finally {
    fs.closeSync(descriptor)
  }
}
