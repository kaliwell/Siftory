import path from 'path'
import os from 'os'
import fs from 'fs'
import type { DirListRequest, DirListSort } from '../shared/ipc-contract'

export const MAX_FILE_OPERATION_SOURCES = 1000
export const MAX_THUMBNAIL_BATCH = 200
export const MAX_USER_PATH_LENGTH = 4096

const DIR_LIST_SORT_FIELDS: DirListSort['field'][] = ['name', 'size', 'type', 'mtime', 'ext']
const DIR_LIST_MAX_PAGE_SIZE = 500

interface ShellPathApi {
  openPath(targetPath: string): Promise<string>
  showItemInFolder(targetPath: string): void
}

interface ShellPathOptions {
  requireExists?: boolean
}

interface ShellPathResult {
  ok: boolean
  path?: string
  error?: string
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 32) return true
  }
  return false
}

export function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1).replace(/^[\\/]/, ''))
  }
  return p
}

export function normalizeUserPath(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > MAX_USER_PATH_LENGTH) return null
  if (hasControlChars(trimmed)) return null
  return path.normalize(expandHome(trimmed))
}

/** UNC paths (\\host\share) are allowed for browsing/reveal but never for execution. */
function isUncPath(value: string): boolean {
  return value.startsWith('\\\\') || value.startsWith('//')
}

export function normalizePathList(input: unknown, maxCount = MAX_FILE_OPERATION_SOURCES): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of input) {
    const normalized = normalizeUserPath(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
    if (result.length >= maxCount) break
  }
  return result
}

export function isSameOrNestedPath(parentPath: string, candidatePath: string): boolean {
  const parent = path.resolve(parentPath)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(parent, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Returns a normalized path safe for shell.openPath / showItemInFolder, or null if invalid. */
export function safeShellPath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string') return null
  const trimmed = rawPath.trim()
  if (!trimmed || hasControlChars(trimmed)) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)) return null
  const normalized = normalizeUserPath(trimmed)
  if (!normalized || normalized === '.' || normalized === '..') return null
  return normalized
}

function validateShellTarget(rawPath: unknown, options: ShellPathOptions = {}): ShellPathResult {
  const targetPath = safeShellPath(rawPath)
  if (!targetPath) return { ok: false, error: 'Invalid path' }
  if (options.requireExists && !fs.existsSync(targetPath)) {
    return { ok: false, path: targetPath, error: 'Path does not exist' }
  }
  return { ok: true, path: targetPath }
}

export async function openSafeShellPath(
  shellApi: ShellPathApi,
  rawPath: unknown,
  options: ShellPathOptions = {},
): Promise<ShellPathResult> {
  const validation = validateShellTarget(rawPath, options)
  if (!validation.ok || !validation.path) return validation
  // Executing remote (UNC) targets is never allowed; browsing/reveal stays permitted.
  if (isUncPath(validation.path)) {
    return { ok: false, path: validation.path, error: 'UNC paths cannot be executed' }
  }
  const error = await shellApi.openPath(validation.path)
  return error ? { ok: false, path: validation.path, error } : { ok: true, path: validation.path }
}

export function revealSafeShellPath(
  shellApi: ShellPathApi,
  rawPath: unknown,
  options: ShellPathOptions = {},
): ShellPathResult {
  const validation = validateShellTarget(rawPath, options)
  if (!validation.ok || !validation.path) return validation
  shellApi.showItemInFolder(validation.path)
  return { ok: true, path: validation.path }
}

export function normalizeConflictOption(options: unknown): 'overwrite' | 'rename' {
  if (
    options &&
    typeof options === 'object' &&
    (options as { conflict?: unknown }).conflict === 'rename'
  ) {
    return 'rename'
  }
  return 'overwrite'
}

export function normalizeDirListRequest(
  raw: unknown,
): { ok: true; req: DirListRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Invalid directory list request' }
  }

  const input = raw as Partial<DirListRequest> & {
    sort?: Partial<DirListSort>
  }
  if (typeof input.dirPath !== 'string' || input.dirPath.trim() === '') {
    return { ok: false, error: 'Invalid directory path' }
  }

  const offsetValue = Number(input.offset)
  const limitValue = Number(input.limit)
  const field = DIR_LIST_SORT_FIELDS.includes(input.sort?.field as DirListSort['field'])
    ? (input.sort!.field as DirListSort['field'])
    : 'name'

  return {
    ok: true,
    req: {
      dirPath: path.normalize(expandHome(input.dirPath)),
      sort: {
        field,
        direction: input.sort?.direction === 'desc' ? 'desc' : 'asc',
      },
      offset: Number.isFinite(offsetValue) ? Math.max(0, Math.floor(offsetValue)) : 0,
      limit: Number.isFinite(limitValue)
        ? Math.max(1, Math.min(DIR_LIST_MAX_PAGE_SIZE, Math.floor(limitValue)))
        : 200,
    },
  }
}
