const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { startAssetLibrarySyncTask } = loadTsModule(
  'electron/assetLibrarySyncService.ts',
)

function createHarness(overrides = {}) {
  const progress = []
  const feedback = []
  const calls = { sourcePath: '', concurrency: 0, manifest: '' }
  const task = { id: 'sync-1', cancelled: false }
  const host = {
    startTask(type, runner) {
      assert.equal(type, 'sync')
      return { ok: true, taskId: task.id, promise: runner(task) }
    },
    publishProgress(patch) {
      progress.push(patch)
    },
    async markFeedbackDirty(reason) {
      feedback.push(reason)
    },
  }
  const dependencies = {
    getDefaultSourcePath: () => 'default-index',
    getAssetStore: () => ({
      async replaceFromImageIndex(assets, manifest, isCancelled, onProgress) {
        calls.manifest = manifest
        assert.equal(isCancelled(), false)
        assert.equal(assets.length, 2)
        onProgress(1, 2)
        return { added: 1, updated: 1, missing: 1, total: 2 }
      },
    }),
    async readSource(sourcePath, options) {
      calls.sourcePath = sourcePath
      options.onProgress({ current: 1, total: 4, message: 'Reading...' })
      return { assets: [{ path: 'a' }], sourceManifest: 'manifest.json' }
    },
    async verifySource(assets, options) {
      assert.equal(assets.length, 1)
      calls.concurrency = options.concurrency
      options.onProgress({ current: 3, total: 4, message: 'Verifying...' })
      return { assets: [{ path: 'a' }, { path: 'b' }], missing: 2, invalid: 1 }
    },
    ...overrides,
  }
  return { host, dependencies, progress, feedback, calls }
}

test('asset sync maps stage progress and reports the persisted result', async () => {
  const harness = createHarness()
  const started = startAssetLibrarySyncTask(' custom-index ', harness.host, harness.dependencies)
  const message = await started.promise

  assert.equal(harness.calls.sourcePath, 'custom-index')
  assert.equal(harness.calls.concurrency, 24)
  assert.equal(harness.calls.manifest, 'manifest.json')
  assert.deepEqual(
    harness.progress.map(({ percent, message: progressMessage }) => [
      percent,
      progressMessage,
    ]),
    [
      [9, 'Reading...'],
      [76, 'Verifying...'],
      [92, 'Saving asset metadata...'],
      [96, 'Updating asset library...'],
    ],
  )
  assert.deepEqual(harness.feedback, ['Asset library synchronized with Image Search'])
  assert.equal(
    message,
    'Synced 2 available assets: 1 new, 1 updated, 1 marked missing, 3 stale index records skipped.',
  )
})

test('asset sync uses the active index and skips feedback for an unchanged library', async () => {
  const harness = createHarness({
    getAssetStore: () => ({
      async replaceFromImageIndex() {
        return { added: 0, updated: 0, missing: 0, total: 2 }
      },
    }),
  })
  const started = startAssetLibrarySyncTask(undefined, harness.host, harness.dependencies)
  await started.promise

  assert.equal(harness.calls.sourcePath, 'default-index')
  assert.deepEqual(harness.feedback, [])
})

test('asset sync rejects a missing source before reading storage', async () => {
  const harness = createHarness({
    getDefaultSourcePath: () => '',
    getAssetStore: () => {
      assert.fail('storage should not be opened without a source')
    },
  })
  const started = startAssetLibrarySyncTask(' ', harness.host, harness.dependencies)

  await assert.rejects(started.promise, /Load or build an Image Search index first/)
})
