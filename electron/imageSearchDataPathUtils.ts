import path from 'node:path'
import { Buffer } from 'node:buffer'

/**
 * Canonical Image Search path key. Windows paths are resolved with win32
 * semantics even when fixtures execute outside Electron.
 */
export function normalizedImageDataPathKey(value: string): string {
  const raw = String(value || '')
    .trim()
    .replace(/\//g, '\\')
  if (!raw) return ''
  const absolute =
    /^[a-zA-Z]:/.test(raw) || raw.startsWith('\\\\')
      ? path.win32.resolve(raw)
      : path.resolve(raw).replace(/\//g, '\\')
  const normalized = absolute.toLowerCase()
  if (/^[a-z]:\\$/.test(normalized)) return normalized
  return normalized.replace(/\\+$/, '')
}

export function isImageDataPathWithin(candidate: string, folder: string): boolean {
  const candidateKey = normalizedImageDataPathKey(candidate)
  const folderKey = normalizedImageDataPathKey(folder)
  if (!candidateKey || !folderKey) return false
  if (candidateKey === folderKey) return true
  return folderKey.endsWith('\\')
    ? candidateKey.startsWith(folderKey)
    : candidateKey.startsWith(`${folderKey}\\`)
}

/** Preserve native data-query semantics without resolving substring queries. */
export function normalizedImageDataQueryPrefix(query: string): string | null {
  const normalized = String(query || '')
    .replace(/\/+/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
  if (!normalized) return null
  return normalized.includes(':\\') || normalized.startsWith('\\') ? normalized : null
}

export function isImageDataQueryPathWithin(recordPath: string, prefix: string): boolean {
  const normalizedPath = String(recordPath || '')
    .replace(/\/+/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
  return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}\\`)
}

/**
 * Decode one JSON string field without parsing the adjacent vector array.
 * Embedding rows are often tens of KiB, so full JSON.parse would allocate the
 * whole numeric vector during catalog and folder scans.
 */
export function extractJsonStringField(line: string, field: string): string | undefined {
  if (!field || field.length > 96) return undefined
  const marker = JSON.stringify(field)
  let searchFrom = 0
  while (searchFrom < line.length) {
    const markerIndex = line.indexOf(marker, searchFrom)
    if (markerIndex < 0) return undefined
    let cursor = markerIndex + marker.length
    while (cursor < line.length && /\s/.test(line[cursor])) cursor++
    if (line[cursor] !== ':') {
      searchFrom = markerIndex + marker.length
      continue
    }
    cursor++
    while (cursor < line.length && /\s/.test(line[cursor])) cursor++
    if (line[cursor] !== '"') return undefined
    const start = cursor
    let escaped = false
    for (cursor += 1; cursor < line.length; cursor++) {
      const char = line[cursor]
      if (char === '"' && !escaped) {
        try {
          const decoded: unknown = JSON.parse(line.slice(start, cursor + 1))
          return typeof decoded === 'string' ? decoded : undefined
        } catch {
          return undefined
        }
      }
      if (char === '\\') escaped = !escaped
      else escaped = false
    }
    return undefined
  }
  return undefined
}

/**
 * Buffer variant used by full catalog scans. It decodes only the requested
 * quoted value and never materializes the adjacent multi-KiB vector as a JS
 * string.
 */
export function extractJsonStringFieldBuffer(data: Uint8Array, field: string): string | undefined {
  if (!field || field.length > 96) return undefined
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const marker = Buffer.from(JSON.stringify(field), 'utf8')
  const isWhitespace = (value: number): boolean =>
    value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d
  let searchFrom = 0
  while (searchFrom < buffer.length) {
    const markerIndex = buffer.indexOf(marker, searchFrom)
    if (markerIndex < 0) return undefined
    let cursor = markerIndex + marker.length
    while (cursor < buffer.length && isWhitespace(buffer[cursor])) cursor++
    if (buffer[cursor] !== 0x3a) {
      searchFrom = markerIndex + marker.length
      continue
    }
    cursor++
    while (cursor < buffer.length && isWhitespace(buffer[cursor])) cursor++
    if (buffer[cursor] !== 0x22) return undefined
    const start = cursor
    for (cursor += 1; cursor < buffer.length; cursor++) {
      if (buffer[cursor] === 0x5c) {
        cursor++
        continue
      }
      if (buffer[cursor] !== 0x22) continue
      try {
        const decoded: unknown = JSON.parse(buffer.subarray(start, cursor + 1).toString('utf8'))
        return typeof decoded === 'string' ? decoded : undefined
      } catch {
        return undefined
      }
    }
    return undefined
  }
  return undefined
}
