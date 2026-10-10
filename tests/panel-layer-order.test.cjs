const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { bringPanelLayerToFront, sendPanelLayerToBack, setPanelLayerPinned } = loadTsModule(
  'src/components/panelLayerOrder.ts',
)

function fixture() {
  const zIndices = new Map()
  const ids = {
    normalA: Symbol('normal-a'),
    normalB: Symbol('normal-b'),
    pinnedA: Symbol('pinned-a'),
    pinnedB: Symbol('pinned-b'),
  }
  const entries = [
    { id: ids.normalA, pinned: false, setZ: (z) => zIndices.set(ids.normalA, z) },
    { id: ids.normalB, pinned: false, setZ: (z) => zIndices.set(ids.normalB, z) },
    { id: ids.pinnedA, pinned: true, setZ: (z) => zIndices.set(ids.pinnedA, z) },
    { id: ids.pinnedB, pinned: true, setZ: (z) => zIndices.set(ids.pinnedB, z) },
  ]
  return { entries, ids, zIndices }
}

function names(entries) {
  return entries.map((entry) => entry.id.description)
}

test('bringing a normal panel forward keeps it below every pinned panel', () => {
  const { entries, ids, zIndices } = fixture()

  bringPanelLayerToFront(entries, ids.normalA)

  assert.deepEqual(names(entries), ['normal-b', 'normal-a', 'pinned-a', 'pinned-b'])
  assert.ok(zIndices.get(ids.normalA) < zIndices.get(ids.pinnedA))
})

test('pinning and unpinning moves a panel to the front of its new group', () => {
  const { entries, ids } = fixture()

  setPanelLayerPinned(entries, ids.normalA, true)
  assert.deepEqual(names(entries), ['normal-b', 'pinned-a', 'pinned-b', 'normal-a'])

  setPanelLayerPinned(entries, ids.normalA, false)
  assert.deepEqual(names(entries), ['normal-b', 'normal-a', 'pinned-a', 'pinned-b'])
})

test('sending panels backward only changes order within their own group', () => {
  const { entries, ids } = fixture()

  sendPanelLayerToBack(entries, ids.pinnedB)
  assert.deepEqual(names(entries), ['normal-a', 'normal-b', 'pinned-b', 'pinned-a'])

  sendPanelLayerToBack(entries, ids.normalB)
  assert.deepEqual(names(entries), ['normal-b', 'normal-a', 'pinned-b', 'pinned-a'])
})
