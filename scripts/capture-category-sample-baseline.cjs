// Captures the current (pre-worker) Category Sample Search results on the REAL
// library so the worker-based implementation can be diffed for parity.
// Usage: node scripts/capture-category-sample-baseline.cjs [categoryId] [topK] [outName]
// Defaults: categoryId=12 (test01), topK=50, includeReviewed=false.
// Read-only against the real library: the search itself only reads; a stale
// feedback model may be rebuilt first (normal flow, same before/after).
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

  const categoryId = Number(process.argv[2] || 12)
  const topK = Number(process.argv[3] || 50)
  const outName = process.argv[4] || `category-sample-baseline-${categoryId}-${topK}.json`
  console.log(`[baseline] categoryId=${categoryId} topK=${topK} includeReviewed=false`)

  const started = svc.startCategorySampleSearch({ categoryId, topK })
  if (!started.ok) throw new Error(`search rejected: ${started.error}`)

  const deadline = Date.now() + 20 * 60 * 1000
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const results = svc.getCategorySampleSearchResults(categoryId)
    if (results) {
      const payload = {
        categoryId: results.categoryId,
        categoryName: results.categoryName,
        topK: results.topK,
        includeReviewed: results.includeReviewed,
        scanned: results.scanned,
        returned: results.returned,
        searchMode: results.searchMode,
        dinoCandidateCount: results.dinoCandidateCount,
        dinoPositiveSampleCount: results.dinoPositiveSampleCount,
        dinoNegativeSampleCount: results.dinoNegativeSampleCount,
        dinoCacheVectorCount: results.dinoCacheVectorCount,
        positiveSampleCount: results.positiveSampleCount,
        negativeSampleCount: results.negativeSampleCount,
        feedbackRevision: results.feedbackRevision,
        feedbackStale: results.feedbackStale,
        searchMs: results.searchMs,
        hits: results.hits.map((hit) => ({
          assetId: hit.item.asset.id,
          score: hit.score,
          positiveScore: hit.positiveScore,
          negativeScore: hit.negativeScore,
          reviewState: hit.reviewState,
        })),
      }
      fs.mkdirSync(outDir, { recursive: true })
      const outPath = path.join(outDir, outName)
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2))
      console.log(
        `[baseline] captured ${payload.returned} hits (scanned=${payload.scanned}, mode=${payload.searchMode}, ${payload.searchMs}ms) -> ${outPath}`,
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
