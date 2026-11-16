import { isInteractiveSearchActive, onInteractiveSearchIdle } from './interactiveSearchPriority'
let active = false
let snapshotRequired = false
let preparations = 0
export function setVectorPreparationActive(value: boolean): void {
  active = value
  if (value) snapshotRequired = true
}
export function isVectorPreparationActive(): boolean {
  return active || preparations > 0 || snapshotRequired
}

export function beginSearchablePreparation(): () => void {
  preparations++
  snapshotRequired = true
  let released = false
  return () => {
    if (!released) {
      released = true
      preparations--
    }
  }
}

let revision = 0
let unknownRevision = 0
let unknownActive = 0
const changedPaths = new Map<string, number>()
const activePaths = new Map<string, number>()
function recordPaths(keys?: readonly string[]): void {
  revision++
  if (!keys) {
    unknownRevision = revision
    return
  }
  for (const key of keys) {
    changedPaths.delete(key)
    changedPaths.set(key, revision)
  }
  while (changedPaths.size > 100000) {
    const first = changedPaths.keys().next().value!
    unknownRevision = Math.max(unknownRevision, changedPaths.get(first)!)
    changedPaths.delete(first)
  }
}
export function changedPreparedPathsSince(since: number): { reset: boolean; keys: Set<string> } {
  const keys = new Set(activePaths.keys())
  if (since !== revision) for (const [key, at] of changedPaths) if (at > since) keys.add(key)
  return { reset: unknownActive > 0 || unknownRevision > since, keys }
}
export function invalidatePreparedSearches(): void {
  recordPaths()
}
export function getPreparationSearchRevision(): number {
  return revision
}

let mutations = 0
export function isPreparedSearchMutationActive(): boolean {
  return mutations > 0
}
export function beginPreparedSearchMutation(keys?: readonly string[]): () => void {
  mutations++
  if (!keys) unknownActive++
  else for (const key of keys) activePaths.set(key, (activePaths.get(key) || 0) + 1)
  recordPaths(keys)
  let released = false
  return () => {
    if (released) return
    released = true
    recordPaths(keys)
    if (!keys) unknownActive--
    else
      for (const key of keys) {
        const count = activePaths.get(key)! - 1
        if (count) activePaths.set(key, count)
        else activePaths.delete(key)
      }
    mutations--
  }
}

export function markPreparedSearchCommitted(): void {
  snapshotRequired = false
}

export async function invalidatePreparedInputs(
  remove: () => number,
  flush: () => Promise<unknown>,
  keys?: readonly string[],
): Promise<void> {
  let removed: number
  try {
    removed = remove()
  } catch (error) {
    invalidatePreparedSearches()
    throw error
  }
  // New paths have no old vectors to invalidate. Do not fence unrelated reads
  // merely because the scan discovered another file.
  const release = removed > 0 ? beginPreparedSearchMutation(keys) : () => {}
  try {
    await flush()
  } finally {
    release()
  }
}

onInteractiveSearchIdle(() => {
  if (!isInteractiveSearchActive() && !isVectorPreparationActive() && !mutations)
    changedPaths.clear()
})
