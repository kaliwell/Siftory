const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')
const { StorageLocationService, LIBRARY_MARKER } = loadTsModule(
  'electron/storageLocationService.ts',
)
const { migrateStorageDirectory } = loadTsModule('electron/storageDirectoryMigration.ts')
const resolver = loadTsModule('electron/storagePathResolver.ts')
const context = require('../scripts/maintenance-storage-context.cjs')
const repair = require('../scripts/repair-vector-coverage.cjs')
const rebuild = require('../scripts/rebuild-vector-library.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'siftory-maintenance-'),
  )
  const appData = path.join(directory, 'profile')
  const original = path.join(appData, 'floating-clock-electron')
  const destination = path.join(directory, 'Siftory-data-test')
  fs.mkdirSync(original, { recursive: true })
  const service = new StorageLocationService(appData, original)
  service.initialize()
  fs.writeFileSync(path.join(original, 'payload.bin'), 'original')
  const previousAppData = process.env.APPDATA
  process.env.APPDATA = appData
  t.after(() => {
    resolver.configureStoragePathResolver('', [])
    if (previousAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previousAppData
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    appData,
    original,
    destination,
    service,
    async move() {
      service.schedule(destination)
      assert.equal((await migrateStorageDirectory(service)).migrated, true)
    },
  }
}

test('both maintenance CLIs default to the active migrated root and accept its marked directory', async (t) => {
  const f = fixture(t)
  await f.move()
  assert.equal(repair.parseArgs([]).userDataPath, f.destination)
  assert.equal(rebuild.parseArgs([]).userDataPath, f.destination)
  const children = path.join(f.directory, 'children')
  const images = path.join(f.directory, 'images')
  fs.mkdirSync(children)
  fs.mkdirSync(images)
  for (const filename of [
    'embeddingPreparationChild.js',
    'clipEmbeddingChild.js',
    'dinoEmbeddingChild.js',
  ])
    fs.writeFileSync(path.join(children, filename), '')
  assert.doesNotThrow(() =>
    repair.validateOptions(repair.parseArgs([`--user-data=${f.destination}`])),
  )
  assert.doesNotThrow(() =>
    rebuild.validateOptions(
      rebuild.parseArgs([
        `--user-data=${f.destination}`,
        `--children-dir=${children}`,
        `--scan-path=${images}`,
      ]),
    ),
  )
  assert.throws(
    () => repair.validateOptions({ ...repair.parseArgs([]), execute: true, confirm: '' }),
    /requires --confirm/,
  )
})

test('retained copies, unmarked folders and malformed markers are rejected', async (t) => {
  const f = fixture(t)
  await f.move()
  assert.throws(() => context.validateMaintenanceRoot(f.original), /retained copy/)
  const unmarked = path.join(f.directory, 'unmarked')
  fs.mkdirSync(unmarked)
  assert.throws(() => context.validateMaintenanceRoot(unmarked))
  fs.writeFileSync(path.join(unmarked, LIBRARY_MARKER), '{}')
  assert.throws(() => context.validateMaintenanceRoot(unmarked), /identity/)
})

test('offline or corrupt active locations never fall back to a retained copy', async (t) => {
  const f = fixture(t)
  await f.move()
  fs.renameSync(f.destination, f.destination + '-offline')
  for (const cli of [repair, rebuild]) assert.throws(() => cli.parseArgs([]))
  fs.writeFileSync(f.service.bootstrapPath, '{broken')
  for (const cli of [repair, rebuild]) assert.throws(() => cli.parseArgs([]))
})

test('pending migration blocks maintenance defaults and explicit operations on that library', (t) => {
  const f = fixture(t)
  f.service.schedule(f.destination)
  for (const cli of [repair, rebuild])
    assert.throws(() => cli.parseArgs([]), /pending data migration/)
  assert.throws(() => context.validateMaintenanceRoot(f.original), /pending data migration/)
})

test('maintenance binds vector and historical cache paths to the active root without changing APPDATA', async (t) => {
  const f = fixture(t)
  await f.move()
  const restore = context.bindMaintenanceStorageRoot(f.destination)
  assert.equal(process.env.APPDATA, f.appData)
  assert.equal(resolver.getConfiguredStorageRoot(), f.destination)
  assert.equal(
    resolver.resolveStoredDataPath(path.join(f.original, 'media-search', 'frames', 'a.jpg')),
    path.join(f.destination, 'media-search', 'frames', 'a.jpg'),
  )
  const external = path.join(f.directory, 'external-original.jpg')
  assert.equal(resolver.resolveStoredDataPath(external), external)
  restore()
  assert.equal(resolver.getConfiguredStorageRoot(), undefined)
})
