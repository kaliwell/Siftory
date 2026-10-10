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
  assert.match(navigator, /PANEL_ID_BY_VISIBILITY\[visibilityKey\]/)
  assert.doesNotMatch(navigator, /const PANEL_IDS: Record/)
  assert.match(linkedMove, /for \(const pn of PANEL_IDS\)/)
  assert.match(linkedMove, /PANEL_IDENTITIES\[panel\]\.positionKey/)
})

test('live session and scan panels remain mounted after their first display', () => {
  const registry = source('src/config/panelRegistry.ts')
  assert.match(registry, /id: 'duplicateFinder'[\s\S]*?preserveWhenHidden: true/)
  assert.match(registry, /id: 'remoteTerminal'[\s\S]*?preserveWhenHidden: true/)

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

test('workspace navigator has its own persistent drag handle', () => {
  const navigator = source('src/components/WorkspaceNavigator.tsx')
  assert.match(navigator, /data-testid="workspace-navigator-move"/)
  assert.match(navigator, /onMouseDown=\{startMove\}/)
  assert.match(navigator, /onDoubleClick=\{\(\) => setNavigatorPos\(null\)\}/)
  assert.match(navigator, /clampPanelToWorkspace/)
  assert.match(navigator, /const workArea = useStore\(\(state\) => state\.workArea\)/)
  assert.match(navigator, /getBoundingClientRect\(\)[\s\S]*setNavigatorPos\(next\)/)
  assert.match(navigator, /navigator\.dataset\.moving = 'true'/)
  assert.match(navigator, /navigator\.style\.willChange = 'transform'/)
  assert.match(navigator, /navigator\.style\.transform = `translate3d\(/)
  assert.match(navigator, /visualPosition = next[\s\S]*setNavigatorPos\(visualPosition\)/)

  const flushBlock = navigator.slice(
    navigator.indexOf('const flush = () =>'),
    navigator.indexOf('const onMove ='),
  )
  assert.doesNotMatch(flushBlock, /setNavigatorPos/)

  const navigatorStyles = source('src/styles/workspace-navigator.css')
  assert.match(navigatorStyles, /html\[data-panel-interaction='active'\] \.workspace-navigator/)
  assert.match(navigatorStyles, /\.workspace-navigator\[data-moving='true'\]/)
  assert.match(navigatorStyles, /contain: paint style/)
  assert.match(navigatorStyles, /backdrop-filter: none/)
  assert.match(navigator, /activeDomain !== 'Tasks' && !modelsOpen && <FirstRunGuide/)
  assert.match(
    navigator,
    /workspace-navigator__getting-started[\s\S]*setActiveDomain\(null\)[\s\S]*workspace-open-first-run-guide/,
  )

  const autoSave = source('src/hooks/useAutoSaveSettings.ts')
  const app = source('src/App.tsx')
  const contract = source('shared/ipc/app-core.ts')
  assert.match(autoSave, /workspaceNavigatorPos: state\.workspaceNavigatorPos/)
  assert.match(app, /safePoint\(settings\.workspaceNavigatorPos\)/)
  assert.match(app, /new MutationObserver\(\(mutations\) => \{[\s\S]*interactionActive/)
  assert.match(app, /mutations\.some\(mutationContainsShapeElement\)/)
  assert.match(app, /scheduleSettledShapeSync/)
  assert.match(app, /lastShape \? 80 : 300/)
  assert.doesNotMatch(app, /element\.offsetParent/)
  const windowStyles = source('src/styles/window-system.css')
  assert.match(windowStyles, /\.panel\s*\{[\s\S]*contain: layout style/)
  assert.match(app, /overflow: 'clip'/)
  assert.doesNotMatch(app, /data-testid="app-root"[\s\S]{0,500}overflow: 'hidden'/)
  assert.match(contract, /workspaceNavigatorPos\?: \{ x: number; y: number \} \| null/)
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

test('layout controls live in the workspace navigator instead of settings', () => {
  const navigator = source('src/components/WorkspaceNavigator.tsx')
  for (const testId of [
    'workspace-layout-toggle',
    'workspace-layout-row',
    'workspace-layout-grid',
    'workspace-layout-column',
    'workspace-layout-linked-move',
    'workspace-layout-snap-grid',
  ]) {
    assert.match(navigator, new RegExp(`data-testid="${testId}"`))
  }
  assert.match(navigator, /arrangeHorizontal\(\)/)
  assert.match(navigator, /autoArrange\(\)/)
  assert.match(navigator, /arrangeVertical\(\)/)

  const settings = source('src/components/SettingsPanel.tsx')
  assert.doesNotMatch(settings, /<Section label=\{t\('Layout'\)\}/)
  assert.doesNotMatch(settings, /setSnapToGrid/)
})

test('settings are grouped into accessible collapsible categories', () => {
  const settings = source('src/components/SettingsPanel.tsx')
  for (const id of ['appearance', 'panels', 'searchModels', 'dataReset', 'aiControl', 'system']) {
    assert.match(settings, new RegExp(`id="${id}"`))
    assert.match(settings, new RegExp(`expanded=\\{expandedSections\\.${id}\\}`))
  }
  assert.match(settings, /aria-expanded=\{expanded\}/)
  assert.match(settings, /aria-controls=\{`settings-category-content-\$\{id\}`\}/)
  assert.match(settings, /hasMountedBody\.current \? children : null/)
  assert.match(settings, /setAllSectionsExpanded\(true\)/)
  assert.match(settings, /setAllSectionsExpanded\(false\)/)
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
  assert.ok(declarations >= 15)
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
