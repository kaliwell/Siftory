const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const identity = loadTsModule('electron/startupSecurity.ts')

test('public product identity uses the approved bilingual brand', () => {
  assert.equal(identity.PRODUCT_NAME, 'Siftory')
  assert.equal(identity.PRODUCT_NAME_ZH_CN, '寻藏')
  assert.equal(identity.PRODUCT_DISPLAY_NAME, 'Siftory · 寻藏')
})

test('renamed builds preserve the established user data directory', () => {
  assert.equal(identity.LEGACY_USER_DATA_DIRECTORY, 'floating-clock-electron')
  assert.equal(
    identity.resolveStableUserDataPath('C:\\Users\\fixture\\AppData\\Roaming'),
    path.join('C:\\Users\\fixture\\AppData\\Roaming', 'floating-clock-electron'),
  )
})
