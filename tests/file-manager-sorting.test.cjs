const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { compareFileManagerEntries } = loadTsModule('electron/fileManagerSorting.ts')
const { DirectoryLoadCoordinator } = loadTsModule(
  'src/components/filemanager/directoryLoadCoordinator.ts',
)
const { createFolderSizeSortSnapshot, sortEntriesBySizeSnapshot } = loadTsModule(
  'src/components/filemanager/folderSizeAggregation.ts',
)

function entry(name, size, isDirectory = false, mtime = 1, type = '.bin') {
  return {
    name,
    path: path.join('C:\\sorting-test', name),
    isDirectory,
    size,
    mtime,
    type: isDirectory ? '文件夹' : type,
  }
}

test('size sorting keeps folders stable and deterministically orders equal-size files', () => {
  const entries = [
    entry('folder-z', 0, true),
    entry('same-b.bin', 50),
    entry('large.bin', 100),
    entry('folder-a', 0, true),
    entry('small.bin', 1),
    entry('same-a.bin', 50),
  ]

  const ascending = [...entries].sort((a, b) =>
    compareFileManagerEntries(a, b, { field: 'size', direction: 'asc' }),
  )
  const descending = [...entries]
    .reverse()
    .sort((a, b) => compareFileManagerEntries(a, b, { field: 'size', direction: 'desc' }))

  assert.deepEqual(
    ascending.map((item) => item.name),
    ['folder-a', 'folder-z', 'small.bin', 'same-a.bin', 'same-b.bin', 'large.bin'],
  )
  assert.deepEqual(
    descending.map((item) => item.name),
    ['folder-a', 'folder-z', 'large.bin', 'same-a.bin', 'same-b.bin', 'small.bin'],
  )
})

test('directory load coordination rejects stale reorder responses and duplicate page loads', () => {
  const coordinator = new DirectoryLoadCoordinator()
  const firstSort = coordinator.begin(true)
  const latestSort = coordinator.begin(true)

  assert.ok(firstSort)
  assert.ok(latestSort)
  assert.equal(coordinator.isCurrent(firstSort), false)
  assert.equal(coordinator.isCurrent(latestSort), true)
  assert.equal(coordinator.begin(false), null)

  coordinator.finish(latestSort)
  const firstPageAppend = coordinator.begin(false)
  assert.ok(firstPageAppend)
  assert.equal(coordinator.begin(false), null)

  const watcherRefresh = coordinator.begin('silent')
  assert.ok(watcherRefresh)
  assert.equal(coordinator.isCurrent(firstPageAppend), false)
  coordinator.finish(firstPageAppend)
  assert.equal(coordinator.begin(false), null)

  coordinator.finish(watcherRefresh)
  assert.ok(coordinator.begin(false))
})

test('folder size sorting uses a frozen display snapshot instead of live scan progress', () => {
  const entries = [
    entry('folder-unknown', 0, true),
    entry('folder-large', 0, true),
    entry('folder-small', 0, true),
    entry('file-large.bin', 200),
    entry('file-small.bin', 2),
  ]
  const states = new Map([
    ['C:\\sorting-test\\folder-large', { status: 'ready', bytes: 100, complete: true }],
    ['C:\\sorting-test\\folder-small', { status: 'loading', entriesScanned: 2, bytes: 10 }],
    ['C:\\sorting-test\\folder-unknown', { status: 'queued' }],
  ])
  const snapshot = createFolderSizeSortSnapshot(states)

  assert.deepEqual(
    sortEntriesBySizeSnapshot(entries, 'asc', snapshot).map((item) => item.name),
    ['folder-small', 'folder-large', 'folder-unknown', 'file-small.bin', 'file-large.bin'],
  )

  states.set('C:\\sorting-test\\folder-small', {
    status: 'ready',
    bytes: 1000,
    complete: true,
  })
  assert.deepEqual(
    sortEntriesBySizeSnapshot(entries, 'asc', snapshot).map((item) => item.name),
    ['folder-small', 'folder-large', 'folder-unknown', 'file-small.bin', 'file-large.bin'],
  )
  assert.deepEqual(
    sortEntriesBySizeSnapshot(entries, 'desc', createFolderSizeSortSnapshot(states)).map(
      (item) => item.name,
    ),
    ['folder-small', 'folder-large', 'folder-unknown', 'file-large.bin', 'file-small.bin'],
  )
})

test('file manager listing wires the deterministic comparator and latest-request gate', () => {
  const root = path.resolve(__dirname, '..')
  const ipc = fs.readFileSync(path.join(root, 'electron', 'fileManagerIpc.ts'), 'utf8')
  const pane = fs.readFileSync(
    path.join(root, 'src', 'components', 'filemanager', 'FilePane.tsx'),
    'utf8',
  )

  assert.match(ipc, /entries\.sort\(\(a, b\) => compareFileManagerEntries\(a, b, req\.sort!\)\)/)
  assert.match(ipc, /entries\.slice\(req\.offset, req\.offset \+ req\.limit\)/)
  assert.match(pane, /directoryLoadCoordinator\.begin\(reset\)/)
  assert.match(pane, /directoryLoadCoordinator\.isCurrent\(loadTicket\)/)
  assert.match(pane, /directoryLoadCoordinator\.finish\(loadTicket\)/)
  assert.match(pane, /\(isFullReset \|\| isSilent\) && !preserveFolderSizes/)
  assert.match(pane, /loadDir\(currentPath, sameDirectory \? 'silent' : true, sameDirectory\)/)
  assert.match(pane, /createFolderSizeSortSnapshot\(folderSizeStates\)/)
  assert.match(
    pane,
    /sortEntriesBySizeSnapshot\(filtered, sort\.direction, folderSizeSortSnapshot\)/,
  )
})
