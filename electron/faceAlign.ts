// ── Face alignment math (pure functions) ──────────────────
// Similarity-transform estimation from 5 facial landmarks to the
// ArcFace 112x112 reference template. Extracted from faceMatchService
// so the geometry can be unit-tested without onnxruntime / sharp.

export interface FacePoint {
  x: number
  y: number
}

// ArcFace reference landmarks for a 112x112 aligned face
// (left eye, right eye, nose, left mouth corner, right mouth corner).
export const ARCFACE_TEMPLATE: FacePoint[] = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
]

export interface Affine2D {
  // forward map: dst = M * src + t
  a: number
  b: number
  c: number
  d: number
  tx: number
  ty: number
}

/**
 * Umeyama similarity transform (rotation + uniform scale + translation)
 * mapping src points onto dst points, least squares.
 * Requires >= 2 point pairs; landmarks come in detection order
 * (left eye, right eye, nose, mouth left, mouth right).
 */
export function estimateSimilarity(src: FacePoint[], dst: FacePoint[]): Affine2D {
  const n = Math.min(src.length, dst.length)
  if (n < 2) throw new Error('estimateSimilarity needs at least 2 point pairs')

  let srcMx = 0,
    srcMy = 0,
    dstMx = 0,
    dstMy = 0
  for (let i = 0; i < n; i++) {
    srcMx += src[i].x
    srcMy += src[i].y
    dstMx += dst[i].x
    dstMy += dst[i].y
  }
  srcMx /= n
  srcMy /= n
  dstMx /= n
  dstMy /= n

  // Complex-domain least squares: w ≈ alpha * z + beta
  let numRe = 0,
    numIm = 0,
    den = 0
  for (let i = 0; i < n; i++) {
    const zx = src[i].x - srcMx
    const zy = src[i].y - srcMy
    const wx = dst[i].x - dstMx
    const wy = dst[i].y - dstMy
    // alpha = Σ w * conj(z) / Σ |z|²
    numRe += wx * zx + wy * zy
    numIm += wy * zx - wx * zy
    den += zx * zx + zy * zy
  }
  if (den === 0) throw new Error('degenerate source points')
  const aRe = numRe / den
  const aIm = numIm / den

  // forward matrix rows: [aRe, -aIm; aIm, aRe]
  const tx = dstMx - (aRe * srcMx - aIm * srcMy)
  const ty = dstMy - (aIm * srcMx + aRe * srcMy)
  return { a: aRe, b: -aIm, c: aIm, d: aRe, tx, ty }
}

/** Invert a similarity/affine transform (for output→input resampling). */
export function invertAffine(m: Affine2D): Affine2D {
  const det = m.a * m.d - m.b * m.c
  if (det === 0) throw new Error('singular affine matrix')
  const a = m.d / det
  const b = -m.b / det
  const c = -m.c / det
  const d = m.a / det
  return {
    a,
    b,
    c,
    d,
    tx: -(a * m.tx + b * m.ty),
    ty: -(c * m.tx + d * m.ty),
  }
}

export function applyAffine(m: Affine2D, p: FacePoint): FacePoint {
  return {
    x: m.a * p.x + m.b * p.y + m.tx,
    y: m.c * p.x + m.d * p.y + m.ty,
  }
}

/** Cosine similarity of two vectors; returns 0 for empty/degenerate input. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0,
    na = 0,
    nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** L2-normalize a vector in place-safe way (returns a new array). */
export function l2Normalize(v: ArrayLike<number>): number[] {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const norm = Math.sqrt(sum) || 1
  const out = new Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}
