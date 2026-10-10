const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  createInitialManagedSearchModelStatuses,
  isManagedSearchModelReady,
  resolveManagedSearchModelReadiness,
} = loadTsModule('src/services/managedSearchModelReadiness.ts')

const root = path.join(__dirname, '..')

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('simple and advanced image search share a bounded control rail in wide panels', () => {
  const panel = source('src/components/ImageSearchPanel.tsx')
  assert.match(panel, /className="image-search-shell"/)
  assert.match(panel, /image-search-workspace is-\$\{experienceMode\}/)
  assert.match(panel, /className="image-search-control-pane"/)
  assert.match(panel, /className="image-search-results-pane"/)

  const styles = source('src/styles/window-system.css')
  assert.match(styles, /@container image-search-panel \(min-width: 1050px\)/)
  assert.match(styles, /@container image-search-panel[\s\S]*\.image-search-workspace\s*\{/)
  assert.match(styles, /grid-template-columns: clamp\(390px, 25cqi, 460px\) minmax\(0, 1fr\)/)
  assert.match(styles, /\.image-search-control-pane[\s\S]*overflow-y: auto/)
  assert.match(styles, /\.image-search-results-pane[\s\S]*overflow: hidden/)
  assert.match(styles, /\.discovery-source-form[\s\S]*display: grid !important/)
  assert.match(styles, /\.asset-collection-toolbar[\s\S]*flex: 1 1 135px/)
  assert.match(styles, /\.image-search-query-controls > input[\s\S]*flex-basis: 100% !important/)
  assert.match(styles, /white-space: nowrap/)
  assert.doesNotMatch(styles, /\.image-search-workspace\.is-advanced/)
})

test('image result cards keep metadata and all five actions readable', () => {
  const grid = source('src/components/ImageSearchResultGrid.tsx')

  assert.match(grid, /const rowHeight = 268/)
  assert.match(grid, /minColumnWidth: 240/)
  assert.match(grid, /const RESULT_ACTION_STYLE[\s\S]*whiteSpace: 'nowrap'/)
  assert.match(grid, /flexWrap: 'wrap'/)
  assert.equal((grid.match(/style=\{RESULT_ACTION_STYLE\}/g) ?? []).length, 5)
})

test('startup index hydration does not reload the main-process default manifest', () => {
  const panel = source('src/components/ImageSearchPanel.tsx')
  const service = source('electron/imageSearchService.ts')
  const duplicateGuard = panel.indexOf(
    'normalizeImageSearchRoot(status.segmentPath) === normalizeImageSearchRoot(rootDir)',
  )
  const rendererLoad = panel.indexOf('.loadManifest(rootDir)')

  assert.match(panel, /initialStatusLoaded/)
  assert.ok(duplicateGuard > 0)
  assert.ok(rendererLoad > duplicateGuard)
  assert.match(service, /message: 'Loading default image index\.\.\.'/)
  assert.match(service, /loadManifestAsync\(defaultSavePath, defaultThumbnailCachePath\)/)
})

test('image search controls are grouped into four readable workflow sections', () => {
  const panel = source('src/components/ImageSearchPanel.tsx')
  const controls = source('src/components/ImageSearchControls.tsx')
  const sources = source('src/components/DiscoverySourcesSection.tsx')
  const collapsible = source('src/components/CollapsibleSearchSection.tsx')
  const styles = source('src/styles/window-system.css')

  assert.match(panel, /testId="image-search-sources-section"/)
  assert.match(controls, /testId="image-search-library-section"/)
  assert.match(controls, /testId="image-search-query-section"/)
  assert.match(panel, /testId="image-search-maintenance-section"/)
  assert.match(panel, /Data sources and collections/)
  assert.match(controls, /Library preparation/)
  assert.match(controls, /Search input/)
  assert.match(panel, /Index and maintenance/)

  assert.match(collapsible, /aria-expanded=\{effectiveExpanded\}/)
  assert.match(collapsible, /aria-controls=\{contentId\}/)
  assert.match(collapsible, /bodyMounted \? children : null/)
  assert.match(collapsible, /Number\.parseInt\(step, 10\)/)
  assert.match(collapsible, /requestAnimationFrame\(reveal\)/)
  assert.match(collapsible, /data-collapsed=\{effectiveExpanded \? 'false' : 'true'\}/)
  assert.match(collapsible, /data-pinned=\{pinned \? 'true' : undefined\}/)
  assert.match(collapsible, /data-static="true"/)
  assert.match(collapsible, /data-section-icon=\{tone\}/)
  assert.match(collapsible, /<SearchControlSectionIcon tone=\{tone\} \/>/)
  assert.doesNotMatch(collapsible, /search-control-section__step/)
  assert.match(collapsible, /data-testid=\{`\$\{panelId\}-sections-expand-all`\}/)
  assert.match(collapsible, /data-testid=\{`\$\{panelId\}-sections-collapse-all`\}/)
  assert.match(panel, /setAllControlSectionsExpanded\(true\)/)
  assert.match(panel, /setAllControlSectionsExpanded\(false\)/)
  assert.match(
    panel,
    /<SearchControlSectionsToolbar[\s\S]*?leadingControl=\{[\s\S]*?<SearchExperienceModeBar/,
  )
  assert.doesNotMatch(panel, /image-search-model-readiness|SearchModelReadinessBar/)
  assert.match(panel, /refreshManagedModels\(\)/)
  assert.match(panel, /isManagedSearchModelReady\(latestModels\?\.clip_vit_base_patch32\)/)
  assert.match(controls, /semanticModelReady: boolean/)
  assert.match(controls, /disabled=\{searching \|\| workflowRunning \|\| !semanticModelReady\}/)
  const imageSourcesStart = panel.indexOf('id="image-search-sources-section"')
  const imageSourcesEnd = panel.indexOf('</CollapsibleSearchSection>', imageSourcesStart)
  assert.ok(imageSourcesStart > 0 && imageSourcesEnd > imageSourcesStart)
  assert.doesNotMatch(
    panel.slice(imageSourcesStart, imageSourcesEnd),
    /SearchExperienceModeBar|summary=\{t\(experienceMode/,
  )
  assert.doesNotMatch(sources, /image-search-sources-content__toggle/)
  const imageQueryStart = controls.indexOf('id="image-search-query-section"')
  const imageQueryEnd = controls.indexOf('</CollapsibleSearchSection>', imageQueryStart)
  const imageQuerySection = controls.slice(imageQueryStart, imageQueryEnd)
  assert.ok(imageQueryStart > 0 && imageQueryEnd > imageQueryStart)
  assert.match(imageQuerySection, /expanded=\{true\}/)
  assert.match(imageQuerySection, /collapsible=\{false\}/)
  assert.match(imageQuerySection, /\bpinned\b/)
  assert.doesNotMatch(imageQuerySection, /onToggle=/)
  assert.match(panel, /id === 'query' \? true : expanded/)

  assert.match(styles, /\.search-control-section\s*\{[\s\S]*border-radius:/)
  assert.match(styles, /\.search-control-section__header\s*\{[\s\S]*grid-template-columns:/)
  assert.match(styles, /\.search-control-section__copy\s*\{[\s\S]*gap: 4px/)
  assert.match(styles, /\.search-control-section__copy strong\s*\{[\s\S]*line-height: 1\.4/)
  assert.match(styles, /\.search-control-section__copy small\s*\{[\s\S]*line-height: 1\.55/)
  assert.match(styles, /\.search-control-section__copy small\s*\{[\s\S]*letter-spacing: 0\.015em/)
  assert.match(
    styles,
    /\.search-control-section__icon\s*\{[\s\S]*color: rgb\(var\(--color-text-muted\)\)/,
  )
  assert.match(styles, /\.search-control-section__icon-svg\s*\{[\s\S]*width: 16px/)
  assert.doesNotMatch(styles, /--search-section-accent/)
  assert.match(styles, /\.image-search-controls\s*\{\s*display: contents;/)
  assert.match(styles, /\.search-control-section--query\s*\{\s*order: 1;/)
  assert.match(
    styles,
    /\.search-control-section\[data-pinned='true'\]\s*\{[\s\S]*position: sticky;[\s\S]*top: 0;/,
  )
  const workflowSectionRule = styles.match(/\.search-control-section\s*\{([\s\S]*?)\}/)?.[1]
  assert.ok(workflowSectionRule)
  assert.doesNotMatch(workflowSectionRule, /border-left:/)
  assert.match(styles, /\.search-control-section__body\[hidden\]/)
  assert.match(
    styles,
    /\.search-control-sections-toolbar__primary \.search-experience-mode\s*\{[\s\S]*?border: 0/,
  )
  assert.doesNotMatch(styles, /\.search-control-section--sources \.search-experience-mode/)
})

test('video indexing uses the same four collapsible workflow sections', () => {
  const panel = source('src/components/MediaSearchPanel.tsx')
  const controls = source('src/components/MediaSearchControls.tsx')

  for (const id of ['sources', 'library', 'query', 'maintenance']) {
    assert.match(controls, new RegExp(`testId="media-search-${id}-section"`))
  }
  assert.match(panel, /sources: true/)
  assert.match(panel, /library: true/)
  assert.match(panel, /query: true/)
  assert.match(panel, /maintenance: false/)
  assert.match(controls, /Video sources/)
  assert.match(controls, /Video library preparation/)
  assert.match(controls, /Video search/)
  assert.match(controls, /AI semantics and maintenance/)
  const videoQueryStart = controls.indexOf('id="media-search-query-section"')
  const videoQueryEnd = controls.indexOf('</CollapsibleSearchSection>', videoQueryStart)
  const videoQuerySection = controls.slice(videoQueryStart, videoQueryEnd)
  assert.ok(videoQueryStart > 0 && videoQueryEnd > videoQueryStart)
  assert.match(videoQuerySection, /expanded=\{true\}/)
  assert.match(videoQuerySection, /collapsible=\{false\}/)
  assert.match(videoQuerySection, /\bpinned\b/)
  assert.doesNotMatch(videoQuerySection, /onToggle=/)
  assert.match(panel, /id === 'query' \? true : expanded/)
  assert.match(controls, /onSetAllSectionsExpanded\(true\)/)
  assert.match(controls, /onSetAllSectionsExpanded\(false\)/)
  assert.match(
    controls,
    /<SearchControlSectionsToolbar[\s\S]*?leadingControl=\{modeControl\}[\s\S]*?\/>/,
  )
  assert.doesNotMatch(controls, /modelReadinessControl|SearchModelReadinessBar/)
  assert.match(controls, /disabled=\{running \|\| !dinoModelReady\}/)
  assert.match(controls, /disabled=\{running \|\| !clipModelReady\}/)
  assert.doesNotMatch(panel, /media-search-model-readiness|SearchModelReadinessBar/)
  assert.match(panel, /const latestModels = await refreshManagedModels\(\)/)
  assert.match(panel, /const canSearchFrames =\s*queryModelReady &&/)
  const videoSourcesStart = controls.indexOf('id="media-search-sources-section"')
  const videoSourcesEnd = controls.indexOf('</CollapsibleSearchSection>', videoSourcesStart)
  assert.ok(videoSourcesStart > 0 && videoSourcesEnd > videoSourcesStart)
  assert.doesNotMatch(controls.slice(videoSourcesStart, videoSourcesEnd), /\{modeControl\}/)
  assert.match(panel, /maintenanceStatus=\{maintenanceControlStatus\}/)
})

test('managed model readiness requires verified files and blocks AI tasks while stale or busy', () => {
  const initial = createInitialManagedSearchModelStatuses()
  assert.equal(isManagedSearchModelReady(initial.dinov2_vitb14), false)
  assert.deepEqual(resolveManagedSearchModelReadiness(initial, true, null), {
    state: 'checking',
    canExecuteAiTasks: false,
    readyCount: 0,
    totalCount: 2,
    unavailableModels: ['dinov2_vitb14', 'clip_vit_base_patch32'],
  })

  const ready = {
    dinov2_vitb14: {
      name: 'dinov2_vitb14',
      state: 'downloaded',
      installedPath: 'C:\\models\\dino.onnx',
    },
    clip_vit_base_patch32: {
      name: 'clip_vit_base_patch32',
      state: 'loaded',
      installedPath: 'C:\\models\\clip.onnx',
    },
  }
  assert.equal(isManagedSearchModelReady(ready.dinov2_vitb14), true)
  assert.equal(resolveManagedSearchModelReadiness(ready, false, null).canExecuteAiTasks, true)
  assert.equal(resolveManagedSearchModelReadiness(ready, false, null).state, 'ready')

  const missingPath = {
    ...ready,
    clip_vit_base_patch32: { name: 'clip_vit_base_patch32', state: 'verified' },
  }
  assert.equal(isManagedSearchModelReady(missingPath.clip_vit_base_patch32), false)
  assert.equal(resolveManagedSearchModelReadiness(missingPath, false, null).state, 'blocked')

  const busy = {
    ...ready,
    clip_vit_base_patch32: { name: 'clip_vit_base_patch32', state: 'downloading' },
  }
  assert.equal(resolveManagedSearchModelReadiness(busy, false, null).state, 'busy')
  assert.equal(resolveManagedSearchModelReadiness(ready, false, 'IPC unavailable').state, 'error')
})

test('managed model hook refreshes task dependencies without rendering duplicate panel status', () => {
  const hook = source('src/hooks/useManagedSearchModels.ts')
  const imagePanel = source('src/components/ImageSearchPanel.tsx')
  const mediaPanel = source('src/components/MediaSearchPanel.tsx')

  assert.match(hook, /Promise\.all\([\s\S]*api\.getModelStatus\(name\)/)
  assert.match(hook, /api\.onModelStatusChanged/)
  assert.match(hook, /isManagedSearchModelName\(status\.name\)/)
  assert.match(imagePanel, /const latestModels = await refreshManagedModels\(\)/)
  assert.match(mediaPanel, /const latestModels = await refreshManagedModels\(\)/)
  assert.doesNotMatch(imagePanel, /SearchModelReadinessBar/)
  assert.doesNotMatch(mediaPanel, /SearchModelReadinessBar/)
})
