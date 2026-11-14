const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

function fixture(active = true) {
  let now = 0,
    timer,
    frame,
    observe,
    cleanup
  const calls = [],
    listeners = new Map()
  const doc = {
    hidden: false,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  }
  const context = {
    exports: {},
    require: () => ({
      useEffect: (fn) => {
        cleanup = fn()
      },
    }),
    performance: { now: () => now },
    document: doc,
    window: {
      electronAPI: {
        imageSearch: {
          reportScanResponsiveness: (sample) => {
            calls.push(sample)
            return Promise.resolve({ ok: true })
          },
        },
      },
    },
    setInterval: (fn) => {
      timer = fn
      return 1
    },
    clearInterval: () => {
      timer = undefined
    },
    requestAnimationFrame: (fn) => {
      frame = fn
      return 1
    },
    cancelAnimationFrame: () => {
      frame = undefined
    },
    PerformanceObserver: class {
      static supportedEntryTypes = ['longtask']
      constructor(fn) {
        observe = fn
      }
      observe() {}
      disconnect() {
        observe = undefined
      }
    },
  }
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync('src/hooks/useScanResponsiveness.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  )
  context.exports.useScanResponsiveness(active)
  return {
    calls,
    doc,
    listeners,
    advance: (ms) => {
      now += ms
    },
    tick: () => timer?.(),
    frame: () => frame?.(now),
    task: (duration) => observe?.({ getEntries: () => [{ startTime: now, duration }] }),
    close: () => cleanup?.(),
    manual: (enabled) => context.exports.setManualPerformanceSampling(enabled),
    resources: () => [timer, frame, observe].filter(Boolean).length,
  }
}

test('Renderer records stalls without React state updates and stops every observer on cleanup', () => {
  const f = fixture()
  f.advance(180)
  f.frame()
  f.task(120)
  f.advance(4820)
  f.tick()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].longTaskCount, 1)
  assert.equal(f.calls[0].longTaskMaxMs, 120)
  assert.equal(f.calls[0].maxFrameGapMs, 180)
  assert.equal(f.calls[0].maxTimerLagMs, 4800)
  // A report still waiting on main must not accumulate more IPC requests.
  f.advance(5000)
  f.tick()
  assert.equal(f.calls.length, 1)
  f.close()
  assert.equal(f.resources(), 0)
  assert.equal(f.listeners.size, 0)
})

test('hidden windows do not produce false frame stalls and inactive scans allocate no samplers', () => {
  const inactive = fixture(false)
  assert.equal(inactive.resources(), 0)
  const f = fixture()
  f.doc.hidden = true
  f.listeners.get('visibilitychange')()
  f.advance(30000)
  f.tick()
  f.task(20000)
  assert.equal(f.calls.length, 0)
  f.doc.hidden = false
  f.listeners.get('visibilitychange')()
  f.advance(16)
  f.frame()
  f.close()
  assert.equal(f.calls[0].maxFrameGapMs, 16)
  assert.equal(f.calls[0].longTaskCount, 0)
  assert.equal(f.calls[0].elapsedMs, 16)
})

test('manual sampling survives page unmount and shares the automatic sampler', () => {
  const f = fixture()
  f.manual(true)
  f.close()
  assert.equal(f.resources(), 3)
  f.advance(5000)
  f.tick()
  assert.equal(f.calls.length, 1)
  f.manual(false)
  assert.equal(f.resources(), 0)
  assert.equal(f.listeners.size, 0)
})
