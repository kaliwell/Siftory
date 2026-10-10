import type { EmbeddingProgress } from '../shared/vectorTypes'
import { getSourceFileSyncMutationEpoch, isSourceFileSyncRunning } from './sourceFileSyncService'

let mediaFrameEmbeddingBuildActive = false

type FrameIndexBuilder = () => Promise<unknown>
type FrameIndexBuildScheduler = (run: () => void) => void

export function createCoalescedFrameIndexBuilder(
  build: FrameIndexBuilder,
  schedule: FrameIndexBuildScheduler,
  onError: (error: unknown) => void,
): { request: () => void; isPending: () => boolean } {
  let scheduledOrRunning = false
  let rebuildRequested = false

  const reportError = (error: unknown): void => {
    try {
      onError(error)
    } catch {
      // Error reporting must never strand the coalescing state machine.
    }
  }

  const drain = async () => {
    try {
      do {
        rebuildRequested = false
        try {
          await build()
        } catch (error) {
          reportError(error)
        }
      } while (rebuildRequested)
    } finally {
      scheduledOrRunning = false
    }
  }

  return {
    request: () => {
      rebuildRequested = true
      if (scheduledOrRunning) return
      scheduledOrRunning = true
      try {
        schedule(() => void drain())
      } catch (error) {
        rebuildRequested = false
        scheduledOrRunning = false
        reportError(error)
      }
    },
    isPending: () => scheduledOrRunning,
  }
}

let requestedFrameIndexEpoch = 0

const frameIndexBuilder = createCoalescedFrameIndexBuilder(
  async () => {
    const buildEpoch = requestedFrameIndexEpoch
    if (isSourceFileSyncRunning() || buildEpoch !== getSourceFileSyncMutationEpoch()) return
    const { buildFrameIndexAsync } = await import('./mediaSearchFrameIndex')
    if (isSourceFileSyncRunning() || buildEpoch !== getSourceFileSyncMutationEpoch()) return
    await buildFrameIndexAsync()
  },
  (run) => setTimeout(run, 250),
  (error) => console.error('[MediaSearch] frame index build failed', error),
)

export function markMediaFrameEmbeddingBuildActive(): void {
  mediaFrameEmbeddingBuildActive = true
}

export function clearMediaFrameEmbeddingBuildActive(): void {
  mediaFrameEmbeddingBuildActive = false
}

function queueMediaFrameIndexBuild(): void {
  requestedFrameIndexEpoch = getSourceFileSyncMutationEpoch()
  frameIndexBuilder.request()
}

export function isMediaFrameIndexBuildPending(): boolean {
  return mediaFrameEmbeddingBuildActive || frameIndexBuilder.isPending()
}

export function handleMediaFrameEmbeddingProgress(progress: EmbeddingProgress): void {
  if (mediaFrameEmbeddingBuildActive && progress.state === 'done') {
    mediaFrameEmbeddingBuildActive = false
    if (!isSourceFileSyncRunning()) queueMediaFrameIndexBuild()
  } else if (
    mediaFrameEmbeddingBuildActive &&
    (progress.state === 'error' || progress.state === 'stopping')
  ) {
    mediaFrameEmbeddingBuildActive = false
  }
}
