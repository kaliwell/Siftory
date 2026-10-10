import { float16ToFloat32 } from './embeddingF16Cache'
import {
  MAX_EMBEDDING_VECTOR_DIM,
  requireNormalizedEmbeddingVectorFloat32,
} from './embeddingVectorValidation'

export const VECTOR_ANN_VERSION = 1
export const VECTOR_ANN_PLANES = 48
export const VECTOR_ANN_TERMS_PER_PLANE = 16
export const VECTOR_ANN_BAND_BITS = 12
export const VECTOR_ANN_BANDS = VECTOR_ANN_PLANES / VECTOR_ANN_BAND_BITS
export const VECTOR_ANN_PROBE_RADIUS = 4
export const VECTOR_ANN_SIGNATURE_BYTES = 8
export const VECTOR_ANN_PROJECTION_DIMENSIONS = 128
export const VECTOR_ANN_CANDIDATE_RATIO = 0.2
export const VECTOR_ANN_MAX_TOP_K = 20_000

export interface VectorAnnProjectionPlan {
  dim: number
  dimensions: Uint16Array
  signs: Int8Array
  thresholds: Float32Array
}

export interface VectorAnnScoredRow {
  row: number
  score: number
}

export interface VectorAnnBufferSegment {
  startRow: number
  rowCount: number
  buffer: Buffer
}

export interface VectorAnnQuantizedProjection {
  dimensions: Uint16Array
  inverseScales: Float32Array
  values: Buffer
}

type VectorAnnBufferSource = Buffer | readonly VectorAnnBufferSegment[]

function validateSegments(
  source: VectorAnnBufferSource,
  count: number,
  rowBytes: number,
  label: string,
): readonly VectorAnnBufferSegment[] | null {
  if (Buffer.isBuffer(source)) {
    if (source.length !== count * rowBytes) throw new Error(`${label} byte length mismatch`)
    return null
  }
  let nextRow = 0
  for (const segment of source) {
    if (
      segment.startRow !== nextRow ||
      !Number.isInteger(segment.rowCount) ||
      segment.rowCount < 0 ||
      segment.buffer.length !== segment.rowCount * rowBytes
    ) {
      throw new Error(`${label} segments are not contiguous`)
    }
    nextRow += segment.rowCount
  }
  if (nextRow !== count) throw new Error(`${label} row count mismatch`)
  return source
}

function nextRandom(state: { value: number }): number {
  state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0
  return state.value
}

export function createVectorAnnProjectionPlan(
  dim: number,
  tableIndex = 0,
  center?: Float32Array | number[],
): VectorAnnProjectionPlan {
  if (!Number.isInteger(dim) || dim <= 0 || dim > MAX_EMBEDDING_VECTOR_DIM) {
    throw new Error(`Invalid ANN dimension: ${dim}`)
  }
  if (!Number.isSafeInteger(tableIndex) || tableIndex < 0 || tableIndex > 255) {
    throw new Error(`Invalid ANN projection table: ${tableIndex}`)
  }
  const dimensions = new Uint16Array(VECTOR_ANN_PLANES * VECTOR_ANN_TERMS_PER_PLANE)
  const signs = new Int8Array(dimensions.length)
  const centerVector = center ? Float32Array.from(center) : null
  if (centerVector && centerVector.length !== dim) {
    throw new Error(`Invalid ANN projection center dimension: ${centerVector.length}`)
  }
  if (centerVector?.some((value) => !Number.isFinite(value))) {
    throw new Error('Invalid ANN projection center value')
  }
  const thresholds = new Float32Array(VECTOR_ANN_PLANES)
  // Table zero intentionally preserves the v1 projection. Additional tables
  // use deterministic, well-separated seeds so an index is reproducible.
  const random = {
    value: (0x6d2b79f5 ^ Math.imul(tableIndex, 0x9e3779b9)) >>> 0,
  }
  for (let plane = 0; plane < VECTOR_ANN_PLANES; plane++) {
    const used = new Set<number>()
    for (let term = 0; term < VECTOR_ANN_TERMS_PER_PLANE; term++) {
      let dimension = nextRandom(random) % dim
      // Small synthetic/test dimensions may contain fewer coordinates than one
      // projection plane has terms. Keep production dimensions unique while
      // allowing deterministic reuse after every coordinate has been selected.
      while (used.size < dim && used.has(dimension)) dimension = (dimension + 1) % dim
      used.add(dimension)
      const index = plane * VECTOR_ANN_TERMS_PER_PLANE + term
      dimensions[index] = dimension
      signs[index] = (nextRandom(random) & 1) === 0 ? -1 : 1
      if (centerVector) thresholds[plane] += centerVector[dimension] * signs[index]
    }
  }
  return { dim, dimensions, signs, thresholds }
}

function setSignatureBit(signature: { low: number; high: number }, bit: number): void {
  if (bit < 32) signature.low = (signature.low | (1 << bit)) >>> 0
  else signature.high = (signature.high | (1 << (bit - 32))) >>> 0
}

export function vectorAnnSignatureFromFloat32(
  vector: Float32Array | number[],
  plan: VectorAnnProjectionPlan,
): { low: number; high: number } {
  const normalized = requireNormalizedEmbeddingVectorFloat32(vector, plan.dim)
  const signature = { low: 0, high: 0 }
  for (let plane = 0; plane < VECTOR_ANN_PLANES; plane++) {
    let projection = 0
    const offset = plane * VECTOR_ANN_TERMS_PER_PLANE
    for (let term = 0; term < VECTOR_ANN_TERMS_PER_PLANE; term++) {
      const index = offset + term
      projection += normalized[plan.dimensions[index]] * plan.signs[index]
    }
    if (projection >= plan.thresholds[plane]) setSignatureBit(signature, plane)
  }
  return signature
}

export function vectorAnnSignatureFromF16(
  vectors: Buffer,
  row: number,
  plan: VectorAnnProjectionPlan,
): { low: number; high: number } {
  const signature = { low: 0, high: 0 }
  const rowOffset = row * plan.dim * 2
  for (let plane = 0; plane < VECTOR_ANN_PLANES; plane++) {
    let projection = 0
    const offset = plane * VECTOR_ANN_TERMS_PER_PLANE
    for (let term = 0; term < VECTOR_ANN_TERMS_PER_PLANE; term++) {
      const index = offset + term
      const dimension = plan.dimensions[index]
      projection +=
        float16ToFloat32(vectors.readUInt16LE(rowOffset + dimension * 2)) * plan.signs[index]
    }
    if (projection >= plan.thresholds[plane]) setSignatureBit(signature, plane)
  }
  return signature
}

export function writeVectorAnnSignature(
  target: Buffer,
  row: number,
  signature: { low: number; high: number },
): void {
  const offset = row * VECTOR_ANN_SIGNATURE_BYTES
  target.writeUInt32LE(signature.low >>> 0, offset)
  target.writeUInt16LE(signature.high & 0xffff, offset + 4)
  target.writeUInt16LE(0, offset + 6)
}

const popcount12 = new Uint8Array(1 << VECTOR_ANN_BAND_BITS)
for (let value = 1; value < popcount12.length; value++) {
  popcount12[value] = popcount12[value >>> 1] + (value & 1)
}

function signatureBand(low: number, high: number, band: number): number {
  const shift = band * VECTOR_ANN_BAND_BITS
  if (shift < 32) {
    if (shift <= 20) return (low >>> shift) & 0xfff
    const lowBits = 32 - shift
    const lowPart = low >>> shift
    const highMask = (1 << (VECTOR_ANN_BAND_BITS - lowBits)) - 1
    return (lowPart | ((high & highMask) << lowBits)) & 0xfff
  }
  return (high >>> (shift - 32)) & 0xfff
}

export function collectVectorAnnCandidates(
  signatures: VectorAnnBufferSource,
  count: number,
  query: { low: number; high: number },
  isCancelled?: () => boolean,
): Uint32Array {
  const segments = validateSegments(signatures, count, VECTOR_ANN_SIGNATURE_BYTES, 'ANN signature')
  const rows: number[] = []
  const queryBands = new Uint16Array(VECTOR_ANN_BANDS)
  for (let band = 0; band < VECTOR_ANN_BANDS; band++) {
    queryBands[band] = signatureBand(query.low, query.high, band)
  }
  let segmentIndex = 0
  let segment = segments?.[0]
  for (let row = 0; row < count; row++) {
    if ((row & 4095) === 0 && isCancelled?.()) throw new Error('ANN search cancelled')
    while (segment && row >= segment.startRow + segment.rowCount) {
      segment = segments?.[++segmentIndex]
    }
    const buffer = segment?.buffer || (signatures as Buffer)
    const localRow = segment ? row - segment.startRow : row
    const offset = localRow * VECTOR_ANN_SIGNATURE_BYTES
    const low = buffer.readUInt32LE(offset)
    const high = buffer.readUInt16LE(offset + 4)
    let accepted = false
    for (let band = 0; band < VECTOR_ANN_BANDS; band++) {
      const distance = popcount12[signatureBand(low, high, band) ^ queryBands[band]]
      if (distance <= VECTOR_ANN_PROBE_RADIUS) {
        accepted = true
        break
      }
    }
    if (accepted) rows.push(row)
  }
  return Uint32Array.from(rows)
}

export function createVectorAnnProjectionDimensions(
  dim: number,
  requestedCount = VECTOR_ANN_PROJECTION_DIMENSIONS,
): Uint16Array {
  if (!Number.isInteger(dim) || dim <= 0 || dim > MAX_EMBEDDING_VECTOR_DIM) {
    throw new Error(`Invalid ANN dimension: ${dim}`)
  }
  if (!Number.isSafeInteger(requestedCount) || requestedCount <= 0) {
    throw new Error(`Invalid ANN projection dimension count: ${requestedCount}`)
  }
  const values = Array.from({ length: dim }, (_, index) => index)
  const random = { value: 0x243f6a88 }
  for (let index = values.length - 1; index > 0; index--) {
    random.value = nextRandom(random)
    const target = random.value % (index + 1)
    ;[values[index], values[target]] = [values[target], values[index]]
  }
  return Uint16Array.from(values.slice(0, Math.min(dim, requestedCount)))
}

function validateProjectionParameters(
  dim: number,
  dimensions: Uint16Array,
  inverseScales: Float32Array,
): void {
  if (dimensions.length === 0 || dimensions.length !== inverseScales.length) {
    throw new Error('ANN quantized projection metadata mismatch')
  }
  const seen = new Set<number>()
  for (let index = 0; index < dimensions.length; index++) {
    const dimension = dimensions[index]
    if (dimension >= dim || seen.has(dimension)) {
      throw new Error('ANN quantized projection dimensions are invalid')
    }
    if (!Number.isFinite(inverseScales[index]) || inverseScales[index] <= 0) {
      throw new Error('ANN quantized projection scale is invalid')
    }
    seen.add(dimension)
  }
}

export function quantizeVectorAnnProjection(
  vectors: Buffer,
  dim: number,
  dimensions: Uint16Array,
  inverseScales: Float32Array,
  isCancelled?: () => boolean,
  rejectClipping = false,
): Buffer {
  validateProjectionParameters(dim, dimensions, inverseScales)
  const rowBytes = dim * 2
  if (vectors.length % rowBytes !== 0) throw new Error('ANN projection vector byte mismatch')
  const count = vectors.length / rowBytes
  const values = Buffer.allocUnsafe(count * dimensions.length)
  const signedValues = new Int8Array(values.buffer, values.byteOffset, values.length)
  for (let row = 0; row < count; row++) {
    if ((row & 1023) === 0 && isCancelled?.()) throw new Error('ANN build cancelled')
    const sourceOffset = row * rowBytes
    const targetOffset = row * dimensions.length
    for (let projectedIndex = 0; projectedIndex < dimensions.length; projectedIndex++) {
      const value = float16ToFloat32(
        vectors.readUInt16LE(sourceOffset + dimensions[projectedIndex] * 2),
      )
      if (rejectClipping && Math.abs(value) > inverseScales[projectedIndex] * 127 * (1 + 1e-6)) {
        throw new Error('ANN quantized projection scale exceeded')
      }
      signedValues[targetOffset + projectedIndex] = Math.max(
        -127,
        Math.min(127, Math.round(value / inverseScales[projectedIndex])),
      )
    }
  }
  return values
}

export function buildVectorAnnQuantizedProjection(
  vectors: Buffer,
  dim: number,
  isCancelled?: () => boolean,
): VectorAnnQuantizedProjection {
  const rowBytes = dim * 2
  if (vectors.length % rowBytes !== 0) throw new Error('ANN projection vector byte mismatch')
  const count = vectors.length / rowBytes
  const dimensions = createVectorAnnProjectionDimensions(dim)
  const maximums = new Float32Array(dimensions.length)
  for (let row = 0; row < count; row++) {
    if ((row & 1023) === 0 && isCancelled?.()) throw new Error('ANN build cancelled')
    const sourceOffset = row * rowBytes
    for (let projectedIndex = 0; projectedIndex < dimensions.length; projectedIndex++) {
      const value = Math.abs(
        float16ToFloat32(vectors.readUInt16LE(sourceOffset + dimensions[projectedIndex] * 2)),
      )
      if (value > maximums[projectedIndex]) maximums[projectedIndex] = value
    }
  }
  const inverseScales = Float32Array.from(maximums, (maximum) => maximum / 127 || 1)
  return {
    dimensions,
    inverseScales,
    values: quantizeVectorAnnProjection(vectors, dim, dimensions, inverseScales, isCancelled),
  }
}

export function collectVectorAnnProjectionCandidates(
  projections: VectorAnnBufferSource,
  count: number,
  dimensions: Uint16Array,
  inverseScales: Float32Array,
  queryVector: Float32Array | number[],
  activeRows: Uint32Array,
  topK: number,
  candidateRatio = VECTOR_ANN_CANDIDATE_RATIO,
  isCancelled?: () => boolean,
): Uint32Array {
  validateProjectionParameters(queryVector.length, dimensions, inverseScales)
  const normalizedQuery = requireNormalizedEmbeddingVectorFloat32(queryVector, queryVector.length)
  if (!Number.isSafeInteger(topK) || topK <= 0 || topK > VECTOR_ANN_MAX_TOP_K) {
    throw new RangeError(`ANN topK must be a positive safe integer <= ${VECTOR_ANN_MAX_TOP_K}`)
  }
  if (!Number.isFinite(candidateRatio) || candidateRatio <= 0 || candidateRatio > 0.2) {
    throw new RangeError('ANN candidate ratio must be in (0, 0.2]')
  }
  const segments = validateSegments(
    projections,
    count,
    dimensions.length,
    'ANN quantized projection',
  )
  const queryWeights = Float32Array.from(
    dimensions,
    (dimension, index) => normalizedQuery[dimension] * inverseScales[index],
  )
  const candidateLimit = Math.min(
    activeRows.length,
    Math.max(topK, Math.floor(activeRows.length * candidateRatio)),
  )
  if (candidateLimit === activeRows.length) {
    if (isCancelled?.()) throw new Error('ANN search cancelled')
    return activeRows.slice()
  }
  const scores = new Float32Array(activeRows.length)
  const cutoffHeap = new Float32Array(candidateLimit)
  let cutoffHeapSize = 0
  const retainCutoffScore = (score: number): void => {
    if (cutoffHeapSize < candidateLimit) {
      let child = cutoffHeapSize++
      cutoffHeap[child] = score
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2)
        if (cutoffHeap[parent] <= cutoffHeap[child]) break
        ;[cutoffHeap[parent], cutoffHeap[child]] = [cutoffHeap[child], cutoffHeap[parent]]
        child = parent
      }
      return
    }
    if (score <= cutoffHeap[0]) return
    cutoffHeap[0] = score
    let parent = 0
    for (;;) {
      const left = parent * 2 + 1
      const right = left + 1
      if (left >= cutoffHeapSize) break
      const smaller = right < cutoffHeapSize && cutoffHeap[right] < cutoffHeap[left] ? right : left
      if (cutoffHeap[parent] <= cutoffHeap[smaller]) break
      ;[cutoffHeap[parent], cutoffHeap[smaller]] = [cutoffHeap[smaller], cutoffHeap[parent]]
      parent = smaller
    }
  }
  let segmentIndex = 0
  let segment = segments?.[0]
  let previousRow = -1
  for (let activeIndex = 0; activeIndex < activeRows.length; activeIndex++) {
    if ((activeIndex & 1023) === 0 && isCancelled?.()) throw new Error('ANN search cancelled')
    const row = activeRows[activeIndex]
    if (row >= count || row <= previousRow) throw new Error('ANN active rows are invalid')
    previousRow = row
    while (segment && row >= segment.startRow + segment.rowCount) {
      segment = segments?.[++segmentIndex]
    }
    if (segments && (!segment || row < segment.startRow)) {
      throw new Error('ANN projection segment is missing')
    }
    const buffer = segment?.buffer || (projections as Buffer)
    const localRow = segment ? row - segment.startRow : row
    const rowOffset = localRow * dimensions.length
    let score = 0
    for (let projectedIndex = 0; projectedIndex < dimensions.length; projectedIndex++) {
      score += queryWeights[projectedIndex] * buffer.readInt8(rowOffset + projectedIndex)
    }
    scores[activeIndex] = score
    retainCutoffScore(score)
  }
  const cutoff = cutoffHeap[0]
  let strictlyGreater = 0
  for (const score of scores) if (score > cutoff) strictlyGreater += 1
  let tiedRemaining = candidateLimit - strictlyGreater
  const candidates = new Uint32Array(candidateLimit)
  let outputIndex = 0
  for (let activeIndex = 0; activeIndex < activeRows.length; activeIndex++) {
    const accepted =
      scores[activeIndex] > cutoff || (scores[activeIndex] === cutoff && tiedRemaining-- > 0)
    if (accepted) candidates[outputIndex++] = activeRows[activeIndex]
  }
  if (outputIndex !== candidateLimit) throw new Error('ANN candidate selection count mismatch')
  return candidates
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
    let smaller = left
    if (right < heap.length && heap[right].score < heap[left].score) smaller = right
    if (heap[parent].score <= heap[smaller].score) break
    ;[heap[parent], heap[smaller]] = [heap[smaller], heap[parent]]
    parent = smaller
  }
}

export function scoreVectorAnnCandidates(
  vectors: VectorAnnBufferSource,
  dim: number,
  candidates: Uint32Array,
  queryVector: Float32Array | number[],
  topK: number,
  isCancelled?: () => boolean,
): VectorAnnScoredRow[] {
  const normalizedQuery = requireNormalizedEmbeddingVectorFloat32(queryVector, dim)
  if (!Number.isSafeInteger(topK) || topK <= 0 || topK > VECTOR_ANN_MAX_TOP_K) {
    throw new RangeError(`ANN topK must be a positive safe integer <= ${VECTOR_ANN_MAX_TOP_K}`)
  }
  const count = Buffer.isBuffer(vectors)
    ? vectors.length / (dim * 2)
    : vectors.reduce((sum, segment) => sum + segment.rowCount, 0)
  if (!Number.isInteger(count)) throw new Error('ANN vector byte length mismatch')
  const segments = validateSegments(vectors, count, dim * 2, 'ANN vector')
  const heap: VectorAnnScoredRow[] = []
  const limit = topK
  let segmentIndex = 0
  let segment = segments?.[0]
  let previousRow = -1
  const seenCandidates = new Set<number>()
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    if ((candidateIndex & 1023) === 0 && isCancelled?.()) throw new Error('ANN search cancelled')
    const row = candidates[candidateIndex]
    if (row >= count) throw new Error('ANN candidate row is outside the vector snapshot')
    if (seenCandidates.has(row)) throw new Error(`ANN candidate row ${row} is duplicated`)
    seenCandidates.add(row)
    if (segments) {
      if (row < previousRow) {
        segmentIndex = 0
        segment = segments[0]
      }
      while (segment && row >= segment.startRow + segment.rowCount) {
        segment = segments[++segmentIndex]
      }
      if (!segment || row < segment.startRow) throw new Error('ANN vector segment is missing')
    }
    previousRow = row
    const buffer = segment?.buffer || (vectors as Buffer)
    const localRow = segment ? row - segment.startRow : row
    const rowOffset = localRow * dim * 2
    let dot = 0
    for (let dimension = 0; dimension < dim; dimension++) {
      dot +=
        normalizedQuery[dimension] *
        float16ToFloat32(buffer.readUInt16LE(rowOffset + dimension * 2))
    }
    pushScoredRow(heap, { row, score: (dot + 1) / 2 }, limit)
  }
  return heap.sort((left, right) => right.score - left.score || left.row - right.row)
}
