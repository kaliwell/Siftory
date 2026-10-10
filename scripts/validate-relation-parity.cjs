// Read-only parity check for the real asset library: compares every relation
// table inside asset-library.sqlite against the authoritative JSONL files.
// Usage: node scripts/validate-relation-parity.cjs [assetLibraryDir]
// Exit code 0 = all tables identical, 1 = mismatch or database missing.
const path = require('node:path')
const fs = require('node:fs')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const assetLibraryDir =
  process.argv[2] ||
  path.join(process.env.APPDATA, 'floating-clock-electron', 'asset-library')

const sqliteFile = path.join(assetLibraryDir, 'asset-library.sqlite')
if (!fs.existsSync(sqliteFile)) {
  console.error(`[parity] FAIL: ${sqliteFile} does not exist (dual mode has not run here yet)`)
  process.exit(1)
}

const { AssetLibraryDatabase } = loadTsModule('electron/assetLibraryDatabase.ts')

const db = new AssetLibraryDatabase(assetLibraryDir)
db.open()
try {
  const report = db.verifyAgainstJsonl()
  const names = Object.keys(report.tables)
  console.log(`[parity] library: ${assetLibraryDir}`)
  console.log(`[parity] tables: ${names.length}`)
  for (const name of names) {
    const t = report.tables[name]
    const status = t.ok ? 'OK  ' : 'FAIL'
    console.log(
      `[parity] ${status} ${name}: jsonl=${t.expectedCount} sqlite=${t.actualCount} badLines=${t.sourceBadLines} hashMatch=${t.expectedHash === t.actualHash}`,
    )
  }
  if (!report.ok) {
    console.error('[parity] RESULT: MISMATCH')
    process.exit(1)
  }
  console.log('[parity] RESULT: ALL TABLES IDENTICAL')
} finally {
  db.close()
}
