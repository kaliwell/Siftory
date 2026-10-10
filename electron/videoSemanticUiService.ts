import {
  VIDEO_SEMANTIC_PROFILES,
  isVideoSemanticProfileId,
  type VideoSemanticProfileId,
  type VideoSemanticRuntimeStatus,
} from '../shared/videoSemantic'
import type { VideoSemanticControlResult, VideoSemanticUiStatus } from '../shared/ipc/media-search'
import { VideoSemanticDatabase } from './videoSemanticDatabase'
import { VideoSemanticJobService } from './videoSemanticJobService'

export type VideoSemanticRuntimeStatusProvider = () =>
  | Promise<VideoSemanticRuntimeStatus>
  | VideoSemanticRuntimeStatus

export type VideoSemanticBuildStarter = (
  videoId: string,
) => Promise<VideoSemanticControlResult> | VideoSemanticControlResult
export type VideoSemanticResumeStarter = (
  jobId: string,
) => Promise<VideoSemanticControlResult> | VideoSemanticControlResult

const NOT_INSTALLED: VideoSemanticRuntimeStatus = {
  adapterId: 'none',
  state: 'not-installed',
  reason: 'model-missing',
}
const RUNTIME_STATUS_CACHE_MS = 30_000

function safeId(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || /[\r\n\0]/.test(normalized)) {
    throw new Error('Invalid video semantic identifier')
  }
  return normalized
}

export class VideoSemanticUiService {
  private runtimeStatusCache: { value: VideoSemanticRuntimeStatus; expiresAt: number } | null = null
  private runtimeStatusInFlight: Promise<VideoSemanticRuntimeStatus> | null = null

  constructor(
    private readonly database: VideoSemanticDatabase,
    private readonly jobs: VideoSemanticJobService,
    private readonly runtimeStatus: VideoSemanticRuntimeStatusProvider = () => NOT_INSTALLED,
    private readonly buildStarter?: VideoSemanticBuildStarter,
    private readonly resumeStarter?: VideoSemanticResumeStarter,
  ) {}

  hasActiveJob(): boolean {
    return this.database.listJobs().some((job) => job.state === 'running' || job.state === 'queued')
  }

  private async inspectRuntime(forceRefresh = false): Promise<VideoSemanticRuntimeStatus> {
    const now = Date.now()
    if (!forceRefresh && this.runtimeStatusCache && this.runtimeStatusCache.expiresAt > now) {
      return this.runtimeStatusCache.value
    }
    if (this.runtimeStatusInFlight) return this.runtimeStatusInFlight
    const request = Promise.resolve(this.runtimeStatus()).then((value) => {
      this.runtimeStatusCache = {
        value,
        expiresAt: Date.now() + RUNTIME_STATUS_CACHE_MS,
      }
      return value
    })
    this.runtimeStatusInFlight = request
    try {
      return await request
    } finally {
      if (this.runtimeStatusInFlight === request) this.runtimeStatusInFlight = null
    }
  }

  async getStatus(videoId?: string, forceRuntimeRefresh = false): Promise<VideoSemanticUiStatus> {
    const selectedVideoId = videoId ? safeId(videoId) : undefined
    const runtime = await this.inspectRuntime(forceRuntimeRefresh)
    const stats = this.database.stats()
    const jobs = this.database.listJobs(selectedVideoId).map((job) => ({
      jobId: job.jobId,
      videoId: job.videoId,
      generationId: job.generationId,
      profileId: job.profileId,
      state: job.state,
      completedSegments: job.completedSegments,
      failedSegments: job.failedSegments,
      totalSegments: job.segments.length,
      ...(job.currentSegmentId ? { currentSegmentId: job.currentSegmentId } : {}),
      ...(job.lastError ? { lastError: job.lastError } : {}),
      updatedAt: job.updatedAt,
    }))
    const latest = [...jobs].sort((left, right) => right.updatedAt - left.updatedAt)[0]
    const active = jobs.find((job) => job.state === 'running' || job.state === 'queued')
    const resumable = jobs.find((job) => job.state === 'paused' || job.state === 'stopped')
    const activeSegments = selectedVideoId
      ? this.database.getActiveSegments(selectedVideoId).length
      : stats.segments
    return {
      runtime,
      indexState: stats.activeVideos > 0 ? 'ready' : 'index-stale',
      activeVideos: stats.activeVideos,
      activeSegments,
      ...(selectedVideoId ? { selectedVideoId } : {}),
      ...(selectedVideoId && this.database.getActiveGenerationId(selectedVideoId)
        ? { activeGenerationId: this.database.getActiveGenerationId(selectedVideoId)! }
        : {}),
      profileOverride: selectedVideoId
        ? (this.database.getVideoProfileOverride(selectedVideoId) as
            | VideoSemanticProfileId
            | 'auto')
        : 'auto',
      profiles: Object.values(VIDEO_SEMANTIC_PROFILES).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
      })),
      jobs: latest ? jobs : [],
      canBuild: Boolean(
        selectedVideoId && runtime.state === 'ready' && !active && this.buildStarter,
      ),
      canStop: Boolean(active),
      canResume: Boolean(resumable && !active),
      updatedAt: Date.now(),
    }
  }

  async setProfile(
    videoId: string,
    profileId: VideoSemanticProfileId | 'auto',
  ): Promise<VideoSemanticControlResult> {
    const safeVideoId = safeId(videoId)
    if (profileId !== 'auto' && !isVideoSemanticProfileId(profileId)) {
      return { ok: false, error: 'Invalid video semantic profile' }
    }
    this.database.setVideoProfileOverride(safeVideoId, profileId)
    return { ok: true, status: await this.getStatus(safeVideoId) }
  }

  async start(videoId: string): Promise<VideoSemanticControlResult> {
    const status = await this.getStatus(safeId(videoId), true)
    if (status.runtime.state !== 'ready') {
      return { ok: false, status, error: status.runtime.reason || 'model-missing' }
    }
    if (!this.buildStarter) {
      return { ok: false, status, error: 'video-semantic-evidence-planner-not-ready' }
    }
    return await this.buildStarter(status.selectedVideoId!)
  }

  async stop(jobId: string): Promise<VideoSemanticControlResult> {
    const job = this.jobs.requestStop(safeId(jobId))
    return { ok: true, status: await this.getStatus(job.videoId) }
  }

  async resume(jobId: string): Promise<VideoSemanticControlResult> {
    const job = this.jobs.resumeJob(safeId(jobId))
    const status = await this.getStatus(job.videoId, true)
    if (status.runtime.state !== 'ready') {
      this.jobs.pauseJob(job.jobId, status.runtime.reason || 'model-missing')
      return {
        ok: false,
        status: await this.getStatus(job.videoId),
        error: status.runtime.reason || 'model-missing',
      }
    }
    if (this.resumeStarter) {
      try {
        const result = await this.resumeStarter(job.jobId)
        if (result.ok) return result
        const error = result.error || 'video-semantic-resume-start-failed'
        const current = this.jobs.getJob(job.jobId)
        if (current && (current.state === 'queued' || current.state === 'running')) {
          this.jobs.pauseJob(job.jobId, error)
        }
        return { ...result, status: await this.getStatus(job.videoId), error }
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause)
        const current = this.jobs.getJob(job.jobId)
        if (current && (current.state === 'queued' || current.state === 'running')) {
          this.jobs.pauseJob(job.jobId, error)
        }
        return { ok: false, status: await this.getStatus(job.videoId), error }
      }
    }
    const error = 'video-semantic-resume-planner-not-ready'
    this.jobs.pauseJob(job.jobId, error)
    return { ok: false, status: await this.getStatus(job.videoId), error }
  }
}
