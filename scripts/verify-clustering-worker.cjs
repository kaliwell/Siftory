// Read-only clustering check on the real library: runs the worker pipeline
// (pure function, no DB writes) twice and asserts deterministic output.
// Usage: node scripts/verify-clustering-worker.cjs
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
  const { getEmbeddingStorePaths } = loadTsModule('electron/vectorDatabaseService.ts')
  const { AssetMetadataStore } = loadTsModule('electron/assetMetadataStore.ts')
  const { runAssetClusteringPipeline } = loadTsModule('electron/assetClusteringWorker.ts')

  const assetStore = new AssetMetadataStore(path.join(userDataDir, 'asset-library'))
  await assetStore.ensureLoaded()
  const assets = assetStore.activePathIndexEntries()
  console.log(`[cluster] active assets: ${assets.length}`)

  const input = {
    cacheDir: path.join(userDataDir, 'vector-db', 'embedding-cache'),
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim: 768,
    sourcePaths: getEmbeddingStorePaths('dinov2_vitb14', 'global'),
    clipVectorDir: path.join(userDataDir, 'vector-db'),
    scopePaths: [],
    maxAssets: 500000,
    minClusterSize: 5,
    minSimilarity: 0.76,
    autoClusters: true,
    requestedMaxClusters: 96,
    semanticRefine: true,
    semanticSimilarity: 0.86,
    semanticMaxSplits: 4,
    assets,
  }
  const runs = []
  for (let run = 0; run < 2; run++) {
    const startedAt = Date.now()
    const result = await runAssetClusteringPipeline(
      input,
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    if (result.stopped) throw new Error('unexpected stop')
    runs.push(result)
    console.log(
      `[cluster] run ${run + 1}: ${result.viable.length} groups, ${result.memberCount} members, ` +
        `eligible=${result.eligibleCount}, centers=${result.maxClusters}+${result.residualCenterCount} residual, ` +
        `semantic=${result.semanticEmbeddedCount}/${result.semanticSplitCount} splits, ${Date.now() - startedAt}ms`,
    )
  }
  if (JSON.stringify(runs[0].viable) !== JSON.stringify(runs[1].viable)) {
    throw new Error('non-deterministic clustering output between two identical runs')
  }
  if (runs[0].viable.length === 0) throw new Error('no viable groups on the real library')
  console.log('[cluster] RESULT: deterministic; real-library pipeline OK (no writes performed)')
}

main().catch((error) => {
  console.error(`[cluster] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
