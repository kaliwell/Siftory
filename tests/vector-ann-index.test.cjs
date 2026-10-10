const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const ann = loadTsModule('electron/vectorAnnIndex.ts')
const f16 = loadTsModule('electron/embeddingF16Cache.ts')
const annHost = loadTsModule('electron/vectorAnnWorkerHost.ts')

function vectorBuffer(vectors) {
  const dim = vectors[0].length
  const buffer = Buffer.alloc(vectors.length * dim * 2)
  vectors.forEach((vector, row) => {
    vector.forEach((value, dimension) => {
      buffer.writeUInt16LE(f16.float32ToFloat16(value), (row * dim + dimension) * 2)
    })
  })
  return { buffer, dim }
}

test('ANN projection plan and signatures are deterministic', () => {
  const firstPlan = ann.createVectorAnnProjectionPlan(8)
  const secondPlan = ann.createVectorAnnProjectionPlan(8)
  assert.deepEqual(firstPlan.dimensions, secondPlan.dimensions)
  assert.deepEqual(firstPlan.signs, secondPlan.signs)
  assert.deepEqual(firstPlan.thresholds, secondPlan.thresholds)
  assert.notDeepEqual(firstPlan.signs, ann.createVectorAnnProjectionPlan(8, 1).signs)
  assert.deepEqual(
    ann.vectorAnnSignatureFromFloat32([1, 0, 0, 0, 0, 0, 0, 0], firstPlan),
    ann.vectorAnnSignatureFromFloat32([1, 0, 0, 0, 0, 0, 0, 0], secondPlan),
  )
})

test('Q8 projection selects a bounded candidate set before exact F16 reranking', () => {
  const vectors = Array.from({ length: 20 }, (_, index) => {
    const angle = (index / 20) * Math.PI * 2
    return [Math.cos(angle), Math.sin(angle), 0, 0, 0, 0, 0, 0]
  })
  const { buffer, dim } = vectorBuffer(vectors)
  const projection = ann.buildVectorAnnQuantizedProjection(buffer, dim)
  assert.equal(projection.dimensions.length, dim)
  assert.equal(projection.values.length, vectors.length * dim)
  const activeRows = Uint32Array.from({ length: vectors.length }, (_, index) => index)
  const candidates = ann.collectVectorAnnProjectionCandidates(
    projection.values,
    vectors.length,
    projection.dimensions,
    projection.inverseScales,
    vectors[0],
    activeRows,
    2,
    0.2,
  )
  assert.equal(candidates.length, 4)
  assert.ok([...candidates].includes(0), 'the identical row must survive projection screening')
  const scored = ann.scoreVectorAnnCandidates(buffer, dim, candidates, vectors[0], 2)
  assert.equal(scored[0].row, 0)
})

test('Q8 projection append and segmented search match one contiguous snapshot', () => {
  const vectors = Array.from({ length: 16 }, (_, index) => {
    const angle = (index / 16) * Math.PI * 2
    return [Math.cos(angle), Math.sin(angle), 0, 0, 0, 0, 0, 0]
  })
  const { buffer, dim } = vectorBuffer(vectors)
  const projection = ann.buildVectorAnnQuantizedProjection(buffer, dim)
  const splitRow = 9
  const projectionBytes = projection.dimensions.length
  const appended = ann.quantizeVectorAnnProjection(
    buffer.subarray(splitRow * dim * 2),
    dim,
    projection.dimensions,
    projection.inverseScales,
  )
  assert.deepEqual(appended, projection.values.subarray(splitRow * projectionBytes))
  const segments = [
    {
      startRow: 0,
      rowCount: splitRow,
      buffer: projection.values.subarray(0, splitRow * projectionBytes),
    },
    { startRow: splitRow, rowCount: vectors.length - splitRow, buffer: appended },
  ]
  const activeRows = Uint32Array.from({ length: vectors.length }, (_, index) => index)
  const args = [
    vectors.length,
    projection.dimensions,
    projection.inverseScales,
    vectors[3],
    activeRows,
    2,
    0.2,
  ]
  assert.deepEqual(
    ann.collectVectorAnnProjectionCandidates(segments, ...args),
    ann.collectVectorAnnProjectionCandidates(projection.values, ...args),
  )
})

test('Q8 projection validates bounds and cooperatively cancels', () => {
  const { buffer, dim } = vectorBuffer(Array.from({ length: 2048 }, () => [1, 0, 0, 0]))
  assert.throws(() => ann.buildVectorAnnQuantizedProjection(buffer, dim, () => true), /cancelled/)
  const projection = ann.buildVectorAnnQuantizedProjection(buffer.subarray(0, dim * 2), dim)
  assert.throws(
    () =>
      ann.collectVectorAnnProjectionCandidates(
        projection.values,
        1,
        projection.dimensions,
        projection.inverseScales,
        [1, 0, 0, 0],
        Uint32Array.from([0]),
        1,
        0.21,
      ),
    /candidate ratio/,
  )
  assert.throws(
    () =>
      ann.collectVectorAnnProjectionCandidates(
        projection.values,
        1,
        projection.dimensions,
        projection.inverseScales,
        [1, 0, 0, 0],
        Uint32Array.from([0]),
        1,
        0.2,
        () => true,
      ),
    /cancelled/,
  )
  const base = vectorBuffer([[0.5, 0.5]])
  const baseProjection = ann.buildVectorAnnQuantizedProjection(base.buffer, base.dim)
  const changed = vectorBuffer([[1, 0]])
  assert.throws(
    () =>
      ann.quantizeVectorAnnProjection(
        changed.buffer,
        changed.dim,
        baseProjection.dimensions,
        baseProjection.inverseScales,
        undefined,
        true,
      ),
    /scale exceeded/,
  )
})

test('ANN signatures select and exactly rerank candidates', () => {
  const vectors = [
    [1, 0, 0, 0, 0, 0, 0, 0],
    [0.9, 0.1, 0, 0, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 0, 0, 0],
    [-1, 0, 0, 0, 0, 0, 0, 0],
  ]
  const { buffer, dim } = vectorBuffer(vectors)
  const plan = ann.createVectorAnnProjectionPlan(dim)
  const signatures = Buffer.alloc(vectors.length * ann.VECTOR_ANN_SIGNATURE_BYTES)
  for (let row = 0; row < vectors.length; row++) {
    ann.writeVectorAnnSignature(signatures, row, ann.vectorAnnSignatureFromF16(buffer, row, plan))
  }
  const query = ann.vectorAnnSignatureFromFloat32(vectors[0], plan)
  const candidates = ann.collectVectorAnnCandidates(signatures, vectors.length, query)
  assert.ok([...candidates].includes(0), 'the identical row must be recalled')
  const scored = ann.scoreVectorAnnCandidates(buffer, dim, candidates, vectors[0], 2)
  assert.equal(scored.length, 2)
  assert.equal(scored[0].row, 0)
  assert.ok(scored[0].score >= scored[1].score)
})

test('segmented ANN signatures and vectors are identical to a contiguous snapshot', () => {
  const vectors = [
    [1, 0, 0, 0, 0, 0, 0, 0],
    [0.8, 0.2, 0, 0, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 0, 0, 0],
    [-1, 0, 0, 0, 0, 0, 0, 0],
  ]
  const { buffer, dim } = vectorBuffer(vectors)
  const plan = ann.createVectorAnnProjectionPlan(dim)
  const signatures = Buffer.alloc(vectors.length * ann.VECTOR_ANN_SIGNATURE_BYTES)
  for (let row = 0; row < vectors.length; row++) {
    ann.writeVectorAnnSignature(signatures, row, ann.vectorAnnSignatureFromF16(buffer, row, plan))
  }
  const splitRow = 2
  const signatureSegments = [
    {
      startRow: 0,
      rowCount: splitRow,
      buffer: signatures.subarray(0, splitRow * ann.VECTOR_ANN_SIGNATURE_BYTES),
    },
    {
      startRow: splitRow,
      rowCount: vectors.length - splitRow,
      buffer: signatures.subarray(splitRow * ann.VECTOR_ANN_SIGNATURE_BYTES),
    },
  ]
  const vectorSegments = [
    { startRow: 0, rowCount: splitRow, buffer: buffer.subarray(0, splitRow * dim * 2) },
    {
      startRow: splitRow,
      rowCount: vectors.length - splitRow,
      buffer: buffer.subarray(splitRow * dim * 2),
    },
  ]
  const query = ann.vectorAnnSignatureFromFloat32(vectors[0], plan)
  const contiguousCandidates = ann.collectVectorAnnCandidates(signatures, vectors.length, query)
  const segmentedCandidates = ann.collectVectorAnnCandidates(
    signatureSegments,
    vectors.length,
    query,
  )
  assert.deepEqual(segmentedCandidates, contiguousCandidates)
  assert.deepEqual(
    ann.scoreVectorAnnCandidates(vectorSegments, dim, segmentedCandidates, vectors[0], 3),
    ann.scoreVectorAnnCandidates(buffer, dim, contiguousCandidates, vectors[0], 3),
  )
})

test('ANN candidate collection and scoring are cooperatively cancellable', () => {
  const signatures = Buffer.alloc(5000 * ann.VECTOR_ANN_SIGNATURE_BYTES)
  assert.throws(
    () => ann.collectVectorAnnCandidates(signatures, 5000, { low: 0, high: 0 }, () => true),
    /cancelled/,
  )

  const { buffer, dim } = vectorBuffer(Array.from({ length: 2048 }, () => [1, 0, 0, 0, 0, 0, 0, 0]))
  assert.throws(
    () =>
      ann.scoreVectorAnnCandidates(
        buffer,
        dim,
        Uint32Array.from({ length: 2048 }, (_, index) => index),
        [1, 0, 0, 0, 0, 0, 0, 0],
        10,
        () => true,
      ),
    /cancelled/,
  )
})

test('large vector search keeps exact Float16 fallback behind ANN', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'electron', 'vectorIndexService.ts'),
    'utf8',
  )
  const annCall = source.indexOf('await searchVectorAnn(')
  const exactCall = source.indexOf('await searchEmbeddingF16Cache(')
  assert.ok(annCall >= 0, 'ANN search call must exist')
  assert.ok(exactCall > annCall, 'exact Float16 fallback must remain after ANN')
  assert.match(source, /FLOATING_CLOCK_DISABLE_VECTOR_ANN/)
})

test('ANN host rejects malformed query vectors before starting a worker', async () => {
  const cache = {
    meta: { dim: 3 },
    vectorPath: 'unused',
    pathIndexPath: 'unused',
  }
  for (const query of [
    [1, 0],
    [1, 0, 0, 0],
    [0, 0, 0],
    [1, null, 0],
    [1, Number.NaN, 0],
  ]) {
    await assert.rejects(annHost.searchVectorAnn(cache, query, 1), /Invalid embedding vector/)
  }
})

test('ANN signature and exact rerank reject malformed queries and normalize extreme finite values', () => {
  const vectors = [
    [1, 0],
    [0, 1],
  ]
  const { buffer, dim } = vectorBuffer(vectors)
  const plan = ann.createVectorAnnProjectionPlan(dim)
  const candidates = Uint32Array.from([0, 1])
  const invalidQueries = [
    [1],
    [1, 0, 0],
    [0, 0],
    [1, null],
    [1, '0'],
    [1, Number.NaN],
    [1, Number.POSITIVE_INFINITY],
  ]
  for (const query of invalidQueries) {
    assert.throws(() => ann.vectorAnnSignatureFromFloat32(query, plan), /Invalid embedding vector/)
    assert.throws(
      () => ann.scoreVectorAnnCandidates(buffer, dim, candidates, query, 1),
      /Invalid embedding vector/,
    )
  }

  const baselineSignature = ann.vectorAnnSignatureFromFloat32([1, 0], plan)
  for (const query of [
    [1e308, 0],
    [Number.MIN_VALUE, 0],
  ]) {
    assert.deepEqual(ann.vectorAnnSignatureFromFloat32(query, plan), baselineSignature)
    const scored = ann.scoreVectorAnnCandidates(buffer, dim, candidates, query, 1)
    assert.deepEqual(
      scored.map((entry) => entry.row),
      [0],
    )
    assert.equal(scored[0].score, 1)
  }
})

test('ANN exact rerank validates topK and candidate identity', () => {
  const { buffer, dim } = vectorBuffer([
    [1, 0],
    [0, 1],
  ])
  for (const topK of [
    0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    ann.VECTOR_ANN_MAX_TOP_K + 1,
    1.5,
  ]) {
    assert.throws(
      () => ann.scoreVectorAnnCandidates(buffer, dim, Uint32Array.from([0]), [1, 0], topK),
      /topK/,
    )
  }
  assert.throws(
    () => ann.scoreVectorAnnCandidates(buffer, dim, Uint32Array.from([2]), [1, 0], 1),
    /outside/,
  )
  assert.throws(
    () => ann.scoreVectorAnnCandidates(buffer, dim, Uint32Array.from([0, 0]), [1, 0], 1),
    /duplicated/,
  )
})

test('Q8 candidate cutoff uses bounded candidate storage without a full score copy', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'vectorAnnIndex.ts'),
    'utf8',
  )
  const selection = source.slice(source.indexOf('export function collectVectorAnnProjectionCandidates'))
  assert.match(selection, /const cutoffHeap = new Float32Array\(candidateLimit\)/)
  assert.doesNotMatch(selection, /orderedScores|scores\.slice\(\)/)
})
