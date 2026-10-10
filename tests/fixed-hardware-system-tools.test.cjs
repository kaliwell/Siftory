'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  TOOL_RELATIVE_PATHS,
  createFixedWindowsSystemEnvironment,
  resolveFixedHardwareSystemTools,
} = require('../scripts/fixed-hardware-system-tools.cjs')

function createToolFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-system-tools-'))
  for (const segments of Object.values(TOOL_RELATIVE_PATHS)) {
    const filePath = path.win32.join(root, ...segments)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'fixture')
  }
  return root
}

test('fixed-hardware tools resolve only absolute regular files under one trusted root', () => {
  const root = createToolFixture()
  try {
    const tools = resolveFixedHardwareSystemTools({ platform: 'win32', windowsRoot: root })
    assert.equal(tools.policy, 'fixed-windows-system32-v1')
    for (const name of ['powershell', 'taskkill', 'nvidiaSmi', 'wmic', 'comSpec']) {
      assert.equal(path.isAbsolute(tools[name]), true)
      assert.equal(fs.lstatSync(tools[name]).isFile(), true)
      assert.equal(path.relative(root, tools[name]).startsWith('..'), false)
    }
    const environment = createFixedWindowsSystemEnvironment({
      systemRoot: tools.systemRoot,
      comSpec: tools.comSpec,
    })
    assert.equal(Object.isFrozen(environment), true)
    assert.deepEqual(Object.keys(environment).sort(), [
      'ComSpec',
      'PATH',
      'PATHEXT',
      'PSModulePath',
      'ProgramFiles',
      'ProgramW6432',
      'SystemRoot',
      'WINDIR',
    ])
    assert.equal(environment.ComSpec, tools.comSpec)
    assert.equal(environment.SystemRoot, tools.systemRoot)
    assert.equal(environment.WINDIR, tools.systemRoot)
    assert.equal(environment.PATHEXT, '.COM;.EXE;.BAT;.CMD')
    assert.match(environment.PATH, /System32/i)
    assert.match(environment.PSModulePath, /WindowsPowerShell\\v1\.0\\Modules$/i)
    const expectedProgramFiles = path.win32.join(path.win32.parse(tools.systemRoot).root, 'Program Files')
    assert.equal(environment.ProgramFiles, expectedProgramFiles)
    assert.equal(environment.ProgramW6432, expectedProgramFiles)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fixed Windows environment derives Program Files only from the trusted system drive', () => {
  const environment = createFixedWindowsSystemEnvironment({
    systemRoot: 'D:\\TrustedWindows',
    comSpec: 'D:\\TrustedWindows\\System32\\cmd.exe',
  })
  assert.equal(environment.ProgramFiles, 'D:\\Program Files')
  assert.equal(environment.ProgramW6432, 'D:\\Program Files')
  assert.throws(
    () => createFixedWindowsSystemEnvironment({ systemRoot: '\\\\server\\Windows' }),
    /trusted drive/,
  )
})

test('fixed-hardware tool policy rejects relative roots, missing tools, and links', (t) => {
  assert.throws(
    () => resolveFixedHardwareSystemTools({ platform: 'win32', windowsRoot: 'Windows' }),
    /must be absolute/,
  )

  const missingRoot = createToolFixture()
  try {
    fs.rmSync(path.win32.join(missingRoot, ...TOOL_RELATIVE_PATHS.taskkill))
    assert.throws(
      () => resolveFixedHardwareSystemTools({ platform: 'win32', windowsRoot: missingRoot }),
      /ENOENT/,
    )
  } finally {
    fs.rmSync(missingRoot, { recursive: true, force: true })
  }

  const linkRoot = createToolFixture()
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-system-tool-target-'))
  try {
    const powerShell = path.win32.join(linkRoot, ...TOOL_RELATIVE_PATHS.powershell)
    const target = path.join(targetRoot, 'powershell.exe')
    fs.writeFileSync(target, 'target')
    fs.rmSync(powerShell)
    try {
      fs.symlinkSync(target, powerShell, 'file')
    } catch (error) {
      if (['EPERM', 'EACCES'].includes(error?.code)) {
        t.skip('Windows link creation is unavailable')
        return
      }
      throw error
    }
    assert.throws(
      () => resolveFixedHardwareSystemTools({ platform: 'win32', windowsRoot: linkRoot }),
      /non-link file/,
    )
  } finally {
    fs.rmSync(linkRoot, { recursive: true, force: true })
    fs.rmSync(targetRoot, { recursive: true, force: true })
  }
})
