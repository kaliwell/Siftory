import path from 'path'
import readline from 'readline'
import { getMediaSearchDir } from './mediaCacheService'
import { extractAudioEvidencePcm16 } from './audioEvidenceService'
import { AudioSemanticPipelineService } from './audioSemanticPipelineService'
import { PersistentAudioSpeakerClusterer } from './audioSpeakerClusteringService'
import {
  AudioSemanticJobService,
  type AudioSemanticBuildJobRecord,
  type AudioSemanticBuildVideoInput,
} from './audioSemanticJobService'
import {
  CAMPLUS_SPEAKER_IDENTITY,
  FunAsrAudioSemanticRuntime,
  SENSEVOICE_MODEL_IDENTITY,
  type AudioDiarizationTurn,
} from './audioSemanticRuntime'
import { saveAudioSemanticTranscript } from './transcriptService'

interface StartCommand {
  type: 'start'
  videos: AudioSemanticBuildVideoInput[]
}

interface ResumeCommand {
  type: 'resume'
  jobId: string
}

interface StopCommand {
  type: 'stop'
  jobId: string
}

type AudioSemanticChildCommand = StartCommand | ResumeCommand | StopCommand

const MAX_COMMAND_CHARS = 4 * 1024 * 1024
const jobService = new AudioSemanticJobService(path.join(getMediaSearchDir(), 'audio-semantic'))
let running = false
let stopRequested = false
let runtime: FunAsrAudioSemanticRuntime | null = null

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function publicJob(job: AudioSemanticBuildJobRecord) {
  return {
    jobId: job.jobId,
    generationId: job.generationId,
    state: job.state,
    totalVideos: job.totalVideos,
    completedVideos: job.completedVideos,
    totalSegments: job.totalSegments,
    completedSegments: job.completedSegments,
    failedSegments: job.failedSegments,
    currentVideoId: job.currentVideoId,
    currentStartMs: job.currentStartMs,
    currentEndMs: job.currentEndMs,
    lastError: job.lastError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function emitJob(job: AudioSemanticBuildJobRecord): void {
  send({ type: 'progress', job: publicJob(job) })
}

function isExtractionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ffmpeg|authoritative video|audio extraction/i.test(message)
}

function slicePcm16(
  pcm16Base64: string,
  turn: Pick<AudioDiarizationTurn, 'startMs' | 'endMs'>,
): string {
  const pcm = Buffer.from(pcm16Base64, 'base64')
  const startByte = Math.max(0, Math.floor(turn.startMs * 32) & ~1)
  const endByte = Math.min(pcm.length, Math.ceil(turn.endMs * 32) & ~1)
  if (endByte <= startByte) throw new Error('Invalid diarized PCM16 turn')
  return pcm.subarray(startByte, endByte).toString('base64')
}

async function runJob(initial: AudioSemanticBuildJobRecord): Promise<void> {
  if (running) throw new Error('audio-semantic-job-already-running')
  running = true
  stopRequested = false
  const activeRuntime = new FunAsrAudioSemanticRuntime()
  runtime = activeRuntime
  let job = jobService.markRunning(initial.jobId)
  emitJob(job)
  let consecutiveInferenceFailures = 0
  const clusterers = new Map<string, PersistentAudioSpeakerClusterer>()
  const existingTurnKeys = new Map<string, Set<string>>()
  try {
    const runtimeStatus = activeRuntime.inspect()
    if (runtimeStatus.state !== 'ready') {
      throw new Error(runtimeStatus.reason || 'audio-model-missing')
    }
    while (job.videoCursor < job.videos.length) {
      if (stopRequested) {
        job = jobService.markStopped(job.jobId)
        emitJob(job)
        return
      }
      const video = job.videos[job.videoCursor]
      const chunk = video?.chunks[job.segmentCursor]
      if (!video || !chunk) throw new Error('audio-semantic-job-cursor-invalid')
      const pipeline = new AudioSemanticPipelineService(activeRuntime, (record) => {
        jobService.stageRecord(job.jobId, record)
      })
      let segmentError: unknown
      try {
        const evidence = extractAudioEvidencePcm16({
          videoPath: video.videoPath,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
        })
        const chunkAuthority = {
          generationId: job.generationId,
          assetId: video.assetId,
          videoId: video.videoId,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          sourceFingerprint: video.sourceFingerprint,
          model: job.model,
          createdAt: job.createdAt,
        }
        const diarizationStatus = activeRuntime.inspectDiarization()
        const diarization =
          diarizationStatus.state === 'ready'
            ? await activeRuntime.diarize({
                authority: chunkAuthority,
                pcm16Base64: evidence.pcm16Base64,
                sampleRate: 16_000,
                channels: 1,
              })
            : { turns: [] }
        const turns: AudioDiarizationTurn[] = diarization.turns.length
          ? diarization.turns
          : [{ startMs: 0, endMs: chunk.endMs - chunk.startMs }]
        let knownTurns = existingTurnKeys.get(video.videoId)
        if (!knownTurns) {
          knownTurns = new Set(
            jobService
              .recordsForVideo(job.jobId, video.videoId)
              .map((record) => `${record.startMs}:${record.endMs}`),
          )
          existingTurnKeys.set(video.videoId, knownTurns)
        }
        for (const turn of turns) {
          const startMs = chunk.startMs + turn.startMs
          const endMs = chunk.startMs + turn.endMs
          const turnKey = `${startMs}:${endMs}`
          if (knownTurns.has(turnKey)) continue
          let speakerId: string | undefined
          if (turn.embedding && diarizationStatus.state === 'ready') {
            let clusterer = clusterers.get(video.videoId)
            if (!clusterer) {
              clusterer = new PersistentAudioSpeakerClusterer(
                path.join(jobService.root, 'speaker-states'),
                job.jobId,
                video.videoId,
                CAMPLUS_SPEAKER_IDENTITY,
              )
              clusterers.set(video.videoId, clusterer)
            }
            speakerId = clusterer.assign(`turn-${startMs}-${endMs}`, turn.embedding)
          }
          await pipeline.process({
            authority: {
              ...chunkAuthority,
              startMs,
              endMs,
              ...(speakerId ? { speakerModel: CAMPLUS_SPEAKER_IDENTITY } : {}),
            },
            pcm16Base64: slicePcm16(evidence.pcm16Base64, turn),
            ...(speakerId ? { speakerId } : {}),
          })
          knownTurns.add(turnKey)
        }
        consecutiveInferenceFailures = 0
      } catch (error) {
        segmentError = error
        consecutiveInferenceFailures += 1
      }

      const videoFinished = job.segmentCursor + 1 >= video.chunks.length
      if (videoFinished) {
        const records = jobService.recordsForVideo(job.jobId, video.videoId)
        if (records.length > 0) saveAudioSemanticTranscript(video.videoPath, records)
      }
      if (segmentError && isExtractionFailure(segmentError)) {
        consecutiveInferenceFailures = 0
        job = jobService.skipCurrentVideo(job.jobId, segmentError)
      } else {
        job = jobService.advanceSegment(job.jobId, segmentError)
      }
      emitJob(job)
      if (consecutiveInferenceFailures >= 3) {
        throw new Error('audio-semantic-consecutive-inference-failures')
      }
    }
    job = jobService.markCompleted(job.jobId)
    emitJob(job)
  } catch (error) {
    job = jobService.markFailed(job.jobId, error)
    emitJob(job)
  } finally {
    await activeRuntime.dispose()
    runtime = null
    running = false
    stopRequested = false
  }
}

function handleCommand(command: AudioSemanticChildCommand): void {
  if (command.type === 'stop') {
    const current = jobService.load()
    if (!current || current.jobId !== command.jobId) {
      send({ type: 'error', error: 'audio-semantic-job-not-found' })
      return
    }
    stopRequested = true
    send({ type: 'stop-requested', jobId: command.jobId })
    return
  }
  if (running) {
    send({ type: 'error', error: 'audio-semantic-job-already-running' })
    return
  }
  try {
    const job =
      command.type === 'start'
        ? jobService.create(command.videos, SENSEVOICE_MODEL_IDENTITY)
        : jobService.load()
    if (!job || (command.type === 'resume' && job.jobId !== command.jobId)) {
      throw new Error('audio-semantic-job-not-found')
    }
    emitJob(job)
    void runJob(job)
  } catch (error) {
    send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  if (!line || line.length > MAX_COMMAND_CHARS) {
    send({ type: 'error', error: 'invalid-audio-semantic-command' })
    return
  }
  try {
    handleCommand(JSON.parse(line) as AudioSemanticChildCommand)
  } catch {
    send({ type: 'error', error: 'invalid-audio-semantic-command' })
  }
})

process.once('SIGTERM', () => {
  stopRequested = true
  void runtime?.dispose()
})

send({ type: 'ready' })
