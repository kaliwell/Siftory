const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  PRODUCT_PANEL_SPLIT_BREAKPOINTS,
  PRODUCT_PANEL_VIEWPORT_MATRIX,
  PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY,
  PRODUCT_PRIMARY_WORKSPACE_VISIBILITY,
  PRODUCT_SEARCH_MODE_ACTIONS,
  nextRovingIndex,
  productSearchModesHaveParity,
  resolveProductPanelLayout,
  resolveProductWorkspaceVisibilityMigration,
} = loadTsModule('src/services/productInformationArchitecture.ts')

const root = path.resolve(__dirname, '..')

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('simple and advanced search modes expose the same primary journeys', () => {
  const files = {
    image: source('src/components/ImageSearchControls.tsx'),
    video: source('src/components/MediaSearchControls.tsx'),
  }
  for (const surface of ['image', 'video']) {
    assert.equal(productSearchModesHaveParity(surface), true)
    assert.deepEqual(
      PRODUCT_SEARCH_MODE_ACTIONS[surface].advanced,
      PRODUCT_SEARCH_MODE_ACTIONS[surface].simple,
    )
    assert.equal(
      new Set(PRODUCT_SEARCH_MODE_ACTIONS[surface].simple).size,
      PRODUCT_SEARCH_MODE_ACTIONS[surface].simple.length,
    )
    for (const testId of PRODUCT_SEARCH_MODE_ACTIONS[surface].simple) {
      assert.match(files[surface], new RegExp(`data-testid=["']${testId}["']`))
    }
    assert.ok(files[surface].includes(`productSearchCoreActionIds('${surface}'`))
    assert.match(files[surface], /data-experience-mode=\{experienceMode\}/)
  }
})

test('unified search is the sole default search surface and migration preserves custom layouts', () => {
  assert.equal(PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showUnifiedSearch, true)
  assert.equal(PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showImageSearch, false)
  assert.equal(PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showMediaSearch, false)
  assert.equal(PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showAssetLibrary, false)

  const legacy = resolveProductWorkspaceVisibilityMigration(
    PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY,
    1,
    2,
  )
  assert.equal(legacy.migrated, true)
  assert.deepEqual(legacy.visibility, PRODUCT_PRIMARY_WORKSPACE_VISIBILITY)

  const unversionedLegacy = resolveProductWorkspaceVisibilityMigration(
    PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY,
    Number.NaN,
    2,
  )
  assert.equal(unversionedLegacy.migrated, true)
  assert.deepEqual(unversionedLegacy.visibility, PRODUCT_PRIMARY_WORKSPACE_VISIBILITY)

  const customVisibility = {
    ...PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY,
    showMediaSearch: true,
  }
  const custom = resolveProductWorkspaceVisibilityMigration(customVisibility, 1, 2)
  assert.equal(custom.migrated, false)
  assert.deepEqual(custom.visibility, customVisibility)

  const current = resolveProductWorkspaceVisibilityMigration(
    PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY,
    2,
    2,
  )
  assert.equal(current.migrated, false)
  assert.deepEqual(current.visibility, PRODUCT_LEGACY_DEFAULT_WORKSPACE_VISIBILITY)
})

test('roving keyboard navigation wraps and supports every conventional axis key', () => {
  assert.equal(nextRovingIndex(0, 3, 'ArrowRight'), 1)
  assert.equal(nextRovingIndex(2, 3, 'ArrowRight'), 0)
  assert.equal(nextRovingIndex(0, 3, 'ArrowLeft'), 2)
  assert.equal(nextRovingIndex(1, 3, 'ArrowDown'), 2)
  assert.equal(nextRovingIndex(1, 3, 'ArrowUp'), 0)
  assert.equal(nextRovingIndex(2, 3, 'Home'), 0)
  assert.equal(nextRovingIndex(0, 3, 'End'), 2)
  assert.equal(nextRovingIndex(0, 3, 'Enter'), null)
  assert.equal(nextRovingIndex(0, 0, 'ArrowRight'), null)
})

test('the product viewport matrix has compact, stacked, and split coverage without gaps', () => {
  assert.deepEqual(PRODUCT_PANEL_VIEWPORT_MATRIX, [320, 480, 560, 720, 979, 980, 1050, 1440])
  assert.equal(PRODUCT_PANEL_SPLIT_BREAKPOINTS.image, 1050)
  assert.equal(PRODUCT_PANEL_SPLIT_BREAKPOINTS.video, 980)
  assert.equal(resolveProductPanelLayout('image', 320), 'compact')
  assert.equal(resolveProductPanelLayout('image', 560), 'compact')
  assert.equal(resolveProductPanelLayout('image', 1049), 'stacked')
  assert.equal(resolveProductPanelLayout('image', 1050), 'split')
  assert.equal(resolveProductPanelLayout('video', 979), 'stacked')
  assert.equal(resolveProductPanelLayout('video', 980), 'split')
  assert.equal(resolveProductPanelLayout('unified', Number.NaN), 'compact')

  const styles = source('src/styles/window-system.css')
  assert.match(styles, /@container split-tool-panel \(max-width: 560px\)/)
  assert.match(styles, /@container split-tool-panel \(min-width: 980px\)/)
  assert.match(styles, /@container image-search-panel \(max-width: 560px\)/)
  assert.match(styles, /@container image-search-panel \(min-width: 1050px\)/)
  assert.match(styles, /\.split-tool-control-pane[\s\S]*max-height: min\(46%, 440px\)/)
  assert.match(styles, /\.image-search-control-pane[\s\S]*max-height: min\(48%, 460px\)/)
  assert.match(styles, /writing-mode: horizontal-tb/)
})

test('all three search surfaces provide explicit actionable empty states', () => {
  const emptyState = source('src/components/SearchEmptyState.tsx')
  assert.match(emptyState, /role="status"/)
  assert.match(emptyState, /aria-live="polite"/)
  for (const [file, testId] of [
    ['src/components/ImageSearchResultGrid.tsx', 'image-search-empty-state'],
    ['src/components/MediaSearchResultsView.tsx', 'media-search-empty-state'],
    ['src/components/UnifiedSearchPanel.tsx', 'unified-search-empty-state'],
  ]) {
    const panel = source(file)
    assert.match(panel, /<SearchEmptyState/)
    assert.match(panel, new RegExp(`testId=["']${testId}["']`))
    assert.match(panel, /description=/)
  }
})

test('mode switcher and quick navigation are keyboard reachable with visible focus', () => {
  const modeBar = source('src/components/SearchExperienceModeBar.tsx')
  const navigator = source('src/components/WorkspaceNavigator.tsx')
  const windowStyles = source('src/styles/window-system.css')
  const navigatorStyles = source('src/styles/focused-workspace.css')
  const smoke = source('electron/uiSmokeService.ts')

  assert.match(modeBar, /role="radiogroup"/)
  assert.match(modeBar, /role="radio"/)
  assert.match(modeBar, /aria-checked=\{mode === value\}/)
  assert.match(modeBar, /tabIndex=\{mode === value \? 0 : -1\}/)
  assert.match(modeBar, /nextRovingIndex/)
  assert.match(
    modeBar,
    /requestAnimationFrame\(\(\) => buttonRefs\.current\[nextIndex\]\?\.focus\(\)\)/,
  )

  assert.match(navigator, /nextRovingIndex/)
  assert.match(navigator, /refs.current\[next\]\?\.focus/)
  assert.match(navigator, /event.key === 'Escape'/)
  assert.match(navigator, /aria-current=/)
  assert.match(navigator, /aria-controls=/)
  assert.match(navigator, /aria-expanded=/)
  assert.doesNotMatch(navigator, /moveNavigatorWithKeyboard|advancedSearchOpen/)
  assert.match(windowStyles, /button:focus-visible/)
  assert.match(navigatorStyles, /button:focus-visible/)
  assert.match(navigatorStyles, /@media \(max-width: 760px\)/)
  for (const evidence of [
    'coreActionParity',
    'keyboardReachable',
    'responsiveLayout',
    'sectionedControls',
    'collapsibleControls',
    'viewportStable',
  ]) {
    assert.match(smoke, new RegExp(evidence))
  }
})

test('result layouts group metadata and actions instead of compressing labels vertically', () => {
  const media = source('src/components/MediaSearchResultsView.tsx')
  const unified = source('src/components/UnifiedSearchPanel.tsx')
  const styles = source('src/styles/window-system.css')
  assert.match(media, /className="media-search-video-row"/)
  assert.match(media, /className="media-search-video-row__info"/)
  assert.match(media, /className="media-search-video-row__actions"/)
  assert.match(unified, /className="unified-search-result-heading"/)
  assert.match(unified, /className="unified-search-result-actions"/)
  assert.match(styles, /grid-template-areas:[\s\S]*'thumbnail info'[\s\S]*'actions actions'/)
  assert.match(styles, /\.media-search-video-row__actions[\s\S]*grid-template-columns: repeat\(4/)
})
