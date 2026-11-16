let active = false
let preparations = 0
export function setVectorPreparationActive(value: boolean): void {
  active = value
}
export function isVectorPreparationActive(): boolean {
  return active || preparations > 0
}

export function beginSearchablePreparation(): () => void {
  preparations++
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
