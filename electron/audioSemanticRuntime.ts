import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type {
  AudioSemanticModelIdentity,
  AudioSemanticRuntimeStatus,
} from '../shared/audioSemantic'
import type { AudioSemanticAuthority, AudioSemanticRuntimeOutput } from './audioSemanticSchema'

const MAX_PCM16_BASE64_CHARS = 3 * 1024 * 1024
const BASE64_PATTERN = /^[a-z0-9+/]+={0,2}$/i

export const SENSEVOICE_MODEL_ID = 'FunAudioLLM/SenseVoiceSmall'
export const SENSEVOICE_MODEL_REVISION = '3847d57b6bdf2dd8875cb1508d2af43d80a16bf7'
export const SENSEVOICE_MODEL_FILE_BYTES = 936_291_369
export const FSMN_VAD_MODEL_REVISION = 'v2.0.4'
export const CAMPLUS_MODEL_REVISION = 'v2.0.2'
export const CAMPLUS_SPEAKER_IDENTITY = {
  modelId: 'campplus-speaker',
  modelRevision: `modelscope-${CAMPLUS_MODEL_REVISION}`,
} as const
export const SENSEVOICE_MODEL_IDENTITY: AudioSemanticModelIdentity = {
  modelId: SENSEVOICE_MODEL_ID,
  modelRevision: SENSEVOICE_MODEL_REVISION,
  runtime: 'funasr',
  quantization: 'fp32',
}

const SENSEVOICE_CRITICAL_FILES: Readonly<Record<string, number>> = {
  'model.pt': SENSEVOICE_MODEL_FILE_BYTES,
  'config.yaml': 1_855,
  'configuration.json': 396,
  'am.mvn': 11_203,
  'chn_jpn_yue_eng_ko_spectok.bpe.model': 377_341,
}
const FSMN_VAD_CRITICAL_FILES: Readonly<Record<string, number>> = {
  'model.pt': 1_721_366,
  'config.yaml': 1_215,
  'configuration.json': 365,
  'am.mvn': 8_040,
}
const CAMPLUS_CRITICAL_FILES: Readonly<Record<string, number>> = {
  'campplus_cn_common.bin': 28_036_335,
  'config.yaml': 537,
  'configuration.json': 581,
}
const SENSEVOICE_STDOUT_LIMIT = 64 * 1024
const SENSEVOICE_STDERR_LIMIT = 256 * 1024
const SENSEVOICE_DEFAULT_TIMEOUT_MS = 180_000
const SENSEVOICE_TAG_PATTERN = /<\|([^|]{1,64})\|>/g

export interface AudioSemanticRuntimeRequest {
  authority: AudioSemanticAuthority
  pcm16Base64: string
  sampleRate: 16_000
  channels: 1
}

export interface AudioDiarizationTurn {
  startMs: number
  endMs: number
  embedding?: number[]
}

export interface AudioDiarizationOutput {
  turns: AudioDiarizationTurn[]
}

export interface AudioDiarizationRuntimeStatus {
  state: 'not-installed' | 'ready' | 'unavailable' | 'error'
  reason?: string
  vadModel?: { modelId: string; modelRevision: string }
  speakerModel?: { modelId: string; modelRevision: string }
}

export interface AudioSemanticRuntime {
  readonly adapterId: string
  inspect(): AudioSemanticRuntimeStatus | Promise<AudioSemanticRuntimeStatus>
  transcribe(
    request: AudioSemanticRuntimeRequest,
    signal?: AbortSignal,
  ): AudioSemanticRuntimeOutput | Promise<AudioSemanticRuntimeOutput>
  dispose?(): void | Promise<void>
}

function validatePcm(request: AudioSemanticRuntimeRequest): void {
  const value = request.pcm16Base64
  if (
    !value ||
    value.length % 4 !== 0 ||
    value.length > MAX_PCM16_BASE64_CHARS ||
    !BASE64_PATTERN.test(value)
  ) {
    throw new Error('Invalid bounded PCM16 audio evidence')
  }
  const decodedBytes = Math.floor((value.length * 3) / 4)
  const maximumBytes = ((request.authority.endMs - request.authority.startMs) * 16_000 * 2) / 1_000
  if (decodedBytes > maximumBytes + 32_000) {
    throw new Error('PCM16 audio evidence exceeds the authoritative segment')
  }
}

export function parseAudioDiarizationTurns(
  raw: unknown,
  durationMs: number,
): AudioDiarizationOutput {
  if (!Array.isArray(raw) || !Number.isSafeInteger(durationMs) || durationMs < 1) {
    throw new Error('Invalid audio diarization output')
  }
  const turns: AudioDiarizationTurn[] = []
  let previousEndMs = 0
  for (const value of raw.slice(0, 64)) {
    if (!value || typeof value !== 'object') throw new Error('Invalid audio diarization turn')
    const turn = value as Record<string, unknown>
    if (
      !Number.isSafeInteger(turn.startMs) ||
      !Number.isSafeInteger(turn.endMs) ||
      (turn.startMs as number) < previousEndMs ||
      (turn.endMs as number) <= (turn.startMs as number) ||
      (turn.endMs as number) > durationMs
    ) {
      throw new Error('Invalid audio diarization turn range')
    }
    let embedding: number[] | undefined
    if (turn.embeddingF32Base64 !== undefined) {
      if (typeof turn.embeddingF32Base64 !== 'string' || turn.embeddingF32Base64.length > 1_100) {
        throw new Error('Invalid speaker embedding')
      }
      const bytes = Buffer.from(turn.embeddingF32Base64, 'base64')
      if (bytes.length !== 192 * 4) throw new Error('Invalid speaker embedding dimensions')
      embedding = Array.from({ length: 192 }, (_, index) => bytes.readFloatLE(index * 4))
      const norm = Math.hypot(...embedding)
      if (!embedding.every(Number.isFinite) || norm < 0.99 || norm > 1.01) {
        throw new Error('Invalid normalized speaker embedding')
      }
    }
    turns.push({
      startMs: turn.startMs as number,
      endMs: turn.endMs as number,
      ...(embedding ? { embedding } : {}),
    })
    previousEndMs = turn.endMs as number
  }
  return { turns }
}

function defaultRuntimeRoot(): string {
  const explicitRoot = process.env.FLOATING_CLOCK_SENSEVOICE_RUNTIME_ROOT?.trim()
  if (explicitRoot) return explicitRoot
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(roaming, 'floating-clock-electron', 'runtimes', 'sensevoice')
}

function defaultRunnerPath(): string {
  const explicitRunner = process.env.FLOATING_CLOCK_SENSEVOICE_RUNNER_PATH?.trim()
  if (explicitRunner) return explicitRunner
  const packagedRoot =
    process.env.FLOATING_CLOCK_RESOURCES_PATH?.trim() ||
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packagedCandidate = packagedRoot
    ? path.join(packagedRoot, 'sensevoice', 'sensevoice_runner.py')
    : ''
  return packagedCandidate && fs.existsSync(packagedCandidate)
    ? packagedCandidate
    : path.join(process.cwd(), 'resources', 'sensevoice', 'sensevoice_runner.py')
}

function appendBounded(current: string, chunk: Buffer, maximum: number): string {
  if (current.length >= maximum) return current
  return (current + chunk.toString('utf8')).slice(0, maximum)
}

function safeChildError(stderr: string): string {
  const normalized = stderr.replaceAll('\u0000', '').trim()
  return normalized ? normalized.slice(-2_000) : 'sensevoice-runtime-failed'
}

export function parseSenseVoiceRichText(rawText: string): AudioSemanticRuntimeOutput {
  const tags = [...rawText.matchAll(SENSEVOICE_TAG_PATTERN)].map((match) => match[1].toLowerCase())
  const language = tags.find((tag) => ['zh', 'en', 'yue', 'ja', 'ko', 'nospeech'].includes(tag))
  const emotionMap: Record<string, string> = {
    neutral: 'neutral',
    happy: 'happy',
    sad: 'sad',
    angry: 'angry',
    fearful: 'fearful',
    disgusted: 'disgusted',
    surprised: 'surprised',
  }
  const eventMap: Record<string, string> = {
    speech: 'speech',
    bgm: 'bgm',
    applause: 'applause',
    laughter: 'laughter',
    cry: 'cry',
    cough: 'cough',
    sneeze: 'sneeze',
  }
  const emotionTag = tags.find((tag) => emotionMap[tag])
  const audioEvents = [...new Set(tags.map((tag) => eventMap[tag]).filter(Boolean))]
  const text = rawText.replace(SENSEVOICE_TAG_PATTERN, ' ').replace(/\s+/g, ' ').trim()
  if (text && !audioEvents.includes('speech')) audioEvents.unshift('speech')
  return {
    text,
    language: language || 'nospeech',
    emotion: emotionTag ? emotionMap[emotionTag] : 'unknown',
    audioEvents,
  }
}

export interface FunAsrAudioSemanticRuntimeOptions {
  runtimeRoot?: string
  runnerPath?: string
  timeoutMs?: number
  expectedFiles?: Readonly<Record<string, number>>
  expectedVadFiles?: Readonly<Record<string, number>>
  expectedSpeakerFiles?: Readonly<Record<string, number>>
}

export class FunAsrAudioSemanticRuntime implements AudioSemanticRuntime {
  readonly adapterId = 'funasr-sensevoice-cpu'
  private readonly runtimeRoot: string
  private readonly runnerPath: string
  private readonly pythonPath: string
  private readonly modelDir: string
  private readonly vadModelDir: string
  private readonly speakerModelDir: string
  private readonly timeoutMs: number
  private readonly expectedFiles: Readonly<Record<string, number>>
  private readonly expectedVadFiles: Readonly<Record<string, number>>
  private readonly expectedSpeakerFiles: Readonly<Record<string, number>>
  private child: ChildProcessWithoutNullStreams | null = null
  private startup: Promise<void> | null = null
  private startupResolve: (() => void) | null = null
  private startupReject: ((error: Error) => void) | null = null
  private stdoutBuffer = ''
  private stderrTail = ''
  private requestSequence = 0
  private readonly pending = new Map<
    number,
    {
      operation: 'transcribe' | 'diarize'
      durationMs: number
      resolve: (value: AudioSemanticRuntimeOutput | AudioDiarizationOutput) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
      abort?: () => void
      signal?: AbortSignal
    }
  >()

  constructor(options: FunAsrAudioSemanticRuntimeOptions = {}) {
    this.runtimeRoot = path.resolve(options.runtimeRoot || defaultRuntimeRoot())
    this.runnerPath = path.resolve(options.runnerPath || defaultRunnerPath())
    this.pythonPath = path.join(
      this.runtimeRoot,
      'venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    )
    this.modelDir = path.join(
      this.runtimeRoot,
      'models',
      'SenseVoiceSmall',
      SENSEVOICE_MODEL_REVISION,
    )
    this.vadModelDir = path.join(this.runtimeRoot, 'models', 'fsmn-vad', FSMN_VAD_MODEL_REVISION)
    this.speakerModelDir = path.join(this.runtimeRoot, 'models', 'campplus', CAMPLUS_MODEL_REVISION)
    this.timeoutMs = options.timeoutMs || SENSEVOICE_DEFAULT_TIMEOUT_MS
    this.expectedFiles = options.expectedFiles || SENSEVOICE_CRITICAL_FILES
    this.expectedVadFiles = options.expectedVadFiles || FSMN_VAD_CRITICAL_FILES
    this.expectedSpeakerFiles = options.expectedSpeakerFiles || CAMPLUS_CRITICAL_FILES
  }

  inspect(): AudioSemanticRuntimeStatus {
    if (!fs.existsSync(this.pythonPath)) {
      return { adapterId: this.adapterId, state: 'not-installed', reason: 'audio-runtime-missing' }
    }
    if (!fs.existsSync(this.runnerPath)) {
      return { adapterId: this.adapterId, state: 'unavailable', reason: 'audio-runner-missing' }
    }
    for (const [fileName, expectedBytes] of Object.entries(this.expectedFiles)) {
      try {
        const stat = fs.statSync(path.join(this.modelDir, fileName))
        if (!stat.isFile() || stat.size !== expectedBytes) {
          return { adapterId: this.adapterId, state: 'error', reason: 'audio-model-corrupt' }
        }
      } catch {
        return { adapterId: this.adapterId, state: 'not-installed', reason: 'audio-model-missing' }
      }
    }
    return { adapterId: this.adapterId, state: 'ready', model: { ...SENSEVOICE_MODEL_IDENTITY } }
  }

  inspectDiarization(): AudioDiarizationRuntimeStatus {
    if (!fs.existsSync(this.pythonPath) || !fs.existsSync(this.runnerPath)) {
      return { state: 'unavailable', reason: 'audio-diarization-runtime-missing' }
    }
    for (const [root, files] of [
      [this.vadModelDir, this.expectedVadFiles],
      [this.speakerModelDir, this.expectedSpeakerFiles],
    ] as const) {
      for (const [fileName, expectedBytes] of Object.entries(files)) {
        try {
          const stat = fs.statSync(path.join(root, fileName))
          if (!stat.isFile() || stat.size !== expectedBytes) {
            return { state: 'error', reason: 'audio-diarization-model-corrupt' }
          }
        } catch {
          return { state: 'not-installed', reason: 'audio-diarization-model-missing' }
        }
      }
    }
    return {
      state: 'ready',
      vadModel: { modelId: 'fsmn-vad', modelRevision: `modelscope-${FSMN_VAD_MODEL_REVISION}` },
      speakerModel: { ...CAMPLUS_SPEAKER_IDENTITY },
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private resetChild(error: Error): void {
    const child = this.child
    this.child = null
    this.startup = null
    this.stdoutBuffer = ''
    this.startupReject?.(error)
    this.startupResolve = null
    this.startupReject = null
    this.rejectPending(error)
    child?.kill()
  }

  private handleResponseLine(line: string): void {
    let response: {
      type?: unknown
      id?: unknown
      rawText?: unknown
      turns?: unknown
      error?: unknown
    }
    try {
      response = JSON.parse(line) as typeof response
    } catch {
      return
    }
    if (response.type === 'ready') {
      this.startupResolve?.()
      this.startupResolve = null
      this.startupReject = null
      return
    }
    if (!Number.isSafeInteger(response.id)) return
    const id = response.id as number
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort)
    if (
      response.type === 'result' &&
      pending.operation === 'transcribe' &&
      typeof response.rawText === 'string'
    ) {
      pending.resolve(parseSenseVoiceRichText(response.rawText))
      return
    }
    if (response.type === 'diarization' && pending.operation === 'diarize') {
      pending.resolve(parseAudioDiarizationTurns(response.turns, pending.durationMs))
      return
    }
    const reason =
      typeof response.error === 'string'
        ? response.error.slice(0, 2_000)
        : 'sensevoice-runtime-failed'
    pending.reject(new Error(reason))
  }

  private ensureChild(): Promise<void> {
    if (this.child && this.startup) return this.startup
    const diarizationStatus = this.inspectDiarization()
    const childArguments = [this.runnerPath, '--model-dir', this.modelDir]
    if (diarizationStatus.state === 'ready') {
      childArguments.push('--vad-dir', this.vadModelDir, '--speaker-dir', this.speakerModelDir)
    }
    const child = spawn(this.pythonPath, childArguments, {
      cwd: this.runtimeRoot,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        PYTHONNOUSERSITE: '1',
        PYTHONUTF8: '1',
      },
    })
    this.child = child
    this.stderrTail = ''
    this.startup = new Promise<void>((resolve, reject) => {
      this.startupResolve = resolve
      this.startupReject = reject
    })
    const startupTimer = setTimeout(
      () => this.resetChild(new Error('sensevoice-runtime-startup-timeout')),
      this.timeoutMs,
    )
    void this.startup.finally(() => clearTimeout(startupTimer)).catch(() => {})
    child.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8')
      if (this.stdoutBuffer.length > SENSEVOICE_STDOUT_LIMIT) {
        this.resetChild(new Error('sensevoice-runtime-output-too-large'))
        return
      }
      let newline = this.stdoutBuffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.stdoutBuffer.slice(0, newline).trim()
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
        if (line) this.handleResponseLine(line)
        newline = this.stdoutBuffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = appendBounded(this.stderrTail, chunk, SENSEVOICE_STDERR_LIMIT)
    })
    child.once('error', (error) => this.resetChild(error))
    child.once('close', (code) => {
      if (this.child !== child) return
      this.resetChild(
        new Error(code === 0 ? 'sensevoice-runtime-closed' : safeChildError(this.stderrTail)),
      )
    })
    return this.startup
  }

  async transcribe(
    request: AudioSemanticRuntimeRequest,
    signal?: AbortSignal,
  ): Promise<AudioSemanticRuntimeOutput> {
    return (await this.runRequest('transcribe', request, signal)) as AudioSemanticRuntimeOutput
  }

  async diarize(
    request: AudioSemanticRuntimeRequest,
    signal?: AbortSignal,
  ): Promise<AudioDiarizationOutput> {
    const status = this.inspectDiarization()
    if (status.state !== 'ready') {
      throw new Error(status.reason || 'audio-diarization-model-missing')
    }
    return (await this.runRequest('diarize', request, signal)) as AudioDiarizationOutput
  }

  private async runRequest(
    operation: 'transcribe' | 'diarize',
    request: AudioSemanticRuntimeRequest,
    signal?: AbortSignal,
  ): Promise<AudioSemanticRuntimeOutput | AudioDiarizationOutput> {
    if (signal?.aborted) throw new Error('Audio semantic runtime request aborted')
    validatePcm(request)
    const status = this.inspect()
    if (status.state !== 'ready') throw new Error(status.reason || 'audio-model-missing')
    await this.ensureChild()
    const child = this.child
    if (!child) throw new Error('sensevoice-runtime-closed')
    const id = ++this.requestSequence
    return await new Promise<AudioSemanticRuntimeOutput | AudioDiarizationOutput>(
      (resolve, reject) => {
        const abort = signal
          ? () => this.resetChild(new Error('Audio semantic runtime request aborted'))
          : undefined
        const timer = setTimeout(
          () => this.resetChild(new Error('sensevoice-runtime-timeout')),
          this.timeoutMs,
        )
        this.pending.set(id, {
          operation,
          durationMs: request.authority.endMs - request.authority.startMs,
          resolve,
          reject,
          timer,
          abort,
          signal,
        })
        if (abort) signal?.addEventListener('abort', abort, { once: true })
        child.stdin.write(
          `${JSON.stringify({ id, operation, pcm16Base64: request.pcm16Base64 })}\n`,
          (error) => {
            if (error) this.resetChild(error)
          },
        )
      },
    )
  }

  async dispose(): Promise<void> {
    if (!this.child) return
    this.resetChild(new Error('sensevoice-runtime-disposed'))
  }
}

const FAKE_MODEL: AudioSemanticModelIdentity = {
  modelId: 'sensevoice-fake',
  modelRevision: 'fixture-v1',
  runtime: 'fake',
  quantization: 'none',
}

export type FakeAudioSemanticHandler = (
  request: AudioSemanticRuntimeRequest,
  callIndex: number,
) => AudioSemanticRuntimeOutput | Promise<AudioSemanticRuntimeOutput>

export class FakeAudioSemanticRuntime implements AudioSemanticRuntime {
  readonly adapterId = 'fake'
  readonly requests: AudioSemanticRuntimeRequest[] = []

  constructor(
    private readonly handler: FakeAudioSemanticHandler = () => ({
      text: 'fixture speech',
      language: 'zh',
      emotion: 'neutral',
      audioEvents: ['speech'],
    }),
  ) {}

  inspect(): AudioSemanticRuntimeStatus {
    return { adapterId: this.adapterId, state: 'ready', model: { ...FAKE_MODEL } }
  }

  async transcribe(
    request: AudioSemanticRuntimeRequest,
    signal?: AbortSignal,
  ): Promise<AudioSemanticRuntimeOutput> {
    if (signal?.aborted) throw new Error('Audio semantic runtime request aborted')
    validatePcm(request)
    const callIndex = this.requests.length
    this.requests.push(request)
    return await this.handler(request, callIndex)
  }
}

export class MissingAudioSemanticRuntime implements AudioSemanticRuntime {
  readonly adapterId = 'none'

  inspect(): AudioSemanticRuntimeStatus {
    return { adapterId: this.adapterId, state: 'not-installed', reason: 'audio-model-missing' }
  }

  transcribe(): never {
    throw new Error('audio-model-missing')
  }
}

export class AudioSemanticRuntimeRegistry {
  constructor(private runtime: AudioSemanticRuntime = new MissingAudioSemanticRuntime()) {}

  get(): AudioSemanticRuntime {
    return this.runtime
  }

  async replace(next: AudioSemanticRuntime): Promise<void> {
    if (next === this.runtime) return
    const previous = this.runtime
    this.runtime = next
    await previous.dispose?.()
  }
}
