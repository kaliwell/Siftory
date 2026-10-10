const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')

const {
  BUILD_OUTPUT_DIRECTORIES,
  cleanBuildOutputs,
} = require('../scripts/clean-build-outputs.cjs')

test('production build cleaning removes only known output directories', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-build-clean-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const name of BUILD_OUTPUT_DIRECTORIES) {
    fs.mkdirSync(path.join(root, name), { recursive: true })
    fs.writeFileSync(path.join(root, name, 'stale.js'), 'stale output')
  }
  fs.writeFileSync(path.join(root, 'keep.txt'), 'user source')

  assert.deepEqual(cleanBuildOutputs(root), BUILD_OUTPUT_DIRECTORIES)
  for (const name of BUILD_OUTPUT_DIRECTORIES) {
    assert.equal(fs.existsSync(path.join(root, name)), false)
  }
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'user source')
  assert.deepEqual(cleanBuildOutputs(root), [])
})

test(
  'Windows build launchers forward profile and failure through the checked npm build',
  {
    skip: process.platform !== 'win32',
  },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory build launcher '))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const project = path.join(root, 'project')
    fs.mkdirSync(project)
    fs.writeFileSync(
      path.join(project, 'npm.cmd'),
      '@echo off\r\necho BUILD_ARGS=%*\r\necho BUILD_CWD=%CD%\r\nexit /b 17\r\n',
    )
    for (const name of ['build.bat', 'build-installer.bat']) {
      fs.copyFileSync(path.join(__dirname, '..', name), path.join(project, name))
      const result = spawnSync('cmd.exe', ['/d', '/c', `project\\${name}`, '--profile=offline'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      })
      assert.equal(result.status, 17, `${name}: ${result.stderr || result.error || result.stdout}`)
      assert.match(result.stdout, /BUILD_ARGS=run build -- --profile=offline/)
      assert.ok(result.stdout.includes(`BUILD_CWD=${project}`), result.stdout)
    }
  },
)
