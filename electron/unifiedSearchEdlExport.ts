import type {
  UnifiedSearchExportRequest,
  UnifiedTimelineFrameRate,
} from '../shared/ipc/unified-search'
import { projectUnifiedSearchExportDocument } from './unifiedSearchExport'

const MAX_EDL_EVENTS = 999
const RECORD_START_MS = 60 * 60 * 1_000
const DEFAULT_CLIP_DURATION_MS = 3_000

export interface UnifiedSearchEdlExport {
  content: string
  exportedCount: number
  skippedCount: number
  clampedCount: number
  frameRate: UnifiedTimelineFrameRate
  dropFrame: boolean
}

export function isDropFrameRate(frameRate: UnifiedTimelineFrameRate): boolean {
  return frameRate === 29.97 || frameRate === 59.94
}

function actualFrameNumber(milliseconds: number, frameRate: UnifiedTimelineFrameRate): number {
  return Math.max(0, Math.round((milliseconds * frameRate) / 1_000))
}

export function cmxTimecodeFromFrameNumber(
  rawFrameNumber: number,
  frameRate: UnifiedTimelineFrameRate,
): string {
  const nominalFps = Math.round(frameRate)
  let frameNumber = Math.max(0, Math.floor(rawFrameNumber))
  const dropFrame = isDropFrameRate(frameRate)
  if (dropFrame) {
    const dropFrames = nominalFps === 60 ? 4 : 2
    const framesPer10Minutes = nominalFps * 60 * 10 - dropFrames * 9
    const framesPerMinute = nominalFps * 60 - dropFrames
    const framesPer24Hours = actualFrameNumber(24 * 60 * 60 * 1_000, frameRate)
    frameNumber %= framesPer24Hours
    const tenMinuteBlocks = Math.floor(frameNumber / framesPer10Minutes)
    const remainder = frameNumber % framesPer10Minutes
    frameNumber += dropFrames * 9 * tenMinuteBlocks
    if (remainder > dropFrames) {
      frameNumber += dropFrames * Math.floor((remainder - dropFrames) / framesPerMinute)
    }
  }
  const frames = frameNumber % nominalFps
  const totalSeconds = Math.floor(frameNumber / nominalFps)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60) % 24
  const separator = dropFrame ? ';' : ':'
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(frames).padStart(2, '0')}`
}

export function millisecondsToCmxTimecode(
  milliseconds: number,
  frameRate: UnifiedTimelineFrameRate,
): string {
  return cmxTimecodeFromFrameNumber(actualFrameNumber(milliseconds, frameRate), frameRate)
}

function commentText(value: string, maximum = 1_000): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 ? ' ' : character
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

export function serializeUnifiedSearchEdl(
  request: UnifiedSearchExportRequest,
): UnifiedSearchEdlExport {
  if (request.format !== 'edl' || request.frameRate === undefined) {
    throw new Error('EDL export requires an explicit supported frame rate')
  }
  const frameRate = request.frameRate
  const document = projectUnifiedSearchExportDocument(request)
  const lines = [
    'TITLE: SIFTORY SEARCH RESULTS',
    `FCM: ${isDropFrameRate(frameRate) ? 'DROP FRAME' : 'NON-DROP FRAME'}`,
  ]
  lines.push(`* SIFTORY FRAME RATE: ${frameRate}`)
  if (document.query.text) lines.push(`* SIFTORY QUERY: ${commentText(document.query.text, 500)}`)
  lines.push('')
  let eventIndex = 0
  let skippedCount = 0
  let clampedCount = 0
  let recordCursorFrames = actualFrameNumber(RECORD_START_MS, frameRate)
  for (const result of document.results) {
    if (eventIndex >= MAX_EDL_EVENTS) break
    const seenRanges = new Set<string>()
    const timedEvidence = result.evidence.filter(
      (evidence) => evidence.startMs !== undefined && evidence.startMs >= 0,
    )
    let exportedForResult = 0
    if (result.mediaType !== 'video' || !result.videoId || timedEvidence.length === 0) {
      skippedCount += 1
      continue
    }
    for (const evidence of timedEvidence) {
      if (eventIndex >= MAX_EDL_EVENTS) break
      const startMs = evidence.startMs!
      if (result.durationMs !== undefined && startMs >= result.durationMs) continue
      let endMs = evidence.endMs ?? startMs + DEFAULT_CLIP_DURATION_MS
      let clamped = false
      if (result.durationMs !== undefined && endMs > result.durationMs) {
        endMs = result.durationMs
        clamped = true
      }
      const sourceInFrames = actualFrameNumber(startMs, frameRate)
      let sourceOutFrames = actualFrameNumber(endMs, frameRate)
      if (sourceOutFrames <= sourceInFrames) sourceOutFrames = sourceInFrames + 1
      if (result.durationMs !== undefined) {
        const maximumFrames = actualFrameNumber(result.durationMs, frameRate)
        if (sourceInFrames >= maximumFrames) continue
        if (sourceOutFrames > maximumFrames) {
          sourceOutFrames = maximumFrames
          clamped = true
        }
      }
      if (sourceOutFrames <= sourceInFrames) continue
      const rangeKey = `${sourceInFrames}:${sourceOutFrames}`
      if (seenRanges.has(rangeKey)) continue
      seenRanges.add(rangeKey)
      const durationFrames = sourceOutFrames - sourceInFrames
      const recordOutFrames = recordCursorFrames + durationFrames
      eventIndex += 1
      exportedForResult += 1
      if (clamped) clampedCount += 1
      const eventNumber = String(eventIndex).padStart(3, '0')
      const reel = `SFT${String(eventIndex).padStart(5, '0')}`
      lines.push(
        `${eventNumber}  ${reel} V     C        ${cmxTimecodeFromFrameNumber(sourceInFrames, frameRate)} ${cmxTimecodeFromFrameNumber(sourceOutFrames, frameRate)} ${cmxTimecodeFromFrameNumber(recordCursorFrames, frameRate)} ${cmxTimecodeFromFrameNumber(recordOutFrames, frameRate)}`,
      )
      lines.push(`* FROM CLIP NAME: ${commentText(result.displayName, 500)}`)
      lines.push(`* SOURCE FILE: ${commentText(result.displayPath, 1_000)}`)
      lines.push(
        `* SIFTORY EVIDENCE: ${commentText(`${evidence.hitType} | ${evidence.summary}`, 1_000)}`,
      )
      if (clamped) lines.push('* SIFTORY RANGE CLAMPED TO SOURCE DURATION')
      lines.push('')
      recordCursorFrames = recordOutFrames
    }
    if (exportedForResult === 0) skippedCount += 1
  }
  if (eventIndex === 0)
    throw new Error('No selected video results contain an exportable time range')
  return {
    content: `${lines.join('\r\n')}\r\n`,
    exportedCount: eventIndex,
    skippedCount,
    clampedCount,
    frameRate,
    dropFrame: isDropFrameRate(frameRate),
  }
}

export function validateCmx3600Edl(content: string): {
  ok: boolean
  eventCount: number
  errors: string[]
} {
  const lines = content.split(/\r?\n/)
  const errors: string[] = []
  if (!lines.some((line) => /^TITLE:\s+\S/.test(line))) errors.push('missing-title')
  const mode = lines.find((line) => /^FCM:/.test(line))
  if (mode !== 'FCM: NON-DROP FRAME' && mode !== 'FCM: DROP FRAME') errors.push('invalid-fcm')
  const eventLines = lines.filter((line) => /^\d{3}\s{2}/.test(line))
  const timecode =
    mode === 'FCM: DROP FRAME' ? '\\d{2}:\\d{2}:\\d{2};\\d{2}' : '\\d{2}:\\d{2}:\\d{2}:\\d{2}'
  const eventPattern = new RegExp(
    `^\\d{3}\\s{2}\\S{1,8}\\s+V\\s+C\\s+${timecode}\\s+${timecode}\\s+${timecode}\\s+${timecode}$`,
  )
  for (const line of eventLines) {
    if (!eventPattern.test(line)) errors.push(`invalid-event:${line.slice(0, 32)}`)
  }
  if (!eventLines.length) errors.push('missing-events')
  return { ok: errors.length === 0, eventCount: eventLines.length, errors }
}
