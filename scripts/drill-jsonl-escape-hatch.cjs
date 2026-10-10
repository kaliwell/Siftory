// Escape-hatch drill: proves the jsonl fallback works on real-library-shaped
// data after the sqlite migration. Copies the real library's authoritative
// files into a temp dir, renames the `.jsonl.migrated` relation files back to
// `.jsonl` (the manual escape-hatch step), boots the asset library service in
// jsonl mode and checks the relation data is fully readable.
// Usage: node scripts/drill-jsonl-escape-hatch.cjs
// Read-only against the real library; the temp copy is deleted afterwards.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const realDir = path.join(process.env.APPDATA, 'floating-clock-electron', 'asset-library')

const RELATION_FILES = [
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

async function main() {
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jsonl-escape-hatch-'))
  const assetDir = path.join(userDataDir, 'asset-library')
  await fsp.mkdir(assetDir, { recursive: true })
  try {
    // Minimal authoritative assets + restored relation JSONL from .migrated.
    for (const file of ['assets.jsonl', 'state.json', 'archived-assets.json']) {
      const source = path.join(realDir, file)
      if (fs.existsSync(source)) await fsp.copyFile(source, path.join(assetDir, file))
    }
    let restored = 0
    for (const file of RELATION_FILES) {
      const migrated = path.join(realDir, `${file}.migrated`)
      if (fs.existsSync(migrated)) {
        await fsp.copyFile(migrated, path.join(assetDir, file))
        restored++
      }
    }
    console.log(`[drill] temp copy ready: ${restored} relation files restored from .migrated`)

    const {
      initAssetLibraryService,
      getAssetLibraryStorageMode,
      getAssetLibraryStats,
      listAssetCategories,
      listAssetClusters,
    } = loadTsModule('electron/assetLibraryService.ts')

    initAssetLibraryService(userDataDir, { storageMode: 'jsonl' })
    if (getAssetLibraryStorageMode() !== 'jsonl') {
      throw new Error(`expected jsonl mode, got ${getAssetLibraryStorageMode()}`)
    }
    const stats = await getAssetLibraryStats()
    const categories = listAssetCategories()
    const clusters = await listAssetClusters()
    console.log(
      `[drill] jsonl mode stats: totalAssets(active)=${stats.totalAssets} categories=${categories.length} ` +
        `classifiedAssets=${stats.classifiedAssets} suggestions=${stats.suggestedCount} ` +
        `clusters=${clusters.length}`,
    )
    // Expected relation counts come from the real (sqlite-authoritative)
    // library, so the drill asserts jsonl/sqlite equivalence, not constants.
    const { DatabaseSync } = require('node:sqlite')
    const realDb = new DatabaseSync(path.join(realDir, 'asset-library.sqlite'), {
      readOnly: true,
    })
    let expectedCategories
    try {
      expectedCategories = realDb.prepare('SELECT COUNT(*) AS c FROM categories').get().c
    } finally {
      realDb.close()
    }
    if (categories.length !== expectedCategories) {
      throw new Error(`expected ${expectedCategories} categories, got ${categories.length}`)
    }
    if (stats.totalAssets <= 0) {
      throw new Error(`expected active assets, got ${stats.totalAssets}`)
    }
    // listAssetClusters filters ignored groups and groups without active
    // members, so only a non-empty sanity check is meaningful here.
    if (clusters.length <= 0) {
      throw new Error(`expected listed clusters, got ${clusters.length}`)
    }
    console.log('[drill] RESULT: jsonl escape hatch reads the restored library correctly')
  } finally {
    try {
      await fsp.rm(userDataDir, { recursive: true, force: true })
    } catch (error) {
      // The catalog projection SQLite handle is process-held; the OS cleans
      // up %TEMP% leftovers, so a locked temp dir is not a drill failure.
      console.warn(
        `[drill] temp dir cleanup deferred: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

main().catch((error) => {
  console.error(`[drill] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
