// ── Unified staged task scheduler (Phase 3, design 8.2) ──
// One main-process scheduler for the D1-D6 stage ladder. Two isolated lanes:
// - 'local': discovery (D1), metadata (D2), preview (D3), hash (D4) — native
//   scanning, SQLite and file operations;
// - 'gpu': embedding (D5), video deep indexing (D6) — GPU-heavy workers.
// The lanes have independent execution loops and concurrency budgets, so a
// saturated GPU lane can never block or starve D1 discovery (design 8.2
// constraint 1/2). Queued tasks are ordered by (priority, stage rank,
// enqueue sequence); setVisiblePaths bumps tasks touching the visible set to
// P0 so on-screen previews and embeddings are produced first (Phase 3 task 4).
// Pure module: no electron imports, so node --test can drive it directly.

import type {
  UnifiedSchedulerLaneStats,
  UnifiedSchedulerStats,
  UnifiedResourceProfile,
  UnifiedTaskLane,
  UnifiedTaskPriority,
  UnifiedTaskStage,
} from '../shared/ipc/unified-search'
import {
  UnifiedResourceGovernor,
  type UnifiedResourcePressureSnapshot,
  type UnifiedResourcePressureUpdateOptions,
} from './resourceGovernor'

const STAGE_RANK: Record<UnifiedTaskStage, number> = {
  discovery: 0,
  metadata: 1,
  preview: 2,
  hash: 3,
  embedding: 4,
  'video-deep': 5,
}

const GPU_STAGES = new Set<UnifiedTaskStage>(['embedding', 'video-deep'])

export function unifiedTaskLaneForStage(stage: UnifiedTaskStage): UnifiedTaskLane {
  return GPU_STAGES.has(stage) ? 'gpu' : 'local'
}

export interface UnifiedTaskRequest<T> {
  stage: UnifiedTaskStage
  priority?: UnifiedTaskPriority
  /** Paths this task works on; used by setVisiblePaths for P0 bumping. */
  paths?: readonly string[]
  label?: string
  run: () => Promise<T> | T
}

export interface UnifiedTaskHandle<T> {
  id: number
  promise: Promise<T>
}

interface QueuedTask {
  id: number
  seq: number
  lane: UnifiedTaskLane
  stage: UnifiedTaskStage
  priority: UnifiedTaskPriority
  pathKeys: string[]
  label?: string
  run: () => Promise<unknown> | unknown
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  cancelled: boolean
}

function normalizePathKey(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export interface UnifiedTaskSchedulerOptions {
  localConcurrency?: number
  gpuConcurrency?: number
  resourceProfile?: UnifiedResourceProfile
}

export class UnifiedTaskScheduler {
  private readonly concurrencyOverrides: Partial<Record<UnifiedTaskLane, number>>
  private readonly resourceGovernor: UnifiedResourceGovernor
  private readonly queues: Record<UnifiedTaskLane, QueuedTask[]> = { local: [], gpu: [] }
  private readonly runningCount: Record<UnifiedTaskLane, number> = { local: 0, gpu: 0 }
  private readonly counters: Record<UnifiedTaskLane, UnifiedSchedulerLaneStats> = {
    local: { running: 0, queued: 0, completed: 0, failed: 0, cancelled: 0 },
    gpu: { running: 0, queued: 0, completed: 0, failed: 0, cancelled: 0 },
  }
  private nextId = 1
  private nextSeq = 1
  private readonly tasks = new Map<number, QueuedTask>()

  constructor(options: UnifiedTaskSchedulerOptions = {}) {
    this.concurrencyOverrides = {
      ...(options.localConcurrency !== undefined
        ? { local: Math.max(1, Math.floor(options.localConcurrency)) }
        : {}),
      ...(options.gpuConcurrency !== undefined
        ? { gpu: Math.max(1, Math.floor(options.gpuConcurrency)) }
        : {}),
    }
    this.resourceGovernor = new UnifiedResourceGovernor(options.resourceProfile)
  }

  enqueue<T>(request: UnifiedTaskRequest<T>): UnifiedTaskHandle<T> {
    const id = this.nextId++
    const lane = unifiedTaskLaneForStage(request.stage)
    const priority = request.priority ?? defaultPriorityForStage(request.stage)
    if (this.totalQueued() >= this.resourceGovernor.maximumQueuedTasks()) {
      this.counters[lane].cancelled += 1
      this.resourceGovernor.recordPolicyCancellation(1)
      return {
        id,
        promise: Promise.reject(new Error('Unified task rejected by resource queue limit')),
      }
    }
    let resolvePromise!: (value: unknown) => void
    let rejectPromise!: (error: unknown) => void
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve as (value: unknown) => void
      rejectPromise = reject
    })
    const task: QueuedTask = {
      id,
      seq: this.nextSeq++,
      lane,
      stage: request.stage,
      priority,
      pathKeys: (request.paths ?? []).map(normalizePathKey),
      ...(request.label !== undefined ? { label: request.label } : {}),
      run: request.run as () => Promise<unknown> | unknown,
      resolve: resolvePromise,
      reject: rejectPromise,
      cancelled: false,
    }
    this.tasks.set(id, task)
    this.queues[lane].push(task)
    this.counters[lane].queued += 1
    this.sortQueue(lane)
    this.pump(lane)
    return { id, promise }
  }

  /** Cancel a still-queued task. Returns false when already running/done. */
  cancel(id: number): boolean {
    const task = this.tasks.get(id)
    if (!task || task.cancelled) return false
    const queue = this.queues[task.lane]
    const index = queue.indexOf(task)
    if (index === -1) return false
    queue.splice(index, 1)
    task.cancelled = true
    this.tasks.delete(id)
    this.counters[task.lane].queued -= 1
    this.counters[task.lane].cancelled += 1
    task.reject(new Error('Unified task cancelled'))
    return true
  }

  /**
   * Visible-region hint (Phase 3 task 4): queued tasks whose paths intersect
   * the visible set jump to P0 and resurface at the front of their lane.
   * Returns the number of tasks bumped.
   */
  setVisiblePaths(paths: readonly string[]): number {
    const visible = new Set(paths.map(normalizePathKey))
    if (visible.size === 0) return 0
    let bumped = 0
    for (const lane of ['local', 'gpu'] as const) {
      let laneBumped = false
      for (const task of this.queues[lane]) {
        if (task.priority === 0) continue
        if (task.pathKeys.some((key) => visible.has(key))) {
          task.priority = 0
          bumped += 1
          laneBumped = true
        }
      }
      if (laneBumped) this.sortQueue(lane)
    }
    return bumped
  }

  setResourceProfile(profile: UnifiedResourceProfile): UnifiedSchedulerStats {
    this.resourceGovernor.setProfile(profile)
    this.pump('local')
    this.pump('gpu')
    return this.stats()
  }

  updateResourcePressure(
    snapshot: UnifiedResourcePressureSnapshot,
    options?: UnifiedResourcePressureUpdateOptions,
  ): UnifiedSchedulerStats {
    this.resourceGovernor.updatePressure(snapshot, options)
    this.pump('local')
    this.pump('gpu')
    return this.stats()
  }

  cancelBackgroundTasks(): number {
    const ids = [...this.queues.local, ...this.queues.gpu]
      .filter((task) => task.priority >= 3)
      .map((task) => task.id)
    let cancelled = 0
    for (const id of ids) {
      if (this.cancel(id)) cancelled += 1
    }
    this.resourceGovernor.recordPolicyCancellation(cancelled)
    return cancelled
  }

  stats(): UnifiedSchedulerStats {
    return {
      lanes: {
        local: { ...this.counters.local },
        gpu: { ...this.counters.gpu },
      },
      resource: this.resourceGovernor.stats({
        local: this.laneConcurrency('local'),
        gpu: this.laneConcurrency('gpu'),
      }),
    }
  }

  private totalQueued(): number {
    return this.queues.local.length + this.queues.gpu.length
  }

  private laneConcurrency(lane: UnifiedTaskLane): number {
    const governed = this.resourceGovernor.effectiveConcurrency(lane)
    const configured = this.concurrencyOverrides[lane]
    return configured === undefined ? governed : Math.min(configured, governed)
  }

  private sortQueue(lane: UnifiedTaskLane): void {
    this.queues[lane].sort(
      (left, right) =>
        left.priority - right.priority ||
        STAGE_RANK[left.stage] - STAGE_RANK[right.stage] ||
        left.seq - right.seq,
    )
  }

  private pump(lane: UnifiedTaskLane): void {
    while (this.runningCount[lane] < this.laneConcurrency(lane) && this.queues[lane].length > 0) {
      const nextIndex = this.queues[lane].findIndex((task) =>
        this.resourceGovernor.canRun(task.priority),
      )
      if (nextIndex < 0) return
      const [task] = this.queues[lane].splice(nextIndex, 1)
      this.counters[lane].queued -= 1
      this.runningCount[lane] += 1
      this.counters[lane].running += 1
      void this.execute(lane, task)
    }
  }

  private async execute(lane: UnifiedTaskLane, task: QueuedTask): Promise<void> {
    try {
      const result = await task.run()
      this.tasks.delete(task.id)
      this.counters[lane].completed += 1
      task.resolve(result)
    } catch (error) {
      this.tasks.delete(task.id)
      this.counters[lane].failed += 1
      task.reject(error)
    } finally {
      this.runningCount[lane] -= 1
      this.counters[lane].running -= 1
      this.pump(lane)
    }
  }
}

function defaultPriorityForStage(stage: UnifiedTaskStage): UnifiedTaskPriority {
  // Design 8.2: discovery/metadata serve the current folder and search scope
  // (P1), preview/hash follow (P2), background embedding and video deep
  // indexing are P3 background work.
  switch (stage) {
    case 'discovery':
    case 'metadata':
      return 1
    case 'preview':
    case 'hash':
      return 2
    default:
      return 3
  }
}
