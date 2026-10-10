// One-shot write-path drill against the REAL asset library in sqlite mode:
// create a category -> delete it (writes the deletion trash) -> undo the
// delete, checking table counts at every step. Exercises withSqliteWrite on
// the real database; net effect is one restored trash record, same as a user
// clicking through the UI. Usage: node scripts/drill-sqlite-write.cjs
const path = require('node:path')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const userDataDir = path.join(process.env.APPDATA, 'floating-clock-electron')

async function main() {
  const {
    initAssetLibraryService,
    getAssetLibraryStorageMode,
    createAssetCategory,
    deleteAssetCategory,
    listAssetCategories,
    listAssetMetadataDeletions,
    restoreAssetMetadataDeletion,
  } = loadTsModule('electron/assetLibraryService.ts')

  initAssetLibraryService(userDataDir, { storageMode: 'sqlite' })
  if (getAssetLibraryStorageMode() !== 'sqlite') {
    throw new Error(`expected sqlite mode, got ${getAssetLibraryStorageMode()}`)
  }

  const before = listAssetCategories().length
  const trashBefore = listAssetMetadataDeletions().total
  console.log(`[drill] before: categories=${before} trash=${trashBefore}`)

  const category = await createAssetCategory({ name: 'sqlite-write-drill' })
  if (listAssetCategories().length !== before + 1) {
    throw new Error('category count did not increase after create')
  }
  console.log(`[drill] created category id=${category.id}`)

  const deleted = await deleteAssetCategory(category.id)
  if (!deleted.ok) throw new Error(`delete failed: ${deleted.error}`)
  if (listAssetCategories().length !== before) {
    throw new Error('category count did not return after delete')
  }
  const trashAfterDelete = listAssetMetadataDeletions().total
  if (trashAfterDelete !== trashBefore + 1) {
    throw new Error(`expected trash ${trashBefore + 1}, got ${trashAfterDelete}`)
  }
  console.log(`[drill] deleted; trash=${trashAfterDelete}`)

  const pending = listAssetMetadataDeletions({ status: 'pending' })
  const record = pending.items.find((item) => item.kind === 'category')
  if (!record) throw new Error('no pending category deletion record found')
  const restored = await restoreAssetMetadataDeletion(record.id)
  if (!restored.ok) throw new Error(`undo failed: ${restored.error}`)
  if (listAssetCategories().length !== before + 1) {
    throw new Error('category was not restored by undo')
  }
  console.log(`[drill] undo restored category "${listAssetCategories().at(-1)?.name}"`)

  // Clean up the drill category so the library is left as it was found
  // (one pending trash record remains and can be purged from the UI).
  const drillCategory = listAssetCategories().find((item) => item.name === 'sqlite-write-drill')
  if (!drillCategory) throw new Error('restored drill category not found')
  const cleanup = await deleteAssetCategory(drillCategory.id)
  if (!cleanup.ok) throw new Error(`cleanup delete failed: ${cleanup.error}`)
  console.log(
    `[drill] cleanup deleted; final categories=${listAssetCategories().length} trash=${listAssetMetadataDeletions().total}`,
  )
  console.log('[drill] RESULT: sqlite write path (create/delete/undo) works on the real library')
}

main().catch((error) => {
  console.error(`[drill] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
