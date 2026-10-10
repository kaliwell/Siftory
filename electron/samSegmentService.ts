// ── SAM-compatible Click Segmentation Service ─────────────
// Click-to-segment: user clicks a point on the query image, a compatible model
// produces the subject mask at that location.
//   encoder.onnx: image → 256×64×64 embedding (runs once per image, cached)
//   decoder.onnx: embedding + point prompt → 3 masks, best-IoU wins
// Models are supplied by the user through Model Platform; HWC float32 input
// and ImageNet mean/std normalization are required by this adapter.
// All unvetted ONNX work runs inside the isolated user-model runtime child
// (electron/userModelSessionService.ts); main only caches session metadata
// and validated encoder embeddings.

import fs from 'fs'
import sharp from 'sharp'
import { packedSamMaskHasPixel } from './embeddingChildLineFraming'
import { orientedDimensions } from './subjectBoxes'
import { scaleSamPromptsToInput } from './samPromptCoordinates'
import {
  getUserModelFileSignature,
  getUserModelProfile,
  onBeforeUserModelMutation,
} from './userModelPlatformService'
import {
  acquireUserModelSession,
  runSamDecoderSession,
  runUserModelSession,
  type UserModelSession,
} from './userModelSessionService'
import {
  getImageAdapterSpec,
  imageTensorDimensions,
  preprocessRgb,
  resolveTensorName,
} from './userModelRuntimeAdapters'

const EMBED_CACHE_MAX = 4

const loadErrors: Partial<Record<'enc' | 'dec', string>> = {}

onBeforeUserModelMutation(async (slotId) => {
  const kind = slotId === 'segment-encoder' ? 'enc' : slotId === 'segment-decoder' ? 'dec' : null
  if (!kind) return
  loadErrors[kind] = undefined
  embedCache.clear()
})

async function getSession(kind: 'enc' | 'dec'): Promise<UserModelSession | null> {
  const slotId = kind === 'enc' ? 'segment-encoder' : 'segment-decoder'
  const { session, error } = await acquireUserModelSession(slotId)
  loadErrors[kind] = error
  return session
}

export async function getSamStatus(): Promise<{ ready: boolean; error?: string }> {
  const enc = await getSession('enc')
  const dec = await getSession('dec')
  return {
    ready: enc !== null && dec !== null,
    error: loadErrors.enc ?? loadErrors.dec,
  }
}

// ── Image embedding (cached per image) ─────────────────────

interface CachedEmbedding {
  key: string
  data: Float32Array
  dims: number[]
  width: number
  height: number
  inputWidth: number
  inputHeight: number
  sourceSize: number
  sourceMtimeMs: number
}
const embedCache = new Map<string, CachedEmbedding>()

/** Structural + finiteness gate for cached encoder embeddings. */
function isUsableEncoderOutput(dims: readonly number[], data: Float32Array): boolean {
  if (dims.length < 3 || dims.length > 4) return false
  let elements = 1
  for (const dimension of dims) {
    if (!Number.isSafeInteger(dimension) || dimension <= 0) return false
    elements *= dimension
  }
  if (elements !== data.length) return false
  for (let index = 0; index < data.length; index++) {
    if (!Number.isFinite(data[index])) return false
  }
  return true
}

async function encodeImage(imagePath: string): Promise<{
  data: Float32Array
  dims: number[]
  width: number
  height: number
  inputWidth: number
  inputHeight: number
  sourceSize: number
  sourceMtimeMs: number
} | null> {
  const enc = await getSession('enc')
  if (!enc) return null
  const profile = getUserModelProfile('segment-encoder')
  const inputName = resolveTensorName(enc.inputNames, ['input_image', 'images', 'input'])
  const adapterSpec = getImageAdapterSpec(
    profile,
    enc.inputMetadata.find((metadata) => metadata.name === inputName),
  )
  let sourceSize: number
  let sourceMtimeMs: number
  try {
    const stat = fs.statSync(imagePath)
    sourceSize = stat.size
    sourceMtimeMs = stat.mtimeMs
  } catch {
    return null
  }
  const modelSignature = getUserModelFileSignature('segment-encoder') ?? 'unavailable'
  const key = `${modelSignature}|${imagePath}|${sourceSize}|${Math.round(sourceMtimeMs)}`
  const cached = embedCache.get(key)
  if (cached) return cached

  const metadata = await sharp(imagePath).metadata()
  // Display orientation (EXIF applied) — the picker modal shows EXIF-rotated
  // thumbnails, so the mask/bbox coordinate space must match it.
  const { width, height } = orientedDimensions(
    metadata.width ?? 0,
    metadata.height ?? 0,
    metadata.orientation,
  )
  if (width <= 0 || height <= 0) return null

  // Resize/pad and tensor layout follow the selected encoder profile.
  const resized = await sharp(imagePath)
    .rotate()
    .resize(adapterSpec.width, adapterSpec.height, {
      fit: 'inside',
      withoutEnlargement: false,
    })
    .removeAlpha()
    .toBuffer()
  const resizedMeta = await sharp(resized).metadata()
  const rw = resizedMeta.width ?? 0
  const rh = resizedMeta.height ?? 0
  const { data: rgb } = await sharp(resized)
    .extend({
      top: 0,
      left: 0,
      bottom: adapterSpec.height - rh,
      right: adapterSpec.width - rw,
      background: { r: 0, g: 0, b: 0 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const input = preprocessRgb(rgb, adapterSpec)

  const out = await runUserModelSession(enc, [
    { name: inputName, dims: imageTensorDimensions(adapterSpec), data: input },
  ])
  const outputName = resolveTensorName(enc.outputNames, [
    'image_embeddings',
    'embeddings',
    'output',
  ])
  const output = out.get(outputName)
  if (!output || !isUsableEncoderOutput(output.dims, output.data)) {
    // Hostile or corrupt encoder output must not enter the embedding cache.
    return null
  }
  const data = output.data

  const entry: CachedEmbedding = {
    key,
    data,
    dims: [...output.dims],
    width,
    height,
    inputWidth: rw,
    inputHeight: rh,
    sourceSize,
    sourceMtimeMs,
  }
  embedCache.set(key, entry)
  if (embedCache.size > EMBED_CACHE_MAX) {
    const oldest = embedCache.keys().next().value
    if (oldest) embedCache.delete(oldest)
  }
  return entry
}

// ── Point-prompt decode ────────────────────────────────────

export interface SamPoint {
  x: number
  y: number
  /** 0 background, 1 foreground, 2 box top-left, 3 box bottom-right. */
  label?: 0 | 1 | 2 | 3
}

export interface SamSegmentResult {
  ok: boolean
  width?: number
  height?: number
  /** tight bbox of the winning mask, original image pixels */
  bbox?: { x: number; y: number; w: number; h: number }
  iou?: number
  /** grayscale mask PNG (white = subject), original image size */
  maskPngDataUrl?: string
  /** Source fingerprint used for the embedding; kept inside the main process. */
  sourceSize?: number
  sourceMtimeMs?: number
  error?: string
}

export async function segmentAtPoint(
  imagePath: string,
  points: SamPoint[],
): Promise<SamSegmentResult> {
  const dec = await getSession('dec')
  if (!dec) return { ok: false, error: loadErrors.dec || 'decoder unavailable' }
  if (points.length === 0) return { ok: false, error: 'no prompt points' }

  const embedding = await encodeImage(imagePath)
  if (!embedding) return { ok: false, error: loadErrors.enc || 'cannot encode image' }
  const {
    data: embData,
    dims: embDims,
    width,
    height,
    inputWidth,
    inputHeight,
    sourceSize,
    sourceMtimeMs,
  } = embedding

  const coords = new Float32Array(points.length * 2)
  const labels = new Float32Array(points.length)
  const scaledPoints = scaleSamPromptsToInput(points, width, height, inputWidth, inputHeight)
  scaledPoints.forEach((p, i) => {
    coords[i * 2] = p.x
    coords[i * 2 + 1] = p.y
    labels[i] = p.label ?? 1
  })

  const embeddingName = resolveTensorName(dec.inputNames, ['image_embeddings', 'embeddings'], false)
  const pointCoordsName = resolveTensorName(dec.inputNames, ['point_coords', 'coords'], false)
  const pointLabelsName = resolveTensorName(dec.inputNames, ['point_labels', 'labels'], false)
  const maskInputName = resolveTensorName(dec.inputNames, ['mask_input'], false)
  const hasMaskName = resolveTensorName(dec.inputNames, ['has_mask_input', 'has_mask'], false)
  const originalSizeName = resolveTensorName(
    dec.inputNames,
    ['orig_im_size', 'original_size'],
    false,
  )
  const masksName = resolveTensorName(dec.outputNames, ['masks', 'mask'], false)
  const iouName = resolveTensorName(dec.outputNames, ['iou_predictions', 'iou'], false)
  const mask = await runSamDecoderSession(
    dec,
    [
      { name: embeddingName, dims: embDims, data: embData },
      { name: pointCoordsName, dims: [1, points.length, 2], data: coords },
      { name: pointLabelsName, dims: [1, points.length], data: labels },
      { name: maskInputName, dims: [1, 1, 256, 256], data: new Float32Array(256 * 256) },
      { name: hasMaskName, dims: [1], data: new Float32Array([0]) },
      { name: originalSizeName, dims: [2], data: new Float32Array([height, width]) },
    ],
    masksName,
    iouName,
  )
  if (mask.width !== width || mask.height !== height) {
    return { ok: false, error: 'decoder mask size does not match the source image' }
  }
  const plane = width * height

  // bbox + grayscale PNG of the winning mask
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  const gray = Buffer.alloc(plane)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (packedSamMaskHasPixel(mask.maskBits, idx)) {
        gray[idx] = 255
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { ok: false, error: 'mask is empty' }

  const png = await sharp(gray, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer()

  return {
    ok: true,
    width,
    height,
    bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    iou: mask.iou,
    maskPngDataUrl: `data:image/png;base64,${png.toString('base64')}`,
    sourceSize,
    sourceMtimeMs,
  }
}
