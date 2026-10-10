const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('../tests/guard-utils.cjs')

async function main() {
  const userDataPath =
    process.argv[2] || path.join(process.env.APPDATA || '', 'floating-clock-electron')
  const imageIndexPath = process.argv[3] || path.join(userDataPath, 'image-search-index')
  const { previewVectorGc } = loadTsModule('electron/vectorGcService.ts')
  const started = performance.now()
  const preview = await previewVectorGc(userDataPath, imageIndexPath)
  process.stdout.write(
    `${JSON.stringify(
      {
        elapsedMs: Math.round(performance.now() - started),
        activeAssetCount: preview.activeAssetCount,
        reclaimableBytes: preview.reclaimableBytes,
        shards: preview.shards,
      },
      null,
      2,
    )}\n`,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
