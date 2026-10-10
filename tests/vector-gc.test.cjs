const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { compactVectorGcShard, previewVectorGcShard } = loadTsModule('electron/vectorGcService.ts')
const { serializeEmbeddingShardMutation } = loadTsModule('electron/vectorDatabaseService.ts')

function row(imageId, vector, extra = {}) {
  return JSON.stringify({
    imageId,
    modelName: 'fixture_dinov2',
    embeddingType: 'global',
    dim: vector.length,
    vector,
    ...extra,
  })
}

function fixture(lines) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-vector-gc-'))
  const shard = path.join(directory, 'dino.jsonl')
  fs.writeFileSync(shard, `${lines.join('\n')}\n`)
  return { directory, shard }
}

test('GC preview reports active, stale, duplicate, malformed, and predicted bytes', async () => {
  const { shard } = fixture([
    row('C:\\active-a.jpg', [1, 0]),
    row('C:\\stale.jpg', [0, 1]),
    '{bad',
    row('C:\\active-a.jpg', [0.9, 0.1], { updatedAt: 2 }),
    row('C:\\active-b.jpg', [0.8, 0.2]),
  ])
  const preview = await previewVectorGcShard(shard, ['c:\\ACTIVE-A.jpg', 'C:\\active-b.jpg'])
  assert.equal(preview.totalRecords, 5)
  assert.equal(preview.activeRecords, 2)
  assert.equal(preview.staleRecords, 1)
  assert.equal(preview.duplicateRecords, 1)
  assert.equal(preview.malformedRecords, 1)
  assert.ok(preview.predictedBytes < preview.sourceBytes)
  assert.equal(preview.reclaimableBytes, preview.sourceBytes - preview.predictedBytes)
})

test('GC atomically keeps latest active rows and retains the old shard as a backup', async () => {
  const { shard } = fixture([
    row('C:\\active-a.jpg', [1, 0]),
    row('C:\\stale.jpg', [0, 1]),
    row('C:\\active-a.jpg', [0.9, 0.1], { updatedAt: 2 }),
    row('C:\\active-b.jpg', [0.8, 0.2]),
  ])
  const result = await compactVectorGcShard(shard, ['C:\\active-a.jpg', 'C:\\active-b.jpg'])
  const compacted = fs
    .readFileSync(shard, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    compacted.map((item) => item.imageId),
    ['C:\\active-a.jpg', 'C:\\active-b.jpg'],
  )
  assert.deepEqual(compacted[0].vector, [0.9, 0.1])
  assert.equal(fs.existsSync(result.backupPath), true)
  assert.equal(fs.readFileSync(result.backupPath, 'utf8').includes('stale.jpg'), true)
  assert.equal(result.actualBytes, fs.statSync(shard).size)
})

test('GC ignores hostile invalid schema leaders and preserves following valid rows', async (t) => {
  const { directory, shard } = fixture([
    row('C:\\hostile.jpg', [0, 0], { dim: 2 }),
    row('C:\\active-a.jpg', [1, 0]),
    row('C:\\active-b.jpg', [0, 1]),
  ])
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const preview = await previewVectorGcShard(shard, [
    'C:\\hostile.jpg',
    'C:\\active-a.jpg',
    'C:\\active-b.jpg',
  ])
  assert.equal(preview.dim, 2)
  assert.equal(preview.activeRecords, 2)
  assert.equal(preview.malformedRecords, 1)

  await compactVectorGcShard(shard, ['C:\\active-a.jpg', 'C:\\active-b.jpg'])
  const compacted = fs.readFileSync(shard, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
  assert.deepEqual(
    compacted.map((item) => item.imageId),
    ['C:\\active-a.jpg', 'C:\\active-b.jpg'],
  )
})

test('GC treats latest zero, non-finite, and wrong-dimension revisions as tombstones', async (t) => {
  const invalidRevisions = [
    { vector: [0, 0], extra: {} },
    { vector: [1, null], extra: {} },
    { vector: [1, 0, 0], extra: { dim: 3 } },
    { vector: [1, 0], extra: { dim: undefined } },
    { vector: [1, 0], extra: { dim: 0 } },
    { vector: [1, 0], extra: { dim: 1.5 } },
    { vector: [1, 0], extra: { dim: 16_385 } },
  ]
  for (const [index, invalid] of invalidRevisions.entries()) {
    const { directory, shard } = fixture([
      row('C:\\active-a.jpg', [1, 0]),
      row('C:\\active-b.jpg', [0, 1]),
      row('c:/ACTIVE-A.jpg', invalid.vector, invalid.extra),
    ])
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const preview = await previewVectorGcShard(shard, ['C:\\active-a.jpg', 'C:\\active-b.jpg'])
    assert.equal(preview.activeRecords, 1, `invalid revision ${index}`)
    assert.equal(preview.duplicateRecords, 1)
    assert.equal(preview.malformedRecords, 1)

    await compactVectorGcShard(shard, ['C:\\active-a.jpg', 'C:\\active-b.jpg'])
    const compacted = fs.readFileSync(shard, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    assert.deepEqual(
      compacted.map((item) => item.imageId),
      ['C:\\active-b.jpg'],
    )
  }
})

test('cancelled GC leaves the authoritative shard unchanged and no temporary output', async () => {
  const lines = Array.from({ length: 2000 }, (_, index) =>
    row(`C:\\active-${index}.jpg`, [1, index / 2000]),
  )
  const { directory, shard } = fixture(lines)
  const before = fs.readFileSync(shard)
  let checks = 0
  await assert.rejects(
    compactVectorGcShard(
      shard,
      lines.map((_, index) => `C:\\active-${index}.jpg`),
      {
        isCancelled: () => ++checks > 3,
      },
    ),
    /cancelled/i,
  )
  assert.deepEqual(fs.readFileSync(shard), before)
  assert.equal(
    fs.readdirSync(directory).some((name) => name.endsWith('.tmp')),
    false,
  )
})

test('disk-full preflight and switch failure both preserve the authoritative shard', async () => {
  const activePath = 'C:\\active.jpg'
  const first = fixture([row(activePath, [1, 0])])
  const firstBefore = fs.readFileSync(first.shard)
  await assert.rejects(
    compactVectorGcShard(first.shard, [activePath], { availableBytes: 0 }),
    /free space/i,
  )
  assert.deepEqual(fs.readFileSync(first.shard), firstBefore)

  const second = fixture([row(activePath, [1, 0]), row('C:\\stale.jpg', [0, 1])])
  const secondBefore = fs.readFileSync(second.shard)
  let renames = 0
  await assert.rejects(
    compactVectorGcShard(second.shard, [activePath], {
      renameFile: async (from, to) => {
        renames++
        if (renames === 2) throw new Error('simulated switch failure')
        await fs.promises.rename(from, to)
      },
    }),
    /switch failure/i,
  )
  assert.deepEqual(fs.readFileSync(second.shard), secondBefore)
  assert.equal(
    fs.readdirSync(second.directory).some((name) => name.endsWith('.tmp')),
    false,
  )
})

test('GC refuses to switch when the source shard grows during compaction', async (t) => {
  const lines = Array.from({ length: 2_000 }, (_, index) =>
    row(`C:\\active-${index}.jpg`, [1, index / 2_000]),
  )
  const { directory, shard } = fixture(lines)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const appended = `${row('C:\\active-0.jpg', [0, 0])}\n`
  let changed = false

  await assert.rejects(
    compactVectorGcShard(
      shard,
      lines.map((_, index) => `C:\\active-${index}.jpg`),
      {
        onProgress: () => {
          if (changed) return
          changed = true
          fs.appendFileSync(shard, appended)
        },
      },
    ),
    /changed during compaction/,
  )
  assert.equal(changed, true)
  assert.equal(fs.readFileSync(shard, 'utf8').endsWith(appended), true)
  assert.equal(
    fs.readdirSync(directory).some((name) => name.includes('.gc-backup-') || name.endsWith('.tmp')),
    false,
  )
})

test('an append accepted during the GC switch lands in the new shard, not its backup', async (t) => {
  const activePath = 'C:\\active.jpg'
  const { directory, shard } = fixture([row(activePath, [1, 0]), row('C:\\stale.jpg', [0, 1])])
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const appended = `${row(activePath, [0.9, 0.1], { updatedAt: 2 })}\n`
  let appendPromise
  let renames = 0

  const result = await compactVectorGcShard(shard, [activePath], {
    renameFile: async (from, to) => {
      renames += 1
      if (renames === 1) {
        appendPromise = serializeEmbeddingShardMutation(() =>
          fs.promises.appendFile(shard, appended, 'utf8'),
        )
      }
      await fs.promises.rename(from, to)
    },
  })
  await appendPromise

  assert.equal(fs.readFileSync(shard, 'utf8').endsWith(appended), true)
  assert.equal(fs.readFileSync(result.backupPath, 'utf8').endsWith(appended), false)
})
