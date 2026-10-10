import type { AudioSemanticSegmentRecord } from '../shared/audioSemantic'
import { normalizeAudioSemanticOutput, type AudioSemanticAuthority } from './audioSemanticSchema'
import type { AudioSemanticRuntime } from './audioSemanticRuntime'

export interface AudioSemanticPipelineInput {
  authority: AudioSemanticAuthority
  pcm16Base64: string
  speakerId?: string
}

export type AudioSemanticCommit = (record: AudioSemanticSegmentRecord) => Promise<void> | void

export class AudioSemanticPipelineService {
  constructor(
    private readonly runtime: AudioSemanticRuntime,
    private readonly commit: AudioSemanticCommit,
  ) {}

  async process(
    input: AudioSemanticPipelineInput,
    signal?: AbortSignal,
  ): Promise<AudioSemanticSegmentRecord> {
    const status = await this.runtime.inspect()
    if (status.state !== 'ready' || !status.model) {
      throw new Error(status.reason || 'audio-model-missing')
    }
    const expected = input.authority.model
    if (
      status.model.modelId !== expected.modelId ||
      status.model.modelRevision !== expected.modelRevision ||
      status.model.runtime !== expected.runtime ||
      status.model.quantization !== expected.quantization
    ) {
      throw new Error('audio-model-identity-mismatch')
    }
    const output = await this.runtime.transcribe(
      {
        authority: input.authority,
        pcm16Base64: input.pcm16Base64,
        sampleRate: 16_000,
        channels: 1,
      },
      signal,
    )
    const normalized = normalizeAudioSemanticOutput(
      input.speakerId ? { ...output, speakerId: input.speakerId } : output,
      input.authority,
    )
    if (!normalized.ok) throw new Error(normalized.error)
    await this.commit(normalized.value)
    return normalized.value
  }
}
