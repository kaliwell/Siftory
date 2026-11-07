'use strict'
// Read-only reservoir sample from existing catalog export. Catalog fixtures and
// measurements go to artifacts; source images and the live library are never written.
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const crypto = require('node:crypto')
async function main() {
  if (!process.env.SIFTORY_REAL_CATALOG) {
    throw new Error('Set SIFTORY_REAL_CATALOG to an existing read-only assets.jsonl export')
  }
  const source = path.resolve(process.env.SIFTORY_REAL_CATALOG)
  const out = fs.mkdtempSync(path.resolve('artifacts/benchmark/real-gallery-'))
  const extensions = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.gif',
    '.bmp',
    '.avif',
    '.tif',
    '.tiff',
  ])
  const pool = [],
    seen = new Set()
  const poolSize = 20000
  let seed = 220261107,
    eligible = 0,
    malformed = 0
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const input = fs.createReadStream(source)
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    let item
    try {
      item = JSON.parse(line)
    } catch {
      malformed++
      continue
    }
    const ext = path.extname(item.path || '').toLowerCase()
    if (
      item.kind !== 'image' ||
      item.missing ||
      !/^[cd]:[\\/]/i.test(item.path || '') ||
      !extensions.has(ext) ||
      !(item.width > 0 && item.height > 0) ||
      seen.has(item.path.toLowerCase())
    )
      continue
    seen.add(item.path.toLowerCase())
    eligible++
    if (pool.length < poolSize) pool.push(item)
    else {
      const slot = Math.floor(random() * eligible)
      if (slot < poolSize) pool[slot] = item
    }
  }
  const files = [],
    distribution = {},
    skipped = {}
  for (const item of pool) {
    if (files.length >= 10000) break
    try {
      const stat = fs.statSync(item.path)
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) {
        skipped.sizeOrKind = (skipped.sizeOrKind || 0) + 1
        continue
      }
      const ext = path.extname(item.path).toLowerCase()
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(item.path)).digest('hex')
      files.push({
        path: item.path,
        width: item.width,
        height: item.height,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ext,
        sha256,
      })
      distribution[ext] = (distribution[ext] || 0) + 1
    } catch {
      skipped.unavailable = (skipped.unavailable || 0) + 1
    }
    if (files.length && files.length % 1000 === 0)
      console.log(JSON.stringify({ out, selected: files.length }))
  }
  if (files.length < 10000) throw new Error('Fewer than 10000 readable real images selected')
  const testSource = fs.readFileSync('tests/asset-library.test.cjs', 'utf8')
  const begin = testSource.indexOf('async function writeSegment('),
    end = testSource.indexOf('\n}\n', begin) + 2
  if (begin < 0 || end < begin) throw new Error('Existing segment fixture writer missing')
  const writer = Function(
    'fs',
    'path',
    'return (' + testSource.slice(begin, end) + ')',
  )(fs.promises, path)
  for (const count of [1000, 5000, 10000])
    await writer(
      path.join(out, 'catalog-' + count + '.idx'),
      files.slice(0, count).map((f) => ({
        path: f.path,
        width: f.width,
        height: f.height,
        fileSize: f.size,
        modifiedTime: Math.round(f.mtimeMs),
      })),
    )
  const report = {
    scope:
      'Deterministic reservoir sample from existing real catalog, unique readable local C/D raster files <=64MiB; original files/catalog read only. Not a text relevance fixture. OS file cache warmed by source hashing.',
    sourceCatalog: source,
    eligible,
    malformed,
    skipped,
    distribution,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    files,
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(
    'artifacts/performance-real-gallery-fixture.json',
    JSON.stringify(
      { out, count: files.length, distribution, totalBytes: report.totalBytes },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify({
      out,
      count: files.length,
      distribution,
      totalMiB: report.totalBytes / 1048576,
    }),
  )
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
