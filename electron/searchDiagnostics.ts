import { app } from 'electron'
import path from 'node:path'
import crypto from 'node:crypto'
import { SearchDiagnosticStore } from './searchDiagnosticStore'

let store: SearchDiagnosticStore | undefined
const recentInputs = new Map<
  string,
  { path: string; fingerprint: Promise<Record<string, unknown>> }
>()
let captureQueue = Promise.resolve(false)
export function saveSearchQueryCopy(traceId: string): Promise<boolean> {
  const input = recentInputs.get(traceId)
  if (!input) return Promise.resolve(false)
  captureQueue = captureQueue
    .catch(() => false)
    .then(async () => {
      const fingerprint = await input.fingerprint
      if (fingerprint.status !== 'stable' || typeof fingerprint.sha256 !== 'string') return false
      return getSearchDiagnostics().saveQueryCopy(traceId, input.path, fingerprint.sha256)
    })
    .catch(() => false)
  return captureQueue
}
export function getSearchDiagnostics(): SearchDiagnosticStore {
  if (!store) {
    store = new SearchDiagnosticStore(
      path.join(app.getPath('userData'), 'diagnostics', 'search'),
      app.getVersion(),
    )
    app.once('before-quit', (event) => {
      event.preventDefault()
      void Promise.race([
        store!.flush(),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]).finally(() => app.quit())
    })
    store.append('session', 'session-start', {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
    })
  }
  return store
}

export function beginSearchDiagnostic(inputPath: string, parameters: unknown) {
  const recorder = getSearchDiagnostics()
  const id = crypto.randomUUID()
  const started = Date.now()
  recorder.append(id, 'query-start', {
    parameters,
    inputOrigin: path.basename(inputPath).startsWith('clipboard-') ? 'clipboard' : 'file-or-drop',
  })
  const fingerprint = recorder.fingerprint(inputPath)
  recentInputs.set(id, { path: inputPath, fingerprint })
  if (recentInputs.size > 32) recentInputs.delete(recentInputs.keys().next().value!)
  recorder.track(fingerprint.then((input) => recorder.append(id, 'query-input', input)))
  let lastPhase = ''
  return {
    id,
    event: (name: string, detail: unknown) => recorder.append(id, name, detail),
    phase: (phase: string, detail: unknown) => {
      if (phase === lastPhase) return
      lastPhase = phase
      recorder.append(id, 'phase', { phase, elapsedMs: Date.now() - started, detail })
    },
    results: (
      name: string,
      results: Array<{
        path?: string
        imageId?: string
        id?: string
        finalScore?: number
        score?: number
        vectorScore?: number
        hashScore?: number
        colorScore?: number
        shapeScore?: number
        indexSources?: string[]
      }>,
    ) => {
      recorder.track(
        Promise.all(
          results.slice(0, 50).map(async (r, i) => ({
            rank: i + 1,
            id: await recorder.identity(
              String(r.path || r.imageId || r.id || 'unknown').toLowerCase(),
            ),
            score: r.finalScore ?? r.score,
            vector: r.vectorScore,
            hash: r.hashScore,
            color: r.colorScore,
            shape: r.shapeScore,
            sources: r.indexSources,
          })),
        )
          .then((items) => recorder.append(id, name, { count: results.length, items }))
          .catch(() => recorder.append(id, 'candidate-log-unavailable')),
      )
    },
  }
}
