import crypto from 'crypto'
import {
  VIDEO_SEMANTIC_PROFILE_IDS,
  isVideoSemanticProfileId,
  type VideoSemanticJobRecord,
  type VideoSemanticPlannedSegment,
  type VideoSemanticProfileId,
} from '../shared/videoSemantic'
import { VideoSemanticDatabase } from './videoSemanticDatabase'

const FRAME_ID_PATTERN = /^[a-f0-9]{40}$/i
const MAX_SEGMENTS_PER_JOB = 10_800
const MAX_ATTEMPTS_PER_SEGMENT = 3

export interface CreateVideoSemanticJobInput {
  assetId: string
  videoId: string
  generationId: string
  profileId: VideoSemanticProfileId
  segments: readonly VideoSemanticPlannedSegment[]
  now?: number
}

export interface VideoSemanticSegmentAttempt {
  jobId: string
  attempt: number
  maxAttempts: number
  reducedEvidence: boolean
  segment: VideoSemanticPlannedSegment
}

export type VideoSemanticSegmentProcessor = (
  attempt: VideoSemanticSegmentAttempt,
) => Promise<void> | void

function requiredId(value: string, label: string): string {
  const normalized = value.trim()
  if (
    !normalized ||
    normalized.length > 256 ||
    /[\r\n]/.test(normalized) ||
    normalized.includes('\0')
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return normalized
}

function normalizePlanSegment(raw: VideoSemanticPlannedSegment): VideoSemanticPlannedSegment {
  const segmentId = requiredId(raw.segmentId, 'segment id')
  if (
    !Number.isSafeInteger(raw.startMs) ||
    !Number.isSafeInteger(raw.endMs) ||
    raw.startMs < 0 ||
    raw.endMs <= raw.startMs ||
    raw.endMs > 7 * 24 * 60 * 60 * 1000
  ) {
    throw new Error('Invalid planned segment range')
  }
  const evidenceFrameIds = [...new Set(raw.evidenceFrameIds)].filter((frameId) =>
    FRAME_ID_PATTERN.test(frameId),
  )
  if (evidenceFrameIds.length === 0 || evidenceFrameIds.length > 16) {
    throw new Error('Invalid planned segment evidence frames')
  }
  return {
    segmentId,
    startMs: raw.startMs,
    endMs: raw.endMs,
    evidenceFrameIds,
    evidenceFrameDigest: requiredId(raw.evidenceFrameDigest, 'evidence frame digest'),
  }
}

function canonicalPlan(segments: readonly VideoSemanticPlannedSegment[]): string {
  return JSON.stringify(
    segments.map((segment) => ({
      segmentId: segment.segmentId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      evidenceFrameIds: segment.evidenceFrameIds,
      evidenceFrameDigest: segment.evidenceFrameDigest,
    })),
  )
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function limitVideoSemanticSegmentEvidence(
  segment: VideoSemanticPlannedSegment,
  maximum: number,
): VideoSemanticPlannedSegment {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error('Invalid video semantic evidence limit')
  }
  if (segment.evidenceFrameIds.length <= maximum) return segment
  const reduced = Array.from({ length: maximum }, (_, index) => {
    const sourceIndex = Math.round(
      (index * (segment.evidenceFrameIds.length - 1)) / Math.max(1, maximum - 1),
    )
    return segment.evidenceFrameIds[sourceIndex]
  })
  return {
    ...segment,
    evidenceFrameIds: reduced,
    evidenceFrameDigest: digest(JSON.stringify(reduced)),
  }
}

function attemptSegment(
  segment: VideoSemanticPlannedSegment,
  attempt: number,
): VideoSemanticPlannedSegment {
  if (attempt <= 1 || segment.evidenceFrameIds.length <= 1) return segment
  const maximum = attempt >= MAX_ATTEMPTS_PER_SEGMENT ? 2 : 4
  return limitVideoSemanticSegmentEvidence(segment, maximum)
}

export class VideoSemanticJobService {
  constructor(private readonly database: VideoSemanticDatabase) {}

  createJob(input: CreateVideoSemanticJobInput): VideoSemanticJobRecord {
    const assetId = requiredId(input.assetId, 'asset id')
    const videoId = requiredId(input.videoId, 'video id')
    const generationId = requiredId(input.generationId, 'generation id')
    if (!isVideoSemanticProfileId(input.profileId))
      throw new Error('Invalid video semantic profile')
    if (input.segments.length === 0 || input.segments.length > MAX_SEGMENTS_PER_JOB) {
      throw new Error('Invalid video semantic segment plan size')
    }
    const segments = input.segments.map(normalizePlanSegment).sort((left, right) => {
      return (
        left.startMs - right.startMs ||
        left.endMs - right.endMs ||
        left.segmentId.localeCompare(right.segmentId)
      )
    })
    if (new Set(segments.map((segment) => segment.segmentId)).size !== segments.length) {
      throw new Error('Duplicate planned segment id')
    }
    const planFingerprint = digest(canonicalPlan(segments))
    const jobId = crypto
      .createHash('sha1')
      .update(`${videoId}\u0000${generationId}\u0000${planFingerprint}`)
      .digest('hex')
    const existing = this.database.getJob(jobId)
    if (existing) return existing
    const now = input.now ?? Date.now()
    const job: VideoSemanticJobRecord = {
      jobId,
      assetId,
      videoId,
      generationId,
      profileId: input.profileId,
      planFingerprint,
      segments,
      state: 'queued',
      cursor: 0,
      completedSegments: 0,
      failedSegments: 0,
      attemptsBySegment: {},
      createdAt: now,
      updatedAt: now,
    }
    this.database.putJob(job)
    return job
  }

  getJob(jobId: string): VideoSemanticJobRecord | null {
    return this.database.getJob(requiredId(jobId, 'job id'))
  }

  requestStop(jobId: string, now = Date.now()): VideoSemanticJobRecord {
    const job = this.requireJob(jobId)
    if (job.state === 'done') return job
    const updated: VideoSemanticJobRecord = {
      ...job,
      state: 'stopped',
      updatedAt: now,
    }
    this.database.putJob(updated)
    return updated
  }

  pauseJob(jobId: string, reason: string, now = Date.now()): VideoSemanticJobRecord {
    const job = this.requireJob(jobId)
    if (job.state === 'done' || job.state === 'stopped') return job
    const updated: VideoSemanticJobRecord = {
      ...job,
      state: 'paused',
      currentSegmentId: undefined,
      lastError: reason.slice(0, 500),
      updatedAt: now,
    }
    this.database.putJob(updated)
    return updated
  }

  resumeJob(jobId: string, now = Date.now()): VideoSemanticJobRecord {
    const job = this.requireJob(jobId)
    if (job.state === 'done') return job
    const updated: VideoSemanticJobRecord = {
      ...job,
      state: 'queued',
      currentSegmentId: undefined,
      lastError: undefined,
      updatedAt: now,
    }
    this.database.putJob(updated)
    return updated
  }

  recoverInterruptedJobs(now = Date.now()): number {
    return this.database.recoverInterruptedJobs(now)
  }

  async runJob(
    jobId: string,
    processor: VideoSemanticSegmentProcessor,
    now: () => number = Date.now,
  ): Promise<VideoSemanticJobRecord> {
    let job = this.requireJob(jobId)
    if (job.state === 'done' || job.state === 'stopped') return job
    job = { ...job, state: 'running', updatedAt: now() }
    this.database.putJob(job)
    while (job.cursor < job.segments.length) {
      const persisted = this.requireJob(jobId)
      if (persisted.state === 'stopped' || persisted.state === 'paused') return persisted
      job = persisted
      const planned = job.segments[job.cursor]
      const attempt = (job.attemptsBySegment[planned.segmentId] ?? 0) + 1
      const segment = attemptSegment(planned, attempt)
      job = {
        ...job,
        state: 'running',
        currentSegmentId: planned.segmentId,
        attemptsBySegment: { ...job.attemptsBySegment, [planned.segmentId]: attempt },
        updatedAt: now(),
      }
      this.database.putJob(job)
      try {
        await processor({
          jobId,
          attempt,
          maxAttempts: MAX_ATTEMPTS_PER_SEGMENT,
          reducedEvidence: segment.evidenceFrameIds.length < planned.evidenceFrameIds.length,
          segment,
        })
        const afterProcess = this.requireJob(jobId)
        job = {
          ...afterProcess,
          cursor: afterProcess.cursor + 1,
          completedSegments: afterProcess.completedSegments + 1,
          currentSegmentId: undefined,
          lastError: afterProcess.failedSegments > 0 ? afterProcess.lastError : undefined,
          updatedAt: now(),
        }
        this.database.putJob(job)
        if (job.state === 'stopped' || job.state === 'paused') return job
      } catch (error) {
        const message =
          error instanceof Error ? error.message.slice(0, 500) : 'Segment processing failed'
        const afterFailure = this.requireJob(jobId)
        if (afterFailure.state === 'stopped' || afterFailure.state === 'paused') return afterFailure
        if (attempt < MAX_ATTEMPTS_PER_SEGMENT) {
          job = {
            ...afterFailure,
            currentSegmentId: undefined,
            lastError: message,
            updatedAt: now(),
          }
          this.database.putJob(job)
          continue
        }
        job = {
          ...afterFailure,
          cursor: afterFailure.cursor + 1,
          failedSegments: afterFailure.failedSegments + 1,
          currentSegmentId: undefined,
          lastError: message,
          updatedAt: now(),
        }
        this.database.putJob(job)
      }
    }
    job = {
      ...this.requireJob(jobId),
      state: 'done',
      currentSegmentId: undefined,
      updatedAt: now(),
    }
    this.database.putJob(job)
    return job
  }

  private requireJob(jobId: string): VideoSemanticJobRecord {
    const job = this.database.getJob(requiredId(jobId, 'job id'))
    if (!job) throw new Error('Video semantic job not found')
    if (!VIDEO_SEMANTIC_PROFILE_IDS.includes(job.profileId)) {
      throw new Error('Video semantic job profile is invalid')
    }
    return job
  }
}
