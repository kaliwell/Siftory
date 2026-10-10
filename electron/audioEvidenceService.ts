import fs from 'fs'
import { spawnSync, type SpawnSyncReturns } from 'child_process'
import { AUDIO_SEMANTIC_MAX_CHUNK_MS } from '../shared/audioSemantic'
import { getFfmpegStatus } from './ffmpegService'

const SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 2

export interface AudioEvidenceChunk {
  startMs: number
  endMs: number
}

export function planAudioEvidenceChunks(durationMs: number): AudioEvidenceChunk[] {
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1_000 ||
    durationMs > 7 * 24 * 60 * 60_000
  ) {
    throw new Error('Invalid authoritative audio duration')
  }
  const chunks: AudioEvidenceChunk[] = []
  for (let startMs = 0; startMs < durationMs; startMs += AUDIO_SEMANTIC_MAX_CHUNK_MS) {
    const endMs = Math.min(durationMs, startMs + AUDIO_SEMANTIC_MAX_CHUNK_MS)
    if (endMs - startMs >= 1_000) chunks.push({ startMs, endMs })
  }
  return chunks
}

export interface AudioEvidenceExtractRequest extends AudioEvidenceChunk {
  videoPath: string
}

interface AudioEvidenceDependencies {
  ffmpegCommand?: string
  spawn?: (
    command: string,
    args: string[],
    options: { encoding: null; timeout: number; windowsHide: true; maxBuffer: number },
  ) => SpawnSyncReturns<Buffer>
}

export function extractAudioEvidencePcm16(
  request: AudioEvidenceExtractRequest,
  dependencies: AudioEvidenceDependencies = {},
): { pcm16Base64: string; sampleRate: 16_000; channels: 1 } {
  if (!fs.existsSync(request.videoPath) || !fs.statSync(request.videoPath).isFile()) {
    throw new Error('Authoritative video is unavailable')
  }
  if (
    !Number.isSafeInteger(request.startMs) ||
    !Number.isSafeInteger(request.endMs) ||
    request.startMs < 0 ||
    request.endMs <= request.startMs ||
    request.endMs - request.startMs > AUDIO_SEMANTIC_MAX_CHUNK_MS
  ) {
    throw new Error('Invalid bounded audio segment')
  }
  const command = dependencies.ffmpegCommand ?? getFfmpegStatus().ffmpeg.command
  if (!command) throw new Error('ffmpeg is not available')
  const durationMs = request.endMs - request.startMs
  const maximumPcmBytes = Math.ceil((durationMs * SAMPLE_RATE * BYTES_PER_SAMPLE) / 1_000)
  const run = dependencies.spawn ?? spawnSync
  const result = run(
    command,
    [
      '-v',
      'error',
      '-ss',
      (request.startMs / 1_000).toFixed(3),
      '-t',
      (durationMs / 1_000).toFixed(3),
      '-i',
      request.videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      's16le',
      'pipe:1',
    ],
    {
      encoding: null,
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: maximumPcmBytes + 64 * 1024,
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('ffmpeg audio extraction failed')
  const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0)
  if (!output.length || output.length > maximumPcmBytes + 32_000) {
    throw new Error('ffmpeg returned invalid bounded PCM16 audio')
  }
  const boundedOutput =
    output.length > maximumPcmBytes ? output.subarray(0, maximumPcmBytes) : output
  return { pcm16Base64: boundedOutput.toString('base64'), sampleRate: 16_000, channels: 1 }
}
