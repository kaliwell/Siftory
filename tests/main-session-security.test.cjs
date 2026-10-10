const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const { loadTsModule } = require('./guard-utils.cjs')

const { MAIN_SESSION_ALLOWED_PERMISSIONS, hardenMainSession, isMainSessionPermissionAllowed } =
  loadTsModule('electron/sessionSecurity.ts')

// ipcAuthorization imports ipcMain from electron at module scope; stub it so
// the pure trust factory can be unit-tested without a runtime.
const electronModulePath = require.resolve('electron')
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: { ipcMain: { handle() {}, on() {} } },
}
const { createRendererFrameUrlTrust } = loadTsModule('electron/ipcAuthorization.ts')

const root = path.resolve(__dirname, '..')

function parseCsp(html) {
  const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)
  assert.ok(match, 'index.html must carry a CSP meta tag')
  const directives = new Map()
  for (const part of match[1].split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length > 0) directives.set(tokens[0], tokens.slice(1))
  }
  return directives
}

test('main session allows no web permissions by default', () => {
  assert.ok(Object.isFrozen(MAIN_SESSION_ALLOWED_PERMISSIONS))
  assert.equal(MAIN_SESSION_ALLOWED_PERMISSIONS.length, 0)
  for (const permission of [
    'media',
    'mediaKeySystem',
    'notifications',
    'clipboard-read',
    'clipboard-sanitized-write',
    'geolocation',
    'fullscreen',
    'pointerLock',
    'serial',
    'midi',
    'usb',
    'hid',
    'idle-detection',
    'window-management',
  ]) {
    assert.equal(isMainSessionPermissionAllowed(permission), false, permission)
  }
})

test('hardenMainSession installs deny-by-default request and check handlers', () => {
  const handlers = {}
  const fakeSession = {
    setPermissionRequestHandler(handler) {
      handlers.request = handler
    },
    setPermissionCheckHandler(handler) {
      handlers.check = handler
    },
  }
  hardenMainSession(fakeSession)
  assert.equal(typeof handlers.request, 'function')
  assert.equal(typeof handlers.check, 'function')
  let granted = null
  handlers.request({}, 'notifications', (value) => {
    granted = value
  })
  assert.equal(granted, false)
  assert.equal(handlers.check({}, 'media'), false)
  assert.equal(handlers.check({}, 'clipboard-read'), false)
})

test('renderer CSP forbids plugins, framing, forms, and non-self code', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  const csp = parseCsp(html)
  assert.deepEqual(csp.get('default-src'), ["'self'"])
  assert.deepEqual(csp.get('script-src'), ["'self'"])
  assert.deepEqual(csp.get('object-src'), ["'none'"])
  assert.deepEqual(csp.get('base-uri'), ["'none'"])
  assert.deepEqual(csp.get('form-action'), ["'none'"])
  assert.deepEqual(csp.get('frame-src'), ["'none'"])
  assert.deepEqual(csp.get('child-src'), ["'none'"])
  assert.deepEqual(csp.get('worker-src'), ["'self'"])
  for (const [directive, tokens] of csp) {
    assert.ok(!tokens.includes("'unsafe-eval'"), `${directive} must not allow unsafe-eval`)
  }
  // connect-src may only reach the app itself and dev HMR websockets — no
  // arbitrary http(s) exfiltration channel.
  assert.deepEqual(csp.get('connect-src'), ["'self'", 'ws:'])
  assert.ok(!csp.get('script-src').includes("'unsafe-inline'"))
})

test('packaged renderer trust accepts only file URLs inside the app directory', () => {
  const appPath = path.resolve(root, 'fixture-app')
  const trust = createRendererFrameUrlTrust({ appPath, devServerUrl: null })
  const inside = path.join(appPath, 'dist', 'index.html')
  const nested = path.join(appPath, 'dist', 'assets', 'page.html')
  assert.equal(trust(pathToFileURL(inside).href), true)
  assert.equal(trust(pathToFileURL(nested).href), true)
  const outside = process.platform === 'win32' ? 'C:\\evil\\index.html' : '/etc/evil.html'
  assert.equal(trust(pathToFileURL(outside).href), false)
  const sibling = path.join(path.dirname(appPath), `${path.basename(appPath)}-evil`, 'index.html')
  assert.equal(trust(pathToFileURL(sibling).href), false)
  // No dev server configured: no loopback http origin is trusted at all.
  assert.equal(trust('http://localhost:5173/'), false)
  assert.equal(trust('http://127.0.0.1:32145/'), false)
  assert.equal(trust('https://example.com/'), false)
  assert.equal(trust('not a url'), false)
})

test('development renderer trust pins the exact dev-server origin', () => {
  const appPath = path.resolve(root, 'fixture-app')
  const trust = createRendererFrameUrlTrust({ appPath, devServerUrl: 'http://localhost:5173' })
  assert.equal(trust('http://localhost:5173/'), true)
  assert.equal(trust('http://localhost:5173/src/main.tsx'), true)
  // Any other loopback port or hostname spelling is rejected.
  assert.equal(trust('http://localhost:5174/'), false)
  assert.equal(trust('http://127.0.0.1:5173/'), false)
  assert.equal(trust('http://[::1]:5173/'), false)
  assert.equal(trust('https://localhost:5173/'), false)
  // file: stays confined to the app directory even in development.
  assert.equal(trust(pathToFileURL(path.join(appPath, 'dist', 'index.html')).href), true)
  const outside = process.platform === 'win32' ? 'C:\\evil\\index.html' : '/etc/evil.html'
  assert.equal(trust(pathToFileURL(outside).href), false)
  assert.equal(trust('not a url'), false)
})

test('main process wires session hardening before window creation and strict IPC trust', () => {
  const source = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8')
  assert.match(source, /hardenMainSession,[\s\S]*from '\.\/startupSecurity'/)
  assert.match(source, /hardenMainSession\(session\.defaultSession\)/)
  const hardenIndex = source.indexOf('hardenMainSession(session.defaultSession)')
  assert.ok(hardenIndex > 0)
  assert.ok(
    source.indexOf('createWindow()', hardenIndex) > hardenIndex,
    'hardenMainSession must run before createWindow()',
  )
  assert.match(
    source,
    /authorizeIpcWebContents\(\s*mainWindow\.webContents,\s*createRendererFrameUrlTrust\(\{ appPath: app\.getAppPath\(\), devServerUrl \}\),?\s*\)/,
  )
})
