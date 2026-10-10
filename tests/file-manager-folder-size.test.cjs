const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  calculateFileManagerVolumeSpace,
  calculateFileManagerFolderSize,
  fileManagerFolderSizePathsOverlap,
  fileManagerVolumeSpaceFromStatFs,
  normalizeFileManagerVolumeSpacePath,
  normalizeFileManagerFolderSizeRequest,
} = loadTsModule('electron/fileManagerIpc.ts')
const { summarizeCurrentFolderSize } = loadTsModule(
  'src/components/filemanager/folderSizeAggregation.ts',
)

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `siftory-fm-folder-size-${label}-`))
}

test('file manager folder size reports recursive logical bytes without blocking directory listing', async () => {
  const root = tempRoot('count')
  try {
    fs.mkdirSync(path.join(root, 'nested'))
    fs.writeFileSync(path.join(root, 'first.bin'), Buffer.alloc(11))
    fs.writeFileSync(path.join(root, 'nested', 'second.bin'), Buffer.alloc(19))

    const result = await calculateFileManagerFolderSize(root, { maxEntries: 100 })
    assert.equal(result.path, path.normalize(root))
    assert.equal(result.bytes, 30)
    assert.equal(result.fileCount, 2)
    assert.equal(result.folderCount, 1)
    assert.equal(result.complete, true)
    assert.equal(result.error, undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('file manager folder size exposes partial and cancelled states', async () => {
  const root = tempRoot('bounded')
  try {
    fs.writeFileSync(path.join(root, 'first.bin'), Buffer.alloc(3))
    fs.writeFileSync(path.join(root, 'second.bin'), Buffer.alloc(7))

    const partial = await calculateFileManagerFolderSize(root, { maxEntries: 1 })
    assert.equal(partial.complete, false)
    assert.equal(partial.partialReason, 'entry-limit')
    assert.equal(partial.entriesScanned, 1)

    const cancelled = await calculateFileManagerFolderSize(root, { isCancelled: () => true })
    assert.equal(cancelled.cancelled, true)
    assert.equal(cancelled.complete, false)
    assert.match(cancelled.error || '', /cancelled/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('folder size IPC request validation rejects malformed paths and cancellation ids', () => {
  const valid = normalizeFileManagerFolderSizeRequest({
    folderPath: 'C:\\Users',
    requestId: 'pane-0:42.1',
  })
  assert.equal(valid.ok, true)

  assert.equal(normalizeFileManagerFolderSizeRequest(null).ok, false)
  assert.equal(
    normalizeFileManagerFolderSizeRequest({ folderPath: 'C:\\bad\u0000path', requestId: 'ok' }).ok,
    false,
  )
  assert.equal(
    normalizeFileManagerFolderSizeRequest({ folderPath: 'C:\\Users', requestId: '../escape' }).ok,
    false,
  )
})

test('folder size cache invalidation is scoped to related branches', () => {
  const root = path.resolve('C:\\cache-test')
  const first = path.join(root, 'first')
  const nested = path.join(first, 'nested')
  const sibling = path.join(root, 'sibling')

  assert.equal(fileManagerFolderSizePathsOverlap(first, nested), true)
  assert.equal(fileManagerFolderSizePathsOverlap(nested, first), true)
  assert.equal(fileManagerFolderSizePathsOverlap(first, sibling), false)
})

test('volume roots use filesystem capacity instead of recursive logical-size estimates', async () => {
  const rootPath = path.parse(path.resolve(os.tmpdir())).root
  assert.equal(normalizeFileManagerVolumeSpacePath(rootPath), path.normalize(rootPath))
  assert.equal(normalizeFileManagerVolumeSpacePath(os.tmpdir()), null)

  assert.deepEqual(
    fileManagerVolumeSpaceFromStatFs(rootPath, {
      bsize: 4n,
      blocks: 100n,
      bfree: 30n,
      bavail: 20n,
    }),
    {
      path: rootPath,
      totalBytes: 400,
      usedBytes: 280,
      freeBytes: 120,
      availableBytes: 80,
    },
  )

  const live = await calculateFileManagerVolumeSpace(rootPath)
  assert.equal(live.error, undefined)
  assert.ok(live.totalBytes > 0)
  assert.ok(live.usedBytes >= 0)
  assert.equal(live.usedBytes + live.freeBytes, live.totalBytes)

  const rejected = await calculateFileManagerVolumeSpace(os.tmpdir())
  assert.match(rejected.error || '', /drive or share root/i)
})

test('current directory total combines files with exact and partial folder sizes', () => {
  const entries = [
    { path: 'file.bin', isDirectory: false, size: 10 },
    { path: 'loading', isDirectory: true, size: 0 },
    { path: 'partial', isDirectory: true, size: 0 },
    { path: 'exact', isDirectory: true, size: 0 },
    { path: 'queued', isDirectory: true, size: 0 },
  ]
  const states = new Map([
    ['loading', { status: 'loading', entriesScanned: 5, bytes: 5 }],
    ['partial', { status: 'ready', bytes: 7, complete: false }],
    ['exact', { status: 'ready', bytes: 20, complete: true }],
    ['queued', { status: 'queued' }],
  ])

  const partial = summarizeCurrentFolderSize(entries, states, false)
  assert.deepEqual(partial, {
    bytes: 42,
    complete: false,
    folderCount: 4,
    processedFolderCount: 2,
    completeFolderCount: 1,
  })

  const exact = summarizeCurrentFolderSize(
    [entries[0], entries[3]],
    new Map([['exact', { status: 'ready', bytes: 20, complete: true }]]),
    false,
  )
  assert.deepEqual(exact, {
    bytes: 30,
    complete: true,
    folderCount: 1,
    processedFolderCount: 1,
    completeFolderCount: 1,
  })
  assert.equal(summarizeCurrentFolderSize([entries[0]], new Map(), true).complete, false)
})

test('folder size UI uses bounded auto-queueing, visibility scheduling, and cancellation', () => {
  const root = path.resolve(__dirname, '..')
  const pane = fs.readFileSync(
    path.join(root, 'src', 'components', 'filemanager', 'FilePane.tsx'),
    'utf8',
  )
  const ipc = fs.readFileSync(path.join(root, 'electron', 'fileManagerIpc.ts'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8')

  assert.match(pane, /new IntersectionObserver/)
  assert.match(pane, /FOLDER_SIZE_REQUEST_CONCURRENCY = 2/)
  assert.match(pane, /FOLDER_SIZE_AUTO_QUEUE_LIMIT = 64/)
  assert.match(pane, /folders\.length > FOLDER_SIZE_AUTO_QUEUE_LIMIT/)
  assert.match(pane, /scheduleFolderSizeRef\.current\(folder\.path\)/)
  assert.match(pane, /fmGetFolderSize\(\{ folderPath, requestId: generation\.id \}\)/)
  assert.match(pane, /fmCancelFolderSizeRequests\(generation\.id\)/)
  assert.match(pane, /onFMFolderSizeProgress/)
  assert.match(pane, /progress\.phase === 'queued'/)
  assert.match(pane, /entriesScanned: progress\.entriesScanned/)
  assert.match(pane, /data-testid="fm-folder-size"/)
  assert.match(pane, /data-folder-size-bytes=/)
  assert.match(pane, /text = `≥ \$\{formatSize\(state\.bytes\)\}`/)
  assert.match(pane, /data-testid="fm-size-summary"/)
  assert.match(pane, /data-testid="fm-current-total-size"/)
  assert.match(pane, /data-total-size-source="logical"/)
  assert.match(pane, /data-testid="fm-size-progress"/)
  assert.match(pane, /data-size-progress-processed=/)
  assert.match(pane, /Size progress \{processed\}\/\{total\}/)
  assert.match(pane, /data-testid="fm-volume-space"/)
  assert.match(pane, /Calculated total \{size\}/)
  assert.match(pane, /Disk used \{used\} \/ \{total\} · Free \{free\}/)
  assert.match(pane, /fmGetVolumeSpace\(dir\)/)
  assert.match(pane, /summarizeCurrentFolderSize/)
  assert.match(pane, /hasMore \|\| loading \|\| Boolean\(error\)/)
  assert.match(ipc, /FILE_MANAGER_FOLDER_SIZE_MAX_SCANS = 2/)
  assert.match(ipc, /fsp\.statfs\(rootPath, \{ bigint: true \}\)/)
  assert.match(ipc, /secureIpcMain\.handle\('fm-get-volume-space'/)
  assert.match(ipc, /FILE_MANAGER_FOLDER_SIZE_MAX_ENTRIES = 250_000/)
  assert.match(ipc, /maxDirectorySnapshots: FILE_MANAGER_FOLDER_SIZE_CACHE_LIMIT/)
  assert.match(ipc, /onDirectoryStats: \(snapshotPath, stats\)/)
  assert.match(ipc, /cacheFolderSize\(folderTreeStatsToFileManagerResult\(snapshotPath, stats\)\)/)
  assert.match(ipc, /invalidateFileManagerFolderSizeCache\(\[changedPath\]\)/)
  assert.match(ipc, /sender\.once\('destroyed'/)
  assert.match(preload, /ipcRenderer\.invoke\('fm-get-folder-size', request\)/)
  assert.match(preload, /ipcRenderer\.invoke\('fm-get-volume-space', rootPath\)/)
  assert.match(preload, /ipcRenderer\.invoke\('fm-cancel-folder-size-requests', requestId\)/)
  assert.match(preload, /ipcRenderer\.on\('fm:folder-size-progress', handler\)/)
  assert.match(preload, /ipcRenderer\.removeListener\('fm:folder-size-progress', handler\)/)
})
