// Test-only Electron bridge. These are synthetic assets and IPC responses, not a native-client test.
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '../../src/App'
import { useStore } from '../../src/stores/useStore'
import '../../src/styles/global.css'
const picture =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#a8bdcf"/><rect x="80" y="70" width="240" height="160" rx="12" fill="#eff3f8"/></svg>',
  )
let sourceRevision = 1
let profile = 'balanced'
let failSettings = false
let failResourceProfile = false
let searchResultCount = 8
const methodDelays: Record<string, number> = {}
const inFlight: Record<string, number> = {}
const maximumInFlight: Record<string, number> = {}
const events: string[] = []
const eventMounts: Array<{ name: string; mounted: boolean }> = []
for (const name of [
  'workspace-sources-focus',
  'workspace-prepare-library-focus',
  'workspace-first-search-focus',
  'workspace-open-model-settings',
])
  window.addEventListener(name, () => {
    events.push(name)
    const id =
      name === 'workspace-open-model-settings'
        ? 'settings'
        : name === 'workspace-first-search-focus'
          ? 'unified-search'
          : 'image-search'
    eventMounts.push({
      name,
      mounted: Boolean(document.querySelector(`[data-panel="${id}"]`)?.getClientRects().length),
    })
  })
const delays: Record<string, number> = {}
const calls: Array<{ method: string; args: unknown[] }> = []
const stats = () => ({
  lanes: { local: { running: 0, queued: 0 }, gpu: { running: 0, queued: 0 } },
  resource: {
    profile,
    effectiveLocalConcurrency: 2,
    effectiveGpuConcurrency: 1,
    pressureReasons: [],
    backgroundPaused: false,
  },
})
const source = () => ({
  id: 'fixtures',
  displayName: '素材目录 ' + sourceRevision,
  type: 'local-ntfs',
  rootLocator: 'C:/fixtures',
  availability: 'online',
  scanCapability: 'directory',
  readOnly: true,
  fileCount: 8,
  totalBytes: 10000,
})
const items = Array.from({ length: 8 }, (_, i) => ({
  fileEntryId: `fixture-${i}`,
  assetId: `asset-${i}`,
  mediaType: 'image',
  displayName: `参考素材_${i}.jpg`,
  displayPath: `C:/fixtures/scene-${i}.jpg`,
  sizeBytes: 1200000,
  modifiedAt: 1,
  source: { id: 'fixtures', name: '产品素材', type: 'local-ntfs', availability: 'online' },
  indexState: ['full'],
  evidence: [],
}))
let selectedDisplayScope = { mode: 'primary' }
const topology = () => ({
  scope: selectedDisplayScope,
  displays: [],
  workArea: { x: 0, y: 0, width: innerWidth, height: innerHeight, displays: [] },
})
const idle = {
  state: 'idle',
  total: 0,
  completed: 0,
  failed: 0,
  pending: 0,
  running: 0,
  skipped: 0,
}
let persistedSettings: any = {
  displayScope: { mode: 'all' },
  language: 'zh-CN',
  themeId: 'midnight-dark',
  themeMode: 'dark',
  showClock: true,
  showPrompts: true,
  showRemoteTerminal: true,
  showUnifiedSearch: true,
  showSettings: true,
  panelVisibilityDefaultsVersion: 999,
  panelSizeDefaultsVersion: 999,
  fmFavorites: [{ path: 'C:/kept', name: 'Kept' }],
  firstRunGuide: {
    schema: 1,
    status: 'dismissed',
    lastStep: 'models',
    updatedAt: 1,
    completedSteps: [],
    firstSearchCompleted: false,
  },
}
const handlers: Record<string, (...args: any[]) => any> = {
  loadSettings: () =>
    JSON.parse(
      sessionStorage.getItem('workspace-ui-settings') || JSON.stringify(persistedSettings),
    ),
  loadConfig: () => null,
  saveSettings: (settings: any) => {
    if (failSettings) throw new Error('Synthetic disk write failed')
    persistedSettings = structuredClone(settings)
    sessionStorage.setItem('workspace-ui-settings', JSON.stringify(settings))
  },
  saveConfig: () => ({ ok: true }),
  setIgnoreMouseEvents: () => true,
  getWorkArea: () => topology().workArea,
  setDisplayScope: (scope: { mode: string }) => {
    selectedDisplayScope = scope
    return topology()
  },
  getDisplayTopology: topology,
  setOverlayShape: () => ({ x: 0, y: 0 }),
  getWindowAlwaysOnTop: () => false,
  setWindowAlwaysOnTop: (value: boolean) => value,
  getHotkeyStatus: () => ({ active: false, entries: [] }),
  getAiControlSettings: () => ({
    enabled: false,
    running: false,
    port: 32145,
    address: 'http://127.0.0.1:32145/v1',
    tokenAvailable: false,
    tokenScopes: ['read'],
    auditEntries: 0,
    pendingConfirmations: 0,
  }),
  'unifiedSearch.saveFeedback': () => ({ ok: true, feedbackId: 'synthetic-feedback' }),
  'unifiedSearch.getSchedulerStats': stats,
  'unifiedSearch.setResourceProfile': (value: string) => {
    if (failResourceProfile) return { ok: false, error: 'Synthetic profile failure' }
    profile = value
    return { ok: true, stats: stats() }
  },
  'unifiedSearch.cancelBackgroundTasks': () => ({ cancelled: 0 }),
  'unifiedSearch.query': (request: any) =>
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            items: Array.from({ length: searchResultCount }, (_, index) => ({
              ...items[index % items.length],
              fileEntryId: `fixture-${index}`,
              displayName: (request.query ?? '') + ' ' + index + '.jpg',
            })).slice(request.offset ?? 0, Math.min(500, (request.offset ?? 0) + request.limit)),
            total: searchResultCount,
            lanes: [],
            aiEnhancement: 'ready',
          }),
        delays[request.query] ?? 0,
      ),
    ),
  'unifiedSearch.setVisiblePaths': () => ({ bumped: 0 }),
  'discoveryCatalog.listSources': () => [source()],
  'discoveryCatalog.getScanStatus': () => [],
  'remoteTerminal.listProfiles': () => [],
  'assetLibrary.listCollections': () => [{ id: 1, name: '常用参考' }],
  'assetLibrary.listCollectionItems': () => [],
  'imageSearch.getStatus': () => ({
    state: 'idle',
    indexedCount: 8,
    pendingCount: 0,
    message: 'Ready',
  }),
  'imageSearch.selectImage': () => 'C:/fixtures/reference.jpg',
  'imageSearch.search': () => ({
    results: [
      { path: 'C:/fixtures/original.jpg', score: 0.99, distance: 1, width: 160, height: 120 },
    ],
    status: { state: 'idle', indexedCount: 8, pendingCount: 0 },
    queryHash: '0123456789abcdef',
    scannedCount: 8,
    candidateCount: 1,
    searchMs: 1,
  }),
  'vector.searchLayered': (request: any) => ({
    results: [
      {
        imageId: 'original',
        path: 'C:/fixtures/original.jpg',
        finalScore: 0.99,
        hashScore: 0.99,
        vectorScore: 0.9,
        colorScore: 0.8,
        shapeScore: 0.8,
        localFeatureScore: 0,
        ocrScore: 0,
        matchLevel: 'exact',
        reasons: [],
        indexSources: ['hash', 'vector'],
        width: 160,
        height: 120,
      },
    ],
    mode: request.mode,
    searchMode: request.mode,
    degraded: false,
    degradationReasons: [],
    hashCandidateCount: 1,
    mergedCandidateCount: 1,
    totalMs: 1,
  }),
  'imageSearch.listDrives': () => [],
  'imageSearch.getPreparationProgress': () => ({
    state: 'idle',
    taskId: '',
    phase: 'idle',
    message: '',
  }),
  'imageSearch.getThumbnailRebuildProgress': () => idle,
  'imageSearch.getFolderDataEditProgress': () => ({ state: 'idle' }),
  'imageSearch.pasteClipboardImage': () => ({ ok: true, path: 'C:/fixtures/pasted.jpg' }),
  'vector.getEmbeddingProgress': () => idle,
  'vector.getVectorIndexStatus': () => ({ built: true, count: 8 }),
  'vector.getModelStatus': (name: string) => ({ name, state: 'not-downloaded' }),
  'vector.listUserModelSlots': () => [],
  'vector.getSettings': () => ({
    enabled: false,
    rerankEnabled: false,
    maxConcurrency: 2,
    backend: 'cpu',
    textEncoder: 'auto',
  }),
  'mediaSearch.getStatus': () => ({
    state: 'idle',
    videoCount: 0,
    indexedFrameCount: 0,
    ffmpegConfigured: false,
    ffprobeConfigured: false,
    updatedAt: 1,
  }),
  'mediaSearch.getTaskProgress': () => [],
  'assetLibrary.getStats': () => ({
    totalAssets: 0,
    classifiedAssets: 0,
    unclassifiedAssets: 0,
    suggestedCount: 0,
    lowConfidenceCount: 0,
    categoryCount: 0,
    tagCount: 0,
    clusterCount: 0,
    referenceCount: 0,
    archivedAssets: 0,
    storageState: 'ready',
    storageCorruptRows: 0,
  }),
  'assetLibrary.listCategories': () => [],
  'assetLibrary.listTags': () => [],
  'assetLibrary.listSmartAlbums': () => [],
  'assetLibrary.listSuggestions': () => ({ items: [], total: 0 }),
  'assetLibrary.listClusters': () => [],
  'assetLibrary.getTaskProgress': () => ({ state: 'idle', kind: '', processed: 0, total: 0 }),
  'assetLibrary.getFeedbackStatus': () => ({
    state: 'missing',
    enabled: false,
    modelName: 'clip_vit_base_patch32',
    revision: 1,
    builtRevision: 0,
    targetCount: 0,
    positiveSampleCount: 0,
    negativeSampleCount: 0,
    positivePrototypeCount: 0,
    negativePrototypeCount: 0,
    embeddedSampleCount: 0,
    skippedSampleCount: 0,
    updatedAt: 0,
  }),
  'assetLibrary.listAssets': () => ({ items: [], total: 0 }),
  'mediaSearch.getVideoSemanticStatus': () => ({
    runtime: { adapterId: 'qwen3-vl', state: 'not-installed' },
    indexState: 'empty',
    activeVideos: 0,
    activeSegments: 0,
    profileOverride: 'auto',
    profiles: [],
    jobs: [],
    canBuild: false,
    canStop: false,
    canResume: false,
    updatedAt: 1,
  }),
  'mediaSearch.getAudioSemanticStatus': () => ({
    runtime: { adapterId: 'sensevoice', state: 'not-installed' },
    diarization: { state: 'not-installed' },
    indexState: 'empty',
    indexedVideos: 0,
    indexedSegments: 0,
    eligibleVideos: 0,
    capabilities: {},
    canBuild: false,
    canStop: false,
    canResume: false,
    modelDownloadRequired: true,
    updatedAt: 1,
  }),
  fmGetFileIcons: (values: any[]) => values.map((item) => ({ path: item.path, dataUrl: picture })),
  fmGetThumbnailsBatch: (values: any[]) =>
    values.map((item) => ({ path: item.path, dataUrl: picture })),
  fmGetThumbnail: () => ({ dataUrl: picture }),
}
const api = (prefix = ''): any =>
  new Proxy(() => {}, {
    get: (_, key) =>
      key === 'then' ? undefined : api(prefix ? prefix + '.' + String(key) : String(key)),
    apply: (_, __, args) => {
      const name = prefix.split('.').at(-1)!
      if (name.startsWith('on')) return () => {}
      calls.push({ method: prefix, args })
      inFlight[prefix] = (inFlight[prefix] ?? 0) + 1
      maximumInFlight[prefix] = Math.max(maximumInFlight[prefix] ?? 0, inFlight[prefix])
      return Promise.resolve()
        .then(() =>
          methodDelays[prefix]
            ? new Promise((resolve) => setTimeout(resolve, methodDelays[prefix]))
            : undefined,
        )
        .then(() => (handlers[prefix] ? handlers[prefix](...args) : { ok: true }))
        .finally(() => {
          inFlight[prefix]--
        })
    },
  })
;(window as any).electronAPI = api()
;(window as any).__workspaceTest = {
  store: useStore,
  calls,
  events,
  eventMounts,
  maximumInFlight,
  getSettings: () => structuredClone(persistedSettings),
  failSettings: (value: boolean) => {
    failSettings = value
  },
  failResourceProfile: (value: boolean) => {
    failResourceProfile = value
  },
  setResultCount: (value: number) => {
    searchResultCount = value
  },
  delayMethod: (name: string, delay: number) => {
    methodDelays[name] = delay
  },
  delayQuery: (query: string, delay: number) => {
    delays[query] = delay
  },
  addSource: () => {
    sourceRevision++
  },
  dispatch: (name: string) => window.dispatchEvent(new Event(name)),
}
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
