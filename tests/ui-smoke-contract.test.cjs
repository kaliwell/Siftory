const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const repo = path.resolve(__dirname, '..')
const {
  assertTemporaryDirectory,
  redactSmokeText,
  resolveUiSmokeExecutable,
  createUiSmokeFileFixture,
  verifyUiSmokeFileFixture,
} = require('./smoke-test-utils.cjs')

function source(relativePath) {
  return fs.readFileSync(path.join(repo, relativePath), 'utf8')
}

function packagedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-ui-smoke-contract-'))
  const expectedRoot = fs.realpathSync(root)
  t.after(() => {
    assertTemporaryDirectory(root)
    assert.equal(fs.realpathSync(root), expectedRoot)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const createPackage = (directory) => {
    fs.mkdirSync(path.join(directory, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'Siftory.exe'), 'not executable; fixture only')
    fs.writeFileSync(path.join(directory, 'resources', 'app.asar'), 'fixture only')
    return fs.realpathSync(directory)
  }
  return { root, createPackage }
}

test('UI smoke selects an explicit package without copying it into the release directory', (t) => {
  const { root, createPackage } = packagedFixture(t)
  const candidate = createPackage(path.join(root, 'external-candidate', 'win-unpacked'))
  const resolved = resolveUiSmokeExecutable({
    repo: path.join(root, 'different-project'),
    packaged: true,
    packagedDirectory: candidate,
  })
  assert.equal(resolved, path.join(candidate, 'Siftory.exe'))
  assert.equal(fs.existsSync(path.join(root, 'different-project', 'release')), false)
})

test('UI smoke uses bounded temporary files and detects same-size fixture corruption', (t) => {
  const { root } = packagedFixture(t)
  const fixture = createUiSmokeFileFixture(root)
  assert.equal(fixture.totalBytes, 896)
  assert.equal(fixture.files.length, 3)
  assert.equal(verifyUiSmokeFileFixture(fixture), true)
  assert.throws(() => createUiSmokeFileFixture(root), /EEXIST/)
  fs.writeFileSync(path.join(fixture.directory, 'sample.txt'), Buffer.alloc(128, 66))
  assert.equal(verifyUiSmokeFileFixture(fixture), false)
  const runner = source('tests/electron-ui-smoke.cjs')
  assert.match(runner, /fmPaneTabs: \[\[fileFixture\.directory\]/)
  assert.match(
    source('electron/uiSmokeService.ts'),
    /fileFixtureCheck\.totalBytes === expectedFixtureBytes/,
  )
})

test('UI smoke preserves the default package location and development Electron choice', (t) => {
  const { root, createPackage } = packagedFixture(t)
  const defaultPackage = createPackage(path.join(root, 'release', 'win-unpacked'))
  assert.equal(
    resolveUiSmokeExecutable({ repo: root, packaged: true }),
    path.join(defaultPackage, 'Siftory.exe'),
  )
  assert.equal(
    resolveUiSmokeExecutable({
      repo: root,
      packaged: false,
      developmentExecutable: 'development-electron',
    }),
    'development-electron',
  )
  assert.throws(
    () =>
      resolveUiSmokeExecutable({
        repo: root,
        packaged: false,
        packagedDirectory: defaultPackage,
      }),
    /requires --packaged/,
  )
})

test('UI smoke rejects missing ASAR and directories masquerading as executables before launch', (t) => {
  const { root, createPackage } = packagedFixture(t)
  const missingAsar = createPackage(path.join(root, 'missing-asar'))
  fs.unlinkSync(path.join(missingAsar, 'resources', 'app.asar'))
  assert.throws(() =>
    resolveUiSmokeExecutable({
      repo: root,
      packaged: true,
      packagedDirectory: missingAsar,
    }),
  )
  const badExe = createPackage(path.join(root, 'bad-exe'))
  fs.unlinkSync(path.join(badExe, 'Siftory.exe'))
  fs.mkdirSync(path.join(badExe, 'Siftory.exe'))
  assert.throws(
    () =>
      resolveUiSmokeExecutable({
        repo: root,
        packaged: true,
        packagedDirectory: badExe,
      }),
    /regular Siftory.exe/,
  )
})

test('temporary cleanup validation refuses the temp root itself and its parent', () => {
  assert.throws(() => assertTemporaryDirectory(os.tmpdir()), /below the system temp/)
  assert.throws(
    () => assertTemporaryDirectory(path.dirname(fs.realpathSync(os.tmpdir()))),
    /below the system temp/,
  )
})

test('license UI evidence checks both locales and captures settings without launching the shell', () => {
  const smoke = source('electron/uiSmokeService.ts')
  assert.match(smoke, /settings-category-system/)
  assert.match(smoke, /settings-third-party-licenses/)
  assert.match(smoke, /licenseControls/)
  assert.match(smoke, /every\(\(evidence\) => evidence\?\.licenseEntryValid\)/)
  assert.match(smoke, /third-party-licenses\.png/)
  assert.match(smoke, /licenseAccessCheck\.unobscured/)
  assert.match(smoke, /shellLaunchTested: false/)
  assert.doesNotMatch(smoke, /openThirdPartyLicenses\s*\(/)
  const check = smoke.slice(
    smoke.indexOf('licenseAccessCheck = (await'),
    smoke.indexOf('snapshot.licenseAccessCheck ='),
  )
  assert.match(check, /button\?\.focus/)
  assert.doesNotMatch(check, /button\??\.click\(/)
  const runner = source('tests/electron-ui-smoke.cjs')
  assert.match(runner, /--packaged-dir=/)
  assert.match(runner, /resolveUiSmokeExecutable/)
})

test('UI smoke logs redact credentials and embedded absolute paths', () => {
  const value = redactSmokeText(
    'token=private C:\\Users\\person\\model.onnx\n/tmp/private/runtime.log',
  )
  assert.doesNotMatch(value, /private|C:\\Users|\/tmp\//)
  assert.match(value, /token=\[redacted\]/)
  assert.match(value, /\[path\]/)
})

test('development StrictMode is opt-in for native desktop panels', () => {
  const entry = source('src/main.tsx')
  assert.match(entry, /VITE_REACT_STRICT_MODE === '1'/)
  assert.match(entry, /<React\.StrictMode>\{application\}<\/React\.StrictMode>/)
  assert.doesNotMatch(entry, /\.render\(\s*<React\.StrictMode>/)
})

test('UI smoke locates panels by stable data-panel ids', () => {
  const smoke = source('electron/uiSmokeService.ts')
  const manifest = source('shared/ipc/app-core.ts')
  for (const panelId of [
    'clock',
    'folders',
    'prompts',
    'calculator',
    'file-manager',
    'image-search',
    'unified-search',
    'media-search',
    'remote-terminal',
    'app-storage',
    'duplicate-finder',
    'neko-search',
    'settings',
    'batch-rename',
  ]) {
    assert.match(manifest, new RegExp(`['"]${panelId}['"]`))
  }
  assert.match(smoke, /PANEL_DOM_IDS/)
  assert.match(smoke, /const REQUIRED_PANEL_IDS = \[\.\.\.PANEL_DOM_IDS\]/)
  assert.match(smoke, /REQUIRED_PANEL_IDS/)
  assert.match(smoke, /Date\.now\(\) \+ 8000/)
  assert.match(smoke, /\.panel\[data-panel=/)
  assert.doesNotMatch(smoke, /REQUIRED_PANEL_TITLES/)
  assert.doesNotMatch(smoke, /panel-title.*===/)
  assert.doesNotMatch(smoke, /data-ui-smoke-index/)
})

test('UI smoke interactions use stable test ids instead of translated labels', () => {
  const smoke = source('electron/uiSmokeService.ts')
  for (const testId of [
    'search-mode-simple',
    'search-mode-advanced',
    'search-prepare-library',
    'asset-view-library',
    'asset-view-review',
    'asset-view-clusters',
    'asset-mode-assets',
    'asset-mode-categories',
    'asset-mode-sampleSearch',
    'asset-mode-similar',
    'asset-new-category-name',
    'asset-create-category',
    'asset-history-toggle',
    'asset-history-restore',
    'asset-new-tag-name',
    'asset-create-tag',
    'asset-search-category',
    'asset-search-run',
    'asset-cluster-category',
    'asset-cluster-build-category',
    'asset-filter-query',
    'asset-select',
    'asset-collection-rename',
    'asset-collection-move-up',
    'asset-collection-move-down',
    'asset-library-collection-select',
    'asset-library-collect-selected',
    'image-search-data-manager-toggle',
    'app-language',
    'window-material-solid',
    'window-material-glass',
    'window-glass-strength',
  ]) {
    assert.match(smoke, new RegExp(testId))
  }
  for (const translatedLabel of [
    "button('Advanced')",
    "button('Simple')",
    "button('Categories & Tags')",
    "button('Sample Search')",
    "button('Similar Results')",
    "button('Build category group')",
    "button('Data Editor Manager')",
  ]) {
    assert.doesNotMatch(smoke, new RegExp(translatedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('focused workspace keeps primary domains and retires remote terminal tools', () => {
  const navigator = source('src/components/WorkspaceNavigator.tsx')
  const smoke = source('electron/uiSmokeService.ts')
  const sources = source('src/components/DiscoverySourcesSection.tsx')
  const imagePanel = source('src/components/ImageSearchPanel.tsx')
  const collapsible = source('src/components/CollapsibleSearchSection.tsx')
  for (const domain of ['Search', 'Sources', 'Library', 'Tasks', 'Settings']) {
    assert.match(navigator, new RegExp(`['"]${domain}['"]`))
  }
  assert.doesNotMatch(
    navigator,
    /workspace-remote-advanced|showRemoteTerminal|workspace-search-advanced-toggle/,
  )
  assert.match(navigator, /panel: 'unifiedSearch'/)
  assert.match(navigator, /panel: 'assetLibrary'/)
  const settings = source('src/components/SettingsPanel.tsx')
  assert.doesNotMatch(settings, /sourceAdvancedToolItems/)
  assert.match(navigator, /getSchedulerStats\(\)/)
  assert.match(sources, /workspace-sources-focus/)
  assert.match(imagePanel, /testId="image-search-sources-section"/)
  assert.match(imagePanel, /sources: true/)
  assert.match(collapsible, /data-collapsed=/)
  assert.match(collapsible, /data-pinned=/)
  assert.match(smoke, /collapsibleWorkflowSections/)
  assert.match(smoke, /pinnedQueryRemainsExpanded/)
  for (const check of [
    'compositorDragStable',
    'domainWidthStable',
    'domainsPresent',
    'legacyModuleNamesAbsent',
    'modelInventoryComplete',
    'modelLayoutValid',
    'modelOcclusionFree',
    'modelStatusInNavigator',
    'remoteAdvancedFocused',
    'sourcesExpanded',
    'taskSummaryVisible',
    'unifiedSearchPageVisible',
  ]) {
    assert.match(smoke, new RegExp(`workspaceNavigationCheck\\.${check}`))
  }
})

test('unified search is a first-class page with safe result actions', () => {
  const navigator = source('src/components/WorkspaceNavigator.tsx')
  const panel = source('src/components/UnifiedSearchPanel.tsx')
  assert.match(navigator, /panel: 'unifiedSearch'/)
  assert.match(navigator, /openWorkspacePanel/)
  for (const testId of [
    'unified-search-page',
    'unified-search-query',
    'unified-result-open',
    'unified-result-reveal',
    'unified-result-collect',
    'unified-result-download',
  ]) {
    assert.match(panel, new RegExp(`data-testid=["']${testId}["']`))
  }
  assert.match(panel, /assetIdentity\.openOriginal/)
  assert.match(panel, /assetIdentity\.revealOriginal/)
  assert.match(panel, /createRemoteDownloadGrant/)
  assert.match(panel, /enqueueCatalogDownload/)
})

test('UI smoke runner isolates artifacts and settings by explicit locale', () => {
  const runner = source('tests/electron-ui-smoke.cjs')
  const main = source('electron/main.ts')
  const smoke = source('electron/uiSmokeService.ts')
  assert.match(runner, /--locale=/)
  assert.match(runner, /--surface=/)
  assert.match(runner, /requestedSurface === 'glass' \? 36 : 0/)
  assert.match(runner, /FLOATING_CLOCK_UI_SMOKE_SURFACE/)
  assert.match(smoke, /glassSurfacePreview/)
  assert.match(runner, /requestedLocale !== 'zh-CN' && requestedLocale !== 'en'/)
  assert.match(runner, /floating_clock_settings\.json/)
  assert.match(runner, /FLOATING_CLOCK_UI_SMOKE_LOCALE/)
  assert.match(main, /expectedLocale: uiSmokeLocale/)
  assert.match(smoke, /snapshot\.language === options\.expectedLocale/)
  assert.match(source('src/components/SettingsPanel.tsx'), /Open App Data Folder/)
  assert.match(source('src/i18n/core.ts'), /'Open App Data Folder': '打开应用数据目录'/)
})

test('UI smoke proves translated surfaces, accessibility names, and the DPI matrix', () => {
  const runner = source('tests/electron-ui-smoke.cjs')
  const matrix = source('tests/electron-ui-i18n-matrix.cjs')
  const smoke = source('electron/uiSmokeService.ts')
  const main = source('electron/main.ts')

  assert.match(runner, /--viewport=/)
  assert.match(runner, /--scale=/)
  assert.match(runner, /--work-area=/)
  assert.match(runner, /force-device-scale-factor/)
  assert.match(main, /FLOATING_CLOCK_UI_SMOKE_VIEWPORT/)
  for (const expected of [
    '1366x768',
    '1920x1080',
    '2560x1440',
    "'1.25'",
    "'1.5'",
    '-1536,0,1536,864',
  ]) {
    assert.match(matrix, new RegExp(expected.replace('.', '\\.')))
  }
  for (const check of [
    'visibleTextChanged',
    'surfacesChanged',
    'errorTranslated',
    'accessibilityValid',
    'layoutValid',
  ]) {
    assert.match(smoke, new RegExp(`languageSwitchCheck\\.${check}`))
  }
  for (const testId of [
    'image-search-toast',
    'image-search-results',
    'asset-backups-toggle',
    'asset-backup-view',
    'vector-storage-toggle',
    'vector-cleanup-preview',
  ]) {
    assert.match(smoke, new RegExp(testId))
  }
  assert.match(smoke, /snapshot\.devicePixelRatio - options\.expectedScale/)
  assert.match(smoke, /window\.getBounds\(\)/)
  assert.match(smoke, /windowBounds\.x - options\.expectedWorkArea\.x/)
  assert.match(smoke, /Math\.abs\(snapshot\.viewport\.width - options\.expectedViewport\.width\)/)
  assert.match(
    smoke,
    /Math\.abs\(\(screenshotSize\?\.width \|\| 0\) - options\.expectedPixelSize\.width\)/,
  )
})

test('packaged UI smoke proves runtime resources come from the packaged resources root', () => {
  const runner = source('tests/electron-ui-smoke.cjs')
  const smoke = source('electron/uiSmokeService.ts')
  const imageSearch = source('electron/imageSearchService.ts')

  assert.doesNotMatch(runner, /FLOATING_CLOCK_PACKAGED_RUNTIME_SMOKE_IMAGE/)
  assert.match(smoke, /window\.electronAPI\.mediaSearch\.getStatus/)
  assert.match(smoke, /packagedProvenance\.modelsUnderResources/)
  assert.match(smoke, /packagedProvenance\.userCandidateModelsAbsent/)
  assert.match(smoke, /wideSplitLayout/)
  assert.match(runner, /cwd: packaged \? path\.dirname\(electronPath\) : repo/)
  assert.match(smoke, /models\/yolov8n\/model\.onnx/)
  assert.match(smoke, /models\/mobilesam\/decoder\.onnx/)
  assert.match(smoke, /packagedProvenance\.distributionProfile/)
  assert.match(
    smoke,
    /!runtimeCheck\.packagedProvenance\.required \|\|\s*runtimeCheck\.packagedProvenance\.distributionProfile === 'online'/,
  )
  assert.match(smoke, /packagedProvenance\.nativeUnderResources/)
  assert.match(smoke, /packagedProvenance\.ffmpegUnderResources/)
  assert.match(smoke, /packagedProvenance\.ffprobeUnderResources/)
  assert.match(imageSearch, /nativePath = p/)
})

test('packaged locale evidence is isolated by online/offline profile', () => {
  const smoke = source('tests/electron-ui-smoke.cjs')
  const matrix = source('scripts/validate-packaged-matrix.cjs')
  assert.match(smoke, /packaged && requestedProfile \? requestedProfile : ''/)
  assert.match(matrix, /MATRIX_PROFILES = \['offline', 'online'\]/)
  assert.match(matrix, /MATRIX_LOCALES = \['zh-CN', 'en'\]/)
})

test('image query clears stale display filters and reports filtered-empty results', () => {
  const panel = source('src/components/ImageSearchPanel.tsx')
  const grid = source('src/components/ImageSearchResultGrid.tsx')
  const runImageQuery = panel.slice(
    panel.indexOf('const runImageQuery = useCallback'),
    panel.indexOf('const handleQueryImage = useCallback'),
  )

  assert.match(runImageQuery, /setSearchQuery\(''\)/)
  assert.match(runImageQuery, /setResults\(\[\]\)/)
  assert.match(runImageQuery, /setLayeredResults\(\[\]\)/)
  assert.match(panel, /rawResultCount=\{sortedResults\.length\}/)
  assert.match(grid, /filteredResults\.length === 0/)
  assert.match(grid, /No visible image results/)
  assert.match(grid, /Clear or change the name filter to show matching indexed images\./)
})

async function runRemoteFocusProbe({
  eventAt = 20,
  commitAt = 40,
  replaceAt,
  eventPanel = 'remote-terminal',
  initiallyOnTop = false,
  clickFails = false,
} = {}) {
  const smoke = source('electron/uiSmokeService.ts')
  const start = smoke.indexOf('const remotePanel = document.querySelector(')
  const end = smoke.indexOf("byTestId('workspace-domain-search')?.click()", start)
  assert.ok(start >= 0 && end > start)
  const probe = new Function(
    'document',
    'window',
    'performance',
    'getComputedStyle',
    'byTestId',
    'setTimeout',
    `return (async () => {
    ${smoke.slice(start, end)}
    return { remoteAdvancedFocused, remoteAdvancedFocusEvidence }
  })()`,
  )
  let now = 0
  const listeners = new Set()
  const panel = (id, zIndex) => ({
    isConnected: true,
    style: { zIndex: String(zIndex) },
    getAttribute: () => id,
  })
  let remote = panel('remote-terminal', initiallyOnTop ? 23 : 22)
  const other = panel('image-search', initiallyOnTop ? 22 : 23)
  const original = remote
  const pending = []
  const schedule = (at, action) => {
    if (at !== null && at !== undefined) pending.push({ at, action })
  }
  const button = {
    click() {
      if (clickFails) throw new Error('fixture click failed')
      schedule(eventAt, () => {
        for (const listener of listeners) listener({ detail: { panel: eventPanel } })
      })
      schedule(replaceAt, () => {
        original.isConnected = false
        remote = panel('remote-terminal', 22)
        other.style.zIndex = '23'
      })
      schedule(commitAt, () => {
        remote.style.zIndex = '23'
        other.style.zIndex = '22'
      })
    },
  }
  const promise = probe(
    {
      querySelector: () => remote,
      querySelectorAll: () => [other, remote],
      visibilityState: 'visible',
    },
    {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
    { now: () => now },
    (node) => ({ zIndex: node.style.zIndex, display: 'flex' }),
    () => button,
    (resolve, delay) => {
      const until = now + delay
      pending.sort((a, b) => a.at - b.at)
      while (pending.length && pending[0].at <= until) {
        const entry = pending.shift()
        now = entry.at
        entry.action()
      }
      now = until
      resolve()
    },
  )
  try {
    return await promise
  } finally {
    assert.equal(listeners.size, 0, 'focus observer must always be removed')
  }
}

test('remote focus smoke waits for the actual event and committed top layer beyond 100ms', async () => {
  const result = await runRemoteFocusProbe({ eventAt: 125, commitAt: 175 })
  assert.equal(result.remoteAdvancedFocusEvidence.focusedAt100Ms, false)
  assert.equal(result.remoteAdvancedFocused, true)
  assert.equal(result.remoteAdvancedFocusEvidence.events[0].elapsedMs, 125)
  assert.equal(result.remoteAdvancedFocusEvidence.after.elapsedMs, 175)
  assert.equal(
    result.remoteAdvancedFocusEvidence.after.panels.find((panel) => panel.id === 'remote-terminal')
      .zIndex,
    '23',
  )
})

test('remote focus smoke checks the current panel after a visibility remount', async () => {
  const result = await runRemoteFocusProbe({ initiallyOnTop: true, replaceAt: 30, commitAt: 150 })
  assert.equal(result.remoteAdvancedFocusEvidence.at100Ms.originalConnected, false)
  assert.equal(result.remoteAdvancedFocusEvidence.at100Ms.originalIsCurrent, false)
  assert.equal(result.remoteAdvancedFocusEvidence.focusedAt100Ms, false)
  assert.equal(result.remoteAdvancedFocused, true)
  assert.equal(result.remoteAdvancedFocusEvidence.after.elapsedMs, 150)
})

test('remote focus smoke rejects a missing request, an unrelated request, and uncommitted focus', async () => {
  for (const options of [
    { eventAt: null, initiallyOnTop: true },
    { eventPanel: 'image-search', initiallyOnTop: true },
    { commitAt: null },
  ]) {
    const result = await runRemoteFocusProbe(options)
    assert.equal(result.remoteAdvancedFocused, false)
    assert.equal(result.remoteAdvancedFocusEvidence.after.elapsedMs, 2000)
  }
})

test('remote focus smoke removes its observer when clicking fails', async () => {
  await assert.rejects(runRemoteFocusProbe({ clickFails: true }), /fixture click failed/)
})
