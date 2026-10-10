// ── Person Re-Identification Service (user model slot) ─────
// Embedding: compatible 256x128 ONNX → 512d L2-normalized vector.
// Used as the fallback signal for person
// subjects whose face is not visible (back view, occlusion, distance).
// The user is responsible for installing a model with compatible I/O.
// All unvetted ONNX work runs inside the isolated user-model runtime child
// (electron/userModelSessionService.ts); main only caches session metadata.

import sharp from 'sharp'
import type { SubjectBBox } from './subjectBoxes'
import { cosineSimilarity } from './faceAlign'
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
  preprocessRgb,
  resolveTensorName,
} from './userModelRuntimeAdapters'

const OSNET_BATCH = 16

let loadError: string | null = null
let loadReason: UserModelNegativeReason | undefined

async function getOsnetSession(): Promise<UserModelSession | null> {
  const { session, error, reason } = await acquireUserModelSession('person-reid')
  loadError = error ?? null
  loadReason = reason
  return session
}

export async function getPersonReidStatus(): Promise<{ ready: boolean; error?: string }> {
  const s = await getOsnetSession()
  return { ready: s !== null, error: loadError ?? undefined }
}

async function loadPersonCrop(
  imagePath: string,
  width: number,
  height: number,
  bbox?: SubjectBBox,
): Promise<Buffer | null> {
  try {
    let pipeline = sharp(imagePath)
    if (bbox) {
      const metadata = await sharp(imagePath).metadata()
      const imgW = metadata.width ?? 0
      const imgH = metadata.height ?? 0
      const left = Math.max(0, Math.min(imgW - 1, bbox.x))
      const top = Math.max(0, Math.min(imgH - 1, bbox.y))
      const width = Math.min(imgW - left, bbox.w)
      const height = Math.min(imgH - top, bbox.h)
      if (width < 8 || height < 8) return null
      pipeline = pipeline.extract({ left, top, width, height })
    }
    const { data } = await pipeline
      .resize(width, height, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return data
  } catch {
    return null
  }
}

export interface PersonReidInput {
  imagePath: string
  bbox?: SubjectBBox
}

/**
 * Embed person crops in chunks of 16 (dynamic batch — no padding).
 * Returns one vector per input, or null entries for unreadable images.
 */
export async function embedPersonCrops(inputs: PersonReidInput[]): Promise<(number[] | null)[]> {
  const s = await getOsnetSession()
  if (!s) return inputs.map(() => null)
  const profile = getUserModelProfile('person-reid')
  const inputName = resolveTensorName(s.inputNames, ['input', 'images', 'data'])
  const adapterSpec = getImageAdapterSpec(
    profile,
    s.inputMetadata.find((metadata) => metadata.name === inputName),
  )

  const buffers = await Promise.all(
    inputs.map((i) => loadPersonCrop(i.imagePath, adapterSpec.width, adapterSpec.height, i.bbox)),
  )
  const results: (number[] | null)[] = new Array(inputs.length).fill(null)

  const outputName = resolveTensorName(s.outputNames, ['embedding', 'features', 'output'])
  const sampleLength = 3 * adapterSpec.width * adapterSpec.height

  const executeBatch = async (indices: number[]): Promise<void> => {
    const batch = new Float32Array(indices.length * sampleLength)
    indices.forEach((idx, slot) => {
      batch.set(preprocessRgb(buffers[idx]!, adapterSpec), slot * sampleLength)
    })
    const out = await runUserModelSession(s, [
      {
        name: inputName,
        dims: imageTensorDimensions(adapterSpec, indices.length),
        data: batch,
      },
    ])
    const output = out.get(outputName)
    if (!output) throw new Error('Person ReID model returned no embedding tensor')
    const data = output.data
    const outputDimension = data.length / indices.length
    if (!Number.isInteger(outputDimension) || outputDimension < 2) {
      throw new Error('Person ReID output does not contain one embedding per input')
    }
    let invalid = 0
    indices.forEach((idx, slot) => {
      try {
        results[idx] = requireStrictUserModelEmbedding(
          data.subarray(slot * outputDimension, (slot + 1) * outputDimension),
          'person ReID',
        )
      } catch {
        // A hostile crop embedding degrades to a per-crop miss, never a crash.
        results[idx] = null
        invalid += 1
      }
    })
    if (invalid > 0 && invalid === indices.length) {
      throw new Error('Person ReID output failed validation for the whole batch')
    }
  }

  for (let start = 0; start < inputs.length; start += OSNET_BATCH) {
    const batchIdx: number[] = []
    for (let i = start; i < Math.min(start + OSNET_BATCH, inputs.length); i++) {
      if (buffers[i]) batchIdx.push(i)
    }
    if (batchIdx.length === 0) continue

    try {
      await executeBatch(batchIdx)
    } catch (error) {
      if (batchIdx.length === 1) throw error
      // Many exported ReID graphs fix the first dimension to one. Keep the
      // fast dynamic-batch path, then transparently retry those graphs one by one.
      for (const index of batchIdx) await executeBatch([index])
    }
  }
  return results
}

/** One-shot convenience wrapper for a single person crop. */
export async function getPersonEmbedding(
  imagePath: string,
  bbox?: SubjectBBox,
): Promise<{ ok: boolean; vector?: number[]; error?: string; reason?: UserModelNegativeReason }> {
  const s = await getOsnetSession()
  if (!s) {
    return {
      ok: false,
      error: loadError || 'osnet unavailable',
      reason: loadReason ?? 'model-invalid',
    }
  }
  let vector: number[] | null
  try {
    ;[vector] = await embedPersonCrops([{ imagePath, bbox }])
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      reason: 'output-invalid',
    }
  }
  if (!vector) return { ok: false, error: 'cannot read image', reason: 'input-unreadable' }
  return { ok: true, vector }
}

export function personSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return a.length === b.length ? cosineSimilarity(a, b) : 0
}
