const path = require('node:path')
const { loadTsModule } = require('../tests/guard-utils.cjs')

// Manifest-aware Image Search orphan segment/staging cleanup.
// Read-only by default; pass --execute to delete the previewed orphans
// (the manifest is re-verified before every delete and a report is written).
//
// Usage: node scripts/image-search-orphan-cleanup.cjs [userDataPath] [--execute]

async function main() {
  const execute = process.argv.includes('--execute')
  const args = process.argv.slice(2).filter((arg) => arg !== '--execute')
  const userDataPath = args[0] || path.join(process.env.APPDATA || '', 'floating-clock-electron')
  const indexDir = path.join(userDataPath, 'image-search-index')

  const { previewIndexOrphanCleanup, executeIndexOrphanCleanup } = loadTsModule(
    'electron/imageSearchIndexOrphans.ts',
  )
  const preview = await previewIndexOrphanCleanup(indexDir)
  if (!preview) {
    console.error('Image Search manifest is missing or unreadable; cleanup aborted (fail-closed)')
    process.exitCode = 1
    return
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        referencedSegments: preview.referencedCount,
        orphanFiles: preview.orphans.length,
        orphanBytes: preview.totalBytes,
        orphans: preview.orphans.map((orphan) => ({
          path: path.relative(indexDir, orphan.path),
          sizeBytes: orphan.sizeBytes,
          mtime: new Date(orphan.mtimeMs).toISOString(),
        })),
      },
      null,
      2,
    )}\n`,
  )
  if (!execute) return
  const result = await executeIndexOrphanCleanup(preview)
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: result.ok,
        error: result.error,
        deletedFiles: result.deletedFiles,
        deletedBytes: result.deletedBytes,
        skipped: result.skipped,
        errors: result.errors,
        reportPath: result.reportPath,
      },
      null,
      2,
    )}\n`,
  )
  if (!result.ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
