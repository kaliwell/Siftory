const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  addCollectionItem,
  addCollectionItems,
  createAssetLibraryMetadataBackup,
  createCollection,
  deleteCollection,
  getAssetLibraryShadowDatabase,
  initAssetLibraryService,
  listCollectionItems,
  listCollections,
  removeCollectionItem,
  reorderCollections,
  updateCollection,
} = loadTsModule('electron/assetLibraryService.ts')
const { normalizeCollectionItemInput } = loadTsModule('electron/assetLibraryGuards.ts')

const localItem = {
  assetId: 'asset_0123456789abcdef01234567',
  fileEntryId: '21',
  mediaType: 'image',
  displayName: 'cat.jpg',
  displayPath: 'C:\\Pictures\\cat.jpg',
  sizeBytes: 123,
  modifiedAt: 456,
  source: { id: 'local', name: 'Pictures', type: 'local-ntfs', availability: 'online' },
}

async function withTempLibrary(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-clock-collection-'))
  try {
    initAssetLibraryService(dir, { storageMode: 'jsonl' })
    await run(dir)
  } finally {
    getAssetLibraryShadowDatabase()?.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('collections keep stable references, deduplicate items and cascade deletion', async () => {
  await withTempLibrary(async () => {
    const collection = await createCollection('  Selects  ')
    assert.equal(collection.name, 'Selects')
    assert.deepEqual(
      listCollections().map((item) => item.name),
      ['Selects'],
    )

    const first = await addCollectionItem(collection.id, localItem)
    const refreshed = await addCollectionItem(collection.id, {
      ...localItem,
      fileEntryId: '22',
      displayPath: 'D:\\Moved\\cat.jpg',
    })
    assert.equal(refreshed.id, first.id)
    assert.equal(refreshed.referenceKey, `asset:${localItem.assetId}`)
    assert.equal(listCollectionItems(collection.id).length, 1)
    assert.equal(listCollectionItems(collection.id)[0].displayPath, 'D:\\Moved\\cat.jpg')

    const remote = await addCollectionItem(collection.id, {
      ...localItem,
      assetId: undefined,
      fileEntryId: '99',
      source: { id: 'remote', name: 'NAS', type: 'sftp', availability: 'offline' },
    })
    assert.equal(remote.referenceKey, 'entry:99')
    assert.equal(listCollectionItems(collection.id).length, 2)
    assert.deepEqual(await removeCollectionItem(remote.id), { ok: true, affected: 1 })
    assert.deepEqual(await deleteCollection(collection.id), { ok: true, affected: 2 })
    assert.deepEqual(listCollections(), [])
  })
})

test('collection metadata is persisted and covered by portable backup', async () => {
  await withTempLibrary(async (dir) => {
    const collection = await createCollection('Backup')
    await addCollectionItem(collection.id, localItem)
    const backup = await createAssetLibraryMetadataBackup()
    assert.equal(backup.ok, true)
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(dir, 'asset-library-backups', backup.backup.id, 'manifest.json'),
        'utf8',
      ),
    )
    const paths = new Set(manifest.files.map((file) => file.path))
    assert.equal(paths.has('asset-collections.jsonl'), true)
    assert.equal(paths.has('asset-collection-items.jsonl'), true)
  })
})

test('collection names are required and unique', async () => {
  await withTempLibrary(async () => {
    await assert.rejects(() => createCollection(' '), /name is required/)
    await createCollection('Review')
    await assert.rejects(() => createCollection('review'), /already exists/)
  })
})

test('collection inputs accept a stable AssetId without a catalog entry id', () => {
  const normalized = normalizeCollectionItemInput({ ...localItem, fileEntryId: undefined })
  assert.equal(normalized.assetId, localItem.assetId)
  assert.equal(normalized.fileEntryId, undefined)
  assert.throws(
    () =>
      normalizeCollectionItemInput({
        ...localItem,
        assetId: undefined,
        fileEntryId: undefined,
      }),
    /Invalid collection item/,
  )
})

test('collections support rename, manual order and atomic batch additions', async () => {
  await withTempLibrary(async () => {
    const first = await createCollection('First')
    const second = await createCollection('Second')
    const renamed = await updateCollection(first.id, 'Renamed')
    assert.equal(renamed.name, 'Renamed')
    assert.deepEqual(await reorderCollections([second.id, first.id]), { ok: true, affected: 2 })
    assert.deepEqual(
      listCollections().map((item) => item.id),
      [second.id, first.id],
    )
    const added = await addCollectionItems(second.id, [
      localItem,
      { ...localItem, assetId: undefined, fileEntryId: '23', displayName: 'dog.jpg' },
    ])
    assert.equal(added.length, 2)
    assert.equal(listCollectionItems(second.id).length, 2)
    const refreshed = await addCollectionItems(second.id, [
      { ...localItem, displayPath: 'D:\\Moved\\cat.jpg' },
    ])
    assert.equal(refreshed[0].id, added[0].id)
    assert.equal(listCollectionItems(second.id).length, 2)
    assert.equal(
      listCollectionItems(second.id).find((item) => item.id === added[0].id).displayPath,
      'D:\\Moved\\cat.jpg',
    )
    await assert.rejects(() => updateCollection(first.id, 'Second'), /already exists/)
    await assert.rejects(() => reorderCollections([first.id]), /every collection/)
  })
})

test('collection tray exposes selection, atomic batch and drag-drop entry points', () => {
  const ui = require('node:fs').readFileSync('src/components/DiscoverySourcesSection.tsx', 'utf8')
  assert.match(ui, /data-testid="asset-collection-add-selected"/)
  assert.match(ui, /addCollectionItems/)
  assert.match(ui, /draggable/)
  assert.match(ui, /dataTransfer\.setData\(COLLECTION_DRAG_TYPE/)
  assert.match(ui, /onDrop=/)
})

test('asset and media result views share collection entry points and stable identity resolution', () => {
  const fsSync = require('node:fs')
  const assetView = fsSync.readFileSync(
    'src/components/assetLibrary/AssetLibraryAssetsView.tsx',
    'utf8',
  )
  const mediaView = fsSync.readFileSync('src/components/MediaSearchResultsView.tsx', 'utf8')
  const hook = fsSync.readFileSync('src/hooks/useAssetCollections.ts', 'utf8')
  assert.match(assetView, /data-testid="asset-library-collect-selected"/)
  assert.match(assetView, /assetIdentity\.resolve/)
  assert.match(assetView, /addCollectionItems/)
  assert.match(mediaView, /data-testid="media-search-collect-video"/)
  assert.match(mediaView, /data-testid="media-search-collect-frame"/)
  assert.match(mediaView, /assetIdentity\.resolve/)
  assert.match(hook, /asset-collections-changed/)
})
