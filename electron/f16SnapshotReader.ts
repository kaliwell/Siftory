import fs from 'fs'
import { float16ToFloat32, type EmbeddingF16CacheHandle } from './embeddingF16Cache'
import { requireNormalizedEmbeddingVectorFloat32 } from './embeddingVectorValidation'
import { VECTOR_ANN_MAX_TOP_K, type VectorAnnScoredRow } from './vectorAnnIndex'

const DEFAULT_PAGE_BYTES = 1024 * 1024
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_CACHE_PAGES = 64

interface OpenSegment {
  startRow: number
  rowCount: number
  descriptor: number
  path: string
  committedBytes: number
  openedSize: number
  openedMtimeMs: number
}

interface CachedPage {
  key: string
  buffer: Buffer
}

export interface F16SnapshotReaderStats {
  ownedBytes: number
  pages: number
  bytesRead: number
}

function readFully(descriptor: number, length: number, position: number): Buffer {
  const output = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const read = fs.readSync(descriptor, output, offset, length - offset, position + offset)
    if (read === 0) throw new Error('F16 snapshot range is truncated')
    offset += read
  }
  return output
}

export class F16SnapshotReader {
  readonly dim: number
  readonly count: number
  readonly rowBytes: number
  private readonly segments: OpenSegment[]
  private readonly pageRows: number
  private readonly cacheBudgetBytes: number
  private readonly pages = new Map<string, CachedPage>()
  private cachedBytes = 0
  private bytesRead = 0
  private closed = false

  constructor(cache: EmbeddingF16CacheHandle, cacheBudgetBytes = DEFAULT_CACHE_BYTES) {
    if (!Number.isInteger(cache.meta.dim) || cache.meta.dim <= 0) {
      throw new Error('F16 snapshot dimension is invalid')
    }
    if (!Number.isSafeInteger(cache.meta.count) || cache.meta.count < 0) {
      throw new Error('F16 snapshot count is invalid')
    }
    this.dim = cache.meta.dim
    this.count = cache.meta.count
    this.rowBytes = this.dim * 2
    this.cacheBudgetBytes = Math.max(this.rowBytes, Math.floor(cacheBudgetBytes))
    this.pageRows = Math.max(
      1,
      Math.floor(Math.min(DEFAULT_PAGE_BYTES, this.cacheBudgetBytes) / this.rowBytes),
    )
    const baseCount = cache.delta?.baseCount ?? this.count
    const definitions = [
      { path: cache.vectorPath, startRow: 0, rowCount: baseCount, exact: true },
      ...(cache.delta
        ? [
            {
              path: cache.delta.vectorPath,
              startRow: baseCount,
              rowCount: this.count - baseCount,
              exact: false,
            },
          ]
        : []),
    ]
    const opened: OpenSegment[] = []
    try {
      for (const definition of definitions) {
        if (definition.rowCount < 0) throw new Error('F16 snapshot segment count is invalid')
        const descriptor = fs.openSync(definition.path, 'r')
        const stat = fs.fstatSync(descriptor)
        const committedBytes = definition.rowCount * this.rowBytes
        if (
          stat.size < committedBytes ||
          (definition.exact && stat.size !== committedBytes) ||
          !Number.isSafeInteger(committedBytes)
        ) {
          fs.closeSync(descriptor)
          throw new Error('F16 snapshot segment byte length mismatch')
        }
        opened.push({
          startRow: definition.startRow,
          rowCount: definition.rowCount,
          descriptor,
          path: definition.path,
          committedBytes,
          openedSize: stat.size,
          openedMtimeMs: stat.mtimeMs,
        })
      }
      this.segments = opened
    } catch (error) {
      for (const segment of opened) fs.closeSync(segment.descriptor)
      throw error
    }
  }

  private assertOpenAndStable(segment: OpenSegment): void {
    if (this.closed) throw new Error('F16 snapshot reader is closed')
    const stat = fs.fstatSync(segment.descriptor)
    if (stat.size !== segment.openedSize || stat.mtimeMs !== segment.openedMtimeMs) {
      this.close()
      throw new Error('F16 snapshot changed while being read')
    }
  }

  private segmentForRow(row: number): OpenSegment {
    if (!Number.isSafeInteger(row) || row < 0 || row >= this.count) {
      throw new RangeError('F16 snapshot row is outside the committed view')
    }
    const segment = this.segments.find(
      (candidate) => row >= candidate.startRow && row < candidate.startRow + candidate.rowCount,
    )
    if (!segment) throw new Error('F16 snapshot segment is missing')
    return segment
  }

  readPageForRow(row: number): { buffer: Buffer; localRow: number } {
    const segment = this.segmentForRow(row)
    this.assertOpenAndStable(segment)
    const segmentRow = row - segment.startRow
    const pageStartRow = Math.floor(segmentRow / this.pageRows) * this.pageRows
    const key = `${segment.startRow}:${pageStartRow}`
    const cached = this.pages.get(key)
    if (cached) {
      this.pages.delete(key)
      this.pages.set(key, cached)
      return { buffer: cached.buffer, localRow: segmentRow - pageStartRow }
    }
    const rowCount = Math.min(this.pageRows, segment.rowCount - pageStartRow)
    const length = rowCount * this.rowBytes
    const buffer = readFully(segment.descriptor, length, pageStartRow * this.rowBytes)
    this.bytesRead += length
    if (length <= this.cacheBudgetBytes) {
      while (
        (this.cachedBytes + length > this.cacheBudgetBytes ||
          this.pages.size >= DEFAULT_MAX_CACHE_PAGES) &&
        this.pages.size > 0
      ) {
        const oldestKey = this.pages.keys().next().value as string
        const oldest = this.pages.get(oldestKey)!
        this.pages.delete(oldestKey)
        this.cachedBytes -= oldest.buffer.byteLength
      }
      this.pages.set(key, { key, buffer })
      this.cachedBytes += buffer.byteLength
    }
    return { buffer, localRow: segmentRow - pageStartRow }
  }

  stats(): F16SnapshotReaderStats {
    return { ownedBytes: this.cachedBytes, pages: this.pages.size, bytesRead: this.bytesRead }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.pages.clear()
    this.cachedBytes = 0
    for (const segment of this.segments) {
      try {
        fs.closeSync(segment.descriptor)
      } catch {
        // Idempotent shutdown owns no descriptor after this point.
      }
    }
  }
}

function pushScoredRow(heap: VectorAnnScoredRow[], value: VectorAnnScoredRow, topK: number): void {
  if (heap.length < topK) {
    heap.push(value)
    let child = heap.length - 1
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2)
      if (heap[parent].score <= heap[child].score) break
      ;[heap[parent], heap[child]] = [heap[child], heap[parent]]
      child = parent
    }
    return
  }
  if (value.score <= heap[0].score) return
  heap[0] = value
  let parent = 0
  for (;;) {
    const left = parent * 2 + 1
    const right = left + 1
    if (left >= heap.length) break
    const smaller = right < heap.length && heap[right].score < heap[left].score ? right : left
    if (heap[parent].score <= heap[smaller].score) break
    ;[heap[parent], heap[smaller]] = [heap[smaller], heap[parent]]
    parent = smaller
  }
}

export function scoreF16SnapshotCandidates(
  reader: F16SnapshotReader,
  candidates: Uint32Array,
  queryVector: Float32Array | number[],
  topK: number,
  isCancelled?: () => boolean,
): VectorAnnScoredRow[] {
  const query = requireNormalizedEmbeddingVectorFloat32(queryVector, reader.dim)
  if (!Number.isSafeInteger(topK) || topK <= 0 || topK > VECTOR_ANN_MAX_TOP_K) {
    throw new RangeError(`ANN topK must be a positive safe integer <= ${VECTOR_ANN_MAX_TOP_K}`)
  }
  const heap: VectorAnnScoredRow[] = []
  let previousRow = -1
  for (let index = 0; index < candidates.length; index++) {
    if ((index & 1023) === 0 && isCancelled?.()) throw new Error('ANN search cancelled')
    const row = candidates[index]
    if (row <= previousRow) throw new Error('ANN candidate rows must be unique and sorted')
    previousRow = row
    const page = reader.readPageForRow(row)
    const rowOffset = page.localRow * reader.rowBytes
    let dot = 0
    for (let dimension = 0; dimension < reader.dim; dimension++) {
      dot +=
        query[dimension] * float16ToFloat32(page.buffer.readUInt16LE(rowOffset + dimension * 2))
    }
    pushScoredRow(heap, { row, score: (dot + 1) / 2 }, topK)
  }
  return heap.sort((left, right) => right.score - left.score || left.row - right.row)
}
