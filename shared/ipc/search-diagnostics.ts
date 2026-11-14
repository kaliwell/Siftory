export const SEARCH_DIAGNOSTIC_IPC = {
  SCAN_ERROR_DIAGNOSTICS: 'imageSearch:scanErrorDiagnostics',
  PERFORMANCE_DIAGNOSTICS: 'imageSearch:performanceDiagnostics',
  SAVE_SEARCH_QUERY_COPY: 'imageSearch:saveSearchQueryCopy',
  GET_SEARCH_DIAGNOSTIC_STATUS: 'imageSearch:getSearchDiagnosticStatus',
  REPORT_SCAN_RESPONSIVENESS: 'imageSearch:reportScanResponsiveness',
  EXPORT_SEARCH_DIAGNOSTICS: 'imageSearch:exportSearchDiagnostics',
  CLEAR_SEARCH_DIAGNOSTICS: 'imageSearch:clearSearchDiagnostics',
  REPORT_SEARCH_DIAGNOSTIC: 'imageSearch:reportSearchDiagnostic',
} as const

export interface DiagnosticActionResult {
  ok: boolean
  enabled?: boolean
  traceId?: string
  capturedThisSession?: number
  dropped?: number
  error?: string
  cancelled?: boolean
}
export interface ResponsivenessMetrics {
  elapsedMs: number
  maxTimerLagMs: number
  maxFrameGapMs: number
  longTaskCount: number
  longTaskMaxMs: number
}
