const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { buildWorkspaceTopology } = loadTsModule('electron/workspaceDisplay.ts')
const { clampPanelToWorkspace } = loadTsModule('src/services/workspaceGeometry.ts')
const smoke = fs.readFileSync(path.join(__dirname, '../electron/uiSmokeService.ts'), 'utf8')
// Execute the actual renderer-side fixture planner without booting Electron.
// Keeping the extraction bounded also checks that planning precedes mouse down.
const start = smoke.indexOf('const dragAreas =')
const end = smoke.indexOf('moveHandle.dispatchEvent(', start)
assert.ok(start > 0 && end > start)
const plan = new Function(
  'dragWorkArea',
  'startX',
  'startY',
  'beforeDragRect',
  `${smoke.slice(start, end)}; return { dragArea, targetLeft, targetTop, dragDeltaX, dragDeltaY };`,
)

function verifyDestination(workArea, before, pointer) {
  const result = plan(workArea, pointer.x, pointer.y, before)
  assert.deepEqual(
    clampPanelToWorkspace(
      workArea,
      result.targetLeft,
      result.targetTop,
      before.width,
      before.height,
      {
        x: pointer.x + result.dragDeltaX,
        y: pointer.y + result.dragDeltaY,
      },
    ),
    { x: before.left + result.dragDeltaX, y: before.top + result.dragDeltaY },
  )
  assert.ok(result.targetLeft >= result.dragArea.x + 8)
  assert.ok(result.targetTop >= result.dragArea.y + 8)
  assert.ok(result.targetLeft + before.width <= result.dragArea.x + result.dragArea.width - 8)
  assert.ok(result.targetTop + before.height <= result.dragArea.y + result.dragArea.height - 8)
  return result
}

test('compositor fixture handles the observed three-display negative-y topology without relaxing y', () => {
  const displays = [
    { id: 1, workArea: { x: 0, y: 0, width: 2560, height: 1392 } },
    { id: 2, workArea: { x: -1920, y: -61, width: 1920, height: 1032 } },
    { id: 3, workArea: { x: 0, y: 1440, width: 1920, height: 1032 } },
  ].map((display) => ({ ...display, bounds: display.workArea, scaleFactor: 1, rotation: 0 }))
  const workArea = buildWorkspaceTopology(displays, 1, { mode: 'all' }).workArea
  const before = { left: 1874, top: 8, width: 732, height: 249.390625 }
  const pointer = { x: 2578, y: 24 }
  assert.equal(
    clampPanelToWorkspace(workArea, 1970, 28, before.width, before.height, {
      x: pointer.x + 96,
      y: pointer.y + 20,
    }).y,
    61,
  )
  const result = verifyDestination(workArea, before, pointer)
  assert.equal(result.dragDeltaX, 96)
  assert.equal(result.dragDeltaY, 61)
  assert.equal(result.targetTop, 69)
  assert.match(
    smoke,
    /Math\.abs\(afterDragRect\.top - \(beforeDragRect\.top \+ dragDeltaY\)\) <= 2/,
  )
})

test('compositor fixture preserves ordinary movement in a single-display viewport', () => {
  const result = verifyDestination(
    { width: 1280, height: 720, displays: [] },
    { left: 274, top: 8, width: 732, height: 249 },
    { x: 980, y: 24 },
  )
  assert.equal(result.dragDeltaX, 96)
  assert.equal(result.dragDeltaY, 20)
})

test('compositor fixture chooses a reachable destination near the bottom and right edges', () => {
  const result = verifyDestination(
    { width: 1280, height: 720, displays: [] },
    { left: 548, top: 470, width: 732, height: 249 },
    { x: 1250, y: 486 },
  )
  assert.equal(result.dragDeltaX, -8)
  assert.equal(result.dragDeltaY, -7)
})
