import fs from 'fs'
import path from 'path'
import { getMediaSearchDir } from './mediaCacheService'
import { BoundedLruCache, type BoundedLruCacheStats } from './boundedAsyncQueue'

const MEDIA_SEARCH_IMAGE_DATA_URL_CACHE_LIMIT = 3000
const MEDIA_SEARCH_IMAGE_DATA_URL_CACHE_MAX_BYTES = 128 * 1024 * 1024
const mediaSearchImageDataUrlCache = new BoundedLruCache<string, string>(
  MEDIA_SEARCH_IMAGE_DATA_URL_CACHE_LIMIT,
  MEDIA_SEARCH_IMAGE_DATA_URL_CACHE_MAX_BYTES,
)

export function clearMediaSearchImageDataUrlCache(): void {
  mediaSearchImageDataUrlCache.clear()
}

export function getMediaSearchImageDataUrlCacheStats(): BoundedLruCacheStats {
  return mediaSearchImageDataUrlCache.stats()
}

export function readMediaSearchImageDataUrl(
  imagePath: string | undefined,
  mime = 'image/jpeg',
): string | undefined {
  if (!imagePath) return undefined
  try {
    const cacheRoot = path.resolve(getMediaSearchDir())
    const resolved = path.resolve(imagePath)
    if (
      resolved !== cacheRoot &&
      !resolved.startsWith(`${cacheRoot}${path.sep}`) &&
      !resolved.startsWith(`${cacheRoot}/`)
    ) {
      return undefined
    }
    if (!fs.existsSync(resolved)) return undefined
    // Symlink/junction defense: a link inside the cache root must not escape it.
    const realRoot = fs.realpathSync(cacheRoot)
    const realResolved = fs.realpathSync(resolved)
    if (
      realResolved !== realRoot &&
      !realResolved.startsWith(`${realRoot}${path.sep}`) &&
      !realResolved.startsWith(`${realRoot}/`)
    ) {
      return undefined
    }
    const stat = fs.statSync(realResolved)
    if (stat.size > 1024 * 1024) return undefined
    const cacheKey = `${realResolved}:${stat.size}:${stat.mtimeMs}:${mime}`
    const cached = mediaSearchImageDataUrlCache.get(cacheKey)
    if (cached) return cached
    const data = fs.readFileSync(realResolved)
    const dataUrl = `data:${mime};base64,${data.toString('base64')}`
    const retainedBytes = Buffer.byteLength(cacheKey, 'utf8') + Buffer.byteLength(dataUrl, 'utf8')
    mediaSearchImageDataUrlCache.set(cacheKey, dataUrl, retainedBytes)
    return dataUrl
  } catch {
    return undefined
  }
}

export function readMediaSearchThumbnailDataUrl(
  thumbnailPath: string | undefined,
): string | undefined {
  return readMediaSearchImageDataUrl(thumbnailPath)
}
