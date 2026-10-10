const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const { buildAppEntry, computeTags, extractExePath, extractIconPath, isSkippableRoot } =
  loadTsModule('electron/appStorageService.ts')

test('App Storage parses executable and icon paths safely', () => {
  assert.equal(extractExePath('"C:\\Apps\\Demo\\uninstall.exe" /S'), 'C:\\Apps\\Demo')
  assert.equal(extractIconPath('"C:\\Apps\\Demo\\demo.exe",0'), 'C:\\Apps\\Demo')
  assert.equal(extractExePath('"D:\\SteamLibrary\\steam.exe" -silent'), null)
})

test('App Storage rejects broad and temporary scan roots', () => {
  assert.equal(isSkippableRoot('C:\\'), true)
  assert.equal(isSkippableRoot('C:\\Windows'), true)
  assert.equal(isSkippableRoot('C:\\Windows\\Temp\\cache'), true)
  assert.equal(isSkippableRoot('C:\\Apps\\Demo'), false)
})

test('App Storage converts registry KB estimates and computes trust tags', () => {
  const entry = buildAppEntry(
    {
      DisplayName: '示例应用',
      Publisher: 'Example',
      EstimatedSize: 2048,
      InstallLocation: 'C:\\Apps\\Demo',
    },
    0,
  )
  assert.equal(entry.name, '示例应用')
  assert.equal(entry.estimatedRegistryBytes, 2 * 1024 * 1024)
  assert.ok(entry.paths.every((candidate) => candidate.path !== 'C:\\'))

  entry.paths = []
  assert.deepEqual(computeTags(entry), ['Missing paths', 'Registry estimate', 'Portable-like'])
})
