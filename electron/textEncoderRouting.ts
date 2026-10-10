// ── Text Encoder Routing (pure, electron-free) ─────────────
// Shared primitives for the dual text-encoder semantic search setup:
// - Query language detection and encoder routing (English CLIP vs multilingual CLIP).
// - Mean pooling + Dense projection math for the sentence-transformers
//   clip-ViT-B-32-multilingual-v1 ONNX export (transformer-only ONNX; the
//   pooling and 768→512 Dense layers are applied here in JS).
// - Minimal safetensors parser used to load the Dense projection weights.

export type TextEncoderKind = 'english' | 'multilingual'
export type TextEncoderSetting = 'auto' | 'english' | 'multilingual'

// CJK Unified Ideographs (incl. Ext-A and compatibility), Japanese kana, Korean hangul.
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/

export function containsCjk(text: string): boolean {
  return CJK_PATTERN.test(text)
}

export function normalizeTextEncoderSetting(value: unknown): TextEncoderSetting {
  return value === 'english' || value === 'multilingual' ? value : 'auto'
}

export function resolveTextEncoderChoice(
  text: string,
  setting: TextEncoderSetting,
): TextEncoderKind {
  if (setting === 'english') return 'english'
  if (setting === 'multilingual') return 'multilingual'
  return containsCjk(text) ? 'multilingual' : 'english'
}

export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i]
  const norm = Math.sqrt(sum)
  if (norm <= 0) return vector
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm
  return out
}

// Mean-pool one row of last_hidden_state [seq, hiddenDim] over unmasked tokens.
// hiddenOffset/maskOffset select the row inside a batched tensor; mask entries
// may come from a BigInt64Array, hence the number | bigint element type.
export function meanPoolLastHiddenState(
  hidden: ArrayLike<number | bigint>,
  hiddenOffset: number,
  attentionMask: ArrayLike<number | bigint>,
  maskOffset: number,
  seqLength: number,
  hiddenDim: number,
): Float32Array {
  const pooled = new Float32Array(hiddenDim)
  let maskSum = 0
  for (let t = 0; t < seqLength; t++) {
    const rawMask = attentionMask[maskOffset + t]
    const mask = typeof rawMask === 'bigint' ? Number(rawMask) : rawMask
    if (typeof mask !== 'number' || !Number.isFinite(mask)) {
      throw new Error(`Attention mask component ${maskOffset + t} is invalid`)
    }
    if (mask <= 0) continue
    maskSum += mask
    const base = hiddenOffset + t * hiddenDim
    for (let i = 0; i < hiddenDim; i++) {
      const rawValue = hidden[base + i]
      const value = typeof rawValue === 'bigint' ? Number(rawValue) : rawValue
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Hidden-state component ${base + i} is invalid`)
      }
      pooled[i] += value * mask
    }
  }
  if (maskSum > 0) {
    for (let i = 0; i < hiddenDim; i++) pooled[i] /= maskSum
  }
  return pooled
}

// Apply a bias-free Dense projection. Weights are row-major and may be stored
// as [outDim, inDim] (torch nn.Linear layout) or [inDim, outDim].
export function applyDenseProjection(
  input: ArrayLike<number>,
  weights: ArrayLike<number>,
  weightShape: [number, number],
  inDim: number,
  outDim: number,
): Float32Array {
  const out = new Float32Array(outDim)
  if (weightShape[0] === outDim && weightShape[1] === inDim) {
    for (let o = 0; o < outDim; o++) {
      const base = o * inDim
      let acc = 0
      for (let i = 0; i < inDim; i++) acc += weights[base + i] * input[i]
      out[o] = acc
    }
    return out
  }
  if (weightShape[0] === inDim && weightShape[1] === outDim) {
    for (let i = 0; i < inDim; i++) {
      const value = input[i]
      if (value === 0) continue
      const base = i * outDim
      for (let o = 0; o < outDim; o++) out[o] += value * weights[base + o]
    }
    return out
  }
  throw new Error(
    `Dense weight shape ${weightShape[0]}x${weightShape[1]} does not match ${inDim}->${outDim}`,
  )
}

export interface SafetensorsTensor {
  dtype: string
  shape: number[]
  data: Float32Array
}

// Minimal safetensors parser (F32 tensors only, which is all we ship).
export function parseSafetensorsFloat32(buffer: Buffer): Map<string, SafetensorsTensor> {
  if (buffer.length < 8) throw new Error('safetensors buffer too small')
  const headerLength = Number(buffer.readBigUInt64LE(0))
  const headerEnd = 8 + headerLength
  if (headerEnd > buffer.length) throw new Error('safetensors header out of bounds')
  const header = JSON.parse(buffer.subarray(8, headerEnd).toString('utf8')) as Record<
    string,
    { dtype?: string; shape?: number[]; data_offsets?: [number, number] }
  >
  const tensors = new Map<string, SafetensorsTensor>()
  for (const [name, meta] of Object.entries(header)) {
    if (name === '__metadata__') continue
    if (meta.dtype !== 'F32')
      throw new Error(`Unsupported safetensors dtype for ${name}: ${meta.dtype}`)
    const shape = Array.isArray(meta.shape) ? meta.shape : []
    const offsets = meta.data_offsets
    if (!offsets) throw new Error(`Missing data_offsets for ${name}`)
    const start = headerEnd + offsets[0]
    const end = headerEnd + offsets[1]
    if (end > buffer.length || start < headerEnd) {
      throw new Error(`Tensor data out of bounds for ${name}`)
    }
    const elementCount = shape.reduce((acc, dim) => acc * dim, 1)
    if (elementCount * 4 !== end - start) {
      throw new Error(`Tensor size mismatch for ${name}`)
    }
    const data = new Float32Array(elementCount)
    for (let i = 0; i < elementCount; i++) data[i] = buffer.readFloatLE(start + i * 4)
    tensors.set(name, { dtype: 'F32', shape, data })
  }
  return tensors
}
