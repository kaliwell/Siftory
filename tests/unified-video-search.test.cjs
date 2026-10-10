const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadTsModule } = require('./guard-utils.cjs')

const { AssetIdentityService } = loadTsModule('electron/assetIdentityService.ts')
const { SourceCatalogService } = loadTsModule('electron/sourceCatalogService.ts')
const { assignVideoManifestSources, loadVideoManifest } = loadTsModule(
  'electron/videoScanService.ts',
)
const { findReadyVideoFrameById, videoFramePolicyFor } = loadTsModule(
  'electron/videoFrameService.ts',
)
const { clearMediaSearchData, ensureMediaSearchDirs, setMediaSearchDirForTests } = loadTsModule(
  'electron/mediaCacheService.ts',
)
const { videoHitEvidenceLabelKeys, videoHitLabelKey, videoHitModelLabel } = loadTsModule(
  'src/utils/unifiedVideoEvidence.ts',
)

function videoRecord(filePath, sizeBytes, mtimeMs) {
  return {
    videoId: `video-${path.basename(filePath)}`,
    path: filePath,
    name: path.basename(filePath),
    ext: path.extname(filePath),
    sizeBytes,
    mtimeMs,
    durationMs: 90000,
    discoveredAt: 1,
    updatedAt: 1,
  }
}

test('Media Search batch identity projection gives videos stable AssetIds without duplicate writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-video-identity-'))
  try {
    const first = path.join(root, 'first.mp4')
    const second = path.join(root, 'second.mov')
    fs.writeFileSync(first, 'first-video')
    fs.writeFileSync(second, 'second-video')
    const service = new AssetIdentityService(path.join(root, 'asset-library'))
    const initial = await service.resolveManyForPaths([first, second, first])
    assert.equal(initial.length, 2)
    assert.match(initial[0].assetId, /^asset_[0-9a-f]{24}$/)
    assert.match(initial[1].assetId, /^asset_[0-9a-f]{24}$/)
    assert.notEqual(initial[0].assetId, initial[1].assetId)
    assert.equal(service.store.size(), 2)

    const repeated = await service.resolveManyForPaths([first, second])
    assert.deepEqual(
      repeated.map((identity) => identity.assetId).sort(),
      initial.map((identity) => identity.assetId).sort(),
    )
    assert.equal(service.store.size(), 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Media Search video projection preserves Catalog file identity and unified source metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-video-catalog-'))
  const service = new SourceCatalogService({ databasePath: path.join(root, 'catalog.sqlite') })
  try {
    const sourceRoot = path.join(root, 'registered-source')
    const outsideRoot = path.join(root, 'outside-source')
    fs.mkdirSync(sourceRoot)
    fs.mkdirSync(outsideRoot)
    const videoPath = path.join(sourceRoot, 'nested', 'scene.mp4')
    fs.mkdirSync(path.dirname(videoPath))
    fs.writeFileSync(videoPath, 'video-bytes')
    const stat = fs.statSync(videoPath)
    const source = service.addSource({
      type: 'local-generic',
      displayName: 'Video library',
      rootLocator: sourceRoot,
    })
    assert.equal(source.ok, true, source.error)

    const first = service.projectMediaSearchVideos([
      videoRecord(videoPath, stat.size, stat.mtimeMs),
      videoRecord(path.join(outsideRoot, 'outside.mp4'), 10, 1),
    ])
    assert.equal(first.projected, 1)
    assert.equal(first.unmatched, 1)
    assert.deepEqual(first.assignments, [
      { videoId: 'video-scene.mp4', sourceId: source.source.id, sourceType: 'local' },
    ])
    const before = service.queryCatalog({ query: 'scene.mp4' }).items[0]
    assert.equal(before.source.id, source.source.id)
    assert.equal(before.source.name, 'Video library')
    assert.equal(before.sizeBytes, stat.size)
    assert.ok(before.indexState.includes('metadata-ready:ready'))

    const repeated = service.projectMediaSearchVideos([
      videoRecord(videoPath, stat.size, stat.mtimeMs),
    ])
    assert.equal(repeated.projected, 1)
    assert.equal(repeated.unmatched, 0)
    const after = service.queryCatalog({ query: 'scene.mp4' }).items[0]
    assert.equal(after.fileEntryId, before.fileEntryId)
  } finally {
    service.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('unified result UI renders duration and videoId-bound visual/subtitle time actions', () => {
  const ui = fs.readFileSync('src/components/DiscoverySourcesSection.tsx', 'utf8')
  assert.match(ui, /item\.durationMs/)
  assert.match(ui, /item\.videoHits/)
  assert.match(ui, /videoHitLabelKey\(hit\)/)
  assert.match(ui, /videoHitEvidenceLabelKeys\(hit\)/)
  assert.match(
    ui,
    /openMediaAtTime\(\{[\s\S]*videoId: item\.videoId![\s\S]*timestampMs: hit\.timestampMs/,
  )
  assert.doesNotMatch(ui, /openMediaAtTime\(\{[\s\S]*displayPath: item\.displayPath/)
})

test('first-class unified search exposes provenance and model-bound time actions', () => {
  const ui = fs.readFileSync('src/components/UnifiedSearchPanel.tsx', 'utf8')
  assert.match(ui, /data-testid="unified-video-evidence"/)
  assert.match(ui, /videoHitLabelKey\(hit\)/)
  assert.match(ui, /videoHitEvidenceLabelKeys\(hit\)/)
  assert.match(ui, /videoHitModelLabel\(hit\)/)
  assert.match(
    ui,
    /openMediaAtTime\(\{[\s\S]*videoId: item\.videoId![\s\S]*timestampMs: hit\.timestampMs/,
  )
})

test('fused evidence UI reports every source and contributing model authority', () => {
  const hit = {
    timestampMs: 10_000,
    endMs: 14_000,
    score: 0.9,
    kind: 'fused',
    evidenceSources: [
      'cached-frame',
      'ai-visual-semantic',
      'ocr',
      'transcript-reference',
      'audio-event',
    ],
    generatedByAll: [
      { modelId: 'qwen3-vl', modelRevision: 'qwen-revision' },
      { modelId: 'sensevoice', modelRevision: 'sense-revision' },
    ],
  }
  assert.equal(videoHitLabelKey(hit), 'Fused evidence hit')
  assert.deepEqual(videoHitEvidenceLabelKeys(hit), [
    'Cached frame',
    'AI visual semantics',
    'OCR',
    'Transcript reference',
    'Audio event',
  ])
  assert.equal(videoHitModelLabel(hit), 'qwen3-vl@qwen-revision + sensevoice@sense-revision')
})

test('unified video hit previews resolve manifest-owned frames by frameId', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-video-preview-'))
  try {
    const mediaDir = path.join(root, 'media-search')
    const frameId = '0123456789abcdef0123456789abcdef01234567'
    const framePath = path.join(mediaDir, 'frames', 'video-1', `${frameId}.jpg`)
    setMediaSearchDirForTests(mediaDir)
    ensureMediaSearchDirs()
    fs.mkdirSync(path.dirname(framePath), { recursive: true })
    fs.writeFileSync(framePath, 'derived-frame')
    fs.writeFileSync(
      path.join(mediaDir, 'manifests', 'video_frames.jsonl'),
      `${JSON.stringify({
        frameId,
        videoId: 'video-1',
        videoPath: path.join(root, 'original.mp4'),
        timestampMs: 12_000,
        imagePath: framePath,
        status: 'done',
        createdAt: 1,
        updatedAt: 1,
      })}\n`,
    )

    assert.equal(findReadyVideoFrameById(frameId)?.imagePath, framePath)
    assert.equal(findReadyVideoFrameById('../outside.jpg'), null)
    assert.equal(findReadyVideoFrameById('f'.repeat(40)), null)

    const ui = fs.readFileSync('src/components/DiscoverySourcesSection.tsx', 'utf8')
    assert.match(ui, /getFramePreview\(frameId\)/)
    assert.doesNotMatch(ui, /getFramePreview\([^)]*imagePath/)
    const ipc = fs.readFileSync('electron/mediaSearchIpc.ts', 'utf8')
    assert.match(ipc, /findReadyVideoFrameById\(frameId\)/)
    assert.match(ipc, /readMediaSearchImageDataUrl\(frame\.imagePath\)/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('deleting derived Media Search data preserves original videos and stable identities', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-video-clear-'))
  try {
    const mediaDir = path.join(root, 'media-search')
    const original = path.join(root, 'original.mp4')
    fs.writeFileSync(original, 'authoritative-video')
    const identityService = new AssetIdentityService(path.join(root, 'asset-library'))
    const [identity] = await identityService.resolveManyForPaths([original])
    setMediaSearchDirForTests(mediaDir)
    ensureMediaSearchDirs()
    fs.writeFileSync(path.join(mediaDir, 'manifests', 'video_files.jsonl'), '{}\n')
    fs.mkdirSync(path.join(mediaDir, 'frames', 'video-1'), { recursive: true })
    fs.writeFileSync(path.join(mediaDir, 'frames', 'video-1', 'frame.jpg'), 'derived-frame')

    const cleared = clearMediaSearchData()
    assert.equal(cleared.ok, true, cleared.error)
    assert.equal(fs.readFileSync(original, 'utf8'), 'authoritative-video')
    const reloaded = new AssetIdentityService(path.join(root, 'asset-library'))
    assert.equal((await reloaded.findByPath(original))?.assetId, identity.assetId)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('mounted-network videos persist source policy and use bounded batch extraction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-video-network-policy-'))
  try {
    const mediaDir = path.join(root, 'media-search')
    setMediaSearchDirForTests(mediaDir)
    ensureMediaSearchDirs()
    const videoPath = path.join(root, 'mounted-share', 'long.mp4')
    fs.mkdirSync(path.dirname(videoPath), { recursive: true })
    fs.writeFileSync(videoPath, 'video')
    const record = videoRecord(videoPath, 5, 1)
    fs.writeFileSync(
      path.join(mediaDir, 'manifests', 'video_files.jsonl'),
      `${JSON.stringify(record)}\n`,
    )
    assert.equal(
      assignVideoManifestSources([
        { videoId: record.videoId, sourceId: 'src-network', sourceType: 'mounted-network' },
      ]),
      1,
    )
    const persisted = loadVideoManifest()[0]
    assert.equal(persisted.sourceId, 'src-network')
    assert.equal(persisted.sourceType, 'mounted-network')
    assert.deepEqual(videoFramePolicyFor(persisted), {
      mode: 'network-batch',
      maxFramesPerVideo: 240,
      intervalMs: 15000,
      width: 256,
    })
    assert.deepEqual(videoFramePolicyFor(record), {
      mode: 'local-per-frame',
      maxFramesPerVideo: 3600,
      intervalMs: 3000,
      width: 384,
    })

    const frameService = fs.readFileSync('electron/videoFrameService.ts', 'utf8')
    assert.match(frameService, /generateVideoFramesBatchAsync/)
    assert.match(frameService, /for \(const videoJobs of networkJobs\.values\(\)\)/)
    assert.match(frameService, /preferHardwareDecode: false/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
