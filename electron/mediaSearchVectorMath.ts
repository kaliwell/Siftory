import path from 'path'
import { getVisionModelCapability, type VisionModelName } from './modelRegistry'
import { requireNormalizedEmbeddingVector } from './embeddingVectorValidation'

export type MediaFrameModelName = VisionModelName

export function normalizeFrameKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function cosineScore(a: number[] | Float32Array, b: number[] | Float32Array): number {
  if (!isStrictNumericVector(a) || !isStrictNumericVector(b) || a.length !== b.length) {
    return -Infinity
  }
  const len = a.length
  if (len <= 0) return 0
  let aScale = 0
  let bScale = 0
  for (let i = 0; i < len; i++) {
    const av = a[i]
    const bv = b[i]
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return -Infinity
    aScale = Math.max(aScale, Math.abs(av))
    bScale = Math.max(bScale, Math.abs(bv))
  }
  if (aScale === 0 || bScale === 0) return 0

  let dot = 0
  let aNormSquared = 0
  let bNormSquared = 0
  for (let i = 0; i < len; i++) {
    const av = a[i] / aScale
    const bv = b[i] / bScale
    dot += av * bv
    aNormSquared += av * av
    bNormSquared += bv * bv
  }
  const denominator = Math.sqrt(aNormSquared) * Math.sqrt(bNormSquared)
  if (!Number.isFinite(dot) || !Number.isFinite(denominator) || denominator <= 0) return 0
  return (Math.max(-1, Math.min(1, dot / denominator)) + 1) / 2
}

export function normalizedCosineScore(
  a: number[] | Float32Array,
  b: number[] | Float32Array,
): number {
  if (!isStrictNumericVector(a) || !isStrictNumericVector(b) || a.length !== b.length) {
    return -Infinity
  }
  if (a.length <= 0) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i]
    const bv = b[i]
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return -Infinity
    dot += av * bv
  }
  if (!Number.isFinite(dot)) return -Infinity
  return (Math.max(-1, Math.min(1, dot)) + 1) / 2
}

export function expectedFrameVectorDim(modelName: MediaFrameModelName): number {
  return getVisionModelCapability(modelName).dim
}

export function normalizeFrameVector(value: unknown, dim: number): number[] | null {
  try {
    return requireNormalizedEmbeddingVector(value, dim)
  } catch {
    return null
  }
}

function isStrictNumericVector(value: unknown): value is number[] | Float32Array {
  return Array.isArray(value) || value instanceof Float32Array
}
