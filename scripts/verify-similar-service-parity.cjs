// Service-level integration check: runs startAssetSimilarSearch through the
// real service (which now spawns the worker thread) and diffs the hits
// against the pre-worker baseline. Usage: node scripts/verify-similar-service-parity.cjs
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const userDataDir = path.join(process.env.APPDATA, 'floating-clock-electron')
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

async function main() {
  const baseline = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', 'backup', 'pre-worker-migration', 'similar-baseline-4052-50.json'),
      'utf8',
    ),
  )
  const svc = loadTsModule('electron/assetLibraryService.ts')
  svc.initAssetLibraryService(userDataDir, { storageMode: 'sqlite' })

  const started = svc.startAssetSimilarSearch({
    assetId: baseline.queryAssetId,
    topK: baseline.topK,
    includeReviewed: baseline.includeReviewed,
  })
  if (!started.ok) throw new Error(`search rejected: ${started.error}`)

  const deadline = Date.now() + 15 * 60 * 1000
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const results = svc.getAssetSimilarSearchResults()
    if (results && results.queryAssetId === baseline.queryAssetId) {
      const actual = results.hits.map((hit) => ({ assetId: hit.item.asset.id, score: hit.score }))
      console.log(
        `[svc-parity] got ${actual.length} hits, scanned=${results.scanned}, ${results.searchMs}ms (baseline ${baseline.searchMs}ms)`,
      )
      if (results.scanned !== baseline.scanned) {
        throw new Error(`scanned mismatch: ${results.scanned} vs ${baseline.scanned}`)
      }
      if (actual.length !== baseline.hits.length) {
        throw new Error(`hit count mismatch: ${actual.length} vs ${baseline.hits.length}`)
      }
      for (let index = 0; index < actual.length; index++) {
        if (
          actual[index].assetId !== baseline.hits[index].assetId ||
          Math.abs(actual[index].score - baseline.hits[index].score) > 1e-6
        ) {
          throw new Error(
            `mismatch at rank ${index}: ${JSON.stringify(actual[index])} vs ${JSON.stringify(baseline.hits[index])}`,
          )
        }
      }
      console.log('[svc-parity] RESULT: service+worker results are IDENTICAL to baseline')
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
  console.error(`[svc-parity] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
