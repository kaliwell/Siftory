// Relation pagination benchmark for the SQL read path (migration stage 2).
// Synthesizes a large library, boots the service in sqlite mode and times the
// SQL-backed relation reads. Usage: node tests/asset-relation-benchmark.cjs [assetCount]
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  getAssetLibraryShadowDatabase,
  getAssetLibraryStats,
  initAssetLibraryService,
  listAssetClusters,
  listAssetLibraryAssets,
  listAssetSuggestions,
} = loadTsModule('electron/assetLibraryService.ts')

const TARGETS = {
  categoryFilterPage: 300,
  suggestionsPage: 50,
  stats: 100,
  clusters: 50,
}

function writeJsonl(filePath, count, build) {
  const parts = new Array(count)
  for (let index = 0; index < count; index++) parts[index] = JSON.stringify(build(index + 1))
  fs.writeFileSync(filePath, `${parts.join('\n')}\n`, 'utf8')
}

async function main() {
  const assetCount = Math.max(1, Number.parseInt(process.argv[2] || '187000', 10))
  const categoryCount = 50
  const tagCount = 20
  const groupCount = 200
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asset-relation-benchmark-'))
  try {
    const assetDir = path.join(dir, 'asset-library')
    fs.mkdirSync(assetDir, { recursive: true })

    const setupStarted = performance.now()
    writeJsonl(path.join(assetDir, 'assets.jsonl'), assetCount, (id) => ({
      id,
      path: `D:/bench-assets/folder_${String(id % 240).padStart(3, '0')}/asset_${id}.jpg`,
      kind: 'image',
      source: 'image_search',
      width: 1920,
      height: 1080,
      fileSize: 1000 + ((id * 7919) % 20_000_000),
      modifiedTime: id,
      missing: id % 997 === 0,
      createdAt: id,
      updatedAt: id,
    }))
    fs.writeFileSync(path.join(assetDir, 'state.json'), `{"nextId":${assetCount + 1}}`, 'utf8')
    writeJsonl(path.join(assetDir, 'categories.jsonl'), categoryCount, (id) => ({
      id,
      name: `category-${id}`,
      description: '',
      parentId: null,
      color: '#53c7a2',
      icon: 'folder',
      sortOrder: id,
      createdAt: id,
      updatedAt: id,
    }))
    writeJsonl(path.join(assetDir, 'tags.jsonl'), tagCount, (id) => ({
      id,
      name: `tag-${id}`,
      color: '#f0b35d',
      createdAt: id,
      updatedAt: id,
    }))
    writeJsonl(path.join(assetDir, 'asset_categories.jsonl'), 100_000, (id) => ({
      id,
      assetId: ((id * 37) % assetCount) + 1,
      categoryId: (id % categoryCount) + 1,
      confidence: 0.9,
      source: 'manual',
      status: id % 5 === 0 ? 'suggested' : 'confirmed',
      confirmedByUser: true,
      createdAt: id,
      updatedAt: id,
    }))
    writeJsonl(path.join(assetDir, 'suggestions.jsonl'), 50_000, (id) => ({
      id,
      assetId: ((id * 53) % assetCount) + 1,
      ...(id % 2 === 0
        ? { categoryId: (id % categoryCount) + 1 }
        : { tagId: (id % tagCount) + 1 }),
      confidence: ((id * 13) % 100) / 100,
      source: id % 2 === 0 ? 'reference_image' : 'text_label',
      status: id % 3 === 0 ? 'low_confidence' : 'suggested',
      evidenceAssetIds: [],
      createdAt: id,
      updatedAt: id,
    }))
    writeJsonl(path.join(assetDir, 'cluster_groups.jsonl'), groupCount, (id) => ({
      id,
      name: `group-${id}`,
      algorithm: 'compressed_kmeans',
      status: 'suggested',
      assetCount: 500,
      avgSimilarity: 0.8,
      representativeAssetId: id,
      createdAt: id,
      updatedAt: id,
    }))
    writeJsonl(path.join(assetDir, 'cluster_group_assets.jsonl'), 100_000, (id) => ({
      id,
      clusterGroupId: (id % groupCount) + 1,
      assetId: ((id * 29) % assetCount) + 1,
      similarity: 0.5 + ((id * 7) % 50) / 100,
      createdAt: id,
    }))

    initAssetLibraryService(dir, { storageMode: 'sqlite' })
    const setupMs = performance.now() - setupStarted

    const measure = async (fn, iterations = 20) => {
      // Warmup (JIT + caches + first-touch effects), not measured.
      for (let index = 0; index < 6; index++) await fn()
      const timings = []
      let result
      for (let index = 0; index < iterations; index++) {
        const started = performance.now()
        result = await fn()
        timings.push(performance.now() - started)
      }
      timings.sort((left, right) => left - right)
      return {
        medianMs: Number(timings[Math.floor(timings.length / 2)].toFixed(2)),
        p95Ms: Number(timings[Math.floor((timings.length - 1) * 0.95)].toFixed(2)),
        maxMs: Number(timings[timings.length - 1].toFixed(2)),
        returned: Array.isArray(result) ? result.length : (result.items?.length ?? result.total),
      }
    }

    const categoryFilterPage = await measure(() =>
      listAssetLibraryAssets({ categoryId: 7, limit: 80, offset: 0 }),
    )
    const suggestionsPage = await measure(() =>
      listAssetSuggestions({ status: 'suggested', limit: 80, offset: 800 }),
    )
    const stats = await measure(() => getAssetLibraryStats())
    const clusters = await measure(() => listAssetClusters())

    const report = {
      assets: assetCount,
      relationRows: { assetCategories: 100_000, suggestions: 50_000, clusterMembers: 100_000 },
      setupMs: Number(setupMs.toFixed(2)),
      categoryFilterPage,
      suggestionsPage,
      stats,
      clusters,
    }
    console.log(JSON.stringify(report, null, 2))
    console.log('\ntarget comparison (p95Ms):')
    for (const [name, target] of Object.entries(TARGETS)) {
      const actual = report[name].p95Ms
      console.log(`  ${actual <= target ? 'PASS' : 'FAIL'} ${name}: ${actual}ms (target < ${target}ms)`)
    }
  } finally {
    try {
      getAssetLibraryShadowDatabase()?.close()
    } catch {
      // best effort cleanup
    }
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
