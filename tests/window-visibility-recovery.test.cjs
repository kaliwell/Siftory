const assert = require('node:assert/strict')
const test = require('node:test')
const { fixture } = require('./window-visibility-recovery-fixture.cjs')

for (const eventName of ['display-metrics-changed', 'display-added', 'display-removed']) {
  test(`${eventName} invalidates old shape/mouse and installs topology before new show`, () => {
    const f = fixture()
    f.invoke('set-overlay-shape', [{ x: 200, y: 100, width: 200, height: 100 }], 0)
    const recoveryStart = f.calls.length
    f.event(eventName)
    const generation = f.generation()
    assert.equal(generation, 1)
    const recovering = f.calls.slice(recoveryStart)
    assert.ok(
      recovering.findIndex(([k]) => k === 'opacity') < recovering.findIndex(([k]) => k === 'shape'),
    )
    const workAreaIndex = f.calls.findIndex(([k]) => k === 'work-area-changed')
    const showIndex = f.calls.findIndex(([k]) => k === 'show-global-visibility')
    assert.ok(workAreaIndex >= 0 && workAreaIndex < showIndex)
    const before = f.calls.length
    f.invoke('set-overlay-shape', [{ x: 200, y: 100, width: 200, height: 100 }], 0)
    f.invoke('set-ignore-mouse', false, 0)
    assert.deepEqual(f.calls.slice(before), [['mouse', true]])
    assert.equal(f.invoke('show-window', 0), false)
    assert.equal(f.invoke('reveal-window', 0), false)
    assert.equal(f.invoke('show-window', generation), false, 'fresh geometry is mandatory')
    f.finish()
  })
}

test('DPI and pinned diagnostic scope refresh retire old renderer work', () => {
  const f = fixture()
  f.event('display-metrics-changed', 800, 1.5)
  assert.equal(f.generation(), 1)
  f.finish()
  f.invoke('set-display-scope', { mode: 'primary' })
  assert.equal(f.generation(), 2)
  assert.equal(f.context.workspaceTopology.scope.mode, 'all', 'diagnostic geometry stays pinned')
  f.finish()
})

test('prewarmed reveal and old timeout are fenced across repeated topology changes', () => {
  const f = fixture()
  f.core.setGlobalWindowVisibility(f.options, false, 'settings')
  f.core.setGlobalWindowVisibility(f.options, true, 'settings')
  const oldTimer = [...f.timers].find((timer) => timer.ms === 900)
  f.invoke('set-overlay-shape', [{ x: 10, y: 10, width: 50, height: 50 }], 2)
  assert.equal(f.invoke('show-window', 2), true)
  f.event()
  assert.equal(f.invoke('reveal-window', 2), false)
  assert.equal(f.timers.has(oldTimer), false)
  const before = f.calls.length
  oldTimer.fn()
  assert.equal(f.calls.length, before)
  const superseded = f.generation()
  f.event()
  assert.equal(f.invoke('show-window', superseded), false)
  const timeout = [...f.timers].find((timer) => timer.ms === 900)
  timeout.fn()
  assert.deepEqual(f.last('opacity'), ['opacity', 0])
  assert.ok(f.diagnostics.some((row) => row.code === 'fallback-without-shape'))
  f.finish()
})

test('hidden windows remain hidden through topology and suspend/resume', () => {
  const f = fixture()
  f.core.setGlobalWindowVisibility(f.options, false, 'settings')
  const start = f.calls.length
  f.event()
  f.powerMonitor.emit('suspend')
  f.event()
  f.powerMonitor.emit('resume')
  assert.ok(
    f.calls
      .slice(start)
      .every(
        ([kind, value]) =>
          kind !== 'show-global-visibility' &&
          kind !== 'showInactive' &&
          (kind !== 'opacity' || value === 0),
      ),
  )
  assert.equal(f.invoke('show-window', f.generation()), false)
})

test('suspend cancels preparing-show and resumes only the latest requested visibility', () => {
  const f = fixture()
  f.event()
  const retired = f.generation()
  f.invoke('set-overlay-shape', [{ x: 10, y: 10, width: 50, height: 50 }], retired)
  f.invoke('show-window', retired)
  f.powerMonitor.emit('suspend')
  f.event()
  assert.equal(f.invoke('reveal-window', retired), false)
  f.core.setGlobalWindowVisibility(f.options, false, 'settings')
  f.powerMonitor.emit('resume')
  assert.equal(f.diagnostics.at(-1).state, 'hidden')
  f.powerMonitor.emit('suspend')
  f.core.setGlobalWindowVisibility(f.options, true, 'second-instance')
  assert.equal(f.invoke('show-window', f.generation()), false)
  f.powerMonitor.emit('resume')
  f.finish()
  const generation = f.generation()
  f.powerMonitor.emit('resume')
  assert.equal(f.generation(), generation + 1)
  f.finish()
})

test('visible suspend/resume preserves transparency and requires fresh Shape', () => {
  const f = fixture()
  f.invoke('set-transparency', 25)
  f.powerMonitor.emit('suspend')
  const generation = f.generation()
  f.powerMonitor.emit('suspend')
  assert.equal(f.generation(), generation)
  f.powerMonitor.emit('resume')
  assert.equal(f.invoke('show-window', f.generation()), false)
  f.finish()
  assert.deepEqual(f.last('opacity'), ['opacity', 0.75])
})

for (const operation of ['setIgnoreMouseEvents', 'setShape', 'setOpacity', 'setBounds', 'send']) {
  test(`native ${operation} failure does not escape event dispatch or commit a reveal`, () => {
    const f = fixture()
    const target = operation === 'send' ? f.nativeWindow.webContents : f.nativeWindow
    const original = target[operation]
    target[operation] = () => {
      throw new Error('injected native failure')
    }
    assert.doesNotThrow(() => f.event())
    assert.equal(f.invoke('reveal-window', f.generation()), false)
    assert.ok(f.diagnostics.some((row) => row.code === 'recovery-failed'))
    target[operation] = original
    f.event()
    f.finish()
  })
}

test('destroyed windows safely retire pending work without native calls', () => {
  const f = fixture()
  f.event()
  const oldTimer = [...f.timers].find((timer) => timer.ms === 900)
  f.destroy()
  const start = f.calls.length
  assert.doesNotThrow(() => f.event())
  assert.doesNotThrow(() => f.powerMonitor.emit('suspend'))
  assert.doesNotThrow(() => f.powerMonitor.emit('resume'))
  oldTimer.fn()
  assert.ok(
    f.calls.slice(start).every(([kind]) => kind === 'dispose-ann' || kind === 'dispose-semantic'),
  )
})

test('failed new Shape stays uncommitted and reveal native failure can retry', () => {
  const f = fixture()
  f.event()
  const setShape = f.nativeWindow.setShape
  f.nativeWindow.setShape = () => {
    throw new Error('native Shape failed')
  }
  assert.throws(() =>
    f.invoke('set-overlay-shape', [{ x: 1, y: 1, width: 30, height: 30 }], f.generation()),
  )
  assert.equal(f.invoke('show-window', f.generation()), false)
  f.nativeWindow.setShape = setShape
  f.invoke('set-overlay-shape', [{ x: 1, y: 1, width: 30, height: 30 }], f.generation())
  f.invoke('show-window', f.generation())
  const setOpacity = f.nativeWindow.setOpacity
  f.nativeWindow.setOpacity = () => {
    throw new Error('native opacity failed')
  }
  assert.equal(f.invoke('reveal-window', f.generation()), false)
  assert.equal(f.diagnostics.at(-1).state, 'preparing-show')
  f.nativeWindow.setOpacity = setOpacity
  assert.equal(f.invoke('reveal-window', f.generation()), true)
})

test('no-shape diagnostic still requires new layout ACK and can complete recovery', () => {
  const f = fixture()
  f.options.videoDiagnosticMode = 'no-shape'
  f.event()
  assert.equal(f.invoke('show-window', f.generation()), false)
  f.finish()
  assert.deepEqual(f.last('mouse'), ['mouse', true])
})

test('compact fallback uses only the newly validated native-local Shape', () => {
  const f = fixture()
  f.options.videoDiagnosticMode = 'compact'
  f.event()
  f.invoke('set-overlay-shape', [{ x: 40, y: 50, width: 120, height: 90 }], f.generation())
  const timeout = [...f.timers].find((timer) => timer.ms === 900)
  timeout.fn()
  assert.deepEqual(f.last('shape'), ['shape', [{ x: 0, y: 0, width: 120, height: 90 }]])
  assert.deepEqual(f.last('mouse'), ['mouse', true])
  assert.equal(f.diagnostics.at(-1).state, 'visible')
})

test('power and display events before window creation leave the initial renderer reachable', () => {
  const f = fixture()
  f.context.mainWindow = null
  f.event()
  f.powerMonitor.emit('suspend')
  f.powerMonitor.emit('resume')
  assert.equal(f.generation(), 0)
  f.context.mainWindow = f.nativeWindow
  f.invoke('set-overlay-shape', [{ x: 10, y: 10, width: 50, height: 50 }], 0)
  f.invoke('set-ignore-mouse', false, 0)
  assert.deepEqual(f.last('shape'), ['shape', [{ x: 10, y: 10, width: 50, height: 50 }]])
  assert.deepEqual(f.last('mouse'), ['mouse', false])
  f.event()
  f.finish()
})

test('a resume without an observed suspend still refreshes geometry and fences old requests', () => {
  const f = fixture()
  f.powerMonitor.emit('resume')
  assert.equal(f.generation(), 1)
  assert.ok(f.last('work-area-changed'))
  assert.equal(f.invoke('show-window', 0), false)
  assert.equal(f.invoke('show-window', 1), false)
  f.finish()
})
