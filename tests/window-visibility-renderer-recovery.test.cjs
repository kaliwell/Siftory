const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { fixture: controllerFixture } = require('./window-visibility-recovery-fixture.cjs')

// Execute the actual renderer callbacks without starting Electron, a browser,
// React DOM, a native window or desktop/input APIs. All queues are deterministic.
const root = path.resolve(__dirname, '..')
const ts = require('typescript')
const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function queues() {
  let next = 0
  const frames = new Map(),
    timers = new Map(),
    intervals = new Map(),
    messages = []
  const add = (map, callback) => {
    map.set(++next, callback)
    return next
  }
  const drain = (map) => {
    let count = 0
    while (map.size) {
      assert.ok(++count < 100, 'fixture queue must remain bounded')
      const [id, callback] = map.entries().next().value
      map.delete(id)
      callback()
    }
  }
  return {
    frames,
    timers,
    intervals,
    messages,
    requestAnimationFrame: (callback) => add(frames, callback),
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (callback) => add(timers, callback),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback) => add(intervals, callback),
    clearInterval: (id) => intervals.delete(id),
    flushFrames: () => drain(frames),
    flushTimers: () => drain(timers),
    flushMessages: () => {
      while (messages.length) messages.shift()()
    },
  }
}

function events() {
  const listeners = new Map()
  return {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
    emit: (name, event) => listeners.get(name)?.(event),
  }
}

function mouseFixture(overrides = {}) {
  const q = queues(),
    windowEvents = events(),
    documentEvents = events()
  const pending = deferred(),
    calls = []
  let cleanup
  const document = {
    ...documentEvents,
    documentElement: { dataset: { windowVisibilityGeneration: '0' } },
    elementFromPoint: () => ({ closest: () => ({}) }),
  }
  const window = {
    ...q,
    ...windowEvents,
    electronAPI: {
      setIgnoreMouseEvents: (ignore, generation) => {
        calls.push({ ignore, generation })
        if (overrides.setIgnore) return overrides.setIgnore(ignore, generation)
        return calls.length === 1 ? pending.promise : Promise.resolve()
      },
    },
  }
  const mod = { exports: {} }
  new Function(
    'require',
    'module',
    'exports',
    'window',
    'document',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    compile(read('src/hooks/useMouseTransparency.ts')),
  )(
    (id) => {
      assert.equal(id, 'react')
      return {
        useEffect: (callback) => {
          cleanup = callback()
        },
      }
    },
    mod,
    mod.exports,
    window,
    document,
    q.requestAnimationFrame,
    q.cancelAnimationFrame,
  )
  mod.exports.useMouseTransparency()
  return {
    q,
    calls,
    pending,
    cleanup: () => cleanup(),
    hover() {
      documentEvents.emit('mousemove', { clientX: 10, clientY: 10 })
      q.flushFrames()
    },
    generation(generation, state = 'visible') {
      document.documentElement.dataset.windowVisibilityGeneration = String(generation)
      windowEvents.emit('window-visibility-state', {
        detail: { generation, state, reason: 'recovery' },
      })
    },
  }
}

function rendererFixture(overrides = {}) {
  const source = read('src/components/LegacyOverlayDiagnostics.tsx')
  const ast = ts.createSourceFile(
    'LegacyOverlayDiagnostics.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const matches = []
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'useEffect' &&
      node.getText(ast).includes("let lastShape = ''") &&
      node.getText(ast).includes('setOverlayShape')
    )
      matches.push(node)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(matches.length, 1, 'extract the actual legacy diagnostic Shape effect')
  const q = queues(),
    ev = events(),
    calls = [],
    dispatched = [],
    origins = []
  const shape = deferred(),
    reveal = deferred()
  const visibilityGenerationRef = { current: 2 }
  let cleanup
  const window = {
    ...q,
    ...ev,
    dispatchEvent: (event) => {
      dispatched.push(event)
      ev.emit(event.type, event)
      if (event.type === 'window-visibility-state') overrides.onVisibility?.(event.detail)
    },
    electronAPI: {
      setOverlayShape: (rects, generation) => {
        calls.push(['shape', generation])
        return overrides.shape ? overrides.shape(rects, generation) : shape.promise
      },
      showWindow: (generation) => {
        calls.push(['show', generation])
        return overrides.show ? overrides.show(generation) : Promise.resolve(true)
      },
      revealWindow: (generation) => {
        calls.push(['reveal', generation])
        return overrides.reveal ? overrides.reveal(generation) : reveal.promise
      },
    },
  }
  const document = {
    documentElement: { dataset: {} },
    body: { getBoundingClientRect: () => ({}) },
    querySelectorAll: () => [
      { getBoundingClientRect: () => ({ left: 20, top: 20, width: 100, height: 100 }) },
    ],
  }
  function MessageChannel() {
    this.port1 = { onmessage: null, close() {} }
    this.port2 = { postMessage: () => q.messages.push(() => this.port1.onmessage?.()), close() {} }
  }
  class Observer {
    observe() {}
    disconnect() {}
  }
  class CustomEvent {
    constructor(type, init) {
      this.type = type
      this.detail = init.detail
    }
  }
  new Function(
    'useEffect',
    'visibilityGenerationRef',
    'window',
    'document',
    'requestAnimationFrame',
    'ResizeObserver',
    'MutationObserver',
    'MessageChannel',
    'useStore',
    'setOverlayOrigin',
    'CustomEvent',
    compile(matches[0].getText(ast)),
  )(
    (callback) => {
      cleanup = callback()
    },
    visibilityGenerationRef,
    window,
    document,
    q.requestAnimationFrame,
    Observer,
    Observer,
    MessageChannel,
    { getState: () => ({ workArea: { width: 800, height: 600 } }) },
    (origin) => origins.push(origin),
    CustomEvent,
  )
  return {
    q,
    calls,
    shape,
    reveal,
    dispatched,
    origins,
    cleanup: () => cleanup(),
    prepare() {
      ev.emit('window-visibility-prepare-show', { detail: { generation: 2, reason: 'recovery' } })
    },
    prewarmed(detail = { generation: 2, reason: 'recovery', state: 'preparing-show' }) {
      ev.emit('window-visibility-native-prewarmed', {
        detail,
      })
    },
    retire() {
      visibilityGenerationRef.current = 3
      ev.emit('window-visibility-state', {
        detail: { generation: 3, state: 'hidden', reason: 'recovery' },
      })
    },
  }
}

test('mouse late ACK retries the active generation instead of claiming it already applied', async () => {
  const f = mouseFixture()
  f.hover()
  f.generation(1)
  f.pending.resolve()
  await settle()
  assert.deepEqual(f.calls, [
    { ignore: false, generation: 0 },
    { ignore: false, generation: 1 },
  ])
  f.cleanup()
})

test('mouse late ACK cannot overwrite cleanup click-through after unmount', async () => {
  const f = mouseFixture()
  f.hover()
  f.generation(1)
  f.cleanup()
  const before = f.calls.slice()
  assert.deepEqual(before.at(-1), { ignore: true, generation: 1 })
  f.pending.resolve()
  await settle()
  assert.deepEqual(f.calls, before)
  assert.equal(f.q.timers.size, 0)
})

test('mouse late native rejection cannot create a retry after unmount', async () => {
  const f = mouseFixture()
  f.hover()
  f.cleanup()
  f.pending.reject(new Error('simulated native failure'))
  await settle()
  assert.equal(f.calls.length, 2)
  assert.equal(f.q.timers.size, 0)
})

test('retiring renderer generation cancels pending layout work before Shape IPC', () => {
  const f = rendererFixture()
  f.prepare()
  f.retire()
  f.q.flushMessages()
  f.q.flushFrames()
  assert.deepEqual(f.calls, [])
  f.cleanup()
})

test('retired Shape result cannot update origin or start a stale show handshake', async () => {
  const f = rendererFixture()
  f.prepare()
  f.q.flushMessages()
  f.retire()
  f.shape.resolve({ x: 100, y: 50 })
  await settle()
  assert.deepEqual(f.calls, [['shape', 2]])
  assert.deepEqual(f.origins, [])
  f.cleanup()
})

test('Shape completion after unmount cannot show the native window', async () => {
  const f = rendererFixture()
  f.prepare()
  f.q.flushMessages()
  f.cleanup()
  f.shape.resolve({ x: 100, y: 50 })
  await settle()
  assert.deepEqual(f.calls, [['shape', 2]])
  assert.deepEqual(f.origins, [])
})

test('reveal completion after unmount cannot publish renderer visible state', async () => {
  const f = rendererFixture()
  f.prepare()
  f.q.flushMessages()
  f.shape.resolve({ x: 0, y: 0 })
  await settle()
  f.prewarmed()
  f.q.flushFrames()
  assert.deepEqual(f.calls, [
    ['shape', 2],
    ['show', 2],
    ['reveal', 2],
  ])
  f.cleanup()
  f.reveal.resolve(true)
  await settle()
  assert.deepEqual(f.dispatched, [])
})

test('live renderer still completes current Shape, prewarm and reveal handshake', async () => {
  const f = rendererFixture()
  f.prepare()
  f.q.flushMessages()
  f.shape.resolve({ x: 12, y: 8 })
  await settle()
  assert.deepEqual(f.origins, [{ x: 12, y: 8 }])
  f.prewarmed()
  f.q.flushFrames()
  f.reveal.resolve(true)
  await settle()
  assert.deepEqual(f.calls, [
    ['shape', 2],
    ['show', 2],
    ['reveal', 2],
  ])
  assert.deepEqual(
    f.dispatched.map((event) => event.detail),
    [{ generation: 2, state: 'visible', reason: 'recovery' }],
  )
  f.cleanup()
})

test('a failed new Shape is retried with current geometry before any show', async () => {
  let attempts = 0
  const f = rendererFixture({
    shape: () =>
      ++attempts === 1
        ? Promise.reject(new Error('temporary native failure'))
        : Promise.resolve({ x: 0, y: 0 }),
  })
  f.prepare()
  f.q.flushMessages()
  await settle()
  assert.equal(f.calls.filter(([kind]) => kind === 'show').length, 0)
  for (let i = 0; i < 3 && !f.calls.some(([kind]) => kind === 'show'); i++) {
    f.q.flushTimers()
    f.q.flushMessages()
    await settle()
    f.q.flushFrames()
    await settle()
  }
  assert.ok(attempts >= 2)
  assert.ok(f.calls.some(([kind]) => kind === 'show'))
  f.cleanup()
})

test('persistent native Shape failures have a finite recovery retry budget', async () => {
  const f = rendererFixture({ shape: () => Promise.reject(new Error('native unavailable')) })
  f.prepare()
  f.q.flushMessages()
  await settle()
  for (let i = 0; i < 8; i++) {
    f.q.flushTimers()
    f.q.flushMessages()
    f.q.flushFrames()
    await settle()
  }
  assert.equal(f.calls.filter(([kind]) => kind === 'show').length, 0)
  assert.ok(f.calls.filter(([kind]) => kind === 'shape').length <= 5)
  assert.equal(f.q.timers.size, 0)
  f.cleanup()
})

test('a retired recovery retry cannot submit a new Shape or show', async () => {
  const f = rendererFixture({ shape: () => Promise.reject(new Error('native unavailable')) })
  f.prepare()
  f.q.flushMessages()
  await settle()
  const before = f.calls.slice()
  f.retire()
  f.q.flushTimers()
  f.q.flushMessages()
  f.q.flushFrames()
  await settle()
  assert.deepEqual(f.calls, before)
  f.cleanup()
})

test('a failed native reveal retries paint confirmation before marking visible', async () => {
  let attempts = 0
  const f = rendererFixture({ reveal: () => Promise.resolve(++attempts > 1) })
  f.prepare()
  f.q.flushMessages()
  f.shape.resolve({ x: 0, y: 0 })
  await settle()
  f.prewarmed()
  f.q.flushFrames()
  await settle()
  assert.equal(f.dispatched.length, 0)
  f.q.flushTimers()
  f.q.flushFrames()
  await settle()
  assert.equal(attempts, 2)
  assert.equal(f.dispatched.length, 1)
  f.cleanup()
})

test('actual controller and renderer recover after Shape failures outlast retries and timeout', async () => {
  const controller = controllerFixture()
  controller.event()
  controller.event()
  assert.equal(controller.generation(), 2)
  let nativeUnavailable = true
  const originalShape = controller.nativeWindow.setShape
  controller.nativeWindow.setShape = (rects) => {
    if (nativeUnavailable && rects.length) throw new Error('temporary native outage')
    originalShape(rects)
  }
  const f = rendererFixture({
    shape: async (rects, generation) => controller.invoke('set-overlay-shape', rects, generation),
    show: async (generation) => controller.invoke('show-window', generation),
    reveal: async (generation) => controller.invoke('reveal-window', generation),
  })
  const send = controller.nativeWindow.webContents.send
  controller.nativeWindow.webContents.send = (channel, data) => {
    send(channel, data)
    if (channel === 'global-window-shown-for-paint') f.prewarmed(data)
  }
  f.prepare()
  f.q.flushMessages()
  await settle()
  for (let i = 0; i < 8; i++) {
    f.q.flushTimers()
    f.q.flushMessages()
    f.q.flushFrames()
    await settle()
  }
  assert.equal(f.q.timers.size, 0)
  assert.equal(f.calls.filter(([kind]) => kind === 'show').length, 0)
  const fallback = [...controller.timers].find((timer) => timer.ms === 900)
  fallback.fn()
  assert.deepEqual(controller.last('opacity'), ['opacity', 0])
  assert.ok(controller.diagnostics.some((row) => row.code === 'fallback-without-shape'))
  nativeUnavailable = false
  // Only the existing 1.5s geometry observer tick occurs; no new recovery
  // event, generation reset, forced hotkey or unbounded retry loop.
  for (const callback of f.q.intervals.values()) callback()
  f.q.flushTimers()
  f.q.flushFrames()
  await settle()
  f.q.flushMessages()
  await settle()
  f.q.flushFrames()
  await settle()
  assert.equal(controller.generation(), 2)
  assert.ok(controller.diagnostics.some((row) => row.code === 'visible' && row.generation === 2))
  assert.ok(f.dispatched.some((event) => event.detail.state === 'visible'))
  assert.deepEqual(controller.last('opacity'), ['opacity', 1])
  f.cleanup()
})

async function paintFailureFixture() {
  const controller = controllerFixture()
  controller.event()
  controller.event()
  let unavailable = true
  const setOpacity = controller.nativeWindow.setOpacity
  controller.nativeWindow.setOpacity = (opacity) => {
    if (unavailable && opacity === 1) throw new Error('temporary native reveal outage')
    setOpacity(opacity)
  }
  const mouse = mouseFixture({
    setIgnore: async (ignore, generation) =>
      controller.invoke('set-ignore-mouse', ignore, generation),
  })
  mouse.generation(2, 'preparing-show')
  mouse.hover()
  const renderer = rendererFixture({
    shape: async (rects, generation) => controller.invoke('set-overlay-shape', rects, generation),
    show: async (generation) => controller.invoke('show-window', generation),
    reveal: async (generation) => controller.invoke('reveal-window', generation),
    onVisibility: (detail) => mouse.generation(detail.generation, detail.state),
  })
  const send = controller.nativeWindow.webContents.send
  controller.nativeWindow.webContents.send = (channel, data) => {
    send(channel, data)
    if (channel === 'global-window-shown-for-paint') renderer.prewarmed(data)
  }
  renderer.prepare()
  renderer.q.flushMessages()
  await settle()
  for (let i = 0; i < 8; i++) {
    renderer.q.flushTimers()
    renderer.q.flushMessages()
    renderer.q.flushFrames()
    await settle()
  }
  assert.equal(renderer.q.timers.size, 0)
  assert.equal(renderer.calls.filter(([kind]) => kind === 'reveal').length, 4)
  assert.equal(renderer.dispatched.length, 0)
  const tick = async () => {
    for (const callback of renderer.q.intervals.values()) callback()
    renderer.q.flushTimers()
    renderer.q.flushFrames()
    await settle()
    renderer.q.flushFrames()
    await settle()
  }
  return {
    controller,
    renderer,
    tick,
    recover: () => {
      unavailable = false
    },
    fallback: () => [...controller.timers].find((timer) => timer.ms === 900).fn(),
    cleanup: () => {
      renderer.cleanup()
      mouse.cleanup()
    },
  }
}

test('successful native fallback immediately commits renderer visibility and mouse interaction once', async () => {
  const f = await paintFailureFixture()
  f.recover()
  f.fallback()
  await settle()
  assert.equal(f.renderer.dispatched.filter((event) => event.detail.state === 'visible').length, 1)
  assert.deepEqual(f.controller.last('mouse'), ['mouse', false])
  assert.deepEqual(f.controller.last('opacity'), ['opacity', 1])
  await f.tick()
  await f.tick()
  assert.equal(f.renderer.dispatched.length, 1)
  assert.equal(f.controller.diagnostics.filter((row) => row.code === 'visible').length, 1)
  assert.equal(f.renderer.calls.filter(([kind]) => kind === 'reveal').length, 4)
  f.cleanup()
})

test('paint recovery after failed fallback uses one attempt per existing periodic tick with unchanged geometry', async () => {
  const f = await paintFailureFixture()
  f.fallback()
  assert.deepEqual(f.controller.last('opacity'), ['opacity', 0])
  const shapes = f.renderer.calls.filter(([kind]) => kind === 'shape').length
  await f.tick()
  assert.equal(f.renderer.calls.filter(([kind]) => kind === 'reveal').length, 5)
  assert.equal(f.renderer.q.timers.size, 0)
  await f.tick()
  assert.equal(f.renderer.calls.filter(([kind]) => kind === 'reveal').length, 6)
  assert.equal(f.renderer.q.timers.size, 0)
  f.recover()
  await f.tick()
  assert.equal(f.renderer.calls.filter(([kind]) => kind === 'reveal').length, 7)
  assert.equal(f.renderer.calls.filter(([kind]) => kind === 'shape').length, shapes)
  assert.equal(f.renderer.dispatched.filter((event) => event.detail.state === 'visible').length, 1)
  assert.deepEqual(f.controller.last('mouse'), ['mouse', false])
  assert.deepEqual(f.controller.last('opacity'), ['opacity', 1])
  await f.tick()
  assert.equal(f.renderer.dispatched.length, 1)
  assert.equal(f.renderer.calls.filter(([kind]) => kind === 'reveal').length, 7)
  f.cleanup()
})

test('a late paint ACK cannot duplicate the fallback visibility commit', async () => {
  const controller = controllerFixture()
  controller.event()
  controller.event()
  const pending = deferred()
  const f = rendererFixture({
    shape: async (rects, generation) => controller.invoke('set-overlay-shape', rects, generation),
    show: async (generation) => controller.invoke('show-window', generation),
    reveal: () => pending.promise,
  })
  const send = controller.nativeWindow.webContents.send
  controller.nativeWindow.webContents.send = (channel, data) => {
    send(channel, data)
    if (channel === 'global-window-shown-for-paint') f.prewarmed(data)
  }
  f.prepare()
  f.q.flushMessages()
  await settle()
  f.q.flushFrames()
  const fallback = [...controller.timers].find((timer) => timer.ms === 900)
  fallback.fn()
  assert.equal(f.dispatched.length, 1)
  pending.resolve(true)
  await settle()
  assert.equal(f.dispatched.length, 1)
  assert.equal(controller.diagnostics.filter((row) => row.code === 'visible').length, 1)
  f.cleanup()
})
