const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTsModule } = require('./guard-utils.cjs')
const { focusedWorkspaceVisibility, RETIRED_PANELS } = loadTsModule(
  'src/services/focusedWorkspace.ts',
)
const { PANEL_IDENTITIES } = loadTsModule('shared/ipc/app-core.ts')
const visible = (state) => Object.keys(state).filter((key) => state[key])

test('old multi-panel profiles start with one search view and retire tools', () => {
  const old = Object.fromEntries(
    Object.values(PANEL_IDENTITIES).map(({ visibilityKey }) => [visibilityKey, true]),
  )
  const next = focusedWorkspaceVisibility(old)
  assert.deepEqual(visible(next), ['showUnifiedSearch'])
  for (const id of RETIRED_PANELS) assert.equal(next[PANEL_IDENTITIES[id].visibilityKey], false)
})
test('opening settings replaces the foreground without modifying unrelated saved data', () => {
  const previous = { ...focusedWorkspaceVisibility({}), manifestPath: 'fixture-index.json' }
  const next = focusedWorkspaceVisibility({ ...previous, showSettings: true }, previous)
  assert.deepEqual(visible(next), ['showSettings'])
  assert.equal(previous.manifestPath, 'fixture-index.json')
})
test('an obsolete IPC show-all or tool toggle cannot reopen retired views', () => {
  const previous = focusedWorkspaceVisibility({ showUnifiedSearch: true })
  for (const id of RETIRED_PANELS) {
    const next = focusedWorkspaceVisibility(
      { ...previous, [PANEL_IDENTITIES[id].visibilityKey]: true },
      previous,
    )
    assert.deepEqual(visible(next), ['showUnifiedSearch'])
  }
})
test('global hide stays completely hidden; restore keeps the saved content view', () => {
  const previous = focusedWorkspaceVisibility({ showMediaSearch: true })
  const hidden = focusedWorkspaceVisibility({ ...previous, globalVisible: false }, previous)
  assert.deepEqual(visible(hidden), [])
  const restored = focusedWorkspaceVisibility(
    { ...hidden, showMediaSearch: true, globalVisible: true },
    hidden,
  )
  assert.deepEqual(visible(restored), ['showMediaSearch'])
})
test('closing the last foreground view returns to search instead of a blank workspace', () => {
  const previous = focusedWorkspaceVisibility({ showSettings: true })
  assert.deepEqual(
    visible(focusedWorkspaceVisibility({ ...previous, showSettings: false }, previous)),
    ['showUnifiedSearch'],
  )
})
test('normalizing an already focused view is stable', () => {
  for (const key of [
    'showAssetLibrary',
    'showImageSearch',
    'showMediaSearch',
    'showAppStorage',
    'showDuplicateFinder',
  ]) {
    const state = focusedWorkspaceVisibility({ [key]: true })
    assert.deepEqual(focusedWorkspaceVisibility(state, state), state)
  }
})

test('global hide honors a visible locked content view, matching the native visibility controller', () => {
  const current = { showSettings: true, globalVisible: false, lockedVisibility: { settings: true } }
  assert.deepEqual(visible(focusedWorkspaceVisibility(current)), ['showSettings'])
  assert.deepEqual(
    visible(
      focusedWorkspaceVisibility({
        globalVisible: false,
        lockedVisibility: { unifiedSearch: true },
      }),
    ),
    [],
  )
})
