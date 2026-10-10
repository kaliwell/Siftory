// Parity check: runs the NEW worker scan (pure function, no vite build
// needed) on the real library and diffs it against the pre-worker baseline
// captured by scripts/capture-similar-baseline.cjs. Results must be identical.
// Usage: node scripts/verify-similar-worker-parity.cjs [baselineJsonPath]
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
  const baselinePath =
    process.argv[2] ||
    path.join(__dirname, '..', 'backup', 'pre-worker-migration', 'similar-baseline-4052-50.json')
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  console.log(`[parity] baseline: query=${baseline.queryAssetId} topK=${baseline.topK} hits=${baseline.hits.length}`)

  const { getEmbeddingStorePaths } = loadTsModule('electron/vectorDatabaseService.ts')
  const {
    ensureEmbeddingF16Cache,
    readEmbeddingF16VectorsForPaths,
    embeddingCachePathKey,
  } = loadTsModule('electron/embeddingF16Cache.ts')
  const { AssetMetadataStore } = loadTsModule('electron/assetMetadataStore.ts')
  const { runAssetSimilarSearchScan } = loadTsModule('electron/assetSimilarSearchWorker.ts')

  const sourcePaths = getEmbeddingStorePaths('dinov2_vitb14', 'global')
  const cacheDir = path.join(userDataDir, 'vector-db', 'embedding-cache')
  const cache = await ensureEmbeddingF16Cache({
    cacheDir,
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim: 768,
    sourcePaths,
  })
  const queryVectors = await readEmbeddingF16VectorsForPaths(cache, [baseline.queryPath])
  const queryVector = queryVectors.get(embeddingCachePathKey(baseline.queryPath))
  if (!queryVector) throw new Error('query vector not found in f16 cache')

  const assetStore = new AssetMetadataStore(path.join(userDataDir, 'asset-library'))
  await assetStore.ensureLoaded()

  const stopView = new Int32Array(new SharedArrayBuffer(4))
  const startedAt = Date.now()
  const result = await runAssetSimilarSearchScan(
    {
      cacheDir,
      modelName: 'dinov2_vitb14',
      embeddingType: 'global',
      dim: 768,
      sourcePaths,
      queryVector: Array.from(queryVector),
      topK: baseline.topK,
      excludeAssetId: baseline.queryAssetId,
      assets: assetStore.activePathIndexEntries(),
      reviewedAssetIds: [],
    },
    stopView,
    () => {},
  )
  const elapsed = Date.now() - startedAt
  if (result.stopped) throw new Error('scan unexpectedly stopped')

  const actual = [...result.candidates].sort(
    (a, b) => b.confidence - a.confidence || a.assetId - b.assetId,
  )
  console.log(
    `[parity] worker scan: ${actual.length} hits, scanned=${result.scanned}, ${elapsed}ms (baseline searchMs=${baseline.searchMs})`,
  )
  if (result.scanned !== baseline.scanned) {
    throw new Error(`scanned mismatch: worker=${result.scanned} baseline=${baseline.scanned}`)
  }
  if (actual.length !== baseline.hits.length) {
    throw new Error(`hit count mismatch: worker=${actual.length} baseline=${baseline.hits.length}`)
  }
  let mismatches = 0
  for (let index = 0; index < actual.length; index++) {
    const expected = baseline.hits[index]
    if (actual[index].assetId !== expected.assetId) {
      console.error(
        `[parity] MISMATCH at rank ${index}: worker assetId=${actual[index].assetId} (${actual[index].confidence}) baseline assetId=${expected.assetId} (${expected.score})`,
      )
      mismatches++
    } else if (Math.abs(actual[index].confidence - expected.score) > 1e-6) {
      console.error(
        `[parity] SCORE DRIFT at rank ${index} assetId=${expected.assetId}: worker=${actual[index].confidence} baseline=${expected.score}`,
      )
      mismatches++
    }
  }
  if (mismatches > 0) throw new Error(`${mismatches} mismatches against baseline`)
  console.log('[parity] RESULT: worker results are IDENTICAL to the pre-worker baseline')
}

main().catch((error) => {
  console.error(`[parity] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
