// Phase 3 tests for vector/manifest path-key repair (Phase 2 leftover):
// a same-volume move re-points the image-search embedding path keys in both
// the derived F16 cache and the pinned authoritative generation, with all
// content proofs re-committed — and refuses to repair on top of corrupt bytes.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  AUTHORITATIVE_VECTOR_STORE_VERSION,
  readCurrentAuthoritativeManifest,
  sha256FileSync,
  sha256FileTailSync,
} = loadTsModule('electron/authoritativeVectorStore.ts')
const { createEmbeddingCacheFileProof, verifyEmbeddingCacheFileProof } = loadTsModule(
  'electron/embeddingCacheIntegrity.ts',
)
const { resetEmbeddingCacheIntegrityMemoForTests } = loadTsModule(
  'electron/embeddingCacheIntegrity.ts',
)
const { probeVectorIndexHealth } = loadTsModule('electron/vectorIndexHealth.ts')
const { repairVectorIndexPathKeys } = loadTsModule('electron/vectorPathKeyRepair.ts')

const OLD_PATH = 'D:\\library\\cat.jpg'
const NEW_PATH = 'D:\\library\\renamed\\cat.jpg'

function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-repath-'))
  const cacheDir = path.join(root, 'embedding-cache')
  const storeRoot = path.join(root, 'vector-store')
  const generationDir = path.join(storeRoot, 'generations', 'gen-1')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.mkdirSync(generationDir, { recursive: true })

  // Derived F16 cache: paths JSONL + dummy vector bytes + meta proofs.
  const cachePaths = path.join(cacheDir, 'dino__global.paths.jsonl')
  fs.writeFileSync(
    cachePaths,
    `${JSON.stringify({ row: 0, path: OLD_PATH })}\n${JSON.stringify({ row: 1, path: 'D:\\library\\dog.jpg' })}\n`,
  )
  const cacheVectors = path.join(cacheDir, 'dino__global.f16')
  fs.writeFileSync(cacheVectors, Buffer.alloc(16))
  const meta = {
    version: 3,
    modelName: 'dino',
    embeddingType: 'global',
    dim: 4,
    count: 2,
    sourceRecordCount: 2,
    sourceFiles: [],
    updatedAt: Date.now(),
    integrity: {
      vectorsSha256: createEmbeddingCacheFileProof(cacheVectors).sha256,
      pathsSha256: createEmbeddingCacheFileProof(cachePaths).sha256,
    },
  }
  const cacheMeta = path.join(cacheDir, 'dino__global.f16.json')
  fs.writeFileSync(cacheMeta, JSON.stringify(meta, null, 2))

  // Authoritative generation pinned by manifest + CURRENT.
  const storeVectors = path.join(generationDir, 'vectors.bin')
  fs.writeFileSync(storeVectors, Buffer.alloc(16))
  const storePaths = path.join(generationDir, 'paths.jsonl')
  fs.writeFileSync(
    storePaths,
    `${JSON.stringify({ row: 0, path: OLD_PATH })}\n${JSON.stringify({ row: 1, path: 'D:\\library\\dog.jpg' })}\n`,
  )
  const cachePathsStat = fs.statSync(cachePaths)
  const manifest = {
    version: AUTHORITATIVE_VECTOR_STORE_VERSION,
    generation: 'gen-1',
    createdAt: Date.now(),
    entries: [
      {
        modelName: 'dino',
        embeddingType: 'global',
        dim: 4,
        dtype: 'f16-le',
        count: 2,
        sourceRecordCount: 2,
        imports: [
          {
            path: cachePaths,
            size: cachePathsStat.size,
            mtimeMs: cachePathsStat.mtimeMs,
            tailSha256: sha256FileTailSync(cachePaths, cachePathsStat.size),
          },
        ],
        vectors: createEmbeddingCacheFileProof(storeVectors),
        paths: createEmbeddingCacheFileProof(storePaths),
      },
    ],
  }
  manifest.entries[0].vectors.name = 'vectors.bin'
  manifest.entries[0].paths.name = 'paths.jsonl'
  const manifestPath = path.join(generationDir, 'manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  fs.writeFileSync(
    path.join(storeRoot, 'CURRENT'),
    JSON.stringify({
      version: AUTHORITATIVE_VECTOR_STORE_VERSION,
      generation: 'gen-1',
      manifestSha256: sha256FileSync(manifestPath),
      switchedAt: Date.now(),
    }),
  )
  return { root, cacheDir, storeRoot, cachePaths, cacheMeta, generationDir, storePaths, storeVectors }
}

test('health probe: missing CURRENT is index-stale, healthy store is ready', () => {
  const { storeRoot } = buildFixture()
  assert.equal(probeVectorIndexHealth(path.join(storeRoot, 'does-not-exist')).status, 'index-stale')
  assert.equal(probeVectorIndexHealth(storeRoot).status, 'ready')
  assert.equal(
    probeVectorIndexHealth(storeRoot, { modelName: 'clip_vit_base_patch32', embeddingType: 'global' })
      .status,
    'index-stale',
    'a healthy DINO-only generation must not enable CLIP semantic recall',
  )
  assert.equal(
    probeVectorIndexHealth(storeRoot, { modelName: 'dino', embeddingType: 'global' }).status,
    'ready',
  )
})

test('same-volume move re-points cache and authoritative path keys with re-pinned proofs', () => {
  const fixture = buildFixture()
  const report = repairVectorIndexPathKeys({
    repairs: [{ oldPath: OLD_PATH, newPath: NEW_PATH }],
    cacheDir: fixture.cacheDir,
    storeRoot: fixture.storeRoot,
  })
  assert.equal(report.status, 'ok')
  assert.equal(report.repairedRows, 2, 'one row in the cache + one in the generation')

  // Derived cache: row re-pointed, meta proof re-pinned and still verifiable.
  const cacheRows = fs
    .readFileSync(fixture.cachePaths, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(cacheRows[0].path, path.resolve(NEW_PATH))
  assert.equal(cacheRows[0].row, 0, 'row order is preserved')
  const meta = JSON.parse(fs.readFileSync(fixture.cacheMeta, 'utf8'))
  assert.equal(
    meta.integrity.pathsSha256,
    createEmbeddingCacheFileProof(fixture.cachePaths).sha256,
  )

  // Authoritative generation: path keys re-pointed, manifest + CURRENT
  // re-pinned, health probe and strict manifest validation both pass.
  const storeRows = fs
    .readFileSync(fixture.storePaths, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(storeRows[0].path, path.resolve(NEW_PATH))
  assert.equal(probeVectorIndexHealth(fixture.storeRoot).status, 'ready')
  const manifest = readCurrentAuthoritativeManifest(fixture.storeRoot, true)
  assert.ok(manifest, 'manifest must still pass structural + checksum validation')
  const entry = manifest.entries[0]
  assert.ok(
    verifyEmbeddingCacheFileProof(fixture.storePaths, entry.paths),
    're-pinned paths proof must verify',
  )
  const imported = entry.imports[0]
  const stat = fs.statSync(fixture.cachePaths)
  assert.equal(imported.size, stat.size, 'import anchor re-pinned to the rewritten cache')
  assert.equal(imported.tailSha256, sha256FileTailSync(fixture.cachePaths, stat.size))
})

test('repair refuses on top of corrupt bytes and leaves files untouched', () => {
  const fixture = buildFixture()
  const before = fs.readFileSync(fixture.storePaths, 'utf8')
  const cacheBefore = fs.readFileSync(fixture.cachePaths, 'utf8')
  const cacheMetaBefore = fs.readFileSync(fixture.cacheMeta, 'utf8')
  fs.writeFileSync(fixture.storeVectors, Buffer.alloc(16, 7), 'utf8')
  // The integrity memo is keyed by path+size+mtime; a same-ms rewrite could
  // hit the stale entry, so tests reset it explicitly (production readers get
  // a fresh key from the changed mtime).
  resetEmbeddingCacheIntegrityMemoForTests()
  assert.equal(probeVectorIndexHealth(fixture.storeRoot).status, 'vector-corrupt')
  const report = repairVectorIndexPathKeys({
    repairs: [{ oldPath: OLD_PATH, newPath: NEW_PATH }],
    cacheDir: fixture.cacheDir,
    storeRoot: fixture.storeRoot,
  })
  assert.equal(report.status, 'refused-corrupt')
  assert.equal(report.repairedRows, 0)
  assert.equal(fs.readFileSync(fixture.storePaths, 'utf8'), before, 'corrupt store untouched')
  assert.equal(
    fs.readFileSync(fixture.cachePaths, 'utf8'),
    cacheBefore,
    'derived cache must remain untouched when authoritative preflight refuses',
  )
  assert.equal(
    fs.readFileSync(fixture.cacheMeta, 'utf8'),
    cacheMetaBefore,
    'derived cache proof must remain untouched when authoritative preflight refuses',
  )
})

test('unknown paths are a no-op', () => {
  const fixture = buildFixture()
  const report = repairVectorIndexPathKeys({
    repairs: [{ oldPath: 'D:\\library\\never-indexed.jpg', newPath: NEW_PATH }],
    cacheDir: fixture.cacheDir,
    storeRoot: fixture.storeRoot,
  })
  assert.equal(report.status, 'noop')
  assert.equal(report.repairedRows, 0)
})
