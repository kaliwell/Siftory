const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { buildGlobalModelReadiness, canExecuteGlobalModelTask, GLOBAL_MANAGED_MODEL_NAMES } =
  loadTsModule('src/services/globalModelReadiness.ts')

const root = path.resolve(__dirname, '..')

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

const userSlotIds = [
  'subject-detector',
  'face-detector',
  'face-embedder',
  'person-reid',
  'segment-encoder',
  'segment-decoder',
]

function readyManaged(name) {
  return { name, state: 'verified', installedPath: `C:\\models\\${name}.onnx` }
}

function baseInput(overrides = {}) {
  return {
    managedStatuses: {},
    userSlots: [],
    userRuntimeStatuses: null,
    videoSemantic: null,
    audioSemantic: null,
    checking: false,
    checkedAt: 1,
    ...overrides,
  }
}

test('global inventory always accounts for all thirteen functional model dependencies', () => {
  const initial = buildGlobalModelReadiness(
    baseInput({ checking: true, checkedAt: null, userSlots: null }),
  )
  assert.equal(initial.totalCount, 13)
  assert.equal(initial.readyCount, 0)
  assert.equal(initial.state, 'checking')
  assert.equal(
    initial.items.every((item) => item.state === 'checking'),
    true,
  )

  assert.deepEqual(GLOBAL_MANAGED_MODEL_NAMES, [
    'dinov2_vitb14',
    'clip_vit_base_patch32',
    'clip_vit_b32_multilingual_v1_text',
  ])
  assert.deepEqual(
    new Set(initial.items.map((item) => item.id)),
    new Set([
      ...GLOBAL_MANAGED_MODEL_NAMES,
      'qwen3-vl',
      'sensevoice',
      'fsmn-vad',
      'campplus-speaker',
      ...userSlotIds,
    ]),
  )
})

test('verified managed, external, diarization, and user models become executable', () => {
  const snapshot = buildGlobalModelReadiness(
    baseInput({
      managedStatuses: Object.fromEntries(
        GLOBAL_MANAGED_MODEL_NAMES.map((name) => [name, readyManaged(name)]),
      ),
      userSlots: userSlotIds.map((id) => ({
        id,
        installed: true,
        inspection: { compatible: true, warnings: [] },
      })),
      userRuntimeStatuses: userSlotIds.map((slotId) => ({
        slotId,
        state: 'ready',
        checkedAt: 1,
      })),
      videoSemantic: { runtime: { state: 'ready' } },
      audioSemantic: {
        runtime: { state: 'ready' },
        diarization: {
          state: 'ready',
          vadModel: { modelId: 'fsmn', modelRevision: '1' },
          speakerModel: { modelId: 'campplus', modelRevision: '1' },
        },
      },
    }),
  )

  assert.equal(snapshot.totalCount, 13)
  assert.equal(snapshot.readyCount, 13)
  assert.equal(snapshot.state, 'ready')
  assert.equal(
    snapshot.items.every((item) => item.state === 'ready'),
    true,
  )
  assert.equal(snapshot.items.filter((item) => item.runtimeChecked).length, 10)
  assert.equal(canExecuteGlobalModelTask(snapshot, ['segment-encoder', 'segment-decoder']), true)
})

test('deep runtime failures override import-time graph inspection and gate dependent tasks', () => {
  const snapshot = buildGlobalModelReadiness(
    baseInput({
      managedStatuses: {
        dinov2_vitb14: readyManaged('dinov2_vitb14'),
      },
      userSlots: [
        {
          id: 'segment-encoder',
          installed: true,
          inspection: { compatible: true, warnings: [] },
        },
        {
          id: 'segment-decoder',
          installed: true,
          inspection: { compatible: true, warnings: [] },
        },
      ],
      userRuntimeStatuses: [
        { slotId: 'segment-encoder', state: 'ready', checkedAt: 1 },
        { slotId: 'segment-decoder', state: 'error', checkedAt: 1, error: 'load failed' },
      ],
    }),
  )

  assert.equal(snapshot.state, 'partial')
  assert.equal(snapshot.items.find((item) => item.id === 'segment-decoder').state, 'error')
  assert.equal(canExecuteGlobalModelTask(snapshot, ['segment-encoder', 'segment-decoder']), false)
  assert.equal(canExecuteGlobalModelTask(snapshot, ['dinov2_vitb14']), true)
})

test('model management stays reachable from tasks/settings and explicit deep checks use the isolated runtime', () => {
  const navigator = source('src/components/WorkspaceNavigator.tsx')
  const panel = source('src/components/GlobalModelReadinessPanel.tsx')
  const hook = source('src/hooks/useGlobalModelReadiness.ts')
  const session = source('electron/userModelSessionService.ts')
  const vectorIpc = source('electron/vectorIpc.ts')
  const preload = source('electron/preload.ts')
  const imagePanel = source('src/components/ImageSearchPanel.tsx')
  const mediaPanel = source('src/components/MediaSearchPanel.tsx')
  const subjectPicker = source('src/components/SubjectPickerModal.tsx')

  assert.match(navigator, /<ProductReadinessCenter/)
  assert.match(navigator, /workspace-open-model-settings/)
  assert.match(source('src/components/ProductReadinessCenter.tsx'), /modelManagerRef/)
  assert.match(source('src/components/SettingsPanel.tsx'), /<VectorSettings/)
  assert.doesNotMatch(navigator, /useGlobalModelReadiness/)
  assert.match(panel, /data-testid="global-model-readiness"/)
  for (const id of [
    ...GLOBAL_MANAGED_MODEL_NAMES,
    'qwen3-vl',
    'sensevoice',
    'fsmn-vad',
    'campplus-speaker',
    ...userSlotIds,
  ]) {
    assert.ok(panel.includes(id), `missing navigation model ${id}`)
  }

  assert.match(hook, /getVideoSemanticStatus\(undefined, deep\)/)
  assert.match(hook, /getAudioSemanticStatus\(deep\)/)
  assert.match(hook, /api\.vector\.checkUserModelSlots\(\)/)
  assert.match(hook, /if \(!deep && deepInFlightRef\.current\) return/)
  assert.match(session, /for \(const slot of USER_MODEL_SLOTS\)/)
  assert.match(session, /await acquireUserModelSession\(slot\.id\)/)
  assert.match(vectorIpc, /vector:checkUserModelSlots/)
  assert.match(preload, /vector:checkUserModelSlots/)

  assert.doesNotMatch(imagePanel, /SearchModelReadinessBar|image-search-model-readiness/)
  assert.doesNotMatch(mediaPanel, /SearchModelReadinessBar|media-search-model-readiness/)
  assert.doesNotMatch(subjectPicker, /Fine segmentation model is unavailable/)
  assert.match(subjectPicker, /window\.electronAPI\.sam[\s\S]*\.status\(\)/)
})
