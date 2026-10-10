const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')
const { createHash } = require('node:crypto')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

// Exercise the real authorization wrapper, controller, loader and receipt writer.
// Only Electron's window/IPC transport is replaced; no GUI or actual user data is used.
const handlers = new Map()
const windows = []
let nextId = 5000
let failNextLoad = false

function contents() {
  const result = new EventEmitter()
  result.id = nextId++
  result.mainFrame = { url: '' }
  result.setWindowOpenHandler = (handler) => {
    result.windowOpenHandler = handler
  }
  return result
}

class TestWindow extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.webContents = contents()
    this.destroyed = false
    this.shown = false
    windows.push(this)
  }
  isDestroyed() {
    return this.destroyed
  }
  show() {
    this.shown = true
  }
  focus() {
    this.focused = true
  }
  close() {
    this.destroy()
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.webContents.emit('destroyed')
    this.emit('closed')
  }
  loadURL(url) {
    this.webContents.mainFrame.url = url
    if (failNextLoad) {
      failNextLoad = false
      return Promise.reject(new Error('Deliberate fixture load failure'))
    }
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('ready-to-show')
    })
    return Promise.resolve()
  }
}

const originalLoad = Module._load
let EndUserTermsController
let authorizeIpcWebContents
let secureIpcMain
try {
  Module._load = function loadWithElectronStub(id, ...rest) {
    if (id === 'electron')
      return {
        BrowserWindow: TestWindow,
        ipcMain: {
          handle: (channel, listener) => handlers.set(channel, listener),
          on: (channel, listener) => handlers.set(channel, listener),
        },
      }
    return originalLoad.call(this, id, ...rest)
  }
  ;({ EndUserTermsController } = loadTsModule('electron/endUserTermsWindow.ts'))
  ;({ authorizeIpcWebContents, secureIpcMain } = loadTsModule('electron/ipcAuthorization.ts'))
} finally {
  Module._load = originalLoad
}

const turn = () => new Promise((resolve) => setImmediate(resolve))
const event = (sender, senderFrame = sender.mainFrame) => ({ sender, senderFrame })
const invoke = (channel, window, ...args) =>
  handlers.get(channel)(event(window.webContents), ...args)
const identity = (terms) => ({ version: terms.version, sha256: terms.sha256 })

function fixture(t, options = {}) {
  handlers.clear()
  windows.length = 0
  failNextLoad = false
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'siftory-terms-ipc-'))
  const resources = path.join(directory, 'resources')
  const legal = path.join(resources, 'legal', 'end-user-terms')
  const userData = path.join(directory, 'user-data')
  fs.mkdirSync(legal, { recursive: true })
  fs.mkdirSync(userData)
  const document = Buffer.from('Automated test agreement. This is not a distribution agreement.')
  fs.writeFileSync(path.join(legal, 'test.txt'), document)
  const manifest = {
    schemaVersion: 1,
    status: 'final',
    title: 'Test agreement',
    version: 'test-1',
    publisher: 'Automated test fixture',
    effectiveDate: '2026-09-25',
    documents: [{ path: 'test.txt', sha256: createHash('sha256').update(document).digest('hex') }],
  }
  const writeManifest = () =>
    fs.writeFileSync(path.join(legal, 'manifest.json'), JSON.stringify(manifest))
  writeManifest()
  const controllerOptions = {
    resourcesRoot: resources,
    userDataPath: userData,
    appPath: directory,
    language: 'en',
    ...options,
  }
  const controller = new EndUserTermsController(controllerOptions)
  controller.register()
  t.after(async () => {
    for (const window of windows) window.destroy()
    await turn()
    const resolved = fs.realpathSync(directory)
    assert.equal(path.dirname(resolved), temporaryRoot)
    assert.equal(resolved, directory)
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return {
    controller,
    controllerOptions,
    manifest,
    writeManifest,
    receipt: path.join(userData, 'end-user-terms-acceptance.json'),
    get window() {
      return windows.at(-1)
    },
  }
}

test('terms IPC authorization restricts channels, exact URL, main frame and window lifetime', (t) => {
  fixture(t)
  const sender = contents()
  const allowed = new Set(['terms:get'])
  const trusted = 'file:///fixture/terms.html'
  sender.mainFrame.url = trusted
  authorizeIpcWebContents(sender, (url) => url === trusted, allowed)
  allowed.add('open-folder')
  secureIpcMain.handle('terms:get', () => 'allowed')
  secureIpcMain.handle('open-folder', () => 'must not run')
  assert.equal(handlers.get('terms:get')(event(sender)), 'allowed')
  assert.throws(() => handlers.get('open-folder')(event(sender)), /unavailable to this window/)
  assert.throws(() => handlers.get('terms:get')(event(sender, { url: trusted })), /main frame/)
  assert.throws(() => handlers.get('terms:get')(event(sender, null)), /main frame/)
  for (const url of [
    'file:///fixture/index.html',
    `${trusted}?other`,
    'http://localhost/terms.html',
  ]) {
    sender.mainFrame.url = url
    assert.throws(() => handlers.get('terms:get')(event(sender)), /Untrusted IPC frame origin/)
  }
  sender.mainFrame.url = trusted
  const other = contents()
  other.mainFrame.url = trusted
  assert.throws(() => handlers.get('terms:get')(event(other)), /Unauthorized IPC sender/)
  sender.emit('destroyed')
  assert.throws(() => handlers.get('terms:get')(event(sender)), /Unauthorized IPC sender/)
})

test('first-use terms window is isolated, plaintext-only IPC cannot reach application handlers', async (t) => {
  const f = fixture(t)
  const pending = f.controller.ensureAccepted()
  const window = f.window
  assert.equal(fs.existsSync(f.receipt), false)
  const payload = invoke('terms:get', window)
  assert.equal(payload.mode, 'accept')
  assert.equal(payload.language, 'en')
  assert.equal(payload.terms.version, 'test-1')
  assert.deepEqual(window.options.webPreferences, {
    preload: path.join(f.controllerOptions.appPath, 'dist-electron', 'endUserTermsPreload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  })
  assert.deepEqual(window.webContents.windowOpenHandler({ url: 'https://example.invalid' }), {
    action: 'deny',
  })
  for (const name of ['will-navigate', 'will-redirect']) {
    let prevented = false
    window.webContents.emit(name, {
      preventDefault: () => {
        prevented = true
      },
    })
    assert.equal(prevented, true)
  }
  secureIpcMain.handle('open-folder', () => assert.fail('terms window reached application handler'))
  assert.throws(() => invoke('open-folder', window), /unavailable to this window/)
  assert.throws(() => invoke('app:viewEndUserTerms', window), /unavailable to this window/)
  window.close()
  assert.equal(await pending, false)
})

test('an otherwise authorized application window cannot read, accept or close the terms window', async (t) => {
  const f = fixture(t)
  const pending = f.controller.ensureAccepted()
  const termsWindow = f.window
  const payload = invoke('terms:get', termsWindow)
  const applicationWindow = new TestWindow({})
  applicationWindow.webContents.mainFrame.url = 'file:///fixture/index.html'
  authorizeIpcWebContents(applicationWindow.webContents)
  for (const [channel, args] of [
    ['terms:get', []],
    ['terms:accept', [identity(payload.terms)]],
    ['terms:close', []],
  ]) {
    assert.throws(() => invoke(channel, applicationWindow, ...args), /Unauthorized terms window/)
  }
  assert.equal(fs.existsSync(f.receipt), false)
  assert.equal(termsWindow.isDestroyed(), false)
  termsWindow.close()
  assert.equal(await pending, false)
})

test('decline and titlebar close never produce an acceptance receipt', async (t) => {
  const f = fixture(t)
  let pending = f.controller.ensureAccepted()
  invoke('terms:close', f.window)
  assert.equal(await pending, false)
  assert.equal(fs.existsSync(f.receipt), false)
  pending = f.controller.ensureAccepted()
  f.window.close()
  assert.equal(await pending, false)
  assert.equal(fs.existsSync(f.receipt), false)
})

test('load failure or a crashed renderer resolves the gate as declined', async (t) => {
  const f = fixture(t)
  failNextLoad = true
  assert.equal(await f.controller.ensureAccepted(), false)
  assert.equal(fs.existsSync(f.receipt), false)
  const pending = f.controller.ensureAccepted()
  f.window.webContents.emit('render-process-gone')
  assert.equal(await pending, false)
  assert.equal(fs.existsSync(f.receipt), false)
})

test('explicit matching acceptance persists before closing and a restarted controller skips that version', async (t) => {
  const f = fixture(t)
  const pending = f.controller.ensureAccepted()
  const window = f.window
  const { terms } = invoke('terms:get', window)
  assert.deepEqual(
    invoke('terms:accept', window, { version: terms.version, sha256: '0'.repeat(64) }),
    { ok: false, reason: 'invalid-request' },
  )
  assert.equal(fs.existsSync(f.receipt), false)
  assert.equal(window.isDestroyed(), false)
  assert.deepEqual(invoke('terms:accept', window, identity(terms)), { ok: true })
  const receipt = JSON.parse(fs.readFileSync(f.receipt, 'utf8'))
  assert.equal(receipt.sha256, terms.sha256)
  assert.equal(receipt.version, terms.version)
  assert.equal(window.isDestroyed(), false, 'the IPC response precedes scheduled closure')
  assert.deepEqual(invoke('terms:accept', window, identity(terms)), {
    ok: false,
    reason: 'invalid-request',
  })
  assert.equal(await pending, true)
  const count = windows.length
  const restarted = new EndUserTermsController(f.controllerOptions)
  assert.equal(await restarted.ensureAccepted(), true)
  assert.equal(windows.length, count)
})

test('read-only viewing has a close action but cannot record or replace acceptance', async (t) => {
  const f = fixture(t)
  assert.deepEqual(f.controller.view(), { ok: true })
  const window = f.window
  const payload = invoke('terms:get', window)
  assert.equal(payload.mode, 'view')
  assert.deepEqual(invoke('terms:accept', window, identity(payload.terms)), {
    ok: false,
    reason: 'invalid-request',
  })
  assert.equal(fs.existsSync(f.receipt), false)
  assert.deepEqual(f.controller.view(), { ok: true })
  assert.equal(windows.length, 1)
  assert.equal(window.focused, true)
  invoke('terms:close', window)
  await turn()
  assert.equal(window.isDestroyed(), true)
  assert.equal(fs.existsSync(f.receipt), false)
})

test('a changed manifest while open rejects the stale acceptance and keeps the window open', async (t) => {
  const f = fixture(t)
  const pending = f.controller.ensureAccepted()
  const window = f.window
  const { terms } = invoke('terms:get', window)
  f.manifest.publisher = 'Updated automated test fixture'
  f.writeManifest()
  assert.deepEqual(invoke('terms:accept', window, identity(terms)), {
    ok: false,
    reason: 'stale-terms',
  })
  assert.equal(window.isDestroyed(), false)
  assert.equal(fs.existsSync(f.receipt), false)
  window.close()
  assert.equal(await pending, false)
})

test('receipt write failure keeps the gate closed and does not turn later closure into acceptance', async (t) => {
  const f = fixture(t)
  const pending = f.controller.ensureAccepted()
  const window = f.window
  const { terms } = invoke('terms:get', window)
  fs.mkdirSync(f.receipt)
  assert.deepEqual(invoke('terms:accept', window, identity(terms)), {
    ok: false,
    reason: 'save-failed',
  })
  assert.equal(window.isDestroyed(), false)
  assert.equal(fs.statSync(f.receipt).isDirectory(), true)
  invoke('terms:close', window)
  assert.equal(await pending, false)
})

test('review has no active agreement; invalid final material fails closed without creating a window', async (t) => {
  const f = fixture(t)
  f.manifest.status = 'review'
  f.writeManifest()
  assert.equal(await f.controller.ensureAccepted(), true)
  assert.deepEqual(f.controller.view(), { ok: false, reason: 'not-published' })
  assert.equal(windows.length, 0)
  assert.equal(fs.existsSync(f.receipt), false)
  f.manifest.status = 'final'
  f.manifest.documents[0].sha256 = '0'.repeat(64)
  f.writeManifest()
  await assert.rejects(f.controller.ensureAccepted())
  assert.deepEqual(f.controller.view(), { ok: false, reason: 'unavailable' })
  assert.equal(windows.length, 0)
  assert.equal(fs.existsSync(f.receipt), false)
})

test('development terms window trusts only the terms document on its configured server', async (t) => {
  const f = fixture(t, { devServerUrl: 'http://localhost:5173/', language: 'zh-CN' })
  const pending = f.controller.ensureAccepted()
  const window = f.window
  assert.equal(window.webContents.mainFrame.url, 'http://localhost:5173/terms.html')
  assert.equal(invoke('terms:get', window).language, 'zh-CN')
  for (const url of [
    'http://localhost:5173/',
    'http://localhost:5174/terms.html',
    'http://localhost:5173/terms.html#changed',
  ]) {
    window.webContents.mainFrame.url = url
    assert.throws(() => invoke('terms:get', window), /Untrusted IPC frame origin/)
  }
  window.close()
  assert.equal(await pending, false)
})

test('startup enforces the terms decision before initializing services or the main renderer', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.ts'), 'utf8')
  const start = source.indexOf('void app.whenReady().then')
  assert.notEqual(start, -1)
  const ready = source.slice(start)
  const hardenedAt = ready.indexOf('hardenMainSession(session.defaultSession)')
  const acceptedAt = ready.indexOf('await termsController.ensureAccepted()')
  const initializedAt = ready.indexOf('initMediaToolConfig()')
  const rendererAt = ready.indexOf('createWindow()')
  assert.ok(hardenedAt >= 0 && acceptedAt > hardenedAt)
  assert.ok(initializedAt > acceptedAt && rendererAt > initializedAt)
  const gate = ready.slice(acceptedAt, initializedAt)
  assert.match(gate, /app\.quit\(\)\s*return/)
  assert.match(gate, /catch\s*\{[\s\S]*dialog\.showErrorBox\([\s\S]*app\.quit\(\)\s*return/)
  assert.match(gate, /applicationServicesStarted = true/)
  assert.match(source, /let applicationStarting = true/)
  assert.match(source, /let applicationServicesStarted = false/)
  assert.match(ready, /createWindow\(\)\s*applicationStarting = false/)
  assert.match(
    source,
    /app\.on\('window-all-closed',[\s\S]*?if \(!applicationStarting && process\.platform !== 'darwin'\) app\.quit\(\)/,
  )
  assert.match(
    source,
    /app\.on\('will-quit', \(event\) => \{\s*if \(!applicationServicesStarted\) return/,
  )
})

test('development terms CSP nonces match actual Vite refresh and style injection without starting Electron', async (t) => {
  const root = path.resolve(__dirname, '..')
  const { termsDevelopmentCsp } = await import(
    pathToFileURL(path.join(root, 'vite.config.mjs')).href
  )
  const { createServer, resolveConfig } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const html = fs.readFileSync(path.join(root, 'terms.html'), 'utf8')
  const plugin = termsDevelopmentCsp()
  const nonce = plugin.config().html.cspNonce
  assert.match(nonce, /^[A-Za-z0-9+/]{43}=$/)
  assert.notEqual(termsDevelopmentCsp().config().html.cspNonce, nonce)
  assert.equal(plugin.apply, 'serve')
  assert.equal(
    plugin.transformIndexHtml.handler(html, { filename: path.join(root, 'index.html') }),
    undefined,
  )

  // Select ONLY React and the CSP plugin. configFile:false prevents loading the
  // project's Electron startup plugin; middleware mode never listens on a port.
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const cacheDir = fs.mkdtempSync(path.join(temporaryRoot, 'siftory-terms-vite-test-'))
  const hmrServer = require('node:http').createServer()
  const server = await createServer({
    root,
    configFile: false,
    envFile: false,
    cacheDir,
    logLevel: 'silent',
    plugins: [plugin, react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      middlewareMode: true,
      hmr: { server: hmrServer },
      watch: null,
      preTransformRequests: false,
    },
  })
  t.after(async () => {
    await server.close()
    const resolved = fs.realpathSync(cacheDir)
    assert.equal(path.dirname(resolved), temporaryRoot)
    assert.equal(resolved, cacheDir)
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  const transformed = await server.transformIndexHtml('/terms.html', html)
  assert.equal(hmrServer.listening, false)
  assert.equal(server.httpServer, null)
  assert.ok(transformed.includes(`script-src 'self' 'nonce-${nonce}';`))
  assert.ok(transformed.includes(`style-src 'self' 'nonce-${nonce}';`))
  assert.ok(transformed.includes(`property="csp-nonce" nonce="${nonce}"`))
  const scripts = transformed.match(/<script\b[^>]*>[\s\S]*?<\/script>/g)
  assert.ok(
    scripts?.some((script) => script.includes('injectIntoGlobalHook')),
    'actual React refresh preamble is present',
  )
  for (const script of scripts) assert.ok(script.includes(`nonce="${nonce}"`))
  const css = await server.transformRequest('/src/components/EndUserTermsDialog.css')
  assert.match(css.code, /updateStyle/)
  const client = await server.transformRequest('/@vite/client')
  assert.match(client.code, /querySelector\("meta\[property=csp-nonce\]"\)\?\.nonce/)
  assert.match(client.code, /style\.setAttribute\("nonce", cspNonce\)/)
  assert.doesNotMatch(transformed, /unsafe-inline|unsafe-eval/)

  const production = await resolveConfig(
    {
      root,
      configFile: false,
      envFile: false,
      cacheDir,
      logLevel: 'silent',
      plugins: [termsDevelopmentCsp()],
    },
    'build',
  )
  assert.equal(production.html?.cspNonce, undefined)
  assert.equal(
    production.plugins.some((item) => item.name === plugin.name),
    false,
  )
  assert.match(html, /script-src 'self'; style-src 'self';/)
  assert.doesNotMatch(html, /nonce-|unsafe-inline|unsafe-eval/)
})
