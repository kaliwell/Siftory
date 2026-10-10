const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('search and analysis panels share a responsive control rail', () => {
  for (const [file, panelClass] of [
    ['src/components/MediaSearchPanel.tsx', 'media-search'],
    ['src/components/UnifiedSearchPanel.tsx', 'unified-search'],
    ['src/components/DuplicateFinderPanel.tsx', 'duplicate-finder'],
  ]) {
    const panel = source(file)
    assert.match(panel, new RegExp(`split-tool-shell ${panelClass}-shell`))
    assert.match(panel, new RegExp(`split-tool-workspace ${panelClass}-workspace`))
    assert.match(panel, new RegExp(`split-tool-control-pane ${panelClass}-control-pane`))
    assert.match(panel, new RegExp(`split-tool-results-pane ${panelClass}-results-pane`))
  }

  const styles = source('src/styles/window-system.css')
  assert.match(styles, /@container split-tool-panel \(min-width: 980px\)/)
  assert.match(styles, /grid-template-columns: var\(--split-tool-control-width/)
  assert.match(styles, /\.split-tool-control-pane[\s\S]*overflow-y: auto/)
  assert.match(styles, /\.split-tool-results-pane[\s\S]*overflow: hidden/)
  assert.match(styles, /\.media-search-source-controls > input[\s\S]*flex-basis: 100% !important/)
  assert.match(styles, /\.duplicate-finder-directory-row[\s\S]*flex-wrap: wrap/)
})

test('asset library controls resist vertical text compression', () => {
  const panel = source('src/components/AssetLibraryPanel.tsx')
  assert.match(panel, /className="asset-library-shell"/)

  const styles = source('src/styles/window-system.css')
  assert.match(styles, /\.asset-library-shell button,[\s\S]*white-space: nowrap/)
  assert.match(styles, /\.asset-library-shell input,[\s\S]*min-width: 0/)
})

test('video search renders its real controls without an artificial idle loading shell', () => {
  const panel = source('src/components/MediaSearchPanel.tsx')
  assert.match(panel, /return <MediaSearchPanelInner \/>/)
  assert.doesNotMatch(panel, /MediaSearchPanelShell/)
  assert.doesNotMatch(panel, /mounting full panel after/)
})
