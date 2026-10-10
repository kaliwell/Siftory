const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Stub electron before any main-process module loads: semantic search resolves
// userData through app.getPath, and fixtures must stay in isolated temp dirs.
let fixtureUserData = null
const electronModulePath = require.resolve('electron')
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getAppPath: () => path.join(os.tmpdir(), 'siftory-semantic-scope-app'),
      getPath: () => fixtureUserData,
    },
  },
}

const { loadTsModule } = require('./guard-utils.cjs')

const { buildSemanticPathScope, filterSemanticVectorCandidates } = loadTsModule(
  'electron/semanticSearchScope.ts',
)
const cacheApi = loadTsModule('electron/embeddingF16Cache.ts')
const vectorDb = loadTsModule('electron/vectorDatabaseService.ts')
const semanticSearch = loadTsModule('electron/semanticSearchService.ts')
const semanticWorkerHost = loadTsModule('electron/semanticVectorSearchWorkerHost.ts')

test.after(() => {
  semanticWorkerHost.disposeSemanticVectorSearchWorker()
})

const CLIP_MODEL = 'clip_vit_base_patch32'
const CLIP_DIM = 512

test('CLIP vector results remain searchable when the hash image index is empty', () => {
  const candidates = [{ path: 'D:\\PxHereDataset\\images\\pxhere-000000\\sample.jpg', score: 0.91 }]

  assert.deepEqual(filterSemanticVectorCandidates(candidates, new Set()), candidates)
})

test('CLIP vector results still respect a populated hash image index', () => {
  const candidates = [
    { path: 'D:\\PxHereDataset\\images\\pxhere-000000\\allowed.jpg', score: 0.91 },
    { path: 'D:\\PxHereDataset\\images\\pxhere-000001\\outside.jpg', score: 0.89 },
  ]
  const scope = buildSemanticPathScope(['d:/pxheredataset/images/pxhere-000000/allowed.jpg'])

  assert.deepEqual(filterSemanticVectorCandidates(candidates, scope), [candidates[0]])
})

function unitVector(entries, dim = CLIP_DIM) {
  const vector = new Array(dim).fill(0)
  for (const [index, value] of entries) vector[index] = value
  const norm = Math.hypot(...vector)
  return vector.map((component) => component / norm)
}

function clipEmbeddingRow(imageId, vector) {
  return `${JSON.stringify({
    modelName: CLIP_MODEL,
    embeddingType: 'global',
    imageId,
    dim: CLIP_DIM,
    vector,
  })}\n`
}

function u32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

function u64(value) {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(BigInt(value), 0)
  return buffer
}

// Minimal IMS1 v2 segment holding only the path records that the semantic
// scope reader consumes (mirrors writeV2Segment in native-segment-v3.test.cjs).
function writeScopeSegment(filePath, paths) {
  const headerSize = 80
  const metaSize = 32
  const pathOffsetsOffset = headerSize
  const pathBytesOffset = pathOffsetsOffset + (paths.length + 1) * 8
  const pathBytes = Buffer.concat(paths.map((p) => Buffer.from(`${p}\0`, 'utf8')))
  const metadataOffset = pathBytesOffset + pathBytes.length
  const offsets = []
  let offset = 0
  for (const p of paths) {
    offsets.push(offset)
    offset += Buffer.byteLength(`${p}\0`)
  }
  offsets.push(offset)
  const header = Buffer.alloc(headerSize)
  header.write('IMS1', 0, 'ascii')
  u32(2).copy(header, 4)
  u64(paths.length).copy(header, 8)
  u64(pathOffsetsOffset).copy(header, 32)
  u64(pathBytesOffset).copy(header, 40)
  u64(metadataOffset).copy(header, 48)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    Buffer.concat([header, ...offsets.map(u64), pathBytes, Buffer.alloc(paths.length * metaSize)]),
  )
}

function writeNativeScope(root, paths) {
  const indexRoot = path.join(root, 'image-search-index')
  writeScopeSegment(path.join(indexRoot, 'segments', 'seg0.idx'), paths)
  fs.writeFileSync(
    path.join(indexRoot, 'manifest.json'),
    JSON.stringify({ segments: [{ file: 'segments/seg0.idx' }] }),
  )
}

function writeClipEmbeddingStore(root, rows) {
  const source = path.join(root, 'vector-db', 'embeddings', `${CLIP_MODEL}__global.jsonl`)
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(
    source,
    rows.map(([imageId, vector]) => clipEmbeddingRow(imageId, vector)).join(''),
  )
}

function makeSemanticFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-sss-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fixtureUserData = root
  vectorDb.initVectorDatabase(root)
  return root
}

// Starvation fixture: the Native scope subset holds two images whose CLIP
// vectors score lower than every out-of-scope candidate. A scope filter
// applied after the bounded topK heap would evict all in-scope candidates and
// return zero results; the prefilter must fill every topK slot in-scope.
test('scoped semantic search fills a small topK from in-scope candidates', async (t) => {
  const root = makeSemanticFixture(t)
  const inScopeA = 'C:\\native\\subset-a.jpg'
  const inScopeB = 'C:\\native\\subset-b.jpg'
  writeNativeScope(root, [inScopeA, inScopeB])
  writeClipEmbeddingStore(root, [
    ['C:\\global\\best.jpg', unitVector([[0, 1]])],
    [
      'C:\\global\\second.jpg',
      unitVector([
        [0, 0.95],
        [1, 0.05],
      ]),
    ],
    [
      inScopeA,
      unitVector([
        [0, 0.3],
        [1, 1],
      ]),
    ],
    [
      inScopeB,
      unitVector([
        [0, 0.1],
        [1, 1],
      ]),
    ],
  ])
  semanticSearch.setSemanticQueryTextEmbeddingProviderForTests(async () => unitVector([[0, 1]]))
  t.after(() => semanticSearch.setSemanticQueryTextEmbeddingProviderForTests())

  const topOne = await semanticSearch.searchSemanticImages({ text: 'fixture query', topK: 1 })
  assert.deepEqual(
    topOne.results.map((result) => result.path),
    [inScopeA],
    'the in-scope best must win the single topK slot despite lower global score',
  )
  assert.equal(topOne.matchedCandidates, 1)
  assert.equal(topOne.returnedCount, 1)

  const topTwo = await semanticSearch.searchSemanticImages({ text: 'fixture query', topK: 2 })
  assert.deepEqual(
    topTwo.results.map((result) => result.path),
    [inScopeA, inScopeB],
  )
  assert.equal(topTwo.matchedCandidates, 2)
})

test('semantic search without a Native scope falls back to the full CLIP store', async (t) => {
  const root = makeSemanticFixture(t)
  const inScope = 'C:\\native\\subset-a.jpg'
  writeClipEmbeddingStore(root, [
    ['C:\\global\\best.jpg', unitVector([[0, 1]])],
    [
      inScope,
      unitVector([
        [0, 0.3],
        [1, 1],
      ]),
    ],
  ])
  semanticSearch.setSemanticQueryTextEmbeddingProviderForTests(async () => unitVector([[0, 1]]))
  t.after(() => semanticSearch.setSemanticQueryTextEmbeddingProviderForTests())

  const response = await semanticSearch.searchSemanticImages({ text: 'fixture query', topK: 1 })
  assert.deepEqual(
    response.results.map((result) => result.path),
    ['C:\\global\\best.jpg'],
  )
  assert.ok(
    response.degradationReasons.some((reason) => reason.includes('No Native image index found')),
    'the absent state is named explicitly in the degradation reasons',
  )
})

test('missing CLIP text files fail before Transformers tokenizer initialization', async (t) => {
  const root = makeSemanticFixture(t)
  writeClipEmbeddingStore(root, [['C:\\global\\best.jpg', unitVector([[0, 1]])]])
  semanticSearch.setSemanticQueryTextEmbeddingProviderForTests()

  const response = await semanticSearch.searchSemanticImages({ text: 'fixture query', topK: 1 })
  const reason = response.degradationReasons.find((item) =>
    item.includes('CLIP embedding semantic search unavailable'),
  )
  assert.match(reason || '', /CLIP text model is not installed or is incomplete/)
  assert.doesNotMatch(reason || '', /tokenizer_class/)
})

// VAL-036: a manifest that parses and declares an empty index is a valid
// empty scope — the explicit full-library fallback is preserved.
test('valid-empty Native manifest keeps the explicit full CLIP fallback', async (t) => {
  const root = makeSemanticFixture(t)
  const indexRoot = path.join(root, 'image-search-index')
  fs.mkdirSync(indexRoot, { recursive: true })
  fs.writeFileSync(
    path.join(indexRoot, 'manifest.json'),
    JSON.stringify({ schemaVersion: 2, segments: [] }),
  )
  writeClipEmbeddingStore(root, [['C:\\global\\best.jpg', unitVector([[0, 1]])]])
  semanticSearch.setSemanticQueryTextEmbeddingProviderForTests(async () => unitVector([[0, 1]]))
  t.after(() => semanticSearch.setSemanticQueryTextEmbeddingProviderForTests())

  const response = await semanticSearch.searchSemanticImages({ text: 'fixture query', topK: 1 })
  assert.deepEqual(
    response.results.map((result) => result.path),
    ['C:\\global\\best.jpg'],
  )
  assert.ok(
    response.degradationReasons.some((reason) => reason.includes('Hash image index is empty')),
    'the valid-empty state is named explicitly in the degradation reasons',
  )
})

// VAL-036: a corrupted manifest must fail closed — never silently widen to
// the full CLIP library — with an explicit degradation reason and signal.
test('corrupt Native manifest fails closed instead of widening to the full CLIP store', async (t) => {
  const root = makeSemanticFixture(t)
  const indexRoot = path.join(root, 'image-search-index')
  fs.mkdirSync(indexRoot, { recursive: true })
  fs.writeFileSync(path.join(indexRoot, 'manifest.json'), '{"segments":[{bad json')
  writeClipEmbeddingStore(root, [['C:\\global\\best.jpg', unitVector([[0, 1]])]])
  semanticSearch.setSemanticQueryTextEmbeddingProviderForTests(async () => unitVector([[0, 1]]))
  t.after(() => semanticSearch.setSemanticQueryTextEmbeddingProviderForTests())
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  t.after(() => {
    console.warn = originalWarn
  })

  const response = await semanticSearch.searchSemanticImages({ text: 'fixture query', topK: 1 })
  assert.deepEqual(response.results, [])
  assert.equal(response.degraded, true)
  assert.ok(
    response.degradationReasons.some((reason) =>
      reason.includes('Native image search index is corrupted'),
    ),
    'the corruption is surfaced as an explicit degradation reason',
  )
  assert.ok(
    warnings.some((line) => line.includes('[semantic-scope]')),
    'the corruption raises an explicit [semantic-scope] signal',
  )
})

// Same fail-closed guarantee for a manifest that parses but has an invalid
// shape (segments is not an array).
test('malformed Native manifest shape fails closed', async (t) => {
  const root = makeSemanticFixture(t)
  const indexRoot = path.join(root, 'image-search-index')
  fs.mkdirSync(indexRoot, { recursive: true })
  fs.writeFileSync(path.join(indexRoot, 'manifest.json'), JSON.stringify({ segments: 'corrupt' }))
  writeClipEmbeddingStore(root, [['C:\\global\\best.jpg', unitVector([[0, 1]])]])
  semanticSearch.setSemanticQueryTextEmbeddingProviderForTests(async () => unitVector([[0, 1]]))
  t.after(() => semanticSearch.setSemanticQueryTextEmbeddingProviderForTests())

  const response = await semanticSearch.searchSemanticImages({ text: 'fixture query', topK: 1 })
  assert.deepEqual(response.results, [])
  assert.equal(response.degraded, true)
  assert.ok(
    response.degradationReasons.some((reason) =>
      reason.includes('Native image search index is corrupted'),
    ),
  )
})

// Same starvation guarantee one layer down: searchEmbeddingF16Cache must apply
// acceptPath before its bounded topK heap, not as a post-filter.
test('F16 cache search applies acceptPath before the bounded topK heap', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-sss-f16-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dim = 3
  const inScope = 'C:\\native\\subset.jpg'
  const source = path.join(root, 'vector-db', 'embeddings', 'fixture_dinov2__global.jsonl')
  fs.mkdirSync(path.dirname(source), { recursive: true })
  const row = (imageId, vector) =>
    `${JSON.stringify({ modelName: 'fixture_dinov2', embeddingType: 'global', imageId, dim, vector })}\n`
  fs.writeFileSync(
    source,
    row('C:\\global\\best.jpg', unitVector([[0, 1]], dim)) +
      row(inScope, unitVector([[1, 1]], dim)),
  )
  const handle = await cacheApi.ensureEmbeddingF16Cache({
    cacheDir: path.join(root, 'vector-db', 'embedding-cache'),
    modelName: 'fixture_dinov2',
    embeddingType: 'global',
    dim,
    sourcePaths: [source],
  })
  assert.ok(handle)

  const unscoped = await cacheApi.searchEmbeddingF16Cache(handle, {
    queryVector: unitVector([[0, 1]], dim),
    topK: 1,
  })
  assert.deepEqual(
    unscoped.map((match) => match.path),
    ['C:\\global\\best.jpg'],
    'fixture premise: the out-of-scope candidate scores highest globally',
  )

  const scoped = await cacheApi.searchEmbeddingF16Cache(handle, {
    queryVector: unitVector([[0, 1]], dim),
    topK: 1,
    acceptPath: (filePath) => filePath === inScope,
  })
  assert.deepEqual(
    scoped.map((match) => match.path),
    [inScope],
    'a scoped topK=1 heap must be filled from in-scope candidates',
  )
})
