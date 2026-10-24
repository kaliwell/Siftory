import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type {
  AutomaticMaintenanceConfig,
  AutomaticMaintenanceStatus,
  SourceFileSyncPreview,
  SourceFileSyncResult,
} from '../shared/ipc/source-derived-data'
import type { VectorGcPreview, VectorGcProgress } from '../shared/ipc/vector-maintenance'

export const AUTOMATIC_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000
export const AUTOMATIC_MISSING_GRACE_MS = 24 * 60 * 60 * 1000
const RETRY_MS = 60 * 60 * 1000
const key = (value: string) =>
  crypto.createHash('sha256').update(path.resolve(value).toLowerCase()).digest('hex')
type Observations = Record<string, Record<string, { first: number; last: number }>>

export interface AutomaticMaintenanceDependencies {
  now(): number
  isIdle(): boolean
  busyReason(): string | null
  acquire(): (() => void) | null
  flush(): Promise<void>
  preview(
    scope: string,
    eligible: (file: string) => boolean,
    cancelled: () => boolean,
  ): Promise<SourceFileSyncPreview>
  apply(token: string, cancelled: () => boolean): Promise<SourceFileSyncResult>
  gcPreview(cancelled: () => boolean): Promise<VectorGcPreview>
  gcStart(token: string): { ok: boolean; error?: string }
  gcProgress(): VectorGcProgress
  gcCancel(): void
  expireBackups(cancelled: () => boolean): Promise<number>
}

export function normalizeAutomaticMaintenanceConfig(raw: unknown): AutomaticMaintenanceConfig {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid automatic maintenance settings')
  const config = raw as AutomaticMaintenanceConfig
  if (
    typeof config.enabled !== 'boolean' ||
    !Array.isArray(config.scopes) ||
    config.scopes.length > 32
  )
    throw new Error('Invalid automatic maintenance settings')
  const scopes = [
    ...new Set(
      config.scopes.map((scope) => {
        if (
          typeof scope !== 'string' ||
          scope.length > 1024 ||
          /[\0\r\n]/.test(scope) ||
          !path.isAbsolute(scope)
        )
          throw new Error('Automatic maintenance requires absolute source folders')
        return path.resolve(scope)
      }),
    ),
  ]
  if (config.enabled && !scopes.length) throw new Error('Choose at least one source folder')
  return { enabled: config.enabled, scopes }
}

/** Opt-in idle worker. Never deletes source files; uses existing transactional sync and GC APIs. */
export class AutomaticMaintenanceService {
  private readonly file: string
  private observations: Observations = {}
  private status: AutomaticMaintenanceStatus = {
    config: { enabled: false, scopes: [] },
    phase: 'disabled',
    pendingMissing: 0,
    removedImages: 0,
    missingVideos: 0,
    recoveredBytes: 0,
    pendingReleaseBytes: 0,
  }
  private timer: ReturnType<typeof setInterval> | null = null
  private active: Promise<AutomaticMaintenanceStatus> | null = null
  private stopping = false
  private generation = 0

  constructor(
    userDataPath: string,
    private readonly deps: AutomaticMaintenanceDependencies,
  ) {
    this.file = path.join(userDataPath, 'automatic-index-maintenance.json')
    try {
      if (fs.existsSync(this.file)) {
        if (fs.statSync(this.file).size > 64 * 1024 * 1024)
          throw new Error('Maintenance state exceeds the size limit')
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        if (saved.version !== 1) throw new Error('Unsupported automatic maintenance state')
        const config = normalizeAutomaticMaintenanceConfig(saved.status?.config)
        const observations = saved.observations
        if (!observations || typeof observations !== 'object' || Array.isArray(observations))
          throw new Error('Invalid maintenance observations')
        for (const [scope, records] of Object.entries(observations)) {
          if (
            !/^[a-f0-9]{64}$/.test(scope) ||
            !records ||
            typeof records !== 'object' ||
            Array.isArray(records)
          )
            throw new Error('Invalid maintenance observations')
          for (const [file, value] of Object.entries(records)) {
            const entry = value as { first: number; last: number }
            if (
              !/^[a-f0-9]{64}$/.test(file) ||
              !entry ||
              !Number.isFinite(entry.first) ||
              !Number.isFinite(entry.last) ||
              entry.first < 0 ||
              entry.last < entry.first
            )
              throw new Error('Invalid maintenance observations')
          }
        }
        this.observations = observations
        const counter = (value: unknown) =>
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
        this.status = {
          ...this.status,
          config,
          phase: config.enabled ? 'waiting' : 'disabled',
          pendingMissing: counter(saved.status.pendingMissing),
          removedImages: counter(saved.status.removedImages),
          missingVideos: counter(saved.status.missingVideos),
          recoveredBytes: counter(saved.status.recoveredBytes),
          pendingReleaseBytes: counter(saved.status.pendingReleaseBytes),
          message:
            typeof saved.status.message === 'string'
              ? saved.status.message.slice(0, 4000)
              : undefined,
          lastCheckAt: Number.isFinite(saved.status.lastCheckAt)
            ? saved.status.lastCheckAt
            : undefined,
          nextCheckAt: Math.max(
            deps.now() + 120000,
            Number.isFinite(saved.status.nextCheckAt)
              ? Math.min(saved.status.nextCheckAt, deps.now() + AUTOMATIC_MAINTENANCE_INTERVAL_MS)
              : 0,
          ),
        }
      }
    } catch {
      this.status.message =
        'Automatic maintenance settings could not be verified. Configure them again.'
    }
  }

  getStatus(): AutomaticMaintenanceStatus {
    return structuredClone(this.status)
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(
        temp,
        JSON.stringify({ version: 1, status: this.status, observations: this.observations }),
        { flag: 'wx', mode: 0o600 },
      )
      fs.renameSync(temp, this.file)
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp)
    }
  }

  configure(raw: unknown): AutomaticMaintenanceStatus {
    const config = normalizeAutomaticMaintenanceConfig(raw)
    const previous = this.status
    this.status = {
      ...previous,
      config,
      phase: this.active ? previous.phase : config.enabled ? 'waiting' : 'disabled',
      message: undefined,
      nextCheckAt: config.enabled ? this.deps.now() + 120000 : undefined,
    }
    try {
      this.persist()
    } catch (error) {
      this.status = previous
      throw error
    }
    this.generation++
    return this.getStatus()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.run().catch(() => undefined)
    }, 60000)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.active?.catch(() => undefined)
  }

  run(manualCheck = false): Promise<AutomaticMaintenanceStatus> {
    if (this.active) return this.active
    this.active = this.perform(manualCheck).finally(() => {
      this.active = null
    })
    return this.active
  }

  private async perform(manualCheck: boolean): Promise<AutomaticMaintenanceStatus> {
    const deps = this.deps
    if (!this.status.config.enabled || this.stopping) return this.getStatus()
    if (!manualCheck && ((this.status.nextCheckAt ?? 0) > deps.now() || !deps.isIdle()))
      return this.getStatus()
    const busy = deps.busyReason()
    if (busy) {
      this.status.phase = 'waiting'
      this.status.message = busy
      return this.getStatus()
    }
    const release = deps.acquire()
    if (!release) {
      this.status.phase = 'waiting'
      this.status.message = 'Waiting for searches and indexing to finish'
      return this.getStatus()
    }
    const generation = this.generation
    const cancelled = () =>
      this.stopping ||
      generation !== this.generation ||
      !this.status.config.enabled ||
      (!manualCheck && !deps.isIdle())
    const issues: string[] = []
    let checked = 0
    this.status = {
      ...this.status,
      phase: 'checking',
      pendingMissing: 0,
      removedImages: 0,
      missingVideos: 0,
      recoveredBytes: 0,
      pendingReleaseBytes: 0,
      message: undefined,
    }
    try {
      await deps.flush()
      for (const scope of [...this.status.config.scopes]) {
        if (cancelled()) throw new Error('Automatic maintenance paused')
        const scopeKey = key(scope)
        const records = this.observations[scopeKey] ?? {}
        const seen = new Set<string>()
        const preview = await deps.preview(
          scope,
          (file) => {
            const fileKey = key(file),
              now = deps.now()
            seen.add(fileKey)
            const previous = records[fileKey]
            const first =
              previous &&
              previous.first <= now &&
              previous.last <= now &&
              now - previous.last <= 3 * AUTOMATIC_MAINTENANCE_INTERVAL_MS
                ? previous.first
                : now
            records[fileKey] = { first, last: now }
            return now - first >= AUTOMATIC_MISSING_GRACE_MS
          },
          cancelled,
        )
        if (cancelled()) throw new Error('Automatic maintenance paused')
        if (!preview.ok) {
          issues.push(`${scope}: ${preview.error || 'Source check failed'}`)
          continue
        }
        checked++
        this.observations[scopeKey] = Object.fromEntries(
          Object.entries(records).filter(([file]) => seen.has(file)),
        )
        this.status.pendingMissing += preview.pendingMissingRecords ?? 0
        this.persist() // Evidence must survive restart before any mutation can start.
        const missing = preview.missingImageRecords + preview.missingVideoRecords
        if (
          missing >
          Math.max(1000, (preview.checkedImageRecords + preview.checkedVideoRecords) * 0.2)
        ) {
          issues.push(`${scope}: Many files are missing. Review this source manually.`)
          continue
        }
        if (missing && preview.token) {
          this.status.phase = 'syncing'
          const result = await deps.apply(preview.token, cancelled)
          this.status.removedImages += result.imageRecordsRemoved
          this.status.missingVideos += result.videoRecordsMarkedMissing
          this.status.recoveredBytes += result.freedBytes
          if (!result.ok) throw new Error(result.error || 'Source synchronization failed')
          if (result.originalFilesAffected !== 0)
            throw new Error('Unexpected original file mutation')
        }
        this.status.phase = 'checking'
      }
      if (!checked) throw new Error(issues.join('\n') || 'No available source folders')
      if (cancelled()) throw new Error('Automatic maintenance paused')
      this.status.recoveredBytes += await deps.expireBackups(cancelled)
      const gc = await deps.gcPreview(cancelled)
      const bytes = gc.shards.reduce((sum, shard) => sum + shard.sourceBytes, 0)
      if (
        !cancelled() &&
        gc.activeAssetCount > 0 &&
        gc.shards.length > 0 &&
        gc.shards.every((shard) => shard.activeRecords > 0) &&
        gc.reclaimableBytes >= 64 * 1024 * 1024 &&
        gc.reclaimableBytes >= bytes * 0.1
      ) {
        this.status.phase = 'recycling'
        const job = deps.gcStart(gc.token)
        if (!job.ok) throw new Error(job.error || 'Could not start automatic vector recycling')
        let progress: VectorGcProgress
        do {
          if (cancelled()) deps.gcCancel()
          progress = deps.gcProgress()
          if (progress.state !== 'running') break
          await new Promise((resolve) => setTimeout(resolve, 500))
        } while (progress.state === 'running')
        if (progress.state !== 'completed')
          throw new Error(
            progress.state === 'cancelled'
              ? 'Automatic maintenance paused'
              : progress.errors.join('; ') || 'Vector recycling failed',
          )
        this.status.pendingReleaseBytes = progress.pendingReleaseBytes
      }
      this.status.lastCheckAt = deps.now()
      this.status.nextCheckAt = deps.now() + AUTOMATIC_MAINTENANCE_INTERVAL_MS
      this.status.phase = 'completed'
      this.status.message = issues.length ? issues.join('\n').slice(0, 4000) : undefined
      this.persist()
    } catch (error) {
      this.status.phase = cancelled() ? 'waiting' : 'error'
      this.status.message = error instanceof Error ? error.message : String(error)
      this.status.nextCheckAt = deps.now() + RETRY_MS
      this.persist()
    } finally {
      release()
      if (!this.status.config.enabled) this.status.phase = 'disabled'
    }
    return this.getStatus()
  }
}
