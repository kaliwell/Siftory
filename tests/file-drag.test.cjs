const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const root = path.resolve(__dirname, '..')
const { FileDragAuthorizer } = loadTsModule('electron/fileDragAuthorization.ts')
const { shouldPreferPhotoshopCompatibilityPreview } = loadTsModule(
  'electron/fileDragCompatibility.ts',
)

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('file drag grants are scoped to one sender and expire', () => {
  let now = 1000
  let sequence = 0
  const authorizer = new FileDragAuthorizer(
    () => now,
    () => `token-${++sequence}`,
    500,
    8,
  )
  const file = { filePath: 'C:\\images\\source.png', size: 123, mtimeMs: 456 }
  const token = authorizer.issue(7, file)

  assert.deepEqual(authorizer.resolve(7, token), file)
  assert.equal(authorizer.resolve(8, token), null)

  now = 1500
  assert.equal(authorizer.resolve(7, token), null)
})

test('file drag grant capacity evicts the oldest capability', () => {
  let sequence = 0
  const authorizer = new FileDragAuthorizer(
    () => 1000,
    () => `token-${++sequence}`,
    5000,
    2,
  )
  const first = authorizer.issue(1, { filePath: 'C:\\a.png', size: 1, mtimeMs: 1 })
  const second = authorizer.issue(1, { filePath: 'C:\\b.png', size: 2, mtimeMs: 2 })
  const third = authorizer.issue(1, { filePath: 'C:\\c.png', size: 3, mtimeMs: 3 })

  assert.equal(authorizer.resolve(1, first), null)
  assert.equal(authorizer.resolve(1, second)?.filePath, 'C:\\b.png')
  assert.equal(authorizer.resolve(1, third)?.filePath, 'C:\\c.png')
})

test('native drag IPC verifies sender, token, and source fingerprint', () => {
  const ipc = source('electron/fileDragIpc.ts')
  assert.match(ipc, /secureIpcMain\.on\('fileDrag:start'/)
  assert.match(ipc, /event\.sender !== window\.webContents/)
  assert.match(ipc, /event\.senderFrame === window\.webContents\.mainFrame/)
  assert.match(ipc, /authorizer\.resolve\(event\.sender\.id, rawToken\)/)
  assert.match(ipc, /current\.size !== grant\.size/)
  assert.match(ipc, /current\.mtimeMs - grant\.mtimeMs/)
  assert.match(ipc, /resolveCompatibilityDragFile\(current, userDataPath\)/)
  assert.match(ipc, /convertStillImageToPng/)
  assert.match(ipc, /event\.sender\.startDrag\(\{ file: dragFile, icon: dragIcon \}\)/)
})

test('legacy Photoshop-risk formats prefer a compatible preview without flattening native PSD', () => {
  for (const file of ['asset.webp', 'asset.avif', 'asset.svg', 'asset.ai', 'asset.pdf']) {
    assert.equal(shouldPreferPhotoshopCompatibilityPreview(file), true, file)
  }
  for (const file of ['asset.jpg', 'asset.png', 'asset.tif', 'asset.psd', 'asset.psb']) {
    assert.equal(shouldPreferPhotoshopCompatibilityPreview(file), false, file)
  }
})

test('all image search result paths receive main-process drag capabilities', () => {
  for (const file of [
    'electron/imageSearchIpc.ts',
    'electron/vectorIpc.ts',
    'electron/subjectSearchIpc.ts',
  ]) {
    assert.match(source(file), /authorizeFileDragResults/)
  }
})

test('result grid starts native drag instead of exposing thumbnail data', () => {
  const grid = source('src/components/ImageSearchResultGrid.tsx')
  const preload = source('electron/preload.ts')
  assert.match(grid, /draggable=\{Boolean\(r\.dragToken\)\}/)
  assert.match(grid, /event\.preventDefault\(\)/)
  assert.match(grid, /event\.shiftKey \? 'original' : 'compatible'/)
  assert.match(preload, /ipcRenderer\.send\('fileDrag:start', token, mode\)/)
  assert.doesNotMatch(preload, /ipcRenderer\.invoke\('fileDrag:start'/)
})
