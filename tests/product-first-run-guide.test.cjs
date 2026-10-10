const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  PRODUCT_FIRST_RUN_GUIDE_STEPS,
  deriveFirstRunGuideView,
  initializeFirstRunGuide,
  normalizeFirstRunGuideSettings,
  reconcileFirstRunGuide,
  updateFirstRunGuide,
} = loadTsModule('src/services/firstRunGuide.ts')

const ROOT = path.resolve(__dirname, '..')

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
}

function readiness({ sources = 0, files = 0, modelsReady = false, searchable = files > 0 } = {}) {
  return {
    state: searchable ? 'searchable' : 'not-started',
    progress: 0,
    searchable,
    stages: [
      {
        id: 'sources',
        state: sources ? 'ready' : 'action-required',
        progress: sources ? 100 : 0,
        reason: sources ? 'source-ready' : 'no-source',
        counts: { sources },
      },
      {
        id: 'catalog',
        state: files ? 'ready' : 'action-required',
        progress: files ? 100 : 0,
        reason: files ? 'catalog-ready' : 'catalog-empty',
        counts: { files },
      },
    ],
    capabilities: {
      metadata: files > 0,
      imageSimilarity: false,
      naturalLanguageImage: false,
      videoFrame: false,
      videoSemantic: false,
      dialogue: false,
    },
    models: [
      {
        id: 'dinov2_vitb14',
        management: 'managed-download',
        state: modelsReady ? 'verified' : 'not-installed',
      },
      {
        id: 'clip_vit_base_patch32',
        management: 'managed-download',
        state: modelsReady ? 'loaded' : 'not-installed',
      },
      { id: 'qwen3-vl', management: 'external-runtime', state: 'not-installed' },
      { id: 'sensevoice', management: 'external-runtime', state: 'not-installed' },
    ],
    tasks: [],
    taskStorage: {},
  }
}

test('fresh profile starts a four-step, ordered, resumable guide', () => {
  const initial = initializeFirstRunGuide(readiness(), null, 100)
  const view = deriveFirstRunGuideView(initial, readiness())
  assert.deepEqual(PRODUCT_FIRST_RUN_GUIDE_STEPS, ['source', 'models', 'catalog', 'search'])
  assert.equal(initial.status, 'active')
  assert.equal(view.visible, true)
  assert.equal(view.currentStep, 'source')
  assert.equal(view.progress, 0)
  assert.deepEqual(
    view.steps.map(({ id, complete }) => [id, complete]),
    [
      ['source', false],
      ['models', false],
      ['catalog', false],
      ['search', false],
    ],
  )
})

test('live source, managed models, catalog, and successful search advance monotonically', () => {
  let state = initializeFirstRunGuide(readiness(), null, 100)
  state = reconcileFirstRunGuide(state, readiness({ sources: 1 }), 200)
  assert.equal(state.lastStep, 'models')

  state = reconcileFirstRunGuide(state, readiness({ sources: 1, modelsReady: true }), 300)
  assert.equal(state.lastStep, 'catalog')

  state = reconcileFirstRunGuide(
    state,
    readiness({ sources: 1, modelsReady: true, files: 12, searchable: false }),
    400,
  )
  assert.equal(state.lastStep, 'search')

  state = updateFirstRunGuide(state, 'search-completed', 500)
  const completeView = deriveFirstRunGuideView(
    state,
    readiness({ sources: 1, modelsReady: true, files: 12 }),
  )
  assert.equal(completeView.currentStep, 'complete')
  assert.equal(completeView.progress, 100)
  assert.equal(completeView.visible, true)

  state = updateFirstRunGuide(state, 'finish', 600)
  assert.equal(state.status, 'completed')
  assert.equal(deriveFirstRunGuideView(state, readiness()).visible, false)
})

test('skip, restart normalization, and reopen retain completed progress', () => {
  let state = initializeFirstRunGuide(readiness({ sources: 1, modelsReady: true }), null, 100)
  state = updateFirstRunGuide(state, 'dismiss', 200)
  const restarted = initializeFirstRunGuide(readiness(), JSON.parse(JSON.stringify(state)), 300)
  assert.equal(restarted.status, 'dismissed')
  assert.deepEqual(restarted.completedSteps, ['source', 'models'])
  assert.equal(restarted.lastStep, 'catalog')
  assert.equal(deriveFirstRunGuideView(restarted, readiness()).visible, false)

  const reopened = updateFirstRunGuide(restarted, 'reopen', 400)
  const view = deriveFirstRunGuideView(reopened, readiness())
  assert.equal(view.visible, true)
  assert.equal(view.currentStep, 'catalog')
  assert.equal(view.progress, 50)
  assert.ok(view.steps.find((step) => step.id === 'source').retainedFromPreviousRun)
})

test('an existing searchable profile is migrated without an onboarding interruption', () => {
  const state = initializeFirstRunGuide(
    readiness({ sources: 1, modelsReady: true, files: 20, searchable: true }),
    undefined,
    100,
  )
  assert.equal(state.status, 'completed')
  assert.equal(state.lastStep, 'complete')
  assert.deepEqual(state.completedSteps, PRODUCT_FIRST_RUN_GUIDE_STEPS)
  assert.equal(deriveFirstRunGuideView(state, readiness()).visible, false)
})

test('persisted guide normalization is bounded and privacy-safe', () => {
  const normalized = normalizeFirstRunGuideSettings(
    {
      schema: 1,
      status: 'active',
      lastStep: 'models',
      completedSteps: ['source', 'source', 'not-a-step'],
      firstSearchCompleted: false,
      updatedAt: Number.MAX_SAFE_INTEGER,
      sourcePath: 'D:\\private-library',
      query: 'private dialogue',
    },
    500,
  )
  assert.deepEqual(normalized.completedSteps, ['source'])
  assert.equal(normalized.updatedAt, 500)
  const serialized = JSON.stringify(normalized)
  assert.doesNotMatch(serialized, /private-library|private dialogue|sourcePath|query/)
  assert.equal(normalizeFirstRunGuideSettings({ schema: 9 }), null)
})

test('guide UI persists immediately, exposes recovery routing, and records real searches only', () => {
  const guide = source('src/components/FirstRunGuide.tsx')
  const navigator = source('src/components/WorkspaceNavigator.tsx')
  const readiness = source('src/components/ProductReadinessCenter.tsx')
  const unified = source('src/components/UnifiedSearchPanel.tsx')
  const image = source('src/components/ImageSearchPanel.tsx')
  const video = source('src/components/MediaSearchPanel.tsx')
  const smoke = source('electron/uiSmokeService.ts')

  for (const testId of ['product-first-run-guide', 'first-run-skip', 'first-run-current-action']) {
    assert.match(guide, new RegExp(testId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(guide, /data-testid=\{`first-run-step-\$\{step\.id\}`\}/)
  assert.match(guide, /scheduleSettingsWrite\(\{ firstRunGuide: next \}\)/)
  assert.match(guide, /flushSettingsWrites\(\)/)
  assert.match(guide, /persisted\.status !== 'active'/)
  assert.doesNotMatch(
    guide,
    /Promise\.all\(\[window\.electronAPI\.loadSettings\(\), loadProductReadiness/,
  )
  assert.match(guide, /workspace-open-first-run-guide/)
  assert.match(navigator, /data-testid="workspace-first-run-guide"/)
  assert.match(navigator, /workspace-open-model-manager/)
  assert.match(navigator, /workspace-prepare-library-focus/)
  assert.match(navigator, /workspace-first-search-focus/)
  assert.match(guide, /source: 'Open source center'/)
  assert.match(guide, /search: 'Open main search'/)
  assert.match(navigator, /focusPanel\('showUnifiedSearch'/)
  assert.match(readiness, /modelManagerRef/)
  assert.match(unified, /announceFirstSearchCompleted\('unified'\)/)
  assert.match(image, /announceFirstSearchCompleted\('image'\)/)
  assert.match(video, /announceFirstSearchCompleted\('video'\)/)
  assert.match(smoke, /firstRunGuideCheck/)
  assert.match(smoke, /dismissedAndHidden/)
  assert.match(smoke, /reopenedAndResumed/)
})
