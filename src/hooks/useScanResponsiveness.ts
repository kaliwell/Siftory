import { useEffect } from 'react'

/** Samples outside React state; hidden windows do not count as stalled frames. */
function startSampler(): () => void {
  let started = performance.now()
  let tick = started
  let frame = started
  let maxTimerLagMs = 0
  let maxFrameGapMs = 0
  let longTaskCount = 0
  let longTaskMaxMs = 0
  let inFlight = false
  let frameId = 0
  let observer: PerformanceObserver | undefined
  const reset = () => {
    started = tick = frame = performance.now()
    maxTimerLagMs = maxFrameGapMs = longTaskCount = longTaskMaxMs = 0
  }
  const send = () => {
    const api = window.electronAPI?.imageSearch
    if (document.hidden || inFlight || !api?.reportScanResponsiveness) return
    const sample = {
      elapsedMs: performance.now() - started,
      maxTimerLagMs,
      maxFrameGapMs,
      longTaskCount,
      longTaskMaxMs,
    }
    reset()
    inFlight = true
    void api
      .reportScanResponsiveness(sample)
      .catch(() => {})
      .finally(() => {
        inFlight = false
      })
  }
  const onFrame = (now: number) => {
    if (!document.hidden) maxFrameGapMs = Math.max(maxFrameGapMs, now - frame)
    frame = now
    frameId = requestAnimationFrame(onFrame)
  }
  frameId = requestAnimationFrame(onFrame)
  const timer = setInterval(() => {
    const now = performance.now()
    if (!document.hidden) maxTimerLagMs = Math.max(maxTimerLagMs, now - tick - 200, 0)
    tick = now
    if (now - started >= 5000) send()
  }, 200)
  if (
    typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes.includes('longtask')
  ) {
    observer = new PerformanceObserver((list) => {
      if (document.hidden) return
      for (const entry of list.getEntries()) {
        // Discard delayed entries from a previous visibility/sample window.
        if (entry.startTime < started) continue
        longTaskCount++
        longTaskMaxMs = Math.max(longTaskMaxMs, entry.duration)
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  }
  document.addEventListener('visibilitychange', reset)
  document.addEventListener('siftory:flush-performance', send)
  return () => {
    send()
    clearInterval(timer)
    cancelAnimationFrame(frameId)
    observer?.disconnect()
    document.removeEventListener('visibilitychange', reset)
    document.removeEventListener('siftory:flush-performance', send)
  }
}

let manualRecording = false
let autoSubscribers = 0
let stopSampler: (() => void) | undefined
function syncSampler(): void {
  if ((manualRecording || autoSubscribers > 0) && !stopSampler) stopSampler = startSampler()
  else if (!manualRecording && autoSubscribers === 0 && stopSampler) {
    stopSampler()
    stopSampler = undefined
  }
}

// Manual test sampling survives navigation away from the scan page.
export function setManualPerformanceSampling(enabled: boolean): void {
  manualRecording = enabled
  syncSampler()
}

export function useScanResponsiveness(active: boolean): void {
  useEffect(() => {
    if (!active) return
    autoSubscribers++
    syncSampler()
    return () => {
      autoSubscribers--
      syncSampler()
    }
  }, [active])
}
