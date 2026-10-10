// Real OS shortcut ownership across two isolated Electron processes.
// This does not synthesize keyboard input or touch an existing application's profile.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createSmokeSessionMarker, createSmokeSpawnEnvironment } = require('./smoke-test-utils.cjs')

const TARGETS = [
  ['toggle-primary', 'CommandOrControl+Shift+Alt+R'],
  ['toggle-legacy', 'CommandOrControl+Shift+Alt+Q'],
  ['snap-panels', 'CommandOrControl+Shift+Alt+P'],
  ['show-all', 'CommandOrControl+Shift+Alt+S'],
]

async function runChild() {
  const { app, globalShortcut } = require('electron')
  const session = process.argv
    .find((arg) => arg.startsWith('--session='))
    .slice('--session='.length)
  const mode = process.argv.includes('--owner') ? 'owner' : 'probe'
  const directory = fs.realpathSync(session)
  const relative = path.relative(fs.realpathSync(os.tmpdir()), directory)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  assert.ok(fs.existsSync(path.join(directory, '.floating-clock-smoke-session.json')))
  const profile = path.join(directory, mode)
  fs.mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  await app.whenReady()
  let core
  const options = { userDataPath: profile, getMainWindow: () => null, getWorkArea: () => ({}) }
  if (mode === 'probe') {
    core = require('./guard-utils.cjs').loadTsModule('electron/appCoreIpc.ts')
    core.registerAppCoreIpc(options)
  }
  process.on('message', async ({ id, command, accelerator }) => {
    try {
      let result
      if (command === 'reserve' && mode === 'owner') {
        assert.ok(TARGETS.some(([, candidate]) => candidate === accelerator))
        result = globalShortcut.register(accelerator, () => {})
      } else if (command === 'release') {
        globalShortcut.unregisterAll()
        result = true
      } else if (command === 'probe' && mode === 'probe') {
        result = core.registerGlobalHotkeys(options)
        globalShortcut.unregisterAll()
      } else if (command === 'quit') {
        await core?.flushWindowVisibilityDiagnostics()
        globalShortcut.unregisterAll()
        process.send({ id, result: true }, () => app.exit(0))
        return
      } else throw new Error('invalid smoke command')
      process.send({ id, result })
    } catch {
      process.send({ id, error: 'fixture-command-failed' })
    }
  })
  process.on('disconnect', () => {
    globalShortcut.unregisterAll()
    app.exit(1)
  })
  process.send({ ready: true })
}

async function runParent() {
  const artifactDirectory = path.resolve(__dirname, '../artifacts/window-visibility')
  fs.mkdirSync(artifactDirectory, { recursive: true })
  const report = { schemaVersion: 1, status: 'running', targets: [], electron: null }
  const session = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-window-shortcuts-'))
  createSmokeSessionMarker(session, 'ui')
  const children = []
  let sequence = 0
  async function start(mode) {
    const env = createSmokeSpawnEnvironment({})
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [__filename, `--${mode}`, `--session=${session}`], {
      cwd: path.resolve(__dirname, '..'),
      env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    children.push(child)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture-start-timeout')), 15_000)
      child.once('error', reject)
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('fixture-exited'))
      })
      child.once('message', (message) => {
        clearTimeout(timer)
        message.ready ? resolve() : reject(new Error('invalid-ready'))
      })
    })
    return child
  }
  function request(child, command, extra = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        child.off('message', handler)
        reject(new Error('fixture-response-timeout'))
      }, 10_000)
      function handler(message) {
        if (message.id !== id) return
        clearTimeout(timer)
        child.off('message', handler)
        message.error ? reject(new Error(message.error)) : resolve(message.result)
      }
      child.on('message', handler)
      child.send({ id, command, ...extra })
    })
  }
  try {
    const owner = await start('owner')
    const probe = await start('probe')
    report.electron = require('electron/package.json').version
    const baseline = await request(probe, 'probe')
    for (const [id, accelerator] of TARGETS) {
      if (!(await request(owner, 'reserve', { accelerator }))) {
        report.targets.push({ id, status: 'blocked', reason: 'already-owned-by-external-process' })
        continue
      }
      const conflict = await request(probe, 'probe')
      assert.equal(conflict.entries.find((entry) => entry.id === id).status, 'conflicted')
      for (const entry of baseline.entries.filter((entry) => entry.id !== id)) {
        assert.equal(
          conflict.entries.find((candidate) => candidate.id === entry.id).status,
          entry.status,
        )
      }
      await request(owner, 'release')
      const restored = await request(probe, 'probe')
      assert.equal(restored.entries.find((entry) => entry.id === id).status, 'registered')
      report.targets.push({ id, status: 'passed', conflictDetected: true, recovered: true })
    }
    await request(probe, 'quit')
    await request(owner, 'quit')
    const diagnostics = JSON.parse(
      fs.readFileSync(path.join(session, 'probe/diagnostics/window-visibility.json'), 'utf8'),
    )
    assert.ok(diagnostics.events.some((event) => event.code === 'hotkey-conflicted'))
    report.diagnosticsEvents = diagnostics.totalEvents
    report.status = report.targets.every((entry) => entry.status === 'passed')
      ? 'passed'
      : 'blocked'
  } catch {
    report.status = 'failed'
    report.failure = 'isolated-electron-shortcut-assertion-or-environment-failure'
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill()
        await new Promise((resolve) => {
          child.once('exit', resolve)
          setTimeout(resolve, 3_000).unref()
        })
      }
    }
    fs.writeFileSync(
      path.join(artifactDirectory, 'shortcut-conflicts.json'),
      JSON.stringify(report, null, 2),
    )
    // The sole deletion target is the mkdtemp directory created by this invocation.
    fs.rmSync(session, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  console.log(JSON.stringify(report))
  if (report.status !== 'passed') process.exitCode = 1
}

if (process.versions.electron) {
  runChild().catch(() => {
    require('electron').app.exit(1)
  })
} else {
  runParent().catch(() => {
    console.error('Window shortcut fixture failed')
    process.exitCode = 1
  })
}
