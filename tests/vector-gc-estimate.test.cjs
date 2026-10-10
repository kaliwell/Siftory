const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { readVectorGcEstimate, writeVectorGcEstimate } = loadTsModule('electron/vectorGcEstimate.ts')

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-gc-estimate-'))
}

function writeShard(root, name, bytes) {
  const target = path.join(root, 'vector-db', 'embeddings', name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.alloc(bytes, 1))
  return target
}

test('write then read round-trips reclaimable bytes for unchanged shards', async () => {
  const root = fixture()
  const shard = writeShard(root, 'dino__global.jsonl', 100)
  await writeVectorGcEstimate(root, [
    { shardPath: shard, reclaimableBytes: 40, predictedBytes: 60 },
  ])
  const estimate = await readVectorGcEstimate(root)
  assert.equal(estimate.reclaimableBytes, 40)
  assert.equal(estimate.matchedShards, 1)
  assert.equal(estimate.totalShards, 1)
  assert.equal(typeof estimate.estimatedAt, 'number')
})

test('any shard modification invalidates the persisted fingerprint', async () => {
  const root = fixture()
  const shard = writeShard(root, 'dino__global.jsonl', 100)
  await writeVectorGcEstimate(root, [
    { shardPath: shard, reclaimableBytes: 40, predictedBytes: 60 },
  ])
  writeShard(root, 'dino__global.jsonl', 101)
  const estimate = await readVectorGcEstimate(root)
  assert.equal(estimate.reclaimableBytes, 0)
  assert.equal(estimate.matchedShards, 0)
  assert.equal(estimate.totalShards, 1)
})

test('missing shards and unstat-able inputs are excluded instead of failing', async () => {
  const root = fixture()
  const shard = writeShard(root, 'dino__global.jsonl', 100)
  await writeVectorGcEstimate(root, [
    { shardPath: shard, reclaimableBytes: 40, predictedBytes: 60 },
    {
      shardPath: path.join(root, 'vector-db', 'embeddings', 'gone__global.jsonl'),
      reclaimableBytes: 5,
      predictedBytes: 5,
    },
  ])
  const estimate = await readVectorGcEstimate(root)
  assert.equal(estimate.totalShards, 1)
  assert.equal(estimate.reclaimableBytes, 40)
})

test('malformed, oversized and wrong-schema estimate files read as empty', async () => {
  const root = fixture()
  writeShard(root, 'dino__global.jsonl', 100)
  const estimatePath = path.join(root, 'vector-db', 'vector-gc-estimate.json')

  fs.writeFileSync(estimatePath, 'not json {')
  assert.deepEqual(await readVectorGcEstimate(root), {
    reclaimableBytes: 0,
    matchedShards: 0,
    totalShards: 0,
  })

  fs.writeFileSync(estimatePath, JSON.stringify({ schemaVersion: 2, shards: [] }))
  assert.equal((await readVectorGcEstimate(root)).reclaimableBytes, 0)

  fs.writeFileSync(estimatePath, `{${' '.repeat(300 * 1024)}`)
  assert.equal((await readVectorGcEstimate(root)).reclaimableBytes, 0)

  // Entries with path separators or non-jsonl names are rejected.
  const shard = path.join(root, 'vector-db', 'embeddings', 'dino__global.jsonl')
  const stat = fs.statSync(shard)
  fs.writeFileSync(
    estimatePath,
    JSON.stringify({
      schemaVersion: 1,
      createdAt: Date.now(),
      shards: [
        {
          name: '../escape.jsonl',
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          reclaimableBytes: 9,
        },
        { name: 'notes.txt', sizeBytes: stat.size, mtimeMs: stat.mtimeMs, reclaimableBytes: 9 },
      ],
    }),
  )
  const estimate = await readVectorGcEstimate(root)
  assert.equal(estimate.totalShards, 0)
  assert.equal(estimate.reclaimableBytes, 0)
})

test('write failures never throw (missing estimate only hides the hint)', async () => {
  const root = path.join(os.tmpdir(), `floating-clock-gc-estimate-missing-${process.pid}`)
  await writeVectorGcEstimate(root, [
    { shardPath: path.join(root, 'nope.jsonl'), reclaimableBytes: 1, predictedBytes: 1 },
  ])
  assert.equal(fs.existsSync(root), false)
})
