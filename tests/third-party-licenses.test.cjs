const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')
const { assertTemporaryDirectory } = require('./smoke-test-utils.cjs')

const { openThirdPartyLicenseDirectory } = loadTsModule('electron/thirdPartyLicenses.ts')
const { getIpcCapabilityDeclaration } = loadTsModule('shared/ipc-capabilities.ts')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-license-entry-'))
  const expectedRoot = fs.realpathSync(root)
  t.after(() => {
    assertTemporaryDirectory(root)
    assert.equal(fs.realpathSync(root), expectedRoot, 'Temporary fixture must not be redirected')
    fs.rmSync(root, { recursive: true, force: true })
  })
  const options = {
    isPackaged: true,
    appPath: path.join(root, 'app.asar'),
    resourcesPath: path.join(root, 'resources'),
  }
  fs.mkdirSync(options.resourcesPath)
  const opened = []
  const shell = {
    showItemInFolder: () => assert.fail('License access must open the fixed directory'),
    openPath: async (directory) => {
      opened.push(directory)
      return ''
    },
  }
  const addLicenses = (appRoot) => {
    const directory = path.join(appRoot, 'legal')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'LICENSE.txt'), 'Fixture license notice')
    // Match fs.promises.realpath in production when Windows TEMP uses an 8.3 alias.
    return fs.realpathSync.native(directory)
  }
  return { root, options, opened, shell, addLicenses }
}

test('packaged license entry uses external resources even when appPath points inside ASAR', async (t) => {
  const { options, opened, shell, addLicenses } = fixture(t)
  const expected = addLicenses(options.resourcesPath)
  assert.deepEqual(await openThirdPartyLicenseDirectory(options, shell), { ok: true })
  assert.deepEqual(opened, [expected])
})

test('development license entry uses the application root and ignores Electron resources', async (t) => {
  const { root, options, opened, shell, addLicenses } = fixture(t)
  options.isPackaged = false
  options.appPath = path.join(root, 'project')
  const expected = addLicenses(options.appPath)
  addLicenses(options.resourcesPath)
  assert.deepEqual(await openThirdPartyLicenseDirectory(options, shell), { ok: true })
  assert.deepEqual(opened, [expected])
})

test('a missing license directory does not fall back to a different application root', async (t) => {
  const { options, opened, shell, addLicenses } = fixture(t)
  addLicenses(options.appPath)
  assert.deepEqual(await openThirdPartyLicenseDirectory(options, shell), {
    ok: false,
    reason: 'unavailable',
  })
  assert.deepEqual(opened, [])
})

test('an empty directory is reported as unavailable without launching the shell', async (t) => {
  const { options, opened, shell } = fixture(t)
  fs.mkdirSync(path.join(options.resourcesPath, 'legal'))
  assert.deepEqual(await openThirdPartyLicenseDirectory(options, shell), {
    ok: false,
    reason: 'unavailable',
  })
  assert.deepEqual(opened, [])
})

test('a file named legal is never launched as an application or document', async (t) => {
  const { options, opened, shell } = fixture(t)
  fs.writeFileSync(path.join(options.resourcesPath, 'legal'), 'not a directory')
  assert.deepEqual(await openThirdPartyLicenseDirectory(options, shell), {
    ok: false,
    reason: 'unavailable',
  })
  assert.deepEqual(opened, [])
})

test('a junction or symlink cannot redirect the fixed license entry outside resources', async (t) => {
  const { root, options, opened, shell, addLicenses } = fixture(t)
  const outside = addLicenses(path.join(root, 'outside'))
  fs.symlinkSync(
    outside,
    path.join(options.resourcesPath, 'legal'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  assert.deepEqual(await openThirdPartyLicenseDirectory(options, shell), {
    ok: false,
    reason: 'unavailable',
  })
  assert.deepEqual(opened, [])
})

test('renderer arguments are rejected rather than used as paths or shell options', async (t) => {
  const { options, opened, shell, addLicenses } = fixture(t)
  addLicenses(options.resourcesPath)
  for (const args of [['../outside'], [{ path: 'https://example.com' }], [null]]) {
    assert.deepEqual(await openThirdPartyLicenseDirectory(options, shell, args), {
      ok: false,
      reason: 'invalid-request',
    })
  }
  assert.deepEqual(opened, [])
})

test('shell failure messages and exceptions are normalized without leaking local paths', async (t) => {
  const { options, addLicenses } = fixture(t)
  addLicenses(options.resourcesPath)
  for (const implementation of [
    { openPath: async () => 'failed at a private user path' },
    {
      openPath: async () => {
        throw new Error('failed at a private user path')
      },
    },
  ]) {
    const shell = {
      ...implementation,
      showItemInFolder: () => assert.fail('License access must open the fixed directory'),
    }
    assert.deepEqual(await openThirdPartyLicenseDirectory(options, shell), {
      ok: false,
      reason: 'open-failed',
    })
  }
})

test('only the fixed license channel gets filesystem and external access capability', () => {
  assert.deepEqual(getIpcCapabilityDeclaration('app:openThirdPartyLicenses').capabilities, [
    'R',
    'FS',
    'EXT',
  ])
  assert.equal(getIpcCapabilityDeclaration('app:openArbitraryPath'), null)
})
