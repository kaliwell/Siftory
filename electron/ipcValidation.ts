import path from 'path'

const MAX_CLIPBOARD_CHARS = 1_000_000
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024
const MAX_CONFIG_BYTES = 8 * 1024 * 1024
const MAX_SCAN_FILE_SIZE = 1024 ** 4
const MAX_FOLDER_PATH_LENGTH = 4096

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 32) return true
  }
  return false
}

export function normalizeClipboardText(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_CLIPBOARD_CHARS) return null
  return raw
}

export function normalizeTransparency(raw: unknown): number | null {
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.min(60, value))
}

export function normalizeFolderPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_FOLDER_PATH_LENGTH || hasControlChars(trimmed)) return null
  const normalized = path.normalize(trimmed)
  return normalized === '.' || normalized === '..' ? null : normalized
}

export function normalizePersistedObject(
  raw: unknown,
  kind: 'settings' | 'config',
): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  try {
    const serialized = JSON.stringify(raw)
    const maxBytes = kind === 'settings' ? MAX_SETTINGS_BYTES : MAX_CONFIG_BYTES
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) return null
    const parsed = JSON.parse(serialized)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function normalizeDuplicateScanOptions(
  raw: unknown,
): { dirPath: string; minSize: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const dirPath = normalizeFolderPath(input.dirPath)
  if (!dirPath) return null
  const value = input.minSize === undefined ? 1024 : Number(input.minSize)
  if (!Number.isFinite(value) || value < 0 || value > MAX_SCAN_FILE_SIZE) return null
  return { dirPath, minSize: Math.floor(value) }
}

export function normalizeLargestOptions(raw: unknown): { dirPath: string; topN: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const dirPath = normalizeFolderPath(input.dirPath)
  if (!dirPath) return null
  const value = input.topN === undefined ? 50 : Number(input.topN)
  if (!Number.isFinite(value) || value < 1 || value > 500) return null
  return { dirPath, topN: Math.floor(value) }
}
