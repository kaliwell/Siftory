const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const ts = require('typescript')
const { loadTsModule } = require('./guard-utils.cjs')

const root = path.resolve(__dirname, '..')
const plain = (value) => JSON.parse(JSON.stringify(value))
const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText

function fixture() {
  const calls = [],
    diagnostics = [],
    handlers = new Map(),
    timers = new Set()
  const timeout = (fn, ms) => {
    const timer = { fn, ms, unref() {} }
    timers.add(timer)
    return timer
  }
  let destroyed = false
  const nativeWindow = {
    isDestroyed: () => destroyed,
    isVisible: () => true,
    getOpacity: () => 1,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    getContentBounds() {
      return this.bounds
    },
    getBounds() {
      return this.bounds
    },
    setBounds(bounds) {
      this.bounds = plain(bounds)
      calls.push(['bounds', this.bounds])
    },
    setOpacity: (value) => calls.push(['opacity', value]),
    setIgnoreMouseEvents: (value) => calls.push(['mouse', value]),
    setShape: (value) => calls.push(['shape', plain(value)]),
    showInactive: () => calls.push(['showInactive']),
    webContents: {
      setBackgroundThrottling: (value) => calls.push(['throttle', value]),
      send: (key, value) => calls.push([key, plain(value)]),
    },
  }
  const electron = {
    app: { quit() {} },
    globalShortcut: { isRegistered: () => false, register: () => true, unregister() {} },
  }
  const mod = { exports: {} }
  const localRequire = (id) => {
    if (id === 'electron') return electron
    if (id === './ipcAuthorization')
      return { secureIpcMain: { handle: (key, handler) => handlers.set(key, handler) } }
    if (id === './windowVisibilityDiagnostics')
      return {
        WindowVisibilityDiagnostics: class {
          record(code, snapshot, details) {
            diagnostics.push({ code, ...snapshot, details })
          }
          async close() {}
        },
      }
    if (id.startsWith('./')) return loadTsModule(`electron/${id.slice(2)}.ts`)
    return require(id)
  }
  const filename = path.join(root, 'electron/appCoreIpc.ts')
  vm.runInNewContext(
    compile(fs.readFileSync(filename, 'utf8')),
    {
      module: mod,
      exports: mod.exports,
      require: localRequire,
      setTimeout: timeout,
      clearTimeout: (timer) => timers.delete(timer),
      console: { ...console, warn() {} },
    },
    { filename },
  )
  const core = mod.exports
  let displays = [
    {
      id: 1,
      bounds: nativeWindow.bounds,
      workArea: nativeWindow.bounds,
      scaleFactor: 1,
      rotation: 0,
    },
  ]
  const screen = new EventEmitter()
  screen.getAllDisplays = () => displays
  screen.getPrimaryDisplay = () => displays[0]
  const powerMonitor = new EventEmitter()
  const topology = loadTsModule('electron/workspaceDisplay.ts')
  const context = vm.createContext({
    uiSmokeMode: true,
    workspaceTopology: topology.buildWorkspaceTopology(displays, 1, { mode: 'all' }),
    displayScope: { mode: 'all' },
    workArea: nativeWindow.bounds,
    mainWindow: nativeWindow,
    appCoreOptions: null,
    screen,
    powerMonitor,
    buildWorkspaceTopology: topology.buildWorkspaceTopology,
    normalizeDisplayScope: topology.normalizeDisplayScope,
    recoverGlobalWindowTopology: core.recoverGlobalWindowTopology,
    suspendGlobalWindowVisibility: core.suspendGlobalWindowVisibility,
    resumeGlobalWindowVisibility: core.resumeGlobalWindowVisibility,
    disposeVectorAnnWorker: () => calls.push(['dispose-ann']),
    disposeSemanticVectorSearchWorker: () => calls.push(['dispose-semantic']),
    scheduleAuthoritativeAnnPrewarm() {},
    setUnifiedResourcePowerState() {},
    setTimeout: timeout,
    app: { getPath: () => '/inert-profile' },
    path,
  })
  const mainFile = path.join(root, 'electron/main.ts')
  const ast = ts.createSourceFile(
    mainFile,
    fs.readFileSync(mainFile, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const snippets = []
  for (const node of ast.statements) {
    if (
      ts.isFunctionDeclaration(node) &&
      [
        'readWorkspaceTopology',
        'installWorkspaceTopology',
        'applyWorkspaceTopology',
        'setDisplayScope',
        'clientWorkArea',
      ].includes(node.name?.text)
    )
      snippets.push(node.getText(ast))
  }
  function collect(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'on' &&
      ['screen', 'powerMonitor'].includes(node.expression.expression.getText(ast))
    )
      snippets.push(node.getText(ast))
    ts.forEachChild(node, collect)
  }
  collect(ast)
  // Execute production event wiring, not a reproduction of the intended wiring.
  assert.equal(snippets.length, 12)
  vm.runInContext(compile(snippets.join('\n;\n')), context)
  context.applyWorkspaceTopology(false)
  const options = {
    userDataPath: '/inert-profile',
    getMainWindow: () => context.mainWindow,
    getWorkArea: () => context.workArea,
    getDisplayTopology: () => context.workspaceTopology,
    setDisplayScope: (value) => context.setDisplayScope(value),
    ensureWindowOnTop() {},
    videoDiagnosticMode: 'baseline',
  }
  context.appCoreOptions = options
  core.registerAppCoreIpc(options)
  const invoke = (key, ...args) => handlers.get(key)({}, ...args)
  const event = (name = 'display-metrics-changed', width = 600, scaleFactor = 1) => {
    const bounds = { x: 0, y: 0, width, height: 600 }
    displays = [{ ...displays[0], bounds, workArea: bounds, scaleFactor }]
    // Overlay diagnostics use an explicit topology instead of the desktop
    // window's automatic display selection. Supply its next test topology.
    context.workspaceTopology = topology.buildWorkspaceTopology(displays, 1, {
      mode: 'all',
    })
    screen.emit(name, {}, displays[0], ['bounds', 'scaleFactor'])
  }
  const last = (kind) => calls.filter(([key]) => key === kind).at(-1)
  const generation = () =>
    diagnostics.filter((row) => row.code === 'transition').at(-1)?.generation ?? 0
  const finish = (gen = generation()) => {
    invoke('set-overlay-shape', [{ x: 40, y: 50, width: 120, height: 90 }], gen)
    assert.equal(invoke('show-window', gen), true)
    assert.equal(invoke('reveal-window', gen), true)
  }
  return {
    core,
    options,
    calls,
    diagnostics,
    timers,
    nativeWindow,
    context,
    powerMonitor,
    invoke,
    event,
    last,
    generation,
    finish,
    destroy: () => {
      destroyed = true
    },
  }
}

module.exports = { fixture }
