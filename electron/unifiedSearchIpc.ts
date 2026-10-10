// ── Unified search IPC (Phase 3, design 12.1) ────────────
// Thin handlers: sender authorization, payload validation and capability
// declaration are enforced by secureIpcMain; handlers only clamp inputs and
// forward to the unified search service / task scheduler. Channels reuse the
// already-declared `catalog` IPC domain.

import { UNIFIED_SEARCH_IPC, type UnifiedSearchResponse } from '../shared/ipc/unified-search'
import { BrowserWindow, dialog } from 'electron'
import fs from 'fs'
import { secureIpcMain } from './ipcAuthorization'
import {
  normalizeUnifiedSearchExportPath,
  normalizeUnifiedSearchExportRequest,
  serializeUnifiedSearchExport,
} from './unifiedSearchExport'
import { serializeUnifiedSearchEdl, validateCmx3600Edl } from './unifiedSearchEdlExport'
import { serializeUnifiedSearchFcpxml, validateFcpxml } from './unifiedSearchFcpxmlExport'
import {
  normalizeUnifiedSearchFeedback,
  normalizeUnifiedSearchFeedbackId,
  normalizeUnifiedSearchQuery,
} from './unifiedSearchGuards'
import { getUnifiedSearchFeedbackStore } from './unifiedSearchFeedbackStore'
import {
  getUnifiedSearchService,
  getUnifiedTaskScheduler,
  setUnifiedResourceProfile,
} from './unifiedSearchRuntime'
import { subjectMaskSessions, type SubjectMaskSessionData } from './subjectMaskSession'
import { getSourceFileSyncMutationEpoch, isSourceFileSyncRunning } from './sourceFileSyncService'
import { tryAcquireVectorSearchReservation } from './vectorMaintenanceService'

const EMPTY_RESPONSE: UnifiedSearchResponse = {
  items: [],
  total: 0,
  lanes: [],
  aiEnhancement: 'unavailable',
}

let activeUnifiedSearches = 0

export function isUnifiedSearchRunning(): boolean {
  return activeUnifiedSearches > 0
}

function maintenanceUnavailableResponse(
  actionableHint = 'Source file synchronization is running. Try again when it finishes.',
): UnifiedSearchResponse {
  return {
    ...EMPTY_RESPONSE,
    degradedReason: 'index-stale',
    actionableHint,
  }
}

function normalizeVisiblePaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, 2000)
    .map((entry) => entry.slice(0, 1024))
}

export function registerUnifiedSearchIpc(): void {
  secureIpcMain.handle(UNIFIED_SEARCH_IPC.QUERY, async (event, raw: unknown) => {
    if (isSourceFileSyncRunning()) return maintenanceUnavailableResponse()
    const service = getUnifiedSearchService()
    if (!service) return EMPTY_RESPONSE
    const releaseSearch = tryAcquireVectorSearchReservation()
    if (!releaseSearch) {
      return maintenanceUnavailableResponse('Index maintenance is running. Try again shortly.')
    }
    const sourceSyncEpoch = getSourceFileSyncMutationEpoch()
    activeUnifiedSearches += 1
    try {
      const request = normalizeUnifiedSearchQuery(raw)
      let subjectMaskSession: SubjectMaskSessionData | undefined
      let subjectMaskError: string | undefined
      if (request.referenceImagePath && request.segmentationSessionId) {
        try {
          const stat = fs.statSync(request.referenceImagePath)
          if (!stat.isFile()) throw new Error('not a file')
          subjectMaskSession =
            subjectMaskSessions.resolve(event.sender.id, request.segmentationSessionId, {
              imagePath: request.referenceImagePath,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            }) ?? undefined
        } catch {
          subjectMaskSession = undefined
        }
        if (!subjectMaskSession) {
          subjectMaskError =
            'The segmentation expired or the source image changed. Segment it again.'
        }
      }
      const response = await service.search(request, {
        ...(subjectMaskSession ? { subjectMaskSession } : {}),
        ...(subjectMaskError ? { subjectMaskError } : {}),
      })
      if (isSourceFileSyncRunning() || sourceSyncEpoch !== getSourceFileSyncMutationEpoch()) {
        return maintenanceUnavailableResponse()
      }
      return response
    } finally {
      activeUnifiedSearches = Math.max(0, activeUnifiedSearches - 1)
      releaseSearch()
    }
  })

  secureIpcMain.handle(UNIFIED_SEARCH_IPC.SET_VISIBLE_PATHS, async (_event, raw: unknown) => {
    return { bumped: getUnifiedTaskScheduler().setVisiblePaths(normalizeVisiblePaths(raw)) }
  })

  secureIpcMain.handle(UNIFIED_SEARCH_IPC.SCHEDULER_STATS, async () => {
    return getUnifiedTaskScheduler().stats()
  })

  secureIpcMain.handle(UNIFIED_SEARCH_IPC.RESOURCE_PROFILE_SET, async (_event, raw: unknown) => {
    return setUnifiedResourceProfile(raw)
  })

  secureIpcMain.handle(UNIFIED_SEARCH_IPC.RESOURCE_BACKGROUND_CANCEL, async () => {
    return { cancelled: getUnifiedTaskScheduler().cancelBackgroundTasks() }
  })

  secureIpcMain.handle(UNIFIED_SEARCH_IPC.FEEDBACK_SAVE, async (_event, raw: unknown) => {
    const request = normalizeUnifiedSearchFeedback(raw)
    if (!request) return { ok: false, error: 'Invalid search feedback request' }
    const store = getUnifiedSearchFeedbackStore()
    if (!store) return { ok: false, error: 'Search feedback store is unavailable' }
    return store.submit(request)
  })

  secureIpcMain.handle(UNIFIED_SEARCH_IPC.FEEDBACK_UNDO, async (_event, raw: unknown) => {
    const feedbackId = normalizeUnifiedSearchFeedbackId(raw)
    if (!feedbackId) return { ok: false, error: 'Invalid search feedback identifier' }
    const store = getUnifiedSearchFeedbackStore()
    if (!store) return { ok: false, error: 'Search feedback store is unavailable' }
    return store.undo(feedbackId)
  })

  secureIpcMain.handle(UNIFIED_SEARCH_IPC.EXPORT_SAVE, async (event, raw: unknown) => {
    const request = normalizeUnifiedSearchExportRequest(raw)
    if (!request) return { ok: false, error: 'Invalid unified search export request' }
    const extension = request.format
    let payload: string
    let exportedCount = request.items.length
    let skippedCount = 0
    let clampedCount = 0
    try {
      if (request.format === 'edl') {
        const edl = serializeUnifiedSearchEdl(request)
        const validation = validateCmx3600Edl(edl.content)
        if (!validation.ok)
          throw new Error(`Generated EDL failed validation: ${validation.errors.join(', ')}`)
        payload = edl.content
        exportedCount = edl.exportedCount
        skippedCount = edl.skippedCount
        clampedCount = edl.clampedCount
      } else if (request.format === 'fcpxml') {
        const fcpxml = serializeUnifiedSearchFcpxml(request)
        const validation = validateFcpxml(fcpxml.content)
        if (!validation.ok) {
          throw new Error(`Generated FCPXML failed validation: ${validation.errors.join(', ')}`)
        }
        payload = fcpxml.content
        exportedCount = fcpxml.exportedCount
        skippedCount = fcpxml.skippedCount
        clampedCount = fcpxml.clampedCount
      } else {
        payload = serializeUnifiedSearchExport(request)
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const options = {
      title: 'Export search results',
      defaultPath: `siftory-search-results.${extension}`,
      filters: [
        request.format === 'json'
          ? { name: 'JSON', extensions: ['json'] }
          : request.format === 'csv'
            ? { name: 'CSV', extensions: ['csv'] }
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
    if (selected.canceled || !selected.filePath) return { ok: false, error: 'cancelled' }
    const filePath = normalizeUnifiedSearchExportPath(selected.filePath, request.format)
    if (!filePath) return { ok: false, error: 'Invalid export path' }
    try {
      await fs.promises.writeFile(filePath, payload, 'utf8')
      return { ok: true, filePath, exportedCount, skippedCount, clampedCount }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
