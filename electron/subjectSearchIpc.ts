import { secureIpcMain } from './ipcAuthorization'
// ── Subject Search IPC ────────────────────────────────────

import { dialog, type BrowserWindow } from 'electron'
import fs from 'fs'
import { detectSubjects, searchBySubject, type SubjectBBox } from './subjectSearchService'
import { normalizeUserPath } from './pathGuards'
import { authorizeFileDragResults } from './fileDragIpc'
import { subjectMaskSessions, type SubjectMaskSessionData } from './subjectMaskSession'
import { getSourceFileSyncMutationEpoch, isSourceFileSyncRunning } from './sourceFileSyncService'
import { tryAcquireVectorSearchReservation } from './vectorMaintenanceService'

type MainWindowProvider = () => BrowserWindow | null

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerSubjectSearchIpc(_getMainWindow: MainWindowProvider): void {
  // Detect subjects in an image
  secureIpcMain.handle('subject:detect', async (_event, rawPath: unknown) => {
    const imagePath = normalizeUserPath(rawPath)
    if (!imagePath) return { ok: false, error: 'Invalid image path' }
    try {
      return await detectSubjects(imagePath)
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })

  // Search by subject; optional explicit subject bbox from the picker
  secureIpcMain.handle(
    'subject:search',
    async (
      event,
      rawPath: unknown,
      rawTopK: unknown,
      rawSubject: unknown,
      rawSegmentationSessionId: unknown,
    ) => {
      const imagePath = normalizeUserPath(rawPath)
      if (!imagePath) return { ok: false, results: [], error: 'Invalid image path' }
      // topK mirrors the Image Search Top K control (1..1000, default 20)
      const topK =
        typeof rawTopK === 'number' && Number.isFinite(rawTopK) && rawTopK >= 1 && rawTopK <= 1000
          ? Math.floor(rawTopK)
          : 20
      let subject: SubjectBBox | undefined
      if (rawSubject !== undefined && rawSubject !== null) {
        const s = rawSubject as Partial<SubjectBBox>
        const nums = [s.x, s.y, s.w, s.h]
        if (
          typeof s !== 'object' ||
          !nums.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
          (s.x as number) < 0 ||
          (s.y as number) < 0 ||
          (s.w as number) < 4 ||
          (s.h as number) < 4 ||
          (s.w as number) > 100000 ||
          (s.h as number) > 100000
        ) {
          return { ok: false, results: [], error: 'Invalid subject region' }
        }
        subject = {
          x: s.x as number,
          y: s.y as number,
          w: s.w as number,
          h: s.h as number,
          confidence:
            typeof s.confidence === 'number' && Number.isFinite(s.confidence) ? s.confidence : 1,
          label:
            typeof s.label === 'string' && s.label.length > 0 ? s.label.slice(0, 50) : 'subject',
        }
      }
      let maskSession: SubjectMaskSessionData | undefined
      if (rawSegmentationSessionId !== undefined && rawSegmentationSessionId !== null) {
        if (
          typeof rawSegmentationSessionId !== 'string' ||
          rawSegmentationSessionId.length === 0 ||
          rawSegmentationSessionId.length > 128
        ) {
          return { ok: false, results: [], error: 'Invalid segmentation session' }
        }
        try {
          const stat = fs.statSync(imagePath)
          if (!stat.isFile()) throw new Error('not a file')
          maskSession =
            subjectMaskSessions.resolve(event.sender.id, rawSegmentationSessionId, {
              imagePath,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            }) ?? undefined
        } catch {
          maskSession = undefined
        }
        if (!maskSession) {
          return {
            ok: false,
            results: [],
            error: 'The segmentation expired or the source image changed. Segment it again.',
          }
        }
      }
      if (isSourceFileSyncRunning()) {
        return { ok: false, results: [], error: 'Source file synchronization is running' }
      }
      const releaseSearch = tryAcquireVectorSearchReservation()
      if (!releaseSearch) {
        return { ok: false, results: [], error: 'Vector maintenance is running' }
      }
      const sourceSyncEpoch = getSourceFileSyncMutationEpoch()
      try {
        const response = await searchBySubject(
          imagePath,
          topK,
          subject,
          (progress) => {
            try {
              const mainWindow = _getMainWindow()
              if (mainWindow && !mainWindow.isDestroyed()) {
                // reuse the layered-search progress channel so the UI shows
                // one continuous bar without any renderer changes
                mainWindow.webContents.send('vector:onLayeredSearchProgress', progress)
              }
            } catch {
              /* ignore */
            }
          },
          maskSession,
        )
        if (isSourceFileSyncRunning() || sourceSyncEpoch !== getSourceFileSyncMutationEpoch()) {
          return {
            ok: false,
            results: [],
            error: 'Search results were discarded because source synchronization changed the index',
          }
        }
        return {
          ...response,
          results: authorizeFileDragResults(
            event.sender.id,
            response.results,
            (result) => result.imagePath,
          ),
        }
      } catch (err) {
        return { ok: false, results: [], error: errorMessage(err) }
      } finally {
        releaseSearch()
      }
    },
  )

  // Select a query image
  secureIpcMain.handle('subject:selectImage', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select query image',
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
