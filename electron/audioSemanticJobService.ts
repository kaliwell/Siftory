import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  AudioSemanticModelIdentity,
  AudioSemanticSegmentRecord,
} from '../shared/audioSemantic'
import { planAudioEvidenceChunks, type AudioEvidenceChunk } from './audioEvidenceService'

export const AUDIO_SEMANTIC_JOB_SCHEMA_VERSION = 1 as const
export const AUDIO_SEMANTIC_JOB_FILENAME = 'build-job.json'

export type AudioSemanticJobState = 'queued' | 'running' | 'stopped' | 'completed' | 'failed'

export interface AudioSemanticBuildVideoInput {
  videoId: string
  assetId: string
  videoPath: string
  durationMs: number
  sourceFingerprint: string
}

export interface AudioSemanticBuildVideoPlan extends AudioSemanticBuildVideoInput {
  chunks: AudioEvidenceChunk[]
}

export interface AudioSemanticBuildJobRecord {
  schemaVersion: typeof AUDIO_SEMANTIC_JOB_SCHEMA_VERSION
  jobId: string
  generationId: string
  state: AudioSemanticJobState
  model: AudioSemanticModelIdentity
  videos: AudioSemanticBuildVideoPlan[]
  videoCursor: number
  segmentCursor: number
  totalVideos: number
  completedVideos: number
  totalSegments: number
  completedSegments: number
  failedSegments: number
  currentVideoId?: string
  currentStartMs?: number
  currentEndMs?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/i
const MAX_VIDEOS = 10_000
const MAX_SEGMENTS = 1_000_000
const JOB_STATES = new Set<AudioSemanticJobState>([
  'queued',
  'running',
  'stopped',
  'completed',
  'failed',
])

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replaceAll('\u0000', '')
    .trim()
    .slice(0, 2_000)
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value), 'utf8')
  fs.renameSync(temporary, filePath)
}

function assertVideoInput(video: AudioSemanticBuildVideoInput): void {
  if (
    !IDENTIFIER_PATTERN.test(video.videoId) ||
    !IDENTIFIER_PATTERN.test(video.assetId) ||
    !IDENTIFIER_PATTERN.test(video.sourceFingerprint) ||
    typeof video.videoPath !== 'string' ||
    !path.isAbsolute(video.videoPath)
  ) {
    throw new Error('Invalid authoritative audio build video')
  }
}

function currentPosition(job: AudioSemanticBuildJobRecord): Partial<AudioSemanticBuildJobRecord> {
  const video = job.videos[job.videoCursor]
  const chunk = video?.chunks[job.segmentCursor]
  return video && chunk
    ? {
        currentVideoId: video.videoId,
        currentStartMs: chunk.startMs,
        currentEndMs: chunk.endMs,
      }
    : { currentVideoId: undefined, currentStartMs: undefined, currentEndMs: undefined }
}

export class AudioSemanticJobService {
  readonly root: string
  readonly jobPath: string
  private readonly stagingRoot: string

  constructor(root: string) {
    this.root = path.resolve(root)
    this.jobPath = path.join(this.root, AUDIO_SEMANTIC_JOB_FILENAME)
    this.stagingRoot = path.join(this.root, 'staging')
  }

  private stagePath(jobId: string): string {
    if (!IDENTIFIER_PATTERN.test(jobId)) throw new Error('Invalid audio semantic job id')
    return path.join(this.stagingRoot, `${jobId}.jsonl`)
  }

  create(
    videos: readonly AudioSemanticBuildVideoInput[],
    model: AudioSemanticModelIdentity,
    createdAt = Date.now(),
  ): AudioSemanticBuildJobRecord {
    if (videos.length < 1 || videos.length > MAX_VIDEOS) {
      throw new Error('Audio semantic build requires a bounded video list')
    }
    const plans = videos.map((video) => {
      assertVideoInput(video)
      return { ...video, chunks: planAudioEvidenceChunks(video.durationMs) }
    })
    const totalSegments = plans.reduce((sum, video) => sum + video.chunks.length, 0)
    if (totalSegments < 1 || totalSegments > MAX_SEGMENTS) {
      throw new Error('Audio semantic build segment count is outside the supported bound')
    }
    const digest = crypto
      .createHash('sha256')
      .update(
        plans
          .map((video) => `${video.videoId}:${video.sourceFingerprint}:${video.durationMs}`)
          .join('\n'),
      )
      .digest('hex')
      .slice(0, 16)
    const jobId = `audio-${createdAt}-${digest}`
    const generationId = `sensevoice-${createdAt}-${digest}`
    const job: AudioSemanticBuildJobRecord = {
      schemaVersion: AUDIO_SEMANTIC_JOB_SCHEMA_VERSION,
      jobId,
      generationId,
      state: 'queued',
      model: { ...model },
      videos: plans,
      videoCursor: 0,
      segmentCursor: 0,
      totalVideos: plans.length,
      completedVideos: 0,
      totalSegments,
      completedSegments: 0,
      failedSegments: 0,
      createdAt,
      updatedAt: createdAt,
      ...currentPosition({
        videos: plans,
        videoCursor: 0,
        segmentCursor: 0,
      } as AudioSemanticBuildJobRecord),
    }
    atomicWriteJson(this.jobPath, job)
    fs.mkdirSync(this.stagingRoot, { recursive: true })
    fs.writeFileSync(this.stagePath(jobId), '', { flag: 'wx' })
    return job
  }

  load(): AudioSemanticBuildJobRecord | null {
    try {
      const job = JSON.parse(fs.readFileSync(this.jobPath, 'utf8')) as AudioSemanticBuildJobRecord
      if (
        job.schemaVersion !== AUDIO_SEMANTIC_JOB_SCHEMA_VERSION ||
        !IDENTIFIER_PATTERN.test(job.jobId) ||
        !IDENTIFIER_PATTERN.test(job.generationId) ||
        !Array.isArray(job.videos) ||
        job.videos.length < 1 ||
        job.videos.length > MAX_VIDEOS ||
        !JOB_STATES.has(job.state) ||
        !Number.isSafeInteger(job.videoCursor) ||
        !Number.isSafeInteger(job.segmentCursor) ||
        job.videoCursor < 0 ||
        job.videoCursor > job.videos.length ||
        job.segmentCursor < 0 ||
        !job.model ||
        !IDENTIFIER_PATTERN.test(job.model.modelRevision) ||
        typeof job.model.modelId !== 'string' ||
        job.model.modelId.length > 256 ||
        typeof job.model.quantization !== 'string' ||
        job.model.quantization.length > 64 ||
        !['fake', 'funasr', 'sensevoice-gguf'].includes(job.model.runtime)
      ) {
        return null
      }
      let totalSegments = 0
      for (const video of job.videos) {
        assertVideoInput(video)
        const expectedChunks = planAudioEvidenceChunks(video.durationMs)
        if (
          !Array.isArray(video.chunks) ||
          video.chunks.length !== expectedChunks.length ||
          video.chunks.some(
            (chunk, index) =>
              chunk.startMs !== expectedChunks[index]?.startMs ||
              chunk.endMs !== expectedChunks[index]?.endMs,
          )
        ) {
          return null
        }
        totalSegments += video.chunks.length
      }
      const currentVideo = job.videos[job.videoCursor]
      if (
        totalSegments < 1 ||
        totalSegments > MAX_SEGMENTS ||
        job.totalVideos !== job.videos.length ||
        job.totalSegments !== totalSegments ||
        !Number.isSafeInteger(job.completedVideos) ||
        job.completedVideos < 0 ||
        job.completedVideos > job.totalVideos ||
        !Number.isSafeInteger(job.completedSegments) ||
        job.completedSegments < 0 ||
        job.completedSegments > job.totalSegments ||
        !Number.isSafeInteger(job.failedSegments) ||
        job.failedSegments < 0 ||
        job.failedSegments > job.totalSegments ||
        job.completedSegments + job.failedSegments > job.totalSegments ||
        (currentVideo ? job.segmentCursor >= currentVideo.chunks.length : job.segmentCursor !== 0)
      ) {
        return null
      }
      return job
    } catch {
      return null
    }
  }

  update(
    jobId: string,
    updater: (job: AudioSemanticBuildJobRecord) => AudioSemanticBuildJobRecord,
  ): AudioSemanticBuildJobRecord {
    const current = this.load()
    if (!current || current.jobId !== jobId) throw new Error('Audio semantic job not found')
    const next = updater(structuredClone(current))
    next.updatedAt = Date.now()
    Object.assign(next, currentPosition(next))
    atomicWriteJson(this.jobPath, next)
    return next
  }

  markRunning(jobId: string): AudioSemanticBuildJobRecord {
    return this.update(jobId, (job) => ({ ...job, state: 'running', lastError: undefined }))
  }

  markStopped(jobId: string): AudioSemanticBuildJobRecord {
    return this.update(jobId, (job) => ({ ...job, state: 'stopped' }))
  }

  markFailed(jobId: string, error: unknown): AudioSemanticBuildJobRecord {
    return this.update(jobId, (job) => ({
      ...job,
      state: 'failed',
      lastError: boundedError(error),
    }))
  }

  markCompleted(jobId: string): AudioSemanticBuildJobRecord {
    return this.update(jobId, (job) => ({
      ...job,
      state: 'completed',
      videoCursor: job.totalVideos,
      segmentCursor: 0,
      completedVideos: job.totalVideos,
    }))
  }

  stageRecord(jobId: string, record: AudioSemanticSegmentRecord): void {
    fs.appendFileSync(this.stagePath(jobId), `${JSON.stringify(record)}\n`, 'utf8')
  }

  recordsForVideo(jobId: string, videoId: string): AudioSemanticSegmentRecord[] {
    const records = new Map<string, AudioSemanticSegmentRecord>()
    try {
      for (const line of fs.readFileSync(this.stagePath(jobId), 'utf8').split(/\r?\n/)) {
        if (!line) continue
        try {
          const record = JSON.parse(line) as AudioSemanticSegmentRecord
          if (record.videoId === videoId && IDENTIFIER_PATTERN.test(record.segmentId)) {
            records.set(record.segmentId, record)
          }
        } catch {
          // A partial final line is ignored and the authoritative cursor is replayed.
        }
      }
    } catch {
      return []
    }
    return [...records.values()].sort((left, right) => left.startMs - right.startMs)
  }

  advanceSegment(jobId: string, error?: unknown): AudioSemanticBuildJobRecord {
    return this.update(jobId, (job) => {
      const video = job.videos[job.videoCursor]
      if (!video) return job
      let videoCursor = job.videoCursor
      let segmentCursor = job.segmentCursor + 1
      let completedVideos = job.completedVideos
      if (segmentCursor >= video.chunks.length) {
        videoCursor += 1
        segmentCursor = 0
        completedVideos += 1
      }
      return {
        ...job,
        videoCursor,
        segmentCursor,
        completedVideos,
        completedSegments: job.completedSegments + (error ? 0 : 1),
        failedSegments: job.failedSegments + (error ? 1 : 0),
        ...(error ? { lastError: boundedError(error) } : {}),
      }
    })
  }

  skipCurrentVideo(jobId: string, error: unknown): AudioSemanticBuildJobRecord {
    return this.update(jobId, (job) => {
      const video = job.videos[job.videoCursor]
      if (!video) return job
      const remaining = Math.max(0, video.chunks.length - job.segmentCursor)
      return {
        ...job,
        videoCursor: job.videoCursor + 1,
        segmentCursor: 0,
        completedVideos: job.completedVideos + 1,
        failedSegments: job.failedSegments + remaining,
        lastError: boundedError(error),
      }
    })
  }
}
