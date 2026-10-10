import type {
  VideoSemanticJobRecord,
  VideoSemanticResourceBudget,
  VideoSemanticResourceDecision,
  VideoSemanticResourceSnapshot,
} from '../shared/videoSemantic'
import type { UnifiedTaskSubmitter } from './unifiedTaskSubmission'
import { submitUnifiedTask } from './unifiedTaskSubmission'
import {
  VideoSemanticJobService,
  type VideoSemanticSegmentAttempt,
} from './videoSemanticJobService'
import {
  OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_CONTEXT_TOKENS,
  OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_GPU_LAYERS,
} from './ollamaVideoSemanticRuntime'

const GIB = 1024 * 1024 * 1024

const LOW_VRAM_BUDGET: VideoSemanticResourceBudget = {
  tier: 'low-vram-4g',
  execution: 'gpu',
  maxConcurrency: 1,
  maxFramesPerSegment: 4,
  preferredFrameWidth: 384,
  contextTokens: OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_CONTEXT_TOKENS,
  maximumContextTokens: 16_384,
  maximumOutputTokens: 1_024,
  segmentTimeoutMs: 180_000,
  minimumFreeGpuBytes: Math.floor(2.5 * GIB),
  systemMemorySoftLimitBytes: 12 * GIB,
  gpuLayers: OLLAMA_VIDEO_SEMANTIC_LOW_VRAM_GPU_LAYERS,
}

const STANDARD_VRAM_BUDGET: VideoSemanticResourceBudget = {
  ...LOW_VRAM_BUDGET,
  tier: 'standard-vram',
  maxFramesPerSegment: 10,
  preferredFrameWidth: 448,
  contextTokens: 8_192,
  maximumContextTokens: 16_384,
  minimumFreeGpuBytes: 4 * GIB,
  gpuLayers: undefined,
}

const CPU_BUDGET: VideoSemanticResourceBudget = {
  ...LOW_VRAM_BUDGET,
  tier: 'cpu-memory',
  execution: 'cpu',
  maxFramesPerSegment: 4,
  contextTokens: 8_192,
  maximumContextTokens: 16_384,
  minimumFreeGpuBytes: 0,
  gpuLayers: 0,
}

const UNSUPPORTED_BUDGET: VideoSemanticResourceBudget = {
  ...CPU_BUDGET,
  tier: 'unsupported',
  execution: 'unavailable',
  maxFramesPerSegment: 0,
  preferredFrameWidth: 0,
  contextTokens: 0,
  maximumContextTokens: 0,
  maximumOutputTokens: 0,
}

function finiteBytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

export function decideVideoSemanticResources(
  snapshot: VideoSemanticResourceSnapshot,
): VideoSemanticResourceDecision {
  const gpuTotalBytes = finiteBytes(snapshot.gpuTotalBytes)
  const gpuFreeBytes = finiteBytes(snapshot.gpuFreeBytes)
  const systemMemoryTotalBytes = finiteBytes(snapshot.systemMemoryTotalBytes)
  if (gpuTotalBytes !== undefined && gpuTotalBytes >= 3.5 * GIB) {
    const budget = gpuTotalBytes >= 8 * GIB ? STANDARD_VRAM_BUDGET : LOW_VRAM_BUDGET
    if (gpuFreeBytes !== undefined && gpuFreeBytes < budget.minimumFreeGpuBytes) {
      return {
        state: 'waiting-gpu',
        budget: { ...budget },
        reason: 'waiting-for-free-gpu-memory',
      }
    }
    return { state: 'ready', budget: { ...budget } }
  }
  if (systemMemoryTotalBytes !== undefined && systemMemoryTotalBytes >= 12 * GIB) {
    return {
      state: 'ready',
      budget: { ...CPU_BUDGET },
      reason: 'gpu-unavailable-using-cpu-fallback',
    }
  }
  return {
    state: 'unsupported',
    budget: { ...UNSUPPORTED_BUDGET },
    reason: 'insufficient-local-memory-for-video-semantic-model',
  }
}

function uniformlyLimitFrames(frameIds: readonly string[], maximum: number): string[] {
  if (frameIds.length <= maximum) return [...frameIds]
  if (maximum <= 1) return frameIds.slice(0, Math.max(0, maximum))
  const selected: string[] = []
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round((index * (frameIds.length - 1)) / (maximum - 1))
    selected.push(frameIds[sourceIndex])
  }
  return selected
}

export interface ScheduledVideoSemanticAttempt extends VideoSemanticSegmentAttempt {
  budget: VideoSemanticResourceBudget
}

export interface QueueVideoSemanticJobInput {
  scheduler?: UnifiedTaskSubmitter
  jobService: VideoSemanticJobService
  jobId: string
  resourceProbe: () => Promise<VideoSemanticResourceSnapshot> | VideoSemanticResourceSnapshot
  processor: (attempt: ScheduledVideoSemanticAttempt) => Promise<void> | void
  authorizedPaths?: readonly string[]
}

export interface QueueVideoSemanticJobResult {
  state: 'done' | 'stopped' | 'waiting-gpu' | 'unsupported'
  job: VideoSemanticJobRecord
  resources: VideoSemanticResourceDecision
}

export function queueVideoSemanticJob(
  input: QueueVideoSemanticJobInput,
): Promise<QueueVideoSemanticJobResult> {
  return submitUnifiedTask(input.scheduler, {
    stage: 'video-deep',
    priority: 2,
    paths: input.authorizedPaths,
    label: `video semantic job: ${input.jobId.slice(0, 12)}`,
    run: async () => {
      const resources = decideVideoSemanticResources(await input.resourceProbe())
      if (resources.state !== 'ready') {
        const job = input.jobService.pauseJob(input.jobId, resources.reason ?? resources.state)
        return { state: resources.state, job, resources }
      }
      const current = input.jobService.getJob(input.jobId)
      if (!current) throw new Error('Video semantic job not found')
      if (current.state === 'paused') input.jobService.resumeJob(input.jobId)
      const job = await input.jobService.runJob(input.jobId, async (attempt) => {
        const limitedFrameIds = uniformlyLimitFrames(
          attempt.segment.evidenceFrameIds,
          resources.budget.maxFramesPerSegment,
        )
        await input.processor({
          ...attempt,
          segment: { ...attempt.segment, evidenceFrameIds: limitedFrameIds },
          budget: resources.budget,
        })
      })
      return {
        state: job.state === 'stopped' ? 'stopped' : 'done',
        job,
        resources,
      }
    },
  })
}
