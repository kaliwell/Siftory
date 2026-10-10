const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const service = loadTsModule('electron/imageSearchFolderDataService.ts')

const temporaryRoots = []

function embeddingRow(imageId, modelName) {
  return JSON.stringify({
    imageId,
    modelName,
    modelVersion: 'test',
    embeddingType: 'global',
    dim: 2,
    vector: [1, 0],
    norm: 1,
    createdAt: 1,
    updatedAt: 1,
  })
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-data-edit-'))
  temporaryRoots.push(root)
  const userData = path.join(root, 'user-data')
  const target = path.join(root, 'dataset', 'images')
  const adjacent = path.join(root, 'dataset', 'images-old')
  fs.mkdirSync(target, { recursive: true })
  fs.mkdirSync(adjacent, { recursive: true })
  const targetA = path.join(target, 'a.jpg')
  const targetB = path.join(target, 'b.jpg')
  const adjacentImage = path.join(adjacent, 'keep.jpg')
  const otherImage = path.join(root, 'other.jpg')
  for (const filePath of [targetA, targetB, adjacentImage, otherImage]) {
    fs.writeFileSync(filePath, 'source-image')
  }

  const embeddings = path.join(userData, 'vector-db', 'embeddings')
  const cache = path.join(userData, 'vector-db', 'embedding-cache')
  fs.mkdirSync(embeddings, { recursive: true })
  fs.mkdirSync(cache, { recursive: true })
  const dino = path.join(embeddings, 'dinov2_vitb14__global.jsonl')
  const dinoAlt = path.join(embeddings, 'dinov2_alt__global.jsonl')
  const clip = path.join(embeddings, 'clip_vit_base_patch32__global.jsonl')
  fs.writeFileSync(
    dino,
    [
      embeddingRow(targetA, 'dinov2_vitb14'),
      embeddingRow(targetA, 'dinov2_vitb14'),
      embeddingRow(adjacentImage, 'dinov2_vitb14'),
      embeddingRow(otherImage, 'dinov2_vitb14'),
      '{malformed-row',
    ].join('\n') + '\n',
  )
  fs.writeFileSync(
    dinoAlt,
    [embeddingRow(targetA, 'dinov2_alt'), embeddingRow(otherImage, 'dinov2_alt')].join('\n') + '\n',
  )
  fs.writeFileSync(
    clip,
    [
      embeddingRow(targetB, 'clip_vit_base_patch32'),
      embeddingRow(adjacentImage, 'clip_vit_base_patch32'),
    ].join('\n') + '\n',
  )

  for (const name of [
    'dinov2_vitb14__global.f16.json',
    'dinov2_vitb14__global.f16',
    'dinov2_vitb14__global.paths.jsonl',
    'dinov2_vitb14__global.ann-simhash-v1.json',
    'dinov2_vitb14__global.ann-simhash-v1.bin',
  ]) {
    fs.writeFileSync(path.join(cache, name), 'derived')
  }
  for (const name of [
    'clip_embedding_cache.json',
    'clip_embedding_cache.f32',
    'clip_embedding_paths.jsonl',
    'vector_index_manifest.json',
  ]) {
    fs.writeFileSync(path.join(userData, 'vector-db', name), 'derived')
  }
  return {
    root,
    userData,
    target,
    targetA,
    targetB,
    adjacentImage,
    otherImage,
    embeddings,
    cache,
    dino,
    dinoAlt,
    clip,
  }
}

test.afterEach(() => {
  service.resetImageSearchFolderDataEditForTests()
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true })
  }
})

test('folder edit previews and atomically removes Native, DINO, and CLIP data by path boundary', async () => {
  const data = fixture()
  const preview = await service.previewImageSearchFolderDataEdit({
    userDataPath: data.userData,
    folder: data.target,
    layers: ['native', 'dino', 'clip'],
    // Historical indexed folders remain editable even after being removed from settings.
    allowedRoots: [],
    nativeStats: { count: 3, totalBytes: 1234 },
  })

  assert.equal(preview.ok, true)
  assert.equal(preview.native.count, 3)
  assert.equal(preview.dino.count, 1)
  assert.equal(preview.dino.recordCount, 3)
  assert.equal(preview.clip.count, 1)
  assert.equal(preview.clip.recordCount, 1)
  assert.ok(preview.temporaryBytes > 0)

  let runtimeInvalidations = 0
  const result = await service.executeImageSearchFolderDataEdit({
    userDataPath: data.userData,
    token: preview.token,
    allowedRoots: [],
    hooks: {
      deleteNative: async () => ({ ok: true, removedCount: 3 }),
      cleanupAuxiliary: async () => ({ removed: 4 }),
      invalidateRuntimeCaches: () => {
        runtimeInvalidations++
      },
    },
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.removed, { native: 3, dino: 1, clip: 1 })
  assert.deepEqual(result.removedRecords, { native: 3, dino: 3, clip: 1 })
  assert.equal(result.auxiliaryRemoved, 4)
  assert.equal(result.backupCount, 3)
  assert.equal(result.pendingReleaseBytes, preview.dino.matchedBytes + preview.clip.matchedBytes)
  assert.equal(runtimeInvalidations, 1)

  const dinoAfter = fs.readFileSync(data.dino, 'utf8')
  const dinoAltAfter = fs.readFileSync(data.dinoAlt, 'utf8')
  const clipAfter = fs.readFileSync(data.clip, 'utf8')
  const imageIds = (text) =>
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line).imageId]
        } catch {
          return []
        }
      })
  const dinoIds = imageIds(dinoAfter)
  const clipIds = imageIds(clipAfter)
  assert.equal(dinoIds.includes(data.targetA), false)
  assert.equal(imageIds(dinoAltAfter).includes(data.targetA), false)
  assert.equal(clipIds.includes(data.targetB), false)
  assert.equal(dinoIds.includes(data.adjacentImage), true)
  assert.equal(clipIds.includes(data.adjacentImage), true)
  assert.equal(dinoIds.includes(data.otherImage), true)
  assert.equal(dinoAfter.includes('{malformed-row'), true)

  // Index editing never touches source images, even when every layer is selected.
  assert.equal(fs.readFileSync(data.targetA, 'utf8'), 'source-image')
  assert.equal(fs.readFileSync(data.targetB, 'utf8'), 'source-image')

  const backupNames = fs.readdirSync(data.embeddings)
  assert.equal(backupNames.filter((name) => name.includes('.gc-backup-')).length, 6)
  assert.equal(fs.existsSync(path.join(data.cache, 'dinov2_vitb14__global.f16.json')), false)
  assert.equal(
    fs.existsSync(path.join(data.userData, 'vector-db', 'clip_embedding_cache.json')),
    false,
  )
  assert.equal(service.getImageSearchFolderDataEditProgress().state, 'completed')
})

test('folder edit refuses a stale preview without changing the shard', async () => {
  const data = fixture()
  const preview = await service.previewImageSearchFolderDataEdit({
    userDataPath: data.userData,
    folder: data.target,
    layers: ['dino'],
    allowedRoots: [path.dirname(data.target)],
    nativeStats: { count: 0, totalBytes: 0 },
  })
  assert.equal(preview.ok, true)
  fs.appendFileSync(data.dino, `${embeddingRow(data.otherImage, 'dinov2_vitb14')}\n`)
  const before = fs.readFileSync(data.dino, 'utf8')

  const result = await service.executeImageSearchFolderDataEdit({
    userDataPath: data.userData,
    token: preview.token,
    allowedRoots: [path.dirname(data.target)],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /changed after preview/)
  assert.equal(fs.readFileSync(data.dino, 'utf8'), before)
  assert.equal(
    fs.readdirSync(data.embeddings).some((name) => name.includes('.gc-backup-')),
    false,
  )
})

test('folder edit refuses an oversized JSONL row without changing any shard', async () => {
  const data = fixture()
  const handle = fs.openSync(data.dino, 'w')
  try {
    fs.writeSync(handle, Buffer.alloc(8 * 1024 * 1024 + 1, 0x78))
  } finally {
    fs.closeSync(handle)
  }
  const before = fs.readFileSync(data.dino)

  const preview = await service.previewImageSearchFolderDataEdit({
    userDataPath: data.userData,
    folder: data.target,
    layers: ['dino'],
    allowedRoots: [path.dirname(data.target)],
    nativeStats: { count: 0, totalBytes: 0 },
  })
  assert.equal(preview.ok, false)
  assert.match(preview.error, /exceeds the safe 8 MiB edit limit/)
  assert.deepEqual(fs.readFileSync(data.dino), before)
  assert.equal(
    fs.readdirSync(data.embeddings).some((name) => name.includes('.folder-edit-')),
    false,
  )
})

test('folder edit preserves retained JSONL rows byte-for-byte', async () => {
  const data = fixture()
  const retainedRow = Buffer.from(`${embeddingRow(data.otherImage, 'dinov2_vitb14')}\r\n`)
  const malformedTail = Buffer.from([0xff, 0xfe, 0x7b])
  fs.writeFileSync(
    data.dino,
    Buffer.concat([
      Buffer.from(`${embeddingRow(data.targetA, 'dinov2_vitb14')}\r\n`),
      retainedRow,
      malformedTail,
    ]),
  )

  const preview = await service.previewImageSearchFolderDataEdit({
    userDataPath: data.userData,
    folder: data.target,
    layers: ['dino'],
    allowedRoots: [path.dirname(data.target)],
    nativeStats: { count: 0, totalBytes: 0 },
  })
  assert.equal(preview.ok, true)

  const result = await service.executeImageSearchFolderDataEdit({
    userDataPath: data.userData,
    token: preview.token,
    allowedRoots: [path.dirname(data.target)],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(fs.readFileSync(data.dino), Buffer.concat([retainedRow, malformedTail]))
})

test('folder boundaries do not treat similarly-prefixed sibling paths as descendants', () => {
  assert.equal(
    service.isImageSearchFolderWithinRoots('D:\\PxHereDataset\\images', ['D:\\PxHereDataset']),
    true,
  )
  assert.equal(
    service.isImageSearchFolderWithinRoots('D:\\PxHereDataset-old\\images', ['D:\\PxHereDataset']),
    false,
  )
})

test('an unconfigured folder with no indexed data is rejected', async () => {
  const data = fixture()
  const preview = await service.previewImageSearchFolderDataEdit({
    userDataPath: data.userData,
    folder: path.join(data.root, 'not-indexed'),
    layers: ['dino', 'clip'],
    allowedRoots: [],
    nativeStats: { count: 0, totalBytes: 0 },
  })
  assert.equal(preview.ok, false)
  assert.match(preview.error, /outside the configured scan paths and has no indexed data/)

  const rootPreview = await service.previewImageSearchFolderDataEdit({
    userDataPath: data.userData,
    folder: path.parse(data.target).root,
    layers: ['dino'],
    allowedRoots: [path.parse(data.target).root],
    nativeStats: { count: 0, totalBytes: 0 },
  })
  assert.equal(rootPreview.ok, false)
  assert.match(rootPreview.error, /below the drive or network-share root/)
})

test('cancelling a long preview leaves every shard byte-for-byte unchanged', async () => {
  const data = fixture()
  const extraRows = Array.from({ length: 5000 }, (_, index) =>
    embeddingRow(path.join(data.target, `bulk-${index}.jpg`), 'dinov2_vitb14'),
  )
  fs.appendFileSync(data.dino, `${extraRows.join('\n')}\n`)
  const before = fs.readFileSync(data.dino)
  const pending = service.previewImageSearchFolderDataEdit({
    userDataPath: data.userData,
    folder: data.target,
    layers: ['dino'],
    allowedRoots: [path.dirname(data.target)],
    nativeStats: { count: 0, totalBytes: 0 },
  })
  service.cancelImageSearchFolderDataEdit()
  const preview = await pending
  assert.equal(preview.ok, false)
  assert.match(preview.error, /cancelled/)
  assert.deepEqual(fs.readFileSync(data.dino), before)
  assert.equal(
    fs.readdirSync(data.embeddings).some((name) => name.includes('.folder-edit-')),
    false,
  )
  assert.equal(service.getImageSearchFolderDataEditProgress().state, 'cancelled')
})
