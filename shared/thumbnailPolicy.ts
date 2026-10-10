// v4 invalidates GPU thumbnails that may have been vertically flipped.
// v6 invalidates v5 caches after the native rebuild could recursively ingest
// its own generated JPEGs when a scan root contained the user-data directory.
export const THUMBNAIL_CACHE_VERSION = 6

export const THUMBNAIL_DIMENSION_BUCKETS = [64, 128, 256] as const

export type ThumbnailSourceTier = 'small' | 'medium' | 'large' | 'extra-large' | 'unsafe'

export interface ThumbnailSourceSpec {
  fileBytes: number
  width?: number
  height?: number
}

export interface ThumbnailSourcePolicy {
  tier: ThumbnailSourceTier
  maxIntermediateDimension: number
  preferredConcurrency: number
  safeToDecode: boolean
}

const MIB = 1024 * 1024

/**
 * Collapse arbitrary renderer sizes into reusable cache buckets. The layout
 * continues to use its requested CSS size; only the decoded bitmap is bucketed.
 */
export function bucketThumbnailDimension(requestedDimension: number): number {
  const finiteDimension = Number.isFinite(requestedDimension) ? requestedDimension : 256
  const dimension = Math.max(1, Math.floor(finiteDimension))
  return (
    THUMBNAIL_DIMENSION_BUCKETS.find((candidate) => dimension <= candidate) ??
    THUMBNAIL_DIMENSION_BUCKETS[THUMBNAIL_DIMENSION_BUCKETS.length - 1]
  )
}

/**
 * File bytes measure I/O while pixel count estimates decode memory. A source
 * always receives the stricter of the two classifications.
 */
export function classifyThumbnailSource(spec: ThumbnailSourceSpec): ThumbnailSourcePolicy {
  const fileBytes = Math.max(0, Number.isFinite(spec.fileBytes) ? spec.fileBytes : 0)
  const width = Math.max(0, Number.isFinite(spec.width) ? Math.floor(spec.width ?? 0) : 0)
  const height = Math.max(0, Number.isFinite(spec.height) ? Math.floor(spec.height ?? 0) : 0)
  const pixels = width > 0 && height > 0 ? width * height : 0
  const longestEdge = Math.max(width, height)

  if (fileBytes > 300 * MIB || pixels > 80_000_000 || longestEdge > 50_000) {
    return {
      tier: 'unsafe',
      maxIntermediateDimension: 0,
      preferredConcurrency: 1,
      safeToDecode: false,
    }
  }
  if (fileBytes > 30 * MIB || pixels > 40_000_000) {
    return {
      tier: 'extra-large',
      maxIntermediateDimension: 512,
      preferredConcurrency: 1,
      safeToDecode: true,
    }
  }
  if (fileBytes > 10 * MIB || pixels > 16_000_000) {
    return {
      tier: 'large',
      maxIntermediateDimension: 512,
      preferredConcurrency: 2,
      safeToDecode: true,
    }
  }
  if (fileBytes > 2 * MIB || pixels > 4_000_000) {
    return {
      tier: 'medium',
      maxIntermediateDimension: 512,
      preferredConcurrency: 3,
      safeToDecode: true,
    }
  }
  return {
    tier: 'small',
    maxIntermediateDimension: 256,
    preferredConcurrency: 4,
    safeToDecode: true,
  }
}
