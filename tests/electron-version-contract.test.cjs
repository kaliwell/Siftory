const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
const { FALLBACK_MIRROR, installElectron } = require('../scripts/install-electron.cjs')

test('Electron is pinned exactly and the lockfile matches the declared version', () => {
  const declared = packageJson.devDependencies.electron
  const locked = packageLock.packages['node_modules/electron']?.version
  assert.match(declared, /^\d+\.\d+\.\d+$/)
  assert.equal(locked, declared)
})

test('clean npm installs explicitly provision the Electron binary', () => {
  assert.equal(packageJson.scripts.postinstall, 'node scripts/install-electron.cjs')
  assert.equal(packageJson.build.electronDist, 'node_modules/electron/dist')
})

test('Electron install retries a checksum-verified mirror after the official endpoint fails', () => {
  const calls = []
  const result = installElectron({
    installerPath: 'electron-install.js',
    env: { TEST_MARKER: '1' },
    runner: (installerPath, env) => {
      calls.push({ installerPath, env })
      return { exitCode: calls.length === 1 ? 1 : 0 }
    },
  })
  assert.deepEqual(result, { ok: true, usedFallback: true, error: undefined })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].env.ELECTRON_MIRROR, undefined)
  assert.equal(calls[1].env.ELECTRON_MIRROR, FALLBACK_MIRROR)
})

test('Electron install respects an explicitly configured mirror without changing it', () => {
  const calls = []
  const result = installElectron({
    installerPath: 'electron-install.js',
    env: { ELECTRON_MIRROR: 'https://example.invalid/electron/' },
    runner: (installerPath, env) => {
      calls.push({ installerPath, env })
      return { exitCode: 1, error: 'unavailable' }
    },
  })
  assert.deepEqual(result, { ok: false, usedFallback: false, error: 'unavailable' })
  assert.equal(calls.length, 1)
})
