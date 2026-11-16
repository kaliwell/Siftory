const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')
const { scanPreparedVectors } = loadTsModule('electron/preparationVectorWorker.ts')
const row = (imageId, vector) =>
  JSON.stringify({
    imageId,
    vector,
    dim: vector.length,
    modelName: 'test',
    embeddingType: 'global',
  }) + '\n'
async function fixture(t, text) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prepared-snapshot-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'vectors.jsonl')
  await fs.writeFile(file, text)
  const capture = async () => {
    const s = await fs.stat(file)
    return { path: file, size: s.size, ino: s.ino, dev: s.dev }
  }
  const input = async () => ({
    sources: [await capture()],
    model: 'test',
    dim: 2,
    query: [1, 0],
    topK: 10,
  })
  return { file, input }
}
test('a query sees complete rows at its pinned boundary; later queries see appended rows', async (t) => {
  const f = await fixture(t, row('a', [1, 0]))
  const first = await f.input()
  await fs.appendFile(f.file, row('b', [1, 1]))
  assert.deepEqual(
    (await scanPreparedVectors(first)).candidates.map((c) => c.path),
    ['a'],
  )
  assert.equal((await scanPreparedVectors(await f.input())).scanned, 2)
})
test('partial tail is excluded; completing it makes the next query see it exactly once', async (t) => {
  const b = row('b', [1, 0])
  const f = await fixture(t, row('a', [0, 1]) + b.slice(0, -3))
  assert.equal((await scanPreparedVectors(await f.input())).scanned, 1)
  await fs.appendFile(f.file, b.slice(-3))
  assert.equal((await scanPreparedVectors(await f.input())).scanned, 2)
})
test('latest revision wins, invalid latest rows suppress old vectors and scopes are enforced', async (t) => {
  const f = await fixture(
    t,
    row('a', [1, 0]) +
      row('a', [0, 1]) +
      row('bad', [1, 0]) +
      row('bad', [0, 0]) +
      row('b', [1, 0]),
  )
  const input = await f.input()
  const result = await scanPreparedVectors(input)
  assert.equal(result.scanned, 2)
  assert.equal(result.candidates.find((c) => c.path === 'a').score, 0.5)
  assert.equal(
    result.candidates.some((c) => c.path === 'bad'),
    false,
  )
  assert.deepEqual(
    (await scanPreparedVectors({ ...input, scope: ['b'] })).candidates.map((c) => c.path),
    ['b'],
  )
  assert.equal((await scanPreparedVectors({ ...input, scope: [] })).scanned, 0)
})
test('cancellation and changed source identity fail closed', async (t) => {
  const f = await fixture(t, row('a', [1, 0]))
  const input = await f.input()
  const stop = new SharedArrayBuffer(4)
  new Int32Array(stop)[0] = 1
  await assert.rejects(scanPreparedVectors({ ...input, stop }), /cancelled/)
  await fs.writeFile(f.file, '')
  await assert.rejects(scanPreparedVectors(input), /source changed/)
})

test('preparation mode spans model-stage gaps and releases exactly once', () => {
  const mode = loadTsModule('electron/preparationSearchState.ts')
  const release = mode.beginSearchablePreparation()
  mode.setVectorPreparationActive(true)
  mode.setVectorPreparationActive(false)
  assert.equal(mode.isVectorPreparationActive(), true)
  const revision = mode.getPreparationSearchRevision()
  mode.invalidatePreparedSearches()
  assert.equal(mode.getPreparationSearchRevision(), revision + 1)
  release()
  release()
  assert.equal(mode.isVectorPreparationActive(), true)
  mode.markPreparedSearchCommitted()
  assert.equal(mode.isVectorPreparationActive(), false)
})

test('snapshot scores retain the normal search cosine-to-score scale', async (t) => {
  const f = await fixture(
    t,
    row('same', [1, 0]) + row('orthogonal', [0, 1]) + row('opposite', [-1, 0]),
  )
  const found = await scanPreparedVectors(await f.input())
  assert.deepEqual(
    found.candidates.map((c) => [c.path, c.score]),
    [
      ['same', 1],
      ['orthogonal', 0.5],
      ['opposite', 0],
    ],
  )
})

test('an invalidation fences queries for its entire persistence window', () => {
  const mode = loadTsModule('electron/preparationSearchState.ts')
  const before = mode.getPreparationSearchRevision()
  const release = mode.beginPreparedSearchMutation()
  assert.equal(mode.isPreparedSearchMutationActive(), true)
  assert.equal(mode.getPreparationSearchRevision(), before + 1)
  release()
  release()
  assert.equal(mode.isPreparedSearchMutationActive(), false)
  assert.equal(mode.getPreparationSearchRevision(), before + 2)
})

test('new-only scan commits do not invalidate concurrent readers', async () => {
  const mode = loadTsModule('electron/preparationSearchState.ts')
  const before = mode.getPreparationSearchRevision()
  await mode.invalidatePreparedInputs(
    () => 0,
    async () => {
      assert.equal(mode.isPreparedSearchMutationActive(), false)
      assert.equal(mode.getPreparationSearchRevision(), before)
    },
  )
  assert.equal(mode.getPreparationSearchRevision(), before)
})
test('replacement holds the fence until persistence settles, including failure', async () => {
  const mode = loadTsModule('electron/preparationSearchState.ts')
  const before = mode.getPreparationSearchRevision()
  await assert.rejects(
    mode.invalidatePreparedInputs(
      () => 1,
      async () => {
        assert.equal(mode.isPreparedSearchMutationActive(), true)
        throw Error('write failure')
      },
    ),
    /write failure/,
  )
  assert.equal(mode.isPreparedSearchMutationActive(), false)
  assert.equal(mode.getPreparationSearchRevision(), before + 2)
})

test('mixed slash spellings share a latest vector identity', async (t) => {
  const f = await fixture(
    t,
    row(
      'C:' + String.fromCharCode(92) + 'Pictures' + String.fromCharCode(92) + 'same.JPG',
      [1, 0],
    ) + row('c:/pictures/same.jpg', [0, 1]),
  )
  const found = await scanPreparedVectors(await f.input())
  assert.equal(found.scanned, 1)
  assert.equal(found.candidates[0].score, 0.5)
})
