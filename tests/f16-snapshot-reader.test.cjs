const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { F16SnapshotReader, scoreF16SnapshotCandidates } = loadTsModule(
  'electron/f16SnapshotReader.ts',
)
const { float32ToFloat16 } = loadTsModule('electron/embeddingF16Cache.ts')
const { scoreVectorAnnCandidates } = loadTsModule('electron/vectorAnnIndex.ts')

function vectorBuffer(rows) {
  const result = Buffer.alloc(rows.length * rows[0].length * 2)
  rows.forEach((row, rowIndex) =>
    row.forEach((value, dim) =>
      result.writeUInt16LE(float32ToFloat16(value), (rowIndex * row.length + dim) * 2),
    ),
  )
  return result
}

function handle(root, rows, baseCount = rows.length) {
  const base = path.join(root, 'base.f16')
  const delta = path.join(root, 'delta.f16')
  fs.writeFileSync(base, vectorBuffer(rows.slice(0, baseCount)))
  if (baseCount < rows.length) fs.writeFileSync(delta, vectorBuffer(rows.slice(baseCount)))
  return {
    meta: { dim: rows[0].length, count: rows.length },
    vectorPath: base,
    pathIndexPath: path.join(root, 'unused.paths'),
    ...(baseCount < rows.length
      ? { delta: { vectorPath: delta, pathIndexPath: 'unused', baseCount } }
      : {}),
  }
}

test('paged base+delta scoring matches resident Float16 scoring with bounded ownership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f16-reader-'))
  try {
    const rows = Array.from({ length: 4000 }, (_, row) => {
      const angle = row / 100
      return [Math.cos(angle), Math.sin(angle), 0, 0]
    })
    const cache = handle(root, rows, 2500)
    const reader = new F16SnapshotReader(cache, 4096)
    const candidates = Uint32Array.from([0, 1, 128, 2499, 2500, 3000, 3999])
    const query = [1, 0, 0, 0]
    const expected = scoreVectorAnnCandidates(vectorBuffer(rows), 4, candidates, query, 4)
    const actual = scoreF16SnapshotCandidates(reader, candidates, query, 4)
    assert.deepEqual(actual, expected)
    assert.ok(reader.stats().ownedBytes <= 4096)
    assert.ok(reader.stats().bytesRead < vectorBuffer(rows).byteLength)
    reader.close()
    assert.equal(reader.stats().ownedBytes, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('snapshot reader fails closed on mutation, duplicate rows, and out-of-range rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f16-reader-'))
  try {
    const cache = handle(root, [
      [1, 0],
      [0, 1],
    ])
    const reader = new F16SnapshotReader(cache)
    assert.throws(
      () => scoreF16SnapshotCandidates(reader, Uint32Array.from([1, 1]), [1, 0], 1),
      /unique and sorted/,
    )
    assert.throws(() => reader.readPageForRow(2), /outside/)
    fs.appendFileSync(cache.vectorPath, Buffer.from([0, 0]))
    assert.throws(() => reader.readPageForRow(0), /changed/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('lookup and scalar paged ranking match across page and delta boundaries, ties and cancellation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f16-reader-parity-'))
  const previous = process.env.SIFTORY_F16_RERANK_SCALAR
  let reader
  try {
    const rows = Array.from({ length: 1200 }, (_, row) => {
      const angle = row % 7 === 0 ? 0 : row / 13
      return [Math.cos(angle), Math.sin(angle), 0, 0, 0]
    })
    reader = new F16SnapshotReader(handle(root, rows, 713), 250)
    const candidates = Uint32Array.from({ length: rows.length }, (_, row) => row)
    for (const topK of [1, 17, 1200]) {
      process.env.SIFTORY_F16_RERANK_SCALAR = '1'
      const reference = scoreF16SnapshotCandidates(reader, candidates, [1, 0, 0, 0, 0], topK)
      delete process.env.SIFTORY_F16_RERANK_SCALAR
      assert.deepEqual(
        scoreF16SnapshotCandidates(reader, candidates, [1, 0, 0, 0, 0], topK),
        reference,
      )
    }
    let checks = 0
    assert.throws(
      () =>
        scoreF16SnapshotCandidates(reader, candidates, [1, 0, 0, 0, 0], 10, () => ++checks === 2),
      /cancelled/,
    )
    assert.equal(checks, 2, 'cancellation remains cooperative during a long search')
    assert.ok(reader.stats().ownedBytes <= 250)
  } finally {
    reader?.close()
    if (previous === undefined) delete process.env.SIFTORY_F16_RERANK_SCALAR
    else process.env.SIFTORY_F16_RERANK_SCALAR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
