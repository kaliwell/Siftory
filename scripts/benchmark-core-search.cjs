// Deterministic, model-free catalog/search measurement. Never opens a user profile.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('../tests/guard-utils.cjs')
const { DiscoveryCatalogDatabase } = loadTsModule('electron/discoveryCatalogDatabase.ts')
const { UnifiedSearchService } = loadTsModule('electron/unifiedSearchService.ts')

async function main() {
  const parent = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(parent, 'siftory-core-benchmark-'))
  const database = new DiscoveryCatalogDatabase(path.join(directory, 'catalog.sqlite'))
  try {
    database.insertSource(
      {
        id: 'fixture',
        type: 'local-generic',
        displayName: 'Synthetic benchmark',
        rootLocator: directory,
        readOnly: true,
        availability: 'online',
        scanCapability: 'directory',
      },
      1,
    )
    const entries = Array.from({ length: 6001 }, (_, index) => {
      const name = `match-${String(index).padStart(5, '0')}.${index === 6000 ? 'mp4' : 'jpg'}`
      return {
        absolutePath: path.join(directory, name),
        relativePath: name,
        name,
        extension: index === 6000 ? 'mp4' : 'jpg',
        sizeBytes: 100,
        modifiedAt: index,
      }
    })
    const start = performance.now()
    database.upsertDiscoveredBatch('fixture', null, entries, 1)
    const buildMs = performance.now() - start
    const service = new UnifiedSearchService({
      lexicalRecall: (request) =>
        database.queryCatalog({
          query: request.query,
          offset: request.offset,
          limit: request.limit,
          mediaTypes: request.filters?.mediaTypes,
          modifiedAfter: request.filters?.modifiedAfter,
        }),
    })
    const cases = [
      { name: 'filename', request: { query: 'match', limit: 100 }, expected: 6001 },
      {
        name: 'video-after-6000-images',
        request: { query: 'match', filters: { mediaTypes: ['video'] } },
        expected: 1,
      },
      {
        name: 'modified-range',
        request: { query: 'match', filters: { modifiedAfter: 5990 } },
        expected: 11,
      },
    ]
    const results = []
    for (const item of cases) {
      await service.search(item.request) // warmup excluded from measurement
      const samples = []
      for (let index = 0; index < 31; index++) {
        const started = performance.now()
        const result = await service.search(item.request)
        if (result.total !== item.expected) throw new Error(`Incorrect result: ${item.name}`)
        samples.push(performance.now() - started)
      }
      samples.sort((a, b) => a - b)
      results.push({
        name: item.name,
        samples: samples.length,
        p50Ms: samples[15],
        p95Ms: samples[29],
      })
    }
    const environment = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      memoryBytes: os.totalmem(),
    }
    const report = {
      schemaVersion: 1,
      fixtureVersion: 'catalog-6001-v1',
      synthetic: true,
      generatedAt: new Date().toISOString(),
      environment,
      comparabilityKey: crypto
        .createHash('sha256')
        .update(JSON.stringify(environment))
        .digest('hex'),
      buildMs,
      results,
      memory: process.memoryUsage(),
      scope:
        'Catalog SQL and unified lexical/filter path only; excludes Native scan, models, GPU, real disk/NAS and installer acceptance.',
    }
    const output = path.resolve(__dirname, '../artifacts/benchmark/core-search/latest.json')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ ok: true, output, buildMs, results }, null, 2))
  } finally {
    database.close()
    if (
      path.dirname(fs.realpathSync(directory)) !== parent ||
      !path.basename(directory).startsWith('siftory-core-benchmark-')
    ) {
      console.error('Refusing benchmark cleanup outside its temporary directory')
      process.exitCode = 1
    } else fs.rmSync(directory, { recursive: true, force: true })
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
module.exports = { main }
