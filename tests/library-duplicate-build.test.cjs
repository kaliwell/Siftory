// Integration tests for library duplicate-group build + persistence
// (路线图 24 阶段 A): buildLibraryDuplicateGroups scans the authoritative
// asset path list, groups exact duplicates (SHA-256), and replaces
// algorithm='duplicate_exact' cluster groups atomically.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  initAssetLibraryService,
  buildLibraryDuplicateGroups,
  buildLibraryNearDuplicateGroups,
  getAssetLibraryTaskProgress,
  listAssetClusters,
  applyDuplicateGroup,
  restoreAssetLibraryAssets,
  getAssetLibraryStats,
  getAssetLibraryShadowDatabase,
} = loadTsModule('electron/assetLibraryService.ts')

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-clock-dup-build-'))
  try {
    await run(dir)
  } finally {
    try {
      getAssetLibraryShadowDatabase()?.close()
    } catch {
      /* best effort */
    }
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function waitTask(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const progress = getAssetLibraryTaskProgress()
    if (progress && progress.state !== 'running') return progress
    if (Date.now() > deadline) throw new Error('task did not finish in time')
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function seedLibrary(dir) {
  const libDir = path.join(dir, 'asset-library')
  await fs.mkdir(libDir, { recursive: true })
  const files = {
    'a1.jpg': 'AAAA-content',
    'a2.jpg': 'AAAA-content',
    'b1.jpg': 'BBBB-unique',
    'c1.jpg': 'CCCC-content',
    'c2.jpg': 'CCCC-content',
    'c3.jpg': 'CCCC-content',
    'missing.jpg': null, // referenced but absent on disk
  }
  const records = []
  let id = 1
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(libDir, name)
    if (content !== null) await fs.writeFile(p, content)
    records.push({
      id: id++,
      path: p,
      width: 10,
      height: 10,
      fileSize: content ? content.length : 10,
      modifiedTime: 1,
      diffHash64: '0',
      dctHash64: '0',
      kind: 'image',
      source: 'test',
      missing: content === null,
      createdAt: 1,
      updatedAt: 1,
    })
  }
  await fs.writeFile(
    path.join(libDir, 'assets.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
  )
  await fs.writeFile(path.join(libDir, 'state.json'), `{"nextId":${id}}`)
  return records
}

function duplicateGroups(summaries) {
  return summaries.filter((s) => s.group.algorithm === 'duplicate_exact')
}

function nearDuplicateGroups(summaries) {
  return summaries.filter((s) => s.group.algorithm === 'duplicate_near')
}

const lowBits = (bits) => ((1n << BigInt(bits)) - 1n).toString(16).padStart(16, '0')

async function seedHashLibrary(dir) {
  const libDir = path.join(dir, 'asset-library')
  await fs.mkdir(libDir, { recursive: true })
  const hashes = [
    '0000000000000000', // 1: group A
    lowBits(5), // 2: dist 5 to 1 → group A
    'ffffffffffffffff', // 3: far away
    '0', // 4: invalid hash → filtered
  ]
  const records = hashes.map((h, i) => ({
    id: i + 1,
    path: path.join(libDir, `h${i + 1}.jpg`),
    width: 10,
    height: 10,
    fileSize: 10,
    modifiedTime: 1,
    diffHash64: h,
    dctHash64: '0',
    kind: 'image',
    source: 'test',
    missing: false,
    createdAt: 1,
    updatedAt: 1,
  }))
  await fs.writeFile(
    path.join(libDir, 'assets.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
  )
  await fs.writeFile(path.join(libDir, 'state.json'), `{"nextId":${hashes.length + 1}}`)
}

test('buildLibraryDuplicateGroups groups exact duplicates and persists them', async () => {
  await withTempDir(async (dir) => {
    await seedLibrary(dir)
    initAssetLibraryService(dir)

    const started = buildLibraryDuplicateGroups()
    assert.equal(started.ok, true, started.error)
    const progress = await waitTask()
    assert.equal(progress.state, 'done', progress.error || progress.message)

    const clusters = await listAssetClusters()
    const dups = duplicateGroups(clusters)
    assert.equal(dups.length, 2)
    const sizes = dups.map((d) => d.group.assetCount).sort((a, b) => a - b)
    assert.deepEqual(sizes, [2, 3])
    // representative = earliest-ingested copy
    for (const d of dups) {
      const memberIds = d.previewAssets.map((p) => p.asset.id)
      assert.ok(memberIds.includes(d.group.representativeAssetId))
    }
  })
})

test('rebuild replaces duplicate_exact groups idempotently', async () => {
  await withTempDir(async (dir) => {
    await seedLibrary(dir)
    initAssetLibraryService(dir)

    assert.equal(buildLibraryDuplicateGroups().ok, true)
    assert.equal((await waitTask()).state, 'done')
    const first = duplicateGroups(await listAssetClusters())
    assert.equal(first.length, 2)

    assert.equal(buildLibraryDuplicateGroups().ok, true)
    assert.equal((await waitTask()).state, 'done')
    const second = duplicateGroups(await listAssetClusters())
    assert.equal(second.length, 2)
    assert.deepEqual(
      second.map((d) => d.group.assetCount).sort(),
      first.map((d) => d.group.assetCount).sort(),
    )
  })
})

test('missing files are skipped without failing the build', async () => {
  await withTempDir(async (dir) => {
    await seedLibrary(dir)
    // remove one duplicate member so group A degenerates to a single file
    await fs.unlink(path.join(dir, 'asset-library', 'a2.jpg'))
    initAssetLibraryService(dir)

    assert.equal(buildLibraryDuplicateGroups().ok, true)
    assert.equal((await waitTask()).state, 'done')
    const dups = duplicateGroups(await listAssetClusters())
    assert.equal(dups.length, 1)
    assert.equal(dups[0].group.assetCount, 3)
  })
})

test('applyDuplicateGroup archives non-representative copies and is restorable', async () => {
  await withTempDir(async (dir) => {
    await seedLibrary(dir)
    initAssetLibraryService(dir)

    assert.equal(buildLibraryDuplicateGroups().ok, true)
    assert.equal((await waitTask()).state, 'done')
    const dups = duplicateGroups(await listAssetClusters())
    const three = dups.find((d) => d.group.assetCount === 3)
    assert.ok(three)

    // wrong group type rejected
    const notDup = await applyDuplicateGroup(999999)
    assert.equal(notDup.ok, false)

    const applied = await applyDuplicateGroup(three.group.id)
    assert.equal(applied.ok, true, applied.error)
    assert.equal(applied.archived, 2)

    // representative stays active, group marked confirmed
    const stats = await getAssetLibraryStats()
    assert.equal(stats.archivedAssets, 2)
    const after = duplicateGroups(await listAssetClusters())
    const updated = after.find((d) => d.group.id === three.group.id)
    assert.equal(updated?.group.status, 'confirmed')

    // second apply rejected
    const again = await applyDuplicateGroup(three.group.id)
    assert.equal(again.ok, false)

    // soft archive is fully restorable
    const rep = three.group.representativeAssetId
    const archivedIds = three.previewAssets.map((p) => p.asset.id).filter((id) => id !== rep)
    const restored = await restoreAssetLibraryAssets(archivedIds)
    assert.equal(restored.ok, true)
    assert.equal((await getAssetLibraryStats()).archivedAssets, 0)
  })
})

test('buildLibraryNearDuplicateGroups groups by hash distance and persists', async () => {
  await withTempDir(async (dir) => {
    await seedHashLibrary(dir)
    initAssetLibraryService(dir)

    const started = buildLibraryNearDuplicateGroups({ threshold: 8 })
    assert.equal(started.ok, true, started.error)
    const progress = await waitTask()
    assert.equal(progress.state, 'done', progress.error || progress.message)

    const dups = nearDuplicateGroups(await listAssetClusters())
    assert.equal(dups.length, 1)
    assert.equal(dups[0].group.assetCount, 2)
    assert.ok(dups[0].group.avgSimilarity > 0.9 && dups[0].group.avgSimilarity < 1)
    assert.ok(dups[0].group.labels?.includes('near'))

    // idempotent rebuild
    assert.equal(buildLibraryNearDuplicateGroups().ok, true)
    assert.equal((await waitTask()).state, 'done')
    const rebuilt = nearDuplicateGroups(await listAssetClusters())
    assert.equal(rebuilt.length, 1)

    // disposition flow works for near groups too (use the fresh group id —
    // rebuild replaces group records atomically)
    const applied = await applyDuplicateGroup(rebuilt[0].group.id)
    assert.equal(applied.ok, true, applied.error)
    assert.equal(applied.archived, 1)
    assert.equal((await getAssetLibraryStats()).archivedAssets, 1)
  })
})

test('buildLibraryNearDuplicateGroups fails cleanly without hashes', async () => {
  await withTempDir(async (dir) => {
    await seedLibrary(dir) // hashes are '0' → invalid, filtered
    initAssetLibraryService(dir)
    assert.equal(buildLibraryNearDuplicateGroups().ok, true)
    const progress = await waitTask()
    assert.equal(progress.state, 'error')
  })
})
