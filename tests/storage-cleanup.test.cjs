const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  cancelStorageCleanup,
  getStorageCleanupProgress,
  isStorageCleanupActiveFor,
  previewStorageCleanup,
  resetStorageCleanupForTests,
  startStorageCleanup,
} = loadTsModule('electron/storageCleanupService.ts')

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-storage-cleanup-'))
}

function write(root, relativePath, bytes = 10) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.alloc(bytes, 1))
  return target
}

async function waitForTerminal() {
  for (let i = 0; i < 200; i++) {
    const current = getStorageCleanupProgress()
    if (current.state !== 'running') return current
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('cleanup did not finish')
}

test.beforeEach(() => resetStorageCleanupForTests())

test('preview exposes logical candidates only and preserves authoritative data', async () => {
  const root = fixture()
  write(root, 'thumbcache/a.jpg', 11)
  write(root, 'vector-db/embedding-cache/dino.f16', 12)
  write(root, 'vector-db/embeddings/dino.jsonl', 13)
  write(root, 'image-search-index/segment.bin', 14)

  const preview = await previewStorageCleanup(root)
  assert.equal(
    preview.items.some((item) => item.id === 'image-search-thumbnails'),
    true,
  )
  assert.equal(
    preview.items.some((item) => item.id === 'vector-caches'),
    true,
  )
  assert.equal(
    preview.items.some((item) => item.id === 'vector-jsonl'),
    false,
  )
  assert.equal(JSON.stringify(preview).includes(root), false)

  const result = startStorageCleanup(root, {
    token: preview.token,
    selectedIds: ['image-search-thumbnails', 'vector-caches'],
  })
  assert.equal(result.ok, true)
  assert.equal(isStorageCleanupActiveFor('image-search'), true)
  const final = await waitForTerminal()
  assert.equal(final.state, 'completed')
  assert.equal(final.freedBytes, 23)
  assert.equal(fs.existsSync(path.join(root, 'thumbcache/a.jpg')), false)
  assert.equal(fs.existsSync(path.join(root, 'vector-db/embedding-cache/dino.f16')), false)
  assert.equal(fs.existsSync(path.join(root, 'vector-db/embeddings/dino.jsonl')), true)
  assert.equal(fs.existsSync(path.join(root, 'image-search-index/segment.bin')), true)
  assert.equal(fs.readdirSync(path.join(root, 'storage-cleanup-snapshots')).length, 1)
})

test('asset cleanup preserves the newest backup id after old directory mtimes change', async () => {
  const root = fixture()
  const oldDirectory = path.join(root, 'asset-library-backups', 'backup-20260101T000000-000Z-old')
  const newestDirectory = path.join(
    root,
    'asset-library-backups',
    'backup-20260201T000000-000Z-new',
  )
  write(root, 'asset-library-backups/backup-20260101T000000-000Z-old/catalog.json', 31)
  write(root, 'asset-library-backups/backup-20260201T000000-000Z-new/catalog.json', 41)
  fs.utimesSync(
    oldDirectory,
    new Date('2027-01-01T00:00:00.000Z'),
    new Date('2027-01-01T00:00:00.000Z'),
  )

  const preview = await previewStorageCleanup(root)
  assert.equal(preview.items.find((item) => item.id === 'asset-backups').estimatedBytes, 31)
  assert.equal(
    startStorageCleanup(root, { token: preview.token, selectedIds: ['asset-backups'] }).ok,
    true,
  )
  assert.equal((await waitForTerminal()).state, 'completed')
  assert.equal(fs.existsSync(path.join(oldDirectory, 'catalog.json')), false)
  assert.equal(fs.existsSync(path.join(newestDirectory, 'catalog.json')), true)
  assert.equal(
    (await previewStorageCleanup(root)).items.some((item) => item.id === 'asset-backups'),
    false,
  )
})

test('confirmation rejects stale tokens, empty selections, and active domains', async () => {
  const root = fixture()
  write(root, 'thumbcache/a.jpg')
  const preview = await previewStorageCleanup(root)
  assert.equal(
    startStorageCleanup(root, { token: 'wrong', selectedIds: ['image-search-thumbnails'] }).ok,
    false,
  )
  assert.equal(startStorageCleanup(root, { token: preview.token, selectedIds: [] }).ok, false)
  assert.equal(
    startStorageCleanup(
      root,
      { token: preview.token, selectedIds: ['image-search-thumbnails'] },
      new Set(['image-search']),
    ).ok,
    false,
  )
  assert.equal(fs.existsSync(path.join(root, 'thumbcache/a.jpg')), true)
})

test('cancellation stops a running file-by-file cleanup and reports partial work', async () => {
  const root = fixture()
  for (let i = 0; i < 300; i++) write(root, `thumbcache/${i}.jpg`, 2)
  const preview = await previewStorageCleanup(root)
  const result = startStorageCleanup(root, {
    token: preview.token,
    selectedIds: ['image-search-thumbnails'],
  })
  assert.equal(result.ok, true)
  cancelStorageCleanup()
  const final = await waitForTerminal()
  assert.equal(final.state, 'cancelled')
  assert.ok(final.completedFiles < final.totalFiles)
  assert.ok(fs.readdirSync(path.join(root, 'thumbcache')).length > 0)
})

test('expired Vector GC snapshots are selectable while unexpired snapshots stay protected', async () => {
  const root = fixture()
  const directory = path.join(root, 'vector-db', 'embeddings')
  const expiredName = 'dino.jsonl.gc-backup-1'
  const protectedName = 'clip.jsonl.gc-backup-2'
  write(root, `vector-db/embeddings/${expiredName}`, 31)
  write(root, `vector-db/embeddings/${protectedName}`, 41)
  fs.writeFileSync(
    path.join(directory, `${expiredName}.json`),
    JSON.stringify({
      expiresAt: '2026-01-01T00:00:00.000Z',
      backup: expiredName,
    }),
  )
  fs.writeFileSync(
    path.join(directory, `${protectedName}.json`),
    JSON.stringify({
      expiresAt: '2099-01-01T00:00:00.000Z',
      backup: protectedName,
    }),
  )
  const preview = await previewStorageCleanup(root)
  const item = preview.items.find((entry) => entry.id === 'vector-gc-backups')
  assert.equal(item.estimatedBytes > 31, true)
  const result = startStorageCleanup(root, {
    token: preview.token,
    selectedIds: ['vector-gc-backups'],
  })
  assert.equal(result.ok, true)
  assert.equal((await waitForTerminal()).state, 'completed')
  assert.equal(fs.existsSync(path.join(directory, expiredName)), false)
  assert.equal(fs.existsSync(path.join(directory, protectedName)), true)
})
