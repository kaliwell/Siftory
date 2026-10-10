// ── Transcript / Subtitle Service ──────────────────────────
// Extracts embedded subtitles from video files via ffmpeg,
// builds a searchable text index, and fuses text + visual
// search results for multimodal queries.

import fs from 'fs'
import path from 'path'
import { getMediaSearchDir, ensureMediaSearchDirs } from './mediaCacheService'
import { detectSubtitleStreams, extractSubtitleTrack, parseSrt } from './ffmpegService'
import type { SubtitleSegment } from './ffmpegService'
import type { MediaSearchVideoFrameRecord } from '../shared/ipc-contract'

type AudioSemanticEmotion =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'fearful'
  | 'disgusted'
  | 'surprised'
  | 'unknown'
type AudioSemanticEventLabel =
  | 'speech'
  | 'bgm'
  | 'applause'
  | 'laughter'
  | 'cry'
  | 'cough'
  | 'sneeze'
  | 'unknown'
type AudioSemanticLanguage = 'zh' | 'en' | 'yue' | 'ja' | 'ko' | 'nospeech'

interface AudioSemanticTranscriptRecord {
  segmentId: string
  generationId: string
  videoId: string
  startMs: number
  endMs: number
  text: string
  language: AudioSemanticLanguage
  emotion: AudioSemanticEmotion
  audioEvents: Array<{ label: AudioSemanticEventLabel }>
  transcriptRef: string
  speaker?: { localId: string }
  modelId: string
  modelRevision: string
}

// ── Types ──────────────────────────────────────────────────

export interface TranscriptSegment extends SubtitleSegment {
  emotion?: AudioSemanticEmotion
  audioEvents?: AudioSemanticEventLabel[]
  speakerId?: string
  transcriptRef?: string
}

export interface VideoTranscript {
  videoId: string
  videoPath: string
  source?: 'embedded-subtitle' | 'sensevoice-asr'
  language?: string | AudioSemanticLanguage
  segments: TranscriptSegment[]
  modelId?: string
  modelRevision?: string
  generationId?: string
  extractedAt: number
}

export interface TranscriptSearchResult {
  videoId: string
  videoPath: string
  timestampMs: number
  text: string
  score: number
  matchStartMs: number
  matchEndMs: number
  source: 'embedded-subtitle' | 'sensevoice-asr'
  language?: string
  emotion?: AudioSemanticEmotion
  audioEvents?: AudioSemanticEventLabel[]
  speakerId?: string
  modelId?: string
  modelRevision?: string
}

export interface MultimodalSearchResult {
  frame: MediaSearchVideoFrameRecord
  visualScore: number
  textScore: number
  fusedScore: number
  matchedText?: string
}

// ── Paths ──────────────────────────────────────────────────

function getTranscriptDir(): string {
  ensureMediaSearchDirs()
  return path.join(getMediaSearchDir(), 'transcripts')
}

function getTranscriptPath(videoId: string): string {
  return path.join(getTranscriptDir(), `${videoId}.json`)
}

export interface AudioSemanticTranscriptStatsSnapshot {
  videos: number
  segments: number
  pending: boolean
}

interface AudioSemanticTranscriptInventory {
  signature: string
  files: string[]
}

const AUDIO_TRANSCRIPT_STATS_SCHEMA = 1
const AUDIO_TRANSCRIPT_STATS_CONCURRENCY = 8
let audioTranscriptStatsCache: {
  signature: string
  value: AudioSemanticTranscriptStatsSnapshot
} | null = null
let audioTranscriptStatsRebuild: {
  signature: string
  promise: Promise<void>
} | null = null

export function invalidateTranscriptCaches(): void {
  audioTranscriptStatsCache = null
  audioTranscriptStatsRebuild = null
}

function audioTranscriptStatsPath(): string {
  return path.join(getMediaSearchDir(), 'audio-semantic', 'transcript-stats.json')
}

function audioTranscriptInventory(): AudioSemanticTranscriptInventory {
  const dir = getTranscriptDir()
  try {
    const files = fs
      .readdirSync(dir)
      .filter((entry) => entry.startsWith('asr-') && entry.endsWith('.json'))
      .sort()
    const directoryMtimeMs = fs.statSync(dir).mtimeMs
    return {
      signature: `${directoryMtimeMs}:${files.length}`,
      files,
    }
  } catch {
    return { signature: 'missing:0', files: [] }
  }
}

function readPersistedAudioTranscriptStats(
  signature: string,
): AudioSemanticTranscriptStatsSnapshot | null {
  try {
    const filePath = audioTranscriptStatsPath()
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size > 16 * 1024) return null
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
    if (
      value.schemaVersion !== AUDIO_TRANSCRIPT_STATS_SCHEMA ||
      value.signature !== signature ||
      !Number.isSafeInteger(value.videos) ||
      !Number.isSafeInteger(value.segments) ||
      Number(value.videos) < 0 ||
      Number(value.segments) < 0
    ) {
      return null
    }
    return {
      videos: Number(value.videos),
      segments: Number(value.segments),
      pending: false,
    }
  } catch {
    return null
  }
}

function persistAudioTranscriptStats(
  signature: string,
  value: AudioSemanticTranscriptStatsSnapshot,
): void {
  try {
    const filePath = audioTranscriptStatsPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const temporaryPath = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify({
        schemaVersion: AUDIO_TRANSCRIPT_STATS_SCHEMA,
        signature,
        videos: value.videos,
        segments: value.segments,
        updatedAt: Date.now(),
      }),
      'utf8',
    )
    fs.renameSync(temporaryPath, filePath)
  } catch {
    // The summary is derived data; a later status request can rebuild it again.
  }
}

async function rebuildAudioTranscriptStats(
  inventory: AudioSemanticTranscriptInventory,
): Promise<void> {
  // Yield before opening transcript files so the status IPC can return and the
  // first panel frame can paint even on antivirus-heavy Windows systems.
  await new Promise<void>((resolve) => setImmediate(resolve))
  const videoIds = new Set<string>()
  let segments = 0
  for (
    let offset = 0;
    offset < inventory.files.length;
    offset += AUDIO_TRANSCRIPT_STATS_CONCURRENCY
  ) {
    const batch = inventory.files.slice(offset, offset + AUDIO_TRANSCRIPT_STATS_CONCURRENCY)
    const transcripts = await Promise.all(
      batch.map(async (entry) => {
        try {
          const raw = await fs.promises.readFile(path.join(getTranscriptDir(), entry), 'utf8')
          return JSON.parse(raw) as Partial<VideoTranscript>
        } catch {
          return null
        }
      }),
    )
    for (const transcript of transcripts) {
      if (
        transcript?.source === 'sensevoice-asr' &&
        typeof transcript.videoId === 'string' &&
        Array.isArray(transcript.segments)
      ) {
        videoIds.add(transcript.videoId)
        segments += transcript.segments.length
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  const current = audioTranscriptInventory()
  if (current.signature !== inventory.signature) return
  const value = { videos: videoIds.size, segments, pending: false }
  audioTranscriptStatsCache = { signature: current.signature, value }
  persistAudioTranscriptStats(current.signature, value)
}

function scheduleAudioTranscriptStatsRebuild(inventory: AudioSemanticTranscriptInventory): void {
  if (audioTranscriptStatsRebuild?.signature === inventory.signature) return
  const promise = rebuildAudioTranscriptStats(inventory)
    .catch(() => {
      if (
        audioTranscriptStatsCache?.signature === inventory.signature &&
        audioTranscriptStatsCache.value.pending
      ) {
        audioTranscriptStatsCache = {
          signature: inventory.signature,
          value: { ...audioTranscriptStatsCache.value, pending: false },
        }
      }
    })
    .finally(() => {
      if (audioTranscriptStatsRebuild?.promise === promise) audioTranscriptStatsRebuild = null
    })
  audioTranscriptStatsRebuild = { signature: inventory.signature, promise }
}

/**
 * Fast UI snapshot. A missing or stale summary is rebuilt cooperatively in the
 * background instead of synchronously opening every transcript from Electron's
 * main thread.
 */
export function getAudioSemanticTranscriptStatsSnapshot(
  options: { force?: boolean } = {},
): AudioSemanticTranscriptStatsSnapshot {
  const inventory = audioTranscriptInventory()
  if (!options.force && audioTranscriptStatsCache?.signature === inventory.signature) {
    return audioTranscriptStatsCache.value
  }
  if (!options.force) {
    const persisted = readPersistedAudioTranscriptStats(inventory.signature)
    if (persisted) {
      audioTranscriptStatsCache = { signature: inventory.signature, value: persisted }
      return persisted
    }
  }
  if (inventory.files.length === 0) {
    const value = { videos: 0, segments: 0, pending: false }
    audioTranscriptStatsCache = { signature: inventory.signature, value }
    return value
  }
  const previous = audioTranscriptStatsCache?.value
  const value = {
    videos: previous?.videos ?? inventory.files.length,
    segments: previous?.segments ?? 0,
    pending: true,
  }
  audioTranscriptStatsCache = { signature: inventory.signature, value }
  scheduleAudioTranscriptStatsRebuild(inventory)
  return value
}

// ── Subtitle extraction ────────────────────────────────────

/** Extract embedded subtitles from a video and store as transcript. */
export function extractVideoSubtitles(
  videoId: string,
  videoPath: string,
): {
  ok: boolean
  transcript?: VideoTranscript
  error?: string
} {
  if (!fs.existsSync(videoPath)) {
    return { ok: false, error: 'Video file not found' }
  }

  const detected = detectSubtitleStreams(videoPath)
  if (!detected.ok || !detected.streams || detected.streams.length === 0) {
    return { ok: false, error: detected.error || 'No embedded subtitle streams found' }
  }

  // Prefer first stream, or first with language tag
  const stream = detected.streams.find((s) => s.language) ?? detected.streams[0]
  const srtPath = path.join(getTranscriptDir(), `${videoId}.srt`)
  const extracted = extractSubtitleTrack(videoPath, stream.index, srtPath)
  if (!extracted.ok || !extracted.path) {
    return { ok: false, error: extracted.error || 'Failed to extract subtitle track' }
  }

  let srtText: string
  try {
    srtText = fs.readFileSync(extracted.path, 'utf-8')
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read extracted SRT: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const segments = parseSrt(srtText)
  if (segments.length === 0) {
    return { ok: false, error: 'SRT parsed but contained no valid segments' }
  }

  const transcript: VideoTranscript = {
    videoId,
    videoPath,
    source: 'embedded-subtitle',
    language: stream.language,
    segments,
    extractedAt: Date.now(),
  }

  try {
    fs.writeFileSync(getTranscriptPath(videoId), JSON.stringify(transcript), 'utf-8')
  } catch (err) {
    return {
      ok: false,
      error: `Failed to save transcript: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  return { ok: true, transcript }
}

export function saveAudioSemanticTranscript(
  videoPath: string,
  records: AudioSemanticTranscriptRecord[],
): VideoTranscript {
  if (!records.length) throw new Error('Audio semantic transcript has no segments')
  const first = records[0]
  if (
    !/^[a-z0-9._:-]{1,256}$/i.test(first.videoId) ||
    records.some(
      (record) =>
        record.videoId !== first.videoId ||
        record.generationId !== first.generationId ||
        record.modelId !== first.modelId ||
        record.modelRevision !== first.modelRevision,
    )
  ) {
    throw new Error('Audio semantic transcript authority is inconsistent')
  }
  const transcript: VideoTranscript = {
    videoId: first.videoId,
    videoPath,
    source: 'sensevoice-asr',
    language: first.language,
    modelId: first.modelId,
    modelRevision: first.modelRevision,
    generationId: first.generationId,
    segments: records
      .map((record) => ({
        startMs: record.startMs,
        endMs: record.endMs,
        text: record.text,
        emotion: record.emotion,
        audioEvents: record.audioEvents.map((event) => event.label),
        ...(record.speaker ? { speakerId: record.speaker.localId } : {}),
        transcriptRef: record.transcriptRef,
      }))
      .sort((left, right) => left.startMs - right.startMs),
    extractedAt: Date.now(),
  }
  const transcriptPath = path.join(getTranscriptDir(), `asr-${first.videoId}.json`)
  const temporaryPath = `${transcriptPath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(transcript), 'utf8')
  fs.renameSync(temporaryPath, transcriptPath)
  return transcript
}

/** Load a stored transcript for a video. */
export function loadTranscript(videoId: string): VideoTranscript | null {
  try {
    const p = getTranscriptPath(videoId)
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as VideoTranscript
  } catch {
    return null
  }
}

/** Check if subtitles are available for a video. */
export function hasSubtitles(videoId: string): boolean {
  return loadTranscript(videoId) !== null
}

/** True when at least one persisted transcript can participate in unified search. */
export function hasTranscriptIndex(): boolean {
  const dir = getTranscriptDir()
  try {
    return fs.readdirSync(dir).some((entry) => entry.endsWith('.json'))
  } catch {
    return false
  }
}

export function getAudioSemanticTranscriptStats(): { videos: number; segments: number } {
  const dir = getTranscriptDir()
  try {
    const transcripts = fs
      .readdirSync(dir)
      .filter((entry) => entry.startsWith('asr-') && entry.endsWith('.json'))
      .map((entry) => loadTranscript(path.basename(entry, '.json')))
      .filter((entry): entry is VideoTranscript => entry?.source === 'sensevoice-asr')
    return {
      videos: new Set(transcripts.map((entry) => entry.videoId)).size,
      segments: transcripts.reduce((sum, entry) => sum + entry.segments.length, 0),
    }
  } catch {
    return { videos: 0, segments: 0 }
  }
}

// ── Text search ────────────────────────────────────────────

function tokenizeText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 1)
}

function searchableSegmentText(segment: TranscriptSegment): string {
  return [segment.text, segment.emotion, ...(segment.audioEvents ?? [])].filter(Boolean).join(' ')
}

function bm25Score(
  termFreq: number,
  docLength: number,
  avgDocLength: number,
  docFreq: number,
  totalDocs: number,
): number {
  const k1 = 1.2
  const b = 0.75
  const idf = Math.log((totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1)
  const tfNorm = (termFreq * (k1 + 1)) / (termFreq + k1 * (1 - b + b * (docLength / avgDocLength)))
  return idf * tfNorm
}

/** Search transcripts for a text query across all indexed videos. */
export function searchTranscripts(
  query: string,
  topK = 50,
  options: { acceptVideo?: (videoId: string, videoPath: string) => boolean } = {},
): TranscriptSearchResult[] {
  const tokens = tokenizeText(query)
  if (tokens.length === 0) return []

  const dir = getTranscriptDir()
  if (!fs.existsSync(dir)) return []

  // Collect all transcripts
  const transcripts: VideoTranscript[] = []
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    const t = loadTranscript(path.basename(entry, '.json'))
    if (
      t &&
      t.segments.length > 0 &&
      (!options.acceptVideo || options.acceptVideo(t.videoId, t.videoPath))
    ) {
      transcripts.push(t)
    }
  }
  if (transcripts.length === 0) return []

  // Build doc-level term stats
  const docLengths = transcripts.map((t) => t.segments.reduce((sum, s) => sum + s.text.length, 0))
  const avgDocLength = docLengths.reduce((a, b) => a + b, 0) / docLengths.length

  const results: TranscriptSearchResult[] = []

  for (let di = 0; di < transcripts.length; di++) {
    const t = transcripts[di]
    const docText = t.segments.map((s) => searchableSegmentText(s).toLowerCase()).join(' ')
    let docScore = 0
    for (const token of tokens) {
      const tf = (
        docText.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []
      ).length
      if (tf === 0) continue
      let df = 0
      for (const t2 of transcripts) {
        if (t2.segments.some((s) => searchableSegmentText(s).toLowerCase().includes(token))) df++
      }
      docScore += bm25Score(tf, docLengths[di], avgDocLength, df, transcripts.length)
    }
    if (docScore <= 0) continue

    // Find best-matching segment within the doc
    for (const seg of t.segments) {
      const segText = searchableSegmentText(seg).toLowerCase()
      let segScore = 0
      for (const token of tokens) {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const matches = segText.match(new RegExp(escaped, 'gi'))
        if (matches) segScore += matches.length
      }
      if (segScore > 0) {
        results.push({
          videoId: t.videoId,
          videoPath: t.videoPath,
          timestampMs: seg.startMs,
          text: seg.text,
          score: docScore * (segScore / tokens.length),
          matchStartMs: seg.startMs,
          matchEndMs: seg.endMs,
          source: t.source === 'sensevoice-asr' ? 'sensevoice-asr' : 'embedded-subtitle',
          ...(t.language ? { language: t.language } : {}),
          ...(seg.emotion ? { emotion: seg.emotion } : {}),
          ...(seg.audioEvents?.length ? { audioEvents: seg.audioEvents } : {}),
          ...(seg.speakerId ? { speakerId: seg.speakerId } : {}),
          ...(t.modelId ? { modelId: t.modelId } : {}),
          ...(t.modelRevision ? { modelRevision: t.modelRevision } : {}),
        })
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, topK)
}

// ── Multimodal fusion ──────────────────────────────────────

/** Fuse visual frame search results with transcript text search.
 *  visualFrames: results from searchVideoFramesByImage or searchSimilarVideoFrames,
 *                each with vectorScore already populated.
 *  textQuery: the original text query to search in transcripts.
 *  visualWeight: weight for visual score (0-1), text weight = 1 - visualWeight. */
export function fuseMultimodalResults(
  visualFrames: MediaSearchVideoFrameRecord[],
  textResults: TranscriptSearchResult[],
  visualWeight = 0.55,
): MultimodalSearchResult[] {
  const fused = new Map<string, MultimodalSearchResult>()

  // Index text results by videoId
  const textByVideo = new Map<string, TranscriptSearchResult[]>()
  for (const tr of textResults) {
    const list = textByVideo.get(tr.videoId) || []
    list.push(tr)
    textByVideo.set(tr.videoId, list)
  }

  for (const frame of visualFrames) {
    const visualScore = frame.vectorScore ?? 0
    const videoTexts = textByVideo.get(frame.videoId) || []
    // Find best text match near this frame's timestamp (±30s)
    let bestTextScore = 0
    let bestText: string | undefined
    for (const tr of videoTexts) {
      const timeDelta = Math.abs(tr.timestampMs - frame.timestampMs)
      const timeDecay = Math.max(0, 1 - timeDelta / 30000) // linear decay over 30s
      const score = tr.score * timeDecay
      if (score > bestTextScore) {
        bestTextScore = score
        bestText = tr.text
      }
    }

    const fusedScore = visualWeight * visualScore + (1 - visualWeight) * Math.min(1, bestTextScore)
    fused.set(frame.frameId, {
      frame: { ...frame, vectorScore: fusedScore },
      visualScore,
      textScore: bestTextScore,
      fusedScore,
      matchedText: bestText,
    })
  }

  // Add text-only results that don't have a visual match
  for (const tr of textResults) {
    const key = `text-${tr.videoId}-${tr.timestampMs}`
    if (!fused.has(key)) {
      fused.set(key, {
        frame: {
          frameId: key,
          videoId: tr.videoId,
          videoPath: tr.videoPath,
          timestampMs: tr.timestampMs,
          status: 'done',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        visualScore: 0,
        textScore: tr.score,
        fusedScore: (1 - visualWeight) * Math.min(1, tr.score),
        matchedText: tr.text,
      })
    }
  }

  return [...fused.values()].sort((a, b) => b.fusedScore - a.fusedScore)
}
