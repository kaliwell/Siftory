const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const pathGuards = loadTsModule('electron/pathGuards.ts')
const imageSearchGuards = loadTsModule('electron/imageSearchGuards.ts')
const devServerGuard = loadTsModule('electron/devServerGuard.ts')
const environmentGuards = loadTsModule('electron/environmentGuards.ts')

test('path guards normalize and deduplicate file-operation paths', () => {
  const input = ['  C:\\tmp\\a  ', '', null, 'C:\\tmp\\a', 'C:\\tmp\\b\\..\\c']
  assert.deepEqual(pathGuards.normalizePathList(input), [
    path.normalize('C:\\tmp\\a'),
    path.normalize('C:\\tmp\\c'),
  ])
})

test('path guards limit paged directory listing requests', () => {
  const normalized = pathGuards.normalizeDirListRequest({
    dirPath: ' C:\\tmp ',
    sort: { field: 'ctime', direction: 'sideways' },
    offset: -20,
    limit: 50000,
  })

  assert.equal(normalized.ok, true)
  assert.equal(normalized.req.sort.field, 'name')
  assert.equal(normalized.req.sort.direction, 'asc')
  assert.equal(normalized.req.offset, 0)
  assert.equal(normalized.req.limit, 500)
})

test('path guards detect nested destinations', () => {
  assert.equal(pathGuards.isSameOrNestedPath('C:\\tmp\\root', 'C:\\tmp\\root'), true)
  assert.equal(pathGuards.isSameOrNestedPath('C:\\tmp\\root', 'C:\\tmp\\root\\child'), true)
  assert.equal(pathGuards.isSameOrNestedPath('C:\\tmp\\root', 'C:\\tmp\\other'), false)
})

test('path guards reject control chars and oversized paths', () => {
  assert.equal(pathGuards.normalizeUserPath('C:\\tmp\x1finjected'), null)
  assert.equal(pathGuards.normalizeUserPath('C:\\tmp\0x'), null)
  assert.equal(pathGuards.normalizeUserPath(`C:\\${'a'.repeat(5000)}`), null)
  assert.equal(imageSearchGuards.normalizeFsPath('D:\\scan\x1fD:\\injected'), null)
  assert.equal(imageSearchGuards.normalizeScanPaths(['D:\\ok\x1fD:\\evil', 'D:\\valid']).length, 1)
})

test('openSafeShellPath rejects UNC execution but reveal permits it', async () => {
  const calls = []
  const fakeShell = {
    openPath: async (p) => {
      calls.push(p)
      return ''
    },
    showItemInFolder: (p) => calls.push(p),
  }
  const unc = '\\\\host\\share\\tool.exe'
  const opened = await pathGuards.openSafeShellPath(fakeShell, unc)
  assert.equal(opened.ok, false)
  assert.match(opened.error, /UNC/)
  assert.equal(calls.length, 0)
  // revealSafeShellPath does not execute; UNC remains allowed for browsing.
  assert.equal(pathGuards.safeShellPath(unc) !== null, true)
})

test('image search guards normalize scan/search params', () => {
  const manyPaths = Array.from({ length: 80 }, (_, i) => `C:\\images\\${i}`)
  const normalizedPaths = imageSearchGuards.normalizeScanPaths(['', ...manyPaths, manyPaths[0]])

  assert.equal(normalizedPaths.length, imageSearchGuards.MAX_SCAN_PATHS)
  assert.equal(imageSearchGuards.normalizeScanMode('updateAll'), 'updateAll')
  assert.equal(imageSearchGuards.normalizeScanMode('bad'), 'full')
  assert.equal(imageSearchGuards.normalizeSearchMode('recall'), 'recall')
  assert.equal(imageSearchGuards.normalizeSearchMode('bad'), 'balanced')
  assert.equal(imageSearchGuards.clampNumber(999, 50, 1, 500), 500)
  assert.equal(imageSearchGuards.clampNumber('bad', 50, 1, 500), 50)
})

test('dev server guard only permits loopback HTTP URLs in development', () => {
  assert.equal(
    devServerGuard.getAllowedDevServerUrl(false, 'http://127.0.0.1:5173'),
    'http://127.0.0.1:5173/',
  )
  assert.equal(
    devServerGuard.getAllowedDevServerUrl(false, 'http://localhost:4173/app'),
    'http://127.0.0.1:4173/app',
  )
  assert.equal(
    devServerGuard.getAllowedDevServerUrl(false, 'http://[::1]:5173'),
    'http://[::1]:5173/',
  )
  assert.equal(devServerGuard.getAllowedDevServerUrl(true, 'http://127.0.0.1:5173'), null)
  assert.equal(devServerGuard.getAllowedDevServerUrl(false, 'https://example.com'), null)
  assert.equal(devServerGuard.getAllowedDevServerUrl(false, 'http://192.168.1.10:5173'), null)
  assert.equal(devServerGuard.getAllowedDevServerUrl(false, 'file:///tmp/index.html'), null)
  assert.equal(devServerGuard.getAllowedDevServerUrl(false, 'not a url'), null)
})

test('Windows environment guard collapses duplicate PATH keys', () => {
  const env = { PATH: 'C:\\tools', Path: 'C:\\tools', OTHER: 'value' }
  assert.equal(environmentGuards.normalizeWindowsPathEnvironment(env), true)
  assert.deepEqual(env, { Path: 'C:\\tools', OTHER: 'value' })
  assert.equal(environmentGuards.normalizeWindowsPathEnvironment(env), false)
})

test('Electron entry enforces one application instance and restores the existing window', () => {
  const source = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'electron', 'main.ts'),
    'utf8',
  )
  assert.match(source, /app\.requestSingleInstanceLock\(\)/)
  assert.match(source, /app\.on\('second-instance'/)
  assert.match(source, /revealGlobalWindow\(appCoreOptions\)/)
  assert.match(source, /if \(!hasSingleInstanceLock\) \{\s*app\.quit\(\)/)
})

test('window topmost can be disabled and is only reaffirmed while enabled', () => {
  const source = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'electron', 'main.ts'),
    'utf8',
  )
  const ipcSource = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'electron', 'appCoreIpc.ts'),
    'utf8',
  )
  assert.match(source, /if \(!windowAlwaysOnTop\) return/)
  assert.match(source, /mainWindow\.setAlwaysOnTop\(windowAlwaysOnTop,/)
  assert.match(ipcSource, /secureIpcMain\.handle\('set-window-always-on-top'/)
  assert.match(ipcSource, /options\.setWindowAlwaysOnTop\(value\)/)
})

test('transparent workspace disables native window movement and resize borders', () => {
  const source = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'electron', 'main.ts'),
    'utf8',
  )
  assert.match(source, /resizable:\s*false/)
  assert.match(source, /movable:\s*false/)
  assert.match(source, /thickFrame:\s*false/)
})
