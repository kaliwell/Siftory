const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  countVideoFrameVectors,
  ensureVideoFrameVectorLookup,
  findVideoFrameVector,
  scanVideoFrameVectors,
} = loadTsModule('electron/videoFrameVectorLookup.ts')

const MODEL = 'clip_vit_base_patch32'
const DIM = 512

function vector(seed) {
  const values = Array(DIM).fill(0)
  values[seed % DIM] = 1
  return values
}

test('frame vector SQLite lookup streams bounded rows and preserves latest revision semantics', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-vector-lookup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const indexPath = path.join(root, 'frame_embedding_index.jsonl')
  const lookupPath = path.join(root, 'frame_embedding_index.lookup.sqlite')
  const output = fs.createWriteStream(indexPath, { encoding: 'utf8' })
  for (let index = 0; index < 10_000; index++) {
    output.write(
      `${JSON.stringify({
        imagePath: `C:/frames/${index}.jpg`,
        modelName: MODEL,
        dim: DIM,
        vector: vector(index),
      })}\n`,
    )
  }
  output.write(
    `${JSON.stringify({
      imagePath: 'C:/frames/10.jpg',
      modelName: MODEL,
      dim: DIM - 1,
      vector: vector(10),
    })}\n`,
  )
  output.end()
  await new Promise((resolve) => output.on('close', resolve))

  await ensureVideoFrameVectorLookup(indexPath, lookupPath)
  assert.equal(countVideoFrameVectors(lookupPath, MODEL), 9_999)
  assert.equal(findVideoFrameVector(lookupPath, MODEL, 'c:\\FRAMES\\10.jpg'), undefined)
  assert.equal(findVideoFrameVector(lookupPath, MODEL, 'c:\\FRAMES\\11.jpg').length, DIM)

  let visited = 0
  let largestLiveWindow = 0
  const scanned = await scanVideoFrameVectors(
    lookupPath,
    MODEL,
    (_imagePath, item) => {
      visited++
      largestLiveWindow = Math.max(largestLiveWindow, item.length)
    },
    { yieldEvery: 257 },
  )
  assert.equal(scanned, 9_999)
  assert.equal(visited, 9_999)
  assert.equal(largestLiveWindow, DIM)
})

test('frame vector lookup rebuilds after source append and supports cancellation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-vector-rebuild-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const indexPath = path.join(root, 'index.jsonl')
  const lookupPath = path.join(root, 'index.sqlite')
  fs.writeFileSync(
    indexPath,
    `${JSON.stringify({ imagePath: 'a.jpg', modelName: MODEL, dim: DIM, vector: vector(1) })}\n`,
  )
  await ensureVideoFrameVectorLookup(indexPath, lookupPath)
  assert.equal(countVideoFrameVectors(lookupPath, MODEL), 1)
  fs.appendFileSync(
    indexPath,
    `${JSON.stringify({ imagePath: 'b.jpg', modelName: MODEL, dim: DIM, vector: vector(2) })}\n`,
  )
  await ensureVideoFrameVectorLookup(indexPath, lookupPath)
  assert.equal(countVideoFrameVectors(lookupPath, MODEL), 2)
  let cancelled = false
  await assert.rejects(
    scanVideoFrameVectors(
      lookupPath,
      MODEL,
      () => {
        cancelled = true
      },
      { isCancelled: () => cancelled },
    ),
    /cancelled/,
  )
})
