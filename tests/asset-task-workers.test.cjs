const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const { runAssetSimilarSearchScan } = loadTsModule('electron/assetSimilarSearchWorker.ts')
const { runAssetSuggestionScan } = loadTsModule('electron/assetSuggestionScanWorker.ts')
const { runAssetCategorySearch, runAssetFeedbackBuild } = loadTsModule(
  'electron/assetCategoryFeedbackWorker.ts',
)
const { shiftedCosine, scoreReferencePrototypes } = loadTsModule('electron/assetLibraryScoring.ts')
const { scoreAssetFeedbackTarget } = loadTsModule('electron/assetFeedbackModel.ts')

const MODEL = 'dinov2_vitb14'

// Must match pathKey() in electron/assetMetadataStore.ts.
function assetPathKey(filePath) {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function embeddingRow(imageId, vector, modelName = MODEL) {
  return JSON.stringify({ modelName, embeddingType: 'global', imageId, dim: vector.length, vector })
}

// Vectors are unit-length with components exactly representable in float16,
// so the cache (which normalizes and quantizes to f16) is lossless and the
// oracle comparison is exact.
const DIM_VECTORS = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0.5, 0.5, 0.5, 0.5],
  [0.5, -0.5, 0.5, 0.5],
  [0.5, 0.5, -0.5, -0.5],
  [-1, 0, 0, 0],
  [0, 0, 0, 1],
]

async function withTempDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asset-task-workers-'))
  try {
    await run(dir)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

function seedLibrary(dir) {
  const source = path.join(dir, 'dinov2.jsonl')
  const assets = DIM_VECTORS.map((vector, index) => ({
    id: index + 1,
    path: `C:\\images\\asset-${index + 1}.jpg`,
    vector,
  }))
  fs.writeFileSync(
    source,
    assets.map((asset) => embeddingRow(asset.path, asset.vector)).join('\n') + '\n',
  )
  return { source, assets }
}

function scanInput(dir, source, assets, overrides = {}) {
  return {
    cacheDir: path.join(dir, 'cache'),
    modelName: MODEL,
    embeddingType: 'global',
    dim: 4,
    sourcePaths: [source],
    queryVector: assets[0].vector,
    topK: 3,
    excludeAssetId: assets[0].id,
    assets: assets.map((asset) => ({ id: asset.id, pathKey: assetPathKey(asset.path) })),
    reviewedAssetIds: [],
    ...overrides,
  }
}

function oracleTopK(assets, queryVector, topK, excludeAssetId, reviewedIds = []) {
  const reviewed = new Set(reviewedIds)
  return assets
    .filter((asset) => asset.id !== excludeAssetId && !reviewed.has(asset.id))
    .map((asset) => ({
      assetId: asset.id,
      confidence: shiftedCosine(Float32Array.from(queryVector), Float32Array.from(asset.vector)),
    }))
    .sort((a, b) => b.confidence - a.confidence || a.assetId - b.assetId)
    .slice(0, topK)
}

function sortedCandidates(candidates) {
  return [...candidates].sort((a, b) => b.confidence - a.confidence || a.assetId - b.assetId)
}

test('similar scan matches a linear shifted-cosine oracle', async () => {
  await withTempDir(async (dir) => {
    const { source, assets } = seedLibrary(dir)
    const stopView = new Int32Array(new SharedArrayBuffer(4))
    const result = await runAssetSimilarSearchScan(
      scanInput(dir, source, assets),
      stopView,
      () => {},
    )
    assert.equal(result.stopped, false)
    assert.equal(result.scanned, assets.length)
    const oracle = oracleTopK(assets, assets[0].vector, 3, assets[0].id)
    const actual = sortedCandidates(result.candidates)
    assert.equal(actual.length, 3)
    assert.deepEqual(
      actual.map((c) => c.assetId),
      oracle.map((c) => c.assetId),
    )
    actual.forEach((candidate, index) => {
      assert.ok(Math.abs(candidate.confidence - oracle[index].confidence) < 1e-6)
    })
  })
})

test('similar scan excludes reviewed assets', async () => {
  await withTempDir(async (dir) => {
    const { source, assets } = seedLibrary(dir)
    const stopView = new Int32Array(new SharedArrayBuffer(4))
    const oracle = oracleTopK(assets, assets[0].vector, 3, assets[0].id)
    const reviewedId = oracle[0].assetId
    const result = await runAssetSimilarSearchScan(
      scanInput(dir, source, assets, { reviewedAssetIds: [reviewedId] }),
      stopView,
      () => {},
    )
    assert.equal(result.stopped, false)
    const expected = oracleTopK(assets, assets[0].vector, 3, assets[0].id, [reviewedId])
    assert.deepEqual(
      sortedCandidates(result.candidates).map((c) => c.assetId),
      expected.map((c) => c.assetId),
    )
    assert.ok(!result.candidates.some((c) => c.assetId === reviewedId))
  })
})

test('similar scan honors the stop flag', async () => {
  await withTempDir(async (dir) => {
    const { source, assets } = seedLibrary(dir)
    const stopView = new Int32Array(new SharedArrayBuffer(4))
    Atomics.store(stopView, 0, 1)
    const result = await runAssetSimilarSearchScan(
      scanInput(dir, source, assets),
      stopView,
      () => {},
    )
    assert.equal(result.stopped, true)
  })
})

test('similar scan is deterministic across runs', async () => {
  await withTempDir(async (dir) => {
    const { source, assets } = seedLibrary(dir)
    const input = scanInput(dir, source, assets)
    const first = await runAssetSimilarSearchScan(
      input,
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    const second = await runAssetSimilarSearchScan(
      input,
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    assert.deepEqual(sortedCandidates(first.candidates), sortedCandidates(second.candidates))
    assert.equal(first.scanned, second.scanned)
  })
})

test('similar scan and scoring reject malformed queries and normalize extreme finite inputs', async () => {
  await withTempDir(async (dir) => {
    const { source, assets } = seedLibrary(dir)
    const stopView = new Int32Array(new SharedArrayBuffer(4))
    for (const queryVector of [
      [1, 0],
      [1, 0, 0, 0, 0],
      [0, 0, 0, 0],
      [1, null, 0, 0],
      [1, '0', 0, 0],
      [1, Number.NaN, 0, 0],
      null,
      '1,0,0,0',
    ]) {
      await assert.rejects(
        runAssetSimilarSearchScan(
          scanInput(dir, source, assets, { queryVector }),
          stopView,
          () => {},
        ),
        /Invalid embedding vector/,
      )
    }

    for (const queryVector of [
      [1e308, 0, 0, 0],
      [Number.MIN_VALUE, 0, 0, 0],
    ]) {
      const result = await runAssetSimilarSearchScan(
        scanInput(dir, source, assets, { queryVector }),
        stopView,
        () => {},
      )
      assert.equal(result.candidates.length, 3)
      assert.equal(
        result.candidates.every((candidate) => Number.isFinite(candidate.confidence)),
        true,
      )
    }

    assert.throws(
      () => shiftedCosine(Float32Array.of(1, 0), Float32Array.of(1)),
      /dimension mismatch/,
    )
    assert.throws(
      () => shiftedCosine(Float32Array.of(1, 0), Float32Array.of(Number.NaN, 0)),
      /finite/,
    )
    assert.throws(() => shiftedCosine(Float32Array.of(1, 0), Float32Array.of(0, 0)), /zero norm/)

    const similarWorkerSource = fs.readFileSync(
      path.join(__dirname, '..', 'electron', 'assetSimilarSearchWorker.ts'),
      'utf8',
    )
    const suggestionWorkerSource = fs.readFileSync(
      path.join(__dirname, '..', 'electron', 'assetSuggestionScanWorker.ts'),
      'utf8',
    )
    const suggestionGenerationSource = fs.readFileSync(
      path.join(__dirname, '..', 'electron', 'assetSuggestionGenerationService.ts'),
      'utf8',
    )
    assert.match(similarWorkerSource, /shiftedCosineNormalized\(queryVector, vector\)/)
    assert.match(suggestionWorkerSource, /scoreNormalizedReferencePrototypes\(/)
    assert.match(suggestionWorkerSource, /shiftedCosineNormalized\(/)
    assert.match(suggestionGenerationSource, /normalizeRawVector\(cached\.vector, DINO_DIM\)/)
    assert.match(suggestionGenerationSource, /normalizeRawVector\(embedded\.vector, DINO_DIM\)/)
    assert.match(suggestionGenerationSource, /normalizeRawVector\(values, CLIP_DIM\)/)
    assert.doesNotMatch(suggestionGenerationSource, /Number\(value \|\| 0\)/)
  })
})

// ── Suggestion scan worker ─────────────────────────────────────────────────

const CLIP_MODEL = 'clip_vit_base_patch32'

// 2D unit vectors keep the oracle math exact (normalizedVector is a no-op).
const SUGGESTION_ASSETS = [
  { id: 1, path: 'C:\\sug\\a1.jpg', vector: [1, 0] },
  { id: 2, path: 'C:\\sug\\a2.jpg', vector: [1, 0] },
  { id: 3, path: 'C:\\sug\\a3.jpg', vector: [0, 1] },
  { id: 4, path: 'C:\\sug\\a4.jpg', vector: [0, 1] },
  { id: 5, path: 'C:\\sug\\a5.jpg', vector: [0.6, 0.8] },
  { id: 6, path: 'C:\\sug\\a6.jpg', vector: [-1, 0] },
]

function seedSuggestionSource(dir, modelName) {
  const source = path.join(dir, `${modelName}.jsonl`)
  fs.writeFileSync(
    source,
    SUGGESTION_ASSETS.map((asset) => embeddingRow(asset.path, asset.vector, modelName)).join('\n') +
      '\n',
  )
  return source
}

function suggestionInput(source, modelName, overrides = {}) {
  return {
    mode: 'reference',
    modelName,
    dim: 2,
    sourcePaths: [source],
    targets: [],
    maxPerTarget: 10,
    assets: SUGGESTION_ASSETS.map((asset) => ({
      id: asset.id,
      pathKey: assetPathKey(asset.path),
    })),
    excludedPairs: [],
    ...overrides,
  }
}

function candidatesOf(result, targetId) {
  const entry = result.results.find((item) => item.targetId === targetId)
  assert.ok(entry, `missing results for target ${targetId}`)
  return [...entry.candidates].sort((a, b) => b.confidence - a.confidence || a.assetId - b.assetId)
}

test('suggestion scan (reference) scores prototypes with threshold, exclusion and evidence', async () => {
  await withTempDir(async (dir) => {
    const source = seedSuggestionSource(dir, MODEL)
    // cat 1: prototype asset 1 ([1,0]); cat 2: prototype asset 3 ([0,1]).
    // "2:1" is already assigned, "1:1" and "3:2" are reference pairs.
    // Orthogonal vectors score 0.5 under shifted cosine, so the floor is 0.6.
    const result = await runAssetSuggestionScan(
      suggestionInput(source, MODEL, {
        targets: [
          {
            targetId: 1,
            minConfidence: 0.6,
            prototypes: [{ assetId: 1, vector: [1, 0], weight: 1 }],
          },
          {
            targetId: 2,
            minConfidence: 0.6,
            prototypes: [{ assetId: 3, vector: [0, 1], weight: 1 }],
          },
        ],
        excludedPairs: ['1:1', '3:2', '2:1'],
      }),
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    assert.equal(result.stopped, false)
    assert.equal(result.scanned, SUGGESTION_ASSETS.length)

    // Oracle via the production scorer on the same normalized vectors.
    const oracle = scoreReferencePrototypes(Float32Array.from([0.6, 0.8]), [
      { assetId: 3, vector: Float32Array.from([0, 1]), weight: 1 },
    ])

    const cat1 = candidatesOf(result, 1)
    assert.deepEqual(
      cat1.map((c) => c.assetId),
      [5],
    )
    // cat2: a4 (1.0), a5 (0.9 shifted); a6/a1/a2 sit at 0.5, below the floor
    const cat2 = candidatesOf(result, 2)
    assert.deepEqual(
      cat2.map((c) => c.assetId),
      [4, 5],
    )
    const a5 = cat2.find((c) => c.assetId === 5)
    assert.ok(Math.abs(a5.confidence - oracle.confidence) < 1e-6)
    assert.deepEqual(a5.evidenceAssetIds, [oracle.evidenceAssetId])
  })
})

test('suggestion scan (text_label) ranks by shifted cosine and truncates per target', async () => {
  await withTempDir(async (dir) => {
    const source = seedSuggestionSource(dir, CLIP_MODEL)
    const result = await runAssetSuggestionScan(
      suggestionInput(source, CLIP_MODEL, {
        mode: 'text_label',
        targets: [
          {
            targetId: 11,
            minConfidence: 0.6,
            prototypes: [{ assetId: 0, vector: [1, 0], weight: 1 }],
          },
        ],
        maxPerTarget: 2,
      }),
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    assert.equal(result.stopped, false)
    const tag = candidatesOf(result, 11)
    // a1/a2 tie at 1.0 and fill the heap; a5 (0.8) is truncated by maxPerTarget.
    assert.deepEqual(
      tag.map((c) => c.assetId),
      [1, 2],
    )
    assert.equal(tag.length, 2, 'maxPerTarget truncates the heap')
    const a1 = tag.find((c) => c.assetId === 1)
    assert.ok(a1, 'a1 present')
    const expected = shiftedCosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))
    assert.ok(Math.abs(a1.confidence - expected) < 1e-6)
  })
})

test('suggestion scan honors the stop flag', async () => {
  await withTempDir(async (dir) => {
    const source = seedSuggestionSource(dir, MODEL)
    const stopView = new Int32Array(new SharedArrayBuffer(4))
    Atomics.store(stopView, 0, 1)
    const result = await runAssetSuggestionScan(
      suggestionInput(source, MODEL, {
        targets: [
          {
            targetId: 1,
            minConfidence: 0.5,
            prototypes: [{ assetId: 1, vector: [1, 0], weight: 1 }],
          },
        ],
      }),
      stopView,
      () => {},
    )
    assert.equal(result.stopped, true)
  })
})

// ── Category feedback worker ───────────────────────────────────────────────

function seedClipCache(dir, assets) {
  const vectorPath = path.join(dir, 'clip.f32')
  const pathListPath = path.join(dir, 'clip.paths.jsonl')
  const vectors = Buffer.concat(
    assets.map((asset) => Buffer.from(Float32Array.from(asset.vector).buffer)),
  )
  fs.writeFileSync(vectorPath, vectors)
  fs.writeFileSync(
    pathListPath,
    assets.map((asset, row) => JSON.stringify({ row, path: asset.path })).join('\n') + '\n',
  )
  return { dim: assets[0].vector.length, count: assets.length, vectorPath, pathListPath }
}

function appendClipDelta(dir, cache, assets) {
  const baseCount = cache.count
  const vectorPath = path.join(dir, 'clip.delta.f32')
  const pathListPath = path.join(dir, 'clip.delta.paths.jsonl')
  fs.writeFileSync(
    vectorPath,
    Buffer.concat(assets.map((asset) => Buffer.from(Float32Array.from(asset.vector).buffer))),
  )
  fs.writeFileSync(
    pathListPath,
    assets
      .map((asset, index) => JSON.stringify({ row: baseCount + index, path: asset.path }))
      .join('\n') + '\n',
  )
  cache.delta = { vectorPath, pathListPath, baseCount }
  cache.count += assets.length
}

const CATEGORY_ASSETS = [
  { id: 1, path: 'C:\\cat\\one.jpg', vector: [1, 0] },
  { id: 2, path: 'C:\\cat\\two.jpg', vector: [0.8, 0.6] },
  { id: 3, path: 'C:\\cat\\three.jpg', vector: [0, 1] },
  { id: 4, path: 'C:\\cat\\four.jpg', vector: [-1, 0] },
]

function feedbackSource() {
  return {
    targets: [
      {
        key: 'category:7',
        kind: 'category',
        id: 7,
        name: 'subject',
        positiveSampleCount: 2,
        negativeSampleCount: 1,
        positiveSamples: [
          { path: CATEGORY_ASSETS[0].path, weight: 1 },
          { path: CATEGORY_ASSETS[1].path, weight: 0.8 },
        ],
        negativeSamples: [{ path: CATEGORY_ASSETS[3].path, weight: 1 }],
      },
    ],
  }
}

test('feedback build worker is deterministic and matches prototype source counts', async () => {
  await withTempDir(async (dir) => {
    const input = {
      kind: 'feedback_build',
      source: feedbackSource(),
      cache: seedClipCache(dir, CATEGORY_ASSETS),
    }
    const first = await runAssetFeedbackBuild(
      input,
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    const second = await runAssetFeedbackBuild(
      input,
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    assert.equal(first.stopped, false)
    assert.deepEqual(second, first)
    assert.equal(first.result.sourceSampleCount, 3)
    assert.equal(first.result.embeddedSampleCount, 3)
    assert.equal(first.result.skippedSampleCount, 0)
    assert.equal(first.result.targets.length, 1)
    assert.equal(first.result.targets[0].positivePrototypes.length, 2)
    assert.equal(first.result.targets[0].negativePrototypes.length, 1)
  })
})

test('category search worker matches the feedback scorer and eligible asset filter', async () => {
  await withTempDir(async (dir) => {
    const cache = seedClipCache(dir, CATEGORY_ASSETS)
    const built = await runAssetFeedbackBuild(
      { kind: 'feedback_build', source: feedbackSource(), cache },
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    const target = built.result.targets[0]
    const input = {
      kind: 'category_search',
      cache,
      target,
      eligibleAssets: CATEGORY_ASSETS.filter((asset) => asset.id !== 4).map((asset) => ({
        id: asset.id,
        pathKey: assetPathKey(asset.path),
      })),
      clipCandidateK: 10,
      topK: 3,
      dino: {
        cacheDir: path.join(dir, 'dino-cache'),
        modelName: MODEL,
        embeddingType: 'global',
        dim: 2,
        sourcePaths: [],
      },
    }
    const actual = await runAssetCategorySearch(
      input,
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    const repeated = await runAssetCategorySearch(
      input,
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    const annPrefiltered = await runAssetCategorySearch(
      {
        ...input,
        clipAnnCandidates: CATEGORY_ASSETS.map((asset, row) => ({ path: asset.path, row })),
      },
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    assert.equal(actual.stopped, false)
    assert.deepEqual(repeated, actual)
    assert.equal(actual.result.scanned, CATEGORY_ASSETS.length)
    assert.equal(actual.result.clipScanMode, 'exact')
    assert.equal(annPrefiltered.result.clipScanMode, 'ann')
    assert.equal(annPrefiltered.result.clipAnnCandidateCount, CATEGORY_ASSETS.length)
    assert.equal(annPrefiltered.result.clipCandidateCount, 3)
    assert.equal(annPrefiltered.result.clipIndexedCount, CATEGORY_ASSETS.length)
    assert.equal(actual.result.mode, 'clip')
    const expected = CATEGORY_ASSETS.filter((asset) => asset.id !== 4)
      .map((asset) => ({
        assetId: asset.id,
        score: scoreAssetFeedbackTarget(Float32Array.from(asset.vector), target).score,
      }))
      .sort((left, right) => right.score - left.score || left.assetId - right.assetId)
    assert.deepEqual(
      actual.result.hits.map((hit) => hit.assetId),
      expected.map((hit) => hit.assetId),
    )
    actual.result.hits.forEach((hit, index) => {
      assert.ok(Math.abs(hit.score - expected[index].score) < 1e-6)
    })
    assert.deepEqual(annPrefiltered.result.hits, actual.result.hits)
    assert.ok(!actual.result.hits.some((hit) => hit.assetId === 4))
  })
})

test('category worker searches delta additions and ignores superseded base vectors', async () => {
  await withTempDir(async (dir) => {
    const cache = seedClipCache(dir, CATEGORY_ASSETS)
    const built = await runAssetFeedbackBuild(
      { kind: 'feedback_build', source: feedbackSource(), cache },
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    const added = { id: 5, path: 'C:\\cat\\five.jpg', vector: [1, 0] }
    appendClipDelta(dir, cache, [
      { ...CATEGORY_ASSETS[0], path: 'c:/CAT/one.jpg', vector: [-1, 0] },
      added,
    ])

    const actual = await runAssetCategorySearch(
      {
        kind: 'category_search',
        cache,
        target: built.result.targets[0],
        eligibleAssets: [CATEGORY_ASSETS[0], added].map((asset) => ({
          id: asset.id,
          pathKey: assetPathKey(asset.path),
        })),
        clipCandidateK: 10,
        topK: 2,
        dino: {
          cacheDir: path.join(dir, 'dino-cache'),
          modelName: MODEL,
          embeddingType: 'global',
          dim: 2,
          sourcePaths: [],
        },
      },
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )

    assert.equal(actual.stopped, false)
    assert.equal(actual.result.scanned, CATEGORY_ASSETS.length + 1)
    assert.deepEqual(
      actual.result.hits.map((hit) => hit.assetId),
      [added.id, CATEGORY_ASSETS[0].id],
    )
    assert.ok(actual.result.hits[0].clipScore > actual.result.hits[1].clipScore)
  })
})

test('category feedback worker jobs honor a pre-set stop flag', async () => {
  await withTempDir(async (dir) => {
    const cache = seedClipCache(dir, CATEGORY_ASSETS)
    const stopView = new Int32Array(new SharedArrayBuffer(4))
    Atomics.store(stopView, 0, 1)
    const feedback = await runAssetFeedbackBuild(
      { kind: 'feedback_build', source: feedbackSource(), cache },
      stopView,
      () => {},
    )
    assert.equal(feedback.stopped, true)

    const fresh = await runAssetFeedbackBuild(
      { kind: 'feedback_build', source: feedbackSource(), cache },
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    const search = await runAssetCategorySearch(
      {
        kind: 'category_search',
        cache,
        target: fresh.result.targets[0],
        eligibleAssets: CATEGORY_ASSETS.map((asset) => ({
          id: asset.id,
          pathKey: assetPathKey(asset.path),
        })),
        clipCandidateK: 10,
        topK: 3,
        dino: {
          cacheDir: path.join(dir, 'dino-cache'),
          modelName: MODEL,
          embeddingType: 'global',
          dim: 2,
          sourcePaths: [],
        },
      },
      stopView,
      () => {},
    )
    assert.equal(search.stopped, true)
  })
})

// ── Clustering pipeline worker ─────────────────────────────────────────────

const { runAssetClusteringPipeline } = loadTsModule('electron/assetClusteringWorker.ts')

// Three tight visual groups of 8 assets each. Sign patterns differ per group
// because the 12-bit micro-bucket signature reads component signs (zero and
// positive are indistinguishable); perturbations are float16-exact and never
// flip a sign.
const CLUSTER_GROUPS = [
  { dir: 'C:\\clu\\groupA', base: [0.5, -0.5, 0.5, -0.5] },
  { dir: 'C:\\clu\\groupB', base: [-0.5, 0.5, -0.5, 0.5] },
  { dir: 'C:\\clu\\groupC', base: [0.5, 0.5, -0.5, -0.5] },
]
const PERTURBATIONS = [0, 0.03125, -0.03125, 0.015625, -0.015625, 0.0625, -0.0625, 0]

function seedClusteringLibrary(dir) {
  const assets = []
  let id = 0
  for (let groupIndex = 0; groupIndex < CLUSTER_GROUPS.length; groupIndex++) {
    const group = CLUSTER_GROUPS[groupIndex]
    for (let memberIndex = 0; memberIndex < 8; memberIndex++) {
      id += 1
      const vector = group.base.map((component, dimIndex) =>
        dimIndex === (memberIndex % 3) + 1 ? component + PERTURBATIONS[memberIndex] : component,
      )
      assets.push({ id, path: `${group.dir}\\asset-${id}.jpg`, vector, groupIndex })
    }
  }
  const source = path.join(dir, 'dinov2.jsonl')
  fs.writeFileSync(
    source,
    assets.map((asset) => embeddingRow(asset.path, asset.vector, MODEL)).join('\n') + '\n',
  )
  return { source, assets }
}

function clusteringInput(dir, source, assets, overrides = {}) {
  return {
    cacheDir: path.join(dir, 'cache'),
    modelName: MODEL,
    embeddingType: 'global',
    dim: 4,
    sourcePaths: [source],
    clipVectorDir: dir,
    scopePaths: [],
    maxAssets: 1000,
    minClusterSize: 5,
    minSimilarity: 0.9,
    autoClusters: true,
    requestedMaxClusters: 8,
    semanticRefine: false,
    semanticSimilarity: 0.86,
    semanticMaxSplits: 4,
    assets: assets.map((asset) => ({
      id: asset.id,
      pathKey: assetPathKey(asset.path),
      path: asset.path,
    })),
    ...overrides,
  }
}

test('clustering pipeline groups tight visual clusters end-to-end', async () => {
  await withTempDir(async (dir) => {
    const { source, assets } = seedClusteringLibrary(dir)
    const result = await runAssetClusteringPipeline(
      clusteringInput(dir, source, assets),
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    assert.equal(result.stopped, false)
    assert.equal(result.eligibleCount, 24)
    assert.equal(result.memberCount, 24)
    assert.equal(result.viable.length, 3)
    // Every cluster's members come from exactly one synthetic group.
    for (const cluster of result.viable) {
      assert.equal(cluster.members.length, 8)
      const groups = new Set(
        cluster.members.map(
          (member) => assets.find((asset) => asset.id === member.assetId).groupIndex,
        ),
      )
      assert.equal(groups.size, 1)
      assert.ok(cluster.avgSimilarity >= 0.9)
      assert.ok(cluster.members.every((member) => member.similarity >= 0.9))
    }
  })
})

test('clustering pipeline is deterministic and scope-filtered', async () => {
  await withTempDir(async (dir) => {
    const { source, assets } = seedClusteringLibrary(dir)
    const input = clusteringInput(dir, source, assets)
    const first = await runAssetClusteringPipeline(
      input,
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    const second = await runAssetClusteringPipeline(
      input,
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    assert.ok(first.memberCount > 0, 'determinism check needs non-empty clusters')
    assert.deepEqual(second.viable, first.viable)

    const scoped = await runAssetClusteringPipeline(
      clusteringInput(dir, source, assets, {
        scopePaths: [path.resolve('C:\\clu\\groupA')],
        autoClusters: false,
        requestedMaxClusters: 1,
      }),
      new Int32Array(new SharedArrayBuffer(4)),
      () => {},
    )
    assert.equal(scoped.eligibleCount, 8)
    assert.equal(scoped.memberCount, 8)
    assert.equal(scoped.viable.length, 1)
  })
})

test('clustering pipeline honors the stop flag', async () => {
  await withTempDir(async (dir) => {
    const { source, assets } = seedClusteringLibrary(dir)
    const stopView = new Int32Array(new SharedArrayBuffer(4))
    Atomics.store(stopView, 0, 1)
    const result = await runAssetClusteringPipeline(
      clusteringInput(dir, source, assets),
      stopView,
      () => {},
    )
    assert.equal(result.stopped, true)
  })
})
