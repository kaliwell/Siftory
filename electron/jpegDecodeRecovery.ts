import path from 'path'

const RECOVERABLE_JPEG_WARNING =
  /premature end of jpeg image|invalid sos parameters|warning treated as error due to failon setting/i

/**
 * Some camera and downloaded JPEGs are displayable but contain a truncated
 * tail or non-standard scan header. Only these known JPEG warnings may use the
 * tolerant decoder retry; unsupported formats and hard decode failures remain
 * rejected.
 */
export function isRecoverableJpegDecodeWarning(filePath: string, error: unknown): boolean {
  const extension = path.extname(filePath).toLowerCase()
  if (extension !== '.jpg' && extension !== '.jpeg') return false
  const message = error instanceof Error ? error.message : String(error)
  return RECOVERABLE_JPEG_WARNING.test(message)
}
