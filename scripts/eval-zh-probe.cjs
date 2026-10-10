// Ad-hoc probe: compare zh (multilingual) vs en (English CLIP tower) retrieval
// on the real library for user-reported problem words. Read-only.
// Usage: node scripts/eval-zh-probe.cjs "游戏" "动漫" "性感" ...
// Optional English gloss for comparison: node scripts/eval-zh-probe.cjs "游戏=video game" "动漫=anime girl"

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
const MULTI_ROOT = path.resolve(__dirname, '..', 'ai-models', 'clip_vit_b32_multilingual_v1_text')
const MULTI_ID = 'sentence-transformers/clip-ViT-B-32-multilingual-v1'
const CLIP_ROOT = path.resolve(__dirname, '..', 'ai-models', 'clip_vit_base_patch32')
const CLIP_ID = 'Xenova/clip-vit-base-patch32'
const TOP_K = 10

function topK(vectors, count, paths, query, k) {
  const dim = query.length
  const best = []
  let worst = Infinity
  for (let row = 0; row < count; row++) {
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

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('usage: node scripts/eval-zh-probe.cjs "词1[=english gloss]" ...')
    process.exit(2)
  }
  const pairs = args.map((arg) => {
    const [zh, en] = arg.split('=')
    return { zh, en: en || null }
  })

  const transformers = await import('@huggingface/transformers')
  transformers.env.allowLocalModels = true
  transformers.env.allowRemoteModels = false

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

  async function embedMulti(texts) {
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

  async function embedClipEn(texts) {
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

  const raw = fs.readFileSync(path.join(CACHE_DIR, `${CACHE_BASE}.f16`))
  const vectors = new Float32Array(Math.floor(raw.length / 2))
  for (let i = 0; i < vectors.length; i++) vectors[i] = float16ToFloat32(raw.readUInt16LE(i * 2))
  const meta = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${CACHE_BASE}.f16.json`), 'utf8'))
  const paths = []
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(CACHE_DIR, `${CACHE_BASE}.paths.jsonl`)),
  })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      paths.push(JSON.parse(trimmed).path)
    } catch {
      paths.push(trimmed)
    }
  }
  console.log(`cache: ${meta.count} vectors\n`)

  for (const { zh, en } of pairs) {
    const variants = [zh, `一张${zh}的照片`, `${zh}的照片`]
    const [zhRaw, zhTpl, zhTpl2] = await embedMulti(variants)
    console.log(`== ${zh}${en ? ` (en gloss: ${en})` : ''} ==`)
    for (const [label, vec] of [
      ['zh-raw ', zhRaw],
      ['zh-tplA', zhTpl],
      ['zh-tplB', zhTpl2],
    ]) {
      const hits = topK(vectors, meta.count, paths, vec, TOP_K)
      console.log(`  ${label}: ${hits.map((h) => path.basename(h.path)).join(' | ')}`)
    }
    if (en) {
      const [enVec] = await embedClipEn([en])
      const hits = topK(vectors, meta.count, paths, enVec, TOP_K)
      console.log(`  en-CLIP: ${hits.map((h) => path.basename(h.path)).join(' | ')}`)
      // fused: average of multilingual(zh) and English-CLIP(gloss), same 512-d space
      const fused = normalize(zhRaw.map((v, i) => v + enVec[i]).map((v) => v / 2))
      const fusedHits = topK(vectors, meta.count, paths, fused, TOP_K)
      console.log(`  FUSED  : ${fusedHits.map((h) => path.basename(h.path)).join(' | ')}`)
    }
    console.log()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
