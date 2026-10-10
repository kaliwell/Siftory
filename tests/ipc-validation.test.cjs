const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  normalizeClipboardText,
  normalizeDuplicateScanOptions,
  normalizeFolderPath,
  normalizeLargestOptions,
  normalizePersistedObject,
  normalizeTransparency,
} = loadTsModule('electron/ipcValidation.ts')

test('IPC validation clamps transparency and rejects non-finite values', () => {
  assert.equal(normalizeTransparency(80), 60)
  assert.equal(normalizeTransparency(-5), 0)
  assert.equal(normalizeTransparency('20'), 20)
  assert.equal(normalizeTransparency(Number.NaN), null)
})

test('IPC validation rejects invalid paths and oversized clipboard payloads', () => {
  assert.equal(normalizeFolderPath(''), null)
  assert.equal(normalizeFolderPath('bad\0path'), null)
  assert.equal(normalizeClipboardText('ok'), 'ok')
  assert.equal(normalizeClipboardText('x'.repeat(1_000_001)), null)
})

test('IPC validation sanitizes persisted JSON objects', () => {
  assert.deepEqual(normalizePersistedObject({ showClock: true }, 'settings'), {
    showClock: true,
  })
  assert.equal(normalizePersistedObject([], 'settings'), null)
  assert.equal(normalizePersistedObject({ value: BigInt(1) }, 'settings'), null)
})

test('IPC validation bounds Duplicate Finder options', () => {
  assert.deepEqual(normalizeDuplicateScanOptions({ dirPath: 'C:\\Data', minSize: 12.8 }), {
    dirPath: 'C:\\Data',
    minSize: 12,
  })
  assert.equal(normalizeDuplicateScanOptions({ dirPath: 'C:\\Data', minSize: Infinity }), null)
  assert.deepEqual(normalizeLargestOptions({ dirPath: 'D:\\', topN: 100 }), {
    dirPath: 'D:\\',
    topN: 100,
  })
  assert.equal(normalizeLargestOptions({ dirPath: 'D:\\', topN: 501 }), null)
})
