const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const streamApi = loadTsModule('electron/assetEmbeddingStream.ts')
const MODEL = 'fixture-model'
const DIM = 2

function embeddingRow(imageId, vector, dim = DIM) {
  return JSON.stringify({
    imageId,
    modelName: MODEL,
    modelVersion: 'fixture',
    embeddingType: 'global',
    dim,
    vector,
    norm: 1,
    createdAt: 1,
    updatedAt: 1,
  })
}

async function withTemporaryDirectory(run) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'asset-embedding-stream-'))
  try {
    await run(directory)
  } finally {
    await fsp.rm(directory, { recursive: true, force: true })
  }
}

async function collect(sourcePaths, expectedDim = DIM) {
  const entries = []
  const summary = await streamApi.streamAssetEmbeddingsFromPaths({
    modelName: MODEL,
    expectedDim,
    sourcePaths,
    onEntry: (entry) => entries.push(entry),
  })
  return { entries, summary }
}

test('newer shard vector wins over a legacy revision', async () => {
  await withTemporaryDirectory(async (directory) => {
    const legacy = path.join(directory, 'legacy.jsonl')
    const shard = path.join(directory, 'current.jsonl')
    fs.writeFileSync(legacy, `${embeddingRow('C:\\Images\\a.jpg', [1, 0])}\n`)
    fs.writeFileSync(shard, `${embeddingRow('C:/Images/a.jpg', [0, 1])}\n`)

    const { entries, summary } = await collect([legacy, shard])
    assert.equal(summary.scanned, 1)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].imageId, 'C:/Images/a.jpg')
    assert.deepEqual(Array.from(entries[0].vector), [0, 1])
  })
})

test('invalid newer shard vector tombstones a valid legacy revision', async () => {
  await withTemporaryDirectory(async (directory) => {
    const legacy = path.join(directory, 'legacy.jsonl')
    const shard = path.join(directory, 'current.jsonl')
    fs.writeFileSync(legacy, `${embeddingRow('C:\\Images\\a.jpg', [1, 0])}\n`)
    fs.writeFileSync(shard, `${embeddingRow('c:/images/a.jpg', [1, null])}\n`)

    const { entries, summary } = await collect([legacy, shard])
    assert.equal(summary.scanned, 0)
    assert.deepEqual(entries, [])
  })
})

test('wrong declared dimension tombstones a valid legacy revision', async () => {
  await withTemporaryDirectory(async (directory) => {
    const legacy = path.join(directory, 'legacy.jsonl')
    const shard = path.join(directory, 'current.jsonl')
    fs.writeFileSync(legacy, `${embeddingRow('C:\\Images\\a.jpg', [1, 0])}\n`)
    fs.writeFileSync(shard, `${embeddingRow('c:/images/a.jpg', [0, 1], 3)}\n`)

    const { entries } = await collect([legacy, shard])
    assert.deepEqual(entries, [])
  })
})

test('invalid latest row in one shard tombstones its earlier valid row', async () => {
  await withTemporaryDirectory(async (directory) => {
    const shard = path.join(directory, 'current.jsonl')
    fs.writeFileSync(
      shard,
      `${embeddingRow('C:\\Images\\a.jpg', [1, 0])}\n${embeddingRow('C:\\Images\\a.jpg', [0, 0])}\n`,
    )

    const { entries } = await collect([shard])
    assert.deepEqual(entries, [])
  })
})

test('case and slash equivalent paths share one latest-revision key', async () => {
  await withTemporaryDirectory(async (directory) => {
    const shard = path.join(directory, 'current.jsonl')
    fs.writeFileSync(
      shard,
      `${embeddingRow('C:\\Images\\a.jpg', [1, 0])}\n${embeddingRow('c:/images/a.jpg', [0, 1])}\n`,
    )

    const { entries } = await collect([shard])
    assert.equal(entries.length, 1)
    assert.equal(streamApi.embeddingPathKey(entries[0].imageId), 'c:\\images\\a.jpg')
    assert.deepEqual(Array.from(entries[0].vector), [0, 1])
  })
})

test('stream rejects coercible values but stably normalizes extreme finite vectors', async () => {
  await withTemporaryDirectory(async (directory) => {
    const shard = path.join(directory, 'current.jsonl')
    fs.writeFileSync(
      shard,
      [
        embeddingRow('C:\\Images\\string.jpg', [1, '0']),
        embeddingRow('C:\\Images\\null.jpg', [1, null]),
        embeddingRow('C:\\Images\\zero.jpg', [0, 0]),
        embeddingRow('C:\\Images\\huge.jpg', [1e308, 1e308]),
      ].join('\n') + '\n',
    )

    const { entries } = await collect([shard])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].imageId, 'C:\\Images\\huge.jpg')
    assert.equal(entries[0].vector.every(Number.isFinite), true)
    assert.ok(Math.abs(Math.hypot(...entries[0].vector) - 1) < 1e-6)
  })
})

test('public vector and cosine helpers fail closed on invalid query boundaries', () => {
  const validEntry = { dim: DIM, vector: [1e308, 1e308] }
  const normalized = streamApi.normalizedVector(validEntry, DIM)
  assert.equal(normalized.every(Number.isFinite), true)
  assert.ok(Math.abs(Math.hypot(...normalized) - 1) < 1e-6)

  assert.throws(() => streamApi.normalizedVector({ dim: 3, vector: [1, 0] }, DIM), /dimension/)
  assert.throws(() => streamApi.normalizedVector({ dim: DIM, vector: [1, null] }, DIM), /finite/)
  assert.throws(() => streamApi.normalizedVector({ dim: DIM, vector: [0, 0] }, DIM), /zero norm/)
  assert.throws(
    () => streamApi.shiftedCosine(Float32Array.of(1, 0), Float32Array.of(1)),
    /dimension mismatch/,
  )
  assert.throws(
    () => streamApi.shiftedCosine(Float32Array.of(1, 0), Float32Array.of(Infinity, 0)),
    /finite/,
  )
  assert.throws(
    () => streamApi.shiftedCosine(Float32Array.of(1, 0), Float32Array.of(0, 0)),
    /zero norm/,
  )
  assert.ok(
    Math.abs(
      streamApi.shiftedCosine(Float32Array.of(3e38, 3e38), Float32Array.of(3e38, 3e38)) - 1,
    ) < 1e-6,
  )
})
