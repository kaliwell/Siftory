const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { FolderStatsCancelledError } = loadTsModule('electron/appStorageService.ts')
const { assessLargeFileCleanup, scanSourceLargeFiles, scanStorageLargeFiles } = loadTsModule(
  'electron/largeFileInventoryService.ts',
)
const { redactAiControlValue } = loadTsModule('electron/aiControlPolicy.ts')

const MIB = 1024 ** 2

function source(root) {
  return {
    id: 'src-large-files',
    type: 'local-generic',
    displayName: 'Large-file fixture',
    rootLocator: root,
    readOnly: true,
    availability: 'online',
    scanCapability: 'directory',
  }
}

function writeSizedFile(filePath, bytes, modifiedAt) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.alloc(bytes))
  fs.utimesSync(filePath, modifiedAt, modifiedAt)
}

test('large-file cleanup assessment is conservative for system, cache, and download files', () => {
  const now = Date.UTC(2026, 7, 18)
  const old = now - 60 * 24 * 60 * 60 * 1000
  const recent = now - 2 * 24 * 60 * 60 * 1000

  assert.deepEqual(assessLargeFileCleanup('C:\\Windows\\memory.bin', old, 30, now), {
    assessment: 'protected',
    reasonCode: 'system-managed-directory',
    suggestedAction: 'do-not-delete-directly',
  })
  assert.equal(
    assessLargeFileCleanup('C:\\Users\\person\\AppData\\Local\\Temp\\old.bin', old, 30, now)
      .assessment,
    'low-risk',
  )
  assert.equal(
    assessLargeFileCleanup('C:\\Users\\person\\AppData\\Local\\Temp\\recent.bin', recent, 30, now)
      .assessment,
    'review',
  )
  assert.equal(
    assessLargeFileCleanup('C:\\Users\\person\\Downloads\\old.iso', old, 30, now).reasonCode,
    'old-download-installer-or-archive',
  )
  assert.equal(
    assessLargeFileCleanup('C:\\$Recycle.Bin\\deleted.bin', old, 30, now).suggestedAction,
    'empty-recycle-bin-with-windows',
  )
  assert.equal(assessLargeFileCleanup('C:\\pagefile.sys', old, 30, now).assessment, 'protected')
})

test('large-file inventory returns a bounded descending list without absolute paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-large-file-inventory-'))
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  try {
    writeSizedFile(path.join(root, 'cache', 'old-cache.bin'), 2 * MIB, old)
    writeSizedFile(path.join(root, 'downloads', 'installer.iso'), 3 * MIB, old)
    writeSizedFile(path.join(root, 'documents', 'video.mp4'), 4 * MIB, recent)
    writeSizedFile(path.join(root, 'pagefile.sys'), 5 * MIB, old)
    writeSizedFile(path.join(root, 'cache', 'recent-cache.bin'), 6 * MIB, recent)
    fs.writeFileSync(path.join(root, 'tiny.txt'), 'tiny')

    const result = await scanSourceLargeFiles(source(root), {
      minBytes: MIB,
      topN: 3,
      olderThanDays: 30,
    })
    assert.equal(result.complete, true)
    assert.equal(result.candidateCount, 5)
    assert.equal(result.returnedCount, 3)
    assert.deepEqual(
      result.items.map((item) => item.sizeBytes),
      [6 * MIB, 5 * MIB, 4 * MIB],
    )
    assert.equal(result.assessments.protected.count, 1)
    assert.ok(result.assessments['low-risk'].count >= 1)
    assert.equal(JSON.stringify(result).includes(root), false)
    assert.equal(
      result.items.every((item) => !path.isAbsolute(item.relativeFile)),
      true,
    )
    assert.equal(new Set(result.items.map((item) => item.itemId)).size, result.items.length)

    const redacted = redactAiControlValue(result)
    assert.equal(redacted.items[0].relativeFile, result.items[0].relativeFile)
    assert.equal(JSON.stringify(redacted).includes(root), false)

    const cleanable = await scanSourceLargeFiles(source(root), {
      minBytes: MIB,
      topN: 10,
      olderThanDays: 30,
      assessment: 'low-risk',
    })
    assert.equal(
      cleanable.items.every((item) => item.assessment === 'low-risk'),
      true,
    )
    assert.equal(cleanable.matchedCount, cleanable.assessments['low-risk'].count)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('large-file inventory preserves source boundaries and cooperative cancellation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-large-file-boundary-'))
  try {
    fs.writeFileSync(path.join(root, 'payload.bin'), Buffer.alloc(MIB))
    await assert.rejects(
      scanSourceLargeFiles(source(root), { relativePath: '..', minBytes: MIB }),
      /escapes the registered source/,
    )
    await assert.rejects(
      scanSourceLargeFiles(source(root), { minBytes: MIB }, { isCancelled: () => true }),
      FolderStatsCancelledError,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('one-call storage inventory discovers injected roots and returns a global bounded list', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-storage-large-files-'))
  const firstRoot = path.join(fixture, 'first')
  const secondRoot = path.join(fixture, 'second')
  const unavailableRoot = path.join(fixture, 'unavailable')
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  try {
    writeSizedFile(path.join(firstRoot, 'cache', 'two.bin'), 2 * MIB, old)
    writeSizedFile(path.join(firstRoot, 'cache', 'four.bin'), 4 * MIB, old)
    writeSizedFile(path.join(secondRoot, 'downloads', 'three.iso'), 3 * MIB, old)

    const result = await scanStorageLargeFiles(
      {
        scope: 'computer',
        minBytes: MIB,
        topN: 2,
        olderThanDays: 30,
        assessment: 'all',
      },
      {
        roots: [
          { rootId: 'drive-a', rootLabel: 'Disk A', rootLocator: firstRoot },
          { rootId: 'drive-b', rootLabel: 'Disk B', rootLocator: secondRoot },
          { rootId: 'drive-z', rootLabel: 'Disk Z', rootLocator: unavailableRoot },
        ],
      },
    )

    assert.equal(result.scope, 'computer')
    assert.equal(result.rootsDiscovered, 3)
    assert.equal(result.rootsScanned, 2)
    assert.equal(result.rootsFailed, 1)
    assert.equal(result.complete, false)
    assert.equal(result.partialReason, 'root-scan-failed')
    assert.equal(result.candidateCount, 3)
    assert.equal(result.returnedCount, 2)
    assert.deepEqual(
      result.items.map((item) => item.sizeBytes),
      [4 * MIB, 3 * MIB],
    )
    assert.deepEqual(
      result.items.map((item) => item.rootId),
      ['drive-a', 'drive-b'],
    )
    assert.equal(result.roots.find((root) => root.rootId === 'drive-z').status, 'failed')
    assert.equal(JSON.stringify(result).includes(fixture), false)
    assert.equal(
      result.items.every((item) => !path.isAbsolute(item.relativeFile)),
      true,
    )

    const filtered = await scanStorageLargeFiles(
      { scope: 'computer', rootId: 'drive-a', minBytes: MIB, topN: 10 },
      {
        roots: [
          { rootId: 'drive-a', rootLabel: 'Disk A', rootLocator: firstRoot },
          { rootId: 'drive-b', rootLabel: 'Disk B', rootLocator: secondRoot },
        ],
      },
    )
    assert.equal(filtered.requestedRootId, 'drive-a')
    assert.equal(filtered.rootsDiscovered, 1)
    assert.equal(filtered.rootsScanned, 1)
    assert.equal(filtered.candidateCount, 2)
    assert.equal(
      filtered.items.every((item) => item.rootId === 'drive-a'),
      true,
    )
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

test('one-call storage inventory supports cooperative cancellation', async () => {
  await assert.rejects(
    scanStorageLargeFiles(
      { scope: 'computer', minBytes: MIB },
      {
        roots: [{ rootId: 'drive-a', rootLabel: 'Disk A', rootLocator: os.tmpdir() }],
        isCancelled: () => true,
      },
    ),
    FolderStatsCancelledError,
  )
})
