const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { migrateStaleEmbeddingJobs } = loadTsModule('electron/embeddingJobsMigration.ts')

const NOW = Date.parse('2026-08-04T00:00:00.000Z')

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-jobs-migration-'))
}

function job(imageId, overrides) {
  return {
    imageId,
    path: imageId,
    status: 'pending',
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    retries: 0,
    createdAt: NOW - 40 * 24 * 60 * 60 * 1000,
    ...overrides,
  }
}

function writeLines(filePath, lines) {
  fs.writeFileSync(filePath, lines.map((line) => line + '\n').join(''))
  return filePath
}

function shardRow(imageId) {
  return JSON.stringify({
    imageId,
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim: 2,
    vector: [1, 0],
  })
}

function setup(dir) {
  const jobsPath = writeLines(path.join(dir, 'embedding_jobs.jsonl'), [
    JSON.stringify(job('C:\\images\\embedded.jpg')),
    JSON.stringify(job('C:\\images\\backlog.jpg')),
    JSON.stringify(job('C:\\images\\done.jpg', { status: 'completed', finishedAt: NOW })),
    JSON.stringify(
      job('C:\\images\\owned.jpg', { owner: 'build-7', heartbeatAt: NOW - 60 * 1000 }),
    ),
    'not json {',
  ])
  const shardPath = writeLines(path.join(dir, 'dino__global.jsonl'), [
    shardRow('C:\\images\\embedded.jpg'),
    shardRow('C:\\images\\owned.jpg'),
  ])
  return { jobsPath, shardPath }
}

test('dry run partitions rows without touching the jobs file', async () => {
  const dir = fixture()
  const { jobsPath, shardPath } = setup(dir)
  const before = fs.readFileSync(jobsPath, 'utf8')
  const result = await migrateStaleEmbeddingJobs(jobsPath, [shardPath], {
    now: NOW,
    dryRun: true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.originalRows, 5)
  assert.equal(result.archivedRows, 1) // embedded.jpg
  assert.equal(result.keptRows, 4) // backlog + completed + owned + malformed
  assert.equal(result.malformedKept, 1)
  assert.equal(fs.readFileSync(jobsPath, 'utf8'), before)
  assert.equal(result.archivePath, undefined)
  assert.equal(result.backupPath, undefined)
})

test('migration archives embedded rows, keeps the rest and preserves a backup', async () => {
  const dir = fixture()
  const { jobsPath, shardPath } = setup(dir)
  const result = await migrateStaleEmbeddingJobs(jobsPath, [shardPath], { now: NOW })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.archivedRows, 1)
  assert.equal(result.keptRows, 4)

  const kept = fs.readFileSync(jobsPath, 'utf8')
  assert.match(kept, /backlog\.jpg/)
  assert.match(kept, /done\.jpg/)
  assert.match(kept, /owned\.jpg/)
  assert.match(kept, /not json \{/)
  assert.doesNotMatch(kept, /embedded\.jpg/)

  const archive = fs.readFileSync(result.archivePath, 'utf8')
  assert.match(archive, /embedded\.jpg/)
  assert.doesNotMatch(archive, /backlog\.jpg/)

  const backup = fs.readFileSync(result.backupPath, 'utf8')
  assert.match(backup, /embedded\.jpg/)
  assert.equal(backup.split('\n').filter(Boolean).length, 5)
})

test('migration refuses to run without shard evidence or a jobs file', async () => {
  const dir = fixture()
  const { jobsPath, shardPath } = setup(dir)
  const noShards = await migrateStaleEmbeddingJobs(jobsPath, [], { now: NOW })
  assert.equal(noShards.ok, false)
  assert.match(noShards.error, /No authoritative shards/)

  const missing = await migrateStaleEmbeddingJobs(path.join(dir, 'gone.jsonl'), [shardPath], {
    now: NOW,
  })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /unavailable/)
  assert.equal(fs.existsSync(jobsPath), true)
})

test('unreadable shard aborts before any write', async () => {
  const dir = fixture()
  const { jobsPath } = setup(dir)
  const before = fs.readFileSync(jobsPath, 'utf8')
  const result = await migrateStaleEmbeddingJobs(
    jobsPath,
    [path.join(dir, 'missing__global.jsonl')],
    { now: NOW },
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /Cannot read authoritative shard/)
  assert.equal(fs.readFileSync(jobsPath, 'utf8'), before)
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes('migration')),
    [],
  )
})

test('rows whose shard key differs stay in the backlog', async () => {
  const dir = fixture()
  const jobsPath = writeLines(path.join(dir, 'embedding_jobs.jsonl'), [
    JSON.stringify(job('C:\\images\\embedded.jpg', { modelName: 'clip_vit_base_patch32' })),
  ])
  const shardPath = writeLines(path.join(dir, 'dino__global.jsonl'), [
    shardRow('C:\\images\\embedded.jpg'), // different modelName → no match
  ])
  const result = await migrateStaleEmbeddingJobs(jobsPath, [shardPath], { now: NOW })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.archivedRows, 0)
  assert.equal(result.keptRows, 1)
  assert.match(fs.readFileSync(jobsPath, 'utf8'), /embedded\.jpg/)
})

test('migration keeps fresh epoch work and archives only an expired embedded lease', async () => {
  const dir = fixture()
  const freshId = 'C:\\images\\fresh-epoch.jpg'
  const expiredId = 'C:\\images\\expired-epoch.jpg'
  const jobsPath = writeLines(path.join(dir, 'embedding_jobs.jsonl'), [
    JSON.stringify(
      job(freshId, {
        epoch: 12,
        owner: 'run-fresh',
        heartbeatAt: NOW - 1_000,
        updatedAt: NOW - 1_000,
      }),
    ),
    JSON.stringify(
      job(expiredId, {
        status: 'running',
        epoch: 11,
        owner: 'run-crashed',
        heartbeatAt: NOW - 10 * 24 * 60 * 60 * 1000,
        updatedAt: NOW - 10 * 24 * 60 * 60 * 1000,
      }),
    ),
  ])
  const shardPath = writeLines(path.join(dir, 'dino__global.jsonl'), [
    shardRow(freshId),
    shardRow(expiredId),
  ])

  const result = await migrateStaleEmbeddingJobs(jobsPath, [shardPath], {
    now: NOW,
    dryRun: true,
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.keptRows, 1)
  assert.equal(result.archivedRows, 1)
})

test('migration keeps a newly-created unowned pending job even when its vector already exists', async () => {
  const dir = fixture()
  const imageId = 'C:\\images\\fresh-pending.jpg'
  const jobsPath = writeLines(path.join(dir, 'embedding_jobs.jsonl'), [
    JSON.stringify(job(imageId, { createdAt: NOW - 60_000, epoch: 13 })),
  ])
  const shardPath = writeLines(path.join(dir, 'dino__global.jsonl'), [shardRow(imageId)])
  const result = await migrateStaleEmbeddingJobs(jobsPath, [shardPath], {
    now: NOW,
    dryRun: true,
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.keptRows, 1)
  assert.equal(result.archivedRows, 0)
})
