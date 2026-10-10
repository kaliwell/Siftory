// ── Color Feature Service ──────────────────────────────────
// Extracts real HSV color histograms and dominant colors for
// Layer 3 reranking. Uses sharp to decode and sample pixels.

import sharp from 'sharp'
import type { ColorFeature } from '../shared/vectorTypes'
import { upsertColorFeature, getColorFeature } from './vectorDatabaseService'

interface RGBColor {
  r: number
  g: number
  b: number
}

interface DominantColor {
  r: number
  g: number
  b: number
  pct: number
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  const s = max === 0 ? 0 : d / max
  const v = max

  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }

  return [h * 360, s, v]
}

async function sampleImagePixels(imagePath: string): Promise<RGBColor[]> {
  const { data, info } = await sharp(imagePath)
    .resize(96, 96, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })

  const channels = info.channels
  const pixels: RGBColor[] = []
  for (let i = 0; i + 2 < data.length; i += channels) {
    pixels.push({ r: data[i], g: data[i + 1], b: data[i + 2] })
  }
  return pixels
}

function computeHsvHistogram(pixels: RGBColor[]): number[] {
  const H_BINS = 18
  const S_BINS = 4
  const V_BINS = 4
  const totalBins = H_BINS + S_BINS + V_BINS
  const hist = new Array(totalBins).fill(0)

  for (const p of pixels) {
    const [h, s, v] = rgbToHsv(p.r, p.g, p.b)
    const hBin = Math.min(Math.floor(h / (360 / H_BINS)), H_BINS - 1)
    const sBin = Math.min(Math.floor(s * S_BINS), S_BINS - 1)
    const vBin = Math.min(Math.floor(v * V_BINS), V_BINS - 1)

    hist[hBin]++
    hist[H_BINS + sBin]++
    hist[H_BINS + S_BINS + vBin]++
  }

  const total = pixels.length || 1
  for (let i = 0; i < hist.length; i++) hist[i] /= total
  return hist
}

function findDominantColors(pixels: RGBColor[], topK = 3): DominantColor[] {
  const Q = 8
  const buckets = new Map<number, number>()

  for (const p of pixels) {
    const rq = Math.min(Q - 1, Math.floor(p.r / (256 / Q)))
    const gq = Math.min(Q - 1, Math.floor(p.g / (256 / Q)))
    const bq = Math.min(Q - 1, Math.floor(p.b / (256 / Q)))
    const key = (rq * Q + gq) * Q + bq
    buckets.set(key, (buckets.get(key) || 0) + 1)
  }

  const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK)
  const total = pixels.length || 1
  return sorted.map(([key, count]) => {
    const bq = key % Q
    const gq = Math.floor(key / Q) % Q
    const rq = Math.floor(key / (Q * Q))
    return {
      r: Math.round((rq + 0.5) * (256 / Q)),
      g: Math.round((gq + 0.5) * (256 / Q)),
      b: Math.round((bq + 0.5) * (256 / Q)),
      pct: Math.round((count / total) * 100),
    }
  })
}

export function colorSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let intersection = 0
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < a.length; i++) {
    intersection += Math.min(a[i], b[i])
    sumA += a[i]
    sumB += b[i]
  }
  return intersection / (Math.max(sumA, sumB) || 1)
}

/**
 * Identity-oriented color similarity for subject matching: the flat
 * colorSimilarity treats hue/saturation/value marginals equally, so two
 * saturated colors of different hue still score ~0.67. For instance
 * identity ("this red bag", not "a blue one"), hue dominates:
 * hue 0.6 / saturation 0.2 / value 0.2.
 */
export function colorIdentitySimilarity(a: number[], b: number[]): number {
  if (a.length !== 26 || b.length !== 26) return 0
  const section = (start: number, end: number): number => {
    let inter = 0
    let sumA = 0
    let sumB = 0
    for (let i = start; i < end; i++) {
      inter += Math.min(a[i], b[i])
      sumA += a[i]
      sumB += b[i]
    }
    return inter / (Math.max(sumA, sumB) || 1)
  }
  return section(0, 18) * 0.6 + section(18, 22) * 0.2 + section(22, 26) * 0.2
}

export async function extractColorFeature(
  imageId: string,
  imagePath: string = imageId,
): Promise<ColorFeature> {
  const pixels = await sampleImagePixels(imagePath)
  const feature: Omit<ColorFeature, 'id'> = {
    imageId,
    featureType: 'hsv_hist',
    colorHist: computeHsvHistogram(pixels),
    dominantColors: findDominantColors(pixels),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  return upsertColorFeature(feature)
}

export function computeColorScore(queryImageId: string, candidateImageId: string): number {
  const q = getColorFeature(queryImageId)
  const c = getColorFeature(candidateImageId)
  if (!q || !c) return 0
  return colorSimilarity(q.colorHist, c.colorHist)
}

/**
 * Pure histogram extraction for ad-hoc images (temp subject crops) —
 * no database write. Optionally restricts to a region (subject bbox).
 */
export async function computeImageColorHist(
  imagePath: string,
  region?: { left: number; top: number; width: number; height: number },
): Promise<number[] | null> {
  try {
    let pipeline = sharp(imagePath)
    if (region) {
      const metadata = await sharp(imagePath).metadata()
      const imgW = metadata.width ?? 0
      const imgH = metadata.height ?? 0
      const left = Math.max(0, Math.min(imgW - 1, region.left))
      const top = Math.max(0, Math.min(imgH - 1, region.top))
      const width = Math.min(imgW - left, region.width)
      const height = Math.min(imgH - top, region.height)
      if (width < 4 || height < 4) return null
      pipeline = pipeline.extract({ left, top, width, height })
    }
    const { data, info } = await pipeline
      .resize(96, 96, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true })

    const channels = info.channels
    const pixels: RGBColor[] = []
    for (let i = 0; i + 2 < data.length; i += channels) {
      pixels.push({ r: data[i], g: data[i + 1], b: data[i + 2] })
    }
    return computeHsvHistogram(pixels)
  } catch {
    return null
  }
}
