const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const ts = require('typescript')
const { loadTsModule } = require('./guard-utils.cjs')

function fixture(t, shortcutOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-window-runtime-'))
  const handlers = new Map()
  const calls = []
  const callbacks = new Map()
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => true,
    getOpacity: () => 1,
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    setOpacity: (opacity) => calls.push(['opacity', opacity]),
    setShape: (rects) => calls.push(['shape', rects]),
    setIgnoreMouseEvents: (ignore) => calls.push(['mouse', ignore]),
    webContents: {
      id: 1,
      setBackgroundThrottling: () => {},
      send: (channel, data) => calls.push([channel, data]),
    },
  })
  const trays = []
  const app = Object.assign(new EventEmitter(), {
    getLocale: () => 'en',
    quit: () => {
      app.emit('before-quit')
      calls.push(['quit'])
    },
  })
  const electron = {
    app,
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    Menu: { buildFromTemplate: (items) => items },
    Tray: class extends EventEmitter {
      constructor() {
        super()
        trays.push(this)
      }
      setToolTip() {}
      setContextMenu(items) {
        this.menu = items
      }
      destroy() {
        this.destroyed = true
      }
    },
    globalShortcut: {
      isRegistered: (key) => callbacks.has(key),
      register: (key, callback) => {
        callbacks.set(key, callback)
        return true
      },
      unregister: (key) => callbacks.delete(key),
      ...shortcutOverrides,
    },
  }
  const loadRuntime = (name, overrides = {}) => {
    const filename = path.resolve(__dirname, '../electron', name + '.ts')
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText
    const mod = new Module(filename, module)
    mod.filename = filename
    mod.paths = Module._nodeModulePaths(path.dirname(filename))
    mod.require = (id) => {
      if (Object.hasOwn(overrides, id)) return overrides[id]
      if (id === 'electron') return electron
      if (id === '../shared/globalHotkey') return loadTsModule('shared/globalHotkey.ts')
      if (id === './ipcAuthorization')
        return { secureIpcMain: { handle: (key, fn) => handlers.set(key, fn) } }
      if (id.startsWith('./')) return loadTsModule(`electron/${id.slice(2)}.ts`)
      return require(id)
    }
    mod._compile(compiled, filename)
    return mod.exports
  }
  const core = loadRuntime('appCoreIpc')
  const options = {
    userDataPath: dir,
    getMainWindow: () => window,
    getWorkArea: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    ensureWindowOnTop: () => {},
    videoDiagnosticMode: 'baseline',
  }
  core.registerAppCoreIpc(options)
  t.after(async () => {
    core.setGlobalWindowVisibility(options, false, 'recovery')
    await core.flushWindowVisibilityDiagnostics()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const invoke = (key, ...args) => handlers.get(key)({ sender: { id: 1 } }, ...args)
  const snapshot = async () => {
    await core.flushWindowVisibilityDiagnostics()
    return JSON.parse(fs.readFileSync(path.join(dir, 'diagnostics/window-visibility.json'), 'utf8'))
  }
  const attachCloseBehavior = () =>
    loadRuntime('workspaceCloseBehavior', {
      './appCoreIpc': core,
      './startupSecurity': { PRODUCT_DISPLAY_NAME: 'Siftory' },
    }).attachWorkspaceCloseBehavior(window, options, 'icon.ico')
  return {
    core,
    options,
    calls,
    callbacks,
    invoke,
    snapshot,
    window,
    trays,
    app,
    attachCloseBehavior,
  }
}

test('custom visibility shortcut preserves the old binding on internal and external conflicts', (t) => {
  const { core, options, callbacks, invoke } = fixture(t)
  core.registerGlobalHotkeys(options)
  const original = 'CommandOrControl+Shift+Alt+Q'
  assert.ok(callbacks.has(original))
  assert.equal(callbacks.has('CommandOrControl+Shift+Alt+R'), false)
  assert.equal(invoke('register-hotkey', 'Shift+Escape').error, 'Shortcut conflicts')
  callbacks.set('CommandOrControl+F8', () => {})
  assert.equal(invoke('register-hotkey', 'Ctrl+F8').error, 'Shortcut conflicts')
  assert.ok(callbacks.has(original))
  const changed = invoke('register-hotkey', 'Alt+Ctrl+F9')
  assert.equal(changed.error, undefined)
  assert.ok(callbacks.has('CommandOrControl+Alt+F9'))
  assert.equal(callbacks.has(original), false)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(options.userDataPath, 'global_hotkeys.json'), 'utf8'))
      .visibility,
    'CommandOrControl+Alt+F9',
  )
})

test('failed persistence rolls back the candidate and startup restores a saved shortcut', (t) => {
  const { core, options, callbacks, invoke } = fixture(t)
  fs.writeFileSync(
    path.join(options.userDataPath, 'global_hotkeys.json'),
    JSON.stringify({ visibility: 'Ctrl+F10' }),
  )
  core.registerGlobalHotkeys(options)
  assert.ok(callbacks.has('CommandOrControl+F10'))
  fs.unlinkSync(path.join(options.userDataPath, 'global_hotkeys.json'))
  fs.mkdirSync(path.join(options.userDataPath, 'global_hotkeys.json'))
  assert.equal(invoke('register-hotkey', 'Ctrl+F11').error, 'Could not save shortcut')
  assert.ok(callbacks.has('CommandOrControl+F10'))
  assert.equal(callbacks.has('CommandOrControl+F11'), false)
})

test('startup rejects saved reserved keys and leaves the quit shortcut disabled by default', (t) => {
  const { core, options, callbacks } = fixture(t)
  fs.writeFileSync(
    path.join(options.userDataPath, 'global_hotkeys.json'),
    JSON.stringify({ visibility: 'Shift+Escape' }),
  )
  const status = core.registerGlobalHotkeys(options)
  assert.ok(status.error)
  assert.equal(status.entries[0].accelerator, 'CommandOrControl+Shift+Alt+Q')
  assert.equal(status.quitShortcutEnabled, false)
  assert.equal(status.closeToTray, false)
  assert.equal(callbacks.has('Shift+Escape'), false)
})

test('explicit desktop preferences survive restart and the quit shortcut can be disabled', (t) => {
  const { core, options, callbacks, invoke } = fixture(t)
  fs.writeFileSync(
    path.join(options.userDataPath, 'global_hotkeys.json'),
    JSON.stringify({ visibility: 'Ctrl+F10', quitShortcutEnabled: true, closeToTray: true }),
  )
  const status = core.registerGlobalHotkeys(options)
  assert.equal(status.closeToTray, true)
  assert.equal(status.quitShortcutEnabled, true)
  assert.equal(callbacks.has('Shift+Escape'), true)
  invoke('unregister-hotkey')
  assert.equal(callbacks.has('Shift+Escape'), true)
  assert.equal(
    invoke('set-desktop-behavior', 'quitShortcutEnabled', false).quitShortcutEnabled,
    false,
  )
  assert.equal(callbacks.has('Shift+Escape'), false)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(options.userDataPath, 'global_hotkeys.json'), 'utf8')),
    { visibility: 'CommandOrControl+F10', quitShortcutEnabled: false, closeToTray: true },
  )
})

test('closing the workspace exits by default even if additional windows are open', async (t) => {
  const { attachCloseBehavior, window, calls, trays } = fixture(t)
  attachCloseBehavior()
  const event = { preventDefault: t.mock.fn() }
  window.emit('close', event)
  assert.equal(event.preventDefault.mock.callCount(), 1)
  await new Promise(setImmediate)
  assert.equal(trays.length, 0)
  assert.ok(calls.some(([name]) => name === 'quit'))
  const appClosing = { preventDefault: t.mock.fn() }
  window.emit('close', appClosing)
  assert.equal(appClosing.preventDefault.mock.callCount(), 0)
})

test('opt-in close hides the workspace, tray click restores it, and tray quit exits', (t) => {
  const { attachCloseBehavior, options, window, calls, trays, invoke } = fixture(t)
  options.standardWindow = true
  let visible = true
  window.isVisible = () => visible
  window.isMinimized = () => false
  window.hide = () => {
    visible = false
  }
  window.show = () => {
    visible = true
    window.emit('show')
  }
  window.focus = () => {}
  attachCloseBehavior()
  assert.equal(invoke('set-desktop-behavior', 'closeToTray', true).closeToTray, true)
  const event = { preventDefault: t.mock.fn() }
  window.emit('close', event)
  assert.equal(visible, false)
  assert.equal(
    calls.some(([name]) => name === 'quit'),
    false,
  )
  trays[0].emit('click')
  assert.equal(visible, true)
  assert.equal(trays[0].destroyed, true)
  window.emit('close', event)
  trays[1].menu.find((entry) => entry.label === 'Quit').click()
  assert.equal(trays[1].destroyed, true)
  assert.ok(calls.some(([name]) => name === 'quit'))
})

test('recording suppresses native visibility and quit actions without releasing their registrations', (t) => {
  const { core, options, callbacks, calls, invoke, window } = fixture(t)
  core.registerGlobalHotkeys(options)
  assert.equal(
    invoke('set-desktop-behavior', 'quitShortcutEnabled', true).quitShortcutEnabled,
    true,
  )
  assert.equal(invoke('set-hotkey-recording', true), true)
  callbacks.get('CommandOrControl+Shift+Alt+Q')()
  callbacks.get('Shift+Escape')()
  assert.deepEqual(
    calls.filter(([event]) => event === 'hotkey-recorded').map(([, key]) => key),
    ['CommandOrControl+Shift+Alt+Q', 'Shift+Escape'],
  )
  assert.equal(
    calls.some(([event]) => event === 'quit' || event === 'opacity'),
    false,
  )
  assert.equal(invoke('set-hotkey-recording', false), false)
  callbacks.get('Shift+Escape')()
  assert.ok(calls.some(([event]) => event === 'quit'))
  assert.equal(invoke('set-hotkey-recording', true), true)
  window.isFocused = () => false
  callbacks.get('Shift+Escape')()
  assert.equal(calls.filter(([event]) => event === 'quit').length, 2)
})

test('recording lease expires if renderer cleanup never arrives', (t) => {
  const { core, options, callbacks, calls, invoke } = fixture(t)
  core.registerGlobalHotkeys(options)
  invoke('set-desktop-behavior', 'quitShortcutEnabled', true)
  invoke('set-hotkey-recording', true)
  const future = Date.now() + 31000
  t.mock.method(Date, 'now', () => future)
  callbacks.get('Shift+Escape')()
  assert.ok(calls.some(([event]) => event === 'quit'))
})

test('standard windows hide and reveal natively without clipping or click-through', async (t) => {
  const { core, options, calls, invoke, window } = fixture(t)
  options.standardWindow = true
  let visible = true
  window.isVisible = () => visible
  window.isMinimized = () => false
  window.hide = () => {
    visible = false
    calls.push(['native-hide'])
  }
  window.show = () => {
    visible = true
    calls.push(['native-show'])
  }
  window.focus = () => calls.push(['native-focus'])
  invoke('set-overlay-shape', [{ x: 3, y: 4, width: 50, height: 50 }], 0)
  invoke('set-ignore-mouse', true, 0)
  invoke('set-transparency', 60)
  assert.equal(
    calls.some(([name, value]) => name === 'shape' || (name === 'mouse' && value === true)),
    false,
  )
  core.setGlobalWindowVisibility(options, false, 'settings')
  assert.equal(visible, false)
  assert.equal(invoke('show-window', 0), false)
  assert.equal(invoke('reveal-window', 0), false)
  assert.equal(visible, false, 'stale renderer ACKs must not reverse a native hide')
  core.revealGlobalWindow(options)
  assert.equal(invoke('show-window', 2), true)
  assert.equal(visible, true)
  assert.ok(calls.some(([name]) => name === 'native-focus'))
  assert.equal(
    calls.some(([name, value]) => name === 'opacity' && value !== 1),
    false,
  )
  core.setGlobalWindowVisibility(options, false, 'settings')
  let restoredGeometry = 0
  core.recoverGlobalWindowTopology(options, () => restoredGeometry++)
  core.resumeGlobalWindowVisibility(options, () => restoredGeometry++)
  assert.equal(restoredGeometry, 2)
  assert.equal(visible, false, 'display changes and resume must not reveal a hidden app')
})

test('shortcut conflicts and registration exceptions remain per-key and recover on retry', async (t) => {
  let failing = true
  const { core, options, snapshot } = fixture(t, {
    register: (key) => {
      if (failing && key === 'Shift+Alt+W') return false
      if (failing && key.endsWith('+Q')) throw new Error('private path must not enter diagnostics')
      return true
    },
  })
  const initial = core.registerGlobalHotkeys(options)
  assert.equal(initial.active, false)
  assert.equal(initial.entries.find((entry) => entry.id === 'toggle-primary').status, 'conflicted')
  assert.equal(initial.entries.find((entry) => entry.id === 'snap-panels').status, 'registered')
  failing = false
  assert.equal(core.registerGlobalHotkeys(options).active, true)
  const events = (await snapshot()).events
  assert.ok(events.some((event) => event.code === 'hotkey-conflicted'))
  assert.ok(events.some((event) => event.code === 'hotkey-failed'))
  assert.doesNotMatch(JSON.stringify(events), /private path/)
})

test('hide releases hit testing before opacity, rejects stale ACK, and commits once', async (t) => {
  const { core, options, calls, invoke, snapshot } = fixture(t)
  core.setGlobalWindowVisibility(options, false, 'hotkey')
  assert.deepEqual(calls.slice(0, 3), [
    ['mouse', true],
    ['shape', []],
    ['opacity', 0],
  ])
  core.setGlobalWindowVisibility(options, true, 'hotkey')
  assert.equal(invoke('show-window', 1), false)
  assert.equal(invoke('reveal-window', 1), false)
  invoke('set-overlay-shape', [{ x: 20, y: 20, width: 80, height: 40 }], 2)
  assert.equal(invoke('show-window', 2), true)
  assert.equal(invoke('reveal-window', 2), true)
  assert.equal(invoke('reveal-window', 2), true)
  invoke('set-ignore-mouse', false, 1)
  assert.deepEqual(calls.at(-1), ['mouse', true])
  const events = (await snapshot()).events
  assert.equal(events.filter((event) => event.code === 'visible').length, 1)
  assert.equal(events.filter((event) => event.code === 'stale-ack').length, 2)
})

test('timeout without a validated shape keeps opacity zero and accepts a late renderer recovery', async (t) => {
  const { core, options, calls, invoke, snapshot } = fixture(t)
  core.setGlobalWindowVisibility(options, false, 'settings')
  core.setGlobalWindowVisibility(options, true, 'settings')
  await new Promise((resolve) => setTimeout(resolve, 950))
  assert.ok(calls.filter(([kind]) => kind === 'shape').every(([, rects]) => rects.length === 0))
  assert.ok(calls.filter(([kind]) => kind === 'mouse').every(([, ignore]) => ignore))
  assert.equal(calls.filter(([kind]) => kind === 'opacity').at(-1)[1], 0)
  invoke('set-overlay-shape', [{ x: 0, y: 0, width: 20, height: 20 }], 2)
  assert.equal(invoke('show-window', 2), true)
  assert.equal(invoke('reveal-window', 2), true)
  assert.ok((await snapshot()).events.some((event) => event.code === 'fallback-without-shape'))
})

test('a native failure during timeout does not escape the timer callback', async (t) => {
  const { core, options, invoke, window, snapshot } = fixture(t)
  invoke('set-overlay-shape', [{ x: 0, y: 0, width: 20, height: 20 }], 0)
  core.setGlobalWindowVisibility(options, false, 'settings')
  core.setGlobalWindowVisibility(options, true, 'settings')
  window.setShape = () => {
    throw new Error('native failure')
  }
  await new Promise((resolve) => setTimeout(resolve, 950))
  window.setShape = () => {}
  assert.ok((await snapshot()).events.some((event) => event.code === 'shape-failed'))
})

test('native failures stay observable and a later mouse request can retry', async (t) => {
  const { invoke, window, snapshot } = fixture(t)
  window.setIgnoreMouseEvents = () => {
    throw new Error('C:\\private\\path')
  }
  assert.throws(() => invoke('set-ignore-mouse', false, 0))
  window.setIgnoreMouseEvents = () => {}
  invoke('set-ignore-mouse', true, 0)
  window.setShape = () => {
    throw new Error('private shape failure')
  }
  assert.throws(() => invoke('set-overlay-shape', [{ x: 0, y: 0, width: 20, height: 20 }], 0))
  window.setShape = () => {}
  const events = (await snapshot()).events
  assert.ok(events.some((event) => event.code === 'mouse-failed'))
  assert.ok(events.some((event) => event.code === 'shape-failed'))
  assert.equal(events.at(-2).code, 'mouse-applied')
  assert.doesNotMatch(JSON.stringify(events), /private/)
})
