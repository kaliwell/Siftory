// ── Multilingual Text Encoder ──────────────────────────────
// sentence-transformers/clip-ViT-B-32-multilingual-v1 (Apache-2.0):
// multilingual DistilBERT text encoder distilled into the OpenAI
// CLIP ViT-B/32 embedding space, so its 512-d output is directly
// comparable with the existing clip_vit_base_patch32 image embeddings.
// The shipped ONNX is the transformer tower only; mean pooling and the
// 768→512 Dense projection (2_Dense/model.safetensors) are applied in JS.

import fs from 'fs'
import path from 'path'
import { getInstalledModelDir } from './modelService'
import {
  applyDenseProjection,
  l2Normalize,
  meanPoolLastHiddenState,
  parseSafetensorsFloat32,
} from './textEncoderRouting'
import { requireNormalizedEmbeddingVector } from './embeddingVectorValidation'

const MULTILINGUAL_MODEL_DIR = 'clip_vit_b32_multilingual_v1_text'
const MULTILINGUAL_MODEL_ID = 'sentence-transformers/clip-ViT-B-32-multilingual-v1'
const MULTILINGUAL_ONNX_FILE = 'model_quint8_avx2.onnx'
const MULTILINGUAL_INPUT_DIM = 768
const MULTILINGUAL_OUTPUT_DIM = 512
const MULTILINGUAL_MAX_SEQ_LENGTH = 128

type MultilingualDevice = 'cpu' | 'gpu' | 'dml'

interface MultilingualTensor {
  data: ArrayLike<number | bigint>
  dims: number[]
}
interface MultilingualTokenizerOutput {
  input_ids: MultilingualTensor
  attention_mask: MultilingualTensor
}
interface MultilingualTokenizer {
  (
    texts: string[],
    options: { padding: boolean; truncation: boolean; max_length: number },
  ): MultilingualTokenizerOutput
}
interface MultilingualModel {
  (inputs: MultilingualTokenizerOutput): Promise<{
    last_hidden_state?: { data: ArrayLike<number>; dims: number[] }
  }>
  dispose?: () => unknown | Promise<unknown>
}
interface MultilingualTransformersModule {
  env: {
    localModelPath: string
    cacheDir: string
    allowLocalModels: boolean
    allowRemoteModels: boolean
  }
  AutoTokenizer: {
    from_pretrained(modelId: string): Promise<MultilingualTokenizer>
  }
  AutoModel: {
    from_pretrained(
      modelId: string,
      options: { model_file_name: string; device: MultilingualDevice },
    ): Promise<MultilingualModel>
  }
}

interface DenseProjection {
  weights: Float32Array
  shape: [number, number]
}

const modelPromises = new Map<MultilingualDevice, Promise<MultilingualModel>>()
let tokenizerPromise: Promise<MultilingualTokenizer> | null = null
let denseProjectionPromise: Promise<DenseProjection> | null = null

function getMultilingualOnnxPath(modelDir: string): string {
  return path.join(modelDir, MULTILINGUAL_MODEL_ID, 'onnx', MULTILINGUAL_ONNX_FILE)
}

function getMultilingualModelRoot(): string {
  const modelRoot = getInstalledModelDir(MULTILINGUAL_MODEL_DIR)
  if (!modelRoot || !fs.existsSync(getMultilingualOnnxPath(modelRoot))) {
    throw new Error(
      'Multilingual CLIP text model is not installed or is incomplete. Open Settings > Models and download or repair it.',
    )
  }
  return modelRoot
}

export function isMultilingualTextEncoderAvailable(): boolean {
  const modelRoot = getInstalledModelDir(MULTILINGUAL_MODEL_DIR)
  return Boolean(modelRoot && fs.existsSync(getMultilingualOnnxPath(modelRoot)))
}

export async function disposeMultilingualTextEncoder(): Promise<void> {
  const pending = [...modelPromises.values()]
  modelPromises.clear()
  tokenizerPromise = null
  denseProjectionPromise = null
  const settled = await Promise.allSettled(pending)
  const models = new Set<MultilingualModel>()
  for (const result of settled) {
    if (result.status === 'fulfilled') models.add(result.value)
  }
  await Promise.allSettled(
    [...models].map(async (model) => {
      await model.dispose?.()
    }),
  )
}

async function configureMultilingualTransformers(): Promise<MultilingualTransformersModule> {
  const modelRoot = getMultilingualModelRoot()
  const transformers =
    (await import('@huggingface/transformers')) as unknown as MultilingualTransformersModule
  transformers.env.localModelPath = modelRoot
  transformers.env.cacheDir = path.join(modelRoot, '.transformers-cache')
  transformers.env.allowLocalModels = true
  transformers.env.allowRemoteModels = false
  return transformers
}

async function getMultilingualTokenizer(): Promise<MultilingualTokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      const { AutoTokenizer } = await configureMultilingualTransformers()
      return AutoTokenizer.from_pretrained(MULTILINGUAL_MODEL_ID)
    })().catch((err) => {
      tokenizerPromise = null
      throw err
    })
  }
  return tokenizerPromise
}

// The shipped ONNX is an AVX2 CPU-quantized model (MatMulInteger kernels).
// DirectML cannot accelerate those kernels and crashed the main process
// natively when session creation succeeded with the vector backend set to GPU
// (2026-07-27 repro: zh query → crashpad kill, no JS error). Keep this
// encoder on CPU regardless of the vector backend setting.
const MULTILINGUAL_DEVICE: MultilingualDevice = 'cpu'

async function getMultilingualModel(): Promise<MultilingualModel> {
  if (!modelPromises.has(MULTILINGUAL_DEVICE)) {
    const promise = (async () => {
      const { AutoModel } = await configureMultilingualTransformers()
      return AutoModel.from_pretrained(MULTILINGUAL_MODEL_ID, {
        model_file_name: MULTILINGUAL_ONNX_FILE.replace(/\.onnx$/, ''),
        device: MULTILINGUAL_DEVICE,
      })
    })().catch((err) => {
      modelPromises.delete(MULTILINGUAL_DEVICE)
      throw err
    })
    modelPromises.set(MULTILINGUAL_DEVICE, promise)
  }
  return modelPromises.get(MULTILINGUAL_DEVICE)!
}

async function getDenseProjection(): Promise<DenseProjection> {
  if (!denseProjectionPromise) {
    denseProjectionPromise = (async () => {
      const densePath = path.join(
        getMultilingualModelRoot(),
        MULTILINGUAL_MODEL_ID,
        '2_Dense',
        'model.safetensors',
      )
      const tensors = parseSafetensorsFloat32(fs.readFileSync(densePath))
      const tensor = tensors.get('linear.weight')
      if (!tensor || tensor.shape.length !== 2) {
        throw new Error('Multilingual Dense projection weights missing or malformed')
      }
      if (
        tensor.shape[0] !== MULTILINGUAL_OUTPUT_DIM ||
        tensor.shape[1] !== MULTILINGUAL_INPUT_DIM ||
        tensor.data.length !== MULTILINGUAL_OUTPUT_DIM * MULTILINGUAL_INPUT_DIM
      ) {
        throw new Error(`Multilingual Dense projection shape mismatch: ${tensor.shape.join('x')}`)
      }
      for (let index = 0; index < tensor.data.length; index++) {
        if (!Number.isFinite(tensor.data[index])) {
          throw new Error(`Multilingual Dense projection weight ${index} is not finite`)
        }
      }
      return {
        weights: tensor.data,
        shape: [tensor.shape[0], tensor.shape[1]] as [number, number],
      }
    })()
  }
  return denseProjectionPromise
}

export async function getMultilingualTextEmbeddings(
  texts: string[],
): Promise<Map<string, number[]>> {
  const uniqueTexts = [...new Set(texts.map((text) => text.trim()).filter(Boolean))]
  const result = new Map<string, number[]>()
  if (uniqueTexts.length === 0) return result

  const tokenizer = await getMultilingualTokenizer()
  const model = await getMultilingualModel()
  const projection = await getDenseProjection()

  const inputs = tokenizer(uniqueTexts, {
    padding: true,
    truncation: true,
    max_length: MULTILINGUAL_MAX_SEQ_LENGTH,
  })
  const output = await model(inputs)
  const hidden = output?.last_hidden_state
  if (!hidden || !Array.isArray(hidden.dims) || hidden.dims.length !== 3) {
    throw new Error('Multilingual encoder returned no hidden states')
  }
  const [rows, seqLength, hiddenDim] = hidden.dims
  if (
    !Number.isInteger(rows) ||
    rows !== uniqueTexts.length ||
    !Number.isInteger(seqLength) ||
    seqLength <= 0 ||
    seqLength > MULTILINGUAL_MAX_SEQ_LENGTH ||
    hiddenDim !== MULTILINGUAL_INPUT_DIM ||
    hidden.data.length !== rows * seqLength * hiddenDim
  ) {
    throw new Error(`Multilingual encoder shape mismatch: ${rows}x${seqLength}x${hiddenDim}`)
  }
  const maskData = inputs.attention_mask.data
  const maskDims = inputs.attention_mask.dims
  if (
    !Array.isArray(maskDims) ||
    maskDims.length !== 2 ||
    maskDims[0] !== rows ||
    maskDims[1] !== seqLength ||
    maskData.length !== rows * seqLength
  ) {
    throw new Error('Multilingual attention mask shape mismatch')
  }
  for (let index = 0; index < hidden.data.length; index++) {
    const value: unknown = hidden.data[index]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Multilingual hidden-state component ${index} is not finite`)
    }
  }
  for (let index = 0; index < maskData.length; index++) {
    const value: unknown = maskData[index]
    if (
      (typeof value !== 'number' && typeof value !== 'bigint') ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new Error(`Multilingual attention mask component ${index} is invalid`)
    }
  }
  for (let row = 0; row < uniqueTexts.length; row++) {
    const pooled = meanPoolLastHiddenState(
      hidden.data,
      row * seqLength * hiddenDim,
      maskData,
      row * seqLength,
      seqLength,
      hiddenDim,
    )
    const projected = applyDenseProjection(
      pooled,
      projection.weights,
      projection.shape,
      MULTILINGUAL_INPUT_DIM,
      MULTILINGUAL_OUTPUT_DIM,
    )
    result.set(
      uniqueTexts[row],
      requireNormalizedEmbeddingVector(l2Normalize(projected), MULTILINGUAL_OUTPUT_DIM),
    )
  }
  return result
}
