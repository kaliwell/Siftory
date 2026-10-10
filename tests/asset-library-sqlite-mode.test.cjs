const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { loadTsModule } = require('./guard-utils.cjs')

const { AssetLibraryDatabase } = loadTsModule('electron/assetLibraryDatabase.ts')
const { restoreAssetLibraryBackup } = loadTsModule('electron/assetLibraryBackup.ts')
const {
  assignAssetsToCategory,
  assignAssetsToTag,
  createAssetCategory,
  createAssetTag,
  deleteAssetCategory,
  getAssetLibraryShadowDatabase,
  getAssetLibraryStats,
  getAssetLibraryStorageMode,
  initAssetLibraryService,
  listAssetCategories,
  listAssetLibraryAssets,
  listAssetMetadataDeletions,
  restoreAssetMetadataDeletion,
} = loadTsModule('electron/assetLibraryService.ts')

const GUARD_UTILS_PATH = path.join(__dirname, 'guard-utils.cjs')
const SQLITE_FILENAME = 'asset-library.sqlite'
const RELATION_JSONL = [
  'categories.jsonl',
  'tags.jsonl',
  'category_references.jsonl',
  'asset_categories.jsonl',
  'asset_tags.jsonl',
  'suggestions.jsonl',
  'cluster_groups.jsonl',
  'cluster_group_assets.jsonl',
  'metadata_deletion_trash.jsonl',
]

async function withTempDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asset-library-sqlite-mode-'))
  try {
    await run(dir)
  } finally {
    try {
      getAssetLibraryShadowDatabase()?.close()
    } catch {
      // best effort cleanup
    }
    // Startup manifest redaction may still be finishing inside this fixture.
    // Retry transient Windows directory races; persistent cleanup errors fail.
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

function seedAssets(dir, count) {
  const assetDir = path.join(dir, 'asset-library')
  fs.mkdirSync(assetDir, { recursive: true })
  const lines = []
  for (let id = 1; id <= count; id++) {
    lines.push(
      JSON.stringify({
        id,
        path: `D:/sqlite-mode-assets/asset-${id}.jpg`,
        kind: 'image',
        source: 'manual',
        width: 1,
        height: 1,
        fileSize: 1,
        modifiedTime: id,
        missing: false,
        createdAt: id,
        updatedAt: id,
      }),
    )
  }
  fs.writeFileSync(path.join(assetDir, 'assets.jsonl'), `${lines.join('\n')}\n`, 'utf8')
  fs.writeFileSync(path.join(assetDir, 'state.json'), `{"nextId":${count + 1}}`, 'utf8')
  return assetDir
}

function readMeta(dir, key) {
  const db = new DatabaseSync(path.join(dir, 'asset-library', SQLITE_FILENAME))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db.prepare('SELECT value FROM library_meta WHERE key = ?').get(key)
    return row ? row.value : null
  } finally {
    db.close()
  }
}

function rawRows(dir, sql) {
  const db = new DatabaseSync(path.join(dir, 'asset-library', SQLITE_FILENAME))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}

test('sqlite mode migrates JSONL, writes authoritatively and restarts cleanly', async () => {
  await withTempDir(async (dir) => {
    const assetDir = seedAssets(dir, 5)
    // pre-existing relation data to migrate
    fs.writeFileSync(
      path.join(assetDir, 'categories.jsonl'),
      `${JSON.stringify({
        id: 1,
        name: 'migrated-cat',
        description: '',
        parentId: null,
        color: '#53c7a2',
        icon: 'folder',
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      })}\n`,
      'utf8',
    )

    initAssetLibraryService(dir, { storageMode: 'sqlite' })
    assert.equal(getAssetLibraryStorageMode(), 'sqlite')
    // relation JSONL renamed away after import
    assert.equal(fs.existsSync(path.join(assetDir, 'categories.jsonl')), false)
    assert.equal(fs.existsSync(path.join(assetDir, 'categories.jsonl.migrated')), true)
    assert.equal(readMeta(dir, 'migrated_from_jsonl'), 'complete')

    const shadow = getAssetLibraryShadowDatabase()
    assert.deepEqual(shadow.counts().categories, 1)

    const category = await createAssetCategory({ name: 'sqlite-cat' })
    const tag = await createAssetTag({ name: 'sqlite-tag' })
    assert.equal((await assignAssetsToCategory([1, 2], category.id)).ok, true)
    assert.equal((await assignAssetsToTag([1], tag.id)).ok, true)

    // authoritative rows in SQLite
    const assignments = rawRows(dir, 'SELECT asset_id, category_id FROM asset_categories ORDER BY asset_id')
    assert.deepEqual(
      assignments.map((row) => [row.asset_id, row.category_id]),
      [
        [1, category.id],
        [2, category.id],
      ],
    )
    // no relation JSONL recreated by writes (memory-only mirrors)
    for (const name of RELATION_JSONL) {
      assert.equal(fs.existsSync(path.join(assetDir, name)), false, `${name} recreated`)
    }
    // reads come from SQL and agree with the mirror
    const listed = await listAssetLibraryAssets({ categoryId: category.id })
    assert.equal(listed.total, 2)
    assert.equal(listed.items[0].categories.length, 1)

    // delete → trash row in SQL, relations gone
    assert.equal((await deleteAssetCategory(category.id)).ok, true)
    assert.equal(rawRows(dir, 'SELECT COUNT(*) c FROM asset_categories')[0].c, 0)
    assert.equal(rawRows(dir, 'SELECT COUNT(*) c FROM metadata_deletion_trash')[0].c, 1)
    assert.equal(listAssetMetadataDeletions().total, 1)

    // restart: import skipped, mirror primed from SQLite
    initAssetLibraryService(dir, { storageMode: 'sqlite' })
    assert.equal(readMeta(dir, 'migrated_from_jsonl'), 'complete')
    assert.deepEqual(listAssetCategories().map((item) => item.name), ['migrated-cat'])
    assert.equal(listAssetMetadataDeletions().total, 1)

    // restore the deletion through the sqlite write path
    const deletionId = rawRows(dir, 'SELECT id FROM metadata_deletion_trash')[0].id
    assert.equal((await restoreAssetMetadataDeletion(deletionId)).ok, true)
    assert.deepEqual(
      listAssetCategories().map((item) => item.name).sort(),
      ['migrated-cat', 'sqlite-cat'],
    )
    assert.equal(rawRows(dir, 'SELECT COUNT(*) c FROM asset_categories')[0].c, 2)
    assert.equal(rawRows(dir, 'SELECT restored_at FROM metadata_deletion_trash')[0].restored_at > 0, true)
  })
})

test('assignment upsert semantics match the legacy path on the same fixture', async () => {
  const presetLines = () =>
    [
      { id: 1, assetId: 1, categoryId: 1, confidence: 1, source: 'manual', status: 'confirmed', confirmedByUser: true, createdAt: 1, updatedAt: 1 },
      { id: 2, assetId: 2, categoryId: 1, suggestionId: 9, confidence: 0.5, source: 'cluster', status: 'suggested', confirmedByUser: false, createdAt: 1, updatedAt: 1 },
      { id: 3, assetId: 3, categoryId: 1, confidence: 1, source: 'manual', status: 'manual_override', confirmedByUser: true, createdAt: 1, updatedAt: 1 },
    ]

  const runScenario = async (mode) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asset-library-upsert-'))
    try {
      const assetDir = seedAssets(dir, 1200)
      fs.writeFileSync(
        path.join(assetDir, 'categories.jsonl'),
        `${JSON.stringify({ id: 1, name: 'upsert-cat', description: '', parentId: null, color: '#53c7a2', icon: 'folder', sortOrder: 0, createdAt: 1, updatedAt: 1 })}\n`,
        'utf8',
      )
      fs.writeFileSync(
        path.join(assetDir, 'asset_categories.jsonl'),
        `${presetLines().map((row) => JSON.stringify(row)).join('\n')}\n`,
        'utf8',
      )
      initAssetLibraryService(dir, { storageMode: mode })
      // crosses the 500-row IN chunking boundary
      const assetIds = Array.from({ length: 1200 }, (_, index) => index + 1)
      assert.equal((await assignAssetsToCategory(assetIds, 1)).ok, true)
      const normalize = (row) => ({
        id: row.id,
        assetId: row.assetId,
        categoryId: row.categoryId,
        suggestionId: row.suggestionId ?? null,
        confidence: row.confidence,
        source: row.source,
        status: row.status,
        confirmedByUser: row.confirmedByUser,
      })
      if (mode === 'sqlite') {
        return rawRows(dir, 'SELECT * FROM asset_categories ORDER BY asset_id').map((row) =>
          normalize({
            id: row.id,
            assetId: row.asset_id,
            categoryId: row.category_id,
            suggestionId: row.suggestion_id,
            confidence: row.confidence,
            source: row.source,
            status: row.status,
            confirmedByUser: row.confirmed_by_user === 1,
          }),
        )
      }
      return fs
        .readFileSync(path.join(assetDir, 'asset_categories.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => normalize(JSON.parse(line)))
        .sort((left, right) => left.assetId - right.assetId)
    } finally {
      try {
        getAssetLibraryShadowDatabase()?.close()
      } catch {
        // best effort cleanup
      }
      await fsp.rm(dir, { recursive: true, force: true })
    }
  }

  const sqliteRows = await runScenario('sqlite')
  const jsonlRows = await runScenario('jsonl')
  assert.equal(sqliteRows.length, 1200)
  assert.equal(jsonlRows.length, 1200)
  assert.deepEqual(sqliteRows, jsonlRows)

  // spot-check the three semantic cases
  assert.equal(sqliteRows[0].status, 'confirmed') // manual stays confirmed
  assert.equal(sqliteRows[1].source, 'manual')
  assert.equal(sqliteRows[1].status, 'manual_override') // AI row overridden by manual
  assert.equal(sqliteRows[1].suggestionId, null) // manual clears suggestionId
  assert.equal(sqliteRows[2].status, 'manual_override') // preserved
})

test('SQL trash prune keeps newest pending records within record and byte limits', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    fs.mkdirSync(assetDir, { recursive: true })
    const db = new AssetLibraryDatabase(assetDir)
    db.open()
    const bundle = (id, extra = {}) => ({
      id,
      kind: 'category',
      name: `cat-${id}`,
      categoryAssignments: [],
      tagAssignments: [],
      references: [],
      suggestions: [],
      deletedAt: id,
      ...extra,
    })
    db.transaction(() => {
      for (let id = 1; id <= 60; id++) {
        db.insertTrashBundle(bundle(id, id <= 10 ? { restoredAt: id } : {}))
      }
    })
    // 60 records (10 restored + 50 pending) with a 50-record limit:
    // pending records win, so all restored ones are pruned.
    db.transaction(() => db.pruneTrash(50, 1 << 30))
    let rows = db.trashPage({ status: 'all', offset: 0, limit: 50 }).items
    assert.equal(rows.length, 50)
    assert.equal(rows.some((row) => row.restoredAt), false)
    assert.deepEqual(rows[0].id, 60)

    // byte limit still keeps at least the newest record
    db.transaction(() => db.pruneTrash(50, 1))
    rows = db.trashPage({ status: 'all', offset: 0, limit: 50 }).items
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 60)

    // record limit 1 keeps the newest pending record
    db.transaction(() => {
      for (let id = 61; id <= 63; id++) db.insertTrashBundle(bundle(id))
    })
    db.transaction(() => db.pruneTrash(1, 1 << 30))
    rows = db.trashPage({ status: 'all', offset: 0, limit: 50 }).items
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 63)
    db.close()
  })
})

test('exportJsonl rollback drill round-trips sqlite data with identical hashes', async () => {
  await withTempDir(async (dir) => {
    seedAssets(dir, 5)
    initAssetLibraryService(dir, { storageMode: 'sqlite' })
    const category = await createAssetCategory({ name: 'export-cat' })
    const tag = await createAssetTag({ name: 'export-tag' })
    await assignAssetsToCategory([1, 2], category.id)
    await assignAssetsToTag([3], tag.id)
    await deleteAssetCategory(category.id)

    const shadow = getAssetLibraryShadowDatabase()
    const exportDir = path.join(dir, 'rollback-export')
    const report = shadow.exportJsonl(exportDir)
    const sourceCounts = shadow.counts()
    getAssetLibraryShadowDatabase()?.close()

    const reimported = new AssetLibraryDatabase(exportDir)
    reimported.open()
    const reimportReport = reimported.importFromJsonl()
    assert.equal(reimportReport.skipped, false)
    assert.deepEqual(reimportReport.counts, report.counts)
    assert.deepEqual(reimported.counts(), sourceCounts)
    assert.equal(reimported.verifyAgainstJsonl().ok, true)
    assert.equal(reimported.counts().metadata_deletion_trash, 1)
    reimported.close()
  })
})

test('restoring a v1 JSONL backup re-imports relations into SQLite', async () => {
  await withTempDir(async (dir) => {
    const assetDir = seedAssets(dir, 3)
    // craft a v1 backup by hand: manifest version 1 + hashed JSONL files
    const backupId = 'backup-v1-restore-test'
    const backupDir = path.join(dir, 'asset-library-backups', backupId)
    fs.mkdirSync(backupDir, { recursive: true })
    const backupFiles = {
      'assets.jsonl': `${JSON.stringify({ id: 1, path: 'D:/sqlite-mode-assets/asset-1.jpg', kind: 'image', source: 'manual', width: 1, height: 1, fileSize: 1, modifiedTime: 1, missing: false, createdAt: 1, updatedAt: 1 })}\n`,
      'state.json': '{"nextId":2}',
      'categories.jsonl': `${JSON.stringify({ id: 7, name: 'v1-cat', description: '', parentId: null, color: '#53c7a2', icon: 'folder', sortOrder: 0, createdAt: 1, updatedAt: 1 })}\n`,
      'tags.jsonl': `${JSON.stringify({ id: 8, name: 'v1-tag', color: '#f0b35d', createdAt: 1, updatedAt: 1 })}\n`,
    }
    const manifestFiles = []
    let totalBytes = 0
    for (const [name, contents] of Object.entries(backupFiles)) {
      fs.writeFileSync(path.join(backupDir, name), contents, 'utf8')
      const bytes = Buffer.byteLength(contents, 'utf8')
      manifestFiles.push({
        path: name,
        bytes,
        sha256: crypto.createHash('sha256').update(contents, 'utf8').digest('hex'),
      })
      totalBytes += bytes
    }
    fs.writeFileSync(
      path.join(backupDir, 'manifest.json'),
      JSON.stringify(
        {
          version: 1,
          createdAt: 1000,
          sourceDirectory: assetDir,
          reason: 'manual',
          files: manifestFiles,
          totalBytes,
        },
        null,
        2,
      ),
      'utf8',
    )

    const restored = await restoreAssetLibraryBackup(assetDir, backupId)
    assert.ok(restored.restoredFiles >= 4)
    assert.equal(fs.existsSync(path.join(assetDir, 'categories.jsonl')), true)

    initAssetLibraryService(dir, { storageMode: 'sqlite' })
    assert.equal(readMeta(dir, 'migrated_from_jsonl'), 'complete')
    const shadow = getAssetLibraryShadowDatabase()
    assert.equal(shadow.counts().categories, 1)
    assert.equal(shadow.counts().tags, 1)
    assert.deepEqual(listAssetCategories().map((item) => item.name), ['v1-cat'])
    assert.equal(fs.existsSync(path.join(assetDir, 'categories.jsonl.migrated')), true)
    assert.equal((await getAssetLibraryStats()).categoryCount, 1)
  })
})

// Power-loss injection: the child begins an authoritative write transaction
// and freezes before COMMIT; the parent kills it and verifies nothing landed.
function buildFreezeChildScript(dbDir, markerPath) {
  return [
    `'use strict'`,
    `const fs = require('node:fs')`,
    `const { loadTsModule } = require(${JSON.stringify(GUARD_UTILS_PATH)})`,
    `const { AssetLibraryDatabase } = loadTsModule('electron/assetLibraryDatabase.ts')`,
    `const db = new AssetLibraryDatabase(${JSON.stringify(dbDir)})`,
    `db.open()`,
    `db.transaction(() => {`,
    `  const id = db.allocateId('categories')`,
    `  db.insertCategory({`,
    `    id,`,
    `    name: 'should-not-exist',`,
    `    description: '',`,
    `    parentId: null,`,
    `    color: '#000000',`,
    `    icon: 'x',`,
    `    sortOrder: 0,`,
    `    createdAt: 1,`,
    `    updatedAt: 1,`,
    `  })`,
    `  fs.writeFileSync(${JSON.stringify(markerPath)}, '')`,
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)`,
    `})`,
  ].join('\n')
}

async function runChildUntilMarker(scriptPath, markerPath) {
  const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const started = Date.now()
  try {
    while (!fs.existsSync(markerPath)) {
      if (Date.now() - started > 20000) {
        throw new Error(`child did not reach the freeze marker\nstderr:\n${stderr}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  } finally {
    child.kill('SIGKILL')
  }
  await new Promise((resolve) => {
    child.once('exit', () => resolve())
    setTimeout(resolve, 2000)
  })
}

test('killing a write mid-transaction leaves no partial commit behind', async () => {
  await withTempDir(async (dir) => {
    const assetDir = path.join(dir, 'asset-library')
    fs.mkdirSync(assetDir, { recursive: true })
    const markerPath = path.join(dir, 'child-frozen.marker')
    const scriptPath = path.join(dir, 'freeze-child.cjs')
    fs.writeFileSync(scriptPath, buildFreezeChildScript(assetDir, markerPath), 'utf8')

    await runChildUntilMarker(scriptPath, markerPath)

    // the killed transaction left no row and no sequence bump behind
    const db = new AssetLibraryDatabase(assetDir)
    db.open()
    assert.equal(db.counts().categories, 0)
    assert.equal(readMeta(dir, 'next_id:categories'), null)
    const importReport = db.importFromJsonl()
    assert.deepEqual(importReport.counts.categories, 0)
    db.close()
    assert.equal(rawRows(dir, 'SELECT COUNT(*) c FROM categories')[0].c, 0)
  })
})


test('id sequences lagging behind MAX(id) are reconciled at init', async () => {
  await withTempDir(async (dir) => {
    seedAssets(dir, 3)
    initAssetLibraryService(dir, { storageMode: 'sqlite' })
    const base = await createAssetCategory({ name: 'seq-base' })
    assert.equal(base.id, 1)
    // Sequence now says 2. Simulate dual-era drift: a row that entered the
    // database outside allocateId (shadow reload / restored v2 snapshot).
    getAssetLibraryShadowDatabase().insertDomainRecords('categories', [
      {
        id: 2,
        name: 'dual-era-row',
        description: '',
        parentId: null,
        color: null,
        icon: null,
        sortOrder: 0,
        createdAt: 2,
        updatedAt: 2,
      },
    ])
    assert.equal(readMeta(dir, 'next_id:categories'), '2')

    // Re-init reconciles the sequence past MAX(id); without it the next
    // sqlite write would die on UNIQUE constraint failed: categories.id.
    initAssetLibraryService(dir, { storageMode: 'sqlite' })
    assert.equal(readMeta(dir, 'next_id:categories'), '3')
    const after = await createAssetCategory({ name: 'seq-after-drift' })
    assert.equal(after.id, 3)
    assert.equal(listAssetCategories().length, 3)
  })
})
