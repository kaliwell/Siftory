const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

// VAL-032: the recall observation gate runs inside the low-priority recall
// worker. These tests pin the host contract — result parity with the
// in-process gate, progress forwarding, cooperative cancellation — against
// the compiled worker bundle (built by test:vector-ann's build:renderer, or
// rebuilt from source here when stale/missing).

const { ensureRecallWorkerBundle } = require('../scripts/verify-vector-generation-recall.cjs')
const recall = loadTsModule('electron/vectorGenerationRecall.ts')
const host = loadTsModule('electron/vectorGenerationRecallWorkerHost.ts')
const { float32ToFloat16 } = loadTsModule('electron/embeddingF16Cache.ts')

const DIM = 4
const COUNT = 60

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

function writeFixture(dir, vectors) {
  const jsonlPath = path.join(dir, 'shard.jsonl')
  fs.writeFileSync(
    jsonlPath,
    vectors
      .map(
        (vector, row) =>
          `${JSON.stringify({ imageId: `C:\\img\\${row}.jpg`, modelName: 'm', embeddingType: 'global', dim: DIM, vector })}\n`,
      )
      .join(''),
  )
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
      .map((_, row) => `${JSON.stringify({ row, path: `C:\\img\\${row}.jpg`, offset: row * DIM * 2 })}\n`)
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

test('worker evaluation matches the in-process gate and forwards progress', async (t) => {
  t.after(() => host.disposeVectorGenerationRecallWorker())
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-recall-worker-'))
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  const workerPath = ensureRecallWorkerBundle()
  const matrixCacheDir = path.join(dir, 'matrix-cache')

  const expected = await recall.evaluateGenerationRecall(jsonlPath, handle, {
    queryCount: 10,
    topK: 5,
  })
  const phases = new Set()
  const report = await host.evaluateGenerationRecallInWorker(
    [jsonlPath],
    handle,
    { queryCount: 10, topK: 5, memoryCeilingBytes: 1, matrixCacheDir },
    {
      workerPath,
      onProgress: (info) => phases.add(info.phase),
    },
  )
  for (const field of Object.keys(expected)) {
    if (field === 'elapsedMs' || field === 'sourceLoadMode' || field === 'memoryCeilingBytes') {
      continue
    }
    assert.deepStrictEqual(report[field], expected[field], `report field ${field} must match`)
  }
  assert.equal(report.sourceLoadMode, 'spill')
  assert.ok(phases.has('queries'), 'query progress must reach the host')
})

test('worker evaluation honours cooperative cancellation', async (t) => {
  t.after(() => host.disposeVectorGenerationRecallWorker())
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-recall-worker-'))
  const vectors = makeVectors(COUNT, DIM)
  const { jsonlPath, handle } = writeFixture(dir, vectors)
  const workerPath = ensureRecallWorkerBundle()
  await assert.rejects(
    host.evaluateGenerationRecallInWorker([jsonlPath], handle, { queryCount: 10, topK: 5 }, {
      workerPath,
      isCancelled: () => true,
    }),
    /cancelled/,
  )
})
