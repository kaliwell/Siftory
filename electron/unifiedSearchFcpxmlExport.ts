import path from 'path'
import { pathToFileURL } from 'url'
import type {
  UnifiedSearchExportRequest,
  UnifiedTimelineFrameRate,
} from '../shared/ipc/unified-search'
import { projectUnifiedSearchExportDocument } from './unifiedSearchExport'

const MAX_FCPXML_CLIPS = 999
const DEFAULT_CLIP_DURATION_MS = 3_000

interface FrameDuration {
  numerator: number
  denominator: number
}

interface FcpxmlTimelineClip {
  assetKey: string
  displayName: string
  displayPath: string
  mediaUri: string
  sourceInFrames: number
  sourceOutFrames: number
  durationFrames: number
  sourceDurationFrames: number
  width: number
  height: number
  evidenceType: string
  evidenceSummary: string
  evidenceSources: string[]
  models: string[]
  clamped: boolean
}

interface FcpxmlProjection {
  clips: FcpxmlTimelineClip[]
  skippedCount: number
  clampedCount: number
}

export interface UnifiedSearchFcpxmlExport {
  content: string
  exportedCount: number
  skippedCount: number
  clampedCount: number
  frameRate: UnifiedTimelineFrameRate
}

export function fcpxmlFrameDuration(frameRate: UnifiedTimelineFrameRate): FrameDuration {
  if (frameRate === 23.976) return { numerator: 1_001, denominator: 24_000 }
  if (frameRate === 29.97) return { numerator: 1_001, denominator: 30_000 }
  if (frameRate === 59.94) return { numerator: 1_001, denominator: 60_000 }
  return { numerator: 1, denominator: frameRate }
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left))
  let b = Math.abs(Math.trunc(right))
  while (b) [a, b] = [b, a % b]
  return a || 1
}

export function fcpxmlTimeFromFrames(
  rawFrames: number,
  frameRate: UnifiedTimelineFrameRate,
): string {
  const frames = Math.max(0, Math.floor(rawFrames))
  if (frames === 0) return '0s'
  const duration = fcpxmlFrameDuration(frameRate)
  const numerator = frames * duration.numerator
  const divisor = greatestCommonDivisor(numerator, duration.denominator)
  const reducedNumerator = numerator / divisor
  const reducedDenominator = duration.denominator / divisor
  return reducedDenominator === 1
    ? `${reducedNumerator}s`
    : `${reducedNumerator}/${reducedDenominator}s`
}

function frameNumber(milliseconds: number, frameRate: UnifiedTimelineFrameRate): number {
  return Math.max(0, Math.round((milliseconds * frameRate) / 1_000))
}

function xmlAttribute(value: string, maximum = 4_096): string {
  const clean = [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 ? ' ' : character
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
  return clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function mediaUriFromPath(displayPath: string): string | undefined {
  if (/^file:\/\//i.test(displayPath)) {
    try {
      const parsed = new URL(displayPath)
      return parsed.protocol === 'file:' ? parsed.href : undefined
    } catch {
      return undefined
    }
  }
  if (!path.isAbsolute(displayPath)) return undefined
  return pathToFileURL(displayPath).href
}

function projectTimeline(
  request: UnifiedSearchExportRequest,
  frameRate: UnifiedTimelineFrameRate,
): FcpxmlProjection {
  const document = projectUnifiedSearchExportDocument(request)
  const clips: FcpxmlTimelineClip[] = []
  let skippedCount = 0
  let clampedCount = 0
  for (const result of document.results) {
    if (clips.length >= MAX_FCPXML_CLIPS) break
    const mediaUri = mediaUriFromPath(result.displayPath)
    const timedEvidence = result.evidence.filter(
      (evidence) => evidence.startMs !== undefined && evidence.startMs >= 0,
    )
    if (result.mediaType !== 'video' || !result.videoId || !mediaUri || !timedEvidence.length) {
      skippedCount += 1
      continue
    }
    const seenRanges = new Set<string>()
    let exportedForResult = 0
    for (const evidence of timedEvidence) {
      if (clips.length >= MAX_FCPXML_CLIPS) break
      const startMs = evidence.startMs!
      if (result.durationMs !== undefined && startMs >= result.durationMs) continue
      let endMs = evidence.endMs ?? startMs + DEFAULT_CLIP_DURATION_MS
      let clamped = false
      if (result.durationMs !== undefined && endMs > result.durationMs) {
        endMs = result.durationMs
        clamped = true
      }
      const sourceInFrames = frameNumber(startMs, frameRate)
      let sourceOutFrames = frameNumber(endMs, frameRate)
      if (sourceOutFrames <= sourceInFrames) sourceOutFrames = sourceInFrames + 1
      let sourceDurationFrames =
        result.durationMs === undefined
          ? sourceOutFrames
          : Math.max(0, frameNumber(result.durationMs, frameRate))
      if (result.durationMs !== undefined) {
        if (sourceInFrames >= sourceDurationFrames) continue
        if (sourceOutFrames > sourceDurationFrames) {
          sourceOutFrames = sourceDurationFrames
          clamped = true
        }
      }
      if (sourceOutFrames <= sourceInFrames) continue
      sourceDurationFrames = Math.max(sourceDurationFrames, sourceOutFrames, 1)
      const rangeKey = `${sourceInFrames}:${sourceOutFrames}`
      if (seenRanges.has(rangeKey)) continue
      seenRanges.add(rangeKey)
      if (clamped) clampedCount += 1
      exportedForResult += 1
      clips.push({
        assetKey: `${result.fileEntryId}\u0000${result.displayPath}`,
        displayName: result.displayName,
        displayPath: result.displayPath,
        mediaUri,
        sourceInFrames,
        sourceOutFrames,
        durationFrames: sourceOutFrames - sourceInFrames,
        sourceDurationFrames,
        width: result.width && result.width > 0 ? Math.floor(result.width) : 1_920,
        height: result.height && result.height > 0 ? Math.floor(result.height) : 1_080,
        evidenceType: evidence.hitType,
        evidenceSummary: evidence.summary,
        evidenceSources: evidence.evidenceSources,
        models: evidence.models,
        clamped,
      })
    }
    if (exportedForResult === 0) skippedCount += 1
  }
  return { clips, skippedCount, clampedCount }
}

export function serializeUnifiedSearchFcpxml(
  request: UnifiedSearchExportRequest,
): UnifiedSearchFcpxmlExport {
  if (request.format !== 'fcpxml' || request.frameRate === undefined) {
    throw new Error('FCPXML export requires an explicit supported frame rate')
  }
  const frameRate = request.frameRate
  const projection = projectTimeline(request, frameRate)
  if (!projection.clips.length) {
    throw new Error('No selected local video results contain an exportable time range')
  }

  const firstClip = projection.clips[0]
  const formatIdByDimensions = new Map<string, string>()
  const formatLines: string[] = []
  const ensureFormat = (width: number, height: number): string => {
    const key = `${width}x${height}`
    const existing = formatIdByDimensions.get(key)
    if (existing) return existing
    const id = `r${formatIdByDimensions.size + 1}`
    formatIdByDimensions.set(key, id)
    const frameDuration = fcpxmlFrameDuration(frameRate)
    formatLines.push(
      `    <format id="${id}" name="Siftory ${width}x${height} ${frameRate}p" frameDuration="${frameDuration.numerator}/${frameDuration.denominator}s" width="${width}" height="${height}"/>`,
    )
    return id
  }
  const sequenceFormatId = ensureFormat(firstClip.width, firstClip.height)
  for (const clip of projection.clips) ensureFormat(clip.width, clip.height)

  const uniqueAssets = new Map<
    string,
    { id: string; clip: FcpxmlTimelineClip; durationFrames: number }
  >()
  for (const clip of projection.clips) {
    const existing = uniqueAssets.get(clip.assetKey)
    if (existing) {
      existing.durationFrames = Math.max(existing.durationFrames, clip.sourceDurationFrames)
    } else {
      uniqueAssets.set(clip.assetKey, {
        id: `r${formatIdByDimensions.size + uniqueAssets.size + 1}`,
        clip,
        durationFrames: clip.sourceDurationFrames,
      })
    }
  }

  const assetLines: string[] = []
  for (const asset of uniqueAssets.values()) {
    const formatId = ensureFormat(asset.clip.width, asset.clip.height)
    assetLines.push(
      `    <asset id="${asset.id}" name="${xmlAttribute(asset.clip.displayName, 512)}" start="0s" duration="${fcpxmlTimeFromFrames(asset.durationFrames, frameRate)}" hasVideo="1" format="${formatId}">`,
      `      <media-rep kind="original-media" src="${xmlAttribute(asset.clip.mediaUri)}"/>`,
      '    </asset>',
    )
  }

  const clipLines: string[] = []
  let timelineCursorFrames = 0
  for (const clip of projection.clips) {
    const asset = uniqueAssets.get(clip.assetKey)!
    const evidence = [
      clip.evidenceType,
      clip.evidenceSummary,
      clip.evidenceSources.length ? `sources: ${clip.evidenceSources.join(', ')}` : '',
      clip.models.length ? `models: ${clip.models.join(', ')}` : '',
      clip.clamped ? 'range clamped to source duration' : '',
    ]
      .filter(Boolean)
      .join(' | ')
    clipLines.push(
      `            <asset-clip ref="${asset.id}" name="${xmlAttribute(clip.displayName, 512)}" offset="${fcpxmlTimeFromFrames(timelineCursorFrames, frameRate)}" start="${fcpxmlTimeFromFrames(clip.sourceInFrames, frameRate)}" duration="${fcpxmlTimeFromFrames(clip.durationFrames, frameRate)}">`,
      `              <marker start="${fcpxmlTimeFromFrames(clip.sourceInFrames, frameRate)}" duration="${fcpxmlTimeFromFrames(1, frameRate)}" value="Siftory evidence" note="${xmlAttribute(evidence, 2_000)}"/>`,
      '            </asset-clip>',
    )
    timelineCursorFrames += clip.durationFrames
  }

  const document = projectUnifiedSearchExportDocument(request)
  const projectName = document.query.text
    ? `Siftory Search - ${document.query.text}`
    : 'Siftory Search Results'
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.11">',
    '  <resources>',
    ...formatLines,
    ...assetLines,
    '  </resources>',
    '  <library>',
    '    <event name="Siftory Search">',
    `      <project name="${xmlAttribute(projectName, 512)}">`,
    `        <sequence format="${sequenceFormatId}" duration="${fcpxmlTimeFromFrames(timelineCursorFrames, frameRate)}" tcStart="3600s" tcFormat="${frameRate === 29.97 || frameRate === 59.94 ? 'DF' : 'NDF'}" audioLayout="stereo" audioRate="48k">`,
    '          <spine>',
    ...clipLines,
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
    '',
  ].join('\n')
  return {
    content,
    exportedCount: projection.clips.length,
    skippedCount: projection.skippedCount,
    clampedCount: projection.clampedCount,
    frameRate,
  }
}

function readAttribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
}

function hasBalancedXmlTags(content: string): boolean {
  const stack: string[] = []
  const tags = content.match(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*?)?\/?>/g) ?? []
  for (const tag of tags) {
    if (tag.endsWith('/>')) continue
    const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tag)?.[1]
    if (!name) return false
    if (tag.startsWith('</')) {
      if (stack.pop() !== name) return false
    } else {
      stack.push(name)
    }
  }
  return stack.length === 0
}

export function validateFcpxml(content: string): {
  ok: boolean
  clipCount: number
  markerCount: number
  errors: string[]
} {
  const errors: string[] = []
  if (!content.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>')) {
    errors.push('invalid-header')
  }
  if (!/<fcpxml version="1\.11">/.test(content)) errors.push('invalid-root')
  if (!hasBalancedXmlTags(content)) errors.push('unbalanced-tags')
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\dA-Fa-f]+;)/.test(content)) {
    errors.push('unescaped-entity')
  }

  const resourceTags = content.match(/<(?:format|asset)(?=[\s>])[^>]*>/g) ?? []
  const resourceIds = new Set<string>()
  for (const tag of resourceTags) {
    const id = readAttribute(tag, 'id')
    if (!id) errors.push('resource-without-id')
    else if (resourceIds.has(id)) errors.push(`duplicate-resource:${id}`)
    else resourceIds.add(id)
  }
  const assetIds = new Set(
    (content.match(/<asset(?=[\s>])[^>]*>/g) ?? [])
      .map((tag) => readAttribute(tag, 'id'))
      .filter((id): id is string => Boolean(id)),
  )
  const clipTags = content.match(/<asset-clip\b[^>]*>/g) ?? []
  for (const tag of clipTags) {
    const ref = readAttribute(tag, 'ref')
    if (!ref || !assetIds.has(ref)) errors.push(`missing-asset-ref:${ref ?? ''}`)
    for (const attribute of ['offset', 'start', 'duration']) {
      const value = readAttribute(tag, attribute)
      if (!value || !/^(?:0|\d+(?:\/\d+)?)s$/.test(value)) {
        errors.push(`invalid-${attribute}:${value ?? ''}`)
      }
    }
  }
  const mediaTags = content.match(/<media-rep\b[^>]*\/>/g) ?? []
  for (const tag of mediaTags) {
    const src = readAttribute(tag, 'src')
    if (!src?.startsWith('file://') || src.includes('\\')) errors.push('invalid-media-uri')
  }
  const markerCount = (content.match(/<marker\b[^>]*\/>/g) ?? []).length
  if (!clipTags.length) errors.push('missing-clips')
  if (mediaTags.length !== assetIds.size) errors.push('asset-media-mismatch')
  if (markerCount !== clipTags.length) errors.push('evidence-marker-mismatch')
  return { ok: errors.length === 0, clipCount: clipTags.length, markerCount, errors }
}
