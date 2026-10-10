interface CompactPathSegment {
  startRow: number
  rowCount: number
  bytes: Buffer
  offsets: Uint32Array
  present: Uint8Array
}

export interface CompactPathTableStats {
  rows: number
  segments: number
  utf8Bytes: number
  offsetBytes: number
  presenceBytes: number
  ownedBytes: number
}

/** UTF-8 path storage with fixed-width row metadata and append-only segments. */
export class CompactPathTable {
  private readonly segments: CompactPathSegment[] = []
  private rowCount = 0

  constructor(paths: readonly (string | undefined)[] = []) {
    if (paths.length > 0) this.append(paths)
  }

  get count(): number {
    return this.rowCount
  }

  get segmentCount(): number {
    return this.segments.length
  }

  append(paths: readonly (string | undefined)[]): void {
    if (paths.length === 0) return
    let totalBytes = 0
    const encoded = paths.map((value) => {
      if (value === undefined) return null
      const bytes = Buffer.from(value, 'utf8')
      totalBytes += bytes.length
      if (!Number.isSafeInteger(totalBytes) || totalBytes > 0xffff_ffff) {
        throw new Error('Compact path segment exceeds the 4 GiB offset limit')
      }
      return bytes
    })
    const bytes = Buffer.allocUnsafe(totalBytes)
    const offsets = new Uint32Array(paths.length + 1)
    const present = new Uint8Array(paths.length)
    let offset = 0
    for (let index = 0; index < paths.length; index++) {
      offsets[index] = offset
      const value = encoded[index]
      if (value) {
        value.copy(bytes, offset)
        offset += value.length
        present[index] = 1
      }
    }
    offsets[paths.length] = offset
    this.segments.push({
      startRow: this.rowCount,
      rowCount: paths.length,
      bytes,
      offsets,
      present,
    })
    this.rowCount += paths.length
  }

  get(row: number): string | undefined {
    if (!Number.isSafeInteger(row) || row < 0 || row >= this.rowCount) return undefined
    const segment = this.segments.find(
      (candidate) => row >= candidate.startRow && row < candidate.startRow + candidate.rowCount,
    )
    if (!segment) return undefined
    const localRow = row - segment.startRow
    if (segment.present[localRow] === 0) return undefined
    return segment.bytes.toString('utf8', segment.offsets[localRow], segment.offsets[localRow + 1])
  }

  stats(): CompactPathTableStats {
    let utf8Bytes = 0
    let offsetBytes = 0
    let presenceBytes = 0
    for (const segment of this.segments) {
      utf8Bytes += segment.bytes.byteLength
      offsetBytes += segment.offsets.byteLength
      presenceBytes += segment.present.byteLength
    }
    return {
      rows: this.rowCount,
      segments: this.segments.length,
      utf8Bytes,
      offsetBytes,
      presenceBytes,
      ownedBytes: utf8Bytes + offsetBytes + presenceBytes,
    }
  }
}
