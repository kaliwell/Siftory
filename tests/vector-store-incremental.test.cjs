const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const migration = loadTsModule('electron/vectorStoreMigrationService.ts')
const store = loadTsModule('electron/authoritativeVectorStore.ts')
const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')

function row(imageId, vector) {
  return `${JSON.stringify({ modelName: 'dinov2_vitb14', embeddingType: 'global', imageId, dim: vector.length, vector })}\n`
}

async function waitForMigration() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const progress = migration.getVectorStoreMigrationProgress()
    if (progress.state !== 'running') return progress
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('migration test timed out')
}

function sourceOptions(root, source) {
  return {
    cacheDir: path.join(root, 'vector-db', 'embedding-cache'),
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim: 3,
    sourcePaths: [source],
  }
}

function makeRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `floating-clock-vsi-${label}-`))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const embeddings = path.join(root, 'vector-db', 'embeddings')
  fs.mkdirSync(embeddings, { recursive: true })
  const source = path.join(embeddings, 'dinov2_vitb14__global.jsonl')
  return { root, source }
}

async function migrate(root, source) {
  migration.resetVectorStoreMigrationForTests()
  const preview = migration.createVectorStoreMigrationPreview(root, [sourceOptions(root, source)])
  assert.equal(migration.startVectorStoreMigration(root, preview.token).ok, true)
  const completed = await waitForMigration()
  assert.equal(completed.state, 'completed', completed.errors.join('\n'))
  return completed.generation
}

/** Full-build reference in an isolated root from the same final JSONL. */
function fullBuildReference(t, source) {
  const referenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-vsi-ref-'))
  t.after(() => fs.rmSync(referenceRoot, { recursive: true, force: true }))
  const referenceSource = path.join(referenceRoot, 'ref.jsonl')
  fs.copyFileSync(source, referenceSource)
  return cacheApi
    .ensureEmbeddingF16Cache({
      cacheDir: path.join(referenceRoot, 'cache'),
      modelName: 'dinov2_vitb14',
      embeddingType: 'global',
      dim: 3,
      sourcePaths: [referenceSource],
      preferAuthoritative: false,
    })
    .then((handle) => ({
      vectors: fs.readFileSync(handle.vectorPath),
      paths: fs.readFileSync(handle.pathIndexPath, 'utf8'),
      meta: handle.meta,
    }))
}

function derivedCacheBytes(root) {
  const cacheDir = path.join(root, 'vector-db', 'embedding-cache')
  return {
    vectors: fs.readFileSync(path.join(cacheDir, 'dinov2_vitb14__global.f16')),
    paths: fs.readFileSync(path.join(cacheDir, 'dinov2_vitb14__global.paths.jsonl'), 'utf8'),
  }
}

test('incremental migration is byte-identical to a full rebuild', async (t) => {
  const { root, source } = makeRoot(t, 'equiv')
  fs.writeFileSync(
    source,
    row('C:\\images\\a.jpg', [1, 0, 0]) + row('C:\\images\\b.jpg', [0, 2, 0]),
  )
  await migrate(root, source)

  fs.appendFileSync(
    source,
    row('C:\\images\\c.jpg', [0, 0, 3]) + row('C:\\images\\d.jpg', [1, 1, 0]),
  )
  const generation = await migrate(root, source)

  const extended = derivedCacheBytes(root)
  const reference = await fullBuildReference(t, source)
  assert.deepEqual(extended.vectors, reference.vectors)
  assert.equal(extended.paths, reference.paths)

  const storeRoot = path.join(root, 'vector-db', 'vector-store')
  const manifest = store.readCurrentAuthoritativeManifest(storeRoot, true)
  assert.equal(manifest.generation, generation)
  assert.equal(manifest.entries[0].count, 4)
  assert.equal(manifest.entries[0].sourceRecordCount, 4)
  const handle = store.openAuthoritativeVectorStore(storeRoot, 'dinov2_vitb14', 'global', 3, true, [
    source,
  ])
  assert.ok(handle, 'gen2 must satisfy the expectedSourcePaths fingerprint')
})

test('incremental merge follows latest-revision-wins ordering', async (t) => {
  const { root, source } = makeRoot(t, 'dupes')
  fs.writeFileSync(
    source,
    row('C:\\images\\a.jpg', [1, 0, 0]) + row('C:\\images\\b.jpg', [0, 2, 0]),
  )
  await migrate(root, source)

  fs.appendFileSync(
    source,
    row('C:\\images\\a.jpg', [9, 0, 0]) +
      row('C:\\images\\c.jpg', [0, 0, 3]) +
      row('C:\\images\\a.jpg', [5, 5, 0]),
  )
  await migrate(root, source)

  const extended = derivedCacheBytes(root)
  const reference = await fullBuildReference(t, source)
  assert.deepEqual(extended.vectors, reference.vectors)
  assert.equal(extended.paths, reference.paths)

  const pathRows = extended.paths
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).path)
  assert.deepEqual(pathRows, ['C:\\images\\b.jpg', 'C:\\images\\c.jpg', 'C:\\images\\a.jpg'])

  const storeRoot = path.join(root, 'vector-db', 'vector-store')
  const manifest = store.readCurrentAuthoritativeManifest(storeRoot, true)
  assert.equal(manifest.entries[0].count, 3)
  assert.equal(manifest.entries[0].sourceRecordCount, 5)
})

test('shrink, same-size rewrite and non-line boundary all fall back to full', async (t) => {
  // Direct unit checks of the append-only proof.
  const { root, source } = makeRoot(t, 'fallback')
  fs.writeFileSync(
    source,
    row('C:\\images\\a.jpg', [1, 0, 0]) + row('C:\\images\\b.jpg', [0, 2, 0]),
  )
  await migrate(root, source)
  const options = sourceOptions(root, source)

  // No generation at all in a fresh root.
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-vsi-empty-'))
  t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }))
  assert.equal(await cacheApi.extendEmbeddingF16Cache(sourceOptions(emptyRoot, source)), null)

  // Shrink → rewrite detected.
  fs.writeFileSync(source, row('C:\\images\\a.jpg', [1, 0, 0]))
  assert.equal(await cacheApi.extendEmbeddingF16Cache(options), null)

  // Same size, changed mtime → unverifiable rewrite.
  const before = fs.statSync(source)
  fs.utimesSync(source, new Date(before.mtimeMs + 5000), new Date(before.mtimeMs + 5000))
  await migrate(root, source) // re-baseline on the rewritten file
  fs.writeFileSync(
    source,
    row('C:\\images\\a.jpg', [9, 9, 0]).slice(0, before.size).padEnd(before.size, '\n'),
  )
  assert.equal(await cacheApi.extendEmbeddingF16Cache(options), null)

  // Re-baseline, then break the line boundary: file without trailing newline
  // before the append → extend must refuse and the migration must still
  // complete via the full path with correct content.
  fs.writeFileSync(source, row('C:\\images\\a.jpg', [1, 0, 0]).trimEnd())
  await migrate(root, source)
  fs.appendFileSync(source, `\n${row('C:\\images\\b.jpg', [0, 2, 0])}`)
  assert.equal(await cacheApi.extendEmbeddingF16Cache(options), null)
  const generation = await migrate(root, source)
  const storeRoot = path.join(root, 'vector-db', 'vector-store')
  const manifest = store.readCurrentAuthoritativeManifest(storeRoot, true)
  assert.equal(manifest.generation, generation)
  assert.equal(manifest.entries[0].count, 2)
})
