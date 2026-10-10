import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { MediaSearchVideoFrameRecord, MediaSearchVideoRecord } from '../shared/ipc-contract'
import type {
  VideoSemanticJobRecord,
  VideoSemanticPlannedSegment,
  VideoSemanticProfileId,
  VideoSemanticProfilePlan,
  VideoSemanticResourceDecision,
  VideoSemanticResourceSnapshot,
} from '../shared/videoSemantic'
import { isVideoSemanticProfileId } from '../shared/videoSemantic'
import { readNvidiaVideoMemory } from './embeddingBatchPolicy'
import type { UnifiedTaskSubmitter } from './unifiedTaskSubmission'
import { VideoSemanticDatabase } from './videoSemanticDatabase'
import {
  VideoSemanticJobService,
  type VideoSemanticSegmentAttempt,
} from './videoSemanticJobService'
import { VideoSemanticPipelineService } from './videoSemanticPipelineService'
import { planVideoSemanticProfile } from './videoSemanticProfilePlanner'
import type { VideoSemanticRuntime, VideoSemanticRuntimeImage } from './videoSemanticRuntime'
import { deriveVideoSemanticSegmentId } from './videoSemanticSchema'
import { decideVideoSemanticResources } from './videoSemanticTaskScheduling'

const MAX_FRAME_BYTES = 2 * 1024 * 1024
const FRAME_ID_PATTERN = /^[a-f0-9]{40}$/i
const MAX_PLANNED_SEGMENTS = 10_800

export interface PlanVideoSemanticEvidenceInput {
  video: MediaSearchVideoRecord
  frames: readonly MediaSearchVideoFrameRecord[]
  generationId: string
  profileOverride: VideoSemanticProfileId | 'auto'
  maximumFramesPerSegment: number
}

export interface PlannedVideoSemanticEvidence {
  profile: VideoSemanticProfilePlan
  segments: VideoSemanticPlannedSegment[]
}

function uniformlyLimit<T>(values: readonly T[], maximum: number): T[] {
  if (values.length <= maximum) return [...values]
  return Array.from({ length: maximum }, (_, index) => {
    const sourceIndex = Math.round((index * (values.length - 1)) / Math.max(1, maximum - 1))
    return values[sourceIndex]
  })
}

function frameDigest(frameIds: readonly string[]): string {
  return crypto.createHash('sha256').update(frameIds.join('\n')).digest('hex')
}

export function planVideoSemanticEvidence(
  input: PlanVideoSemanticEvidenceInput,
): PlannedVideoSemanticEvidence {
  const durationMs = input.video.durationMs
  if (
    input.video.missing ||
    input.video.metadataStatus !== 'done' ||
    !Number.isSafeInteger(durationMs) ||
    !durationMs ||
    durationMs <= 0
  ) {
    throw new Error('Video semantic source metadata is not ready')
  }
  if (
    !Number.isSafeInteger(input.maximumFramesPerSegment) ||
    input.maximumFramesPerSegment < 1 ||
    input.maximumFramesPerSegment > 16
  ) {
    throw new Error('Invalid video semantic frame budget')
  }

  const profile = planVideoSemanticProfile({
    userOverride: input.profileOverride,
    durationMs,
    width: input.video.width,
    height: input.video.height,
    fileName: input.video.name,
  })
  const readyFrames = input.frames
    .filter(
      (frame) =>
        frame.videoId === input.video.videoId &&
        frame.status === 'done' &&
        typeof frame.imagePath === 'string' &&
        Boolean(frame.imagePath) &&
        FRAME_ID_PATTERN.test(frame.frameId) &&
        Number.isSafeInteger(frame.timestampMs) &&
        frame.timestampMs >= 0 &&
        frame.timestampMs <= durationMs,
    )
    .sort(
      (left, right) =>
        left.timestampMs - right.timestampMs || left.frameId.localeCompare(right.frameId),
    )
  const uniqueFrames = [...new Map(readyFrames.map((frame) => [frame.frameId, frame])).values()]
  if (uniqueFrames.length === 0) throw new Error('Video semantic ready frames are missing')

  const targetMs = profile.policy.targetSegmentMs
  const buckets = new Map<number, MediaSearchVideoFrameRecord[]>()
  for (const frame of uniqueFrames) {
    const bucket = Math.min(
      Math.floor(frame.timestampMs / targetMs),
      Math.ceil(durationMs / targetMs),
    )
    const list = buckets.get(bucket) ?? []
    list.push(frame)
    buckets.set(bucket, list)
  }
  if (buckets.size > MAX_PLANNED_SEGMENTS) {
    throw new Error('Video semantic segment plan exceeds safety limit')
  }

  const segments = [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bucket, frames]) => {
      let startMs = bucket * targetMs
      const endMs = Math.min(durationMs, Math.max(startMs + 1, startMs + targetMs))
      if (endMs - startMs < profile.policy.minSegmentMs) {
        startMs = Math.max(0, endMs - profile.policy.minSegmentMs)
      }
      const selected = uniformlyLimit(
        frames,
        Math.min(input.maximumFramesPerSegment, profile.policy.maxFrames),
      )
      const evidenceFrameIds = selected.map((frame) => frame.frameId)
      return {
        segmentId: deriveVideoSemanticSegmentId({
          videoId: input.video.videoId,
          startMs,
          endMs,
          generationId: input.generationId,
        }),
        startMs,
        endMs,
        evidenceFrameIds,
        evidenceFrameDigest: frameDigest(evidenceFrameIds),
      }
    })

  return { profile, segments }
}

export interface VideoSemanticBuildCoordinatorOptions {
  database: VideoSemanticDatabase
  jobs: VideoSemanticJobService
  runtime: VideoSemanticRuntime
  scheduler?: UnifiedTaskSubmitter
  getVideo: (videoId: string) => MediaSearchVideoRecord | undefined
  getFrames: () => readonly MediaSearchVideoFrameRecord[]
  framesRoot: string
  resourceProbe?: () => VideoSemanticResourceSnapshot
  generationIdFactory?: (videoId: string, sourceFingerprint: string) => string
  now?: () => number
}

export interface VideoSemanticBuildStartResult {
  started: boolean
  job: VideoSemanticJobRecord
  resources: VideoSemanticResourceDecision
  reason?: string
}

export function probeLocalVideoSemanticResources(): VideoSemanticResourceSnapshot {
  const gpu = readNvidiaVideoMemory()
  return {
    ...(gpu
      ? {
          gpuFreeBytes: gpu.freeVideoMemoryBytes,
          gpuTotalBytes: gpu.totalVideoMemoryBytes,
        }
      : {}),
    systemMemoryTotalBytes: os.totalmem(),
  }
}

function sourceFingerprint(video: MediaSearchVideoRecord): string {
  return crypto
    .createHash('sha256')
    .update(`${video.videoId}\0${video.sizeBytes}\0${video.mtimeMs}\0${video.durationMs}`)
    .digest('hex')
}

function defaultGenerationId(videoId: string, fingerprint: string): string {
  return crypto
    .createHash('sha1')
    .update(`${videoId}\0${fingerprint}\0${Date.now()}\0${crypto.randomBytes(16).toString('hex')}`)
    .digest('hex')
}

function mimeTypeFor(filePath: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.webp') return 'image/webp'
  return 'image/jpeg'
}

export class VideoSemanticBuildCoordinator {
  private readonly pipeline: VideoSemanticPipelineService
  private readonly inFlightJobs = new Set<string>()
  private readonly framesRoot: string

  constructor(private readonly options: VideoSemanticBuildCoordinatorOptions) {
    this.pipeline = new VideoSemanticPipelineService(options.database, options.jobs)
    this.framesRoot = path.resolve(options.framesRoot)
  }

  async start(videoId: string): Promise<VideoSemanticBuildStartResult> {
    const active = this.options.database
      .listJobs(videoId)
      .find((job) => job.state === 'queued' || job.state === 'running')
    if (active) {
      return {
        started: false,
        job: active,
        resources: decideVideoSemanticResources(this.probe()),
        reason: 'video-semantic-job-already-active',
      }
    }
    const video = this.requireVideo(videoId)
    const fingerprint = sourceFingerprint(video)
    const resources = decideVideoSemanticResources(this.probe())
    const generationId = (this.options.generationIdFactory ?? defaultGenerationId)(
      video.videoId,
      fingerprint,
    )
    const persistedProfileOverride = this.options.database.getVideoProfileOverride(video.videoId)
    const profileOverride: VideoSemanticProfileId | 'auto' =
      persistedProfileOverride === 'auto' || isVideoSemanticProfileId(persistedProfileOverride)
        ? persistedProfileOverride
        : 'auto'
    const planned = planVideoSemanticEvidence({
      video,
      frames: this.options.getFrames(),
      generationId,
      profileOverride,
      maximumFramesPerSegment: Math.max(1, resources.budget.maxFramesPerSegment),
    })
    const job = this.options.jobs.createJob({
      assetId: video.videoId,
      videoId: video.videoId,
      generationId,
      profileId: planned.profile.profileId,
      segments: planned.segments,
      now: this.now(),
    })
    if (resources.state !== 'ready') {
      const paused = this.options.jobs.pauseJob(job.jobId, resources.reason ?? resources.state)
      return { started: false, job: paused, resources, reason: resources.reason ?? resources.state }
    }
    this.enqueue(job, video, fingerprint, resources)
    return { started: true, job, resources }
  }

  async resume(jobId: string): Promise<VideoSemanticBuildStartResult> {
    const job = this.options.jobs.getJob(jobId)
    if (!job) throw new Error('Video semantic job not found')
    const video = this.requireVideo(job.videoId)
    const resources = decideVideoSemanticResources(this.probe())
    if (resources.state !== 'ready') {
      const paused = this.options.jobs.pauseJob(job.jobId, resources.reason ?? resources.state)
      return { started: false, job: paused, resources, reason: resources.reason ?? resources.state }
    }
    const resumed = this.options.jobs.resumeJob(job.jobId, this.now())
    this.enqueue(resumed, video, sourceFingerprint(video), resources)
    return { started: true, job: resumed, resources }
  }

  private enqueue(
    job: VideoSemanticJobRecord,
    video: MediaSearchVideoRecord,
    fingerprint: string,
    resources: VideoSemanticResourceDecision,
  ): void {
    if (this.inFlightJobs.has(job.jobId)) return
    this.inFlightJobs.add(job.jobId)
    const run = async () => {
      try {
        await this.pipeline.run({
          jobId: job.jobId,
          sourceFingerprint: fingerprint,
          runtime: this.options.runtime,
          resourceBudget: resources.budget,
          loadEvidence: (attempt) => this.loadEvidence(video.videoId, attempt),
          now: this.options.now,
        })
      } catch (error) {
        const current = this.options.jobs.getJob(job.jobId)
        if (current && current.state !== 'done' && current.state !== 'stopped') {
          this.options.jobs.pauseJob(
            job.jobId,
            error instanceof Error ? error.message : 'video-semantic-build-failed',
            this.now(),
          )
        }
      } finally {
        this.inFlightJobs.delete(job.jobId)
      }
    }
    if (this.options.scheduler) {
      void this.options.scheduler
        .enqueue({
          stage: 'video-deep',
          priority: 2,
          paths: [video.path],
          label: `video semantic build: ${video.videoId.slice(0, 12)}`,
          run,
        })
        .promise.catch((error) => {
          this.inFlightJobs.delete(job.jobId)
          const current = this.options.jobs.getJob(job.jobId)
          if (current && current.state !== 'done' && current.state !== 'stopped') {
            this.options.jobs.pauseJob(
              job.jobId,
              error instanceof Error ? error.message : 'video-semantic-scheduler-failed',
              this.now(),
            )
          }
        })
      return
    }
    void Promise.resolve().then(run)
  }

  private loadEvidence(
    videoId: string,
    attempt: VideoSemanticSegmentAttempt,
  ): { frames: VideoSemanticRuntimeImage[] } {
    const byId = new Map(
      this.options
        .getFrames()
        .filter((frame) => frame.videoId === videoId && frame.status === 'done')
        .map((frame) => [frame.frameId, frame]),
    )
    const frames = attempt.segment.evidenceFrameIds.map((frameId) => {
      const frame = byId.get(frameId)
      if (!frame?.imagePath) throw new Error('Video semantic evidence frame is unavailable')
      const resolved = path.resolve(frame.imagePath)
      const relative = path.relative(this.framesRoot, resolved)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Video semantic evidence escaped the controlled frame cache')
      }
      const stat = fs.statSync(resolved)
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FRAME_BYTES) {
        throw new Error('Video semantic evidence frame size is invalid')
      }
      return {
        frameId,
        timestampMs: frame.timestampMs,
        mimeType: mimeTypeFor(resolved),
        dataBase64: fs.readFileSync(resolved).toString('base64'),
      }
    })
    return { frames }
  }

  private requireVideo(videoId: string): MediaSearchVideoRecord {
    const video = this.options.getVideo(videoId)
    if (!video || video.missing) throw new Error('Video semantic source is unavailable')
    return video
  }

  private probe(): VideoSemanticResourceSnapshot {
    return (this.options.resourceProbe ?? probeLocalVideoSemanticResources)()
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}
