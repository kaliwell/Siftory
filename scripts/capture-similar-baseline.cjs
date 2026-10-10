// Captures the current (pre-worker) Similar Search results on the REAL library
// so the worker-based implementation can be diffed for parity afterwards.
// Usage: node scripts/capture-similar-baseline.cjs [assetId] [topK]
// Runs the search through the real service, writes hits to
// backup/pre-worker-migration/similar-baseline-<assetId>-<topK>.json
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const userDataDir = path.join(process.env.APPDATA, 'floating-clock-electron')

// The service imports 'electron' for app.getPath; stub it like the annotation
// tool does (tests/neko-search-annotation.cjs loadElectronModules).
const electronStub = {
  app: {
    getPath: (name) => (name === 'userData' ? userDataDir : path.join(userDataDir, name)),
  },
}
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub
  return originalLoad.call(this, request, parent, isMain)
}

const { loadTsModule } = require('../tests/guard-utils.cjs')

const outDir = path.join(__dirname, '..', 'backup', 'pre-worker-migration')

async function main() {
  const svc = loadTsModule('electron/assetLibraryService.ts')
  svc.initAssetLibraryService(userDataDir, { storageMode: 'sqlite' })

  let assetId = Number(process.argv[2])
  const topK = Number(process.argv[3] || 50)
  if (!Number.isInteger(assetId) || assetId <= 0) {
    // Default: the first confirmed test01 (id=12) asset.
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(path.join(userDataDir, 'asset-library', 'asset-library.sqlite'), {
      readOnly: true,
    })
    try {
      assetId = db
        .prepare(
          'SELECT asset_id AS id FROM asset_categories WHERE category_id = 12 ORDER BY asset_id LIMIT 1',
        )
        .get().id
    } finally {
      db.close()
    }
  }
  console.log(`[baseline] query assetId=${assetId} topK=${topK}`)

  const started = svc.startAssetSimilarSearch({ assetId, topK, includeReviewed: true })
  if (!started.ok) throw new Error(`search rejected: ${started.error}`)

  const deadline = Date.now() + 15 * 60 * 1000
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const results = svc.getAssetSimilarSearchResults()
    if (results && results.queryAssetId === assetId) {
      const payload = {
        queryAssetId: results.queryAssetId,
        queryPath: results.queryPath,
        topK: results.topK,
        includeReviewed: results.includeReviewed,
        scanned: results.scanned,
        returned: results.returned,
        searchMs: results.searchMs,
        hits: results.hits.map((hit) => ({ assetId: hit.item.asset.id, score: hit.score })),
      }
      fs.mkdirSync(outDir, { recursive: true })
      const outPath = path.join(outDir, `similar-baseline-${assetId}-${topK}.json`)
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2))
      console.log(
        `[baseline] captured ${payload.returned} hits (scanned=${payload.scanned}, ${payload.searchMs}ms) -> ${outPath}`,
      )
      return
    }
    const progress = svc.getAssetLibraryTaskProgress()
    if (progress && progress.state === 'error') {
      throw new Error(`search failed: ${progress.error || progress.message}`)
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for search results')
  }
}

main().catch((error) => {
  console.error(`[baseline] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
