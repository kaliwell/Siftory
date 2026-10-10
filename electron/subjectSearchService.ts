// ── Subject Search Service (compatible detector slot) ──────
// Detection: user-supplied compatible ONNX → 80-class detection + NMS.
//   Falls back to gradient saliency → center crop if model unavailable.
//   Returns up to 10 detected subjects with class labels.
// Search: delegates to existing searchLayered (hash + ANN vector).

import fs from 'fs'
import path from 'path'
import os from 'os'
import sharp from 'sharp'
import type { VisionModelName } from './modelRegistry'
import { searchLayered } from './rerankService'
import { getFaceEmbedding, faceSimilarity } from './faceMatchService'
import { getPersonEmbedding, embedPersonCrops, personSimilarity } from './personReidService'
import { SubjectCropEmbedder } from './subjectCropEmbedder'
import { cosineSimilarity } from './faceAlign'
import { colorIdentitySimilarity, computeImageColorHist } from './colorFeatureService'
import { nms, orientedDimensions, pickPrimarySubject, type SubjectBBox } from './subjectBoxes'
import {
  getSubjectEmbedding,
  putSubjectEmbedding,
  statMtimeMs,
  subjectEmbeddingKey,
} from './subjectEmbeddingStore'
import type { LayeredSearchProgress, LayeredSearchRequest } from '../shared/vectorTypes'
import { createSubjectMaskQueryFiles } from './subjectMaskQuery'
import type { SubjectMaskSessionData } from './subjectMaskSession'
import { getUserModelFileSignature, getUserModelProfile } from './userModelPlatformService'
import {
  acquireUserModelSession,
  runUserModelSession,
  type UserModelSession,
} from './userModelSessionService'
import {
  getImageAdapterSpec,
  imageTensorDimensions,
  parseObjectDetections,
  parseSplitDetections,
  preprocessRgb,
  resolveTensorName,
} from './userModelRuntimeAdapters'

// ── Progress ───────────────────────────────────────────────
// Subject search reuses the layered-search progress channel so the UI
// shows one continuous bar: base pipeline 0–70%, identity rerank 70–99%,
// done 100%. Before this, the rerank phase (10–30s) was completely
// silent and looked like a hang.

type SubjectProgressCallback = (progress: LayeredSearchProgress) => void

function makeSubjectProgress(onProgress?: SubjectProgressCallback) {
  const emit = (percent: number, message: string, scanned = 0, total?: number) => {
    onProgress?.({
      mode: 'standard',
      phase: percent >= 100 ? 'done' : percent >= 70 ? 'rerank' : 'preparing',
      percent,
      scanned,
      ...(total !== undefined ? { total } : {}),
      message,
    })
  }
  // remap searchLayered's own 0–100 into 0–70
  const fromLayered = (progress: LayeredSearchProgress) => {
    onProgress?.({
      ...progress,
      percent: progress.percent !== undefined ? Math.round(progress.percent * 0.7) : undefined,
    })
  }
  return { emit, fromLayered }
}

// ── Types ──────────────────────────────────────────────────

export type { SubjectBBox } from './subjectBoxes'

export interface SubjectDetectionResult {
  ok: boolean
  imagePath: string
  width: number
  height: number
  subjects: SubjectBBox[]
  modelLoaded?: boolean
  error?: string
}

export interface SubjectSearchResult {
  imageId: string
  imagePath: string
  score: number
  modelName: string
}

// ── Subject Detection (compatible user model slot) ─────────
// Uses an explicitly user-supplied detector and selected compatibility profile.
// Falls back to gradient saliency if model is not available.
const YOLO_CONF_THRESHOLD = 0.35
const YOLO_IOU_THRESHOLD = 0.45

async function getYoloSession(): Promise<UserModelSession | null> {
  const { session } = await acquireUserModelSession('subject-detector')
  return session
}

// COCO class names (80 classes)
const COCO_CLASSES = [
  'person',
  'bicycle',
  'car',
  'motorcycle',
  'airplane',
  'bus',
  'train',
  'truck',
  'boat',
  'traffic light',
  'fire hydrant',
  'stop sign',
  'parking meter',
  'bench',
  'bird',
  'cat',
  'dog',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
  'zebra',
  'giraffe',
  'backpack',
  'umbrella',
  'handbag',
  'tie',
  'suitcase',
  'frisbee',
  'skis',
  'snowboard',
  'sports ball',
  'kite',
  'baseball bat',
  'baseball glove',
  'skateboard',
  'surfboard',
  'tennis racket',
  'bottle',
  'wine glass',
  'cup',
  'fork',
  'knife',
  'spoon',
  'bowl',
  'banana',
  'apple',
  'sandwich',
  'orange',
  'broccoli',
  'carrot',
  'hot dog',
  'pizza',
  'donut',
  'cake',
  'chair',
  'couch',
  'potted plant',
  'bed',
  'dining table',
  'toilet',
  'tv',
  'laptop',
  'mouse',
  'remote',
  'keyboard',
  'cell phone',
  'microwave',
  'oven',
  'toaster',
  'sink',
  'refrigerator',
  'book',
  'clock',
  'vase',
  'scissors',
  'teddy bear',
  'hair drier',
  'toothbrush',
]

export async function detectSubjects(imagePath: string): Promise<SubjectDetectionResult> {
  if (!fs.existsSync(imagePath)) {
    return { ok: false, imagePath, width: 0, height: 0, subjects: [], error: 'File not found' }
  }
  try {
    const metadata = await sharp(imagePath).metadata()
    // Work in display orientation (EXIF applied): the picker modal shows
    // EXIF-rotated thumbnails, so every bbox/mask must live in that space.
    const { width, height } = orientedDimensions(
      metadata.width ?? 0,
      metadata.height ?? 0,
      metadata.orientation,
    )
    if (width <= 0 || height <= 0) {
      return {
        ok: false,
        imagePath,
        width: 0,
        height: 0,
        subjects: [],
        error: 'Cannot read image dimensions',
      }
    }

    // Try YOLOv8 first
    const session = await getYoloSession()
    if (session) {
      const profile = getUserModelProfile('subject-detector')
      const inputName = resolveTensorName(session.inputNames, ['images', 'input', 'image'])
      const adapterSpec = getImageAdapterSpec(
        profile,
        session.inputMetadata.find((metadata) => metadata.name === inputName),
      )
      const { data: rgbData } = await sharp(imagePath)
        .rotate()
        .resize(adapterSpec.width, adapterSpec.height, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })

      const input = preprocessRgb(rgbData, adapterSpec)

      const results = await runUserModelSession(session, [
        { name: inputName, dims: imageTensorDimensions(adapterSpec), data: input },
      ])
      const tensorMap = Object.fromEntries(results) as Parameters<typeof parseSplitDetections>[0]
      const detections =
        profile.adapter === 'split-detection'
          ? parseSplitDetections(tensorMap)
          : parseObjectDetections(
              profile.adapter,
              (() => {
                const output = results.get(
                  resolveTensorName(session.outputNames, ['output0', 'output', 'detections']),
                )
                if (!output) throw new Error('Model output tensor is missing from the response')
                return output
              })(),
            )

      const boxes: SubjectBBox[] = []
      for (const detection of detections) {
        if (detection.confidence < YOLO_CONF_THRESHOLD) continue
        const normalized =
          Math.max(
            Math.abs(detection.x1 ?? detection.cx ?? 0),
            Math.abs(detection.y1 ?? detection.cy ?? 0),
            Math.abs(detection.x2 ?? detection.width ?? 0),
            Math.abs(detection.y2 ?? detection.height ?? 0),
          ) <= 2
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

        if (w > 4 && h > 4) {
          boxes.push({
            x,
            y,
            w,
            h,
            confidence: detection.confidence,
            label:
              profile.classLabels === 'coco'
                ? COCO_CLASSES[detection.classIndex] || `class ${detection.classIndex}`
                : `class ${detection.classIndex}`,
          })
        }
      }

      const filtered = nms(boxes, YOLO_IOU_THRESHOLD)
      if (filtered.length > 0) {
        return {
          ok: true,
          imagePath,
          width,
          height,
          subjects: filtered.slice(0, 10),
          modelLoaded: true,
        }
      }
      // If YOLO found nothing, fall through to saliency
    }

    // Fallback: gradient saliency
    const sampleW = Math.min(width, 64)
    const sampleH = Math.min(height, 64)
    const { data } = await sharp(imagePath)
      .rotate()
      .resize(sampleW, sampleH, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const pixels = new Uint8Array(data)
    const grad = new Float32Array(sampleW * sampleH)
    let maxGrad = 0,
      sumGradX = 0,
      sumGradY = 0,
      gradCount = 0
    for (let y = 1; y < sampleH - 1; y++) {
      for (let x = 1; x < sampleW - 1; x++) {
        const idx = y * sampleW + x
        const gx =
          -pixels[idx - sampleW - 1] +
          pixels[idx - sampleW + 1] -
          2 * pixels[idx - 1] +
          2 * pixels[idx + 1] -
          pixels[idx + sampleW - 1] +
          pixels[idx + sampleW + 1]
        const gy =
          -pixels[idx - sampleW - 1] -
          2 * pixels[idx - sampleW] -
          pixels[idx - sampleW + 1] +
          pixels[idx + sampleW - 1] +
          2 * pixels[idx + sampleW] +
          pixels[idx + sampleW + 1]
        const mag = Math.sqrt(gx * gx + gy * gy)
        grad[idx] = mag
        if (mag > maxGrad) maxGrad = mag
        sumGradX += x * mag
        sumGradY += y * mag
        gradCount += mag
      }
    }
    if (gradCount > 0) {
      const cx = Math.round((sumGradX / gradCount / sampleW) * width)
      const cy = Math.round((sumGradY / gradCount / sampleH) * height)
      const cw = Math.round(width * 0.7)
      const ch = Math.round(height * 0.7)
      const sx = Math.round(Math.max(0, Math.min(width - cw, cx - cw / 2)))
      const sy = Math.round(Math.max(0, Math.min(height - ch, cy - ch / 2)))
      return {
        ok: true,
        imagePath,
        width,
        height,
        subjects: [{ x: sx, y: sy, w: cw, h: ch, confidence: 0.5, label: 'subject' }],
        modelLoaded: session !== null,
      }
    }

    // Last resort: center crop
    const cw2 = Math.round(width * 0.7)
    const ch2 = Math.round(height * 0.7)
    return {
      ok: true,
      imagePath,
      width,
      height,
      modelLoaded: session !== null,
      subjects: [
        {
          x: Math.round((width - cw2) / 2),
          y: Math.round((height - ch2) / 2),
          w: cw2,
          h: ch2,
          confidence: 0.4,
          label: 'subject (center)',
        },
      ],
    }
  } catch (err) {
    return {
      ok: false,
      imagePath,
      width: 0,
      height: 0,
      subjects: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── Search ─────────────────────────────────────────────────
// Uses the existing searchLayered pipeline (hash + ANN vector index)
// against a center-cropped temp image. This avoids reading the
// 5GB+ embedding shard files.

const MAX_SEARCH_RESULTS = 1000

const MODEL_NAME: VisionModelName = 'dinov2_vitb14'

// Face/body rerank bounds: embedding each candidate costs at least one
// detector forward pass, so only the head of the result list is reranked.
const FACE_RERANK_LIMIT = 100
const FACE_RERANK_CONCURRENCY = 4
const DINO_SCORE_PENALTY = 0.85
// Color is a first-class identity cue (product decision 2026-07-26):
// same instance in a different color is a different instance for the
// user's search intent. Blended into crop/osnet identity scores.
const COLOR_WEIGHT = 0.25

interface PersonRerankQuery {
  faceVector?: number[]
  osnetVector?: number[]
  colorHist?: number[]
}

// ── Cached embedding helpers ───────────────────────────────
// Vectors are keyed to (kind, path, mtime) in subjectEmbeddingStore.
// Empty-array entries are negative markers ("no face in this image")
// so known-negative candidates skip recompute too.

async function cachedFaceEmbedding(imagePath: string): Promise<number[] | null> {
  const mtime = statMtimeMs(imagePath)
  if (mtime === null) return null
  const modelSignature = getUserModelFileSignature('face-embedder') ?? 'unavailable'
  const key = subjectEmbeddingKey(`face:${modelSignature}`, imagePath, mtime)
  const cached = getSubjectEmbedding(key)
  if (cached) return cached
  const emb = await getFaceEmbedding(imagePath)
  if (emb.ok && emb.vector) {
    putSubjectEmbedding(key, emb.vector)
    return emb.vector
  }
  if (emb.error === 'no face detected') {
    putSubjectEmbedding(key, []) // negative marker
    return []
  }
  return null // transient failure — do not cache
}

async function cachedEmbedPersonCrops(
  inputs: { imagePath: string; bbox?: SubjectBBox }[],
): Promise<(number[] | null)[]> {
  const modelSignature = getUserModelFileSignature('person-reid') ?? 'unavailable'
  const keys = inputs.map((i) => {
    const mtime = statMtimeMs(i.imagePath)
    return mtime !== null
      ? subjectEmbeddingKey(`osnet:${modelSignature}`, i.imagePath, mtime)
      : null
  })
  const out: (number[] | null)[] = keys.map((k) => (k ? getSubjectEmbedding(k) : null))
  const missingIdx: number[] = []
  out.forEach((v, i) => {
    if (v === null) missingIdx.push(i)
  })
  if (missingIdx.length > 0) {
    const computed = await embedPersonCrops(missingIdx.map((i) => inputs[i]))
    missingIdx.forEach((i, j) => {
      const vec = computed[j]
      if (vec && keys[i]) {
        putSubjectEmbedding(keys[i]!, vec)
        out[i] = vec
      }
      // unreadable images stay null and are not cached (may be transient)
    })
  }
  return out
}

/**
 * Phase 2+3 person rerank. Per design:
 *   face visible  → max(AdaFace similarity, dinoScore × 0.85)
 *   no face       → max(OSNet body similarity, dinoScore × 0.85)
 * Candidates are processed in two phases so OSNet runs in batches:
 *   1. per-candidate face attempt + person-bbox detection (concurrent)
 *   2. batched OSNet embedding for the no-face candidates
 */
async function rerankPerson(
  results: SubjectSearchResult[],
  query: PersonRerankQuery,
  progress?: ReturnType<typeof makeSubjectProgress>,
): Promise<void> {
  const targets = results.slice(0, FACE_RERANK_LIMIT)

  interface CandidateState {
    faceSim?: number
    osnetSim?: number
    personBbox?: SubjectBBox
  }
  const states = new Map<SubjectSearchResult, CandidateState>()

  let cursor = 0
  let detected = 0
  const detect = async (): Promise<void> => {
    while (cursor < targets.length) {
      const r = targets[cursor++]
      const state: CandidateState = {}
      states.set(r, state)
      try {
        if (query.faceVector) {
          const vec = await cachedFaceEmbedding(r.imagePath)
          if (vec && vec.length > 0) {
            state.faceSim = faceSimilarity(query.faceVector, vec)
            detected++
            progress?.emit(
              70 + Math.round((detected / targets.length) * 15),
              `Face matching ${detected}/${targets.length}...`,
              detected,
              targets.length,
            )
            continue
          }
          // vec === null → compute failed (retry next time);
          // vec.length === 0 → known "no face" (cached negative), fall through
        }
        if (query.osnetVector) {
          const det = await detectSubjects(r.imagePath)
          const person = det.ok ? det.subjects.find((s) => s.label === 'person') : undefined
          if (person) state.personBbox = person
        }
      } catch {
        /* candidate stays DINO-only */
      }
      detected++
      progress?.emit(
        70 + Math.round((detected / targets.length) * 15),
        `Detecting candidates ${detected}/${targets.length}...`,
        detected,
        targets.length,
      )
    }
  }
  await Promise.all(Array.from({ length: FACE_RERANK_CONCURRENCY }, () => detect()))

  // Batched OSNet for no-face candidates with a detected person bbox
  if (query.osnetVector) {
    const osnetTargets = targets.filter((r) => states.get(r)?.personBbox)
    if (osnetTargets.length > 0) {
      const embeddings = await cachedEmbedPersonCrops(
        osnetTargets.map((r) => ({ imagePath: r.imagePath, bbox: states.get(r)!.personBbox })),
      )
      // subject color (clothing) from the person crop region
      const queryHist = query.colorHist
      const candHists = queryHist
        ? await Promise.all(
            osnetTargets.map((r) => {
              const b = states.get(r)!.personBbox!
              return computeImageColorHist(r.imagePath, {
                left: b.x,
                top: b.y,
                width: b.w,
                height: b.h,
              })
            }),
          )
        : osnetTargets.map(() => null)
      osnetTargets.forEach((r, i) => {
        const vec = embeddings[i]
        if (vec) {
          let sim = personSimilarity(query.osnetVector!, vec)
          const candHist = candHists[i]
          if (queryHist && candHist) {
            sim =
              sim * (1 - COLOR_WEIGHT) + colorIdentitySimilarity(queryHist, candHist) * COLOR_WEIGHT
          }
          states.get(r)!.osnetSim = sim
        }
      })
    }
  }

  for (const r of results) {
    const state = states.get(r)
    const dinoScore = r.score * DINO_SCORE_PENALTY
    if (!state) {
      // outside the rerank limit
      r.score = dinoScore
      continue
    }
    const faceSim = state.faceSim
    const osnetSim = state.osnetSim
    // Identity-first scoring (product decision 2026-07-26): when an
    // identity signal exists it alone determines the score — a style/scene
    // match must never outrank an identity match. DINO whole-image only
    // serves as the penalized floor for candidates without identity data.
    const identity = Math.max(faceSim ?? -1, osnetSim ?? -1)
    if (identity >= 0) {
      r.score = identity
      r.modelName =
        faceSim !== undefined && faceSim >= (osnetSim ?? -1) ? 'adaface+dinov2' : 'osnet+dinov2'
    } else {
      r.score = dinoScore
    }
  }
  results.sort((a, b) => b.score - a.score)
}

// ── Object-subject identity rerank ────────────────────────
// The base search compares a subject CROP query against WHOLE-IMAGE
// embeddings — scene and style leak in. For identity-level matching
// ("this bag", not "bags like it"), rerank the head candidates by
// DINO similarity between same-class subject crops on both sides.

const CROP_RERANK_LIMIT = 100
const CROP_RERANK_CONCURRENCY = 4

async function rerankBySubjectCrop(
  results: SubjectSearchResult[],
  label: string,
  queryVector: number[],
  embedder: SubjectCropEmbedder,
  queryColorHist: number[] | null,
  progress?: ReturnType<typeof makeSubjectProgress>,
): Promise<void> {
  const targets = results.slice(0, CROP_RERANK_LIMIT)
  let tmpDir: string
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-crops-'))
  } catch {
    // temp dir unavailable (permissions/policy) — skip rerank, keep base order
    return
  }
  try {
    // Phase 1: locate the same-class subject per candidate and crop it
    const cropPaths = new Map<SubjectSearchResult, string>()
    let cursor = 0
    let cropped = 0
    const crop = async (): Promise<void> => {
      while (cursor < targets.length) {
        const r = targets[cursor++]
        try {
          const det = await detectSubjects(r.imagePath)
          if (!det.ok) continue
          const matches = det.subjects.filter((s) => s.label === label)
          const subject = matches.length > 0 ? matches[0] : undefined
          if (!subject) continue
          const cropPath = path.join(tmpDir, `${cropPaths.size}.jpg`)
          await sharp(r.imagePath)
            .extract({ left: subject.x, top: subject.y, width: subject.w, height: subject.h })
            .jpeg({ quality: 90 })
            .toFile(cropPath)
          cropPaths.set(r, cropPath)
        } catch {
          /* candidate stays without crop */
        } finally {
          cropped++
          progress?.emit(
            70 + Math.round((cropped / targets.length) * 15),
            `Locating subjects ${cropped}/${targets.length}...`,
            cropped,
            targets.length,
          )
        }
      }
    }
    await Promise.all(Array.from({ length: CROP_RERANK_CONCURRENCY }, () => crop()))

    // Phase 2: embed crops through the persistent child (batched by 16),
    // reusing cached vectors keyed to (label, path, mtime)
    const entries = [...cropPaths.entries()]
    const entryKeys = entries.map(([r]) => {
      const mtime = statMtimeMs(r.imagePath)
      return mtime !== null ? subjectEmbeddingKey(`crop:${label}`, r.imagePath, mtime) : null
    })
    const vectors: (number[] | null)[] = entryKeys.map((k) => (k ? getSubjectEmbedding(k) : null))
    const missingIdx: number[] = []
    vectors.forEach((v, i) => {
      if (v === null) missingIdx.push(i)
    })
    if (missingIdx.length > 0) {
      progress?.emit(85, `Embedding subject crops 0/${missingIdx.length}...`, 0, missingIdx.length)
      let embeddedCount = 0
      const computed = await Promise.all(
        missingIdx.map((i) =>
          embedder.embed(entries[i][1]).then((vec) => {
            embeddedCount++
            progress?.emit(
              85 + Math.round((embeddedCount / missingIdx.length) * 14),
              `Embedding subject crops ${embeddedCount}/${missingIdx.length}...`,
              embeddedCount,
              missingIdx.length,
            )
            return vec
          }),
        ),
      )
      missingIdx.forEach((i, j) => {
        const vec = computed[j]
        if (vec && entryKeys[i]) {
          putSubjectEmbedding(entryKeys[i]!, vec)
          vectors[i] = vec
        }
      })
    }

    // Phase 3: identity-first scoring — crop DINO similarity blended with
    // subject color; penalized whole-image DINO for uncropped candidates
    const candHists = await Promise.all(entries.map(([, p]) => computeImageColorHist(p)))
    const sims = new Map<SubjectSearchResult, number>()
    entries.forEach(([r], i) => {
      const vec = vectors[i]
      if (!vec) return
      let sim = cosineSimilarity(queryVector, vec)
      const candHist = candHists[i]
      if (queryColorHist && candHist) {
        sim =
          sim * (1 - COLOR_WEIGHT) +
          colorIdentitySimilarity(queryColorHist, candHist) * COLOR_WEIGHT
      }
      sims.set(r, sim)
    })
    for (const r of results) {
      const sim = sims.get(r)
      if (sim !== undefined) {
        r.score = sim
        r.modelName = 'dinov2-crop'
      } else {
        r.score = r.score * DINO_SCORE_PENALTY
      }
    }
    results.sort((a, b) => b.score - a.score)
  } finally {
    // Cleanup must never fail the search: on Windows the temp crops can be
    // briefly locked (indexer/AV) → EPERM. Retry once in the background,
    // then leave the file for the OS temp cleaner.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      setTimeout(() => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true })
        } catch {
          /* leave for OS temp cleanup */
        }
      }, 5000).unref()
    }
  }
}

export async function searchBySubject(
  imagePath: string,
  topK: number = 20,
  subjectOverride?: SubjectBBox,
  onProgress?: (progress: LayeredSearchProgress) => void,
  maskSession?: SubjectMaskSessionData,
): Promise<{ ok: boolean; results: SubjectSearchResult[]; error?: string; subjectLabel?: string }> {
  const progress = makeSubjectProgress(onProgress)
  // Step 1: resolve the subject — caller-supplied bbox (multi-subject
  // picker) or detect + pick the primary one
  let bbox: SubjectBBox
  if (maskSession) {
    progress.emit(5, 'Preparing masked subject query...')
    bbox = {
      ...maskSession.bbox,
      confidence: 1,
      label: 'sam',
    }
  } else if (subjectOverride) {
    progress.emit(5, 'Preparing subject crop...')
    // clamp the override into the actual image bounds (display orientation)
    const metadata = await sharp(imagePath).metadata()
    const { width: imgW, height: imgH } = orientedDimensions(
      metadata.width ?? 0,
      metadata.height ?? 0,
      metadata.orientation,
    )
    const x = Math.max(0, Math.min(imgW - 1, Math.round(subjectOverride.x)))
    const y = Math.max(0, Math.min(imgH - 1, Math.round(subjectOverride.y)))
    const w = Math.min(imgW - x, Math.round(subjectOverride.w))
    const h = Math.min(imgH - y, Math.round(subjectOverride.h))
    if (imgW <= 0 || imgH <= 0 || w < 4 || h < 4) {
      return { ok: false, results: [], error: 'Invalid subject region' }
    }
    bbox = { ...subjectOverride, x, y, w, h }
  } else {
    progress.emit(2, 'Detecting subjects...')
    const detection = await detectSubjects(imagePath)
    if (!detection.ok || detection.subjects.length === 0) {
      return { ok: false, results: [], error: detection.error || 'No subjects detected' }
    }
    // primary subject: largest detected, not merely the highest-confidence one
    bbox = pickPrimarySubject(detection.subjects)!
  }

  // Step 2: crop to subject area and save as temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-subject-'))
  let cropPath = path.join(tmpDir, 'crop.jpg')
  try {
    if (maskSession) {
      const queryFiles = await createSubjectMaskQueryFiles(
        imagePath,
        maskSession.maskPng,
        maskSession.bbox,
        tmpDir,
      )
      bbox = { ...bbox, ...queryFiles.bbox }
      cropPath = queryFiles.maskedCropPath
    } else {
      await sharp(imagePath)
        .rotate()
        .extract({ left: bbox.x, top: bbox.y, width: bbox.w, height: bbox.h })
        .jpeg({ quality: 92 })
        .toFile(cropPath)
    }

    // Verify crop exists
    if (!fs.existsSync(cropPath)) {
      return { ok: false, results: [], error: 'Crop file was not created' }
    }

    // Step 3: search via existing layered pipeline
    const t = Math.min(topK, MAX_SEARCH_RESULTS)
    const request: LayeredSearchRequest = {
      imagePath: cropPath,
      mode: 'standard',
      hashTopK: Math.max(500, t * 4),
      vectorTopK: t,
      rerankTopK: t,
    }

    const response = await searchLayered(request, progress.fromLayered)

    // Map LayeredSearchResult → SubjectSearchResult
    const results: SubjectSearchResult[] = (response.results || [])
      .filter((r) => r.path && r.path !== imagePath)
      .slice(0, Math.min(topK, MAX_SEARCH_RESULTS))
      .map((r) => ({
        imageId: r.imageId ?? r.path,
        imagePath: r.path,
        score: r.finalScore ?? 0,
        modelName: MODEL_NAME,
      }))

    if (results.length === 0) {
      const reasons =
        response.degradationReasons.length > 0
          ? response.degradationReasons.join('; ')
          : `hash=${response.hashCandidateCount ?? 0} vector=${response.vectorCandidateCount ?? 0} degraded=${response.degraded}`
      return { ok: false, results: [], error: `No results — ${reasons}` }
    }

    // Phase 2+3: person subjects get identity rerank — AdaFace when the
    // query face is visible, OSNet body embedding as the no-face fallback.
    // Score per design doc: max(identitySimilarity, dinoScore × 0.85).
    if (bbox.label === 'person') {
      const query: PersonRerankQuery = {}
      const faceQuery = await getFaceEmbedding(cropPath)
      if (faceQuery.ok && faceQuery.vector) {
        query.faceVector = faceQuery.vector
      } else {
        const osnetQuery = await getPersonEmbedding(cropPath)
        if (osnetQuery.ok && osnetQuery.vector) {
          query.osnetVector = osnetQuery.vector
          query.colorHist = (await computeImageColorHist(cropPath)) ?? undefined
        }
      }
      if (query.faceVector || query.osnetVector) {
        await rerankPerson(results, query, progress)
      }
    } else if (bbox.label === 'sam' || bbox.label === 'manual') {
      // The base layered pipeline already used the masked or rectangular
      // subject query. Candidate-side same-class reranking remains disabled
      // because an arbitrary user-selected subject has no reliable class.
    } else {
      // Object subjects: instance-level rerank via same-class crop
      // embeddings (removes scene/style from both sides of the comparison).
      const embedder = await SubjectCropEmbedder.create()
      if (embedder) {
        try {
          const queryVector = await embedder.embed(cropPath)
          if (queryVector) {
            const queryColorHist = await computeImageColorHist(cropPath)
            await rerankBySubjectCrop(
              results,
              bbox.label,
              queryVector,
              embedder,
              queryColorHist,
              progress,
            )
          }
        } finally {
          await embedder.dispose()
        }
      }
    }

    progress.emit(100, 'Done', results.length, results.length)
    return { ok: true, results, subjectLabel: bbox.label }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}
