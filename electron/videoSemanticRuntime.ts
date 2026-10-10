import type {
  VideoSemanticModelIdentity,
  VideoSemanticRuntimeStatus,
} from '../shared/videoSemantic'
import type { VideoSemanticBuiltPrompt, VideoSemanticFrameEvidence } from './videoSemanticPrompt'

export interface VideoSemanticRuntimeImage extends VideoSemanticFrameEvidence {
  mimeType?: 'image/jpeg' | 'image/png' | 'image/webp'
  dataBase64?: string
}

export interface VideoSemanticRuntimeRequest {
  jobId: string
  plannedSegmentId: string
  prompt: VideoSemanticBuiltPrompt
  images: VideoSemanticRuntimeImage[]
  maximumOutputTokens: number
  timeoutMs: number
  contextTokens?: number
  maximumContextTokens?: number
  gpuLayers?: number
}

export interface VideoSemanticRuntime {
  readonly adapterId: string
  inspect(): Promise<VideoSemanticRuntimeStatus> | VideoSemanticRuntimeStatus
  generate(request: VideoSemanticRuntimeRequest, signal?: AbortSignal): Promise<string>
  dispose?(): Promise<void> | void
}

export type FakeVideoSemanticHandler = (
  request: VideoSemanticRuntimeRequest,
  callIndex: number,
) => Promise<string> | string

const FAKE_MODEL: VideoSemanticModelIdentity = {
  modelId: 'video-semantic-fake',
  modelRevision: 'fixture-v1',
  quantization: 'none',
}

function defaultFakeOutput(request: VideoSemanticRuntimeRequest): string {
  const userContent = request.prompt.messages[1].content
  const payload = JSON.parse(userContent.slice(userContent.indexOf('\n') + 1)) as {
    segment: { startMs: number; endMs: number; profileId: string }
  }
  return JSON.stringify({
    summary: `Fixture ${payload.segment.profileId} segment ${payload.segment.startMs}-${payload.segment.endMs}.`,
    scenes: ['fixture scene'],
    events: [],
    persons: [],
    objects: ['fixture object'],
    searchTags: ['fixture'],
    visualText: [],
    audioEvents: [],
    warnings: ['fake-runtime-output'],
  })
}

export class FakeVideoSemanticRuntime implements VideoSemanticRuntime {
  readonly adapterId = 'fake'
  readonly requests: VideoSemanticRuntimeRequest[] = []

  constructor(private readonly handler: FakeVideoSemanticHandler = defaultFakeOutput) {}

  inspect(): VideoSemanticRuntimeStatus {
    return { adapterId: this.adapterId, state: 'ready', model: { ...FAKE_MODEL } }
  }

  async generate(request: VideoSemanticRuntimeRequest, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('Video semantic runtime request aborted')
    const index = this.requests.length
    this.requests.push(request)
    return this.handler(request, index)
  }
}

export class VideoSemanticRuntimeRegistry {
  private runtime: VideoSemanticRuntime

  constructor(initialRuntime: VideoSemanticRuntime) {
    this.runtime = initialRuntime
  }

  get(): VideoSemanticRuntime {
    return this.runtime
  }

  async replace(nextRuntime: VideoSemanticRuntime): Promise<void> {
    if (nextRuntime === this.runtime) return
    const previous = this.runtime
    this.runtime = nextRuntime
    await previous.dispose?.()
  }
}
