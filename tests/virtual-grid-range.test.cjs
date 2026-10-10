const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { computeVirtualGridRange } = loadTsModule('src/hooks/useVirtualGrid.ts')

test('empty startup grids skip forced workspace geometry measurement', () => {
  const source = fs.readFileSync('src/hooks/useVirtualGrid.ts', 'utf8')
  const emptyGuard = source.indexOf('if (itemCount <= 0)')
  const firstGeometryRead = source.indexOf('getBoundingClientRect()', emptyGuard)
  assert.ok(emptyGuard > 0)
  assert.ok(firstGeometryRead > emptyGuard)
  assert.match(source, /if \(itemCount <= 0\) return[\s\S]*scrollTop !== 0/)
})

test('virtual grid keeps a 1000-result fast-scroll window bounded', () => {
  const common = {
    clientHeight: 720,
    columns: 4,
    gap: 8,
    itemCount: 1000,
    overscanRows: 1,
    rowHeight: 226,
  }
  for (let scrollTop = 0; scrollTop < 60_000; scrollTop += 137) {
    const range = computeVirtualGridRange({ ...common, scrollTop })
    assert.ok(range.startIndex >= 0)
    assert.ok(range.endIndex <= 1000)
    assert.ok(range.endIndex - range.startIndex <= 28)
    assert.equal(range.startIndex % common.columns, 0)
  }
})

test('virtual grid restores idle overscan without changing total geometry', () => {
  const fast = computeVirtualGridRange({
    clientHeight: 720,
    columns: 4,
    gap: 8,
    itemCount: 1000,
    overscanRows: 1,
    rowHeight: 226,
    scrollTop: 20_000,
  })
  const idle = computeVirtualGridRange({
    clientHeight: 720,
    columns: 4,
    gap: 8,
    itemCount: 1000,
    overscanRows: 3,
    rowHeight: 226,
    scrollTop: 20_000,
  })
  assert.equal(fast.totalHeight, idle.totalHeight)
  assert.ok(idle.startIndex <= fast.startIndex)
  assert.ok(idle.endIndex >= fast.endIndex)
})
