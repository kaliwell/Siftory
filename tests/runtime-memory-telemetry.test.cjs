const assert = require('node:assert/strict')
const os = require('node:os')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const electronModulePath = require.resolve('electron')
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: { app: { isPackaged: false, getPath: () => os.tmpdir() } },
}
const { captureRuntimeMemoryTelemetry, registerRuntimeCacheBudgetProvider } = loadTsModule(
  'electron/runtimeMemoryTelemetry.ts',
)
const { canCacheFrameIndexMemory, estimateFrameIndexCacheMemory } = loadTsModule(
  'electron/mediaSearchFrameIndex.ts',
)

test('runtime telemetry separates V8, ANN, renderer, and bounded cache budgets', async () => {
  const calls = []
  let attached = false
  const target = {
    id: 7,
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach(version) {
        calls.push(['attach', version])
        attached = true
      },
      detach() {
        calls.push(['detach'])
        attached = false
      },
      async sendCommand(method) {
        calls.push(['command', method])
        if (method === 'Runtime.getHeapUsage') {
          return {
            usedSize: 100,
            totalSize: 200,
            embedderHeapUsedSize: 30,
            backingStorageSize: 40,
          }
        }
        return { documents: 2, nodes: 300, jsEventListeners: 12 }
      },
    },
  }
  const dispose = registerRuntimeCacheBudgetProvider('thumbnail-lru', () => ({
    entries: 5,
    activeEntries: 1,
    ownedBytesApprox: 1024,
    budgetBytes: 2048,
  }))
  try {
    const snapshot = await captureRuntimeMemoryTelemetry([target])
    assert.equal(snapshot.schema, 'siftory-runtime-memory-telemetry/v1')
    assert.ok(snapshot.main.heapUsedBytes > 0)
    assert.ok(snapshot.main.externalBytes >= snapshot.main.arrayBuffersBytes)
    assert.equal(snapshot.renderers[0].heapUsedBytes, 100)
    assert.equal(snapshot.renderers[0].nodes, 300)
    assert.equal(snapshot.renderers[0].jsEventListeners, 12)
    assert.deepEqual(snapshot.cacheBudgets['thumbnail-lru'], {
      entries: 5,
      activeEntries: 1,
      ownedBytesApprox: 1024,
      budgetBytes: 2048,
    })
    assert.deepEqual(snapshot.cacheBudgets['media-search-data-url'], {
      entries: 0,
      ownedBytesApprox: 0,
      budgetBytes: 128 * 1024 * 1024,
    })
    assert.deepEqual(snapshot.cacheBudgets['media-frame-index'], {
      entries: 0,
      ownedBytesApprox: 0,
      budgetBytes: 256 * 1024 * 1024,
    })
    assert.deepEqual(snapshot.cacheBudgets['user-model-runtime'], {
      entries: 0,
      activeEntries: 0,
      ownedBytesApprox: 0,
      budgetBytes: 512 * 1024 * 1024,
    })
    assert.equal(snapshot.ann.workerResident, false)
    assert.deepEqual(calls, [
      ['attach', '1.3'],
      ['command', 'Runtime.getHeapUsage'],
      ['command', 'Memory.getDOMCounters'],
      ['detach'],
    ])
  } finally {
    dispose()
  }
})

test('frame index budget includes paths, Map/object overhead, and ArrayBuffer ownership', () => {
  const backing = new ArrayBuffer(128)
  const index = new Map([['D:\\素材\\帧-01.jpg', new Float32Array(backing, 0, 4)]])
  const memory = estimateFrameIndexCacheMemory(index, 'signature')
  assert.equal(memory.entries, 1)
  assert.equal(memory.vectorBytes, 16)
  assert.equal(memory.arrayBufferOwnedBytes, 128)
  assert.ok(memory.pathUtf8Bytes > 'D:\\素材\\帧-01.jpg'.length)
  assert.ok(memory.totalOwnedBytesApprox > memory.arrayBufferOwnedBytes)
  assert.equal(canCacheFrameIndexMemory(memory), true)
  assert.equal(
    canCacheFrameIndexMemory({
      ...memory,
      totalOwnedBytesApprox: memory.budgetBytes + 1,
    }),
    false,
  )
})

test('runtime telemetry reports destroyed and unavailable renderers without path-bearing errors', async () => {
  const destroyed = {
    id: 1,
    isDestroyed: () => true,
    debugger: {},
  }
  let attached = false
  const unavailable = {
    id: 2,
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach() {
        attached = true
      },
      detach() {
        attached = false
      },
      async sendCommand() {
        const error = new Error('C:\\Users\\private\\secret')
        error.name = 'ProtocolError'
        throw error
      },
    },
  }
  const snapshot = await captureRuntimeMemoryTelemetry([destroyed, unavailable])
  assert.equal(snapshot.renderers[0].status, 'destroyed')
  assert.deepEqual(snapshot.renderers[1], {
    id: 2,
    status: 'unavailable',
    errorType: 'ProtocolError',
  })
  assert.doesNotMatch(JSON.stringify(snapshot), /Users|secret/)
})

test('runtime cache budget providers are named, bounded, validated, and disposable', async () => {
  assert.throws(
    () =>
      registerRuntimeCacheBudgetProvider('../private', () => ({
        entries: 0,
        ownedBytesApprox: 0,
        budgetBytes: 0,
      })),
    /name is invalid/,
  )
  const dispose = registerRuntimeCacheBudgetProvider('invalid-budget', () => ({
    entries: -1,
    ownedBytesApprox: 0,
    budgetBytes: 0,
  }))
  await assert.rejects(captureRuntimeMemoryTelemetry(), /cache budget snapshot is invalid/)
  dispose()
  const snapshot = await captureRuntimeMemoryTelemetry()
  assert.equal(snapshot.cacheBudgets['invalid-budget'], undefined)
})
