// ── Face Match Service (user-supplied compatible models) ───
// Detection: compatible face detector ONNX → face boxes + 5 landmarks.
// Alignment: similarity transform (electron/faceAlign.ts) → 112x112.
// Embedding: compatible 112x112 ONNX → 512d L2-normalized vector.
// All unvetted ONNX work runs inside the isolated user-model runtime child
// (electron/userModelSessionService.ts); main only caches session metadata.
// All stages degrade gracefully with explicit negative reasons: missing
// model / invalid output / no face → ok:false, callers fall back to the
// DINOv2 whole-body path.

import fs from 'fs'
import sharp from 'sharp'
import { nms, type SubjectBBox } from './subjectBoxes'
import {
  ARCFACE_TEMPLATE,
  estimateSimilarity,
  invertAffine,
  applyAffine,
  cosineSimilarity,
  type FacePoint,
} from './faceAlign'
import { getUserModelProfile } from './userModelPlatformService'
import {
  acquireUserModelSession,
  requireStrictUserModelEmbedding,
  runUserModelSession,
  type UserModelNegativeReason,
  type UserModelSession,
} from './userModelSessionService'
import {
  getImageAdapterSpec,
  imageTensorDimensions,
  parseFaceDetections,
  parseRetinaFaceDetections,
  parseScrfdFaceDetections,
  parseSplitDetections,
  preprocessRgb,
  resolveTensorName,
  type AdapterDetection,
} from './userModelRuntimeAdapters'

const FACE_CONF_THRESHOLD = 0.3
const FACE_IOU_THRESHOLD = 0.45
const ALIGNMENT_FRAME_SIZE = 112

// ── Lazy session metadata (model runs in the isolated child) ─

const loadErrors: Partial<Record<'det' | 'ada', string>> = {}
const loadReasons: Partial<Record<'det' | 'ada', UserModelNegativeReason | undefined>> = {}

async function getSession(kind: 'det' | 'ada'): Promise<UserModelSession | null> {
  const slotId = kind === 'det' ? 'face-detector' : 'face-embedder'
  const { session, error, reason } = await acquireUserModelSession(slotId)
  loadErrors[kind] = error
  loadReasons[kind] = reason
  return session
}

/** Model availability snapshot for status reporting / tests. */
export async function getFaceMatchStatus(): Promise<{
  detectorReady: boolean
  adafaceReady: boolean
  detectorError?: string
  adafaceError?: string
}> {
  const det = await getSession('det')
  const ada = await getSession('ada')
  return {
    detectorReady: det !== null,
    adafaceReady: ada !== null,
    detectorError: loadErrors.det,
    adafaceError: loadErrors.ada,
  }
}

// ── Face detection ─────────────────────────────────────────

export interface FaceDetection {
  bbox: SubjectBBox
  landmarks: FacePoint[] // 5 pts: left eye, right eye, nose, mouth left, mouth right
}

// Standard face proportions relative to a tight forehead-to-chin bbox,
// laid out like the ArcFace template. Used when the detector has no
// landmark head (yolov8n-face is bbox-only): preserves centering/scaling
// through the same affine path, without rotation correction.
const PSEUDO_LANDMARK_RATIOS: FacePoint[] = [
  { x: 0.3, y: 0.4 }, // left eye
  { x: 0.7, y: 0.4 }, // right eye
  { x: 0.5, y: 0.62 }, // nose
  { x: 0.36, y: 0.8 }, // mouth left
  { x: 0.64, y: 0.8 }, // mouth right
]

export function pseudoLandmarksFromBbox(b: SubjectBBox): FacePoint[] {
  return PSEUDO_LANDMARK_RATIOS.map((r) => ({ x: b.x + r.x * b.w, y: b.y + r.y * b.h }))
}

export async function detectFaces(imagePath: string): Promise<{
  ok: boolean
  faces: FaceDetection[]
  error?: string
  reason?: UserModelNegativeReason
}> {
  const session = await getSession('det')
  if (!session) {
    return {
      ok: false,
      faces: [],
      error: loadErrors.det || 'detector unavailable',
      reason: loadReasons.det ?? 'model-invalid',
    }
  }
  if (!fs.existsSync(imagePath)) {
    return { ok: false, faces: [], error: 'file not found', reason: 'input-unreadable' }
  }

  let width: number
  let height: number
  let rgb: Buffer
  const profile = getUserModelProfile('face-detector')
  const inputName = resolveTensorName(session.inputNames, ['images', 'input', 'image'])
  const adapterSpec = getImageAdapterSpec(
    profile,
    session.inputMetadata.find((metadata) => metadata.name === inputName),
  )
  try {
    const metadata = await sharp(imagePath).metadata()
    width = metadata.width ?? 0
    height = metadata.height ?? 0
    if (width <= 0 || height <= 0)
      return { ok: false, faces: [], error: 'cannot read image dimensions' }

    const out = await sharp(imagePath)
      .resize(adapterSpec.width, adapterSpec.height, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    rgb = out.data
  } catch (err) {
    // unreadable / unsupported format — degrade, never throw
    return {
      ok: false,
      faces: [],
      error: err instanceof Error ? err.message : String(err),
      reason: 'input-unreadable',
    }
  }

  const input = preprocessRgb(rgb, adapterSpec)
  let detections: AdapterDetection[]
  try {
    const results = await runUserModelSession(session, [
      { name: inputName, dims: imageTensorDimensions(adapterSpec), data: input },
    ])
    const tensorMap = Object.fromEntries(results) as Parameters<typeof parseSplitDetections>[0]
    const singleOutput = (aliases: string[]) => {
      const output = results.get(resolveTensorName(session.outputNames, aliases))
      if (!output) throw new Error('Model output tensor is missing from the runtime response')
      return output
    }
    detections =
      profile.adapter === 'split-face'
        ? parseSplitDetections(tensorMap)
        : profile.adapter === 'scrfd-face' || profile.adapter === 'scrfd-face-ordered'
          ? parseScrfdFaceDetections(
              tensorMap,
              adapterSpec.width,
              adapterSpec.height,
              profile.adapter === 'scrfd-face-ordered' ? session.outputNames : undefined,
            )
          : profile.adapter === 'retinaface-priorbox'
            ? parseRetinaFaceDetections(
                tensorMap,
                adapterSpec.width,
                adapterSpec.height,
                session.outputNames,
              )
            : parseFaceDetections(
                profile.adapter,
                singleOutput(['output0', 'output', 'detections']),
              )
  } catch (err) {
    // A hostile or corrupt model output must degrade, never crash main.
    return {
      ok: false,
      faces: [],
      error: err instanceof Error ? err.message : String(err),
      reason: 'output-invalid',
    }
  }

  const candidates: { box: SubjectBBox; kps: FacePoint[] }[] = []
  for (const detection of detections) {
    if (detection.confidence < FACE_CONF_THRESHOLD) continue
    const normalized =
      detection.coordinateSpace === 'normalized' ||
      (detection.coordinateSpace !== 'input-pixels' &&
        Math.max(
          Math.abs(detection.x1 ?? detection.cx ?? 0),
          Math.abs(detection.y1 ?? detection.cy ?? 0),
          Math.abs(detection.x2 ?? detection.width ?? 0),
          Math.abs(detection.y2 ?? detection.height ?? 0),
        ) <= 2)
    const inputX = normalized ? 1 : adapterSpec.width
    const inputY = normalized ? 1 : adapterSpec.height
    const left = detection.x1 ?? (detection.cx ?? 0) - (detection.width ?? 0) / 2
    const top = detection.y1 ?? (detection.cy ?? 0) - (detection.height ?? 0) / 2
    const right = detection.x2 ?? (detection.cx ?? 0) + (detection.width ?? 0) / 2
    const bottom = detection.y2 ?? (detection.cy ?? 0) + (detection.height ?? 0) / 2
    const x = Math.max(0, Math.round((left / inputX) * width))
    const y = Math.max(0, Math.round((top / inputY) * height))
    const w = Math.min(width - x, Math.round(((right - left) / inputX) * width))
    const h = Math.min(height - y, Math.round(((bottom - top) / inputY) * height))
    if (w <= 4 || h <= 4) continue

    const kps = (detection.landmarks ?? []).map((point) => ({
      x: (point.x / inputX) * width,
      y: (point.y / inputY) * height,
    }))
    candidates.push({
      box: { x, y, w, h, confidence: detection.confidence, label: 'face' },
      kps,
    })
  }

  const kept = nms(
    candidates.map((c) => c.box),
    FACE_IOU_THRESHOLD,
  )
  const faces: FaceDetection[] = kept.map((box) => {
    const match = candidates.find(
      (c) => c.box.x === box.x && c.box.y === box.y && c.box.confidence === box.confidence,
    )
    return { bbox: box, landmarks: match ? match.kps : [] }
  })
  // largest face first — the primary subject
  faces.sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)
  return { ok: true, faces }
}

// ── Alignment + embedding ──────────────────────────────────

async function loadAlignedFace(
  imagePath: string,
  landmarks: FacePoint[],
  outputSize: number,
): Promise<Buffer | null> {
  if (landmarks.length < 5) return null
  try {
    const metadata = await sharp(imagePath).metadata()
    const imgW = metadata.width ?? 0
    const imgH = metadata.height ?? 0
    if (imgW <= 0 || imgH <= 0) return null

    const forward = estimateSimilarity(landmarks, ARCFACE_TEMPLATE)
    // Map the 112x112 output frame back into input coordinates and take its
    // axis-aligned bounding rect. Our transforms are rotation-free in
    // practice (bbox-derived pseudo landmarks), so extract+resize equals
    // the affine resample. A landmark-capable detector with real rotation
    // must revisit this (sharp does not expose libvips affine oarea).
    const inv = invertAffine(forward)
    const corners = [
      { x: 0, y: 0 },
      { x: ALIGNMENT_FRAME_SIZE, y: 0 },
      { x: 0, y: ALIGNMENT_FRAME_SIZE },
      { x: ALIGNMENT_FRAME_SIZE, y: ALIGNMENT_FRAME_SIZE },
    ].map((p) => applyAffine(inv, p))
    const xs = corners.map((p) => p.x)
    const ys = corners.map((p) => p.y)
    const left = Math.max(0, Math.floor(Math.min(...xs)))
    const top = Math.max(0, Math.floor(Math.min(...ys)))
    const width = Math.min(imgW - left, Math.ceil(Math.max(...xs)) - left)
    const height = Math.min(imgH - top, Math.ceil(Math.max(...ys)) - top)
    if (width < 8 || height < 8) return null

    const { data } = await sharp(imagePath)
      .extract({ left, top, width, height })
      .resize(outputSize, outputSize, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return data
  } catch {
    return null
  }
}

async function embedAlignedFace(rgb: Buffer, session: UserModelSession): Promise<number[]> {
  const profile = getUserModelProfile('face-embedder')
  const inputName = resolveTensorName(session.inputNames, ['input', 'images', 'data'])
  const adapterSpec = getImageAdapterSpec(
    profile,
    session.inputMetadata.find((metadata) => metadata.name === inputName),
  )
  const input = preprocessRgb(rgb, adapterSpec)
  const results = await runUserModelSession(session, [
    { name: inputName, dims: imageTensorDimensions(adapterSpec), data: input },
  ])
  const outputName = resolveTensorName(session.outputNames, ['embedding', 'output', 'features'])
  const output = results.get(outputName)
  if (!output) throw new Error('face embedder returned no embedding tensor')
  return requireStrictUserModelEmbedding(output.data, 'face embedder')
}

/**
 * Full pipeline: detect the largest face, align, embed.
 * Returns ok:false with a reason when any stage is unavailable —
 * callers must treat that as "fall back to non-face matching".
 */
export async function getFaceEmbedding(imagePath: string): Promise<{
  ok: boolean
  vector?: number[]
  error?: string
  reason?: UserModelNegativeReason
}> {
  const det = await detectFaces(imagePath)
  if (!det.ok) {
    return { ok: false, error: det.error, reason: det.reason }
  }
  if (det.faces.length === 0) {
    return { ok: false, error: 'no face detected', reason: 'no-subject' }
  }
  const primary = det.faces[0]
  const landmarks =
    primary.landmarks.length >= 5 ? primary.landmarks : pseudoLandmarksFromBbox(primary.bbox)
  const embedderSession = await getSession('ada')
  if (!embedderSession) {
    return {
      ok: false,
      error: loadErrors.ada || 'adaface unavailable',
      reason: loadReasons.ada ?? 'model-invalid',
    }
  }
  const embedderInputName = resolveTensorName(embedderSession.inputNames, [
    'input',
    'images',
    'data',
  ])
  const embedderSpec = getImageAdapterSpec(
    getUserModelProfile('face-embedder'),
    embedderSession.inputMetadata.find((metadata) => metadata.name === embedderInputName),
  )
  const aligned = await loadAlignedFace(imagePath, landmarks, embedderSpec.width)
  if (!aligned) {
    return { ok: false, error: 'face alignment failed', reason: 'input-unreadable' }
  }
  try {
    const vector = await embedAlignedFace(aligned, embedderSession)
    return { ok: true, vector }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      reason: 'output-invalid',
    }
  }
}

export function faceSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return a.length === b.length ? cosineSimilarity(a, b) : 0
}
