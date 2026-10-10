import fs from 'fs'
import path from 'path'
import type { BrowserWindow } from 'electron'

// Diagnostic-only connected-document inventory. The renderer-wide Memory counter
// remains the test verdict; this does not cover detached targets or other worlds.
const listenerInventoryExpression = `(() => {
  if (typeof getEventListeners !== 'function') return { available: false }
  const knownPanels = new Set(['clock', 'folders', 'prompts', 'settings', 'calculator',
    'file-manager', 'image-search', 'unified-search', 'app-storage', 'remote-terminal',
    'duplicate-finder', 'media-search', 'asset-library', 'batch-rename'])
  const elements = Array.from(document.querySelectorAll('*'))
  const limit = 5000
  const targets = [window, document, ...elements.slice(0, limit)]
  const counts = Object.create(null)
  let listeners = 0
  const group = target => {
    if (target === window) return 'window'
    if (target === document) return 'document'
    if (target === document.documentElement) return 'html'
    if (target === document.body) return 'body'
    if (target === document.getElementById('root')) return 'react-root'
    if (target.closest('.workspace-navigator')) return 'workspace-navigator'
    const panel = target.closest('.panel')?.getAttribute('data-panel')
    return knownPanels.has(panel) ? 'panel:' + panel : 'other-dom'
  }
  for (const target of targets) {
    for (const [type, entries] of Object.entries(getEventListeners(target))) {
      for (const entry of entries) {
        const key = JSON.stringify([group(target), target.tagName || 'non-element', type,
          Boolean(entry.useCapture), Boolean(entry.passive), Boolean(entry.once)])
        counts[key] = (counts[key] || 0) + 1
        listeners += 1
      }
    }
  }
  const image = document.querySelector('.panel[data-panel="image-search"]')
  return { available: true, sampledAt: performance.now(), timeOrigin: performance.timeOrigin,
    visibilityState: document.visibilityState, hidden: document.hidden, focused: document.hasFocus(),
    totalDomElements: elements.length, sampledTargets: targets.length,
    truncated: elements.length > limit, listeners, counts,
    state: {
      ready: document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ready') === 'true',
      imagePanelVisible: image instanceof HTMLElement && image.offsetParent !== null,
      searchDomainActive: document.querySelector('[data-testid="workspace-domain-search"]')?.getAttribute('aria-pressed') === 'true',
      advancedSearchExpanded: document.querySelector('[data-testid="workspace-search-advanced-toggle"]')?.getAttribute('aria-expanded') === 'true',
      modelMenuPresent: !!document.querySelector('[data-testid="global-model-readiness"]'),
      navigatorMoving: document.querySelector('.workspace-navigator')?.getAttribute('data-moving') === 'true',
      panelInteractionActive: document.documentElement.dataset.panelInteraction === 'active',
      visibilityGeneration: Number(document.documentElement.dataset.windowVisibilityGeneration) || 0
    }
  }
})()`

const samples: unknown[] = []

// Observe native onclick assignments without retaining elements or callbacks.
// This hook exists only in an explicitly requested temporary smoke session.
const onclickDiagnosticExpression = `(() => {
  const key = '__siftorySmokeOnclickAssignments'
  if (!window[key]) {
    const owner = HTMLElement.prototype
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'onclick')
    if (!descriptor?.configurable || !descriptor.get || !descriptor.set) return { available: false }
    const knownPanels = new Set(['clock', 'folders', 'prompts', 'settings', 'calculator',
      'file-manager', 'image-search', 'unified-search', 'app-storage', 'remote-terminal',
      'duplicate-finder', 'media-search', 'asset-library', 'batch-rename'])
    const counts = Object.create(null)
    const lastBuckets = []
    let assignments = 0
    Object.defineProperty(owner, 'onclick', { ...descriptor, set(value) {
      const prior = descriptor.get.call(this)
      descriptor.set.call(this, value)
      const panel = this.closest('.panel')?.getAttribute('data-panel')
      const group = this.closest('.workspace-navigator') ? 'workspace-navigator' :
        knownPanels.has(panel) ? 'panel:' + panel : 'other-dom'
      const label = JSON.stringify([group, this.tagName, typeof value, prior === value])
      counts[label] = (counts[label] || 0) + 1
      assignments += 1
      const bucketId = Math.floor(performance.now() / 100)
      let bucket = lastBuckets[lastBuckets.length - 1]
      if (!bucket || bucket.id !== bucketId) {
        bucket = { id: bucketId, counts: Object.create(null) }
        lastBuckets.push(bucket)
        if (lastBuckets.length > 30) lastBuckets.shift()
      }
      bucket.counts[label] = (bucket.counts[label] || 0) + 1
    } })
    Object.defineProperty(window, key, { configurable: true, value: {
      snapshot: () => ({ available: true, assignments, counts, lastBuckets }),
      restore: () => { Object.defineProperty(owner, 'onclick', descriptor); delete window[key] }
    } })
  }
  return window[key].snapshot()
})()`

export async function captureUiSmokeListenerDiagnostic(
  window: BrowserWindow,
  phase: string,
  counters: { documents: number; jsEventListeners: number; nodes: number; usedHeapBytes: number },
  attachedHere: boolean,
): Promise<void> {
  const reportPath = process.env.FLOATING_CLOCK_UI_SMOKE_REPORT
  if (process.env.FLOATING_CLOCK_UI_SMOKE_LISTENER_DIAGNOSTICS !== '1' || !reportPath) return
  const debug = window.webContents.debugger
  const startedAt = Date.now()
  const native = {
    isVisible: window.isVisible(),
    isFocused: window.isFocused(),
    opacity: window.getOpacity(),
    attachedHere,
  }
  let inventory: unknown = null
  let onclickAssignments: unknown = null
  let failed: boolean
  const objectGroup = 'siftory-listener-diagnostic'
  try {
    const assignments = (await debug.sendCommand('Runtime.evaluate', {
      expression: onclickDiagnosticExpression,
      returnByValue: true,
      silent: true,
      objectGroup,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    onclickAssignments = assignments.result?.value ?? null
    const response = (await debug.sendCommand('Runtime.evaluate', {
      expression: listenerInventoryExpression,
      includeCommandLineAPI: true,
      returnByValue: true,
      silent: true,
      objectGroup,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    failed = Boolean(response.exceptionDetails) || !response.result?.value
    if (!failed) inventory = response.result?.value
  } catch {
    failed = true
  } finally {
    if (phase === 'visibility-after') {
      await debug
        .sendCommand('Runtime.evaluate', {
          expression: 'window.__siftorySmokeOnclickAssignments?.restore()',
          returnByValue: true,
          silent: true,
          objectGroup,
        })
        .catch(() => {})
    }
    await debug.sendCommand('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {})
  }
  samples.push({
    phase,
    startedAt,
    completedAt: Date.now(),
    counters,
    native,
    failed,
    inventory,
    onclickAssignments,
  })
  const target = path.join(path.dirname(reportPath), 'listener-diagnostics.json')
  const temporary = `${target}.tmp-${process.pid}`
  fs.writeFileSync(
    temporary,
    JSON.stringify(
      {
        scope:
          'Connected main-document listeners only; original Memory counters decide the smoke verdict.',
        processVersions: process.versions,
        samples,
      },
      null,
      2,
    ),
    'utf8',
  )
  fs.renameSync(temporary, target)
}
