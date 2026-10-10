const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  persistVectorAnnProjectionSidecar,
  readVectorAnnProjectionSidecar,
  vectorAnnProjectionSidecarPaths,
} = loadTsModule('electron/vectorAnnProjectionSidecar.ts')

test('Q8 projection sidecar commits atomically and verifies source/content identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-q8-'))
  try {
    const files = vectorAnnProjectionSidecarPaths(path.join(root, 'vectors.f16'))
    const dimensions = Uint16Array.from([0, 2])
    const scales = Float32Array.from([0.01, 0.02])
    const first = Buffer.from([1, 2, 3, 4])
    const second = Buffer.from([5, 6])
    persistVectorAnnProjectionSidecar(files, 'generation-a', 3, 4, dimensions, scales, [
      { startRow: 0, rowCount: 2, buffer: first },
      { startRow: 2, rowCount: 1, buffer: second },
    ])
    const loaded = readVectorAnnProjectionSidecar(files, {
      sourceIdentity: 'generation-a',
      count: 3,
      dim: 4,
    })
    assert.deepEqual([...loaded.values], [1, 2, 3, 4, 5, 6])
    assert.deepEqual([...loaded.dimensions], [0, 2])
    assert.equal(readVectorAnnProjectionSidecar(files, { sourceIdentity: 'stale', count: 3, dim: 4 }), null)
    fs.writeFileSync(files.values, Buffer.from([1, 2, 3, 4, 5, 7]))
    assert.equal(readVectorAnnProjectionSidecar(files, { sourceIdentity: 'generation-a', count: 3, dim: 4 }), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Q8 projection sidecar rejects gaps, overlaps, and dimension mismatch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-q8-'))
  try {
    const files = vectorAnnProjectionSidecarPaths(path.join(root, 'vectors.f16'))
    assert.throws(
      () => persistVectorAnnProjectionSidecar(
        files,
        'generation-a',
        1,
        4,
        Uint16Array.from([0, 1]),
        Float32Array.from([1, 1]),
        [{ startRow: 1, rowCount: 1, buffer: Buffer.from([1, 2]) }],
      ),
      /not contiguous/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
