const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')
const { normalizeGlobalHotkey, validateVisibilityHotkey } = loadTsModule('shared/globalHotkey.ts')

test('hotkey normalization detects equivalent modifier orders and aliases', () => {
  assert.equal(normalizeGlobalHotkey('alt+q+CTRL+shift'), 'CommandOrControl+Shift+Alt+Q')
  assert.equal(normalizeGlobalHotkey('Shift+Control+F12'), 'CommandOrControl+Shift+F12')
  assert.equal(normalizeGlobalHotkey('win+space'), 'Super+Space')
})
test('hotkey normalization rejects incomplete, duplicate and ambiguous chords', () => {
  for (const value of [
    null,
    {},
    '',
    'Q',
    'Ctrl',
    'Ctrl+Control+Q',
    'Ctrl+Q+R',
    'Ctrl++Q',
    'Alt+F25',
  ])
    assert.equal(normalizeGlobalHotkey(value), null)
})

test('save and startup share internal conflict validation including key aliases', () => {
  assert.equal(
    validateVisibilityHotkey('Control+shift+q', ['Shift+Ctrl+Q']).error,
    'Shortcut conflicts',
  )
  assert.equal(validateVisibilityHotkey('bad', []).error, 'Invalid shortcut')
  assert.equal(validateVisibilityHotkey('Ctrl+Tab', []).accelerator, 'CommandOrControl+Tab')
})
