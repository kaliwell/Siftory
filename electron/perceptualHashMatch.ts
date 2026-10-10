// ── Perceptual hash matching (pure functions) ─────────────
// Extracted from batchRenameService so the matching logic can be
// unit-tested without pulling in the imageSearchService graph.

export function popcount64(n: bigint): number {
  let count = 0
  let v = n
  while (v) {
    count++
    v &= v - 1n
  }
  return count
}

/** Native addon returns 64-bit hashes as 16-char hex strings. */
export type Hash64 = string | number | bigint

function toBigInt(h: Hash64): bigint {
  if (typeof h === 'bigint') return h
  if (typeof h === 'number') return BigInt(h)
  const s = h.trim().toLowerCase()
  if (!/^(0x)?[0-9a-f]+$/.test(s)) return 0n
  return s.startsWith('0x') ? BigInt(s) : BigInt(`0x${s}`)
}

/**
 * Combined similarity of two perceptual hash pairs (dHash + DCT).
 * Returns 0..1 where 1 means identical hashes.
 */
export function combinedScore(hash1: Hash64, hash2: Hash64, dct1: Hash64, dct2: Hash64): number {
  const dHash = toBigInt(hash1) ^ toBigInt(hash2)
  const dctHash = toBigInt(dct1) ^ toBigInt(dct2)
  const dist = popcount64(dHash)
  const dctDist = popcount64(dctHash)
  return ((64 - dist) / 64) * 0.7 + ((64 - dctDist) / 64) * 0.3
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff'])

export function isImageFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return false
  const ext = filePath.slice(dot).toLowerCase()
  return IMAGE_EXTS.has(ext)
}
