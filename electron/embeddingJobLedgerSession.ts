import type { EmbeddingJob } from '../shared/vectorTypes'
import {
  EMBEDDING_JOB_HEARTBEAT_INTERVAL_MS,
  EmbeddingJobEpochLedger,
  type EmbeddingJobLeaseToken,
} from './embeddingJobEpochLedger'
import { selectRetainedEmbeddingJobs } from './embeddingLogRetention'
import type { JsonLinesStore } from './vectorDatabaseService'

type DiagnosticWriter = (event: string, data?: Record<string, unknown>) => void

export class EmbeddingJobLedgerSession {
  current: EmbeddingJobEpochLedger | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly store: JsonLinesStore<EmbeddingJob>,
    private readonly writeDiagnostic: DiagnosticWriter,
  ) {}

  start(jobs: readonly EmbeddingJob[], owner: string): EmbeddingJobEpochLedger {
    this.stopHeartbeat()
    this.current = new EmbeddingJobEpochLedger(jobs, owner)
    return this.current
  }

  persist(reason: string, force = false): void {
    const ledger = this.current
    if (!ledger) return
    if (!force && this.store.getPersistenceStatus().pendingWrites > 0) {
      this.writeDiagnostic('jobs:persist-deferred', { reason, epoch: ledger.epoch })
      return
    }
    const snapshot = ledger.takeDirtySnapshot()
    if (!snapshot) return
    try {
      this.store.replaceAll(snapshot)
      void this.store.flush().catch((error: unknown) => {
        ledger.restoreDirty()
        this.writeDiagnostic('jobs:persist-error', {
          reason,
          epoch: ledger.epoch,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      this.writeDiagnostic('jobs:persist-snapshot', {
        reason,
        epoch: ledger.epoch,
        owner: ledger.owner,
        jobs: snapshot.length,
        active: ledger.activeCount(),
      })
    } catch (error: unknown) {
      ledger.restoreDirty()
      this.writeDiagnostic('jobs:persist-error', {
        reason,
        epoch: ledger.epoch,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  claim(jobId: number): EmbeddingJobLeaseToken | null {
    const claimed = this.current?.claim(jobId)
    if (!claimed?.epoch || !claimed.owner) return null
    this.ensureHeartbeat()
    return { epoch: claimed.epoch, owner: claimed.owner }
  }

  complete(jobId: number, lease: EmbeddingJobLeaseToken): void {
    this.current?.complete(jobId, lease)
  }

  fail(jobId: number, lease: EmbeddingJobLeaseToken, error: string): void {
    this.current?.fail(jobId, lease, error)
  }

  finish(reason: string, release: boolean): void {
    this.stopHeartbeat()
    const ledger = this.current
    if (!ledger) return
    if (release) ledger.release()
    ledger.replaceSnapshot(selectRetainedEmbeddingJobs(ledger.snapshot(), Date.now()))
    this.persist(reason, true)
    this.current = null
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer || !this.current) return
    this.heartbeatTimer = setInterval(() => {
      this.current?.heartbeat()
      this.persist('heartbeat')
    }, EMBEDDING_JOB_HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }
}
