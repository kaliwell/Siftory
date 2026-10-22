const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')
const { requestWorkspaceNavigation, registerWorkspacePanel } = loadTsModule(
  'src/services/workspaceNavigation.ts',
)

test('lazy route events wait for actual mount, and superseded/hidden routes never dispatch', () => {
  const events = []
  const frames = new Map()
  let id = 0
  const original = {
    window: global.window,
    raf: global.requestAnimationFrame,
    caf: global.cancelAnimationFrame,
  }
  global.window = { dispatchEvent: (event) => events.push(event.type) }
  global.requestAnimationFrame = (callback) => {
    frames.set(++id, callback)
    return id
  }
  global.cancelAnimationFrame = (key) => frames.delete(key)
  const flush = () => {
    while (frames.size) {
      const work = [...frames]
      frames.clear()
      for (const [, fn] of work) fn()
    }
  }
  let dispose
  try {
    requestWorkspaceNavigation('imageSearch', 'sources-ready', () => true)
    flush()
    assert.deepEqual(events, [], 'two elapsed frames alone cannot prove a lazy panel is ready')
    dispose = registerWorkspacePanel('imageSearch')
    flush()
    assert.deepEqual(events, ['sources-ready'])
    requestWorkspaceNavigation('settings', 'obsolete', () => true)
    requestWorkspaceNavigation('imageSearch', 'newer', () => true)
    const unregisterSettings = registerWorkspacePanel('settings')
    flush()
    assert.deepEqual(events, ['sources-ready', 'newer'])
    unregisterSettings()
    requestWorkspaceNavigation('imageSearch', 'hidden', () => false)
    flush()
    assert.equal(events.includes('hidden'), false)
    requestWorkspaceNavigation('imageSearch', 'cancelled', () => true)
    requestWorkspaceNavigation('unifiedSearch', undefined, () => true)
    flush()
    assert.equal(events.includes('cancelled'), false)
    requestWorkspaceNavigation('imageSearch', 'unmounted', () => true)
    dispose()
    dispose = undefined
    flush()
    assert.equal(events.includes('unmounted'), false)
  } finally {
    dispose?.()
    requestWorkspaceNavigation('unifiedSearch', undefined, () => false)
    global.window = original.window
    global.requestAnimationFrame = original.raf
    global.cancelAnimationFrame = original.caf
  }
})
