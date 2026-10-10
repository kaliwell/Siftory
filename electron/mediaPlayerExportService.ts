import { BrowserWindow, dialog } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  MEDIA_PLAYER_EXPORT_IPC,
  type MediaPlayerExportFormat,
  type MediaPlayerExportRequest,
  type MediaPlayerExportResult,
} from '../shared/ipc/media-player-export'
import type {
  UnifiedSearchExportRequest,
  UnifiedTimelineFrameRate,
} from '../shared/ipc/unified-search'
import { exportVideoSelectionToMp4 } from './ffmpegService'
import { secureIpcMain } from './ipcAuthorization'
import { serializeUnifiedSearchEdl, validateCmx3600Edl } from './unifiedSearchEdlExport'
import { serializeUnifiedSearchFcpxml, validateFcpxml } from './unifiedSearchFcpxmlExport'

const FRAME_RATES = new Set<UnifiedTimelineFrameRate>([23.976, 24, 25, 29.97, 30, 50, 59.94, 60])
const MAX_SELECTION_MS = 7 * 24 * 60 * 60 * 1_000
const MIN_SELECTION_MS = 40

export interface MediaPlayerExportSource {
  videoId: string
  videoPath: string
  title: string
  durationMs?: number
  width?: number
  height?: number
  sizeBytes?: number
  mtimeMs?: number
}

interface MediaPlayerExportGrant {
  senderId: number
  source: MediaPlayerExportSource
  exporting: boolean
}

interface AuthorizedPlayerExportRequest extends MediaPlayerExportRequest {
  token: string
}

const exportGrants = new Map<string, MediaPlayerExportGrant>()

function safeInteger(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : undefined
}

export function normalizeMediaPlayerExportRequest(
  raw: unknown,
  durationMs?: number,
): AuthorizedPlayerExportRequest | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Partial<AuthorizedPlayerExportRequest>
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  const startMs = safeInteger(input.startMs)
  const endMs = safeInteger(input.endMs)
  const format: MediaPlayerExportFormat | undefined =
    input.format === 'video' || input.format === 'edl' || input.format === 'fcpxml'
      ? input.format
      : undefined
  if (
    !/^[A-Za-z0-9_-]{24,128}$/.test(token) ||
    !format ||
    startMs === undefined ||
    endMs === undefined ||
    startMs < 0 ||
    endMs - startMs < MIN_SELECTION_MS ||
    endMs > MAX_SELECTION_MS ||
    (durationMs !== undefined && endMs > Math.ceil(durationMs))
  ) {
    return undefined
  }
  const frameRate = FRAME_RATES.has(input.frameRate as UnifiedTimelineFrameRate)
    ? (input.frameRate as UnifiedTimelineFrameRate)
    : undefined
  if ((format === 'edl' || format === 'fcpxml') && frameRate === undefined) return undefined
  return { token, format, startMs, endMs, ...(frameRate ? { frameRate } : {}) }
}

export function registerMediaPlayerExportGrant(
  token: string,
  senderId: number,
  source: MediaPlayerExportSource,
): void {
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) throw new Error('Invalid player export token')
  exportGrants.set(token, {
    senderId,
    source: { ...source, videoPath: path.resolve(source.videoPath) },
    exporting: false,
  })
}

export function revokeMediaPlayerExportGrant(token: string): void {
  exportGrants.delete(token)
}

function safeFileStem(value: string): string {
  const stem = path.basename(value, path.extname(value))
  return (
    [...stem]
      .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
      .join('')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/[ .]+$/g, '')
      .slice(0, 96) || 'siftory-clip'
  )
}

function rangeStamp(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1_000)
  const millis = total % 1_000
  return `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}${String(seconds).padStart(2, '0')}${String(millis).padStart(3, '0')}`
}

function ensureExtension(filePath: string, extension: string): string {
  return filePath.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
    ? filePath
    : `${filePath}.${extension}`
}

export function buildMediaPlayerTimelineRequest(
  source: MediaPlayerExportSource,
  request: AuthorizedPlayerExportRequest,
): UnifiedSearchExportRequest {
  const stat = fs.statSync(source.videoPath)
  return {
    format: request.format as 'edl' | 'fcpxml',
    frameRate: request.frameRate!,
    search: { query: 'Player selection' },
    items: [
      {
        fileEntryId: source.videoId,
        videoId: source.videoId,
        mediaType: 'video',
        displayName: source.title,
        displayPath: source.videoPath,
        sizeBytes: source.sizeBytes ?? stat.size,
        modifiedAt: source.mtimeMs ?? stat.mtimeMs,
        ...(source.durationMs !== undefined ? { durationMs: source.durationMs } : {}),
        ...(source.width !== undefined ? { width: source.width } : {}),
        ...(source.height !== undefined ? { height: source.height } : {}),
        source: {
          id: 'controlled-media-player',
          name: 'Local media',
          type: 'local-generic',
          availability: 'online',
        },
        indexState: [],
        evidence: [
          {
            lane: 'video-frame',
            hitType: 'mixed',
            summary: 'Manual player selection',
            startMs: request.startMs,
            endMs: request.endMs,
          },
        ],
      },
    ],
  }
}

async function saveTimeline(
  source: MediaPlayerExportSource,
  request: AuthorizedPlayerExportRequest,
  outputPath: string,
): Promise<MediaPlayerExportResult> {
  const projected = buildMediaPlayerTimelineRequest(source, request)
  if (request.format === 'edl') {
    const document = serializeUnifiedSearchEdl(projected)
    const validation = validateCmx3600Edl(document.content)
    if (!validation.ok) {
      return {
        ok: false,
        error: `Generated EDL failed validation: ${validation.errors.join(', ')}`,
      }
    }
    await fs.promises.writeFile(outputPath, document.content, 'utf8')
  } else {
    const document = serializeUnifiedSearchFcpxml(projected)
    const validation = validateFcpxml(document.content)
    if (!validation.ok) {
      return {
        ok: false,
        error: `Generated FCPXML failed validation: ${validation.errors.join(', ')}`,
      }
    }
    await fs.promises.writeFile(outputPath, document.content, 'utf8')
  }
  return { ok: true, filePath: outputPath }
}

export function registerMediaPlayerExportIpc(): void {
  secureIpcMain.handle(MEDIA_PLAYER_EXPORT_IPC.SAVE_SELECTION, async (event, raw: unknown) => {
    const rawToken =
      raw && typeof raw === 'object' && typeof (raw as { token?: unknown }).token === 'string'
        ? (raw as { token: string }).token
        : ''
    const grant = exportGrants.get(rawToken)
    if (!grant || grant.senderId !== event.sender.id) {
      return { ok: false, error: 'The player export permission has expired' }
    }
    const request = normalizeMediaPlayerExportRequest(raw, grant.source.durationMs)
    if (!request) return { ok: false, error: 'Invalid player export range or format' }
    if (grant.exporting) return { ok: false, error: 'Another export is already running' }
    try {
      const sourceStat = await fs.promises.stat(grant.source.videoPath)
      if (!sourceStat.isFile()) throw new Error('not a file')
    } catch {
      return { ok: false, error: 'The source video is no longer available' }
    }

    const extension = request.format === 'video' ? 'mp4' : request.format
    const defaultName = `${safeFileStem(grant.source.title)}-${rangeStamp(request.startMs)}-${rangeStamp(request.endMs)}.${extension}`
    const options = {
      title: request.format === 'video' ? 'Export video clip' : 'Export timeline selection',
      defaultPath: path.join(path.dirname(grant.source.videoPath), defaultName),
      filters: [
        request.format === 'video'
          ? { name: 'H.264 MP4 video', extensions: ['mp4'] }
          : request.format === 'edl'
            ? { name: 'CMX3600 EDL', extensions: ['edl'] }
            : { name: 'Final Cut Pro XML', extensions: ['fcpxml'] },
      ],
      properties: ['showOverwriteConfirmation' as const],
    }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const selected = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (selected.canceled || !selected.filePath) {
      return { ok: false, cancelled: true, error: 'cancelled' }
    }
    const outputPath = path.resolve(ensureExtension(selected.filePath, extension))
    if (outputPath.toLowerCase() === grant.source.videoPath.toLowerCase()) {
      return { ok: false, error: 'The exported clip cannot overwrite its source video' }
    }

    grant.exporting = true
    try {
      if (request.format === 'video') {
        const exported = await exportVideoSelectionToMp4({
          filePath: grant.source.videoPath,
          outputPath,
          startMs: request.startMs,
          endMs: request.endMs,
        })
        return exported.ok
          ? { ok: true, filePath: exported.path ?? outputPath }
          : { ok: false, error: exported.error }
      }
      return await saveTimeline(grant.source, request, outputPath)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      grant.exporting = false
    }
  })
}
