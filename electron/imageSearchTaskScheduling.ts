import type { ImageSearchStartScanArgs, ImageSearchStatus } from '../shared/ipc-contract'
import {
  failActiveImageSearchScan,
  finishQueuedImageSearchScan,
  getImageSearchStatus,
  isImageSearchScanLifecycleComplete,
  onImageSearchStatus,
  reserveImageSearchScan,
  startImageSearchScan,
  waitForImageSearchPersistence,
} from './imageSearchService'
import type { UnifiedTaskSubmitter } from './unifiedTaskSubmission'

interface ImageSearchTaskSchedulingDeps {
  reserve: (request: ImageSearchStartScanArgs) => ImageSearchStatus
  start: (
    request: ImageSearchStartScanArgs,
    options: { acceptQueuedReservation: true },
  ) => ImageSearchStatus
  getStatus: () => ImageSearchStatus
  onStatus: (listener: (status: ImageSearchStatus) => void) => () => void
  finishQueued: (error?: unknown) => boolean
  failActive: (error: unknown) => boolean
  isComplete: () => boolean
  waitForPersistence: () => Promise<void>
}

export function createImageSearchTaskScheduling(deps: ImageSearchTaskSchedulingDeps) {
  let nextReservationId = 1
  let activeReservationId: number | null = null
  let queuedTask: {
    id: number
    reservationId: number
    scheduler: UnifiedTaskSubmitter
  } | null = null

  const waitForTerminal = (): Promise<ImageSearchStatus> => {
    const current = deps.getStatus()
    if (deps.isComplete()) return Promise.resolve(current)
    return new Promise((resolve) => {
      let pendingCheck: ReturnType<typeof setTimeout> | null = null
      const unsubscribe = deps.onStatus(() => {
        if (pendingCheck) clearTimeout(pendingCheck)
        pendingCheck = setTimeout(() => {
          pendingCheck = null
          if (!deps.isComplete()) return
          unsubscribe()
          resolve(deps.getStatus())
        }, 0)
      })
    })
  }

  const queue = (
    request: ImageSearchStartScanArgs,
    scheduler: UnifiedTaskSubmitter,
  ): ImageSearchStatus => {
    const reserved = deps.reserve(request)
    if (reserved.state !== 'queued') return reserved
    const reservationId = nextReservationId++
    activeReservationId = reservationId
    let startedByScheduler = false
    const handle = scheduler.enqueue({
      stage: 'hash',
      priority: 1,
      paths: request.paths,
      label: 'image search composite preview/hash scan',
      run: async () => {
        startedByScheduler = true
        queuedTask = null
        if (activeReservationId !== reservationId || deps.getStatus().state !== 'queued') {
          return
        }
        const started = deps.start(request, { acceptQueuedReservation: true })
        if (started.state === 'error') throw new Error(started.lastError || 'Image scan failed')
        const terminal = await waitForTerminal()
        await deps.waitForPersistence()
        if (terminal.state === 'error') throw new Error(terminal.lastError || 'Image scan failed')
      },
    })
    if (!startedByScheduler) queuedTask = { id: handle.id, reservationId, scheduler }
    void handle.promise
      .catch((error) => {
        if (activeReservationId === reservationId && !deps.finishQueued(error)) {
          deps.failActive(error)
        }
      })
      .finally(() => {
        if (activeReservationId === reservationId) activeReservationId = null
      })
    return reserved
  }

  const cancelQueued = (): boolean => {
    if (
      !queuedTask ||
      activeReservationId !== queuedTask.reservationId ||
      deps.getStatus().state !== 'queued'
    ) {
      return false
    }
    if (!queuedTask.scheduler.cancel?.(queuedTask.id)) return false
    queuedTask = null
    deps.finishQueued()
    return true
  }

  return { queue, cancelQueued }
}

const runtimeScheduling = createImageSearchTaskScheduling({
  reserve: reserveImageSearchScan,
  start: startImageSearchScan,
  getStatus: getImageSearchStatus,
  onStatus: onImageSearchStatus,
  finishQueued: finishQueuedImageSearchScan,
  failActive: failActiveImageSearchScan,
  isComplete: isImageSearchScanLifecycleComplete,
  waitForPersistence: waitForImageSearchPersistence,
})

export const queueImageSearchScan = runtimeScheduling.queue
export const cancelQueuedImageSearchScan = runtimeScheduling.cancelQueued
