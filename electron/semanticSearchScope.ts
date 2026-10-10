/**
 * Explicit state of the Native image-index scope (VAL-036). Previously the
 * absent, valid-empty and corrupt states collapsed into one "empty scope"
 * result that silently widened vector searches to the full library.
 * - absent: no manifest.json — the Native index was never built (legacy
 *   "no scope" behavior: widening is intended and explicit).
 * - ready: the scope resolved to at least one indexed path.
 * - valid-empty: the manifest parses and declares an empty index (widening
 *   stays, with an explicit reason).
 * - corrupt: the manifest exists but cannot be parsed or has an invalid
 *   shape. Consumers must fail closed — never widen silently.
 */
export type NativeScopeState = 'absent' | 'ready' | 'valid-empty' | 'corrupt'

function normalizeSemanticPathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export function buildSemanticPathScope(paths: readonly string[]): Set<string> {
  return new Set(paths.map(normalizeSemanticPathKey))
}

export function filterSemanticVectorCandidates<T extends { path: string }>(
  candidates: readonly T[],
  activePathKeys: ReadonlySet<string>,
): T[] {
  if (activePathKeys.size === 0) return [...candidates]
  return candidates.filter((candidate) =>
    activePathKeys.has(normalizeSemanticPathKey(candidate.path)),
  )
}
