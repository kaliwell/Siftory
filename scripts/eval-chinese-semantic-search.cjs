// Phase 2 read-only evaluation: Chinese semantic search on the real library.
// Loads the real CLIP embedding cache (vector-db, READ-ONLY) and compares
// Top-20 rankings for zh queries (multilingual encoder) against their en
// synonyms (both the multilingual and the original English CLIP text tower).
// Usage: node scripts/eval-chinese-semantic-search.cjs
// Output: stdout summary + ignored artifacts/benchmark/chinese-semantic-search/latest.json

const path = require('node:path')
const fs = require('node:fs')
const readline = require('node:readline')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const { meanPoolLastHiddenState, applyDenseProjection, l2Normalize, parseSafetensorsFloat32 } =
  loadTsModule('electron/textEncoderRouting.ts')
const { float16ToFloat32 } = loadTsModule('electron/embeddingF16Cache.ts')

const USER_DATA = path.join(process.env.APPDATA, 'floating-clock-electron')
const VECTOR_DB = path.join(USER_DATA, 'vector-db')
const CACHE_DIR = path.join(VECTOR_DB, 'embedding-cache')
const CACHE_BASE = 'clip_vit_base_patch32__global'
const CACHE_VECTORS = path.join(CACHE_DIR, `${CACHE_BASE}.f16`)
const CACHE_PATHS = path.join(CACHE_DIR, `${CACHE_BASE}.paths.jsonl`)
const CACHE_META = path.join(CACHE_DIR, `${CACHE_BASE}.f16.json`)

const MULTI_ROOT = path.resolve(__dirname, '..', 'ai-models', 'clip_vit_b32_multilingual_v1_text')
const MULTI_ID = 'sentence-transformers/clip-ViT-B-32-multilingual-v1'
const CLIP_ROOT = path.resolve(__dirname, '..', 'ai-models', 'clip_vit_base_patch32')
const CLIP_ID = 'Xenova/clip-vit-base-patch32'

const TOP_K = 20
const QUERY_PAIRS = [
  ['一只猫', 'a cat'],
  ['红色连衣裙', 'a red dress'],
  ['美食', 'delicious food'],
  ['夜晚的城市', 'a city at night'],
  ['海滩', 'a beach'],
  ['高跟鞋', 'high heels'],
  ['动漫女孩', 'anime girl'],
  ['汽车', 'a car'],
]

function topK(vectors, paths, query, k) {
  const dim = query.length
  const best = [] // min-heap-ish via sorted insert, k is small
  let worst = Infinity
  for (let row = 0; row < paths.length; row++) {
    const base = row * dim
    let dot = 0
    for (let i = 0; i < dim; i++) dot += query[i] * vectors[base + i]
    if (best.length < k || dot > worst) {
      best.push({ path: paths[row], score: dot })
      best.sort((a, b) => b.score - a.score)
      if (best.length > k) best.pop()
      worst = best[best.length - 1].score
    }
  }
  return best
}

async function loadPaths() {
  const paths = []
  const rl = readline.createInterface({ input: fs.createReadStream(CACHE_PATHS) })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const record = JSON.parse(trimmed)
      paths.push(record.path || record)
    } catch {
      paths.push(trimmed)
    }
  }
  return paths
}

async function main() {
  if (!fs.existsSync(CACHE_VECTORS)) {
    console.error(`SKIP: real cache not found at ${CACHE_VECTORS}`)
    process.exit(2)
  }
  const meta = JSON.parse(fs.readFileSync(CACHE_META, 'utf8'))
  console.log(`cache: ${meta.count} vectors, dim ${meta.dim}`)

  const transformers = await import('@huggingface/transformers')
  transformers.env.allowLocalModels = true
  transformers.env.allowRemoteModels = false

  // multilingual encoder (mirrors electron/multilingualTextEncoder.ts)
  transformers.env.localModelPath = MULTI_ROOT
  transformers.env.cacheDir = path.join(MULTI_ROOT, '.transformers-cache')
  const multiTokenizer = await transformers.AutoTokenizer.from_pretrained(MULTI_ID)
  const multiModel = await transformers.AutoModel.from_pretrained(MULTI_ID, {
    model_file_name: 'model_quint8_avx2',
    device: 'cpu',
  })
  const dense = parseSafetensorsFloat32(
    fs.readFileSync(path.join(MULTI_ROOT, MULTI_ID, '2_Dense', 'model.safetensors')),
  ).get('linear.weight')

  async function embedMultilingual(texts) {
    const inputs = multiTokenizer(texts, { padding: true, truncation: true, max_length: 128 })
    const output = await multiModel(inputs)
    const hidden = output.last_hidden_state
    const [, seq, dim] = hidden.dims
    return texts.map((_, row) => {
      const pooled = meanPoolLastHiddenState(
        hidden.data,
        row * seq * dim,
        inputs.attention_mask.data,
        row * seq,
        seq,
        dim,
      )
      const projected = applyDenseProjection(
        pooled,
        dense.data,
        [dense.shape[0], dense.shape[1]],
        768,
        512,
      )
      return Array.from(l2Normalize(projected))
    })
  }

  // English CLIP text tower (mirrors getClipTextEmbeddings: 'a photo of X' + X dual prompt)
  transformers.env.localModelPath = CLIP_ROOT
  transformers.env.cacheDir = path.join(CLIP_ROOT, '.transformers-cache')
  const clipTokenizer = await transformers.AutoTokenizer.from_pretrained(CLIP_ID)
  const clipTextModel = await transformers.CLIPTextModelWithProjection.from_pretrained(CLIP_ID, {
    dtype: 'q4',
    device: 'cpu',
  })

  function normalize(vec) {
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
    return norm > 0 ? vec.map((v) => v / norm) : vec
  }

  async function embedEnglishClip(texts) {
    const prompts = texts.flatMap((text) => [`a photo of ${text}`, text])
    const inputs = clipTokenizer(prompts, { padding: true, truncation: true })
    const output = await clipTextModel(inputs)
    const { data, dims } = output.text_embeds
    const values = Array.from(data, Number)
    return texts.map((_, i) => {
      const pooled = new Array(dims[1]).fill(0)
      for (let o = 0; o < 2; o++) {
        const row = normalize(values.slice((i * 2 + o) * dims[1], (i * 2 + o + 1) * dims[1]))
        for (let j = 0; j < dims[1]; j++) pooled[j] += row[j]
      }
      return normalize(pooled.map((v) => v / 2))
    })
  }

  console.log('loading f16 cache...')
  const raw = fs.readFileSync(CACHE_VECTORS)
  const vectors = new Float32Array(Math.floor(raw.length / 2))
  for (let i = 0; i < vectors.length; i++) vectors[i] = float16ToFloat32(raw.readUInt16LE(i * 2))
  const paths = await loadPaths()
  console.log(`paths: ${paths.length}`)

  const report = { cacheCount: meta.count, dim: meta.dim, topK: TOP_K, pairs: [] }
  for (const [zh, en] of QUERY_PAIRS) {
    const [zhVec, enMultiVec] = await embedMultilingual([zh, en])
    const [enClipVec] = await embedEnglishClip([en])
    const zhHits = topK(vectors, paths, zhVec, TOP_K)
    const enMultiHits = topK(vectors, paths, enMultiVec, TOP_K)
    const enClipHits = topK(vectors, paths, enClipVec, TOP_K)

    const zhSet = new Set(zhHits.map((h) => h.path))
    const overlapMulti = enMultiHits.filter((h) => zhSet.has(h.path)).length
    const enClipSet = new Set(enClipHits.map((h) => h.path))
    const overlapClip = zhHits.filter((h) => enClipSet.has(h.path)).length

    console.log(`\n== ${zh} / ${en} ==`)
    console.log(
      `  zh-multi Top${TOP_K} vs en-multi overlap: ${overlapMulti}/${TOP_K}; vs en-CLIP overlap: ${overlapClip}/${TOP_K}`,
    )
    console.log('  zh top5:')
    for (const hit of zhHits.slice(0, 5)) {
      console.log(`    ${hit.score.toFixed(4)}  ${path.basename(hit.path)}`)
    }
    console.log('  en-CLIP top5:')
    for (const hit of enClipHits.slice(0, 5)) {
      console.log(`    ${hit.score.toFixed(4)}  ${path.basename(hit.path)}`)
    }
    report.pairs.push({
      zh,
      en,
      overlapMulti,
      overlapClip,
      zhTop: zhHits,
      enMultiTop: enMultiHits,
      enClipTop: enClipHits,
    })
  }

  const outputDir = path.resolve(
    __dirname,
    '..',
    'artifacts',
    'benchmark',
    'chinese-semantic-search',
  )
  fs.mkdirSync(outputDir, { recursive: true })
  const outPath = path.join(outputDir, 'latest.json')
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`\nreport written: ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
