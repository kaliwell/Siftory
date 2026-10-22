import type { DisplayScope } from './ipc/app-core'

export const FOCUSED_DISPLAY_SCOPE_VERSION = 1

/** Invalid or absent scopes must never expand a focused window across screens. */
export function normalizeDisplayScope(raw: unknown): DisplayScope {
  if (!raw || typeof raw !== 'object') return { mode: 'primary' }
  const value = raw as Partial<DisplayScope>
  if (value.mode === 'all') return { mode: 'all' }
  if (value.mode === 'display' && typeof value.displayId === 'string' && value.displayId.trim()) {
    return { mode: 'display', displayId: value.displayId }
  }
  return { mode: 'primary' }
}

/** Old overlay profiles saved all by default; require a new explicit choice to keep it. */
export function restoreFocusedDisplayScope(settings: {
  displayScope?: unknown
  focusedDisplayScopeVersion?: unknown
}): DisplayScope {
  const scope = normalizeDisplayScope(settings.displayScope)
  const version = settings.focusedDisplayScopeVersion
  const confirmed =
    typeof version === 'number' &&
    Number.isFinite(version) &&
    version >= FOCUSED_DISPLAY_SCOPE_VERSION
  return scope.mode === 'all' && !confirmed ? { mode: 'primary' } : scope
}
