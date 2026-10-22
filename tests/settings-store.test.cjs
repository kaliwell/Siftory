const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

// Load the canonical settings helpers (one module, one truth)
const { readJSON, writeJSON } = loadTsModule('electron/settingsStore.ts')
const { resolvePanelVisibility } = loadTsModule('src/services/settingsVisibility.ts')
const panelDefaults = loadTsModule('src/types/index.ts')
const { PRODUCT_PRIMARY_WORKSPACE_VISIBILITY } = loadTsModule(
  'src/services/productInformationArchitecture.ts',
)
const {
  DEFAULT_IMAGE_SEARCH_UI_PREFERENCES,
  DEFAULT_MEDIA_SEARCH_UI_PREFERENCES,
  normalizeImageSearchUiPreferences,
  normalizeMediaSearchUiPreferences,
} = loadTsModule('shared/searchUiPreferences.ts')

test('search UI preferences are normalized into settings-safe values', () => {
  assert.deepEqual(normalizeImageSearchUiPreferences(null), DEFAULT_IMAGE_SEARCH_UI_PREFERENCES)
  assert.deepEqual(
    normalizeMediaSearchUiPreferences(undefined),
    DEFAULT_MEDIA_SEARCH_UI_PREFERENCES,
  )

  assert.deepEqual(
    normalizeImageSearchUiPreferences({
      workspaceView: 'search',
      embeddingGpuJobs: 1,
      embeddingBatchSize: 8,
      buildScanThumbnails: false,
      experienceMode: 'advanced',
      thumbnailRebuildBackend: 'auto',
      thumbnailGpuJobs: 12,
      thumbnailBatchSize: 6,
    }),
    {
      workspaceView: 'search',
      embeddingGpuJobs: 1,
      embeddingBatchSize: 8,
      buildScanThumbnails: false,
      experienceMode: 'advanced',
      thumbnailRebuildBackend: 'auto',
      thumbnailGpuJobs: 12,
      thumbnailBatchSize: 6,
    },
  )

  assert.deepEqual(
    normalizeImageSearchUiPreferences({
      workspaceView: 'unknown',
      embeddingGpuJobs: 99,
      embeddingBatchSize: -1,
      buildScanThumbnails: 'false',
      experienceMode: 'unknown',
      thumbnailRebuildBackend: 'unknown',
      thumbnailGpuJobs: 3,
      thumbnailBatchSize: 999,
    }),
    DEFAULT_IMAGE_SEARCH_UI_PREFERENCES,
  )
})

test('search panel startup never synchronously initializes Chromium local storage', () => {
  for (const file of [
    'src/components/ImageSearchPanel.tsx',
    'src/components/EmbeddingBuildControls.tsx',
    'src/components/ImageSearchDataManager.tsx',
    'src/components/MediaSearchPanel.tsx',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    assert.doesNotMatch(source, /\blocalStorage\b/, file)
  }

  const autoSaveSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'hooks', 'useAutoSaveSettings.ts'),
    'utf8',
  )
  assert.match(autoSaveSource, /imageSearchUiPreferences:\s*state\.imageSearchUiPreferences/)
  assert.match(autoSaveSource, /mediaSearchUiPreferences:\s*state\.mediaSearchUiPreferences/)
})

test('panel defaults use the requested unified large size while preserving compact panels', () => {
  for (const prefix of [
    'FOLDERS',
    'CALC',
    'FM',
    'IMAGESEARCH',
    'APPSTORAGE',
    'REMOTE_TERMINAL',
    'DUPLICATE_FINDER',
    'MEDIA_SEARCH',
    'ASSET_LIBRARY',
  ]) {
    assert.equal(panelDefaults[`DEFAULT_${prefix}_W`], 1135, `${prefix} width`)
    assert.equal(panelDefaults[`DEFAULT_${prefix}_H`], 950, `${prefix} height`)
  }
  assert.deepEqual([panelDefaults.DEFAULT_CLOCK_W, panelDefaults.DEFAULT_CLOCK_H], [269, 106])
  assert.deepEqual([panelDefaults.DEFAULT_SETTINGS_W, panelDefaults.DEFAULT_SETTINGS_H], [269, 996])
  assert.deepEqual([panelDefaults.DEFAULT_PROMPTS_W, panelDefaults.DEFAULT_PROMPTS_H], [240, 240])
  assert.deepEqual(
    [panelDefaults.DEFAULT_BATCH_RENAME_W, panelDefaults.DEFAULT_BATCH_RENAME_H],
    [420, 480],
  )
})

test('both settings reset paths include the batch rename panel size', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'SettingsPanel.tsx'),
    'utf8',
  )
  assert.equal((source.match(/batchRenameSize:\s*\{/g) ?? []).length, 2)
  assert.match(source, /DEFAULT_BATCH_RENAME_W/)
  assert.match(source, /DEFAULT_BATCH_RENAME_H/)
})

test('default panel visibility opens only unified search', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'stores', 'useStore.ts'), 'utf8')
  assert.match(source, /\.\.\.PRODUCT_PRIMARY_WORKSPACE_VISIBILITY/)
  assert.equal(PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showClock, false)
  assert.equal(PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showSettings, false)
  assert.equal(PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showImageSearch, false)
  assert.equal(PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showUnifiedSearch, true)
  assert.equal(PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showMediaSearch, false)
  assert.equal(PRODUCT_PRIMARY_WORKSPACE_VISIBILITY.showAssetLibrary, false)
})

test('default open panels use the captured side-by-side positions for unified search', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'stores', 'useStore.ts'), 'utf8')
  assert.match(source, /settingsPos:\s*\{\s*x:\s*42,\s*y:\s*42\s*\}/)
  assert.match(source, /unifiedSearchPos:\s*\{\s*x:\s*319,\s*y:\s*42\s*\}/)
})

test('settings layout separates search panels from other panels', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'SettingsPanel.tsx'),
    'utf8',
  )
  const searchGroup = source.slice(
    source.indexOf('const searchPanelVisibilityItems'),
    source.indexOf('const otherPanelVisibilityItems'),
  )
  assert.match(searchGroup, /key:\s*'imageSearch'/)
  assert.match(searchGroup, /key:\s*'mediaSearch'/)
  assert.match(searchGroup, /key:\s*'assetLibrary'/)
  assert.doesNotMatch(searchGroup, /key:\s*'settings'/)
})

test('settings panel visibility control is permanently enabled', () => {
  const panelSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'SettingsPanel.tsx'),
    'utf8',
  )
  const settingsItem = panelSource.slice(
    panelSource.indexOf("key: 'settings'"),
    panelSource.indexOf("key: 'calc'"),
  )
  assert.match(settingsItem, /show:\s*showSettings/)
  assert.match(settingsItem, /disabled:\s*true/)

  const storeSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'stores', 'useStore.ts'),
    'utf8',
  )
  const toggleStart = storeSource.lastIndexOf('toggleShowSettings: () =>')
  const toggle = storeSource.slice(
    toggleStart,
    storeSource.indexOf('toggleShowCalc: () =>', toggleStart),
  )
  assert.doesNotMatch(toggle, /showSettings:\s*false/)
  assert.match(toggle, /showSettings:\s*true/)
})

test('settings store reads and writes settings/config JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-settings-'))
  try {
    const settingsPath = path.join(root, 'floating_clock_settings.json')
    const configPath = path.join(root, 'clock_config.json')

    writeJSON(settingsPath, { theme: 2 })
    writeJSON(configPath, { tabs: [{ name: 'Main' }] })

    assert.deepEqual(readJSON(settingsPath), { theme: 2 })
    assert.deepEqual(readJSON(configPath), { tabs: [{ name: 'Main' }] })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('readJSON returns null and backs up corrupted JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-corrupt-'))
  try {
    const badPath = path.join(root, 'bad.json')
    fs.writeFileSync(badPath, '{corrupt', 'utf-8')
    const result = readJSON(badPath)
    assert.equal(result, null)

    // Should have created a backup
    const entries = fs.readdirSync(root)
    const backupFiles = entries.filter((f) => f.startsWith('bad.json.corrupted-'))
    assert.ok(backupFiles.length >= 1, 'corrupted file should be backed up')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('writeJSON writes atomically visible JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-settings-'))
  try {
    const settingsPath = path.join(root, 'floating_clock_settings.json')
    writeJSON(settingsPath, { theme: 5, showDate: false })
    const result = readJSON(settingsPath)
    assert.deepEqual(result, { theme: 5, showDate: false })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('visible startup uses current checkboxes instead of stale visibility snapshots', () => {
  const settings = {
    globalVisible: true,
    showImageSearch: false,
    showDuplicateFinder: true,
    savedVisibility: { imageSearch: true, duplicateFinder: false },
  }
  assert.equal(resolvePanelVisibility(settings, 'imageSearch', 'showImageSearch', false), false)
  assert.equal(
    resolvePanelVisibility(settings, 'duplicateFinder', 'showDuplicateFinder', false),
    true,
  )
})

test('hidden startup restores the saved visibility snapshot', () => {
  const settings = {
    globalVisible: false,
    showImageSearch: false,
    savedVisibility: { imageSearch: true },
  }
  assert.equal(resolvePanelVisibility(settings, 'imageSearch', 'showImageSearch', false), true)
})
