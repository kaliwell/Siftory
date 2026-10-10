import type {
  AssetLibraryMutationResult,
  AssetLibraryTaskProgress,
  AssetLibraryTaskResult,
  AssetLibraryTaskType,
} from '../shared/ipc/asset-library'

export type AssetLibraryProgressListener = (progress: AssetLibraryTaskProgress) => void

export interface AssetLibraryRunningTask {
  id: string
  cancelled: boolean
}

interface TaskRateSample {
  taskId: string
  current: number
  total: number
  sampledAt: number
  ratePerMs: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function taskPercent(current: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0
}

export class AssetLibraryTaskController {
  private progressListener: AssetLibraryProgressListener | null = null
  private activeTask: AssetLibraryRunningTask | null = null
  private taskProgress: AssetLibraryTaskProgress | null = null
  private pendingMutations = 0
  private mutationQueue: Promise<void> = Promise.resolve()
  private taskRateSample: TaskRateSample | null = null

  setProgressListener(listener: AssetLibraryProgressListener | null): void {
    this.progressListener = listener
  }

  hasActiveTask(): boolean {
    return this.activeTask !== null
  }

  hasPendingMutations(): boolean {
    return this.pendingMutations > 0
  }

  publishProgress(patch: Partial<AssetLibraryTaskProgress>): void {
    if (!this.taskProgress) return
    const updatedAt = Date.now()
    const next = { ...this.taskProgress, ...patch, updatedAt }
    if (
      next.state === 'running' &&
      Number.isFinite(next.current) &&
      Number.isFinite(next.total) &&
      next.current >= 0 &&
      next.total > next.current
    ) {
      if (
        !this.taskRateSample ||
        this.taskRateSample.taskId !== next.taskId ||
        this.taskRateSample.total !== next.total ||
        next.current < this.taskRateSample.current
      ) {
        this.taskRateSample = {
          taskId: next.taskId,
          current: next.current,
          total: next.total,
          sampledAt: updatedAt,
          ratePerMs: 0,
        }
        delete next.etaMs
      } else {
        const elapsed = updatedAt - this.taskRateSample.sampledAt
        const advanced = next.current - this.taskRateSample.current
        if (elapsed >= 100 && advanced > 0) {
          const instantRate = advanced / elapsed
          const ratePerMs =
            this.taskRateSample.ratePerMs > 0
              ? this.taskRateSample.ratePerMs * 0.7 + instantRate * 0.3
              : instantRate
          this.taskRateSample = {
            taskId: next.taskId,
            current: next.current,
            total: next.total,
            sampledAt: updatedAt,
            ratePerMs,
          }
          next.etaMs = Math.max(0, Math.round((next.total - next.current) / ratePerMs))
        }
      }
    } else if (patch.state || patch.current !== undefined || patch.total !== undefined) {
      delete next.etaMs
    }
    this.taskProgress = next
    this.progressListener?.({ ...this.taskProgress })
  }

  startTask(
    type: AssetLibraryTaskType,
    runner: (task: AssetLibraryRunningTask) => Promise<string>,
  ): AssetLibraryTaskResult {
    if (this.activeTask) return { ok: false, error: `Another asset library task is running` }
    if (this.pendingMutations > 0) {
      return { ok: false, error: 'Asset library changes are still being saved' }
    }
    const task = {
      id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      cancelled: false,
    }
    this.activeTask = task
    this.taskRateSample = null
    this.taskProgress = {
      taskId: task.id,
      type,
      state: 'running',
      current: 0,
      total: 0,
      percent: 0,
      message: 'Starting...',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.progressListener?.({ ...this.taskProgress })
    void runner(task)
      .then((message) => {
        this.publishProgress({
          state: task.cancelled ? 'stopped' : 'done',
          percent: task.cancelled ? this.taskProgress?.percent || 0 : 100,
          message,
        })
      })
      .catch((error: unknown) => {
        const message = errorMessage(error)
        this.publishProgress({
          state: task.cancelled || /cancelled/i.test(message) ? 'stopped' : 'error',
          message,
          error: message,
        })
      })
      .finally(() => {
        this.activeTask = null
        this.taskRateSample = null
      })
    return { ok: true, taskId: task.id }
  }

  runMutation<T>(runner: () => Promise<T> | T): Promise<T> {
    if (this.activeTask) {
      return Promise.reject(
        new Error('Wait for the active asset library task to finish or stop it'),
      )
    }
    this.pendingMutations += 1
    const operation = this.mutationQueue
      .catch(() => {})
      .then(async () => {
        if (this.activeTask) {
          throw new Error('Wait for the active asset library task to finish or stop it')
        }
        return runner()
      })
    const tracked = operation.finally(() => {
      this.pendingMutations = Math.max(0, this.pendingMutations - 1)
    })
    this.mutationQueue = tracked.then(
      () => undefined,
      () => undefined,
    )
    return tracked
  }

  stopTask(taskId?: string, cancelActiveWorker?: () => void): AssetLibraryMutationResult {
    if (!this.activeTask || (taskId && taskId !== this.activeTask.id)) {
      return { ok: false, error: 'No matching asset library task is running' }
    }
    this.activeTask.cancelled = true
    cancelActiveWorker?.()
    this.publishProgress({ message: 'Stopping...' })
    return { ok: true }
  }

  getProgress(taskId?: string): AssetLibraryTaskProgress | null {
    if (!this.taskProgress || (taskId && taskId !== this.taskProgress.taskId)) return null
    return { ...this.taskProgress }
  }
}
