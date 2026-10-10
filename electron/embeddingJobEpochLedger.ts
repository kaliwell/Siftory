import type { EmbeddingJob, EmbeddingType } from '../shared/vectorTypes'
import { embeddingCachePathKey } from './embeddingF16Cache'

export const EMBEDDING_JOB_HEARTBEAT_INTERVAL_MS = 10_000
export const EMBEDDING_JOB_LEASE_TIMEOUT_MS = 45_000

export interface EmbeddingJobEpochLedgerOptions {
  now?: number
  leaseTimeoutMs?: number
}

export interface EmbeddingJobLeaseToken {
  epoch: number
  owner: string
}

function finiteEpoch(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

export function nextEmbeddingJobEpoch(jobs: readonly EmbeddingJob[], floor = 0): number {
  const next = jobs.reduce((highest, job) => Math.max(highest, finiteEpoch(job.epoch)), 0) + 1
  return Math.max(next, finiteEpoch(floor))
}

export function hasLiveEmbeddingJobLease(
  job: EmbeddingJob,
  now = Date.now(),
  leaseTimeoutMs = EMBEDDING_JOB_LEASE_TIMEOUT_MS,
): boolean {
  return (
    (job.status === 'pending' || job.status === 'running') &&
    typeof job.owner === 'string' &&
    job.owner.length > 0 &&
    typeof job.heartbeatAt === 'number' &&
    Number.isFinite(job.heartbeatAt) &&
    job.heartbeatAt <= now &&
    now - job.heartbeatAt < leaseTimeoutMs
  )
}

function clearLease(job: EmbeddingJob): void {
  delete job.owner
  delete job.heartbeatAt
  delete job.startedAt
}

/**
 * In-memory state machine for one embedding build.
 *
 * The caller persists snapshots at heartbeat boundaries and at shutdown. A
 * persisted epoch/owner pair fences late results from a previous build, while
 * an expired heartbeat makes interrupted running work retryable after restart.
 */
export class EmbeddingJobEpochLedger {
  readonly epoch: number
  readonly owner: string
  readonly leaseTimeoutMs: number

  private jobs: EmbeddingJob[]
  private readonly byId = new Map<number, EmbeddingJob>()
  private readonly activeIds = new Set<number>()
  private readonly observedAt: number
  private dirty = false

  constructor(
    jobs: readonly EmbeddingJob[],
    owner: string,
    options: EmbeddingJobEpochLedgerOptions = {},
  ) {
    if (!owner) throw new Error('Embedding job epoch owner is required')
    const now = options.now ?? Date.now()
    this.observedAt = now
    this.owner = owner
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? EMBEDDING_JOB_LEASE_TIMEOUT_MS
    this.jobs = jobs.map((job) => ({ ...job }))
    this.epoch = nextEmbeddingJobEpoch(this.jobs, now)
    this.reindex()
    this.recoverExpiredLeases(now)
  }

  private reindex(): void {
    this.byId.clear()
    for (const job of this.jobs) {
      if (typeof job.id === 'number' && Number.isSafeInteger(job.id)) this.byId.set(job.id, job)
    }
  }

  private recoverExpiredLeases(now: number): number {
    let recovered = 0
    for (const job of this.jobs) {
      if (job.status !== 'running' && !(job.status === 'pending' && job.owner)) continue
      if (hasLiveEmbeddingJobLease(job, now, this.leaseTimeoutMs)) continue
      job.status = 'pending'
      job.epoch = this.epoch
      job.updatedAt = now
      delete job.error
      clearLease(job)
      recovered++
    }
    if (recovered > 0) this.dirty = true
    return recovered
  }

  add(jobs: readonly EmbeddingJob[]): void {
    for (const source of jobs) {
      const job = { ...source }
      this.jobs.push(job)
      if (typeof job.id === 'number' && Number.isSafeInteger(job.id)) this.byId.set(job.id, job)
    }
    if (jobs.length > 0) this.dirty = true
  }

  addPending(
    jobs: readonly Omit<EmbeddingJob, 'id' | 'status' | 'epoch' | 'owner' | 'heartbeatAt'>[],
  ): EmbeddingJob[] {
    let nextId =
      this.jobs.reduce(
        (highest, job) => Math.max(highest, typeof job.id === 'number' ? job.id : 0),
        0,
      ) + 1
    const added = jobs.map((source) => ({
      ...source,
      id: nextId++,
      status: 'pending' as const,
      epoch: this.epoch,
    }))
    this.add(added)
    return added.map((job) => ({ ...job }))
  }

  listRunnable(
    modelName: string,
    embeddingType: EmbeddingType,
    imageIds?: ReadonlySet<string>,
  ): EmbeddingJob[] {
    const imageKeys = imageIds
      ? new Set([...imageIds].map((imageId) => embeddingCachePathKey(imageId)))
      : undefined
    return this.jobs
      .filter(
        (job) =>
          job.modelName === modelName &&
          job.embeddingType === embeddingType &&
          (job.status === 'pending' || job.status === 'failed') &&
          !hasLiveEmbeddingJobLease(job, this.observedAt, this.leaseTimeoutMs) &&
          (!imageKeys || imageKeys.has(embeddingCachePathKey(job.imageId))),
      )
      .map((job) => ({ ...job }))
  }

  listMatching(
    modelName: string,
    embeddingType: EmbeddingType,
    imageIds: ReadonlySet<string>,
  ): EmbeddingJob[] {
    const imageKeys = new Set([...imageIds].map((imageId) => embeddingCachePathKey(imageId)))
    return this.jobs
      .filter(
        (job) =>
          job.modelName === modelName &&
          job.embeddingType === embeddingType &&
          imageKeys.has(embeddingCachePathKey(job.imageId)),
      )
      .map((job) => ({ ...job }))
  }

  reconcileExisting(
    existingImageIds: ReadonlySet<string>,
    modelName: string,
    embeddingType: EmbeddingType,
    now = Date.now(),
  ): number {
    const existingKeys = new Set(
      [...existingImageIds].map((imageId) => embeddingCachePathKey(imageId)),
    )
    let reconciled = 0
    for (const job of this.jobs) {
      if (
        job.modelName !== modelName ||
        job.embeddingType !== embeddingType ||
        !existingKeys.has(embeddingCachePathKey(job.imageId)) ||
        hasLiveEmbeddingJobLease(job, now, this.leaseTimeoutMs) ||
        (job.status !== 'pending' && job.status !== 'running' && job.status !== 'failed')
      ) {
        continue
      }
      job.status = 'completed'
      job.epoch = this.epoch
      job.finishedAt = now
      job.updatedAt = now
      delete job.error
      clearLease(job)
      if (job.id !== undefined) this.activeIds.delete(job.id)
      reconciled++
    }
    if (reconciled > 0) this.dirty = true
    return reconciled
  }

  claim(id: number, now = Date.now()): EmbeddingJob | null {
    const job = this.byId.get(id)
    if (!job || (job.status !== 'pending' && job.status !== 'failed')) return null
    if (hasLiveEmbeddingJobLease(job, now, this.leaseTimeoutMs)) return null
    job.status = 'running'
    job.epoch = this.epoch
    job.owner = this.owner
    job.heartbeatAt = now
    job.startedAt = now
    job.updatedAt = now
    delete job.finishedAt
    delete job.error
    this.activeIds.add(id)
    this.dirty = true
    return { ...job }
  }

  heartbeat(now = Date.now()): number {
    let refreshed = 0
    for (const id of [...this.activeIds]) {
      const job = this.byId.get(id)
      if (!this.owns(job)) {
        this.activeIds.delete(id)
        continue
      }
      job!.heartbeatAt = now
      job!.updatedAt = now
      refreshed++
    }
    if (refreshed > 0) this.dirty = true
    return refreshed
  }

  complete(id: number, token: EmbeddingJobLeaseToken, now = Date.now()): boolean {
    const job = this.byId.get(id)
    if (!this.owns(job, token)) return false
    job!.status = 'completed'
    job!.heartbeatAt = now
    job!.finishedAt = now
    job!.updatedAt = now
    delete job!.error
    this.activeIds.delete(id)
    this.dirty = true
    return true
  }

  fail(id: number, token: EmbeddingJobLeaseToken, error: string, now = Date.now()): boolean {
    const job = this.byId.get(id)
    if (!this.owns(job, token)) return false
    job!.status = 'failed'
    job!.heartbeatAt = now
    job!.finishedAt = now
    job!.updatedAt = now
    job!.error = error
    job!.retries = Math.max(0, Number(job!.retries) || 0) + 1
    this.activeIds.delete(id)
    this.dirty = true
    return true
  }

  skip(id: number, reason: string, now = Date.now()): boolean {
    const job = this.byId.get(id)
    if (!job || hasLiveEmbeddingJobLease(job, now, this.leaseTimeoutMs)) return false
    if (job.status !== 'pending' && job.status !== 'failed') return false
    job.status = 'skipped'
    job.epoch = this.epoch
    job.finishedAt = now
    job.updatedAt = now
    job.error = reason
    clearLease(job)
    this.activeIds.delete(id)
    this.dirty = true
    return true
  }

  release(now = Date.now()): number {
    let released = 0
    for (const id of [...this.activeIds]) {
      const job = this.byId.get(id)
      if (!this.owns(job)) continue
      job!.status = 'pending'
      job!.updatedAt = now
      clearLease(job!)
      released++
    }
    this.activeIds.clear()
    if (released > 0) this.dirty = true
    return released
  }

  replaceSnapshot(jobs: readonly EmbeddingJob[]): void {
    this.jobs = jobs.map((job) => ({ ...job }))
    this.activeIds.clear()
    this.reindex()
    this.dirty = true
  }

  snapshot(): EmbeddingJob[] {
    return this.jobs.map((job) => ({ ...job }))
  }

  takeDirtySnapshot(): EmbeddingJob[] | null {
    if (!this.dirty) return null
    this.dirty = false
    return this.snapshot()
  }

  restoreDirty(): void {
    this.dirty = true
  }

  activeCount(): number {
    return this.activeIds.size
  }

  size(): number {
    return this.jobs.length
  }

  private owns(
    job: EmbeddingJob | undefined,
    token: EmbeddingJobLeaseToken = { epoch: this.epoch, owner: this.owner },
  ): boolean {
    return Boolean(
      job &&
      job.status === 'running' &&
      job.epoch === token.epoch &&
      job.owner === token.owner &&
      token.epoch === this.epoch &&
      token.owner === this.owner,
    )
  }
}
