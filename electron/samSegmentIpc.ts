import { secureIpcMain } from './ipcAuthorization'
// ── SAM Click Segmentation IPC ─────────────────────────────

import { type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { getSamStatus, segmentAtPoint, type SamPoint } from './samSegmentService'
import { normalizeUserPath } from './pathGuards'
import { subjectMaskSessions } from './subjectMaskSession'
import { createSubjectDisplayPreview } from './subjectDisplayPreview'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const MAX_POINTS = 32
const MIN_PREVIEW_DIMENSION = 128
const MAX_PREVIEW_DIMENSION = 2048
type MainWindowProvider = () => BrowserWindow | null

function isAuthorizedSender(event: IpcMainInvokeEvent, getMainWindow: MainWindowProvider): boolean {
  const window = getMainWindow()
  return Boolean(
    window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame,
  )
}

export function registerSamSegmentIpc(getMainWindow: MainWindowProvider): void {
  secureIpcMain.handle('sam:status', async () => getSamStatus())

  secureIpcMain.handle(
    'sam:preview',
    async (event, rawPath: unknown, rawMaxWidth: unknown, rawMaxHeight: unknown) => {
      if (!isAuthorizedSender(event, getMainWindow)) {
        return { ok: false, error: 'Unauthorized preview request' }
      }
      const imagePath = normalizeUserPath(rawPath)
      if (!imagePath) return { ok: false, error: 'Invalid image path' }
      const dimension = (value: unknown): number | null =>
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= MIN_PREVIEW_DIMENSION &&
        value <= MAX_PREVIEW_DIMENSION
          ? Math.round(value)
          : null
      const maxWidth = dimension(rawMaxWidth)
      const maxHeight = dimension(rawMaxHeight)
      if (!maxWidth || !maxHeight) return { ok: false, error: 'Invalid preview dimensions' }
      return createSubjectDisplayPreview(imagePath, maxWidth, maxHeight)
    },
  )

  secureIpcMain.handle('sam:segment', async (event, rawPath: unknown, rawPoints: unknown) => {
    if (!isAuthorizedSender(event, getMainWindow)) {
      return { ok: false, error: 'Unauthorized segmentation request' }
    }
    const imagePath = normalizeUserPath(rawPath)
    if (!imagePath) return { ok: false, error: 'Invalid image path' }
    if (!Array.isArray(rawPoints) || rawPoints.length === 0 || rawPoints.length > MAX_POINTS) {
      return { ok: false, error: `points must be an array of 1..${MAX_POINTS}` }
    }
    const points: SamPoint[] = []
    for (const raw of rawPoints) {
      const p = raw as Partial<SamPoint>
      if (
        typeof p !== 'object' ||
        p === null ||
        typeof p.x !== 'number' ||
        typeof p.y !== 'number' ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < 0 ||
        p.y < 0 ||
        p.x > 100000 ||
        p.y > 100000
      ) {
        return { ok: false, error: 'Invalid point coordinates' }
      }
      const label = p.label === 0 || p.label === 2 || p.label === 3 ? p.label : 1
      points.push({ x: p.x, y: p.y, label })
    }
    try {
      const result = await segmentAtPoint(imagePath, points)
      if (
        !result.ok ||
        !result.width ||
        !result.height ||
        !result.bbox ||
        !result.maskPngDataUrl ||
        result.sourceSize === undefined ||
        result.sourceMtimeMs === undefined
      ) {
        return result
      }
      const prefix = 'data:image/png;base64,'
      if (!result.maskPngDataUrl.startsWith(prefix)) {
        return { ok: false, error: 'Invalid segmentation mask' }
      }
      const sessionId = subjectMaskSessions.issue(event.sender.id, {
        imagePath,
        size: result.sourceSize,
        mtimeMs: result.sourceMtimeMs,
        width: result.width,
        height: result.height,
        bbox: result.bbox,
        maskPng: Buffer.from(result.maskPngDataUrl.slice(prefix.length), 'base64'),
      })
      if (!sessionId) return { ok: false, error: 'Segmentation mask is too large' }
      return {
        ok: true,
        width: result.width,
        height: result.height,
        bbox: result.bbox,
        iou: result.iou,
        maskPngDataUrl: result.maskPngDataUrl,
        segmentationSessionId: sessionId,
      }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
}
