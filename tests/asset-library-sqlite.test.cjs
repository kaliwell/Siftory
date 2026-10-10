const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { loadTsModule } = require('./guard-utils.cjs')

const { AssetLibraryDatabase } = loadTsModule('electron/assetLibraryDatabase.ts')

const TABLE_FILES = {
  categories: 'categories.jsonl',
  tags: 'tags.jsonl',
  category_references: 'category_references.jsonl',
  asset_categories: 'asset_categories.jsonl',
  asset_tags: 'asset_tags.jsonl',
  suggestions: 'suggestions.jsonl',
  cluster_groups: 'cluster_groups.jsonl',
  cluster_members: 'cluster_group_assets.jsonl',
  metadata_deletion_trash: 'metadata_deletion_trash.jsonl',
}

function fixtureRecords() {
  return {
    'categories.jsonl': [
      {
        id: 1,
        name: '风景',
        description: '自然风光',
        parentId: null,
        color: '#ff0000',
        icon: 'mountain',
        sortOrder: 1,
        referenceThreshold: 0.8,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
      {
        id: 2,
        name: '人物',
        description: '',
        parentId: 1,
        color: '#00ff00',
        icon: 'person',
        sortOrder: 2,
        sourceClusterGroupId: 1,
        createdAt: 1700000000001,
        updatedAt: 1700000000001,
      },
    ],
    'tags.jsonl': [
      { id: 1, name: '收藏', color: '#123456', createdAt: 1700000000000, updatedAt: 1700000000000 },
      {
        id: 2,
        name: '待整理',
        color: '#654321',
        createdAt: 1700000000001,
        updatedAt: 1700000000001,
      },
    ],
    'asset_categories.jsonl': [
      {
        id: 1,
        assetId: 101,
        categoryId: 1,
        confidence: 0.95,
        source: 'manual',
        status: 'confirmed',
        confirmedByUser: true,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
      {
        id: 2,
        assetId: 102,
        categoryId: 2,
        suggestionId: 1,
        confidence: 0.6,
        source: 'cluster',
        status: 'suggested',
        confirmedByUser: false,
        createdAt: 1700000000001,
        updatedAt: 1700000000001,
      },
    ],
    'asset_tags.jsonl': [
      {
        id: 1,
        assetId: 101,
        tagId: 1,
        confidence: 1,
        source: 'manual',
        status: 'confirmed',
        confirmedByUser: true,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
      {
        id: 2,
        assetId: 103,
        tagId: 2,
        suggestionId: 2,
        confidence: 0.5,
        source: 'text_label',
        status: 'suggested',
        confirmedByUser: false,
        createdAt: 1700000000001,
        updatedAt: 1700000000001,
      },
    ],
    'category_references.jsonl': [
      { id: 1, categoryId: 1, assetId: 101, weight: 1.5, createdAt: 1700000000000 },
    ],
    'suggestions.jsonl': [
      {
        id: 1,
        assetId: 102,
        categoryId: 2,
        confidence: 0.6,
        source: 'cluster',
        status: 'suggested',
        evidenceAssetIds: [101, 105],
        createdAt: 1700000000001,
        updatedAt: 1700000000001,
      },
      {
        id: 2,
        assetId: 103,
        tagId: 2,
        confidence: 0.5,
        source: 'text_label',
        status: 'suggested',
        evidenceAssetIds: [],
        createdAt: 1700000000002,
        updatedAt: 1700000000002,
      },
    ],
    'cluster_groups.jsonl': [
      {
        id: 1,
        name: '聚类 1',
        algorithm: 'compressed_kmeans',
        status: 'suggested',
        assetCount: 2,
        avgSimilarity: 0.9,
        representativeAssetId: 101,
        labels: ['山', '水'],
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
    ],
    'cluster_group_assets.jsonl': [
      { id: 1, clusterGroupId: 1, assetId: 101, similarity: 0.95, createdAt: 1700000000000 },
      { id: 2, clusterGroupId: 1, assetId: 102, similarity: 0.85, createdAt: 1700000000001 },
    ],
    'metadata_deletion_trash.jsonl': [
      {
        id: 1,
        kind: 'category',
        name: '旧分类',
        category: {
          id: 9,
          name: '旧分类',
          description: '',
          parentId: null,
          color: '#000000',
          icon: 'x',
          sortOrder: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        categoryAssignments: [
          {
            id: 7,
            assetId: 101,
            categoryId: 9,
            confidence: 1,
            source: 'manual',
            status: 'confirmed',
            confirmedByUser: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        tagAssignments: [],
        references: [],
        suggestions: [],
        deletedAt: 1700000000000,
      },
    ],
  }
}

function writeJsonlFiles(dir, files) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [file, records] of Object.entries(files)) {
    const content =
      records.length > 0 ? `${records.map((r) => JSON.stringify(r)).join('\n')}\n` : ''
    fs.writeFileSync(path.join(dir, file), content, 'utf8')
  }
}

function writeFixtures(dir) {
  writeJsonlFiles(dir, fixtureRecords())
}

function expectedCounts() {
  const files = fixtureRecords()
  const counts = {}
  for (const [table, file] of Object.entries(TABLE_FILES)) {
    counts[table] = (files[file] || []).length
  }
  return counts
}

function readMeta(dir, key) {
  const db = new DatabaseSync(path.join(dir, 'asset-library.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db.prepare('SELECT value FROM library_meta WHERE key = ?').get(key)
    return row ? row.value : null
  } finally {
    db.close()
  }
}

async function withTempDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asset-library-sqlite-'))
  try {
    await run(dir)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

function openDatabase(dir) {
  const database = new AssetLibraryDatabase(dir)
  database.open()
  return database
}

test('open creates schema v2 tables, indexes and migration record', async () => {
  await withTempDir(async (dir) => {
    const database = openDatabase(dir)
    assert.equal(database.isOpen(), true)
    assert.ok(fs.existsSync(path.join(dir, 'asset-library.sqlite')))
    const counts = database.counts()
    for (const table of Object.keys(TABLE_FILES)) assert.equal(counts[table], 0)
    database.close()
    assert.equal(database.isOpen(), false)

    const db = new DatabaseSync(path.join(dir, 'asset-library.sqlite'))
    try {
      const version = db.prepare('PRAGMA user_version').get()
      assert.equal(version.user_version, 2)
      const objects = db
        .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index')")
        .all()
      const tables = new Set(objects.filter((o) => o.type === 'table').map((o) => o.name))
      for (const table of [
        ...Object.keys(TABLE_FILES),
        'library_meta',
        'schema_migrations',
        'cluster_lineage',
      ]) {
        assert.ok(tables.has(table), `missing table ${table}`)
      }
      // schema v2: cluster lineage columns
      const groupColumns = new Set(
        db
          .prepare('PRAGMA table_info(cluster_groups)')
          .all()
          .map((c) => c.name),
      )
      assert.ok(groupColumns.has('origin'))
      assert.ok(groupColumns.has('lineage_key'))
      const indexes = new Set(objects.filter((o) => o.type === 'index').map((o) => o.name))
      for (const index of [
        'idx_categories_parent',
        'idx_categories_name',
        'idx_tags_name',
        'idx_asset_categories_category_status',
        'idx_asset_tags_tag_status',
        'idx_suggestions_status_source',
        'idx_cluster_groups_status',
        'idx_cluster_members_asset',
        'idx_trash_retention',
      ]) {
        assert.ok(indexes.has(index), `missing index ${index}`)
      }
      const migration = db.prepare('SELECT version, description FROM schema_migrations').all()
      assert.equal(migration.length, 1)
      assert.equal(migration[0].version, 2)
    } finally {
      db.close()
    }
  })
})

test('schema migration rolls back an interrupted ALTER and retries without losing rows', async () => {
  await withTempDir(async (dir) => {
    openDatabase(dir).close()
    const filePath = path.join(dir, 'asset-library.sqlite')
    const seed = new DatabaseSync(filePath)
    seed.exec(
      'ALTER TABLE cluster_groups DROP COLUMN origin; ALTER TABLE cluster_groups DROP COLUMN lineage_key; PRAGMA user_version = 1',
    )
    seed.exec("INSERT INTO tags VALUES (1, 'preserve-me', '#123456', 1, 1)")
    seed.close()
    const originalExec = DatabaseSync.prototype.exec
    try {
      DatabaseSync.prototype.exec = function (sql) {
        if (sql.includes('ADD COLUMN lineage_key'))
          throw new Error('injected migration interruption')
        return originalExec.call(this, sql)
      }
      assert.throws(() => openDatabase(dir), /injected migration interruption/)
    } finally {
      DatabaseSync.prototype.exec = originalExec
    }
    const interrupted = new DatabaseSync(filePath)
    try {
      assert.equal(interrupted.prepare('PRAGMA user_version').get().user_version, 1)
      assert.equal(
        interrupted
          .prepare('PRAGMA table_info(cluster_groups)')
          .all()
          .some((row) => row.name === 'origin'),
        false,
      )
    } finally {
      interrupted.close()
    }
    openDatabase(dir).close()
    const recovered = new DatabaseSync(filePath)
    try {
      assert.equal(recovered.prepare('PRAGMA user_version').get().user_version, 2)
      assert.equal(
        recovered.prepare('SELECT name FROM tags WHERE id = 1').get().name,
        'preserve-me',
      )
    } finally {
      recovered.close()
    }
  })
})

test('schema migration resumes both historical partial v1 migration states', async () => {
  for (const existing of ['origin', 'both']) {
    await withTempDir(async (dir) => {
      openDatabase(dir).close()
      const filePath = path.join(dir, 'asset-library.sqlite')
      const seed = new DatabaseSync(filePath)
      if (existing === 'origin') seed.exec('ALTER TABLE cluster_groups DROP COLUMN lineage_key')
      seed.exec('PRAGMA user_version = 1')
      seed.close()
      openDatabase(dir).close()
      const recovered = new DatabaseSync(filePath)
      try {
        assert.equal(recovered.prepare('PRAGMA user_version').get().user_version, 2)
        const columns = recovered
          .prepare('PRAGMA table_info(cluster_groups)')
          .all()
          .map((row) => row.name)
        assert.equal(columns.filter((name) => name === 'origin').length, 1)
        assert.equal(columns.filter((name) => name === 'lineage_key').length, 1)
      } finally {
        recovered.close()
      }
    })
  }
})

test('importFromJsonl imports all tables, then skips when complete', async () => {
  await withTempDir(async (dir) => {
    writeFixtures(dir)
    const database = openDatabase(dir)
    try {
      const report = database.importFromJsonl()
      assert.equal(report.skipped, false)
      assert.deepEqual(report.counts, expectedCounts())
      assert.deepEqual(database.counts(), expectedCounts())
      assert.equal(readMeta(dir, 'migrated_from_jsonl'), 'complete')
      assert.ok(readMeta(dir, 'migrated_at'))
      assert.equal(readMeta(dir, 'next_id:tags'), '3')

      const verify = database.verifyAgainstJsonl()
      assert.equal(verify.ok, true)

      const again = database.importFromJsonl()
      assert.equal(again.skipped, true)
      assert.deepEqual(again.counts, expectedCounts())
    } finally {
      database.close()
    }
  })
})

test('verifyAgainstJsonl detects tampered rows via sampled hash', async () => {
  await withTempDir(async (dir) => {
    writeFixtures(dir)
    const database = openDatabase(dir)
    database.importFromJsonl()
    database.close()

    const db = new DatabaseSync(path.join(dir, 'asset-library.sqlite'))
    try {
      db.prepare('UPDATE tags SET name = ? WHERE id = 1').run('被篡改')
    } finally {
      db.close()
    }

    const reopened = openDatabase(dir)
    try {
      const verify = reopened.verifyAgainstJsonl()
      assert.equal(verify.ok, false)
      assert.equal(verify.tables.tags.ok, false)
      assert.equal(verify.tables.tags.expectedCount, 2)
      assert.equal(verify.tables.tags.actualCount, 2)
      assert.notEqual(verify.tables.tags.expectedHash, verify.tables.tags.actualHash)
      assert.equal(verify.tables.categories.ok, true)
    } finally {
      reopened.close()
    }
  })
})

test('corrupt JSONL rolls the import back and keeps source files untouched', async () => {
  await withTempDir(async (dir) => {
    const files = fixtureRecords()
    const suggestionsFile = path.join(dir, 'suggestions.jsonl')
    writeJsonlFiles(dir, files)
    fs.appendFileSync(suggestionsFile, '{"id":3,"assetId":broken\n', 'utf8')
    const before = fs.readFileSync(suggestionsFile, 'utf8')

    const database = openDatabase(dir)
    try {
      assert.throws(() => database.importFromJsonl(), /malformed line/i)
      const counts = database.counts()
      for (const table of Object.keys(TABLE_FILES)) assert.equal(counts[table], 0)
      assert.equal(readMeta(dir, 'migrated_from_jsonl'), 'failed:corrupt')
      assert.equal(fs.readFileSync(suggestionsFile, 'utf8'), before)
    } finally {
      database.close()
    }
  })
})

test('interrupted import state clears stale rows and re-imports', async () => {
  await withTempDir(async (dir) => {
    writeFixtures(dir)
    const database = openDatabase(dir)
    database.close()

    const db = new DatabaseSync(path.join(dir, 'asset-library.sqlite'))
    try {
      db.prepare('INSERT OR REPLACE INTO library_meta (key, value) VALUES (?, ?)').run(
        'migrated_from_jsonl',
        'importing',
      )
      db.prepare(
        `INSERT INTO categories (
          id, name, description, parent_id, color, icon, sort_order,
          reference_threshold, source_cluster_group_id, created_at, updated_at
        ) VALUES (999, '脏数据', '', NULL, '', '', 0, NULL, NULL, 1, 1)`,
      ).run()
    } finally {
      db.close()
    }

    const reopened = openDatabase(dir)
    try {
      const report = reopened.importFromJsonl()
      assert.equal(report.skipped, false)
      assert.deepEqual(reopened.counts(), expectedCounts())
      assert.equal(readMeta(dir, 'migrated_from_jsonl'), 'complete')
      assert.equal(reopened.verifyAgainstJsonl().ok, true)
    } finally {
      reopened.close()
    }
  })
})

test('exportJsonl round-trips into a fresh database with identical hashes', async () => {
  await withTempDir(async (dir) => {
    const sourceDir = path.join(dir, 'source')
    const exportDir = path.join(dir, 'exported')
    writeFixtures(sourceDir)

    const source = openDatabase(sourceDir)
    const importReport = source.importFromJsonl()
    const exportReport = source.exportJsonl(exportDir)
    assert.deepEqual(exportReport.counts, expectedCounts())
    for (const file of Object.values(TABLE_FILES)) {
      assert.ok(fs.existsSync(path.join(exportDir, file)), `missing export ${file}`)
    }
    source.close()

    const restored = openDatabase(exportDir)
    try {
      const reimport = restored.importFromJsonl()
      assert.equal(reimport.skipped, false)
      assert.deepEqual(reimport.counts, importReport.counts)
      assert.deepEqual(reimport.hashes, importReport.hashes)
      assert.equal(restored.verifyAgainstJsonl().ok, true)
    } finally {
      restored.close()
    }
  })
})

test('transaction rolls back every write when fn throws', async () => {
  await withTempDir(async (dir) => {
    writeFixtures(dir)
    const database = openDatabase(dir)
    try {
      const boom = new Error('rollback-boom')
      assert.throws(
        () =>
          database.transaction(() => {
            database.importFromJsonl()
            throw boom
          }),
        (error) => error === boom,
      )
      const counts = database.counts()
      for (const table of Object.keys(TABLE_FILES)) assert.equal(counts[table], 0)
      assert.equal(readMeta(dir, 'migrated_from_jsonl'), null)

      const report = database.importFromJsonl()
      assert.equal(report.skipped, false)
      assert.deepEqual(database.counts(), expectedCounts())
    } finally {
      database.close()
    }
  })
})
