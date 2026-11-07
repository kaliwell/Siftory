'use strict'
// Serialized into the isolated Electron main process by Playwright. Observe the
// existing authorized handlers without replacing their behavior or results.
function installGalleryPerformanceObserver({ ipcMain }) {
  const fs = process.getBuiltinModule('node:fs')
  const { performance, monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks')
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()
  const fresh = () => ({
    calls: 0,
    requested: 0,
    succeeded: 0,
    diskHits: 0,
    generated: 0,
    failed: 0,
    pending: 0,
    ipcWallMs: [],
    byExtension: {},
    filesystem: {},
  })
  let metrics = fresh()
  for (const method of ['existsSync', 'utimesSync', 'readFileSync']) {
    const original = fs[method]
    fs[method] = function (...args) {
      if (typeof args[0] !== 'string' || !/[\\/]thumbcache[\\/]/i.test(args[0]))
        return original.apply(this, args)
      const start = performance.now()
      try {
        return original.apply(this, args)
      } finally {
        const value = (metrics.filesystem[method] ||= { calls: 0, wallMs: 0 })
        value.calls++
        value.wallMs += performance.now() - start
      }
    }
  }
  const handlers = ipcMain._invokeHandlers
  if (typeof handlers?.get !== 'function')
    throw new Error('This Electron build cannot expose diagnostic IPC counts')
  for (const channel of ['fm-get-thumbnail', 'fm-get-thumbnails-batch']) {
    const original = handlers.get(channel)
    if (typeof original !== 'function') throw new Error('Thumbnail handler missing')
    handlers.set(channel, async function (...args) {
      const current = metrics
      current.calls++
      current.pending++
      const start = performance.now()
      try {
        const result = await original.apply(this, args)
        const rows = Array.isArray(result) ? result : [result]
        current.requested += rows.length
        for (const row of rows) {
          const ext = process
            .getBuiltinModule('node:path')
            .extname(row.path || '')
            .toLowerCase()
          const item = (current.byExtension[ext] ||= {
            requests: 0,
            diskHits: 0,
            generated: 0,
            failed: 0,
          })
          item.requests++
          if (!row.dataUrl) {
            current.failed++
            item.failed++
          } else {
            current.succeeded++
            if (row.backend) {
              current.generated++
              item.generated++
            } else {
              current.diskHits++
              item.diskHits++
            }
          }
        }
        return result
      } finally {
        current.pending--
        current.ipcWallMs.push(performance.now() - start)
      }
    })
  }
  globalThis.__galleryPerformance = {
    snapshot(reset = false) {
      const result = {
        ...metrics,
        eventLoopDelayMaxMs: histogram.max / 1e6,
        eventLoopDelayMeanMs: Number.isFinite(histogram.mean) ? histogram.mean / 1e6 : null,
      }
      if (reset) {
        metrics = fresh()
        histogram.reset()
      }
      return result
    },
  }
}
module.exports = { installGalleryPerformanceObserver }
