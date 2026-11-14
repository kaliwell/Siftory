import { setShellPreviewDiagnosticSink } from './projectPreviewShellRuntime'
import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { SearchDiagnosticStore } from './searchDiagnosticStore'
import {
  PerformanceDiagnosticSession,
  summarizeResponsiveness,
} from './performanceDiagnosticSession'

let store: SearchDiagnosticStore | undefined
export function getPerformanceDiagnosticStore(): SearchDiagnosticStore {
  if (!store) {
    store = new SearchDiagnosticStore(
      path.join(app.getPath('userData'), 'diagnostics', 'performance'),
      app.getVersion(),
    )
    app.once('before-quit', (event) => {
      event.preventDefault()
      performanceSession.stop()
      void Promise.race([
        store!.flush(),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]).finally(() => app.quit())
    })
  }
  return store
}

export const performanceSession = new PerformanceDiagnosticSession(
  (id, event, detail) => {
    getPerformanceDiagnosticStore().append(id, event, detail)
    if (event === 'preview-main-window') {
      getPerformanceDiagnosticStore().append(id, 'process-resources', {
        mainRssBytes: process.memoryUsage.rss(),
        systemFreeBytes: os.freemem(),
        processes: app.getAppMetrics().map((p) => ({
          type: p.type,
          cpuPercent: p.cpu.percentCPUUsage,
          workingSetKiB: p.memory.workingSetSize,
        })),
      })
    }
  },
  () => ({
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    logicalCpus: os.availableParallelism(),
    systemMemoryBytes: os.totalmem(),
  }),
)

setShellPreviewDiagnosticSink((metrics) =>
  performanceSession.recorder?.event('shell-preview', metrics),
)

export function performanceDiagnosticStatus() {
  const store = getPerformanceDiagnosticStore()
  return {
    ok: true,
    enabled: !!performanceSession.recorder,
    traceId: performanceSession.recorder?.id,
    dropped: store.dropped,
    error: store.error,
  }
}

export async function exportPerformanceSnapshot() {
  const snapshot = await getPerformanceDiagnosticStore().snapshot()
  return {
    ...snapshot,
    scope: 'manual-performance-test',
    recording: !!performanceSession.recorder,
    summary: summarizeResponsiveness(snapshot.records as unknown[]),
  }
}

// A test may be started after the automatic preview scan recorder already exists.
export function captureLinkedPreviewWindow(traceId: string, event: string, detail: unknown): void {
  const manual = performanceSession.recorder
  if (manual && event === 'preview-main-window') {
    getPerformanceDiagnosticStore().append(manual.id, 'preview-stage-window', {
      ...(detail as Record<string, unknown>),
      linkedTraceId: traceId,
    })
  }
}
