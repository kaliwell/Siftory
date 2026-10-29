const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { loadTsModule } = require('./guard-utils.cjs')
const { StorageLocationService, LIBRARY_MARKER } = loadTsModule(
  'electron/storageLocationService.ts',
)
const { migrateStorageDirectory } = loadTsModule('electron/storageDirectoryMigration.ts')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'siftory-relocation-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const appData = path.join(root, 'profile')
  const original = path.join(appData, 'floating-clock-electron')
  fs.mkdirSync(original, { recursive: true })
  const service = new StorageLocationService(appData, original)
  const destination = path.join(root, '另一磁盘 新目录')
  const write = (name, content) => {
    const target = path.join(original, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  write('floating_clock_settings.json', '{"theme":"dark","imageSearchScanPaths":["D:/originals"]}')
  write('vector-db/embeddings/clip.jsonl', '{"imageId":"D:/originals/a.jpg","vector":[1,0]}\n')
  write('vector-db/vector-store/values.f16', Buffer.from([0, 1, 128, 255]))
  write('media-search/manifests/video_files.jsonl', '{"path":"D:/originals/video.mp4"}\n')
  write('models/local/model.onnx', Buffer.from([22, 33, 44]))
  service.initialize()
  return { root, appData, original, service, destination, write }
}

test('legacy data is adopted in place with a persistent library identity', (t) => {
  const f = fixture(t)
  assert.equal(f.service.resolveRoot(), f.original)
  const first = f.service.status(false)
  assert.equal(first.backend, 'local')
  assert.equal(
    new StorageLocationService(f.appData, f.original).initialize().libraryId,
    first.libraryId,
  )
  assert.match(
    fs.readFileSync(path.join(f.original, 'floating_clock_settings.json'), 'utf8'),
    /D:\/originals/,
  )
})

test('cold migration preserves SQLite relations, JSONL, binary vectors, models and stable identity', async (t) => {
  const f = fixture(t)
  f.write('asset-library/placeholder', '')
  const database = new DatabaseSync(path.join(f.original, 'asset-library', 'asset-library.sqlite'))
  database.exec(
    "CREATE TABLE collections(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO collections VALUES(17, '保留收藏')",
  )
  database.close()
  const identity = f.service.read().libraryId
  f.service.schedule(f.destination)
  const progress = []
  assert.equal(
    (await migrateStorageDirectory(f.service, { onProgress: (value) => progress.push(value) }))
      .migrated,
    true,
  )
  assert.equal(f.service.resolveRoot(), f.destination)
  assert.equal(f.service.read().libraryId, identity)
  assert.equal(f.service.read().previousRoot, f.original)
  for (const name of [
    'floating_clock_settings.json',
    'vector-db/embeddings/clip.jsonl',
    'vector-db/vector-store/values.f16',
    'models/local/model.onnx',
    'media-search/manifests/video_files.jsonl',
  ])
    assert.deepEqual(
      fs.readFileSync(path.join(f.destination, name)),
      fs.readFileSync(path.join(f.original, name)),
    )
  const copied = new DatabaseSync(path.join(f.destination, 'asset-library', 'asset-library.sqlite'))
  assert.equal(copied.prepare('SELECT name FROM collections WHERE id=17').get().name, '保留收藏')
  assert.equal(copied.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  copied.close()
  assert.ok(progress.some((value) => value.copiedBytes > 0))
  assert.equal(new StorageLocationService(f.appData, f.original).resolveRoot(), f.destination)
})

test('nested roots and existing destinations are rejected without modifying the old data', (t) => {
  const f = fixture(t)
  for (const destination of [f.original, path.join(f.original, 'nested'), f.appData])
    assert.throws(() => f.service.schedule(destination))
  fs.mkdirSync(f.destination)
  assert.throws(() => f.service.schedule(f.destination), /exists/)
  assert.equal(f.service.read().pending, undefined)
})

test('cancellation leaves original root active and partial copy cannot be reconnected', async (t) => {
  const f = fixture(t)
  const controller = new AbortController()
  f.service.schedule(f.destination)
  const result = await migrateStorageDirectory(f.service, {
    signal: controller.signal,
    onProgress: () => controller.abort(),
  })
  assert.equal(result.failed, true)
  assert.equal(f.service.resolveRoot(), f.original)
  assert.equal(fs.existsSync(path.join(f.destination, LIBRARY_MARKER)), false)
  assert.throws(() => f.service.reconnect(f.destination))
  assert.equal(f.service.read().pending, undefined)
})

test('source mutation during copy prevents pointer publication', async (t) => {
  const f = fixture(t)
  f.service.schedule(f.destination)
  let changed = false
  const result = await migrateStorageDirectory(f.service, {
    onProgress: () => {
      if (!changed) {
        changed = true
        f.write('new-file', 'concurrent writer')
      }
    },
  })
  assert.equal(result.failed, true)
  assert.equal(f.service.resolveRoot(), f.original)
})

test('destination corruption after an individual file was checked fails final verification', async (t) => {
  const f = fixture(t)
  f.service.schedule(f.destination)
  let changed = false
  const result = await migrateStorageDirectory(f.service, {
    onProgress: (progress) => {
      const copied = path.join(f.destination, 'floating_clock_settings.json')
      if (!changed && progress.copiedFiles >= 1 && fs.existsSync(copied)) {
        changed = true
        fs.writeFileSync(copied, 'corrupted')
      }
    },
  })
  assert.equal(changed, true)
  assert.equal(result.failed, true)
  assert.equal(f.service.resolveRoot(), f.original)
})

test('insufficient space fails before copying and does not switch locations', async (t) => {
  const f = fixture(t)
  f.service.schedule(f.destination)
  const statfs = fs.promises.statfs
  fs.promises.statfs = async () => ({ bavail: 0, bsize: 4096 })
  try {
    assert.equal((await migrateStorageDirectory(f.service)).failed, true)
  } finally {
    fs.promises.statfs = statfs
  }
  assert.equal(f.service.resolveRoot(), f.original)
  assert.equal(fs.existsSync(f.destination), false)
})

test('links in the data tree fail closed without traversing the linked directory', async (t) => {
  const f = fixture(t)
  const outside = path.join(f.root, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'private'), 'untouched')
  fs.symlinkSync(
    outside,
    path.join(f.original, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  f.service.schedule(f.destination)
  assert.equal((await migrateStorageDirectory(f.service)).failed, true)
  assert.equal(fs.readFileSync(path.join(outside, 'private'), 'utf8'), 'untouched')
  assert.equal(f.service.resolveRoot(), f.original)
})

test('destination appearing after scheduling is preserved', async (t) => {
  const f = fixture(t)
  f.service.schedule(f.destination)
  fs.mkdirSync(f.destination)
  fs.writeFileSync(path.join(f.destination, 'existing'), 'keep me')
  assert.equal((await migrateStorageDirectory(f.service)).failed, true)
  assert.equal(fs.readFileSync(path.join(f.destination, 'existing'), 'utf8'), 'keep me')
  assert.equal(f.service.resolveRoot(), f.original)
})

test('pointer write failure retains original data and the complete verified copy', async (t) => {
  const f = fixture(t)
  f.service.schedule(f.destination)
  const save = f.service.save.bind(f.service)
  f.service.save = (state) => {
    if (state.root === f.destination) throw new Error('disk failure')
    save(state)
  }
  assert.equal((await migrateStorageDirectory(f.service)).failed, true)
  assert.equal(f.service.resolveRoot(), f.original)
  assert.ok(fs.existsSync(path.join(f.destination, LIBRARY_MARKER)))
})

test('offline disk never falls back to an empty default library; explicit reconnect verifies identity', async (t) => {
  const f = fixture(t)
  f.service.schedule(f.destination)
  await migrateStorageDirectory(f.service)
  const moved = path.join(f.root, 'disk mounted elsewhere')
  fs.renameSync(f.destination, moved)
  assert.throws(() => f.service.resolveRoot())
  assert.throws(() => f.service.reconnect(f.appData))
  f.service.reconnect(moved)
  assert.equal(f.service.resolveRoot(), moved)
  const { readStoragePathAliases } = loadTsModule('electron/storageLocationService.ts')
  assert.ok(readStoragePathAliases(moved).includes(f.destination))
  assert.equal(fs.existsSync(f.destination), false)
})

test('corrupt bootstrap and unknown library identities fail closed', (t) => {
  const f = fixture(t)
  fs.writeFileSync(f.service.bootstrapPath, '{broken')
  assert.throws(() => f.service.resolveRoot())
  assert.throws(() => f.service.initialize())
})

test('destination protection runs before any library payload is copied', async (t) => {
  const f = fixture(t)
  f.service.schedule(f.destination)
  const result = await migrateStorageDirectory(f.service, {
    protectDirectory: async (directory) => {
      assert.deepEqual(fs.readdirSync(directory), [])
      throw new Error('ACL protection failed')
    },
  })
  assert.equal(result.failed, true)
  assert.equal(f.service.resolveRoot(), f.original)
})

test('cached frames, project previews and stored vectors remain usable with the old disk removed', async (t) => {
  const f = fixture(t)
  const resolver = loadTsModule('electron/storagePathResolver.ts')
  const { readStoragePathAliases } = loadTsModule('electron/storageLocationService.ts')
  const cache = loadTsModule('electron/embeddingF16Cache.ts')
  const { VideoFrameManifestLookup } = loadTsModule('electron/videoFrameManifestLookup.ts')
  const { ProjectPreviewManifestStore, projectSourceId } = loadTsModule(
    'electron/projectPreviewManifest.ts',
  )
  t.after(() => resolver.configureStoragePathResolver('', []))
  const frame = path.join(f.original, 'media-search', 'frames', 'frame.jpg')
  f.write('media-search/frames/frame.jpg', Buffer.from('cached frame'))
  f.write(
    'media-search/manifests/video_frames.jsonl',
    JSON.stringify({
      frameId: 'frame-1',
      videoId: 'video-1',
      videoPath: 'D:/originals/video.mp4',
      imagePath: frame,
      status: 'done',
      timestampMs: 1000,
    }) + '\n',
  )
  f.write(
    'vector-db/embeddings/dino.jsonl',
    JSON.stringify({
      imageId: frame,
      modelName: 'dinov2_vitb14',
      embeddingType: 'global',
      dim: 3,
      vector: [1, 0, 0],
    }) + '\n',
  )
  const oldSource = path.join(f.original, 'vector-db', 'embeddings', 'dino.jsonl')
  await cache.ensureEmbeddingF16Cache({
    cacheDir: path.join(f.original, 'vector-db', 'embedding-cache'),
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim: 3,
    sourcePaths: [oldSource],
  })
  const sourcePath = path.join(f.root, 'external-original.psd')
  const previewPath = path.join(f.original, 'project-previews', 'v1', 'previews', 'a.jpg')
  f.write('project-previews/v1/previews/a.jpg', Buffer.from('cached preview'))
  f.write(
    'project-previews/v1/manifest.json',
    JSON.stringify({
      version: 1,
      entries: [
        {
          sourceId: projectSourceId(sourcePath),
          sourcePath,
          sourceExt: 'psd',
          previewPath,
          keywords: [],
          status: 'ready',
          size: 1,
          mtimeMs: 1,
        },
      ],
    }),
  )
  f.service.schedule(f.destination)
  assert.equal((await migrateStorageDirectory(f.service)).migrated, true)
  resolver.configureStoragePathResolver(f.destination, readStoragePathAliases(f.destination))
  fs.renameSync(f.original, f.original + '-disconnected')
  const movedFrame = path.join(f.destination, 'media-search', 'frames', 'frame.jpg')
  const lookup = new VideoFrameManifestLookup(
    path.join(f.destination, 'media-search', 'manifests', 'video_frames.jsonl'),
    path.join(f.destination, 'media-search', 'manifests', 'video_frames.lookup.sqlite'),
    resolver.resolveStoredDataPath,
  )
  assert.equal(lookup.findReady('frame-1').imagePath, movedFrame)
  assert.equal(fs.readFileSync(lookup.findReady('frame-1').imagePath, 'utf8'), 'cached frame')
  const vectors = await cache.ensureEmbeddingF16Cache({
    cacheDir: path.join(f.destination, 'vector-db', 'embedding-cache'),
    modelName: 'dinov2_vitb14',
    embeddingType: 'global',
    dim: 3,
    sourcePaths: [path.join(f.destination, 'vector-db', 'embeddings', 'dino.jsonl')],
  })
  assert.ok(vectors)
  const reused = cache.readEmbeddingF16VectorsForPathsSync(vectors, new Set([movedFrame]))
  assert.deepEqual(
    [...reused.get(cache.embeddingCachePathKey(movedFrame))].map(Math.round),
    [1, 0, 0],
  )
  const projects = new ProjectPreviewManifestStore(f.destination)
  const preview = await projects.get(sourcePath)
  assert.equal(fs.readFileSync(preview.previewPath, 'utf8'), 'cached preview')
  assert.equal(
    resolver.resolveStoredDataPath(sourcePath),
    sourcePath,
    'external originals are never remapped',
  )
})

test('repeated moves preserve earlier internal path aliases and the original library identity', async (t) => {
  const f = fixture(t)
  const { readStoragePathAliases } = loadTsModule('electron/storageLocationService.ts')
  const { resolveDataPathInRoots } = loadTsModule('electron/storagePathResolver.ts')
  const libraryId = f.service.read().libraryId
  f.service.schedule(f.destination)
  assert.equal((await migrateStorageDirectory(f.service)).migrated, true)
  const third = path.join(f.root, 'third location')
  f.service.schedule(third)
  assert.equal((await migrateStorageDirectory(f.service)).migrated, true)
  assert.equal(f.service.read().libraryId, libraryId)
  const aliases = readStoragePathAliases(third)
  assert.ok(aliases.includes(f.original))
  assert.ok(aliases.includes(f.destination))
  assert.equal(
    resolveDataPathInRoots(
      third,
      aliases,
      path.join(f.original, 'media-search', 'frames', 'a.jpg'),
    ),
    path.join(third, 'media-search', 'frames', 'a.jpg'),
  )
  assert.equal(
    resolveDataPathInRoots(third, aliases, f.original + '-different'),
    f.original + '-different',
  )
  const nested = path.join(f.original, 'nested-new-location')
  assert.equal(
    resolveDataPathInRoots(nested, [f.original], path.join(nested, 'cache.jpg')),
    path.join(nested, 'cache.jpg'),
  )
})

test('pending recovery is finished in the original library before a migration can copy data', async (t) => {
  const f = fixture(t)
  f.write('asset-library/.asset-library-restore.json', '{"pending":true}')
  f.service.schedule(f.destination)
  const result = await migrateStorageDirectory(f.service)
  assert.equal(result.failed, true)
  assert.match(result.reason, /recovery/)
  assert.equal(f.service.resolveRoot(), f.original)
  assert.equal(fs.existsSync(f.destination), false)
})
