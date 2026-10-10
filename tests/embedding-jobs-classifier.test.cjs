const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { previewEmbeddingJobs } = loadTsModule('electron/embeddingJobsClassifier.ts')

const NOW = Date.parse('2026-08-03T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-jobs-classifier-'))
}

function job(overrides) {
  return {
    imageId: 'C:\\images\\a.jpg',
    path: 'C:\\images\\a.jpg',
    status: 'pending',
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    retries: 0,
    createdAt: NOW - 40 * DAY,
    ...overrides,
  }
}

function writeJobs(dir, rows) {
  const jobsPath = path.join(dir, 'embedding_jobs.jsonl')
  fs.writeFileSync(jobsPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  return jobsPath
}

test('missing jobs file yields an empty preview', async () => {
  const dir = fixture()
  const preview = await previewEmbeddingJobs(path.join(dir, 'embedding_jobs.jsonl'), { now: NOW })
  assert.equal(preview.totalRows, 0)
  assert.equal(preview.fileBytes, 0)
  assert.equal(preview.staleCandidates.rows, 0)
})

test('classifies terminal, malformed, age-bucketed and duplicate pending rows', async () => {
  const dir = fixture()
  const jobsPath = writeJobs(dir, [
    job({ status: 'completed', finishedAt: NOW }),
    job({ status: 'failed', error: 'boom' }),
    job({ status: 'skipped' }),
    job({ createdAt: NOW - 60 * 60 * 1000, imageId: 'C:\\images\\fresh.jpg' }),
    job({ createdAt: NOW - 3 * DAY, imageId: 'C:\\images\\week.jpg' }),
    job({ createdAt: NOW - 14 * DAY, imageId: 'C:\\images\\month.jpg' }),
    job({ createdAt: NOW - 90 * DAY, imageId: 'C:\\images\\ancient.jpg', status: 'running' }),
    job({ imageId: 'C:\\images\\a.jpg' }), // duplicate of the default key
    job({ imageId: 'C:\\images\\a.jpg' }), // and a third copy
    job({ owner: 'build-7', heartbeatAt: NOW - 60 * 1000, epoch: 7 }),
  ])
  fs.appendFileSync(jobsPath, 'not json {\n')
  const preview = await previewEmbeddingJobs(jobsPath, { now: NOW })
  assert.equal(preview.totalRows, 11)
  assert.deepEqual(preview.terminal, { completed: 1, failed: 1, skipped: 1 })
  assert.equal(preview.malformedRows, 1)
  assert.ok(preview.malformedBytes > 0)
  assert.equal(preview.pending, 6)
  assert.equal(preview.running, 1)
  assert.deepEqual(preview.ageBuckets, { under24h: 1, under7d: 1, under30d: 1, over30d: 4 })
  assert.equal(preview.duplicatePendingRows, 2)
  assert.equal(preview.rowsWithOwnerFields, 1)
  // Stale = older than 7 days without a live owner heartbeat: month, ancient
  // and the two plain 40-day a.jpg rows (4 rows). The owner row shares the
  // a.jpg key but has a fresh heartbeat and is excluded from stale.
  assert.equal(preview.staleCandidates.rows, 4)
  assert.ok(preview.staleCandidates.bytes > 0)
  assert.equal(preview.staleWithEmbedding, null)
})

test('rows with unknown status or missing required fields count as malformed', async () => {
  const dir = fixture()
  const jobsPath = writeJobs(dir, [
    job({ status: 'weird' }),
    { imageId: 'C:\\images\\a.jpg', status: 'pending' }, // no model/embeddingType/createdAt
    job({ imageId: '', status: 'pending' }),
  ])
  const preview = await previewEmbeddingJobs(jobsPath, { now: NOW })
  assert.equal(preview.malformedRows, 3)
  assert.equal(preview.pending, 0)
})

test('oversized rows are counted malformed without unbounded parsing', async () => {
  const dir = fixture()
  const jobsPath = writeJobs(dir, [job()])
  fs.appendFileSync(jobsPath, `{"pad":"${'x'.repeat(2048)}"}\n`)
  const preview = await previewEmbeddingJobs(jobsPath, { now: NOW, maxRowBytes: 1024 })
  assert.equal(preview.malformedRows, 1)
  assert.equal(preview.pending, 1)
})

test('embedding check intersects stale candidates with authoritative shard keys', async () => {
  const dir = fixture()
  const embeddedJob = job({ imageId: 'C:\\images\\embedded.jpg' })
  const jobsPath = writeJobs(dir, [
    embeddedJob,
    job({ imageId: 'C:\\images\\missing.jpg' }),
    job({ imageId: 'C:\\images\\fresh.jpg', createdAt: NOW - 60 * 60 * 1000 }),
  ])
  const shardPath = path.join(dir, 'dinov2_vitb14__global.jsonl')
  fs.writeFileSync(
    shardPath,
    `${JSON.stringify({
      imageId: 'C:\\images\\embedded.jpg',
      modelName: 'dinov2_vitb14',
      embeddingType: 'global',
      dim: 768,
      vector: [0.1, 0.2],
    })}\n`,
  )
  const preview = await previewEmbeddingJobs(jobsPath, { now: NOW, shardPaths: [shardPath] })
  assert.equal(preview.staleCandidates.rows, 2)
  assert.deepEqual(preview.staleWithEmbedding, {
    rows: 1,
    bytes: Buffer.byteLength(`${JSON.stringify(embeddedJob)}\n`, 'utf8'),
  })
})

test('unreadable shard shrinks the confirmed set instead of failing the preview', async () => {
  const dir = fixture()
  const jobsPath = writeJobs(dir, [job()])
  const preview = await previewEmbeddingJobs(jobsPath, {
    now: NOW,
    shardPaths: [path.join(dir, 'does-not-exist__global.jsonl')],
  })
  assert.equal(preview.staleCandidates.rows, 1)
  assert.deepEqual(preview.staleWithEmbedding, { rows: 0, bytes: 0 })
})

test('a recent epoch update keeps an old pending row out of stale candidates', async () => {
  const dir = fixture()
  const jobsPath = writeJobs(dir, [job({ epoch: 12, updatedAt: NOW - 60_000 })])
  const preview = await previewEmbeddingJobs(jobsPath, { now: NOW })
  assert.equal(preview.pending, 1)
  assert.equal(preview.rowsWithOwnerFields, 1)
  assert.equal(preview.staleCandidates.rows, 0)
})
