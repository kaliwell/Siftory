const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  clusterStats,
  ensureLineageKey,
  normalizeClusterScopePaths,
  pathMatchesClusterScope,
} = loadTsModule('electron/assetClusterUtilities.ts')

test('cluster scopes trim, resolve, de-duplicate, and remove empty paths', () => {
  const first = path.join(process.cwd(), 'scope-a')
  const second = path.join(process.cwd(), 'scope-b')
  assert.deepEqual(normalizeClusterScopePaths([`  ${first}  `, first, '', '  ', second]), [
    path.resolve(first),
    path.resolve(second),
  ])
  assert.deepEqual(normalizeClusterScopePaths(undefined), [])
})

test('cluster scope matching accepts roots and descendants without prefix escapes', () => {
  const root = path.resolve('library')
  assert.equal(pathMatchesClusterScope(root, [root]), true)
  assert.equal(pathMatchesClusterScope(path.join(root, 'nested', 'asset.jpg'), [root]), true)
  assert.equal(pathMatchesClusterScope(path.resolve('library-other', 'asset.jpg'), [root]), false)
  assert.equal(pathMatchesClusterScope(path.resolve('anywhere', 'asset.jpg'), []), true)
})

test('cluster stats handle empty and populated member sets', () => {
  assert.deepEqual(clusterStats([]), { assetCount: 0, avgSimilarity: 0 })
  assert.deepEqual(clusterStats([{ similarity: 0.5 }, { similarity: 1 }]), {
    assetCount: 2,
    avgSimilarity: 0.75,
  })
})

test('cluster lineage keys preserve explicit identity and provide a stable fallback', () => {
  assert.equal(ensureLineageKey({ id: 7, lineageKey: 'manual-7' }), 'manual-7')
  assert.equal(ensureLineageKey({ id: 42 }), 'lg-42')
})
