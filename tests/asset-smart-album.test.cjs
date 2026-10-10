const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  createSmartAlbum,
  createAssetLibraryMetadataBackup,
  deleteSmartAlbum,
  getAssetLibraryShadowDatabase,
  initAssetLibraryService,
  listSmartAlbums,
  updateSmartAlbum,
} = loadTsModule('electron/assetLibraryService.ts')

async function withTempLibrary(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-clock-smart-album-'))
  try {
    initAssetLibraryService(dir, { storageMode: 'jsonl' })
    await run(dir)
  } finally {
    getAssetLibraryShadowDatabase()?.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('smart albums persist normalized asset-list rules and support CRUD', async () => {
  await withTempLibrary(async (dir) => {
    const created = await createSmartAlbum({
      name: '  Recent cats  ',
      rules: {
        query: 'cat',
        categoryId: 7,
        tagId: 9,
        unclassified: true,
        archivedOnly: true,
        source: 'manual',
        kind: 'video_frame',
        modifiedAfter: 1000,
        modifiedBefore: 2000,
        minRating: 4,
        favoriteOnly: true,
        sort: 'size_desc',
      },
    })
    assert.equal(created.name, 'Recent cats')
    assert.deepEqual(created.rules, {
      sort: 'size_desc',
      query: 'cat',
      categoryId: 7,
      tagId: 9,
      unclassified: true,
      archivedOnly: true,
      source: 'manual',
      kind: 'video_frame',
      modifiedAfter: 1000,
      modifiedBefore: 2000,
      minRating: 4,
      favoriteOnly: true,
    })
    assert.deepEqual(listSmartAlbums().map((album) => album.name), ['Recent cats'])

    const updated = await updateSmartAlbum(created.id, {
      name: 'Largest cats',
      rules: { sort: 'name_asc', query: 'cat' },
    })
    assert.equal(updated.name, 'Largest cats')
    assert.deepEqual(updated.rules, { sort: 'name_asc', query: 'cat' })

    const persisted = await fs.readFile(
      path.join(dir, 'asset-library', 'smart-albums.jsonl'),
      'utf8',
    )
    assert.match(persisted, /Largest cats/)

    const backup = await createAssetLibraryMetadataBackup()
    assert.equal(backup.ok, true)
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(dir, 'asset-library-backups', backup.backup.id, 'manifest.json'),
        'utf8',
      ),
    )
    assert.ok(manifest.files.some((file) => file.path === 'smart-albums.jsonl'))

    assert.deepEqual(await deleteSmartAlbum(created.id), { ok: true, affected: 1 })
    assert.deepEqual(listSmartAlbums(), [])
  })
})

test('smart albums reject empty and duplicate names', async () => {
  await withTempLibrary(async () => {
    await assert.rejects(
      () => createSmartAlbum({ name: ' ', rules: { sort: 'updated_desc' } }),
      /name is required/,
    )
    await createSmartAlbum({ name: 'Review', rules: { sort: 'updated_desc' } })
    await assert.rejects(
      () => createSmartAlbum({ name: 'review', rules: { sort: 'updated_desc' } }),
      /already exists/,
    )
  })
})
