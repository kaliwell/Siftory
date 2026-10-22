const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { buildWorkspaceTopology, normalizeDisplayScope } = loadTsModule(
  'electron/workspaceDisplay.ts',
)
const { restoreFocusedDisplayScope, FOCUSED_DISPLAY_SCOPE_VERSION } = loadTsModule(
  'shared/workspaceDisplayPolicy.ts',
)
const { clampPanelToWorkspace, findPanelWorkArea, findWorkspaceAreaAtPoint } = loadTsModule(
  'src/services/workspaceGeometry.ts',
)

const displays = [
  {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1,
    rotation: 0,
    internal: true,
  },
  {
    id: 2,
    bounds: { x: -2560, y: -400, width: 2560, height: 1440 },
    workArea: { x: -2560, y: -360, width: 2560, height: 1400 },
    scaleFactor: 1.5,
    rotation: 90,
  },
]

test('workspace topology preserves negative coordinates and mixed-DPI display metadata', () => {
  const topology = buildWorkspaceTopology(displays, 1, { mode: 'all' })
  assert.deepEqual(topology.bounds, { x: -2560, y: -360, width: 4480, height: 1400 })
  assert.equal(topology.displays[0].primary, true)
  assert.equal(topology.displays[1].scaleFactor, 1.5)
  assert.equal(topology.displays[1].rotation, 90)
  assert.deepEqual(topology.workArea.displays[0].localWorkArea, {
    x: 2560,
    y: 360,
    width: 1920,
    height: 1040,
  })
  assert.deepEqual(topology.workArea.displays[1].localWorkArea, {
    x: 0,
    y: 0,
    width: 2560,
    height: 1400,
  })
})

test('missing selected display safely falls back to primary after hot unplug', () => {
  const topology = buildWorkspaceTopology([displays[0]], 1, {
    mode: 'display',
    displayId: '2',
  })
  assert.deepEqual(topology.scope, { mode: 'primary' })
  assert.deepEqual(topology.bounds, displays[0].workArea)
})

test('display scope parser rejects untrusted shapes and accepts explicit modes', () => {
  assert.deepEqual(normalizeDisplayScope(null), { mode: 'primary' })
  assert.deepEqual(normalizeDisplayScope({ mode: 'display', displayId: '' }), { mode: 'primary' })
  assert.deepEqual(normalizeDisplayScope({ mode: 'unknown' }), { mode: 'primary' })
  assert.deepEqual(normalizeDisplayScope({ mode: 'all' }), { mode: 'all' })
  assert.deepEqual(normalizeDisplayScope({ mode: 'primary' }), { mode: 'primary' })
  assert.deepEqual(normalizeDisplayScope({ mode: 'display', displayId: '2' }), {
    mode: 'display',
    displayId: '2',
  })
})

test('fresh and legacy overlay profiles use one primary work area', () => {
  for (const settings of [{}, { displayScope: { mode: 'all' } }, { displayScope: null }]) {
    const scope = restoreFocusedDisplayScope(settings)
    const topology = buildWorkspaceTopology(displays, 1, scope)
    assert.deepEqual(topology.scope, { mode: 'primary' })
    assert.deepEqual(topology.bounds, displays[0].workArea)
    assert.equal(topology.workArea.displays.length, 1)
  }
})

test('a selected monitor survives migration and handles negative coordinates', () => {
  const scope = restoreFocusedDisplayScope({ displayScope: { mode: 'display', displayId: '2' } })
  const topology = buildWorkspaceTopology(displays, 1, scope)
  assert.deepEqual(topology.bounds, displays[1].workArea)
  assert.equal(topology.workArea.displays.length, 1)
})

test('conventional windows restore old all-displays profiles onto one screen', () => {
  const saved = {
    displayScope: { mode: 'all' },
    focusedDisplayScopeVersion: FOCUSED_DISPLAY_SCOPE_VERSION,
  }
  assert.deepEqual(restoreFocusedDisplayScope(JSON.parse(JSON.stringify(saved))), {
    mode: 'primary',
  })
  for (const version of [undefined, null, 0, NaN, Infinity, '1']) {
    assert.deepEqual(
      restoreFocusedDisplayScope({ ...saved, focusedDisplayScopeVersion: version }),
      { mode: 'primary' },
    )
  }
})

test('panel movement crosses displays but cannot settle in virtual-desktop gaps', () => {
  const workArea = buildWorkspaceTopology(displays, 1, { mode: 'all' }).workArea
  assert.deepEqual(clampPanelToWorkspace(workArea, 200, 100, 300, 200), { x: 200, y: 100 })
  assert.deepEqual(clampPanelToWorkspace(workArea, 4000, 1200, 600, 400), {
    x: 3880,
    y: 1000,
  })
  assert.equal(findPanelWorkArea(workArea, 2700, 0, 300, 200).x, 2560)
})

test('drag target follows the pointer before the panel center crosses a display edge', () => {
  const workArea = buildWorkspaceTopology(displays, 1, { mode: 'all' }).workArea
  assert.equal(findWorkspaceAreaAtPoint(workArea, 2550, 500).x, 0)
  assert.deepEqual(clampPanelToWorkspace(workArea, 2500, 400, 600, 400, { x: 2550, y: 500 }), {
    x: 1960,
    y: 400,
  })
})
