const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { PreparationInputSpool } = loadTsModule('electron/preparationInputSpool.ts')

test('preparation spool deduplicates paths and removes only acknowledged windows', () => {
  const spool = new PreparationInputSpool()
  const filePath = spool.filePath
  try {
    assert.deepEqual(spool.add(['C:\\images\\a.jpg', 'C:\\images\\a.jpg', 'C:\\images\\b.jpg']), [
      'C:\\images\\a.jpg',
      'C:\\images\\b.jpg',
    ])
    assert.equal(spool.count(), 2)
    const first = spool.peek(1)
    assert.deepEqual(first.paths, ['C:\\images\\a.jpg'])
    assert.equal(spool.count(), 2)
    spool.acknowledge(first.ids)
    assert.deepEqual(spool.peek(2).paths, ['C:\\images\\b.jpg'])
  } finally {
    spool.dispose()
    assert.equal(fs.existsSync(filePath), false)
  }
})

test('preparation spool keeps parent windows bounded at 256 records', () => {
  const spool = new PreparationInputSpool()
  try {
    const paths = Array.from({ length: 20_000 }, (_, index) => `D:\\dataset\\${index}.jpg`)
    assert.equal(spool.add(paths).length, paths.length)
    assert.equal(spool.count(), paths.length)
    const window = spool.peek(1000)
    assert.equal(window.paths.length, 256)
    spool.acknowledge(window.ids)
    assert.equal(spool.count(), paths.length - 256)
  } finally {
    spool.dispose()
  }
})
