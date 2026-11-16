// A cooperative boundary: in-flight batches finish; new batches wait until
// all interactive queries have released. This is independent of user pause.
let readers = 0
const idleListeners = new Set<() => void>()

export function isInteractiveSearchActive(): boolean {
  return readers > 0
}

export function onInteractiveSearchIdle(listener: () => void): () => void {
  idleListeners.add(listener)
  return () => {
    idleListeners.delete(listener)
  }
}

export function reserveInteractiveSearch(): () => void {
  readers++
  let released = false
  return () => {
    if (released) return
    released = true
    readers--
    if (readers !== 0) return
    // Recheck after other queries in the same turn have acquired their lease.
    queueMicrotask(() => {
      if (readers !== 0) return
      for (const listener of idleListeners) listener()
    })
  }
}
