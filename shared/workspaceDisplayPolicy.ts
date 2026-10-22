import type { DisplayScope } from './ipc/app-core'

export const FOCUSED_DISPLAY_SCOPE_VERSION = 2

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

/** A conventional application window always starts on one display. */
export function restoreFocusedDisplayScope(settings: {
  displayScope?: unknown
  focusedDisplayScopeVersion?: unknown
}): DisplayScope {
  const scope = normalizeDisplayScope(settings.displayScope)
  return scope.mode === 'all' ? { mode: 'primary' } : scope
}
