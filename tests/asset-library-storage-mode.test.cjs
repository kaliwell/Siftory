const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  createAssetCategory,
  createAssetTag,
  deleteAssetCategory,
  deleteAssetTag,
  getAssetLibraryShadowDatabase,
  getAssetLibraryStorageMode,
  initAssetLibraryService,
  listAssetMetadataDeletions,
  purgeAssetMetadataDeletions,
  restoreAssetMetadataDeletion,
} = loadTsModule('electron/assetLibraryService.ts')
const { resolveAssetLibraryStorageMode } = loadTsModule(
  'electron/assetLibraryStorageConfig.ts',
)

const SQLITE_FILENAME = 'asset-library.sqlite'

async function withTempDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asset-library-storage-mode-'))
  try {
    await run(dir)
  } finally {
    try {
      getAssetLibraryShadowDatabase()?.close()
    } catch {
      // best effort cleanup
    }
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

function seedAssets(dir) {
  const assetDir = path.join(dir, 'asset-library')
  fs.mkdirSync(assetDir, { recursive: true })
  const asset = (id) => ({
    id,
    path: path.join(dir, `asset-${id}.jpg`),
    kind: 'image',
    source: 'manual',
    width: 1,
    height: 1,
    fileSize: 1,
    modifiedTime: 1,
    missing: false,
    createdAt: 1,
    updatedAt: 1,
  })
  fs.writeFileSync(
    path.join(assetDir, 'assets.jsonl'),
    `${JSON.stringify(asset(1))}\n${JSON.stringify(asset(2))}\n`,
    'utf8',
  )
  fs.writeFileSync(path.join(assetDir, 'state.json'), '{"nextId":3}', 'utf8')
}

test('storage config resolves option, environment, settings, and safe fallback', async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(
      path.join(dir, 'floating_clock_settings.json'),
      JSON.stringify({ storageMode: 'jsonl' }),
      'utf8',
    )
    assert.equal(resolveAssetLibraryStorageMode(dir), 'jsonl')

    process.env.FLOATING_CLOCK_ASSET_STORAGE_MODE = 'sqlite'
    try {
      assert.equal(resolveAssetLibraryStorageMode(dir), 'sqlite')
      assert.equal(resolveAssetLibraryStorageMode(dir, 'jsonl'), 'jsonl')
      assert.equal(resolveAssetLibraryStorageMode(dir, 'retired'), 'sqlite')
    } finally {
      delete process.env.FLOATING_CLOCK_ASSET_STORAGE_MODE
    }
  })
})

test('jsonl mode never creates the sqlite database file', async () => {
  await withTempDir(async (dir) => {
    seedAssets(dir)
    initAssetLibraryService(dir, { storageMode: 'jsonl' })
    assert.equal(getAssetLibraryStorageMode(), 'jsonl')
    assert.equal(getAssetLibraryShadowDatabase(), null)
    await createAssetCategory({ name: 'plain-jsonl' })
    assert.equal(fs.existsSync(path.join(dir, 'asset-library', SQLITE_FILENAME)), false)
  })
})

test('storage mode precedence: option > env > settings > default sqlite', async () => {
  await withTempDir(async (dir) => {
    seedAssets(dir)
    // settings say jsonl, no option/env -> jsonl wins over the sqlite default
    fs.writeFileSync(
      path.join(dir, 'floating_clock_settings.json'),
      JSON.stringify({ storageMode: 'jsonl' }),
      'utf8',
    )
    initAssetLibraryService(dir)
    assert.equal(getAssetLibraryStorageMode(), 'jsonl')
    assert.equal(fs.existsSync(path.join(dir, 'asset-library', SQLITE_FILENAME)), false)

    // env beats settings
    process.env.FLOATING_CLOCK_ASSET_STORAGE_MODE = 'sqlite'
    try {
      initAssetLibraryService(dir)
      assert.equal(getAssetLibraryStorageMode(), 'sqlite')
      assert.ok(fs.existsSync(path.join(dir, 'asset-library', SQLITE_FILENAME)))

      // explicit option beats env
      initAssetLibraryService(dir, { storageMode: 'jsonl' })
      assert.equal(getAssetLibraryStorageMode(), 'jsonl')

      // the retired 'dual' value falls back to sqlite
      process.env.FLOATING_CLOCK_ASSET_STORAGE_MODE = 'dual'
      initAssetLibraryService(dir)
      assert.equal(getAssetLibraryStorageMode(), 'sqlite')

      // invalid env value falls back to sqlite
      process.env.FLOATING_CLOCK_ASSET_STORAGE_MODE = 'bogus'
      initAssetLibraryService(dir)
      assert.equal(getAssetLibraryStorageMode(), 'sqlite')
    } finally {
      delete process.env.FLOATING_CLOCK_ASSET_STORAGE_MODE
    }

    // default (no option/env/settings) is sqlite
    await withTempDir(async (freshDir) => {
      seedAssets(freshDir)
      initAssetLibraryService(freshDir)
      assert.equal(getAssetLibraryStorageMode(), 'sqlite')
    })
  })
})

test('purgeAssetMetadataDeletions behaves identically in jsonl and sqlite modes', async () => {
  for (const mode of ['jsonl', 'sqlite']) {
    await withTempDir(async (dir) => {
      seedAssets(dir)
      initAssetLibraryService(dir, { storageMode: mode })

      const category = await createAssetCategory({ name: `purge-cat-${mode}` })
      const tag = await createAssetTag({ name: `purge-tag-${mode}` })
      assert.equal((await deleteAssetCategory(category.id)).ok, true)
      assert.equal((await deleteAssetTag(tag.id)).ok, true)
      assert.equal(listAssetMetadataDeletions().total, 2)

      // restore one record so restoredOnly has exactly one target
      const deletions = listAssetMetadataDeletions({ status: 'pending' })
      assert.equal(deletions.total, 2)
      const restoredId = deletions.items.find((item) => item.kind === 'category').id
      assert.equal((await restoreAssetMetadataDeletion(restoredId)).ok, true)
      assert.equal(listAssetMetadataDeletions({ status: 'restored' }).total, 1)

      // restoredOnly purges only the restored record
      const purgedRestored = await purgeAssetMetadataDeletions({ restoredOnly: true })
      assert.equal(purgedRestored.ok, true)
      assert.equal(purgedRestored.purgedCount, 1)
      assert.equal(listAssetMetadataDeletions().total, 1)
      assert.equal(listAssetMetadataDeletions().items[0].kind, 'tag')

      // full purge requires explicit confirm
      const rejected = await purgeAssetMetadataDeletions({})
      assert.equal(rejected.ok, false)
      assert.match(rejected.error, /confirm/i)
      const rejectedFalse = await purgeAssetMetadataDeletions({ confirm: false })
      assert.equal(rejectedFalse.ok, false)
      assert.equal(listAssetMetadataDeletions().total, 1)

      const purgedAll = await purgeAssetMetadataDeletions({ confirm: true })
      assert.equal(purgedAll.ok, true)
      assert.equal(purgedAll.purgedCount, 1)
      assert.equal(listAssetMetadataDeletions().total, 0)

      // authoritative store is actually empty
      if (mode === 'sqlite') {
        const db = new DatabaseSync(path.join(dir, 'asset-library', SQLITE_FILENAME))
        try {
          db.exec('PRAGMA busy_timeout = 5000')
          assert.equal(
            db.prepare('SELECT COUNT(*) AS c FROM metadata_deletion_trash').get().c,
            0,
          )
        } finally {
          db.close()
        }
      } else {
        const trashFile = path.join(dir, 'asset-library', 'metadata_deletion_trash.jsonl')
        const contents = fs.existsSync(trashFile) ? fs.readFileSync(trashFile, 'utf8') : ''
        assert.equal(contents.trim(), '')
      }

      // purging an empty trash is a no-op
      const emptyPurge = await purgeAssetMetadataDeletions({ confirm: true })
      assert.equal(emptyPurge.ok, true)
      assert.equal(emptyPurge.purgedCount, 0)
    })
  }
})
