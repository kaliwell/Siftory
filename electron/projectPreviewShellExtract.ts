import fsp from 'node:fs/promises'
import type { NativeImage } from 'electron'
import { projectPreviewBitmapDifference } from './projectPreviewBitmap'

export interface ShellExtractionApi {
  step?: (name: string) => void | Promise<void>
  thumbnail: (source: string, size: { width: number; height: number }) => Promise<NativeImage>
  icon: (source: string) => Promise<NativeImage>
}

/** Called only in the dedicated Electron process. Parent owns the deadline. */
export async function extractShellThumbnail(source: string, api: ShellExtractionApi) {
  const durations: Record<string, number> = {}
  const measure = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
    await api.step?.(name)
    const started = performance.now()
    try {
      return await work()
    } finally {
      durations[name] = performance.now() - started
    }
  }
  let bytes: Buffer | null = null
  let outcome = 'unavailable'
  try {
    const stat = await measure('stat', () => fsp.stat(source))
    if (!stat.isFile() || stat.size <= 0 || stat.size > 4 * 1024 * 1024 * 1024)
      return { bytes, durations, outcome: 'source-limit' }
    const thumbnail = await measure('thumbnail', () =>
      api.thumbnail(source, { width: 1024, height: 1024 }),
    )
    if (!thumbnail || thumbnail.isEmpty()) return { bytes, durations, outcome }
    const icon = await measure('icon', () => api.icon(source))
    if (icon && !icon.isEmpty()) {
      const difference = await measure('compare', () => {
        const size = { width: 64, height: 64 }
        return projectPreviewBitmapDifference(
          Buffer.from(thumbnail.resize(size).toBitmap()),
          Buffer.from(icon.resize(size).toBitmap()),
        )
      })
      if (difference <= 0.035) return { bytes, durations, outcome: 'icon-only' }
    }
    const encoded = await measure('encode', () => thumbnail.toPNG())
    if (encoded.length > 0) {
      bytes = Buffer.from(encoded)
      outcome = 'ready'
    }
  } catch {
    outcome = 'error'
  }
  return { bytes, durations, outcome }
}
