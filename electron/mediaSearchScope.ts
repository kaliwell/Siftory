import fs from 'fs'
import path from 'path'
import { safeShellPath } from './pathGuards'

export function normalizeMediaSearchScopePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const paths: string[] = []
  const seen = new Set<string>()
  for (const rawPath of value) {
    const filePath = typeof rawPath === 'string' ? safeShellPath(rawPath) : ''
    if (!filePath) continue
    try {
      if (!fs.existsSync(filePath)) continue
      const key = filePath.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      paths.push(filePath)
      if (paths.length >= 64) break
    } catch {
      /* skip invalid scope path */
    }
  }
  return paths
}

function normalizeMediaSearchScopeKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function isMediaSearchPathInScope(filePath: string, scopePaths: string[]): boolean {
  return createMediaSearchScopeMatcher(scopePaths)(filePath)
}

export function createMediaSearchScopeMatcher(scopePaths: string[]): (filePath: string) => boolean {
  if (scopePaths.length === 0) return () => true
  const scopeKeys = scopePaths.map(normalizeMediaSearchScopeKey)
  return (filePath: string) => {
    const key = normalizeMediaSearchScopeKey(filePath)
    return scopeKeys.some((scopeKey) => {
      const prefix = scopeKey.endsWith(path.sep) ? scopeKey : `${scopeKey}${path.sep}`
      return key === scopeKey || key.startsWith(prefix)
    })
  }
}
