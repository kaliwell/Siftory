import path from 'path'

export const MAX_SCAN_PATHS = 64
export const MAX_SEARCH_TOP_K = 500
export const MAX_FS_PATH_LENGTH = 4096

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 32) return true
  }
  return false
}

export function normalizeFsPath(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  // Reject empty, oversized and control-char input. Control chars include the
  // native scanner path separator \x1f, so this also blocks scan-root injection.
  if (!trimmed || trimmed.length > MAX_FS_PATH_LENGTH || hasControlChars(trimmed)) return null
  return path.normalize(trimmed)
}

export function normalizeScanPaths(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const paths: string[] = []
  for (const value of input) {
    const normalized = normalizeFsPath(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    paths.push(normalized)
    if (paths.length >= MAX_SCAN_PATHS) break
  }
  return paths
}

export function normalizeScanMode(input: unknown): 'addNew' | 'update' | 'updateAll' | 'full' {
  return input === 'addNew' || input === 'update' || input === 'updateAll' || input === 'full'
    ? input
    : 'full'
}

export function normalizeSearchMode(input: unknown): 'fast' | 'balanced' | 'recall' {
  return input === 'fast' || input === 'recall' ? input : 'balanced'
}

export function clampNumber(input: unknown, fallback: number, min: number, max: number): number {
  const value = Number(input)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}
