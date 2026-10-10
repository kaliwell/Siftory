const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')

const root = path.resolve(__dirname, '..')
const userData = path.resolve(
  process.env.NEKO_SEARCH_USER_DATA ||
    path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'floating-clock-electron',
    ),
)
const command = process.argv[2]
const topPool = 60
const randomPool = 20
const maxPrototypesPerCategory = 32
const clipModel = 'clip_vit_base_patch32'
const clipDim = 512
const dinoModel = 'dinov2_vitb14'
const dinoDim = 768
const labels = ['relevant', 'not_relevant', 'unsure']
const requiredBenchmarkClasses = [
  'people_characters',
  'screenshots_text_ui',
  'products_objects',
  'animals',
  'scenes_environments',
]
const minimumManualRatio = 0.7

function artifactPaths(dir) {
  const base =
    dir ||
    process.env.NEKO_SEARCH_ANNOTATION_DIR ||
    path.join(root, 'artifacts', 'neko-search-annotation')
  return {
    dir: base,
    dataset: path.join(base, 'dataset.json'),
    judgments: path.join(base, 'judgments.json'),
    judgmentEvents: path.join(base, 'judgment-events.jsonl'),
    backups: path.join(base, 'backups'),
    report: path.join(base, 'evaluation.json'),
    acceptance: path.join(base, 'acc-02-acceptance.json'),
    workPlan: path.join(base, 'acc-02-work-plan.json'),
    classMapTemplate: path.join(base, 'class-map.template.json'),
  }
}

function optionValue(name) {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function loadClassMap(filePath, categories) {
  if (!filePath) return new Map()
  const resolved = path.resolve(filePath)
  const payload = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  const entries = Object.entries(payload?.categories || {})
  const knownCategoryIds = new Set(categories.map((category) => String(category.id)))
  const result = new Map()
  for (const [categoryId, benchmarkClass] of entries) {
    if (!knownCategoryIds.has(categoryId))
      throw new Error(`Class map references unknown category id ${categoryId}`)
    if (benchmarkClass === null || benchmarkClass === '') continue
    if (!requiredBenchmarkClasses.includes(benchmarkClass))
      throw new Error(`Class map category ${categoryId} has invalid class "${benchmarkClass}"`)
    result.set(categoryId, benchmarkClass)
  }
  return result
}

// Matches embeddingCachePathKey in electron/embeddingF16Cache.ts so that
// assets, embedding rows and F16 cache rows join on the same key.
function pathKey(filePath) {
  return String(filePath).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function candidateId(assetPath) {
  return crypto.createHash('sha1').update(pathKey(assetPath)).digest('hex').slice(0, 16)
}

async function eachJsonLine(filePath, callback) {
  if (!fs.existsSync(filePath)) return
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    if (!line) continue
    try {
      callback(JSON.parse(line))
    } catch {
      /* malformed rows are excluded from annotation candidates */
    }
  }
}

function normalize(input) {
  const vector = Float32Array.from(input, Number)
  let sum = 0
  for (const value of vector) sum += value * value
  if (!(sum > 0)) return null
  const scale = 1 / Math.sqrt(sum)
  for (let index = 0; index < vector.length; index += 1) vector[index] *= scale
  return vector
}

function dot(a, b) {
  let score = 0
  for (let index = 0; index < a.length; index += 1) score += a[index] * b[index]
  return score
}

// shiftedCosine from electron/assetLibraryEmbeddingSource.ts; a monotonic
// remap of cosine, so it does not change ranking order.
function shiftedCosine(cosine) {
  return Math.max(0, Math.min(1, (cosine + 1) / 2))
}

function seededIndices(seedText, count, limit) {
  let state = Number.parseInt(
    crypto.createHash('sha256').update(seedText).digest('hex').slice(0, 8),
    16,
  )
  const values = new Set()
  while (values.size < Math.min(count, limit)) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    values.add(state % limit)
  }
  return [...values]
}

function heapPush(heap, item) {
  heap.push(item)
  let index = heap.length - 1
  while (index > 0) {
    const parent = (index - 1) >> 1
    if (heap[parent].score <= item.score) break
    heap[index] = heap[parent]
    index = parent
  }
  heap[index] = item
}

function heapReplaceMin(heap, item) {
  heap[0] = item
  let index = 0
  for (;;) {
    const left = index * 2 + 1
    if (left >= heap.length) break
    const right = left + 1
    let smallest = left
    if (right < heap.length && heap[right].score < heap[left].score) smallest = right
    if (heap[smallest].score >= item.score) break
    heap[index] = heap[smallest]
    index = smallest
  }
  heap[index] = item
}

// Bounded min-heap TopK over a Map<pathKey, score>; ties break on the key
// so the ranking is deterministic across runs.
function topKScores(scores, limit) {
  const heap = []
  for (const [key, score] of scores) {
    const item = { key, score }
    if (heap.length < limit) heapPush(heap, item)
    else if (score > heap[0].score || (score === heap[0].score && key < heap[0].key))
      heapReplaceMin(heap, item)
  }
  return heap.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1))
}

function labelOf(entry) {
  return typeof entry === 'string' ? entry : entry?.label
}

function loadElectronModules() {
  const { loadTsModule } = require('./guard-utils.cjs')
  const electronStub = {
    app: {
      getPath: (name) => (name === 'userData' ? userData : path.join(userData, name)),
    },
  }
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, parent, isMain)
  }
  const restore = () => {
    Module._load = originalLoad
  }
  try {
    return {
      embeddingSource: loadTsModule('electron/assetLibraryEmbeddingSource.ts'),
      f16Cache: loadTsModule('electron/embeddingF16Cache.ts'),
      restore,
    }
  } catch (error) {
    restore()
    throw error
  }
}

async function loadAssetLibrary() {
  const { relationJsonlDir } = require('./guard-utils.cjs')
  const libraryDir = path.join(userData, 'asset-library')
  // Relation JSONL may live in a temp export when the library was migrated to
  // SQLite; assets.jsonl always stays in the library dir.
  const relation = relationJsonlDir(libraryDir)
  const categories = []
  await eachJsonLine(path.join(relation.dir, 'categories.jsonl'), (row) => {
    if (Number.isInteger(row?.id) && typeof row.name === 'string')
      categories.push({ id: row.id, name: row.name })
  })
  const assetsById = new Map()
  const assetsByPath = new Map()
  await eachJsonLine(path.join(libraryDir, 'assets.jsonl'), (row) => {
    if (!Number.isInteger(row?.id) || typeof row.path !== 'string') return
    const asset = { id: row.id, path: row.path, missing: row.missing === true }
    assetsById.set(asset.id, asset)
    if (!asset.missing) assetsByPath.set(pathKey(asset.path), asset)
  })
  const positives = new Map()
  const negatives = new Map()
  const addTo = (map, categoryId, asset) => {
    if (!map.has(categoryId)) map.set(categoryId, new Map())
    map.get(categoryId).set(asset.id, asset)
  }
  await eachJsonLine(path.join(relation.dir, 'asset_categories.jsonl'), (row) => {
    if (!Number.isInteger(row?.categoryId)) return
    const asset = assetsById.get(row.assetId)
    if (!asset) return
    if (row.status === 'confirmed' || row.status === 'manual_override' || row.source === 'manual') {
      if (row.status !== 'rejected' && row.status !== 'ignored')
        addTo(positives, row.categoryId, asset)
    } else if (row.status === 'rejected' || row.status === 'ignored') {
      addTo(negatives, row.categoryId, asset)
    }
  })
  await eachJsonLine(path.join(relation.dir, 'suggestions.jsonl'), (row) => {
    if (!Number.isInteger(row?.categoryId)) return
    if (row.status !== 'rejected' && row.status !== 'ignored') return
    const asset = assetsById.get(row.assetId)
    if (asset) addTo(negatives, row.categoryId, asset)
  })
  relation.cleanup()
  return { categories, assetsById, assetsByPath, positives, negatives }
}

// Deterministic prototype selection: sort by path key, then pick evenly
// spaced samples when the positives exceed the cap. Keeps the full-library
// scan cost bounded (prototypes x rows x dim).
function selectPrototypes(assets, vectors, cap) {
  const withVectors = assets
    .filter((asset) => vectors.has(pathKey(asset.path)))
    .sort((a, b) => (pathKey(a.path) < pathKey(b.path) ? -1 : 1))
  const selected =
    withVectors.length <= cap
      ? withVectors
      : seededIndices(`prototypes:${withVectors.length}`, cap, withVectors.length)
          .sort((a, b) => a - b)
          .map((index) => withVectors[index])
  return selected.map((asset) => ({ asset, vector: vectors.get(pathKey(asset.path)) }))
}

function addCandidate(candidates, asset, source, score, rankValue) {
  const id = candidateId(asset.path)
  const current = candidates.get(id) || { id, path: asset.path, assetId: asset.id, sources: [] }
  current.sources.push({ source, score, rank: rankValue })
  candidates.set(id, current)
}

// Seeded prefill merge: manual judgments are never overwritten, seeded
// judgments are refreshed, new candidates get their seeded label filled in.
function seedJudgments(existing, seeded, updatedAt) {
  const result = { version: 1, judgments: {} }
  for (const [categoryIdValue, entries] of Object.entries(existing?.judgments || {}))
    result.judgments[categoryIdValue] = { ...entries }
  for (const [categoryIdValue, entries] of seeded) {
    const bucket = (result.judgments[categoryIdValue] ||= {})
    for (const [id, label] of entries) {
      const previous = bucket[id]
      if (previous && typeof previous === 'object' && previous.origin === 'manual') continue
      bucket[id] = { label, origin: 'seeded', updatedAt }
    }
  }
  return result
}

async function scanClipScores(clipStorePath, assetsByPath, categoryPrototypes) {
  const scores = categoryPrototypes.map(() => new Map())
  let scanned = 0
  await eachJsonLine(clipStorePath, (row) => {
    if (
      row?.modelName !== clipModel ||
      row.embeddingType !== 'global' ||
      typeof row.imageId !== 'string' ||
      !Array.isArray(row.vector) ||
      row.vector.length < clipDim
    )
      return
    const key = pathKey(row.imageId)
    if (!assetsByPath.has(key)) return
    const vector = normalize(row.vector.slice(0, clipDim))
    if (!vector) return
    scanned += 1
    for (let index = 0; index < categoryPrototypes.length; index += 1) {
      let best = -1
      for (const prototype of categoryPrototypes[index])
        best = Math.max(best, dot(vector, prototype.vector))
      if (best > (scores[index].get(key) ?? -1)) scores[index].set(key, best)
    }
    if (scanned % 20000 === 0)
      console.error(`prepare: scanned ${scanned.toLocaleString()} CLIP asset vectors`)
  })
  return scores
}

async function prepare() {
  const paths = artifactPaths()
  const warnings = []
  const library = await loadAssetLibrary()
  if (library.categories.length === 0)
    throw new Error(`No categories found under ${path.join(userData, 'asset-library')}`)
  const classMap = loadClassMap(optionValue('class-map'), library.categories)
  const mappedClasses = new Set(classMap.values())
  const unmappedRequiredClasses = requiredBenchmarkClasses.filter(
    (benchmarkClass) => !mappedClasses.has(benchmarkClass),
  )
  if (unmappedRequiredClasses.length > 0)
    warnings.push(`ACC-02 class map is incomplete; missing: ${unmappedRequiredClasses.join(', ')}`)
  // --category=id|name builds the candidate pool for a single category only.
  const categoryArg = process.argv.find((arg) => arg.startsWith('--category='))
  let categories = library.categories
  if (categoryArg) {
    const value = categoryArg.slice('--category='.length).trim()
    if (!value) throw new Error('--category requires a category id or name')
    categories = library.categories.filter(
      (category) => String(category.id) === value || category.name === value,
    )
    if (categories.length === 0) throw new Error(`--category "${value}" matched no category`)
  }
  const clipStorePath = path.join(userData, 'vector-db', 'embeddings', `${clipModel}__global.jsonl`)
  const dinoStorePath = path.join(userData, 'vector-db', 'embeddings', `${dinoModel}__global.jsonl`)
  const modules = loadElectronModules()
  try {
    const active = []
    for (const category of categories) {
      const positives = [...(library.positives.get(category.id)?.values() || [])].filter(
        (asset) => !asset.missing,
      )
      if (positives.length === 0) {
        warnings.push(
          `category ${category.id} (${category.name}) has no confirmed positives; skipped`,
        )
        continue
      }
      active.push({ category, positives })
    }
    // CLIP prototypes and full-library max-cosine scan.
    const clipPrototypes = []
    for (const entry of active) {
      const vectors = await modules.embeddingSource.loadAssetClipEmbeddingsForPaths(
        entry.positives.map((asset) => asset.path),
      )
      const prototypes = selectPrototypes(entry.positives, vectors, maxPrototypesPerCategory)
      if (prototypes.length === 0) {
        warnings.push(
          `category ${entry.category.id} (${entry.category.name}) has no CLIP vectors for its positives; CLIP ranking skipped`,
        )
      } else if (prototypes.length < vectors.size || vectors.size < entry.positives.length) {
        warnings.push(
          `category ${entry.category.id} (${entry.category.name}): using ${prototypes.length}/${entry.positives.length} positives as CLIP prototypes`,
        )
      }
      clipPrototypes.push(prototypes)
    }
    if (!fs.existsSync(clipStorePath))
      throw new Error(`CLIP embedding store not found: ${clipStorePath}`)
    const clipScores = await scanClipScores(clipStorePath, library.assetsByPath, clipPrototypes)
    // DINO prototypes and F16 cache scan (cache is a rebuildable derived artifact).
    let dinoScores = active.map(() => new Map())
    let dinoPrototypes = active.map(() => [])
    const dinoCache = await modules.f16Cache.ensureEmbeddingF16Cache({
      cacheDir: path.join(userData, 'vector-db', 'embedding-cache'),
      modelName: dinoModel,
      embeddingType: 'global',
      dim: dinoDim,
      sourcePaths: fs.existsSync(dinoStorePath) ? [dinoStorePath] : [],
    })
    if (!dinoCache || dinoCache.meta.count <= 0) {
      warnings.push('DINO Float16 cache unavailable; DINO rankings are empty')
    } else {
      dinoPrototypes = []
      for (const entry of active) {
        const vectors = await modules.f16Cache.readEmbeddingF16VectorsForPaths(
          dinoCache,
          entry.positives.map((asset) => asset.path),
        )
        dinoPrototypes.push(selectPrototypes(entry.positives, vectors, maxPrototypesPerCategory))
      }
      let scanned = 0
      await modules.f16Cache.streamEmbeddingF16Cache(dinoCache, {
        onVector: (filePath, vector) => {
          const key = pathKey(filePath)
          if (!library.assetsByPath.has(key)) return
          scanned += 1
          for (let index = 0; index < dinoPrototypes.length; index += 1) {
            if (dinoPrototypes[index].length === 0) continue
            let best = -1
            for (const prototype of dinoPrototypes[index])
              best = Math.max(best, dot(vector, prototype.vector))
            if (best > (dinoScores[index].get(key) ?? -1)) dinoScores[index].set(key, best)
          }
          if (scanned % 20000 === 0)
            console.error(`prepare: scanned ${scanned.toLocaleString()} DINO asset vectors`)
        },
      })
    }
    const eligible = [...library.assetsByPath.values()].sort((a, b) =>
      pathKey(a.path) < pathKey(b.path) ? -1 : 1,
    )
    const generatedAt = new Date().toISOString()
    const outputCategories = []
    const seeded = new Map()
    for (let index = 0; index < active.length; index += 1) {
      const { category, positives } = active[index]
      const categoryKey = String(category.id)
      const prototypeKeys = new Set(
        [...clipPrototypes[index], ...dinoPrototypes[index]].map(({ asset }) =>
          pathKey(asset.path),
        ),
      )
      const withoutPrototypeSelfMatches = (items) =>
        items.filter((item) => !prototypeKeys.has(item.key)).slice(0, topPool)
      const rankingPoolSize = topPool + prototypeKeys.size
      const clipTop = withoutPrototypeSelfMatches(topKScores(clipScores[index], rankingPoolSize))
      const dinoTop = withoutPrototypeSelfMatches(topKScores(dinoScores[index], rankingPoolSize))
      const candidates = new Map()
      clipTop.forEach((item, rankIndex) =>
        addCandidate(
          candidates,
          library.assetsByPath.get(item.key),
          'clip',
          item.score,
          rankIndex + 1,
        ),
      )
      dinoTop.forEach((item, rankIndex) =>
        addCandidate(
          candidates,
          library.assetsByPath.get(item.key),
          'dino',
          shiftedCosine(item.score),
          rankIndex + 1,
        ),
      )
      const categorySeeded = new Map()
      for (const asset of positives) {
        addCandidate(candidates, asset, 'confirmed_positive')
        categorySeeded.set(candidateId(asset.path), 'relevant')
      }
      for (const asset of library.negatives.get(category.id)?.values() || []) {
        if (asset.missing) continue
        addCandidate(candidates, asset, 'hard_negative')
        categorySeeded.set(candidateId(asset.path), 'not_relevant')
      }
      seededIndices(`neko-search:${category.id}:${category.name}`, randomPool, eligible.length)
        .map((assetIndex) => eligible[assetIndex])
        .forEach((asset) => addCandidate(candidates, asset, 'random'))
      seeded.set(categoryKey, categorySeeded)
      outputCategories.push({
        id: category.id,
        name: category.name,
        benchmarkClass: classMap.get(categoryKey) || null,
        prototypes: {
          clip: clipPrototypes[index].map(({ asset }) => candidateId(asset.path)),
          dino: dinoPrototypes[index].map(({ asset }) => candidateId(asset.path)),
        },
        rankings: {
          clip: clipTop.map((item) => ({ id: candidateId(item.key), score: item.score })),
          dino: dinoTop.map((item) => ({
            id: candidateId(item.key),
            score: shiftedCosine(item.score),
          })),
        },
        candidates: [...candidates.values()].sort(
          (a, b) => bestRank(a.sources) - bestRank(b.sources),
        ),
      })
    }
    if (outputCategories.length === 0)
      throw new Error('No category has confirmed positives; nothing to annotate')
    const dataset = {
      version: 1,
      generatedAt,
      userData,
      methodology:
        'Union of CLIP Top60 and DINO Top60 multi-prototype max-cosine (up to 32 evenly sampled confirmed positives per category), all confirmed positives, rejected/ignored hard negatives, and 20 deterministic random assets. Exact prototype assets are excluded from both rankings to prevent self-match leakage. DINO scores use shiftedCosine over the Float16 cache.',
      warnings,
      categories: outputCategories,
    }
    await fsp.mkdir(paths.dir, { recursive: true })
    await fsp.writeFile(paths.dataset, JSON.stringify(dataset, null, 2), 'utf8')
    const existing = fs.existsSync(paths.judgments)
      ? JSON.parse(await fsp.readFile(paths.judgments, 'utf8'))
      : { version: 1, judgments: {} }
    await fsp.writeFile(
      paths.judgments,
      JSON.stringify(seedJudgments(existing, seeded, generatedAt), null, 2),
      'utf8',
    )
    console.log(
      JSON.stringify(
        {
          ok: true,
          datasetPath: paths.dataset,
          categories: outputCategories.length,
          skippedCategories: library.categories.length - outputCategories.length,
          assets: library.assetsByPath.size,
          candidates: outputCategories.reduce((sum, item) => sum + item.candidates.length, 0),
          warnings,
        },
        null,
        2,
      ),
    )
  } finally {
    modules.restore()
  }
}

function bestRank(sources) {
  return Math.min(...sources.map((source) => source.rank || 1e9))
}

function candidateTier(candidate) {
  const rank = Math.min(
    ...candidate.sources
      .filter((source) => source.source === 'clip' || source.source === 'dino')
      .map((source) => source.rank || Number.POSITIVE_INFINITY),
  )
  if (rank <= 10) return 0
  if (rank <= 20) return 1
  if (rank <= 50) return 2
  return 3
}

function fingerprintDataset(dataset) {
  const canonical = dataset.categories.map((category) => ({
    id: category.id,
    candidates: category.candidates.map((candidate) => candidate.id),
    rankings: {
      clip: category.rankings.clip.map((item) => item.id),
      dino: category.rankings.dino.map((item) => item.id),
    },
  }))
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function fingerprintJudgments(judgments) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(judgments.judgments || {}))
    .digest('hex')
}

function validateState(dataset, judgments) {
  const errors = []
  const warnings = []
  const categoryIds = new Set()
  const candidateIds = new Map()
  const missingFileExamples = []
  let missingFiles = 0
  let candidates = 0
  for (const category of dataset.categories) {
    if (categoryIds.has(category.id)) errors.push(`duplicate category: ${category.id}`)
    categoryIds.add(category.id)
    const ids = new Set()
    for (const candidate of category.candidates) {
      candidates += 1
      if (ids.has(candidate.id)) errors.push(`duplicate candidate: ${category.id}/${candidate.id}`)
      ids.add(candidate.id)
      if (!fs.existsSync(candidate.path)) {
        missingFiles += 1
        if (missingFileExamples.length < 10) missingFileExamples.push(candidate.path)
      }
    }
    candidateIds.set(String(category.id), ids)
    for (const model of ['clip', 'dino'])
      for (const item of category.rankings[model] || [])
        if (!ids.has(item.id))
          errors.push(`ranking outside pool: ${category.id}/${model}/${item.id}`)
  }
  let judgmentsCount = 0
  let staleJudgments = 0
  for (const [categoryIdValue, entries] of Object.entries(judgments.judgments || {})) {
    const ids = candidateIds.get(categoryIdValue)
    if (!ids) {
      staleJudgments += Object.keys(entries).length
      warnings.push(`judgments for unknown category: ${categoryIdValue}`)
      continue
    }
    for (const [id, entry] of Object.entries(entries)) {
      judgmentsCount += 1
      if (!ids.has(id)) {
        staleJudgments += 1
        continue
      }
      if (!labels.includes(labelOf(entry)))
        errors.push(`invalid judgment: ${categoryIdValue}/${id}/${labelOf(entry)}`)
    }
  }
  if (staleJudgments > 0) warnings.push(`${staleJudgments} stale judgments are ignored`)
  if (missingFiles > 0) errors.push(`${missingFiles} candidate image files are missing`)
  return {
    ok: errors.length === 0,
    datasetFingerprint: fingerprintDataset(dataset),
    judgmentFingerprint: fingerprintJudgments(judgments),
    candidates,
    judgments: judgmentsCount,
    staleJudgments,
    missingFiles,
    missingFileExamples,
    errors,
    warnings,
  }
}

function loadState(paths) {
  const dataset = JSON.parse(fs.readFileSync(paths.dataset, 'utf8'))
  const judgments = JSON.parse(fs.readFileSync(paths.judgments, 'utf8'))
  return { dataset, judgments, integrity: validateState(dataset, judgments) }
}

function loadJudgmentEvents(paths) {
  if (!fs.existsSync(paths.dir)) return []
  const names = fs
    .readdirSync(paths.dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === 'judgment-events.jsonl' || /^judgment-events-.*\.jsonl$/.test(entry.name)),
    )
    .map((entry) => entry.name)
    .sort()
  const events = []
  for (const name of names) {
    for (const line of fs.readFileSync(path.join(paths.dir, name), 'utf8').split(/\r?\n/)) {
      if (!line) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        /* malformed audit rows never count as verified manual work */
      }
    }
  }
  return events
}

function sourceIds(category, source) {
  return category.candidates
    .filter((candidate) => candidate.sources?.some((item) => item.source === source))
    .map((candidate) => candidate.id)
}

function rankedIds(category, limit) {
  return new Set(
    ['clip', 'dino'].flatMap((model) =>
      (category.rankings?.[model] || []).slice(0, limit).map((item) => item.id),
    ),
  )
}

function completionFor(ids, entries) {
  const values = [...ids]
  const decided = values.filter((id) => {
    const label = labelOf(entries[id])
    return label === 'relevant' || label === 'not_relevant'
  }).length
  return {
    candidates: values.length,
    decided,
    coverage: decided / Math.max(1, values.length),
    complete: values.length > 0 && decided === values.length,
  }
}

function buildAcc02Acceptance(dataset, judgments, events, integrity) {
  const datasetFingerprint = fingerprintDataset(dataset)
  const latestAuditedLabels = new Map()
  for (const event of events) {
    if (!Number.isInteger(event?.categoryId) || typeof event.id !== 'string') continue
    if (event.datasetFingerprint !== datasetFingerprint) continue
    latestAuditedLabels.set(`${event.categoryId}:${event.id}`, event.label)
  }
  const categories = dataset.categories.map((category) => {
    const entries = judgments.judgments?.[String(category.id)] || {}
    const confirmedPositiveIds = sourceIds(category, 'confirmed_positive')
    const hardNegativeIds = sourceIds(category, 'hard_negative')
    const randomIds = sourceIds(category, 'random')
    const candidateIds = new Set(category.candidates.map((candidate) => candidate.id))
    const prototypeIds = new Set([
      ...(category.prototypes?.clip || []),
      ...(category.prototypes?.dino || []),
    ])
    const ranked = new Set(
      ['clip', 'dino'].flatMap((model) =>
        (category.rankings?.[model] || []).map((item) => item.id),
      ),
    )
    const decidedIds = category.candidates
      .map((candidate) => candidate.id)
      .filter((id) => ['relevant', 'not_relevant'].includes(labelOf(entries[id])))
    const auditedManual = decidedIds.filter((id) => {
      const entry = entries[id]
      return (
        entry?.origin === 'manual' &&
        latestAuditedLabels.get(`${category.id}:${id}`) === labelOf(entry)
      )
    }).length
    const manualRatio = auditedManual / Math.max(1, decidedIds.length)
    const top20 = completionFor(rankedIds(category, 20), entries)
    const top50 = completionFor(rankedIds(category, 50), entries)
    const random = completionFor(new Set(randomIds), entries)
    const issues = []
    if (!requiredBenchmarkClasses.includes(category.benchmarkClass))
      issues.push('missing or invalid benchmarkClass')
    if (confirmedPositiveIds.length === 0)
      issues.push('confirmed-positive set is empty or not independently recorded')
    if (hardNegativeIds.length === 0)
      issues.push('hard-negative set is empty or not independently recorded')
    if (confirmedPositiveIds.some((id) => labelOf(entries[id]) !== 'relevant'))
      issues.push('confirmed-positive set contains a non-relevant judgment')
    if (hardNegativeIds.some((id) => labelOf(entries[id]) !== 'not_relevant'))
      issues.push('hard-negative set contains a non-negative judgment')
    if (randomIds.length < randomPool)
      issues.push(`random pool has ${randomIds.length}/${randomPool} required candidates`)
    if ([...prototypeIds].some((id) => !candidateIds.has(id)))
      issues.push('prototype set references a candidate outside the pool')
    if ([...prototypeIds].some((id) => !confirmedPositiveIds.includes(id)))
      issues.push('prototype set contains an asset outside confirmed positives')
    if ([...prototypeIds].some((id) => ranked.has(id)))
      issues.push('prototype self-match leakage is present in a ranking')
    if (decidedIds.length !== category.candidates.length)
      issues.push('candidate pool is not 100% decided')
    if (manualRatio < minimumManualRatio)
      issues.push(
        `audited manual ratio ${(manualRatio * 100).toFixed(1)}% is below ${minimumManualRatio * 100}%`,
      )
    if (top20.candidates < 20)
      issues.push(`Top20 ranking only has ${top20.candidates}/20 candidates`)
    else if (!top20.complete) issues.push('Top20 is not 100% decided')
    if (top50.candidates < 50)
      issues.push(`Top50 ranking only has ${top50.candidates}/50 candidates`)
    else if (!top50.complete) issues.push('Top50 is not 100% decided')
    if (!random.complete) issues.push('random pool is not 100% decided')
    return {
      id: category.id,
      name: category.name,
      benchmarkClass: category.benchmarkClass || null,
      candidates: category.candidates.length,
      confirmedPositives: confirmedPositiveIds.length,
      hardNegatives: hardNegativeIds.length,
      prototypes: prototypeIds.size,
      decided: decidedIds.length,
      auditedManual,
      manualRatio,
      completion: { top20, top50, random },
      issues,
      ready: issues.length === 0,
    }
  })
  const coveredClasses = new Set(
    categories
      .map((category) => category.benchmarkClass)
      .filter((value) => requiredBenchmarkClasses.includes(value)),
  )
  const missingClasses = requiredBenchmarkClasses.filter((value) => !coveredClasses.has(value))
  const globalIssues = []
  if (!integrity.ok) globalIssues.push('annotation integrity gate failed')
  if (categories.length < requiredBenchmarkClasses.length)
    globalIssues.push(
      `only ${categories.length}/${requiredBenchmarkClasses.length} benchmark categories exist`,
    )
  if (missingClasses.length > 0)
    globalIssues.push(`missing benchmark classes: ${missingClasses.join(', ')}`)
  if (categories.some((category) => !category.ready))
    globalIssues.push('one or more categories do not meet ACC-02 acceptance')
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    datasetFingerprint,
    judgmentFingerprint: fingerprintJudgments(judgments),
    policy: {
      requiredBenchmarkClasses,
      minimumManualRatio,
      requiredCompletion: ['Top20', 'Top50', 'random'],
      auditedManualLabelsOnly: true,
      prototypeSelfMatchesAllowed: false,
    },
    summary: {
      categories: categories.length,
      readyCategories: categories.filter((category) => category.ready).length,
      coveredClasses: [...coveredClasses],
      missingClasses,
      publishable: globalIssues.length === 0,
    },
    integrity,
    globalIssues,
    categories,
  }
}

function buildAcc02WorkPlan(dataset, judgments, events, integrity) {
  const acceptance = buildAcc02Acceptance(dataset, judgments, events, integrity)
  const datasetFingerprint = acceptance.datasetFingerprint
  const latestAuditedLabels = new Map()
  for (const event of events) {
    if (
      event?.datasetFingerprint !== datasetFingerprint ||
      !Number.isInteger(event.categoryId) ||
      typeof event.id !== 'string'
    )
      continue
    latestAuditedLabels.set(`${event.categoryId}:${event.id}`, event.label)
  }
  const acceptanceById = new Map(acceptance.categories.map((category) => [category.id, category]))
  const categories = dataset.categories.map((category) => {
    const entries = judgments.judgments?.[String(category.id)] || {}
    const accepted = acceptanceById.get(category.id)
    const reviewQueue = category.candidates
      .filter((candidate) => fs.existsSync(candidate.path))
      .filter((candidate) => {
        const entry = entries[candidate.id]
        const label = labelOf(entry)
        return !(
          entry?.origin === 'manual' &&
          latestAuditedLabels.get(`${category.id}:${candidate.id}`) === label &&
          (label === 'relevant' || label === 'not_relevant')
        )
      })
      .sort(
        (a, b) =>
          candidateTier(a) - candidateTier(b) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((candidate) => candidate.id)
    const requiredAuditedManual = Math.ceil(accepted.decided * minimumManualRatio)
    return {
      id: category.id,
      name: category.name,
      benchmarkClass: category.benchmarkClass || null,
      candidates: accepted.candidates,
      decided: accepted.decided,
      auditedManual: accepted.auditedManual,
      requiredAuditedManual,
      additionalManualRequired: Math.max(0, requiredAuditedManual - accepted.auditedManual),
      reviewQueue,
      missingCandidateIds: category.candidates
        .filter((candidate) => !fs.existsSync(candidate.path))
        .map((candidate) => candidate.id),
      issues: accepted.issues,
      ready: accepted.ready,
    }
  })
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    datasetFingerprint,
    judgmentFingerprint: acceptance.judgmentFingerprint,
    privacy: 'Candidate source paths are intentionally excluded.',
    summary: {
      categories: categories.length,
      readyCategories: categories.filter((category) => category.ready).length,
      missingClasses: acceptance.summary.missingClasses,
      additionalManualRequired: categories.reduce(
        (sum, category) => sum + category.additionalManualRequired,
        0,
      ),
      reviewQueueItems: categories.reduce((sum, category) => sum + category.reviewQueue.length, 0),
      missingFiles: integrity.missingFiles,
      blocked: !acceptance.summary.publishable,
    },
    categories,
  }
}

async function workPlan(paths) {
  const { dataset, judgments, integrity } = loadState(paths)
  const plan = buildAcc02WorkPlan(dataset, judgments, loadJudgmentEvents(paths), integrity)
  const library = await loadAssetLibrary()
  const datasetClassById = new Map(
    dataset.categories.map((category) => [String(category.id), category.benchmarkClass || null]),
  )
  const libraryCategories = library.categories.map((category) => ({
    id: category.id,
    name: category.name,
    benchmarkClass: datasetClassById.get(String(category.id)) || null,
    confirmedPositives: [...(library.positives.get(category.id)?.values() || [])].filter(
      (asset) => !asset.missing,
    ).length,
    hardNegatives: [...(library.negatives.get(category.id)?.values() || [])].filter(
      (asset) => !asset.missing,
    ).length,
  }))
  let recoverableMissingFiles = 0
  for (const categoryPlan of plan.categories) {
    const datasetCategory = dataset.categories.find((category) => category.id === categoryPlan.id)
    categoryPlan.recoverableMissingCandidateIds = (datasetCategory?.candidates || [])
      .filter((candidate) => !fs.existsSync(candidate.path))
      .filter((candidate) => {
        const current = library.assetsById.get(candidate.assetId)
        return current && !current.missing && fs.existsSync(current.path)
      })
      .map((candidate) => candidate.id)
    recoverableMissingFiles += categoryPlan.recoverableMissingCandidateIds.length
  }
  plan.liveLibraryCategories = libraryCategories
  plan.summary.liveLibraryCategories = libraryCategories.length
  plan.summary.categoriesWithConfirmedPositives = libraryCategories.filter(
    (category) => category.confirmedPositives > 0,
  ).length
  plan.summary.recoverableMissingFiles = recoverableMissingFiles
  const classMapTemplate = {
    version: 1,
    requiredBenchmarkClasses,
    categories: Object.fromEntries(
      libraryCategories.map((category) => [String(category.id), category.benchmarkClass]),
    ),
  }
  await fsp.mkdir(paths.dir, { recursive: true })
  await Promise.all([
    fsp.writeFile(paths.workPlan, JSON.stringify(plan, null, 2), 'utf8'),
    fsp.writeFile(paths.classMapTemplate, JSON.stringify(classMapTemplate, null, 2), 'utf8'),
  ])
  console.log(
    JSON.stringify(
      {
        ok: true,
        workPlanPath: paths.workPlan,
        classMapTemplatePath: paths.classMapTemplate,
        ...plan.summary,
      },
      null,
      2,
    ),
  )
}

async function acceptance(paths) {
  const { dataset, judgments, integrity } = loadState(paths)
  const report = buildAcc02Acceptance(dataset, judgments, loadJudgmentEvents(paths), integrity)
  await fsp.writeFile(paths.acceptance, JSON.stringify(report, null, 2), 'utf8')
  console.log(
    JSON.stringify(
      {
        reportPath: paths.acceptance,
        ...report.summary,
        globalIssues: report.globalIssues,
        categories: report.categories.map((category) => ({
          id: category.id,
          name: category.name,
          benchmarkClass: category.benchmarkClass,
          manualRatio: category.manualRatio,
          ready: category.ready,
          issues: category.issues,
        })),
      },
      null,
      2,
    ),
  )
  if (!report.summary.publishable) process.exitCode = 2
}

async function backupJudgments(paths, reason = 'manual', currentState) {
  const state = currentState || loadState(paths)
  await fsp.mkdir(paths.backups, { recursive: true })
  const backups = (await fsp.readdir(paths.backups, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^judgments-.*\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  if (reason === 'serve-start' && backups.length > 0) {
    try {
      const latest = JSON.parse(
        await fsp.readFile(path.join(paths.backups, backups.at(-1)), 'utf8'),
      )
      if (
        latest.datasetFingerprint === state.integrity.datasetFingerprint &&
        latest.judgmentFingerprint === state.integrity.judgmentFingerprint
      )
        return null
    } catch {
      /* an invalid old backup does not block creation of a new valid snapshot */
    }
  }
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const filePath = path.join(paths.backups, `judgments-${timestamp}.json`)
  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    reason,
    datasetFingerprint: state.integrity.datasetFingerprint,
    judgmentFingerprint: state.integrity.judgmentFingerprint,
    judgments: state.judgments,
  }
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
  backups.push(path.basename(filePath))
  for (const name of backups.slice(0, Math.max(0, backups.length - 20)))
    await fsp.unlink(path.join(paths.backups, name))
  console.log(JSON.stringify({ backupPath: filePath, judgments: state.integrity.judgments }))
  return filePath
}

async function restoreJudgments(paths, fileName, confirmed) {
  if (!fileName || !confirmed) throw new Error('Restore requires a backup file name and --confirm')
  const filePath = path.resolve(paths.backups, fileName)
  const backupRoot = `${path.resolve(paths.backups)}${path.sep}`
  if (!filePath.startsWith(backupRoot))
    throw new Error('Backup must be inside the backup directory')
  const current = loadState(paths)
  const payload = JSON.parse(await fsp.readFile(filePath, 'utf8'))
  if (payload.datasetFingerprint !== current.integrity.datasetFingerprint)
    throw new Error('Backup dataset fingerprint does not match the current dataset')
  const restoredJudgments = payload.judgments
  const restoredIntegrity = validateState(current.dataset, restoredJudgments)
  if (!restoredIntegrity.ok || restoredIntegrity.staleJudgments > 0)
    throw new Error(`Backup judgments failed validation: ${restoredIntegrity.errors.join('; ')}`)
  await backupJudgments(paths, 'before-restore', current)
  const temporary = `${paths.judgments}.${process.pid}.restore.tmp`
  await fsp.writeFile(temporary, JSON.stringify(restoredJudgments, null, 2), 'utf8')
  await fsp.rename(temporary, paths.judgments)
  console.log(
    JSON.stringify({
      restoredFrom: filePath,
      judgments: restoredIntegrity.judgments,
      judgmentFingerprint: restoredIntegrity.judgmentFingerprint,
    }),
  )
}

async function appendJudgmentEvent(paths, event) {
  try {
    const stat = await fsp.stat(paths.judgmentEvents)
    if (stat.size >= 5 * 1024 * 1024) {
      const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
      const archived = path.join(paths.dir, `judgment-events-${timestamp}.jsonl`)
      await fsp.rename(paths.judgmentEvents, archived)
      const archives = (await fsp.readdir(paths.dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^judgment-events-.*\.jsonl$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
      for (const name of archives.slice(0, Math.max(0, archives.length - 5)))
        await fsp.unlink(path.join(paths.dir, name))
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await fsp.appendFile(paths.judgmentEvents, `${JSON.stringify(event)}\n`, 'utf8')
}

function metricForRanking(ranking, categoryLabels, totalRelevant, poolComplete, k) {
  const top = ranking.slice(0, k)
  const relevant = top.filter((item) => categoryLabels[item.id] === 'relevant').length
  const judged = top.filter(
    (item) => categoryLabels[item.id] && categoryLabels[item.id] !== 'unsure',
  ).length
  let dcg = 0
  top.forEach((item, index) => {
    if (categoryLabels[item.id] === 'relevant') dcg += 1 / Math.log2(index + 2)
  })
  let ideal = 0
  for (let index = 0; index < Math.min(k, totalRelevant); index += 1)
    ideal += 1 / Math.log2(index + 2)
  return {
    precision: judged === top.length ? relevant / Math.max(1, top.length) : null,
    judgedPrecision: judged > 0 ? relevant / judged : null,
    pooledRecall: poolComplete && totalRelevant > 0 ? relevant / totalRelevant : null,
    ndcg: poolComplete && ideal > 0 ? dcg / ideal : null,
    judged,
    coverage: judged / Math.max(1, top.length),
    complete: judged === top.length,
  }
}

function average(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function aggregateMetrics(categories, model, k) {
  const metrics = categories.map((category) => category[model][`@${k}`])
  const ready = metrics.filter((metric) => metric.complete)
  const poolReady = categories.filter((category) => category.complete)
  return {
    readyCategories: ready.length,
    totalCategories: categories.length,
    macroPrecision: average(
      ready.map((metric) => metric.precision).filter((value) => value !== null),
    ),
    macroJudgedPrecision: average(
      metrics.map((metric) => metric.judgedPrecision).filter((value) => value !== null),
    ),
    macroPooledRecall: average(
      poolReady
        .map((category) => category[model][`@${k}`].pooledRecall)
        .filter((value) => value !== null),
    ),
    macroNdcg: average(
      poolReady.map((category) => category[model][`@${k}`].ndcg).filter((value) => value !== null),
    ),
  }
}

function categoryLabels(judgments, category) {
  const entries = judgments.judgments[String(category.id)] || {}
  return Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, labelOf(entry)]))
}

async function evaluate(paths) {
  const { dataset, judgments, integrity } = loadState(paths)
  const result = []
  for (const category of dataset.categories) {
    const labelsForCategory = categoryLabels(judgments, category)
    const labelValues = category.candidates.map((candidate) => labelsForCategory[candidate.id])
    const relevant = labelValues.filter((label) => label === 'relevant').length
    const notRelevant = labelValues.filter((label) => label === 'not_relevant').length
    const unsure = labelValues.filter((label) => label === 'unsure').length
    const decided = relevant + notRelevant
    const poolComplete = decided === category.candidates.length
    result.push({
      id: category.id,
      name: category.name,
      labeled: decided + unsure,
      decided,
      unsure,
      candidates: category.candidates.length,
      coverage: decided / Math.max(1, category.candidates.length),
      complete: poolComplete,
      relevant,
      clip: Object.fromEntries(
        [10, 20, 50].map((k) => [
          `@${k}`,
          metricForRanking(category.rankings.clip, labelsForCategory, relevant, poolComplete, k),
        ]),
      ),
      dino: Object.fromEntries(
        [10, 20, 50].map((k) => [
          `@${k}`,
          metricForRanking(category.rankings.dino, labelsForCategory, relevant, poolComplete, k),
        ]),
      ),
    })
  }
  const total = result.reduce((sum, item) => sum + item.candidates, 0)
  const decided = result.reduce((sum, item) => sum + item.decided, 0)
  const aggregate = Object.fromEntries(
    ['clip', 'dino'].map((model) => [
      model,
      Object.fromEntries([10, 20, 50].map((k) => [`@${k}`, aggregateMetrics(result, model, k)])),
    ]),
  )
  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      categories: result.length,
      readyCategories: result.filter((item) => item.complete).length,
      candidates: total,
      decided,
      coverage: decided / Math.max(1, total),
      publishable: integrity.ok && result.every((item) => item.complete),
      warning:
        decided === total
          ? null
          : 'Accuracy metrics are provisional until every candidate has a relevant or not_relevant judgment.',
    },
    integrity,
    aggregate,
    categories: result,
  }
  await fsp.mkdir(paths.dir, { recursive: true })
  await fsp.writeFile(paths.report, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({ reportPath: paths.report, ...report.summary }, null, 2))
}

function status(paths) {
  const { dataset, judgments, integrity } = loadState(paths)
  let decided = 0
  let unsure = 0
  let seededDecided = 0
  let manualDecided = 0
  const tiers = [
    { name: 'Top10', candidates: 0, decided: 0, seeded: 0, manual: 0 },
    { name: 'Top20', candidates: 0, decided: 0, seeded: 0, manual: 0 },
    { name: 'Top50', candidates: 0, decided: 0, seeded: 0, manual: 0 },
    { name: 'Pool', candidates: 0, decided: 0, seeded: 0, manual: 0 },
  ]
  for (const category of dataset.categories) {
    const entries = judgments.judgments[String(category.id)] || {}
    for (const candidate of category.candidates) {
      const entry = entries[candidate.id]
      const label = labelOf(entry)
      const origin = typeof entry === 'object' && entry ? entry.origin : undefined
      const tier = tiers[candidateTier(candidate)]
      tier.candidates += 1
      if (label === 'relevant' || label === 'not_relevant') {
        decided += 1
        tier.decided += 1
        if (origin === 'manual') {
          manualDecided += 1
          tier.manual += 1
        } else {
          seededDecided += 1
          tier.seeded += 1
        }
      } else if (label === 'unsure') unsure += 1
    }
  }
  console.log(
    JSON.stringify(
      {
        ...integrity,
        categories: dataset.categories.length,
        decided,
        seededDecided,
        manualDecided,
        unsure,
        coverage: decided / Math.max(1, integrity.candidates),
        tiers,
      },
      null,
      2,
    ),
  )
  if (!integrity.ok) process.exitCode = 1
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.png'
    ? 'image/png'
    : ext === '.gif'
      ? 'image/gif'
      : ext === '.webp'
        ? 'image/webp'
        : 'image/jpeg'
}

async function serve(paths, options = {}) {
  const html = fs.readFileSync(path.join(__dirname, 'neko-search-annotation.html'), 'utf8')
  let state = loadState(paths)
  if (!state.integrity.ok)
    throw new Error(
      `Annotation dataset failed integrity checks. Run status first. ${state.integrity.errors.join('; ')}`,
    )
  if (state.integrity.judgments > 0) await backupJudgments(paths, 'serve-start', state)
  const plan = buildAcc02WorkPlan(
    state.dataset,
    state.judgments,
    loadJudgmentEvents(paths),
    state.integrity,
  )
  state.reviewQueue = Object.fromEntries(
    plan.categories.map((category) => [String(category.id), category.reviewQueue]),
  )
  let judgmentWriteQueue = Promise.resolve()
  const allowed = new Map()
  for (const category of state.dataset.categories)
    for (const item of category.candidates) allowed.set(`${category.id}:${item.id}`, item.path)
  const handleRequest = async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      return response.end(html)
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      return response.end(JSON.stringify(state))
    }
    if (request.method === 'GET' && url.pathname === '/image') {
      const filePath = allowed.get(
        `${url.searchParams.get('category')}:${url.searchParams.get('id')}`,
      )
      if (!filePath || !fs.existsSync(filePath)) {
        response.statusCode = 404
        return response.end('missing')
      }
      response.setHeader('Content-Type', contentType(filePath))
      const stream = fs.createReadStream(filePath)
      stream.on('error', (error) => {
        if (!response.headersSent) {
          response.statusCode = 404
          response.end('missing')
        } else response.destroy(error)
      })
      return stream.pipe(response)
    }
    if (request.method === 'POST' && url.pathname === '/api/judgment') {
      let body = ''
      try {
        for await (const chunk of request) {
          body += chunk
          if (body.length > 4096) throw new Error('request body too large')
        }
      } catch {
        response.statusCode = 413
        return response.end('invalid')
      }
      let value
      try {
        value = JSON.parse(body)
      } catch {
        response.statusCode = 400
        return response.end('invalid')
      }
      if (
        !value ||
        typeof value !== 'object' ||
        !allowed.has(`${value.categoryId}:${value.id}`) ||
        !['relevant', 'not_relevant', 'unsure', 'unlabeled'].includes(value.label)
      ) {
        response.statusCode = 400
        return response.end('invalid')
      }
      const categoryKey = String(value.categoryId)
      state.judgments.judgments[categoryKey] ||= {}
      const previousEntry = state.judgments.judgments[categoryKey][value.id] || null
      const previous = labelOf(previousEntry) || null
      if (value.label === 'unlabeled') delete state.judgments.judgments[categoryKey][value.id]
      else
        state.judgments.judgments[categoryKey][value.id] = {
          label: value.label,
          origin: 'manual',
          updatedAt: new Date().toISOString(),
        }
      const snapshot = JSON.stringify(state.judgments, null, 2)
      judgmentWriteQueue = judgmentWriteQueue
        .catch(() => undefined)
        .then(async () => {
          const temporary = `${paths.judgments}.${process.pid}.tmp`
          await fsp.writeFile(temporary, snapshot, 'utf8')
          await fsp.rename(temporary, paths.judgments)
          const event = {
            at: new Date().toISOString(),
            datasetFingerprint: state.integrity.datasetFingerprint,
            categoryId: value.categoryId,
            id: value.id,
            previous,
            label: value.label === 'unlabeled' ? null : value.label,
          }
          try {
            await appendJudgmentEvent(paths, event)
          } catch (error) {
            console.warn(`Could not append annotation audit event: ${error.message}`)
          }
        })
      await judgmentWriteQueue
      if (value.label !== 'unlabeled') {
        const reviewQueue = state.reviewQueue[categoryKey] || []
        state.reviewQueue[categoryKey] = reviewQueue.filter((id) => id !== value.id)
      }
      const next = value.label === 'unlabeled' ? null : value.label
      state.integrity = {
        ...state.integrity,
        judgments:
          state.integrity.judgments +
          (previous === null && next !== null ? 1 : 0) -
          (previous !== null && next === null ? 1 : 0),
        judgmentFingerprint: fingerprintJudgments(state.judgments),
      }
      return response.end('ok')
    }
    response.statusCode = 404
    response.end('not found')
  }
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'",
    )
    void handleRequest(request, response).catch((error) => {
      console.error(`Annotation request failed: ${error.stack || error.message}`)
      if (!response.headersSent) {
        response.statusCode = 500
        response.end('internal error')
      } else response.destroy(error)
    })
  })
  const port = options.port ?? Number(process.env.NEKO_SEARCH_ANNOTATION_PORT || 41741)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  if (command === 'serve') {
    let shuttingDown = false
    const shutdown = async (signal) => {
      if (shuttingDown) return
      shuttingDown = true
      console.log(`Annotation service received ${signal}; flushing pending judgments...`)
      server.close()
      await judgmentWriteQueue.catch((error) =>
        console.error(`Pending annotation write failed during shutdown: ${error.message}`),
      )
      server.closeAllConnections?.()
      console.log('Annotation service stopped cleanly.')
    }
    process.once('SIGINT', () => void shutdown('SIGINT'))
    process.once('SIGTERM', () => void shutdown('SIGTERM'))
  }
  console.log(`Annotation UI: http://127.0.0.1:${server.address().port}`)
  return server
}

const smokePng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da63fcffff3f030005fe02fea72d81440000000049454e44ae426082',
  'hex',
)

async function buildSmokeFixture(baseDir) {
  const imageDir = path.join(baseDir, 'images')
  await fsp.mkdir(imageDir, { recursive: true })
  const categories = []
  for (let categoryIndex = 1; categoryIndex <= 3; categoryIndex += 1) {
    const candidates = []
    for (let itemIndex = 1; itemIndex <= 8; itemIndex += 1) {
      const filePath = path.join(imageDir, `cat${categoryIndex}-${itemIndex}.png`)
      await fsp.writeFile(filePath, smokePng)
      const sources = []
      if (itemIndex <= 6)
        sources.push({ source: 'clip', score: 1 - itemIndex * 0.05, rank: itemIndex })
      if (itemIndex >= 2 && itemIndex <= 7)
        sources.push({ source: 'dino', score: 0.9 - itemIndex * 0.04, rank: itemIndex - 1 })
      if (itemIndex === 8) sources.push({ source: 'random' })
      if (itemIndex === 1) sources.push({ source: 'review' })
      candidates.push({
        id: `c${categoryIndex}-${itemIndex}`,
        path: filePath,
        assetId: categoryIndex * 100 + itemIndex,
        sources,
      })
    }
    categories.push({
      id: categoryIndex,
      name: `category-${categoryIndex}`,
      rankings: {
        clip: candidates
          .slice(0, 6)
          .map((candidate, index) => ({ id: candidate.id, score: 1 - (index + 1) * 0.05 })),
        dino: candidates
          .slice(1, 7)
          .map((candidate, index) => ({ id: candidate.id, score: 0.9 - (index + 1) * 0.04 })),
      },
      candidates,
    })
  }
  const dataset = {
    version: 1,
    generatedAt: new Date().toISOString(),
    userData: baseDir,
    methodology: 'smoke fixture',
    categories,
  }
  const judgments = seedJudgments(
    {
      version: 1,
      judgments: {
        1: {
          'c1-1': { label: 'not_relevant', origin: 'manual', updatedAt: '2026-01-01T00:00:00Z' },
        },
      },
    },
    new Map([
      [
        '1',
        new Map([
          ['c1-1', 'relevant'],
          ['c1-2', 'relevant'],
        ]),
      ],
      ['2', new Map([['c2-1', 'not_relevant']])],
    ]),
    '2026-01-02T00:00:00.000Z',
  )
  await fsp.mkdir(baseDir, { recursive: true })
  await fsp.writeFile(path.join(baseDir, 'dataset.json'), JSON.stringify(dataset, null, 2), 'utf8')
  await fsp.writeFile(
    path.join(baseDir, 'judgments.json'),
    JSON.stringify(judgments, null, 2),
    'utf8',
  )
  return { dataset, judgments }
}

async function smoke() {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'neko-search-annotation-'))
  const paths = artifactPaths(baseDir)
  try {
    const { dataset } = await buildSmokeFixture(baseDir)
    // Seeded prefill must never overwrite manual labels, must refresh seeded
    // ones and must fill new candidates.
    const seeded = JSON.parse(await fsp.readFile(paths.judgments, 'utf8'))
    if (
      seeded.judgments['1']['c1-1'].label !== 'not_relevant' ||
      seeded.judgments['1']['c1-1'].origin !== 'manual' ||
      seeded.judgments['1']['c1-2'].origin !== 'seeded' ||
      seeded.judgments['2']['c2-1'].label !== 'not_relevant'
    )
      throw new Error('seeded/manual judgment merge smoke failed')
    const validIntegrity = validateState(dataset, seeded)
    const invalidLabelIntegrity = validateState(dataset, {
      version: 1,
      judgments: { 1: { 'c1-1': { label: 'invalid', origin: 'manual' } } },
    })
    const missingFileDataset = {
      ...dataset,
      categories: dataset.categories.map((category, index) =>
        index === 0
          ? {
              ...category,
              candidates: category.candidates.map((candidate, itemIndex) =>
                itemIndex === 0 ? { ...candidate, path: `${candidate.path}.missing` } : candidate,
              ),
            }
          : category,
      ),
    }
    const missingFileIntegrity = validateState(missingFileDataset, { version: 1, judgments: {} })
    const staleIntegrity = validateState(dataset, {
      version: 1,
      judgments: { 99: { 'c9-1': { label: 'relevant', origin: 'manual' } } },
    })
    if (
      !validIntegrity.ok ||
      invalidLabelIntegrity.ok ||
      missingFileIntegrity.ok ||
      staleIntegrity.staleJudgments !== 1
    )
      throw new Error('annotation integrity gate smoke failed')
    // Candidate pool merge deduplicates by id and appends sources.
    const pool = new Map()
    const asset = { id: 7, path: path.join(baseDir, 'images', 'cat1-1.png') }
    addCandidate(pool, asset, 'clip', 0.9, 1)
    addCandidate(pool, asset, 'review')
    if (pool.size !== 1 || pool.get(candidateId(asset.path)).sources.length !== 2)
      throw new Error('candidate pool merge smoke failed')
    // Bounded heap TopK is exact and deterministic.
    const scores = new Map()
    for (let index = 0; index < 100; index += 1) scores.set(`k${index}`, (index * 37) % 100)
    const top = topKScores(scores, 10)
    const sorted = [...scores.values()].sort((a, b) => b - a).slice(0, 10)
    if (top.length !== 10 || top.some((item, index) => item.score !== sorted[index]))
      throw new Error('bounded heap top-k smoke failed')
    const partialMetric = metricForRanking(
      [{ id: 'a' }, { id: 'b' }],
      { a: 'relevant' },
      1,
      false,
      2,
    )
    const completeMetric = metricForRanking(
      [{ id: 'a' }, { id: 'b' }],
      { a: 'relevant', b: 'not_relevant' },
      1,
      true,
      2,
    )
    if (
      partialMetric.precision !== null ||
      partialMetric.judgedPrecision !== 1 ||
      completeMetric.precision !== 0.5 ||
      completeMetric.pooledRecall !== 1
    )
      throw new Error('annotation metric readiness smoke failed')
    const aggregate = aggregateMetrics(
      [{ complete: true, clip: { '@10': completeMetric } }],
      'clip',
      10,
    )
    if (aggregate.readyCategories !== 1 || aggregate.macroPrecision !== 0.5)
      throw new Error('annotation aggregate metric smoke failed')
    // ACC-02 acceptance must require all five semantic classes, audited
    // manual coverage, independently recorded positives/negatives/random,
    // and rankings without prototype self-matches.
    const acceptanceDataset = {
      ...dataset,
      categories: requiredBenchmarkClasses.map((benchmarkClass, categoryIndex) => {
        const source = dataset.categories[categoryIndex % dataset.categories.length]
        const id = categoryIndex + 101
        const candidates = Array.from({ length: 82 }, (_, itemIndex) => {
          const candidate = source.candidates[itemIndex % source.candidates.length]
          return {
            ...candidate,
            id: `a${id}-${itemIndex + 1}`,
            sources: [
              ...(itemIndex >= 2 && itemIndex < 62
                ? [
                    {
                      source: 'clip',
                      score: 1 - (itemIndex - 1) * 0.005,
                      rank: itemIndex - 1,
                    },
                  ]
                : []),
              ...(itemIndex === 0 ? [{ source: 'confirmed_positive' }] : []),
              ...(itemIndex === 1 ? [{ source: 'hard_negative' }] : []),
              ...(itemIndex >= 62 ? [{ source: 'random' }] : []),
            ],
          }
        })
        return {
          id,
          name: `acceptance-${benchmarkClass}`,
          benchmarkClass,
          prototypes: { clip: [candidates[0].id], dino: [] },
          rankings: {
            clip: candidates
              .slice(2, 62)
              .map((candidate, rank) => ({ id: candidate.id, score: 1 - rank * 0.005 })),
            dino: [],
          },
          candidates,
        }
      }),
    }
    const acceptanceJudgments = { version: 1, judgments: {} }
    const acceptanceEvents = []
    const acceptanceFingerprint = fingerprintDataset(acceptanceDataset)
    for (const category of acceptanceDataset.categories) {
      const entries = (acceptanceJudgments.judgments[String(category.id)] = {})
      for (const [itemIndex, candidate] of category.candidates.entries()) {
        const label = itemIndex === 0 ? 'relevant' : 'not_relevant'
        entries[candidate.id] = { label, origin: 'manual', updatedAt: '2026-01-03T00:00:00Z' }
        acceptanceEvents.push({
          at: '2026-01-03T00:00:00Z',
          datasetFingerprint: acceptanceFingerprint,
          categoryId: category.id,
          id: candidate.id,
          label,
        })
      }
    }
    const acceptanceIntegrity = validateState(acceptanceDataset, acceptanceJudgments)
    const accepted = buildAcc02Acceptance(
      acceptanceDataset,
      acceptanceJudgments,
      acceptanceEvents,
      acceptanceIntegrity,
    )
    const leakedDataset = {
      ...acceptanceDataset,
      categories: acceptanceDataset.categories.map((category, index) =>
        index === 0
          ? {
              ...category,
              rankings: {
                ...category.rankings,
                clip: [{ id: category.prototypes.clip[0], score: 1 }, ...category.rankings.clip],
              },
            }
          : category,
      ),
    }
    const rejectedLeak = buildAcc02Acceptance(
      leakedDataset,
      acceptanceJudgments,
      acceptanceEvents,
      validateState(leakedDataset, acceptanceJudgments),
    )
    const staleFingerprintEvents = acceptanceEvents.map((event) => ({
      ...event,
      datasetFingerprint: 'stale-dataset-fingerprint',
    }))
    const rejectedStaleAudit = buildAcc02Acceptance(
      acceptanceDataset,
      acceptanceJudgments,
      staleFingerprintEvents,
      acceptanceIntegrity,
    )
    const reviewPlan = buildAcc02WorkPlan(
      acceptanceDataset,
      acceptanceJudgments,
      staleFingerprintEvents,
      acceptanceIntegrity,
    )
    if (
      accepted.summary.publishable !== true ||
      rejectedLeak.summary.publishable !== false ||
      rejectedStaleAudit.summary.publishable !== false ||
      reviewPlan.summary.reviewQueueItems !== 410 ||
      reviewPlan.summary.additionalManualRequired !== 290
    )
      throw new Error('ACC-02 acceptance policy smoke failed')
    const server = await serve(paths, { port: 0 })
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    try {
      const stateResponse = await fetch(`${baseUrl}/api/state`)
      const state = await stateResponse.json()
      if (!stateResponse.ok || !state.integrity.ok || state.dataset.categories.length !== 3)
        throw new Error('annotation state smoke failed')
      const category = state.dataset.categories[0]
      const item = category.candidates[0]
      const imageResponse = await fetch(
        `${baseUrl}/image?category=${encodeURIComponent(category.id)}&id=${encodeURIComponent(item.id)}`,
      )
      const outsideResponse = await fetch(
        `${baseUrl}/image?category=${encodeURIComponent(category.id)}&id=${encodeURIComponent('../../../../../../etc/passwd')}`,
      )
      const unknownCategoryResponse = await fetch(
        `${baseUrl}/image?category=999&id=${encodeURIComponent(item.id)}`,
      )
      const invalidResponse = await fetch(`${baseUrl}/api/judgment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad',
      })
      const nullResponse = await fetch(`${baseUrl}/api/judgment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'null',
      })
      const oversizedResponse = await fetch(`${baseUrl}/api/judgment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(5000) }),
      })
      const unknownCandidateResponse = await fetch(`${baseUrl}/api/judgment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId: category.id, id: 'nope', label: 'relevant' }),
      })
      const judgmentResponse = await fetch(`${baseUrl}/api/judgment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId: category.id, id: item.id, label: 'relevant' }),
      })
      const imageBytes = (await imageResponse.arrayBuffer()).byteLength
      const persisted = JSON.parse(await fsp.readFile(paths.judgments, 'utf8'))
      if (
        !imageResponse.ok ||
        imageBytes !== smokePng.length ||
        outsideResponse.status !== 404 ||
        unknownCategoryResponse.status !== 404 ||
        invalidResponse.status !== 400 ||
        nullResponse.status !== 400 ||
        oversizedResponse.status !== 413 ||
        unknownCandidateResponse.status !== 400 ||
        judgmentResponse.status !== 200 ||
        persisted.judgments[String(category.id)][item.id].origin !== 'manual' ||
        persisted.judgments[String(category.id)][item.id].label !== 'relevant' ||
        !stateResponse.headers.get('content-security-policy')
      )
        throw new Error('annotation HTTP smoke failed')
      const events = await fsp.readFile(paths.judgmentEvents, 'utf8')
      if (!events.includes('"label":"relevant"'))
        throw new Error('annotation audit event smoke failed')
      console.log(
        JSON.stringify({
          categories: state.dataset.categories.length,
          candidates: state.dataset.categories.reduce(
            (sum, entry) => sum + entry.candidates.length,
            0,
          ),
          imageBytes,
          invalidJsonStatus: invalidResponse.status,
          nullBodyStatus: nullResponse.status,
          oversizedBodyStatus: oversizedResponse.status,
          outsidePoolStatus: outsideResponse.status,
          securityHeaders: 'ok',
          integrityGate: 'ok',
          metricReadiness: 'ok',
          seededMerge: 'ok',
          candidateMerge: 'ok',
          topK: 'ok',
          auditEvents: 'ok',
          acc02Acceptance: 'ok',
          manualReviewQueue: 'ok',
          datasetBoundAudit: 'ok',
        }),
      )
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  } finally {
    await fsp.rm(baseDir, { recursive: true, force: true })
  }
}

if (command === 'prepare') prepare().catch(fail)
else if (command === 'serve') serve(artifactPaths()).catch(fail)
else if (command === 'evaluate') evaluate(artifactPaths()).catch(fail)
else if (command === 'status') status(artifactPaths())
else if (command === 'acceptance') acceptance(artifactPaths()).catch(fail)
else if (command === 'plan') workPlan(artifactPaths()).catch(fail)
else if (command === 'backup') backupJudgments(artifactPaths()).catch(fail)
else if (command === 'restore')
  restoreJudgments(artifactPaths(), process.argv[3], process.argv.includes('--confirm')).catch(fail)
else if (command === 'smoke') smoke().catch(fail)
else
  fail(
    new Error(
      'Usage: node tests/neko-search-annotation.cjs <prepare|serve|status|evaluate|acceptance|plan|backup|restore|smoke>',
    ),
  )

function fail(error) {
  console.error(error.message || error)
  process.exitCode = 1
}
