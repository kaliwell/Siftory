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
export function invalidatePreparedSearches(): void {
  revision++
}
export function getPreparationSearchRevision(): number {
  return revision
}

let mutations = 0
export function isPreparedSearchMutationActive(): boolean {
  return mutations > 0
}
export function beginPreparedSearchMutation(): () => void {
  mutations++
  invalidatePreparedSearches()
  let released = false
  return () => {
    if (released) return
    released = true
    invalidatePreparedSearches()
    mutations--
  }
}

export function markPreparedSearchCommitted(): void {
  snapshotRequired = false
}

export async function invalidatePreparedInputs(
  remove: () => number,
  flush: () => Promise<unknown>,
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
  const release = removed > 0 ? beginPreparedSearchMutation() : () => {}
  try {
    await flush()
  } finally {
    release()
  }
}
