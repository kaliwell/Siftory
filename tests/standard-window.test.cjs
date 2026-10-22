const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')
const { standardWindowBounds } = loadTsModule('electron/standardWindowGeometry.ts')

test('normal window starts centered and leaves desktop visible', () => {
  assert.deepEqual(standardWindowBounds({ x: 0, y: 0, width: 2560, height: 1392 }), {
    x: 620,
    y: 266,
    width: 1320,
    height: 860,
  })
})
test('restore clamps a window to the selected monitor including negative coordinates', () => {
  const area = { x: -1920, y: -200, width: 1920, height: 1040 }
  const fitted = standardWindowBounds(area, { x: 5000, y: -500, width: 1100, height: 720 })
  assert.deepEqual(fitted, { x: -1100, y: -200, width: 1100, height: 720 })
})
test('a disconnected or smaller display cannot leave the window off screen', () => {
  const area = { x: 0, y: 0, width: 800, height: 600 }
  const fitted = standardWindowBounds(area, { x: -2000, y: 1000, width: 1320, height: 860 })
  assert.ok(
    fitted.x >= area.x &&
      fitted.y >= area.y &&
      fitted.x + fitted.width <= 800 &&
      fitted.y + fitted.height <= 600,
  )
})
