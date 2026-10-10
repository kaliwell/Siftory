import type { ProcessedImageDataResetResult } from '../shared/ipc-contract'
import type { UnifiedTaskSubmitter } from './unifiedTaskSubmission'

let activeAssetDerivedRebuilds = 0

export function waitForBoundedTerminal<T>(options: {
  label: string
  timeoutMs: number
  getCurrent: () => T
  isTerminal: (value: T) => boolean
  subscribe: (listener: (value: T) => void) => () => void
  cancel: () => unknown | Promise<unknown>
  signal?: AbortSignal
}): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(new Error(`${options.label} was cancelled`))
  const current = options.getCurrent()
  if (options.isTerminal(current)) return Promise.resolve(current)
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs))
    : 1
  return new Promise((resolve, reject) => {
    let settling = false
    let unsubscribe: () => void = () => undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => void stop(true)
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
      options.signal?.removeEventListener('abort', onAbort)
    }
    const stop = async (aborted: boolean) => {
      if (settling) return
      settling = true
      cleanup()
      try {
        await options.cancel()
      } catch {
        // Preserve the bounded wait error even when cooperative cancellation
        // itself reports a secondary failure.
      }
      reject(new Error(aborted ? `${options.label} was cancelled` : `${options.label} timed out`))
    }
    unsubscribe = options.subscribe((value) => {
      if (settling || !options.isTerminal(value)) return
      settling = true
      cleanup()
      resolve(value)
    })
    if (settling) return
    const afterSubscribe = options.getCurrent()
    if (options.isTerminal(afterSubscribe)) {
      settling = true
      cleanup()
      resolve(afterSubscribe)
      return
    }
    timer = setTimeout(() => void stop(false), timeoutMs)
    timer.unref?.()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
  })
}

export function waitForBoundedOperation<T>(options: {
  label: string
  timeoutMs: number
  operation: Promise<T>
  cancel: () => unknown | Promise<unknown>
  signal?: AbortSignal
}): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(new Error(`${options.label} was cancelled`))
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs))
    : 1
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      action()
    }
    const stop = async (aborted: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      try {
        await options.cancel()
      } catch {
        // Preserve the timeout/cancellation error when cooperative cancellation fails.
      }
      reject(new Error(aborted ? `${options.label} was cancelled` : `${options.label} timed out`))
    }
    const onAbort = () => void stop(true)
    const timer = setTimeout(() => void stop(false), timeoutMs)
    timer.unref?.()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    void options.operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
    if (options.signal?.aborted) onAbort()
  })
}

export function isAssetDerivedRebuildRunning(): boolean {
  return activeAssetDerivedRebuilds > 0
}

export function scheduleAssetDerivedRebuild(options: {
  scheduler: UnifiedTaskSubmitter
  assetId: string
  roots: string[]
  clear: () => Promise<ProcessedImageDataResetResult>
  rebuild: () => Promise<void>
  ensureReady?: () => string | null
  acquireMaintenance?: () => (() => void) | null
  onSettled?: (error?: unknown) => void
}): number {
  const notifySettled = (error?: unknown) => {
    try {
      options.onSettled?.(error)
    } catch {
      // Settlement observers must never turn a completed/failed rebuild into
      // an unhandled rejection or mask the scheduler's original failure.
    }
  }
  activeAssetDerivedRebuilds += 1
  let handle: ReturnType<UnifiedTaskSubmitter['enqueue']>
  try {
    handle = options.scheduler.enqueue({
      stage: 'metadata',
      priority: 0,
      paths: options.roots,
      label: `rebuild derived index for ${options.assetId}`,
      run: async () => {
        const busy = options.ensureReady?.()
        if (busy) throw new Error(busy)
        const releaseMaintenance = options.acquireMaintenance?.()
        if (options.acquireMaintenance && !releaseMaintenance) {
          throw new Error('Vector maintenance is running')
        }
        try {
          const cleared = await options.clear()
          if (!cleared.ok) throw new Error(cleared.error || 'Could not clear derived image data')
          await options.rebuild()
        } finally {
          releaseMaintenance?.()
        }
      },
    })
  } catch (error) {
    activeAssetDerivedRebuilds = Math.max(0, activeAssetDerivedRebuilds - 1)
    notifySettled(error)
    throw error
  }
  void handle.promise.then(
    () => {
      activeAssetDerivedRebuilds = Math.max(0, activeAssetDerivedRebuilds - 1)
      notifySettled()
    },
    (error) => {
      activeAssetDerivedRebuilds = Math.max(0, activeAssetDerivedRebuilds - 1)
      notifySettled(error)
    },
  )
  return handle.id
}
