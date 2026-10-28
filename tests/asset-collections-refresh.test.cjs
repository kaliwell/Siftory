const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

// Execute the actual hook with controlled IPC promises. State/ref slots persist
// across renders; effects can be replayed to model StrictMode and unmount.
function fixture() {
  const slots = []
  const requests = []
  const listeners = new Map()
  let cursor = 0
  let effect
  let cleanup
  let writes = 0
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [
        slots[index],
        (value) => {
          writes++
          slots[index] = typeof value === 'function' ? value(slots[index]) : value
        },
      ]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback: (callback) => callback,
    useEffect(callback) {
      effect = callback
    },
  }
  const bridge = {
    electronAPI: {
      assetLibrary: {
        listCollections: () =>
          new Promise((resolve, reject) => {
            requests.push({ resolve, reject })
          }),
      },
    },
    addEventListener(name, callback) {
      listeners.set(name, callback)
    },
    removeEventListener(name, callback) {
      if (listeners.get(name) === callback) listeners.delete(name)
    },
  }
  const file = path.resolve(__dirname, '../src/hooks/useAssetCollections.ts')
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText
  const exports = {}
  vm.runInNewContext(
    code,
    {
      exports,
      window: bridge,
      Error,
      require(name) {
        assert.equal(name, 'react')
        return react
      },
    },
    { filename: file },
  )
  const render = () => {
    cursor = 0
    return exports.useAssetCollections()
  }
  return {
    hook: render(),
    requests,
    render,
    listeners,
    mount() {
      cleanup = effect()
    },
    unmount() {
      cleanup()
    },
    snapshot: () => ({ ids: slots[0].map((item) => item.id), selected: slots[1], error: slots[2] }),
    writes: () => writes,
  }
}

test('a late old list cannot overwrite a new collection or current selection', async () => {
  const f = fixture()
  const old = f.hook.refreshCollections()
  const latest = f.hook.refreshCollections()
  f.requests[1].resolve([{ id: 1 }, { id: 2 }])
  await latest
  f.hook.setCollectionId(2)
  f.requests[0].resolve([{ id: 1 }])
  await old
  assert.deepEqual(f.snapshot(), { ids: [1, 2], selected: 2, error: '' })
})

test('a stale failure is still rejected to its caller but cannot replace current status', async () => {
  const f = fixture()
  const old = f.hook.refreshCollections()
  const failure = assert.rejects(old, /old failure/)
  const latest = f.hook.refreshCollections()
  f.requests[1].resolve([{ id: 2 }])
  await latest
  f.requests[0].reject(new Error('old failure'))
  await failure
  assert.deepEqual(f.snapshot(), { ids: [2], selected: 2, error: '' })
})

test('an old success cannot clear the latest failure; retry recovers and validates selection', async () => {
  const f = fixture()
  const old = f.hook.refreshCollections()
  const latest = f.hook.refreshCollections()
  const failure = assert.rejects(latest, /latest failure/)
  f.requests[1].reject(new Error('latest failure'))
  await failure
  f.requests[0].resolve([{ id: 1 }])
  await old
  assert.equal(f.snapshot().error, 'latest failure')
  const retry = f.hook.refreshCollections()
  f.requests[2].resolve([{ id: 3 }])
  await retry
  assert.deepEqual(f.snapshot(), { ids: [3], selected: 3, error: '' })
  const empty = f.hook.refreshCollections()
  f.requests[3].resolve([])
  await empty
  assert.deepEqual(f.snapshot(), { ids: [], selected: 0, error: '' })
})

test('unmount invalidates pending responses, removes listeners and prevents new requests', async () => {
  const f = fixture()
  f.mount()
  assert.equal(f.listeners.size, 2)
  const pending = f.hook.refreshCollections()
  const rejected = assert.rejects(pending, /late failure/)
  f.unmount()
  const before = f.writes()
  f.requests[0].resolve([{ id: 1 }])
  f.requests[1].reject(new Error('late failure'))
  await rejected
  await f.hook.refreshCollections()
  assert.equal(f.writes(), before)
  assert.equal(f.requests.length, 2)
  assert.equal(f.listeners.size, 0)
})

test('StrictMode effect replay and focus refresh keep ownership across rerenders', async () => {
  const f = fixture()
  f.mount()
  f.unmount()
  f.mount()
  f.requests[1].resolve([{ id: 2 }])
  await new Promise((resolve) => setImmediate(resolve))
  f.render()
  f.listeners.get('focus')()
  f.requests[2].resolve([{ id: 3 }])
  await new Promise((resolve) => setImmediate(resolve))
  f.requests[0].resolve([{ id: 1 }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.snapshot(), { ids: [3], selected: 3, error: '' })
  f.unmount()
})
