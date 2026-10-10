// Runtime smoke check for the multilingual text encoder (Chinese semantic search).
// Loads the vendored sentence-transformers/clip-ViT-B-32-multilingual-v1 ONNX
// (quint8) through @huggingface/transformers exactly like
// electron/multilingualTextEncoder.ts does, then verifies:
//   1. 512-d L2-normalized output for zh/en queries.
//   2. Cross-lingual alignment: cos(zh, en synonym) >> cos(zh, unrelated).
// Read-only; no electron required. Usage: node scripts/verify-multilingual-text-encoder.cjs

const path = require('node:path')
const fs = require('node:fs')
const { loadTsModule } = require('../tests/guard-utils.cjs')

const {
  meanPoolLastHiddenState,
  applyDenseProjection,
  l2Normalize,
  parseSafetensorsFloat32,
} = loadTsModule('electron/textEncoderRouting.ts')

const MODEL_ROOT = path.resolve(
  __dirname,
  '..',
  'ai-models',
  'clip_vit_b32_multilingual_v1_text',
)
const MODEL_ID = 'sentence-transformers/clip-ViT-B-32-multilingual-v1'
const ONNX_FILE = 'model_quint8_avx2'
const HIDDEN_DIM = 768
const OUTPUT_DIM = 512

function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // vectors are L2-normalized
}

async function main() {
  const onnxPath = path.join(MODEL_ROOT, MODEL_ID, 'onnx', `${ONNX_FILE}.onnx`)
  if (!fs.existsSync(onnxPath)) {
    console.error(`SKIP: model not found at ${onnxPath}`)
    process.exit(2)
  }

  const transformers = await import('@huggingface/transformers')
  transformers.env.localModelPath = MODEL_ROOT
  transformers.env.cacheDir = path.join(MODEL_ROOT, '.transformers-cache')
  transformers.env.allowLocalModels = true
  transformers.env.allowRemoteModels = false

  const tokenizer = await transformers.AutoTokenizer.from_pretrained(MODEL_ID)
  const model = await transformers.AutoModel.from_pretrained(MODEL_ID, {
    model_file_name: ONNX_FILE,
    device: 'cpu',
  })
  const dense = parseSafetensorsFloat32(
    fs.readFileSync(path.join(MODEL_ROOT, MODEL_ID, '2_Dense', 'model.safetensors')),
  ).get('linear.weight')

  async function embed(texts) {
    const inputs = tokenizer(texts, { padding: true, truncation: true, max_length: 128 })
    const output = await model(inputs)
    const hidden = output.last_hidden_state
    const [rows, seq, dim] = hidden.dims
    if (dim !== HIDDEN_DIM || rows !== texts.length) {
      throw new Error(`unexpected hidden shape ${hidden.dims}`)
    }
    return texts.map((text, row) => {
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
        HIDDEN_DIM,
        OUTPUT_DIM,
      )
      return Array.from(l2Normalize(projected))
    })
  }

  const queries = ['一只猫', 'a cat', '红色连衣裙', 'a red dress', 'quantum physics']
  const vectors = await embed(queries)

  let failed = false
  vectors.forEach((vec, i) => {
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
    if (vec.length !== OUTPUT_DIM || Math.abs(norm - 1) > 1e-3) {
      console.error(`FAIL: ${queries[i]} dim=${vec.length} norm=${norm}`)
      failed = true
    }
  })

  const pairs = [
    ['一只猫', 'a cat', 0.6],
    ['红色连衣裙', 'a red dress', 0.6],
    ['一只猫', 'quantum physics', null], // must be well below synonym pairs
  ]
  for (const [zh, other, minScore] of pairs) {
    const score = cosine(vectors[queries.indexOf(zh)], vectors[queries.indexOf(other)])
    console.log(`cos(${JSON.stringify(zh)}, ${JSON.stringify(other)}) = ${score.toFixed(4)}`)
    if (minScore !== null && score < minScore) {
      console.error(`FAIL: cross-lingual similarity ${score.toFixed(4)} < ${minScore}`)
      failed = true
    }
  }
  const synonym = cosine(vectors[0], vectors[1])
  const synonym2 = cosine(vectors[2], vectors[3])
  const unrelated = cosine(vectors[0], vectors[4])
  // The distilled multilingual model is anisotropic (all pairs score high);
  // what matters for retrieval is ordering: synonyms must outrank unrelated.
  if (unrelated > synonym - 0.05 || unrelated > synonym2 - 0.05) {
    console.error(
      `FAIL: unrelated pair too close (${unrelated.toFixed(4)} vs ${synonym.toFixed(4)}/${synonym2.toFixed(4)})`,
    )
    failed = true
  }

  console.log(failed ? 'MULTILINGUAL ENCODER CHECK FAILED' : 'MULTILINGUAL ENCODER CHECK OK')
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
