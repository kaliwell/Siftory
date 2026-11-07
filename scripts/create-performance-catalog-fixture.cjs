'use strict'
const fs = require('fs'),
  path = require('path')
;(async () => {
  const fixture = path.resolve('artifacts/benchmark/image-fixture-20261107'),
    manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'manifest.json')))
  const source = fs.readFileSync('tests/asset-library.test.cjs', 'utf8')
  const start = source.indexOf('async function writeSegment('),
    end = source.indexOf('\n}\n', start) + 2
  if (start < 0 || end < start) throw new Error('Existing fixture writer not found')
  const writer = Function(
    'fs',
    'path',
    'return (' + source.slice(start, end) + ')',
  )(fs.promises, path)
  for (const count of [1000, 5000, 10000]) {
    const records = manifest.files.slice(0, count).map(({ name }) => {
      const file = path.join(fixture, name),
        stat = fs.statSync(file)
      return {
        path: file,
        width: 1200,
        height: 800,
        fileSize: stat.size,
        modifiedTime: Math.round(stat.mtimeMs),
      }
    })
    await writer(path.join(fixture, 'catalog-' + count + '.idx'), records)
    console.log(
      JSON.stringify({
        catalog: count,
        scope:
          'Catalog metadata fixture only; established test segment writer; generated source images unchanged; not a valid search accuracy fixture.',
      }),
    )
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
