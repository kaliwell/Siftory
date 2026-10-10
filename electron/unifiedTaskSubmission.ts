import type { UnifiedTaskPriority, UnifiedTaskStage } from '../shared/ipc/unified-search'

export interface UnifiedTaskSubmitter {
  enqueue<T>(request: {
    stage: UnifiedTaskStage
    priority?: UnifiedTaskPriority
    paths?: readonly string[]
    label?: string
    run: () => Promise<T> | T
  }): { id: number; promise: Promise<T> }
  cancel?(id: number): boolean
}

/** Run directly outside the composed runtime, otherwise await the real staged task lifetime. */
export function submitUnifiedTask<T>(
  scheduler: UnifiedTaskSubmitter | undefined,
  request: {
    stage: UnifiedTaskStage
    priority?: UnifiedTaskPriority
    paths?: readonly string[]
    label?: string
    run: () => Promise<T> | T
  },
): Promise<T> {
  if (!scheduler) return Promise.resolve().then(request.run)
  return scheduler.enqueue(request).promise
}
