const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const root = path.join(__dirname, '..')

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('one canonical manifest owns every stable panel identity', () => {
  const { PANEL_DOM_IDS, PANEL_IDENTITIES, PANEL_ID_BY_VISIBILITY, PANEL_IDS } =
    loadTsModule('shared/ipc/app-core.ts')
  assert.deepEqual(
    [...PANEL_DOM_IDS],
    [
      'clock',
      'folders',
      'prompts',
      'settings',
      'calculator',
      'file-manager',
      'image-search',
      'unified-search',
      'app-storage',
      'remote-terminal',
      'duplicate-finder',
      'media-search',
      'neko-search',
      'batch-rename',
    ],
  )
  assert.equal(new Set(PANEL_DOM_IDS).size, PANEL_DOM_IDS.length)
  for (const panelId of PANEL_IDS) {
    const identity = PANEL_IDENTITIES[panelId]
    assert.equal(PANEL_ID_BY_VISIBILITY[identity.visibilityKey], panelId)
  }

  const componentRoot = path.join(root, 'src', 'components')
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.name.endsWith('.tsx') && entry.name !== 'DraggablePanel.tsx') {
        const contents = fs.readFileSync(file, 'utf8')
        for (const declaration of contents.match(/<DraggablePanel\b[\s\S]*?>/g) ?? []) {
          const panelId = declaration.match(/panelId="([^"]+)"/)?.[1]
          const dataPanel = declaration.match(/dataPanel="([^"]+)"/)?.[1]
          if (panelId && dataPanel) {
            assert.equal(
              dataPanel,
              PANEL_IDENTITIES[panelId]?.domId,
              `${path.relative(root, file)} duplicates a conflicting panel identity`,
            )
          }
        }
      }
    }
  }
  visit(componentRoot)

  const settings = source('src/components/SettingsPanel.tsx')
  const navigator = source('src/components/WorkspaceNavigator.tsx')
  const linkedMove = source('src/hooks/useLinkedMove.ts')
  assert.match(settings, /PANEL_IDENTITIES\[key\]\.domId/)
  assert.doesNotMatch(settings, /const panelKeys:/)
  assert.match(navigator, /PANEL_IDENTITIES\[panel\]\.visibilityKey/)
  assert.doesNotMatch(navigator, /const PANEL_IDS: Record/)
  assert.match(linkedMove, /for \(const pn of PANEL_IDS\)/)
  assert.match(linkedMove, /PANEL_IDENTITIES\[panel\]\.positionKey/)
})

test('live session and scan panels remain mounted after their first display', () => {
  const registry = source('src/config/panelRegistry.ts')
  assert.match(registry, /id: 'duplicateFinder'[\s\S]*?preserveWhenHidden: true/)
  assert.doesNotMatch(registry, /id: 'remoteTerminal'/)
  for (const panel of ['unifiedSearch', 'assetLibrary', 'appStorage'])
    assert.match(registry, new RegExp(`id: '${panel}'[\\s\\S]*?preserveWhenHidden: true`))

  const duplicateFinder = source('src/components/DuplicateFinderPanel.tsx')
  assert.match(duplicateFinder, /getProgress\(\)[\s\S]*current\.state === 'done'/)
  assert.match(duplicateFinder, /getResults\(\)/)
})

test('short-lived animation and notification work is cancelled on unmount', () => {
  const fileManager = source('src/components/filemanager/FileManagerPanel.tsx')
  assert.match(fileManager, /cancelAnimationFrame\(resizeRafRef\.current\)/)
  const imageSearch = source('src/components/ImageSearchPanel.tsx')
  assert.match(imageSearch, /window\.clearTimeout\(toastTimerRef\.current\)/)
  assert.match(imageSearch, /toastTimerRef\.current = window\.setTimeout/)
})

test('shared panel header exposes move, maximize, restore, and close controls', () => {
  const panel = source('src/components/DraggablePanel.tsx')
  assert.match(panel, /panel-control-move/)
  assert.match(panel, /onMouseDown\(e\)/)
  assert.match(panel, /disabled=\{locked \|\| maximized\}/)
  assert.match(panel, /panel-control-maximize/)
  assert.match(panel, /maximized \? 'Restore panel' : 'Maximize panel'/)
  assert.match(panel, /panel-control-close/)
  assert.match(panel, /title=\{t\('Close panel'\)\}/)
  assert.match(panel, /findPanelWorkArea\(workArea, pos\.x, pos\.y, size\.w, size\.h\)/)
  assert.match(panel, /!maximized &&/)
})

test('desktop workspace owns its viewport and leaves native window geometry to Electron', () => {
  const navigator = source('src/components/WorkspaceNavigator.tsx')
  const styles = source('src/styles/focused-workspace.css')
  const app = source('src/App.tsx')
  assert.doesNotMatch(navigator, /onMouseDown=\{startMove\}|workspace-navigator-move/)
  assert.match(styles, /\.workspace-sidebar\s*\{[\s\S]*?grid-column: 1/)
  assert.match(styles, /data-docked='true'/)
  assert.match(app, /data-presentation="desktop"/)
  assert.match(app, /innerWidth/)
  assert.doesNotMatch(app, /scheduleSettledShapeSync|setOverlayShape\(|useMouseTransparency\(/)
  assert.match(app, /window-visibility-state/)
  assert.match(navigator, /<FirstRunGuide/)
  assert.match(navigator, /workspace-first-run-guide/)
})

test('startup restores the workspace navigator with the saved panel snapshot', () => {
  const app = source('src/App.tsx')
  assert.match(
    app,
    /const migratePanelVisibility =\s*!Number\.isFinite\(storedPanelVisibilityVersion\) \|\|\s*storedPanelVisibilityVersion < PANEL_VISIBILITY_DEFAULTS_VERSION/,
  )
  const restoreBlock = app.slice(
    app.indexOf('// Global hide is a transient desktop action.'),
    app.indexOf('// Restore ImageSearch scan paths'),
  )
  assert.match(restoreBlock, /globalVisible: true/)
  assert.match(restoreBlock, /\.\.\.workspaceVisibilityMigration\.visibility/)
  assert.match(restoreBlock, /PRODUCT_PRIMARY_WORKSPACE_SAVED_VISIBILITY/)
  assert.doesNotMatch(restoreBlock, /globalVisible: settings\.globalVisible/)
})

test('docked pages use the system title bar instead of floating desktop controls', () => {
  const navigator = source('src/components/WorkspaceNavigator.tsx')
  const panel = source('src/components/DraggablePanel.tsx')
  assert.doesNotMatch(
    navigator,
    /workspace-layout-toggle|arrangeHorizontal\(\)|arrangeVertical\(\)/,
  )
  assert.doesNotMatch(navigator, /workspace-window-pin|workspace-window-hide/)
  const main = source('electron/main.ts')
  assert.match(main, /frame: !uiSmokeMode/)
  assert.match(main, /resizable: !uiSmokeMode/)
  assert.match(main, /transparent: uiSmokeMode/)
  assert.match(panel, /if \(docked\)/)
  assert.match(panel, /data-docked="true"/)
})

test('settings category navigation retains accessible lazy sections', () => {
  const settings = source('src/components/SettingsPanel.tsx')
  for (const id of ['appearance', 'panels', 'searchModels', 'dataReset', 'aiControl', 'system']) {
    assert.match(settings, new RegExp(`id="${id}"`))
    assert.match(settings, new RegExp(`expanded=\\{expandedSections\\.${id}\\}`))
  }
  assert.match(settings, /aria-expanded=\{expanded\}/)
  assert.match(settings, /aria-controls=\{`settings-category-content-\$\{id\}`\}/)
  assert.match(settings, /hasMountedBody\.current \? children : null/)
  assert.match(settings, /aria-current=\{activeSection === section.id \? 'page' : undefined\}/)
  assert.match(settings, /hidden=\{!active\}/)
  assert.match(settings, /setActiveSection\('searchModels'\)/)
  assert.match(settings, /setActiveSection\('dataReset'\)/)
  assert.doesNotMatch(settings, /const Section:/)

  const styles = source('src/styles/window-system.css')
  assert.match(styles, /\.settings-category__content\[hidden\]/)
  assert.match(styles, /\.settings-categories__toolbar/)
})

test('every draggable panel declares how its close button hides that panel', () => {
  const componentRoot = path.join(root, 'src', 'components')
  const files = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(item)
      else if (entry.name.endsWith('.tsx') && entry.name !== 'DraggablePanel.tsx') files.push(item)
    }
  }
  visit(componentRoot)

  let declarations = 0
  for (const file of files) {
    const contents = fs.readFileSync(file, 'utf8')
    const panels = contents.match(/<DraggablePanel\b[\s\S]*?>/g) ?? []
    for (const declaration of panels) {
      declarations += 1
      assert.match(
        declaration,
        /(?:panelId="[^"]+"|onClose=\{[^}]+\})/,
        `${path.relative(root, file)} has an unbound close control`,
      )
    }
  }
  // One declaration per real panel. Loading placeholders must not inflate this
  // count because they make startup tests pass while delaying the actual UI.
  const { WORKSPACE_PANELS } = loadTsModule('src/services/focusedWorkspace.ts')
  assert.ok(declarations >= WORKSPACE_PANELS.length)
})

test('panel controls have localized labels and close all registered workspace panels', () => {
  const i18n = source('src/i18n/core.ts')
  assert.match(i18n, /'Maximize panel': '最大化面板'/)
  assert.match(i18n, /'Restore panel': '还原面板'/)
  assert.match(i18n, /'Close panel': '关闭面板'/)
  assert.match(i18n, /'Drag to move panel': '拖动以移动面板'/)

  const store = source('src/stores/useStore.ts')
  for (const id of [
    'clock',
    'folders',
    'prompts',
    'settings',
    'calc',
    'fm',
    'imageSearch',
    'unifiedSearch',
    'appStorage',
    'remoteTerminal',
    'duplicateFinder',
    'mediaSearch',
    'assetLibrary',
    'batchRename',
  ]) {
    assert.match(store, new RegExp(`case '${id}':`))
  }
  assert.match(store, /closePanel: \(name\) => set\(closedPanelPatch\(name\)\)/)
})
