const test = require('node:test')
const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const { loadTsModule } = require('./guard-utils.cjs')
const { ShellPreviewRuntime } = loadTsModule('electron/projectPreviewShellRuntime.ts')

test('production launcher uses spawn with IPC and strips forced Node mode', async () => {
  const spawns = []
  const context = {
    exports: {},
    Buffer,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    process: {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execPath: process.execPath,
      platform: 'win32',
      versions: {},
      once: () => {},
    },
    require: (name) => {
      if (name === 'electron')
        return { app: { getAppPath: () => require.resolve('./fixtures/shell-preview-child.cjs') } }
      if (name === 'node:child_process')
        return {
          fork: () => {
            throw Error('Electron fork forces Node mode')
          },
          spawn: (executable, args, options) => {
            spawns.push(options)
            return require('node:child_process').spawn(executable, args, options)
          },
        }
      return require(name)
    },
  }
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync('electron/projectPreviewShellRuntime.ts', 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    context,
  )
  assert.equal(await context.exports.runShellPreviewCompute('normal'), null)
  assert.equal(spawns.length, 0, 'Plain Node has no desktop Shell API')
  const runtime = new context.exports.ShellPreviewRuntime()
  try {
    assert.equal((await runtime.run('normal')).toString(), 'unchanged-thumbnail')
    assert.equal(spawns.length, 1)
    assert.equal(spawns[0].env.ELECTRON_RUN_AS_NODE, undefined)
    assert.ok(spawns[0].stdio.includes('ipc'))
    assert.ok(fs.existsSync(spawns[0].env.SIFTORY_SHELL_PREVIEW_PROFILE))
  } finally {
    await runtime.stop()
  }
  assert.equal(fs.existsSync(spawns[0].env.SIFTORY_SHELL_PREVIEW_PROFILE), false)
})

function fixture(t) {
  const f = { launches: 0, cleaned: 0 }
  f.runtime = new ShellPreviewRuntime(async (nonce) => {
    f.launches++
    return {
      child: fork(require.resolve('./fixtures/shell-preview-child.cjs'), [nonce], {
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }),
      cleanup: async () => {
        f.cleaned++
      },
    }
  })
  t.after(async () => {
    await f.runtime.stop()
    assert.deepEqual(f.runtime.stats().pids, [])
  })
  return f
}

test('synchronous thumbnail work in the child preserves bytes while the host keeps responding', async (t) => {
  const f = fixture(t)
  let ticks = 0
  const timer = setInterval(() => {
    ticks++
  }, 10)
  const reports = []
  try {
    const bytes = await f.runtime.run('stall', { onMetrics: (m) => reports.push(m) })
    assert.equal(bytes.toString(), 'unchanged-thumbnail')
    assert.ok(ticks >= 10, `host responded only ${ticks} times during a 500ms child stall`)
    assert.ok(reports[0].durations.thumbnail >= 500)
    assert.notEqual(reports[0].childPid, process.pid)
    const pid = f.runtime.stats().pids[0]
    await f.runtime.run('normal')
    assert.equal(f.launches, 1)
    assert.deepEqual(f.runtime.stats().pids, [pid])
    assert.equal(f.runtime.stats().busy, false)
  } finally {
    clearInterval(timer)
  }
})

test('hard timeout reaps a blocked process before replacement and preserves later requests', async (t) => {
  const f = fixture(t)
  await f.runtime.run('normal')
  const pid = f.runtime.stats().pids[0]
  await assert.rejects(f.runtime.run('hang', { timeoutMs: 100 }), { code: 'SHELL_PREVIEW_TIMEOUT' })
  assert.deepEqual(f.runtime.stats().pids, [])
  assert.equal(f.cleaned, 1)
  assert.equal(f.runtime.stats().lastRun.activeStep, 'thumbnail')
  assert.throws(() => process.kill(pid, 0))
  assert.ok(await f.runtime.run('normal'))
  assert.equal(f.launches, 2)
})

test('active and queued cancellation do not publish results or launch queued processes', async (t) => {
  const f = fixture(t)
  await f.runtime.run('normal')
  let cancelled = false
  const active = f.runtime.run('hang', { isCancelled: () => cancelled })
  const queued = f.runtime.run('normal', { isCancelled: () => cancelled })
  const activeCheck = assert.rejects(active, { code: 'PROJECT_PREVIEW_CANCELLED' })
  const queuedCheck = assert.rejects(queued, { code: 'PROJECT_PREVIEW_CANCELLED' })
  setTimeout(() => {
    cancelled = true
  }, 50)
  await Promise.all([activeCheck, queuedCheck])
  assert.deepEqual(f.runtime.stats().pids, [])
  assert.equal(f.launches, 1)
})

test('crashes and malformed output are contained and next work can recover', async (t) => {
  const f = fixture(t)
  await assert.rejects(f.runtime.run('crash'), { code: 'SHELL_PREVIEW_PROCESS_EXIT' })
  await assert.rejects(f.runtime.run('invalid'), { code: 'SHELL_PREVIEW_INVALID_RESULT' })
  assert.ok(await f.runtime.run('normal'))
  assert.equal(f.launches, 3)
})

test('quit cancels active and queued work, reaps its child, and rejects new requests', async (t) => {
  const f = fixture(t)
  await f.runtime.run('normal')
  const pending = f.runtime.run('hang')
  const queued = f.runtime.run('normal')
  const checks = [
    assert.rejects(pending, { code: 'PROJECT_PREVIEW_CANCELLED' }),
    assert.rejects(queued, { code: 'PROJECT_PREVIEW_CANCELLED' }),
  ]
  await f.runtime.stop()
  await Promise.all(checks)
  assert.deepEqual(f.runtime.stats().pids, [])
  await assert.rejects(f.runtime.run('normal'), { code: 'PROJECT_PREVIEW_CANCELLED' })
})
