const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')
const { installSearchModels } = loadTsModule('src/services/installSearchModels.ts')
const { buildProductTaskInventory } = loadTsModule('src/services/productReadiness.ts')

test('open-ended scanning never presents 100% or claims an unsaved index survives restart', () => {
  const [task] = buildProductTaskInventory({
    imageSearch: { state: 'scanning', indexedCount: 1610, pendingCount: 0 },
  })
  assert.equal(task.indeterminate, true)
  assert.equal(task.state, 'running')
  assert.ok(task.progress < 100)
  assert.equal(task.persisted, false)
  const [saving] = buildProductTaskInventory({
    imageSearch: { state: 'idle', indexedCount: 1610, pendingCount: 0, autosaveState: 'saving' },
  })
  assert.equal(saving.state, 'running')
  const [failed] = buildProductTaskInventory({
    imageSearch: { state: 'idle', indexedCount: 1610, pendingCount: 0, autosaveState: 'failed' },
  })
  assert.equal(failed.state, 'failed')
  assert.equal(failed.persisted, false)
  const [done] = buildProductTaskInventory({
    imageSearch: { state: 'idle', indexedCount: 1610, pendingCount: 0, autosaveState: 'saved' },
  })
  assert.equal(done.indeterminate, false)
  assert.equal(done.state, 'completed')
  assert.equal(done.progress, 100)
  assert.equal(done.persisted, true)
})

test('preparation consumers share an in-flight snapshot and refresh again after it settles', async () => {
  const { loadProductReadiness } = loadTsModule('src/services/productReadiness.ts')
  const count = { value: 0 }
  const namespace = new Proxy({}, { get: () => async () => null })
  const api = new Proxy(
    {},
    {
      get: (_, key) =>
        key === 'discoveryCatalog'
          ? {
              listSources: async () => {
                count.value++
                return []
              },
              getScanStatus: async () => [],
            }
          : namespace,
    },
  )
  await Promise.all([loadProductReadiness(api), loadProductReadiness(api)])
  assert.equal(count.value, 1)
  await loadProductReadiness(api)
  assert.equal(count.value, 2)
})

test('automatic model installation reuses verified files, downloads in sequence and rechecks installation', async () => {
  const statuses = new Map(),
    calls = [],
    updates = []
  const api = {
    getModelStatus: async (name) => statuses.get(name) || { name, state: 'not-installed' },
    downloadModel: async (name) => {
      calls.push(name)
      statuses.set(name, { name, state: 'downloaded', installedPath: 'verified-fixture' })
      return { ok: true }
    },
  }
  await installSearchModels(api, (s) => updates.push(s))
  assert.deepEqual(calls, ['dinov2_vitb14', 'clip_vit_base_patch32'])
  assert.equal(updates.at(-1).state, 'downloaded')
  calls.length = 0
  await installSearchModels(api, () => {})
  assert.deepEqual(calls, [])
})

test('a failed or incomplete model install stops the sequence and cannot report success', async () => {
  for (const result of [{ ok: false, error: 'Connection failed' }, { ok: true }]) {
    const calls = []
    await assert.rejects(
      () =>
        installSearchModels(
          {
            getModelStatus: async (name) => ({ name, state: 'not-installed' }),
            downloadModel: async (name) => {
              calls.push(name)
              return result
            },
          },
          () => {},
        ),
      /Connection failed|verification failed/,
    )
    assert.deepEqual(calls, ['dinov2_vitb14'])
  }
})
