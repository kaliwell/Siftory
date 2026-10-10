import type { UnifiedTimelineFrameRate } from './unified-search'

export const MEDIA_PLAYER_EXPORT_IPC = {
  SAVE_SELECTION: 'mediaSearch:exportPlayerSelection',
} as const

export type MediaPlayerExportFormat = 'video' | 'edl' | 'fcpxml'

export interface MediaPlayerExportRequest {
  format: MediaPlayerExportFormat
  startMs: number
  endMs: number
  frameRate?: UnifiedTimelineFrameRate
}

export interface MediaPlayerExportResult {
  ok: boolean
  cancelled?: boolean
  filePath?: string
  error?: string
}

export interface MediaPlayerExportApi {
  exportSelection(request: MediaPlayerExportRequest): Promise<MediaPlayerExportResult>
}
