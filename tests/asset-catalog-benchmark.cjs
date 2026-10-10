const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { loadTsModule } = require('./guard-utils.cjs')

const { AssetCatalogProjection } = loadTsModule('electron/assetCatalogProjection.ts')

async function main() {
  const count = Math.max(1, Number.parseInt(process.argv[2] || '180000', 10))
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-clock-asset-catalog-'))
  try {
    const records = new Map()
    for (let index = 0; index < count; index++) {
      const id = index + 1
      records.set(id, {
        id,
        path: `D:\\pictures\\folder_${String(index % 240).padStart(3, '0')}\\asset_${String(index).padStart(6, '0')}.jpg`,
        kind: 'image',
        source: 'image_search',
        width: 1920,
        height: 1080,
        fileSize: 1000 + ((index * 7919) % 20_000_000),
        modifiedTime: index,
        missing: index % 997 === 0,
        archived: index % 2003 === 0,
        createdAt: index,
        updatedAt: index,
      })
    }

    const projection = new AssetCatalogProjection(path.join(directory, 'asset-catalog.sqlite'))
    const buildStarted = performance.now()
    await projection.replaceAll(records, `benchmark-${count}`)
    const buildMs = performance.now() - buildStarted

    const measure = (request, iterations = 10) => {
      const timings = []
      let result
      for (let index = 0; index < iterations; index++) {
        const started = performance.now()
        result = projection.list(request)
        timings.push(performance.now() - started)
      }
      timings.sort((left, right) => left - right)
      return {
        medianMs: Number(timings[Math.floor(timings.length / 2)].toFixed(2)),
        maxMs: Number(timings[timings.length - 1].toFixed(2)),
        total: result.total,
        returned: result.records.length,
      }
    }

    const updatedPage = measure({ offset: 0, limit: 100, sort: 'updated_desc' })
    const deepNamePage = measure({
      offset: Math.floor(count / 2),
      limit: 100,
      sort: 'name_asc',
    })
    const pathQuery = measure({
      offset: 0,
      limit: 100,
      sort: 'updated_desc',
      query: 'folder_017',
    })
    const databaseStat = await fs.stat(path.join(directory, 'asset-catalog.sqlite'))
    console.log(
      JSON.stringify(
        {
          records: count,
          buildMs: Number(buildMs.toFixed(2)),
          databaseBytes: databaseStat.size,
          databaseMiB: Number((databaseStat.size / 1024 / 1024).toFixed(2)),
          updatedPage,
          deepNamePage,
          pathQuery,
        },
        null,
        2,
      ),
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
