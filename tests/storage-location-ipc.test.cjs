const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const { loadTsModule } = require('./guard-utils.cjs')
const { StorageLocationService } = loadTsModule('electron/storageLocationService.ts')

function loadWithMocks(relative, mocks) {
  const filename = path.resolve(__dirname, '..', relative)
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = Module._nodeModulePaths(path.dirname(filename))
  mod.require = (request) => {
    if (Object.hasOwn(mocks, request)) return mocks[request]
    if (request.startsWith('.'))
      return loadTsModule(
        path.relative(
          path.resolve(__dirname, '..'),
          path.resolve(path.dirname(filename), request + '.ts'),
        ),
      )
    return require(request)
  }
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  )
  return mod.exports
}

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'siftory-location-ipc-'),
  )
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const profile = path.join(root, 'profile')
  fs.mkdirSync(profile)
  const service = new StorageLocationService(profile, path.join(profile, 'original'))
  service.initialize()
  fs.writeFileSync(path.join(service.resolveRoot(), 'vectors.jsonl'), '{"vector":[1,0]}\n')
  const handlers = new Map()
  const progress = []
  let progressClosed = false,
    cancelPhase,
    initializationFailure,
    teardownFailure = false
  let response = 0,
    relaunches = 0,
    quits = 0,
    picker = root
  const adapter = loadWithMocks('electron/storageLocationIpc.ts', {
    electron: {
      app: { isPackaged: false, relaunch: () => relaunches++, quit: () => quits++ },
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [picker] }),
        showMessageBox: async (options) => {
          if (!options.signal) return { response }
          return new Promise((resolve) =>
            options.signal.addEventListener('abort', () => resolve({ response: 0 }), {
              once: true,
            }),
          )
        },
        showErrorBox: () => {},
      },
    },
    './ipcAuthorization': {
      secureIpcMain: { handle: (name, callback) => handlers.set(name, callback) },
    },
    './dataDirectorySecurity': {
      hardenDataDirectoryPermissions: async () => ({ reason: 'disabled' }),
    },
    './storageMigrationWindow': {
      createStorageMigrationWindow: async (onCancel) => {
        if (initializationFailure) throw new Error(initializationFailure)
        return {
          update: (value) => {
            progress.push(value)
            if (value.phase === cancelPhase) onCancel()
          },
          close: () => {
            progressClosed = true
            if (teardownFailure) throw new Error('window teardown failed')
          },
        }
      },
    },
  })
  const event = { sender: { id: 123 } }
  return {
    root,
    service,
    adapter,
    event,
    handlers,
    confirm: () => (response = 1),
    select: (value) => (picker = value),
    counters: () => ({ relaunches, quits }),
    progress,
    progressClosed: () => progressClosed,
    cancelDuring: (phase) => {
      cancelPhase = phase
    },
    failInitialization: (reason) => {
      initializationFailure = reason
    },
    failTeardown: () => {
      teardownFailure = true
    },
  }
}

test('migration authorization is bound to the selecting renderer and cannot be replayed', async (t) => {
  const f = fixture(t)
  f.adapter.registerStorageLocationIpc(f.service, false)
  const choose = f.handlers.get('appStorage:selectMigrationDestination')
  const start = f.handlers.get('appStorage:startMigration')
  const selected = await choose(f.event)
  await assert.rejects(start({ sender: { id: 999 } }, selected.token), /again/)
  await assert.rejects(start(f.event, selected.token), /again/)
  assert.equal(f.service.read().pending, undefined)
  assert.deepEqual(f.counters(), { relaunches: 0, quits: 0 })
})

test('native cancellation does not schedule migration or restart', async (t) => {
  const f = fixture(t)
  f.adapter.registerStorageLocationIpc(f.service, false)
  const selected = await f.handlers.get('appStorage:selectMigrationDestination')(f.event)
  assert.deepEqual(await f.handlers.get('appStorage:startMigration')(f.event, selected.token), {
    scheduled: false,
  })
  assert.equal(f.service.read().pending, undefined)
  assert.deepEqual(f.counters(), { relaunches: 0, quits: 0 })
})

test('confirmed migration schedules cold work and uses the normal asynchronous quit path', async (t) => {
  const f = fixture(t)
  f.adapter.registerStorageLocationIpc(f.service, false)
  f.confirm()
  const selected = await f.handlers.get('appStorage:selectMigrationDestination')(f.event)
  assert.deepEqual(await f.handlers.get('appStorage:startMigration')(f.event, selected.token), {
    scheduled: true,
  })
  assert.equal(f.service.read().pending.destination, selected.destination)
  assert.equal(fs.existsSync(selected.destination), false, 'no live database copy')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.counters(), { relaunches: 1, quits: 1 })
})

test('cold startup completes migration before services start and relaunches to bind the new root', async (t) => {
  const f = fixture(t)
  const destination = path.join(f.root, 'new-root')
  f.service.schedule(destination)
  assert.equal(await f.adapter.prepareStorageLocationStartup(f.service, undefined), false)
  assert.equal(f.service.resolveRoot(), destination)
  assert.deepEqual(f.counters(), { relaunches: 1, quits: 1 })
  assert.equal(f.progress.at(-1).phase, 'completed')
  assert.equal(f.progressClosed(), true)
})

test('closing the progress window during verification preserves the original library', async (t) => {
  const f = fixture(t)
  const original = f.service.resolveRoot()
  const destination = path.join(f.root, 'cancelled-copy')
  f.service.schedule(destination)
  f.cancelDuring('verifying')
  assert.equal(await f.adapter.prepareStorageLocationStartup(f.service, undefined), false)
  assert.equal(f.service.resolveRoot(), original)
  assert.equal(fs.existsSync(path.join(destination, '.siftory-library.json')), false)
  assert.deepEqual(f.counters(), { relaunches: 1, quits: 1 })
  assert.equal(f.progressClosed(), true)
  assert.equal(
    f.progress.some((p) => p.phase === 'completed'),
    false,
  )
})

test('isolated test sessions cannot read or migrate the real user library', (t) => {
  const f = fixture(t)
  f.adapter.registerStorageLocationIpc(f.service, true)
  assert.throws(() => f.handlers.get('appStorage:getLocation')(), /isolated/)
})

for (const reason of ['renderer initialization failed', 'window closed before ready']) {
  test(`startup recovers after migration UI failure: ${reason}`, async (t) => {
    const f = fixture(t)
    const original = f.service.resolveRoot()
    const destination = path.join(f.root, 'new-root')
    f.service.schedule(destination)
    f.failInitialization(reason)
    assert.equal(await f.adapter.prepareStorageLocationStartup(f.service, undefined), false)
    assert.equal(f.service.resolveRoot(), original)
    assert.equal(f.service.read().pending, undefined)
    assert.equal(f.service.read().lastMigration.state, 'failed')
    assert.equal(fs.existsSync(destination), false)
    assert.deepEqual(f.counters(), { relaunches: 1, quits: 1 })
    // The next startup must enter normal services, without trying the broken UI.
    assert.equal(await f.adapter.prepareStorageLocationStartup(f.service, undefined), true)
    assert.deepEqual(f.counters(), { relaunches: 1, quits: 1 })
  })
}

test('progress window teardown failure cannot undo a completed migration or skip relaunch', async (t) => {
  const f = fixture(t)
  const destination = path.join(f.root, 'new-root')
  f.service.schedule(destination)
  f.failTeardown()
  assert.equal(await f.adapter.prepareStorageLocationStartup(f.service, undefined), false)
  assert.equal(f.service.resolveRoot(), destination)
  assert.equal(f.service.read().lastMigration.state, 'completed')
  assert.deepEqual(f.counters(), { relaunches: 1, quits: 1 })
})

test('custom video cache paths block migration instead of silently leaving active data behind', async (t) => {
  const f = fixture(t)
  f.adapter.registerStorageLocationIpc(f.service, false)
  f.confirm()
  const selected = await f.handlers.get('appStorage:selectMigrationDestination')(f.event)
  const prior = process.env.SIFTORY_MEDIA_SEARCH_DIR
  process.env.SIFTORY_MEDIA_SEARCH_DIR = path.join(f.root, 'external-cache')
  try {
    await assert.rejects(
      f.handlers.get('appStorage:startMigration')(f.event, selected.token),
      /override/,
    )
  } finally {
    if (prior === undefined) delete process.env.SIFTORY_MEDIA_SEARCH_DIR
    else process.env.SIFTORY_MEDIA_SEARCH_DIR = prior
  }
  assert.equal(f.service.read().pending, undefined)
})

test('relocated media cache uses the active root even while the old copy still exists', (t) => {
  const f = fixture(t)
  const media = loadWithMocks('electron/mediaCacheService.ts', {
    electron: {
      app: { getPath: (name) => (name === 'userData' ? path.join(f.root, 'new-root') : f.root) },
    },
    './vectorDatabaseService': { getEmbeddingStorePaths: () => [] },
  })
  assert.equal(media.getMediaSearchDir(), path.join(f.root, 'new-root', 'media-search'))
})
