const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { CompactPathTable } = loadTsModule('electron/compactPathTable.ts')

test('compact path table preserves Unicode, missing rows, and append row identity', () => {
  const paths = ['C:\\素材\\猫.png', undefined, 'D:\\产品\\A.JPG']
  const table = new CompactPathTable(paths)
  table.append(['\\\\nas\\共享\\视频.mp4'])
  assert.equal(table.count, 4)
  assert.equal(table.get(0), paths[0])
  assert.equal(table.get(1), undefined)
  assert.equal(table.get(2), paths[2])
  assert.equal(table.get(3), '\\\\nas\\共享\\视频.mp4')
  assert.equal(table.get(4), undefined)
  assert.equal(table.segmentCount, 2)
})

test('compact path ownership excludes per-row JS string slots', () => {
  const paths = Array.from({ length: 10_000 }, (_, index) => `C:\\素材\\${index}.jpg`)
  const table = new CompactPathTable(paths)
  const stats = table.stats()
  assert.equal(stats.rows, paths.length)
  assert.equal(stats.offsetBytes, (paths.length + 1) * Uint32Array.BYTES_PER_ELEMENT)
  assert.equal(stats.presenceBytes, paths.length)
  assert.ok(stats.ownedBytes < paths.reduce((sum, value) => sum + value.length * 2 + 8, 0))
})
