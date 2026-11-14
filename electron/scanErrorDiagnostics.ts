import { app } from 'electron'
import path from 'node:path'
import { SearchDiagnosticStore } from './searchDiagnosticStore'
import { scanErrorRecorder } from './scanErrorLog'

let store: SearchDiagnosticStore | undefined
export function initializeScanErrorDiagnostics(): SearchDiagnosticStore {
  if (!store) {
    store = new SearchDiagnosticStore(
      path.join(app.getPath('userData'), 'diagnostics', 'scan-errors'),
      app.getVersion(),
    )
    scanErrorRecorder.configure(
      (id, event, detail) => store!.append(id, event, detail),
      () => store!.flush(),
      () => store!.pendingRecords < 48,
    )
    app.once('before-quit', (event) => {
      event.preventDefault()
      scanErrorRecorder.flush()
      void Promise.race([
        store!.flush(),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]).finally(() => app.quit())
    })
  }
  return store
}
export async function scanErrorSnapshot(includePaths: boolean) {
  const store = initializeScanErrorDiagnostics()
  await scanErrorRecorder.waitForCollection()
  scanErrorRecorder.flush()
  const snapshot = await store.snapshot()
  const all = snapshot.records as {
    traceId: string
    event: string
    detail?: { items?: { sourceId?: string; stage?: string; code?: string }[] }
  }[]
  const runId = all.at(-1)?.traceId
  const records = all.filter((item) => item.traceId === runId)
  const byCode: Record<string, number> = {}
  const ids = new Set<string>()
  for (const row of records)
    for (const item of row.detail?.items ?? []) {
      const key = `${item.stage}:${item.code}`
      byCode[key] = (byCode[key] ?? 0) + 1
      if (item.sourceId) ids.add(item.sourceId)
    }
  const mapping = scanErrorRecorder.pathMappings(includePaths)
  const sessionFilePaths = mapping
    ? Object.fromEntries(Object.entries(mapping).filter(([id]) => ids.has(id)))
    : undefined
  return {
    ...snapshot,
    records,
    scope: 'scan-and-preview-errors',
    runId,
    summary: { byCode, uniqueSources: ids.size },
    historyRecordsExcluded: all.length - records.length,
    currentSession: scanErrorRecorder.status(),
    includesFilePaths: includePaths,
    sessionFilePaths,
    pathMappingScope:
      'Only paths observed during this app session; older records remain anonymous.',
  }
}
