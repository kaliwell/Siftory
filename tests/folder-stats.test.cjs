const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { FolderStatsCancelledError, listFolderStatsSources, scanFolderTree, scanSourceFolderStats } =
  loadTsModule('electron/appStorageService.ts')

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `siftory-folder-stats-${label}-`))
}

test('folder statistics count logical bytes and support registered relative subfolders', async () => {
  const root = tempRoot('count')
  try {
    fs.mkdirSync(path.join(root, 'nested'))
    fs.writeFileSync(path.join(root, 'a.bin'), Buffer.alloc(3))
    fs.writeFileSync(path.join(root, 'nested', 'b.bin'), Buffer.alloc(7))

    const whole = await scanFolderTree(root)
    assert.equal(whole.bytes, 10)
    assert.equal(whole.fileCount, 2)
    assert.equal(whole.folderCount, 1)
    assert.equal(whole.complete, true)

    const nested = await scanFolderTree(root, 'nested')
    assert.equal(nested.bytes, 7)
    assert.equal(nested.fileCount, 1)
    assert.equal(nested.folderCount, 0)

    const sourceResult = await scanSourceFolderStats({
      id: 'src-local',
      type: 'local-ntfs',
      displayName: 'Test source',
      rootLocator: root,
      readOnly: true,
      availability: 'online',
      scanCapability: 'directory',
    })
    assert.equal(sourceResult.sourceId, 'src-local')
    assert.equal(sourceResult.sourceLabel, 'Test source')
    assert.equal(sourceResult.bytes, 10)
    assert.equal('rootLocator' in sourceResult, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('folder statistics reject absolute paths, traversal, and unsupported remote source types', async () => {
  const root = tempRoot('boundary')
  const outside = tempRoot('outside')
  try {
    await assert.rejects(scanFolderTree(root, outside), /Only a relative folder/)
    await assert.rejects(scanFolderTree(root, '..'), /escapes the registered source/)
    await assert.rejects(
      scanSourceFolderStats({
        id: 'src-sftp',
        type: 'sftp',
        displayName: 'Remote',
        rootLocator: 'sftp-profile:/',
        readOnly: true,
        availability: 'online',
        scanCapability: 'remote-list',
      }),
      /does not support local folder statistics/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('folder statistics skip directory junctions and never count files outside the source', async () => {
  const root = tempRoot('links')
  const outside = tempRoot('links-outside')
  try {
    fs.writeFileSync(path.join(root, 'inside.bin'), Buffer.alloc(5))
    fs.writeFileSync(path.join(outside, 'outside.bin'), Buffer.alloc(100))
    try {
      fs.symlinkSync(outside, path.join(root, 'junction'), 'junction')
    } catch {
      return
    }
    const result = await scanFolderTree(root)
    assert.equal(result.bytes, 5)
    assert.equal(result.fileCount, 1)
    assert.equal(result.skippedLinkCount, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('folder statistics are cancellable and return an explicit partial result at the entry limit', async () => {
  const root = tempRoot('cancel')
  try {
    fs.writeFileSync(path.join(root, 'a.bin'), Buffer.alloc(3))
    fs.writeFileSync(path.join(root, 'b.bin'), Buffer.alloc(7))
    await assert.rejects(
      scanFolderTree(root, '', { isCancelled: () => true }),
      FolderStatsCancelledError,
    )
    const limited = await scanFolderTree(root, '', { maxEntries: 1 })
    assert.equal(limited.complete, false)
    assert.equal(limited.partialReason, 'entry-limit')
    assert.equal(limited.entriesScanned, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('folder statistics emit reusable post-order snapshots and bounded progress', async () => {
  const root = tempRoot('snapshots')
  try {
    const child = path.join(root, 'child')
    const grandchild = path.join(child, 'grandchild')
    fs.mkdirSync(grandchild, { recursive: true })
    fs.writeFileSync(path.join(root, 'root.bin'), Buffer.alloc(2))
    fs.writeFileSync(path.join(child, 'child.bin'), Buffer.alloc(3))
    fs.writeFileSync(path.join(grandchild, 'grandchild.bin'), Buffer.alloc(5))

    const snapshots = []
    const progress = []
    const result = await scanFolderTree(root, '', {
      yieldEvery: 1,
      onProgress: (value) => progress.push(value),
      onDirectoryStats: (folderPath, stats) => snapshots.push({ folderPath, stats }),
    })

    assert.equal(result.bytes, 10)
    assert.ok(progress.length >= 1)
    assert.equal(progress.at(-1).entriesScanned, result.entriesScanned)
    assert.equal(progress.at(-1).bytes, result.bytes)
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.folderPath),
      [grandchild, child, root],
      'deepest snapshots must arrive first so shallow cache entries stay hottest',
    )
    const byPath = new Map(snapshots.map((snapshot) => [snapshot.folderPath, snapshot.stats]))
    assert.equal(byPath.get(grandchild).bytes, 5)
    assert.equal(byPath.get(child).bytes, 8)
    assert.equal(byPath.get(child).folderCount, 1)
    assert.equal(byPath.get(root).bytes, result.bytes)
    assert.equal(byPath.get(root).fileCount, result.fileCount)
    assert.equal(byPath.get(root).folderCount, result.folderCount)
    assert.equal(byPath.get(root).entriesScanned, result.entriesScanned)
    assert.equal(byPath.get(root).complete, result.complete)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('folder statistics keep progress monotonic and reuse every child result in a file-heavy tree', async () => {
  const root = tempRoot('many-files')
  try {
    const directoryCount = 16
    const filesPerDirectory = 32
    for (let directoryIndex = 0; directoryIndex < directoryCount; directoryIndex += 1) {
      const child = path.join(root, `child-${directoryIndex}`)
      fs.mkdirSync(child)
      for (let fileIndex = 0; fileIndex < filesPerDirectory; fileIndex += 1) {
        fs.writeFileSync(path.join(child, `file-${fileIndex}.bin`), Buffer.alloc(1))
      }
    }

    const snapshots = new Map()
    const progress = []
    const result = await scanFolderTree(root, '', {
      maxEntries: 10_000,
      statConcurrency: 4,
      yieldEvery: 37,
      onProgress: (value) => progress.push(value),
      onDirectoryStats: (folderPath, stats) => snapshots.set(folderPath, stats),
    })

    const expectedFiles = directoryCount * filesPerDirectory
    assert.equal(result.bytes, expectedFiles)
    assert.equal(result.fileCount, expectedFiles)
    assert.equal(result.folderCount, directoryCount)
    assert.equal(result.complete, true)
    assert.equal(snapshots.size, directoryCount + 1)
    for (let directoryIndex = 0; directoryIndex < directoryCount; directoryIndex += 1) {
      const childStats = snapshots.get(path.join(root, `child-${directoryIndex}`))
      assert.equal(childStats.bytes, filesPerDirectory)
      assert.equal(childStats.fileCount, filesPerDirectory)
      assert.equal(childStats.complete, true)
    }
    assert.ok(progress.length > 1)
    for (let index = 1; index < progress.length; index += 1) {
      assert.ok(progress[index].entriesScanned >= progress[index - 1].entriesScanned)
      assert.ok(progress[index].bytes >= progress[index - 1].bytes)
    }
    assert.equal(progress.at(-1).entriesScanned, result.entriesScanned)
    assert.equal(progress.at(-1).bytes, result.bytes)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('folder statistics bound snapshot callbacks while retaining shallow reusable results', async () => {
  const root = tempRoot('bounded-snapshots')
  try {
    const child = path.join(root, 'child')
    const grandchild = path.join(child, 'grandchild')
    fs.mkdirSync(grandchild, { recursive: true })
    fs.writeFileSync(path.join(grandchild, 'payload.bin'), Buffer.alloc(9))

    const snapshots = []
    const result = await scanFolderTree(root, '', {
      maxDirectorySnapshots: 2,
      onDirectoryStats: (folderPath, stats) => snapshots.push({ folderPath, stats }),
    })

    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.folderPath),
      [child, root],
    )
    assert.equal(snapshots[0].stats.bytes, 9)
    assert.equal(snapshots[1].stats.bytes, result.bytes)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('folder source discovery returns only safe summaries for locally accessible source types', () => {
  const base = {
    readOnly: true,
    availability: 'online',
    scanCapability: 'directory',
  }
  const summaries = listFolderStatsSources([
    {
      ...base,
      id: 'src-local',
      type: 'local-generic',
      displayName: 'Local files',
      rootLocator: 'C:\\private',
    },
    {
      ...base,
      id: 'src-mounted',
      type: 'mounted-network',
      displayName: 'NAS share',
      rootLocator: '\\\\server\\secret',
    },
    {
      ...base,
      id: 'src-sftp',
      type: 'sftp',
      displayName: 'SFTP',
      rootLocator: 'profile:/secret',
      scanCapability: 'remote-list',
    },
  ])
  assert.deepEqual(
    summaries.map((source) => source.sourceId),
    ['src-local', 'src-mounted'],
  )
  assert.equal(
    summaries.some((source) => 'rootLocator' in source),
    false,
  )
  assert.equal(JSON.stringify(summaries).includes('private'), false)
  assert.equal(JSON.stringify(summaries).includes('server'), false)
})
