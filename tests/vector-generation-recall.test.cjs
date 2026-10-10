const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { evaluateGenerationRecall } = loadTsModule('electron/vectorGenerationRecall.ts')
const { float32ToFloat16 } = loadTsModule('electron/embeddingF16Cache.ts')

const DIM = 4
const COUNT = 60

// Deterministic pseudo-random unit vectors (LCG, no Math.random).
function makeVectors(count, dim) {
  let state = 123456789
  const vectors = []
  for (let row = 0; row < count; row++) {
    const vector = []
    let norm = 0
    for (let index = 0; index < dim; index++) {
      state = (1103515245 * state + 12345) % 2147483648
      const value = (state / 2147483648) * 2 - 1
      vector.push(value)
      norm += value * value
    }
    norm = Math.sqrt(norm)
    vectors.push(vector.map((value) => value / norm))
  }
  return vectors
}

function writeFixture(dir, vectors, options = {}) {
  const pathForRow = options.pathForRow ?? ((row) => `C:\\img\\${row}.jpg`)
  const jsonlPath = path.join(dir, 'shard.jsonl')
  const lines = vectors.map(
    (vector, row) =>
      `${JSON.stringify({ imageId: pathForRow(row), modelName: 'm', embeddingType: 'global', dim: DIM, vector })}\n`,
  )
  if (options.malformedLine) lines.splice(3, 0, 'not json {\n')
  fs.writeFileSync(jsonlPath, lines.join(''))

  const generationDir = path.join(dir, 'generation')
  fs.mkdirSync(generationDir, { recursive: true })
  const vectorPath = path.join(generationDir, 'vectors.f16')
  const pathIndexPath = path.join(generationDir, 'paths.jsonl')
  const buffer = Buffer.alloc(vectors.length * DIM * 2)
  for (let row = 0; row < vectors.length; row++) {
    for (let index = 0; index < DIM; index++) {
      buffer.writeUInt16LE(float32ToFloat16(vectors[row][index]), (row * DIM + index) * 2)
    }
  }
  fs.writeFileSync(vectorPath, buffer)
  fs.writeFileSync(
    pathIndexPath,
    vectors
      .map((_, row) => `${JSON.stringify({ row, path: pathForRow(row), offset: row * DIM * 2 })}\n`)
      .join(''),
  )
  return {
    jsonlPath,
    handle: {
      meta: {
        version: 1,
        modelName: 'm',
        embeddingType: 'global',
        dim: DIM,
        count: vectors.length,
        sourceRecordCount: vectors.length,
        sourceFiles: [],
        updatedAt: 0,
        generation: 'g1',
      },
      vectorPath,
      pathIndexPath,
    },
  }
}

function fixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-recall-gate-'))
}

test('identical stores pass the gate with perfect recall and tiny error', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  const report = await evaluateGenerationRecall(jsonlPath, handle, {
    queryCount: 20,
    topK: 10,
    seed: 7,
    // Tiny 4-dim fixtures quantize scores coarsely; the strict defaults are
    // calibrated for the real 512/768-d stores and are exercised by the
    // failure-path tests instead.
    thresholds: {
      minRecallAtK: 0.9,
      minSelfInTopKRate: 1,
      maxTop1Gap: 1e-3,
      maxMedianScoreError: 1e-3,
      maxP99ScoreError: 5e-3,
    },
  })
  assert.equal(report.malformedJsonlRows, 0)
  assert.equal(report.sourceRecordCount, COUNT)
  assert.equal(report.sourceEffectiveCount, COUNT)
  assert.equal(report.sourceValidCount, COUNT)
  assert.equal(report.sourceZeroNormRows, 0)
  assert.equal(report.sourceNonFiniteRows, 0)
  assert.equal(report.sourceDimensionMismatchRows, 0)
  assert.equal(report.historicalInvalidRows, 0)
  assert.equal(report.missingInGeneration, 0)
  assert.equal(report.alignedCount, COUNT)
  assert.equal(report.missingInJsonl, 0)
  assert.ok(report.recallAtKMean >= 0.9, `recall ${report.recallAtKMean}`)
  assert.equal(report.selfTop1Rate, 1)
  assert.ok(report.scoreErrorMedian < 1e-3, `median error ${report.scoreErrorMedian}`)
  assert.equal(report.gatePassed, true, report.gateFailures.join('; '))
})

test('shuffled generation collapses recall and fails the gate', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const shuffled = [...vectors].reverse()
  const { jsonlPath, handle } = writeFixture(dir, shuffled)
  // The JSONL keeps the original order; the generation rows point at
  // mismatched vectors, so top-K overlap must collapse.
  const jsonlLines = vectors.map(
    (vector, row) =>
      `${JSON.stringify({ imageId: `C:\\img\\${row}.jpg`, modelName: 'm', embeddingType: 'global', dim: DIM, vector })}\n`,
  )
  fs.writeFileSync(jsonlPath, jsonlLines.join(''))
  const report = await evaluateGenerationRecall(jsonlPath, handle, {
    queryCount: 20,
    topK: 10,
    seed: 7,
  })
  assert.equal(report.gatePassed, false)
  assert.ok(report.gateFailures.some((failure) => failure.startsWith('recall@10')))
  assert.ok(report.recallAtKMean < 0.5, `recall ${report.recallAtKMean}`)
})

test('stratified sampling catches a path/vector mismatch confined to the trailing rows', async () => {
  const dir = fixtureDir()
  const count = 399
  const vectors = makeVectors(count, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)

  // With floor(399 / 200) === 1, the former step sampler queried only rows
  // 0..199 and missed every corrupted row. Rotate the paths of rows 200..398
  // so all 199 trailing generation vectors have the wrong source identity.
  const pathRows = fs
    .readFileSync(handle.pathIndexPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
  for (let row = 200; row < count; row++) {
    const nextPathRow = row === count - 1 ? 200 : row + 1
    pathRows[row].path = `C:\\img\\${nextPathRow}.jpg`
  }
  fs.writeFileSync(
    handle.pathIndexPath,
    `${pathRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  )

  const report = await evaluateGenerationRecall(jsonlPath, handle, {
    queryCount: 200,
    topK: 1,
    seed: 7,
  })
  assert.equal(report.alignedCount, count)
  assert.equal(report.queryCount, 200)
  assert.equal(report.gatePassed, false)
  assert.ok(report.gateFailures.some((failure) => failure.startsWith('recall@1')))
})

test('near-tie top-K swaps keep strict recall diagnostic but pass rank-equivalent gate', async () => {
  const dir = fixtureDir()
  const vectors = [[1, 0, 0, 0]]
  for (let row = 0; row < 100; row++) {
    // All candidates land in one narrow F16 bucket while their exact F32
    // scores remain ordered. The strict path top-K therefore changes, but
    // every returned candidate is score-equivalent at the accepted boundary.
    vectors.push([1, 0.010003 - row * 0.00000001, 0, 0])
  }
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  const report = await evaluateGenerationRecall(jsonlPath, handle, {
    queryCount: 1,
    topK: 10,
    seed: 0,
  })
  assert.ok(report.recallAtKMean < 0.99, `strict recall ${report.recallAtKMean}`)
  assert.equal(report.rankEquivalentRecallAtKMean, 1)
  assert.equal(report.selfWithinTop1ToleranceRate, 1)
  assert.equal(report.gatePassed, true, report.gateFailures.join('; '))
})

test('repeated paths use the latest revision in both source and generation', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const repeatedPath = 'C:\\img\\repeated.jpg'
  const { jsonlPath, handle } = writeFixture(dir, vectors, {
    pathForRow: (row) => (row === 0 || row === 50 ? repeatedPath : `C:\\img\\${row}.jpg`),
  })
  const report = await evaluateGenerationRecall(jsonlPath, handle, {
    queryCount: 1,
    topK: 10,
    seed: 50,
  })
  assert.equal(report.sourceRecordCount, COUNT)
  assert.equal(report.sourceEffectiveCount, COUNT - 1)
  assert.equal(report.sourceValidCount, COUNT - 1)
  assert.equal(report.alignedCount, COUNT - 1)
  assert.equal(report.missingInJsonl, 0)
  assert.equal(report.selfWithinTop1ToleranceRate, 1)
  assert.equal(report.gatePassed, true, report.gateFailures.join('; '))
})

test('generation paths missing from the JSONL are excluded and counted', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  // Drop the first 5 JSONL rows: those generation paths lose their F32 twin.
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').slice(5)
  fs.writeFileSync(jsonlPath, lines.join('\n'))
  const report = await evaluateGenerationRecall(jsonlPath, handle, {
    queryCount: 20,
    topK: 10,
    seed: 7,
    thresholds: {
      minRecallAtK: 0.9,
      minSelfInTopKRate: 1,
      maxTop1Gap: 1e-3,
      maxMedianScoreError: 1e-3,
      maxP99ScoreError: 5e-3,
    },
  })
  assert.equal(report.missingInJsonl, 5)
  assert.equal(report.alignedCount, COUNT - 5)
  assert.equal(report.gatePassed, false)
  assert.ok(
    report.gateFailures.some((failure) => failure.includes('missing from the current source')),
  )
})

test('vector file size mismatch is rejected before scoring', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  fs.truncateSync(handle.vectorPath, handle.meta.count * DIM * 2 - 2)
  await assert.rejects(evaluateGenerationRecall(jsonlPath, handle), /size mismatch/)
})

test('malformed source rows fail closed without hiding otherwise valid recall metrics', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors, { malformedLine: true })
  const report = await evaluateGenerationRecall(jsonlPath, handle, { queryCount: 5, topK: 5 })
  assert.equal(report.malformedJsonlRows, 1)
  assert.equal(report.alignedCount, COUNT)
  assert.equal(report.gatePassed, false)
  assert.ok(report.gateFailures.some((failure) => failure.includes('malformed row')))
})

test('current invalid source revisions are classified and repaired revisions become diagnostic only', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  const identity = 'c:/IMG/0.jpg'
  const append = (value) =>
    fs.appendFileSync(
      jsonlPath,
      `${JSON.stringify({
        imageId: identity,
        modelName: 'm',
        embeddingType: 'global',
        dim: DIM,
        vector: value,
      })}\n`,
    )

  append([0, 0, 0, 0])
  let report = await evaluateGenerationRecall(jsonlPath, handle, { queryCount: 5, topK: 5 })
  assert.equal(report.sourceRecordCount, COUNT + 1)
  assert.equal(report.sourceEffectiveCount, COUNT)
  assert.equal(report.sourceValidCount, COUNT - 1)
  assert.equal(report.sourceZeroNormRows, 1)
  assert.equal(report.historicalInvalidRows, 0)
  assert.equal(report.missingInGeneration, 0)
  assert.equal(report.gatePassed, false)

  append(vectors[0])
  report = await evaluateGenerationRecall(jsonlPath, handle, { queryCount: 5, topK: 5 })
  assert.equal(report.sourceRecordCount, COUNT + 2)
  assert.equal(report.sourceEffectiveCount, COUNT)
  assert.equal(report.sourceValidCount, COUNT)
  assert.equal(report.sourceZeroNormRows, 0)
  assert.equal(report.historicalInvalidRows, 1)
  assert.equal(report.gatePassed, true, report.gateFailures.join('; '))
})

test('non-finite, null-container, and row-envelope dimension errors are separate hard failures', async () => {
  const invalids = [
    { vector: [1, null, 0, 0], dim: DIM, field: 'sourceNonFiniteRows' },
    { vector: null, dim: DIM, field: 'sourceDimensionMismatchRows' },
    { vector: [1, 0, 0, 0], dim: 999, field: 'sourceDimensionMismatchRows' },
    { vector: [1, 0, 0], dim: DIM, field: 'sourceDimensionMismatchRows' },
  ]
  for (const [index, invalid] of invalids.entries()) {
    const dir = fixtureDir()
    const vectors = makeVectors(COUNT, DIM)
    const { jsonlPath, handle } = writeFixture(dir, vectors)
    fs.appendFileSync(
      jsonlPath,
      `${JSON.stringify({
        imageId: 'C:\\img\\0.jpg',
        modelName: 'm',
        embeddingType: 'global',
        dim: invalid.dim,
        vector: invalid.vector,
      })}\n`,
    )
    const report = await evaluateGenerationRecall(jsonlPath, handle, {
      queryCount: 3,
      topK: 3,
      seed: index,
    })
    assert.equal(report[invalid.field], 1)
    assert.equal(report.gatePassed, false)
  }
})

test('a valid source path absent from generation is counted and fails the gate', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  fs.appendFileSync(
    jsonlPath,
    `${JSON.stringify({
      imageId: 'C:\\img\\new.jpg',
      modelName: 'm',
      embeddingType: 'global',
      dim: DIM,
      vector: vectors[0],
    })}\n`,
  )
  const report = await evaluateGenerationRecall(jsonlPath, handle, { queryCount: 5, topK: 5 })
  assert.equal(report.missingInGeneration, 1)
  assert.equal(report.gatePassed, false)
})

test('ordered source shards apply canonical latest-wins tombstones and repairs', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  const current = path.join(dir, 'current.jsonl')
  fs.writeFileSync(
    current,
    `${JSON.stringify({
      imageId: 'c:/IMG/0.jpg',
      modelName: 'm',
      embeddingType: 'global',
      dim: DIM,
      vector: [0, 0, 0, 0],
    })}\n`,
  )
  let report = await evaluateGenerationRecall([jsonlPath, current], handle, {
    queryCount: 5,
    topK: 5,
  })
  assert.equal(report.sourceZeroNormRows, 1)
  assert.equal(report.gatePassed, false)

  fs.appendFileSync(
    current,
    `${JSON.stringify({
      imageId: 'C:\\img\\0.jpg',
      modelName: 'm',
      embeddingType: 'global',
      dim: DIM,
      vector: vectors[0],
    })}\n`,
  )
  report = await evaluateGenerationRecall([jsonlPath, current], handle, {
    queryCount: 5,
    topK: 5,
  })
  assert.equal(report.sourceZeroNormRows, 0)
  assert.equal(report.historicalInvalidRows, 1)
  assert.equal(report.gatePassed, true, report.gateFailures.join('; '))
})

test('invalid options and malformed generation indexes fail before unsafe scoring', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  for (const options of [
    { queryCount: 0 },
    { queryCount: Number.NaN },
    { topK: 5001 },
    { seed: Number.POSITIVE_INFINITY },
    {
      thresholds: {
        minRecallAtK: Number.NaN,
        minSelfInTopKRate: 1,
        maxTop1Gap: 0.001,
        maxMedianScoreError: 0.001,
        maxP99ScoreError: 0.005,
      },
    },
  ]) {
    await assert.rejects(evaluateGenerationRecall(jsonlPath, handle, options), /must be|threshold/)
  }

  fs.appendFileSync(handle.pathIndexPath, `${JSON.stringify({ row: COUNT, path: 'x' })}\n`)
  await assert.rejects(evaluateGenerationRecall(jsonlPath, handle), /out of range/)
})

test('zero and non-finite decoded generation rows fail closed', async () => {
  for (const encodedValue of [0x0000, 0x7e00]) {
    const dir = fixtureDir()
    const vectors = makeVectors(COUNT, DIM)
    const { jsonlPath, handle } = writeFixture(dir, vectors)
    const fd = fs.openSync(handle.vectorPath, 'r+')
    try {
      for (let component = 0; component < DIM; component++) {
        const bytes = Buffer.alloc(2)
        bytes.writeUInt16LE(encodedValue)
        fs.writeSync(fd, bytes, 0, 2, component * 2)
      }
    } finally {
      fs.closeSync(fd)
    }
    await assert.rejects(
      evaluateGenerationRecall(jsonlPath, handle),
      /Generation vector row 0 is invalid/,
    )
  }
})

test('generation path indexes reject missing and duplicate physical rows', async () => {
  const vectors = makeVectors(COUNT, DIM)
  {
    const dir = fixtureDir()
    const { jsonlPath, handle } = writeFixture(dir, vectors)
    const lines = fs.readFileSync(handle.pathIndexPath, 'utf8').trim().split(/\r?\n/)
    fs.writeFileSync(handle.pathIndexPath, `${lines.slice(1).join('\n')}\n`)
    await assert.rejects(evaluateGenerationRecall(jsonlPath, handle), /row count mismatch/)
  }
  {
    const dir = fixtureDir()
    const { jsonlPath, handle } = writeFixture(dir, vectors)
    fs.appendFileSync(
      handle.pathIndexPath,
      `${JSON.stringify({ row: 0, path: 'C:\\img\\duplicate.jpg' })}\n`,
    )
    await assert.rejects(evaluateGenerationRecall(jsonlPath, handle), /duplicate row 0/)
  }
})


// ── VAL-032: memory ceiling, unchanged-source reuse, cancellation ────────

const METRIC_FIELDS = [
  'generationCount',
  'sourceRecordCount',
  'sourceEffectiveCount',
  'sourceValidCount',
  'sourceZeroNormRows',
  'sourceNonFiniteRows',
  'sourceDimensionMismatchRows',
  'historicalInvalidRows',
  'missingInGeneration',
  'alignedCount',
  'missingInJsonl',
  'malformedJsonlRows',
  'queryCount',
  'topK',
  'sourceMatrixBytes',
  'recallAtKMean',
  'recallAtKMin',
  'rankEquivalentRecallAtKMean',
  'rankEquivalentRecallAtKMin',
  'selfTop1Rate',
  'selfInTopKRate',
  'selfWithinTop1ToleranceRate',
  'top1GapP99',
  'top1GapMax',
  'scoreErrorMedian',
  'scoreErrorP99',
  'scoreErrorMax',
  'gatePassed',
]

function assertMetricParity(left, right) {
  for (const field of METRIC_FIELDS) {
    assert.deepStrictEqual(right[field], left[field], `metric ${field} must match across load modes`)
  }
}

function tmpSpillLeftovers() {
  return fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('recall-source-spill-') || name.startsWith('recall-source-compact-'))
}

test('memory ceiling spills the source matrix with bit-identical metrics and no leftovers', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  const baseline = await evaluateGenerationRecall(jsonlPath, handle, { queryCount: 10, topK: 5 })
  assert.equal(baseline.sourceLoadMode, 'memory')
  assert.equal(baseline.memoryCeilingBytes, 256 * 1024 * 1024)
  assert.equal(baseline.sourceMatrixBytes, COUNT * DIM * 4)

  const before = tmpSpillLeftovers()
  const spilled = await evaluateGenerationRecall(jsonlPath, handle, {
    queryCount: 10,
    topK: 5,
    memoryCeilingBytes: 1,
  })
  assert.equal(spilled.sourceLoadMode, 'spill')
  assert.equal(spilled.memoryCeilingBytes, 1)
  assertMetricParity(baseline, spilled)
  assert.deepStrictEqual(tmpSpillLeftovers(), before, 'spill/compact scratch files must be removed')
})

test('unchanged source reuses the cached validation matrix; a changed source recomputes', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  const matrixCacheDir = path.join(dir, 'matrix-cache')

  const first = await evaluateGenerationRecall(jsonlPath, handle, {
    queryCount: 10,
    topK: 5,
    matrixCacheDir,
  })
  assert.equal(first.sourceLoadMode, 'memory')
  const cacheEntries = fs.readdirSync(matrixCacheDir)
  assert.equal(cacheEntries.filter((name) => name.endsWith('.json')).length, 1)
  assert.equal(cacheEntries.filter((name) => name.endsWith('.f32')).length, 1)

  const second = await evaluateGenerationRecall(jsonlPath, handle, {
    queryCount: 10,
    topK: 5,
    matrixCacheDir,
  })
  assert.equal(second.sourceLoadMode, 'cache')
  assert.equal(second.sourceFingerprint, first.sourceFingerprint)
  assertMetricParity(first, second)

  // A changed source set invalidates the fingerprint and forces a reload.
  const extra = makeVectors(1, DIM)[0]
  fs.appendFileSync(
    jsonlPath,
    `${JSON.stringify({ imageId: 'C:\\img\\extra.jpg', modelName: 'm', embeddingType: 'global', dim: DIM, vector: extra })}\n`,
  )
  const third = await evaluateGenerationRecall(jsonlPath, handle, {
    queryCount: 10,
    topK: 5,
    matrixCacheDir,
  })
  assert.equal(third.sourceLoadMode, 'memory')
  assert.notEqual(third.sourceFingerprint, first.sourceFingerprint)
  assert.equal(third.sourceValidCount, first.sourceValidCount + 1)

  // A corrupt cache file is distrusted, never fatal: fall back to recompute.
  const corruptible = fs
    .readdirSync(matrixCacheDir)
    .filter((name) => name.endsWith('.f32'))
    .map((name) => path.join(matrixCacheDir, name))
  for (const file of corruptible) fs.writeFileSync(file, Buffer.alloc(8))
  const fourth = await evaluateGenerationRecall(jsonlPath, handle, {
    queryCount: 10,
    topK: 5,
    matrixCacheDir,
  })
  assert.equal(fourth.sourceLoadMode, 'memory')
  assert.equal(fourth.sourceValidCount, third.sourceValidCount)
})

test('cached spill streams chunks above the ceiling with identical metrics', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  const matrixCacheDir = path.join(dir, 'matrix-cache')
  const options = { queryCount: 10, topK: 5, memoryCeilingBytes: 1, matrixCacheDir }

  const spilled = await evaluateGenerationRecall(jsonlPath, handle, options)
  assert.equal(spilled.sourceLoadMode, 'spill')

  const cached = await evaluateGenerationRecall(jsonlPath, handle, options)
  assert.equal(cached.sourceLoadMode, 'cache')
  assertMetricParity(spilled, cached)
})

test('cooperative cancellation rejects before scoring', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  await assert.rejects(
    evaluateGenerationRecall(jsonlPath, handle, { isCancelled: () => true }),
    (error) => error.name === 'RecallEvaluationCancelledError' && /cancelled/.test(error.message),
  )
})

test('invalid memory ceilings are rejected', async () => {
  const dir = fixtureDir()
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  for (const memoryCeilingBytes of [0, -1, Number.NaN, 512 * 1024 * 1024 + 1]) {
    await assert.rejects(
      evaluateGenerationRecall(jsonlPath, handle, { memoryCeilingBytes }),
      /memoryCeilingBytes must be/,
    )
  }
})
