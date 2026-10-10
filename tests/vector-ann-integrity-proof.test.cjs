// VAL-038: the ANN worker re-verifies the committed content proofs carried by
// a minted cache handle before indexing or searching. A bitflip that lands
// after the handle was minted rejects the request (the host then falls back
// to the exact path) instead of silently indexing corrupted vectors.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Worker } = require('node:worker_threads')
const { loadTsModule } = require('./guard-utils.cjs')

const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')
const integrity = loadTsModule('electron/embeddingCacheIntegrity.ts')

const workerPath = path.resolve(__dirname, '..', 'dist-electron', 'vectorAnnWorker.js')

const DIM = 8
const ROWS = 16

function row(imageId, vector) {
  return `${JSON.stringify({ modelName: 'fixture_ann', embeddingType: 'global', imageId, dim: DIM, vector })}\n`
}

function oneHot(index) {
  const vector = new Array(DIM).fill(0)
  vector[index % DIM] = 1
  return vector
}

function makeDerivedCache(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `floating-clock-vai-${label}-`))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source.jsonl')
  let content = ''
  for (let index = 0; index < ROWS; index++) {
    content += row(`C:\\synthetic\\image-${index}.png`, oneHot(index))
  }
  fs.writeFileSync(source, content)
  return cacheApi
    .ensureEmbeddingF16Cache({
      cacheDir: path.join(root, 'cache'),
      modelName: 'fixture_ann',
      embeddingType: 'global',
      dim: DIM,
      sourcePaths: [source],
      preferAuthoritative: false,
    })
    .then((handle) => {
      assert.ok(handle?.integrity, 'minted handle carries content proofs')
      return handle
    })
}

/** Extends a minted derived handle with a synthetic committed delta segment. */
function withDelta(handle, deltaRows) {
  const vectorPath = path.join(path.dirname(handle.vectorPath), 'delta.f16')
  const pathIndexPath = path.join(path.dirname(handle.vectorPath), 'delta.paths.jsonl')
  const vectors = Buffer.alloc(deltaRows * DIM * 2)
  const lines = []
  for (let index = 0; index < deltaRows; index++) {
    const vector = oneHot(handle.meta.count + index)
    for (let dimension = 0; dimension < DIM; dimension++) {
      vectors.writeUInt16LE(
        cacheApi.float32ToFloat16(vector[dimension]),
        (index * DIM + dimension) * 2,
      )
    }
    lines.push(JSON.stringify({ row: handle.meta.count + index, path: `C:\\synthetic\\delta-${index}.png` }))
  }
  fs.writeFileSync(vectorPath, vectors)
  fs.writeFileSync(pathIndexPath, `${lines.join('\n')}\n`, 'utf8')
  return {
    ...handle,
    meta: {
      ...handle.meta,
      count: handle.meta.count + deltaRows,
      sourceRecordCount: handle.meta.sourceRecordCount + deltaRows,
    },
    delta: { vectorPath, pathIndexPath, baseCount: handle.meta.count },
    integrity: {
      ...handle.integrity,
      deltaVectors: integrity.createEmbeddingCacheFileProof(vectorPath),
      deltaPaths: integrity.createEmbeddingCacheFileProof(pathIndexPath),
    },
  }
}

function flipByte(filePath, offset) {
  const fd = fs.openSync(filePath, 'r+')
  try {
    const byte = Buffer.alloc(1)
    fs.readSync(fd, byte, 0, 1, offset)
    byte[0] ^= 0xff
    fs.writeSync(fd, byte, 0, 1, offset)
  } finally {
    fs.closeSync(fd)
  }
  integrity.resetEmbeddingCacheIntegrityMemoForTests()
}

function search(cache) {
  const worker = new Worker(workerPath)
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      worker.off('message', onMessage)
      reject(error)
    }
    const onMessage = (message) => {
      if (message.requestId !== 1 || message.type === 'progress') return
      worker.off('error', onError)
      worker.off('message', onMessage)
      if (message.type === 'result') resolve(message.result)
      else reject(new Error(message.error || message.type))
    }
    worker.once('error', onError)
    worker.on('message', onMessage)
    worker.postMessage({
      type: 'search',
      requestId: 1,
      cache,
      queryVector: [1, ...new Array(DIM - 1).fill(0)],
      topK: 4,
      stopBuffer: new SharedArrayBuffer(4),
    })
  }).finally(() => worker.terminate())
}

test('ANN search succeeds with intact proofs (baseline)', async (t) => {
  const handle = await makeDerivedCache(t, 'baseline')
  const result = await search(handle)
  assert.equal(result.indexedCount, ROWS)
  assert.equal(result.results[0].path, 'C:\\synthetic\\image-0.png')
})

test('derived vector bitflip after mint rejects the ANN request', async (t) => {
  const handle = await makeDerivedCache(t, 'flip-base')
  flipByte(handle.vectorPath, 3)
  await assert.rejects(() => search(handle), /integrity proof mismatch/)
})

test('composite delta bitflip after mint rejects the ANN request', async (t) => {
  const handle = withDelta(await makeDerivedCache(t, 'flip-delta'), 4)
  const baseline = await search({ ...handle, integrity: handle.integrity })
  assert.equal(baseline.indexedCount, ROWS + 4)
  flipByte(handle.delta.vectorPath, 1)
  await assert.rejects(() => search(handle), /integrity proof mismatch/)
})

test('missing delta proofs on a composite handle reject the ANN request', async (t) => {
  const handle = withDelta(await makeDerivedCache(t, 'unproven-delta'), 2)
  const unproven = {
    ...handle,
    integrity: {
      vectors: handle.integrity.vectors,
      paths: handle.integrity.paths,
    },
  }
  await assert.rejects(() => search(unproven), /integrity proof mismatch/)
})
