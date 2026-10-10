const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { buildStorageInventory } = loadTsModule('electron/storageInventory.ts')

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-storage-inventory-'))
}

function write(root, relativePath, bytes, mtime) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.alloc(bytes, 1))
  if (mtime) fs.utimesSync(target, mtime, mtime)
}

test('inventory reports required logical domains without exposing personal paths', async () => {
  const root = fixture()
  write(root, 'image-search-index/segment.bin', 11)
  write(root, 'thumbcache/a.jpg', 12)
  write(root, 'vector-db/embeddings/dino.jsonl', 13)
  write(root, 'vector-db/clip_embedding_cache.f32', 14)
  write(root, 'vector-db/embedding-cache/dino.f16', 15)
  write(root, 'vector-db/embedding-cache/dino.ann-simhash-v1.bin', 16)
  write(root, 'media-search/frames/video/a.jpg', 17)
  write(root, 'media-search/videos.jsonl', 18)
  write(root, 'asset-library-recovery/recovery.json', 19)
  write(root, 'asset-library/metadata_deletion_trash.jsonl', 20)
  write(root, 'vector-db/embedding_failures.jsonl', 21)
  write(root, 'vector-db/embedding_diagnostics.jsonl', 22)
  write(root, 'vector-db/embedding_jobs.jsonl', 23)

  const report = await buildStorageInventory(root, {
    imageSearch: 'active',
    vectors: 'idle',
    mediaSearch: 'active',
    assetLibrary: 'unknown',
  })
  const ids = new Set(report.items.map((item) => item.id))
  for (const expected of [
    'image-search-logs',
    'image-search-index',
    'image-search-thumbnails',
    'vector-jsonl',
    'vector-gc-backups',
    'vector-caches',
    'vector-ann',
    'media-frames',
    'media-vectors',
    'asset-backups',
    'asset-recovery',
    'asset-deletion-history',
    'vector-failures',
    'vector-diagnostics',
    'vector-jobs',
  ]) {
    assert.equal(ids.has(expected), true, `missing ${expected}`)
  }
  assert.equal(report.items.find((item) => item.id === 'image-search-index').taskState, 'active')
  assert.equal(report.items.find((item) => item.id === 'media-frames').taskState, 'active')
  assert.equal(report.items.find((item) => item.id === 'vector-jsonl').reclaimableBytes, 0)
  assert.equal(report.items.find((item) => item.id === 'vector-caches').reclaimableBytes, 29)
  assert.equal(report.items.find((item) => item.id === 'vector-ann').reclaimableBytes, 16)
  assert.equal(
    report.items.some((item) => JSON.stringify(item).includes(root)),
    false,
  )
})

test('backup estimate protects the newest backup and marks older backups reclaimable', async () => {
  const root = fixture()
  const oldTime = new Date('2026-01-01T00:00:00.000Z')
  const newTime = new Date('2026-07-30T00:00:00.000Z')
  const oldDirectory = path.join(root, 'asset-library-backups', 'backup-20260101T000000-000Z-old')
  write(root, 'asset-library-backups/backup-20260101T000000-000Z-old/catalog.json', 31, oldTime)
  write(root, 'asset-library-backups/backup-20260730T000000-000Z-new/catalog.json', 41, newTime)
  fs.utimesSync(
    oldDirectory,
    new Date('2027-01-01T00:00:00.000Z'),
    new Date('2027-01-01T00:00:00.000Z'),
  )

  const backups = (await buildStorageInventory(root)).items.find(
    (item) => item.id === 'asset-backups',
  )
  assert.equal(backups.totalBytes, 72)
  assert.equal(backups.activeBytes, 41)
  assert.equal(backups.reclaimableBytes, 31)
  assert.equal(backups.rebuildable, false)
  assert.equal(backups.cleanupRisk, 'medium')
})

test('reclaimable log estimates only include bytes beyond retention budgets', async () => {
  const root = fixture()
  write(root, 'vector-db/embedding_failures.jsonl', 1024)
  write(root, 'vector-db/embedding_diagnostics.jsonl', 2048)
  write(root, 'image-search-scan.log', 4096)

  const report = await buildStorageInventory(root)
  assert.equal(report.items.find((item) => item.id === 'vector-failures').reclaimableBytes, 0)
  assert.equal(report.items.find((item) => item.id === 'vector-diagnostics').reclaimableBytes, 0)
  assert.equal(report.items.find((item) => item.id === 'image-search-logs').reclaimableBytes, 0)
  assert.equal(
    report.reclaimableBytes,
    report.items.reduce((sum, item) => sum + item.reclaimableBytes, 0),
  )
})

test('vector-jsonl reflects a fresh GC estimate and drops it when shards change', async () => {
  const root = fixture()
  write(root, 'vector-db/embeddings/dino__global.jsonl', 100)
  const shardPath = path.join(root, 'vector-db', 'embeddings', 'dino__global.jsonl')
  const stat = fs.statSync(shardPath)

  // No estimate yet → fail closed to zero.
  let report = await buildStorageInventory(root)
  assert.equal(report.items.find((item) => item.id === 'vector-jsonl').reclaimableBytes, 0)

  fs.writeFileSync(
    path.join(root, 'vector-db', 'vector-gc-estimate.json'),
    JSON.stringify({
      schemaVersion: 1,
      createdAt: Date.now(),
      shards: [
        {
          name: 'dino__global.jsonl',
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          reclaimableBytes: 40,
          predictedBytes: 60,
        },
      ],
    }),
  )
  report = await buildStorageInventory(root)
  let item = report.items.find((entry) => entry.id === 'vector-jsonl')
  assert.equal(item.reclaimableBytes, 40)
  assert.equal(item.activeBytes, 60)
  assert.match(item.detail, /unchanged shards/)

  // Any shard modification invalidates the persisted fingerprint.
  write(root, 'vector-db/embeddings/dino__global.jsonl', 101)
  report = await buildStorageInventory(root)
  item = report.items.find((entry) => entry.id === 'vector-jsonl')
  assert.equal(item.reclaimableBytes, 0)
  assert.equal(item.activeBytes, 101)
  assert.match(item.detail, /run a Vector GC preview/)
})

test('image-search-index separates manifest-referenced bytes from old orphans', async () => {
  const root = fixture()
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
  write(root, 'image-search-index/segments/a.idx', 100)
  write(root, 'image-search-index/segments/orphan.idx', 50, old)
  write(root, 'image-search-index/staging/inflight.tmp', 30)
  fs.writeFileSync(
    path.join(root, 'image-search-index', 'manifest.json'),
    JSON.stringify({ schemaVersion: 2, segments: [{ id: 'a', file: 'segments/a.idx' }] }),
  )
  const report = await buildStorageInventory(root)
  const item = report.items.find((entry) => entry.id === 'image-search-index')
  // Only the old, unreferenced segment is reclaimable; the recent staging
  // file stays protected inside active bytes.
  assert.equal(item.reclaimableBytes, 50)
  assert.equal(item.activeBytes, item.totalBytes - 50)
  assert.match(item.detail, /Unreferenced segment/)
})

test('image-search-index fails closed when the manifest is unreadable', async () => {
  const root = fixture()
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
  write(root, 'image-search-index/segments/orphan.idx', 50, old)
  fs.writeFileSync(path.join(root, 'image-search-index', 'manifest.json'), 'not json {')
  const report = await buildStorageInventory(root)
  const item = report.items.find((entry) => entry.id === 'image-search-index')
  assert.equal(item.reclaimableBytes, 0)
  assert.equal(item.activeBytes, item.totalBytes)
  assert.match(item.detail, /fail-closed/)
})

test('media-vectors covers manifests, vectors and sidecar subdirectories but not frames', async () => {
  const root = fixture()
  write(root, 'media-search/videos.jsonl', 8)
  write(root, 'media-search/manifests/video_frames.jsonl', 10)
  write(root, 'media-search/vectors/clip.jsonl', 20)
  write(root, 'media-search/thumbnails/t.jpg', 4)
  write(root, 'media-search/frames/f.jpg', 5)
  const report = await buildStorageInventory(root)
  const vectors = report.items.find((entry) => entry.id === 'media-vectors')
  const frames = report.items.find((entry) => entry.id === 'media-frames')
  assert.equal(vectors.totalBytes, 42)
  assert.equal(frames.totalBytes, 5)
})

test('user-installed AI models appear as protected inventory', async () => {
  const root = fixture()
  write(root, 'models/face-detector/model.onnx', 70)
  write(root, 'models/face-detector/installation.json', 5)
  const report = await buildStorageInventory(root)
  const item = report.items.find((entry) => entry.id === 'user-models')
  assert.equal(item.totalBytes, 75)
  assert.equal(item.reclaimableBytes, 0)
  assert.equal(item.rebuildable, false)
  assert.equal(item.cleanupRisk, 'high')
})
