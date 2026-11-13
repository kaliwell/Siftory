// Progress may be dropped; lifecycle transitions must be delivered immediately.
export function createProgressCoalescer(deliver: () => void, intervalMs = 100) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let previousKey: string | undefined
  return (key?: string): void => {
    if (key !== undefined && key === previousKey) {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined
          deliver()
        }, intervalMs)
      return
    }
    clearTimeout(timer)
    timer = undefined
    previousKey = key
    deliver()
  }
}
