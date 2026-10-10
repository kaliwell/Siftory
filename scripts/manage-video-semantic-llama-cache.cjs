#!/usr/bin/env node

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const {
  ARTIFACTS,
  cachePathFor,
  defaultCacheRoot,
} = require('./install-video-semantic-llama-runtime.cjs')
const { verifyFile } = require('./fetch-runtime-resources.cjs')

async function inspectCache(cacheRoot = defaultCacheRoot()) {
  const entries = []
  for (const artifact of Object.values(ARTIFACTS)) {
    const result = await verifyFile(cachePathFor(cacheRoot, artifact), artifact)
    entries.push({
      id: artifact.id,
      expectedBytes: artifact.sizeBytes,
      state: result.ok ? 'verified' : result.reason,
    })
  }
  const shaRoot = path.join(cacheRoot, 'sha256')
  const names = fs.existsSync(shaRoot) ? await fsp.readdir(shaRoot) : []
  const known = new Set(Object.values(ARTIFACTS).map((artifact) => `${artifact.sha256}.blob`))
  return {
    schemaVersion: 1,
    entries,
    verified: entries.filter((entry) => entry.state === 'verified').length,
    invalid: entries.filter((entry) => !['verified', 'missing'].includes(entry.state)).length,
    partialFiles: names.filter((name) => name.endsWith('.partial')),
    unknownFiles: names.filter((name) => !known.has(name) && !name.endsWith('.partial')).length,
  }
}

async function cleanupInvalidCache(cacheRoot = defaultCacheRoot()) {
  const resolvedRoot = path.resolve(cacheRoot)
  const shaRoot = path.resolve(resolvedRoot, 'sha256')
  if (!shaRoot.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Unsafe cache root')
  const before = await inspectCache(resolvedRoot)
  const removed = []
  for (const name of before.partialFiles) {
    const target = path.resolve(shaRoot, name)
    if (!target.startsWith(`${shaRoot}${path.sep}`)) throw new Error('Unsafe cache entry')
    await fsp.rm(target, { force: true })
    removed.push(name)
  }
  for (const artifact of Object.values(ARTIFACTS)) {
    const target = cachePathFor(resolvedRoot, artifact)
    const result = await verifyFile(target, artifact)
    if (!result.ok && result.reason !== 'missing') {
      await fsp.rm(target, { force: true })
      removed.push(path.basename(target))
    }
  }
  return { removed: removed.length, after: await inspectCache(resolvedRoot) }
}

async function main() {
  const cleanup = process.argv.includes('--cleanup-invalid')
  const report = cleanup ? await cleanupInvalidCache() : await inspectCache()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!cleanup && report.invalid > 0) process.exitCode = 1
}

if (require.main === module)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
module.exports = { cleanupInvalidCache, inspectCache }
