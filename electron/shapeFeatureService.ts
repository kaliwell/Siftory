// ── Shape Feature Service ──────────────────────────────────
// Extracts real image proportion and simple structure features
// for Layer 3 reranking.

import sharp from 'sharp'
import type { ShapeFeature } from '../shared/vectorTypes'
import { upsertShapeFeature, getShapeFeature } from './vectorDatabaseService'

interface ShapeMeasurements {
  aspectRatio: number
  objectAreaRatio: number
  edgeDensity: number
  bboxWidth: number
  bboxHeight: number
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function estimateBackground(gray: Buffer, width: number, height: number): number {
  let sum = 0
  let count = 0
  for (let x = 0; x < width; x++) {
    sum += gray[x] + gray[(height - 1) * width + x]
    count += 2
  }
  for (let y = 1; y < height - 1; y++) {
    sum += gray[y * width] + gray[y * width + width - 1]
    count += 2
  }
  return count > 0 ? sum / count : 255
}

function computeEdgeDensity(gray: Buffer, width: number, height: number): number {
  let edges = 0
  let comparisons = 0
  for (let y = 1; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const idx = y * width + x
      const dx = Math.abs(gray[idx] - gray[idx - 1])
      const dy = Math.abs(gray[idx] - gray[idx - width])
      if (dx + dy > 45) edges++
      comparisons++
    }
  }
  return comparisons > 0 ? edges / comparisons : 0
}

function computeForegroundFromAlpha(
  rgba: Buffer,
  width: number,
  height: number,
): {
  foreground: number
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let foreground = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = rgba[(y * width + x) * 4 + 3]
      if (alpha > 16) {
        foreground++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  return { foreground, minX, minY, maxX, maxY }
}

async function extractShapeMeasurements(imagePath: string): Promise<ShapeMeasurements> {
  const meta = await sharp(imagePath).metadata()
  const sourceWidth = meta.width || 1
  const sourceHeight = meta.height || 1
  const aspectRatio = sourceWidth / Math.max(1, sourceHeight)

  const resized = sharp(imagePath).resize(128, 128, { fit: 'inside', withoutEnlargement: true })
  const { data: rgba, info: rgbaInfo } = await resized
    .clone()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const alphaForeground = computeForegroundFromAlpha(rgba, rgbaInfo.width, rgbaInfo.height)

  const { data, info } = await resized
    .clone()
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const width = info.width
  const height = info.height
  const background = estimateBackground(data, width, height)

  let minX = alphaForeground.foreground > 0 ? alphaForeground.minX : width
  let minY = alphaForeground.foreground > 0 ? alphaForeground.minY : height
  let maxX = alphaForeground.foreground > 0 ? alphaForeground.maxX : -1
  let maxY = alphaForeground.foreground > 0 ? alphaForeground.maxY : -1
  let foreground = alphaForeground.foreground

  if (foreground === 0 || foreground >= width * height * 0.98) {
    minX = width
    minY = height
    maxX = -1
    maxY = -1
    foreground = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x
        const delta = Math.abs(data[idx] - background)
        if (delta > 22) {
          foreground++
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
  }

  const hasForeground = foreground > 0
  const bboxWidth = hasForeground ? maxX - minX + 1 : width
  const bboxHeight = hasForeground ? maxY - minY + 1 : height
  const objectAreaRatio = hasForeground ? foreground / Math.max(1, width * height) : 1

  return {
    aspectRatio,
    objectAreaRatio: clamp01(objectAreaRatio),
    edgeDensity: clamp01(computeEdgeDensity(data, width, height)),
    bboxWidth: Math.round((bboxWidth / Math.max(1, width)) * sourceWidth),
    bboxHeight: Math.round((bboxHeight / Math.max(1, height)) * sourceHeight),
  }
}

export function shapeSimilarity(a: ShapeFeature, b: ShapeFeature): number {
  const arDiff = Math.abs(a.aspectRatio - b.aspectRatio)
  const arScore = Math.max(0, 1 - arDiff / Math.max(a.aspectRatio, b.aspectRatio, 0.1))

  const areaDiff = Math.abs(a.objectAreaRatio - b.objectAreaRatio)
  const areaScore = Math.max(0, 1 - areaDiff)

  const edgeDiff = Math.abs(a.edgeDensity - b.edgeDensity)
  const edgeScore = Math.max(0, 1 - edgeDiff / Math.max(a.edgeDensity, b.edgeDensity, 0.01))

  const bboxAspectA = a.bboxWidth / Math.max(1, a.bboxHeight)
  const bboxAspectB = b.bboxWidth / Math.max(1, b.bboxHeight)
  const bboxDiff = Math.abs(bboxAspectA - bboxAspectB)
  const bboxScore = Math.max(0, 1 - bboxDiff / Math.max(bboxAspectA, bboxAspectB, 0.1))

  return 0.4 * arScore + 0.25 * bboxScore + 0.2 * areaScore + 0.15 * edgeScore
}

export async function extractShapeFeature(
  imageId: string,
  imagePath: string = imageId,
): Promise<ShapeFeature> {
  const shape = await extractShapeMeasurements(imagePath)
  const feature: Omit<ShapeFeature, 'id'> = {
    imageId,
    ...shape,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  return upsertShapeFeature(feature)
}

export function computeShapeScore(queryImageId: string, candidateImageId: string): number {
  const q = getShapeFeature(queryImageId)
  const c = getShapeFeature(candidateImageId)
  if (!q || !c) return 0
  return shapeSimilarity(q, c)
}
