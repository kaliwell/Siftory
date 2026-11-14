import fsp from 'node:fs/promises'
import type { NativeImage } from 'electron'
import { projectPreviewBitmapDifference } from './projectPreviewBitmap'
import { redactDiagnosticText } from './diagnosticRedaction'
import path from 'node:path'

export interface ShellExtractionApi {
  step?: (name: string) => void | Promise<void>
  thumbnail: (source: string, size: { width: number; height: number }) => Promise<NativeImage>
  icon: (source: string) => Promise<NativeImage>
}

/** Called only in the dedicated Electron process. Parent owns the deadline. */
export async function extractShellThumbnail(source: string, api: ShellExtractionApi) {
  const durations: Record<string, number> = {}
  const sourceInfo: Record<string, string | number> = {}
  let activeStep = 'stat'
  let failureCode: string | undefined
  let reason: string | undefined
  const measure = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
    activeStep = name
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
    sourceInfo.sizeBytes = stat.size
    if (!stat.isFile() || stat.size <= 0 || stat.size > 4 * 1024 * 1024 * 1024)
      return { bytes, durations, outcome: 'source-limit', sourceInfo }
    if (/^\.(psd|psb)$/i.test(path.extname(source))) {
      // Only structural metadata: no layers, pixels, filenames or arbitrary header bytes.
      try {
        const handle = await fsp.open(source, 'r')
        try {
          const buffer = Buffer.alloc(26)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          if (bytesRead === 26 && buffer.toString('ascii', 0, 4) === '8BPS') {
            Object.assign(sourceInfo, {
              format: 'PSD',
              version: buffer.readUInt16BE(4),
              channels: buffer.readUInt16BE(12),
              height: buffer.readUInt32BE(14),
              width: buffer.readUInt32BE(18),
              depth: buffer.readUInt16BE(22),
              colorMode: buffer.readUInt16BE(24),
            })
          } else sourceInfo.format = 'not-psd-header'
        } finally {
          await handle.close()
        }
      } catch {
        sourceInfo.format = 'header-unavailable'
      }
    }
    const thumbnail = await measure('thumbnail', () =>
      api.thumbnail(source, { width: 1024, height: 1024 }),
    )
    if (!thumbnail || thumbnail.isEmpty()) return { bytes, durations, outcome, sourceInfo }
    const icon = await measure('icon', () => api.icon(source))
    if (icon && !icon.isEmpty()) {
      const difference = await measure('compare', () => {
        const size = { width: 64, height: 64 }
        return projectPreviewBitmapDifference(
          Buffer.from(thumbnail.resize(size).toBitmap()),
          Buffer.from(icon.resize(size).toBitmap()),
        )
      })
      if (difference <= 0.035) return { bytes, durations, outcome: 'icon-only', sourceInfo }
    }
    const encoded = await measure('encode', () => thumbnail.toPNG())
    if (encoded.length > 0) {
      bytes = Buffer.from(encoded)
      outcome = 'ready'
    }
  } catch (error) {
    outcome = 'error'
    const code = (error as { code?: string })?.code
    failureCode =
      code === 'ENOENT'
        ? 'SOURCE_MISSING'
        : code === 'EACCES' || code === 'EPERM'
          ? 'SOURCE_PERMISSION_DENIED'
          : `SHELL_${activeStep.toUpperCase()}_FAILED`
    reason = redactDiagnosticText(error instanceof Error ? error.message : String(error), 512)
  }
  return { bytes, durations, outcome, failureCode, reason, sourceInfo }
}
