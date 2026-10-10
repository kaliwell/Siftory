const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { float32ToFloat16 } = require('./guard-utils.cjs').loadTsModule(
  'electron/embeddingF16Cache.ts',
)
const runtime = require('./neko-search-binary-runtime.cjs')
const benchmark = require('./neko-search-accuracy-benchmark.cjs')

function makeStore(root, dtype, implicitRows = false) {
  const paths = ['C:\\images\\same.jpg', 'C:\\images\\near.jpg', 'C:\\images\\other.jpg']
  const vectors = [
    [1, 0, 0],
    [0.8, 0.2, 0],
    [0, 1, 0],
  ]
  const pathIndexPath = path.join(root, `${dtype}.paths.jsonl`)
  const vectorPath = path.join(root, dtype)
  fs.writeFileSync(
    pathIndexPath,
    paths
      .map((filePath, row) =>
        JSON.stringify(implicitRows ? { path: filePath } : { row, path: filePath }),
      )
      .join('\n'),
  )
  const output = Buffer.alloc(vectors.length * 3 * (dtype === 'f32-le' ? 4 : 2))
  let offset = 0
  for (const vector of vectors) {
    for (const value of vector) {
      if (dtype === 'f32-le') {
        output.writeFloatLE(value, offset)
        offset += 4
      } else {
        output.writeUInt16LE(float32ToFloat16(value), offset)
        offset += 2
      }
    }
  }
  fs.writeFileSync(vectorPath, output)
  return {
    modelName: dtype,
    dtype,
    dim: 3,
    count: paths.length,
    vectorPath,
    pathIndexPath,
  }
}

for (const dtype of ['f32-le', 'f16-le']) {
  test(`exact ${dtype} scan preserves ranking and reports phase timings`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-binary-runtime-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const store = makeStore(root, dtype)
    const prototypes = await runtime.readVectorsForPaths(store, [
      'C:\\images\\same.jpg',
      'C:\\images\\other.jpg',
    ])
    assert.equal(prototypes.vectors.size, 2)
    const scan = await runtime.scanExactStore(store, {
      poolByPath: new Map([['c:\\images\\near.jpg', true]]),
      positiveVectors: [prototypes.vectors.get('c:\\images\\same.jpg')],
      negativeVectors: [prototypes.vectors.get('c:\\images\\other.jpg')],
      topN: 3,
    })
    assert.equal(scan.scanned, 3)
    assert.equal(scan.poolScores.get('c:\\images\\near.jpg').positive > 0.7, true)
    assert.equal(scan.poolScores.get('c:\\images\\near.jpg').negative > 0, true)
    assert.equal(scan.heap.sort((a, b) => b.score - a.score)[0].key, 'c:\\images\\same.jpg')
    for (const field of [
      'totalMs',
      'pathIoMs',
      'jsonParseMs',
      'vectorIoMs',
      'similarityMs',
      'rankingMs',
    ]) {
      assert.equal(Number.isFinite(scan.timings[field]), true)
      assert.equal(scan.timings[field] >= 0, true)
    }
  })
}

test('benchmark enforces at least three cold and warm samples', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-binary-profile-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = makeStore(root, 'f32-le')
  const profile = await runtime.benchmarkExactStore(store, {
    poolByPath: new Map(),
    positiveVectors: [Float32Array.from([1, 0, 0])],
    negativeVectors: [],
    topN: 3,
    runs: 1,
  })
  assert.equal(profile.profile.runs, 3)
  assert.equal(profile.profile.applicationCold.totalMs.samples, 3)
  assert.equal(profile.profile.warmPathIndex.totalMs.samples, 3)
})

test('legacy F32 path indexes use physical line order when row is omitted', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-implicit-path-row-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = makeStore(root, 'f32-le', true)
  const loaded = await runtime.loadPathIndex(store)
  assert.deepEqual(loaded.paths, [
    'c:\\images\\same.jpg',
    'c:\\images\\near.jpg',
    'c:\\images\\other.jpg',
  ])
})

test('accuracy gate enforces absolute latency, sample count and comparable inputs', () => {
  const current = {
    variants: {},
    cluster: null,
    comparability: {
      annotationFingerprint: 'annotation-new',
      activeSetFingerprint: 'active-new',
    },
    latency: {
      scanMs: { p95: 40_001 },
      applicationCold: { totalMs: { samples: 2 } },
      warmPathIndex: { totalMs: { samples: 2 } },
    },
  }
  const baseline = {
    variants: {},
    latency: { scanP95Ms: 36_000 },
    comparability: {
      annotationFingerprint: 'annotation-old',
      activeSetFingerprint: 'active-old',
    },
  }
  const gate = benchmark.evaluateGate(current, baseline)
  assert.ok(gate.failures.some((message) => message.includes('40000ms')))
  assert.ok(gate.failures.some((message) => message.includes('at least 3')))
  assert.ok(gate.failures.some((message) => message.includes('Annotation dataset')))
  assert.ok(gate.failures.some((message) => message.includes('Active asset set')))
  assert.throws(() => benchmark.parseArgs(['--runs=2']), /between 3 and 10/)
})

test('accuracy benchmark stays read-only and never rebuilds or JSONL-scans embeddings', () => {
  const source = fs.readFileSync(path.join(__dirname, 'neko-search-accuracy-benchmark.cjs'), 'utf8')
  assert.doesNotMatch(source, /\.ensureEmbeddingF16Cache\s*\(/)
  assert.doesNotMatch(source, /\.streamAssetEmbeddings\s*\(/)
  assert.match(source, /openAuthoritativeVectorStore/)
  assert.match(source, /readExistingEmbeddingF16Cache/)
})
