import type { VideoSemanticJobRecord, VideoSemanticResourceBudget } from '../shared/videoSemantic'
import { VideoSemanticDatabase } from './videoSemanticDatabase'
import {
  VideoSemanticJobService,
  limitVideoSemanticSegmentEvidence,
  type VideoSemanticSegmentAttempt,
} from './videoSemanticJobService'
import {
  buildVideoSemanticPrompt,
  parseVideoSemanticModelOutput,
  type VideoSemanticFrameEvidence,
  type VideoSemanticUntrustedTextEvidence,
} from './videoSemanticPrompt'
import type { VideoSemanticRuntime, VideoSemanticRuntimeImage } from './videoSemanticRuntime'

export interface VideoSemanticSegmentEvidence {
  frames: VideoSemanticRuntimeImage[]
  untrustedText?: VideoSemanticUntrustedTextEvidence[]
}

export interface RunVideoSemanticPipelineInput {
  jobId: string
  sourceFingerprint: string
  runtime: VideoSemanticRuntime
  loadEvidence: (
    attempt: VideoSemanticSegmentAttempt,
  ) => Promise<VideoSemanticSegmentEvidence> | VideoSemanticSegmentEvidence
  maximumOutputTokens?: number
  timeoutMs?: number
  resourceBudget: VideoSemanticResourceBudget
  now?: () => number
}

export interface VideoSemanticPipelineResult {
  job: VideoSemanticJobRecord
  activated: boolean
  stagedSegments: number
}

function promptFrames(frames: VideoSemanticRuntimeImage[]): VideoSemanticFrameEvidence[] {
  return frames.map(({ frameId, timestampMs }) => ({ frameId, timestampMs }))
}

export class VideoSemanticPipelineService {
  constructor(
    private readonly database: VideoSemanticDatabase,
    private readonly jobs: VideoSemanticJobService,
  ) {}

  async run(input: RunVideoSemanticPipelineInput): Promise<VideoSemanticPipelineResult> {
    const initialJob = this.jobs.getJob(input.jobId)
    if (!initialJob) throw new Error('Video semantic pipeline job not found')
    const runtimeStatus = await input.runtime.inspect()
    if (runtimeStatus.state !== 'ready' || !runtimeStatus.model) {
      const job = this.jobs.pauseJob(
        input.jobId,
        runtimeStatus.reason || `runtime-${runtimeStatus.state}`,
        input.now?.() ?? Date.now(),
      )
      return {
        job,
        activated: false,
        stagedSegments: this.database.getStagedJobResults(input.jobId).length,
      }
    }
    const model = runtimeStatus.model
    const now = input.now ?? Date.now
    const job = await this.jobs.runJob(
      input.jobId,
      async (attempt) => {
        const budgetedSegment = limitVideoSemanticSegmentEvidence(
          attempt.segment,
          input.resourceBudget.maxFramesPerSegment,
        )
        const budgetedAttempt =
          budgetedSegment === attempt.segment
            ? attempt
            : { ...attempt, reducedEvidence: true, segment: budgetedSegment }
        const evidence = await input.loadEvidence(budgetedAttempt)
        const authority = {
          generationId: initialJob.generationId,
          assetId: initialJob.assetId,
          videoId: initialJob.videoId,
          startMs: budgetedSegment.startMs,
          endMs: budgetedSegment.endMs,
          profileId: initialJob.profileId,
          evidenceFrameIds: budgetedSegment.evidenceFrameIds,
          evidenceFrameDigest: budgetedSegment.evidenceFrameDigest,
          modelId: model.modelId,
          modelRevision: model.modelRevision,
          quantization: model.quantization,
          sourceFingerprint: input.sourceFingerprint,
          createdAt: initialJob.createdAt,
        }
        const prompt = buildVideoSemanticPrompt({
          authority,
          frames: promptFrames(evidence.frames),
          untrustedText: evidence.untrustedText,
        })
        const requestedOutputTokens =
          input.maximumOutputTokens ?? input.resourceBudget.maximumOutputTokens
        const maximumOutputTokens =
          attempt.attempt > 1 && requestedOutputTokens < input.resourceBudget.maximumOutputTokens
            ? input.resourceBudget.maximumOutputTokens
            : requestedOutputTokens
        const rawOutput = await input.runtime.generate({
          jobId: initialJob.jobId,
          plannedSegmentId: budgetedSegment.segmentId,
          prompt,
          images: evidence.frames,
          maximumOutputTokens,
          timeoutMs: input.timeoutMs ?? input.resourceBudget.segmentTimeoutMs,
          contextTokens:
            attempt.attempt >= attempt.maxAttempts
              ? input.resourceBudget.maximumContextTokens
              : input.resourceBudget.contextTokens,
          maximumContextTokens: input.resourceBudget.maximumContextTokens,
          gpuLayers: input.resourceBudget.gpuLayers,
        })
        const parsed = parseVideoSemanticModelOutput(rawOutput, authority, prompt.transcriptRefs)
        if (!parsed.ok) throw new Error(parsed.error)
        this.database.stageJobResult(
          initialJob.jobId,
          budgetedSegment.segmentId,
          parsed.value,
          now(),
        )
      },
      now,
    )
    const staged = this.database.getStagedJobResults(input.jobId)
    const complete =
      job.state === 'done' && job.failedSegments === 0 && staged.length === job.segments.length
    if (!complete) return { job, activated: false, stagedSegments: staged.length }
    this.database.commitGeneration(staged, now())
    this.database.clearStagedJobResults(input.jobId)
    return { job, activated: true, stagedSegments: staged.length }
  }
}
