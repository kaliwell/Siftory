const EMBEDDED_PATH_PATTERN =
  /(?:[a-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:users|home|root|tmp|var|etc|mnt|volumes)\/)[^\r\n"']*/gi
const URI_PATTERN = /\b(?:sftp|ssh|file|https?):\/\/[^\s"']+/gi
const EMAIL_PATTERN = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const SECRET_PATTERN =
  /\b(password|passphrase|token|secret|private[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi

/**
 * Bound and redact free-form diagnostics before they reach logs, reports or
 * renderer-visible error messages. This intentionally does not preserve a
 * basename: filenames themselves may be private customer data.
 */
export function redactDiagnosticText(value: unknown, maximumLength = 4_096): string {
  if (typeof value !== 'string') return ''
  const boundedMaximum = Number.isSafeInteger(maximumLength)
    ? Math.min(16_384, Math.max(64, maximumLength))
    : 4_096
  return value
    .replaceAll('\u0000', '')
    .slice(0, boundedMaximum)
    .replace(SECRET_PATTERN, '$1=[redacted]')
    .replace(URI_PATTERN, '[uri]')
    .replace(EMBEDDED_PATH_PATTERN, '[path]')
    .replace(EMAIL_PATTERN, '[email]')
    .replace(IPV4_PATTERN, '[ip]')
    .replace(/\s+/g, ' ')
    .trim()
}

export function redactDiagnosticError(error: unknown): string {
  return redactDiagnosticText(error instanceof Error ? error.message : String(error))
}

export function containsUnsafeDiagnosticText(value: string): boolean {
  const patterns = [EMBEDDED_PATH_PATTERN, URI_PATTERN, EMAIL_PATTERN, IPV4_PATTERN, SECRET_PATTERN]
  try {
    return patterns.some((pattern) => pattern.test(value))
  } finally {
    for (const pattern of patterns) pattern.lastIndex = 0
  }
}
