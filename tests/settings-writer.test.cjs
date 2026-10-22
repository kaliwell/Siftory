const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')
const { loadTsModule } = require('./guard-utils.cjs')

function writer(api) {
  const timers = new Map()
  let id = 0
  const context = {
    exports: {},
    window: { electronAPI: api },
    setTimeout: (run, delay) => {
      timers.set(++id, { run, delay })
      return id
    },
    clearTimeout: (key) => timers.delete(key),
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/hooks/settingsWriter.ts'), 'utf8')
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  )
  return {
    ...context.exports,
    timers,
    async tick() {
      const [key, timer] = timers.entries().next().value
      timers.delete(key)
      timer.run()
      await new Promise(setImmediate)
      return timer.delay
    },
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test('settings from different callers merge while preserving unrelated persisted keys', async () => {
  let saved
  const w = writer({
    loadSettings: async () => ({
      theme: 0,
      manifestPath: 'fixture.json',
      firstRunGuide: { schema: 1 },
    }),
    saveSettings: async (value) => {
      saved = structuredClone(value)
    },
  })
  w.scheduleSettingsWrite({ theme: 2 })
  w.scheduleSettingsWrite({ language: 'zh-CN' })
  assert.equal(w.timers.size, 1)
  await w.flushSettingsWrites()
  assert.deepEqual(saved, {
    theme: 2,
    manifestPath: 'fixture.json',
    firstRunGuide: { schema: 1 },
    language: 'zh-CN',
  })
  assert.equal(w.timers.size, 0)
  assert.equal(w.getSettingsWriteStatus(), 'saved')
})

test('concurrent flushes serialize disk writes and drain edits made during an earlier write', async () => {
  const started = deferred(),
    gate = deferred()
  let persisted = { theme: 0 },
    active = 0,
    maximum = 0,
    writes = 0
  const w = writer({
    loadSettings: async () => structuredClone(persisted),
    saveSettings: async (data) => {
      maximum = Math.max(maximum, ++active)
      if (++writes === 1) {
        started.resolve()
        await gate.promise
      }
      persisted = structuredClone(data)
      --active
    },
  })
  w.scheduleSettingsWrite({ theme: 1 })
  const first = w.flushSettingsWrites()
  await started.promise
  w.scheduleSettingsWrite({ theme: 2, language: 'zh-CN' })
  const second = w.flushSettingsWrites()
  gate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(persisted, { theme: 2, language: 'zh-CN' })
  assert.equal(maximum, 1)
  assert.equal(writes, 2)
  assert.equal(w.timers.size, 0)
})

test('failed writes reject, retain unsaved fields, and never overwrite newer edits on retry', async () => {
  const started = deferred(),
    gate = deferred()
  let fail = true,
    saved
  const w = writer({
    loadSettings: async () => ({ manifestPath: 'fixture.json' }),
    saveSettings: async (data) => {
      if (fail) {
        started.resolve()
        await gate.promise
      }
      saved = structuredClone(data)
    },
  })
  w.scheduleSettingsWrite({ theme: 1, language: 'zh-CN' })
  const failed = assert.rejects(w.flushSettingsWrites(), /Could not save local settings/)
  await started.promise
  w.scheduleSettingsWrite({ theme: 2 })
  gate.reject(new Error('Synthetic disk full'))
  await failed
  assert.equal(w.getSettingsWriteStatus(), 'error')
  fail = false
  await w.flushSettingsWrites()
  assert.deepEqual(saved, { manifestPath: 'fixture.json', theme: 2, language: 'zh-CN' })
  assert.equal(w.getSettingsWriteStatus(), 'saved')
})

test('autosave retries are bounded, expose failure, and allow recovery without another edit', async () => {
  let fail = true,
    attempts = 0
  const w = writer({
    loadSettings: async () => ({}),
    saveSettings: async () => {
      attempts++
      if (fail) throw new Error('Synthetic failure')
    },
  })
  w.scheduleSettingsWrite({ theme: 2 })
  assert.equal(await w.tick(), 500)
  assert.equal(await w.tick(), 1000)
  assert.equal(await w.tick(), 3000)
  assert.equal(attempts, 3)
  assert.equal(w.timers.size, 0)
  assert.equal(w.getSettingsWriteStatus(), 'error')
  fail = false
  await w.flushSettingsWrites()
  assert.equal(attempts, 4)
  assert.equal(w.getSettingsWriteStatus(), 'saved')
})

test('a settings read error cannot replace the existing file with only a partial edit', async () => {
  let fail = true,
    saved
  const w = writer({
    loadSettings: async () => {
      if (fail) throw new Error('Synthetic read failure')
      return { manifestPath: 'fixture.json' }
    },
    saveSettings: async (data) => {
      saved = structuredClone(data)
    },
  })
  w.scheduleSettingsWrite({ theme: 3 })
  await assert.rejects(w.flushSettingsWrites())
  assert.equal(saved, undefined)
  fail = false
  await w.flushSettingsWrites()
  assert.deepEqual(saved, { manifestPath: 'fixture.json', theme: 3 })
})

test('write status subscribers can unsubscribe and an empty edit does not touch disk', async () => {
  const states = []
  const w = writer({ loadSettings: async () => null, saveSettings: async () => {} })
  const unsubscribe = w.subscribeSettingsWriteStatus(() => states.push(w.getSettingsWriteStatus()))
  w.scheduleSettingsWrite({})
  assert.equal(w.timers.size, 0)
  w.scheduleSettingsWrite({ theme: 1 })
  await w.flushSettingsWrites()
  unsubscribe()
  w.scheduleSettingsWrite({ theme: 2 })
  await w.flushSettingsWrites()
  assert.deepEqual(states, ['pending', 'saved'])
})

test('atomic settings failure reports failure and preserves the original JSON', () => {
  const { readJSON, writeJSON } = loadTsModule('electron/settingsStore.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-save-test-'))
  const file = path.join(dir, 'settings.json')
  try {
    assert.equal(writeJSON(file, { theme: 1 }), true)
    fs.mkdirSync(file + '.tmp')
    assert.equal(writeJSON(file, { theme: 2 }), false)
    assert.deepEqual(readJSON(file), { theme: 1 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('strict settings reads distinguish missing settings from damaged or unreadable settings', () => {
  const { readJSON } = loadTsModule('electron/settingsStore.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-read-test-'))
  try {
    assert.equal(readJSON(path.join(dir, 'missing.json'), true), null)
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, '{damaged')
    assert.throws(() => readJSON(file, true), /Could not read local settings/)
    assert.equal(fs.readFileSync(file, 'utf8'), '{damaged')
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('settings.json.corrupted-')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
